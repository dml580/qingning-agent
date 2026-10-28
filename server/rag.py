"""
迷你 RAG：多路召回 + 融合重排。

链路：
1. 切块（chunk_text）
2. 多路召回：向量（稠密，ChromaDB）+ BM25（稀疏，纯 Python，无额外依赖）
3. 融合：RRF（Reciprocal Rank Fusion）合并两路排名
4. 重排：RRF 归一化 + 查询词面覆盖度加权
5. 取 top_k 拼成上下文块

不用 cross-encoder：本机未缓存重排模型、外网下载不稳定；
词面覆盖度重排零依赖、可复现，评测里能算命中率。
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any, Dict, List, Sequence, Tuple

from vector_store import vector_store

# 各文书模版检索查询偏置（叠加在用户原文前部）
SCENARIO_QUERY_HINT: Dict[str, str] = {
    "general": "费用 金额 期限 违约 解除 续约 管辖 付款",
    "rental": "押金 租金 涨租 退租 维修 转租 逾期 滞纳",
    "labor": "薪资 试用 竞业 培训 社保 公积金 解除 Offer",
    "training": "学费 退费 违约金 贷款 分期 课时 开课",
    "credit": "利息 手续费 逾期 罚息 提前还款 扣款 免息",
}

# BM25 参数与融合参数
_BM25_K1 = 1.5
_BM25_B = 0.75
_RRF_K = 60
_COVERAGE_WEIGHT = 0.35
_RECALL_MULTIPLIER = 3


def _tokenize(text: str) -> List[str]:
    text = (text or "").lower()
    toks: List[str] = []
    for m in re.finditer(r"[a-z0-9]{2,}|[\u4e00-\u9fff]{2}", text):
        toks.append(m.group(0))
    # 中文单字对短句也给一点信号
    for ch in re.findall(r"[\u4e00-\u9fff]", text):
        toks.append(ch)
    return toks


def chunk_text(text: str, size: int = 400, overlap: int = 50) -> List[str]:
    raw = re.sub(r"\r\n?", "\n", (text or "").strip())
    if not raw:
        return []
    if len(raw) <= size:
        return [raw]

    chunks: List[str] = []
    i = 0
    n = len(raw)
    while i < n:
        piece = raw[i : i + size].strip()
        if piece:
            chunks.append(piece)
        if i + size >= n:
            break
        i += max(1, size - overlap)
    return chunks


def bm25_scores(
    query_tokens: Sequence[str], docs_tokens: Sequence[Sequence[str]]
) -> List[float]:
    """纯 Python BM25（k1/b 可调），返回每个文档的稀疏得分。"""
    n = len(docs_tokens)
    if n == 0 or not query_tokens:
        return [0.0] * n
    avgdl = sum(len(d) for d in docs_tokens) / n or 1.0

    df: Counter = Counter()
    for doc in docs_tokens:
        df.update(set(doc))

    query_counts = Counter(query_tokens)
    scores: List[float] = []
    for doc in docs_tokens:
        dl = len(doc) or 1
        tf = Counter(doc)
        score = 0.0
        for term, qn in query_counts.items():
            f = tf.get(term, 0)
            if not f:
                continue
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            score += qn * idf * (f * (_BM25_K1 + 1)) / (
                f + _BM25_K1 * (1 - _BM25_B + _BM25_B * dl / avgdl)
            )
        scores.append(score)
    return scores


def _rank_indices(scores: Sequence[float], limit: int) -> List[int]:
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    return [i for i in order[:limit] if scores[i] > 0]


def _rrf_fuse(rankings: Sequence[Sequence[int]]) -> Dict[int, float]:
    """RRF：名次倒数加权求和，避免两路分数量纲不一致。"""
    fused: Dict[int, float] = {}
    for ranking in rankings:
        for pos, idx in enumerate(ranking, start=1):
            fused[idx] = fused.get(idx, 0.0) + 1.0 / (_RRF_K + pos)
    return fused


def _coverage(query_tokens: Sequence[str], doc_tokens: Sequence[str]) -> float:
    """查询词在片段里的覆盖率，作为字面重排信号。"""
    q = set(query_tokens)
    if not q:
        return 0.0
    return len(q & set(doc_tokens)) / len(q)


def retrieve_chunks(
    document: str,
    *,
    session_id: str = "default",
    scenario_id: str = "general",
    query_extra: str = "",
    top_k: int = 4,
    min_doc_chars: int = 180,
) -> Dict[str, Any]:
    """多路召回（向量 + BM25）→ RRF 融合 → 词面覆盖度重排。"""
    doc = (document or "").strip()
    # 去掉照片标记
    doc = re.sub(r"\n*【附文书照片】[\s\S]*$", "", doc).strip()

    if len(doc) < min_doc_chars:
        return {
            "enabled": False,
            "reason": "正文过短，跳过检索",
            "chunks": [],
            "context_block": "",
        }

    chunks = chunk_text(doc, size=400, overlap=50)
    if not chunks:
        return {
            "enabled": False,
            "reason": "未切出可用片段",
            "chunks": [],
            "context_block": "",
        }

    # 1. 索引当前文档（幂等：先删同 session 旧块再写）
    vector_store.add_document(
        doc_id=session_id,
        text=doc,
        metadata={"session_id": session_id, "scenario": scenario_id},
    )

    # 2. 构造查询
    hint = SCENARIO_QUERY_HINT.get(scenario_id, SCENARIO_QUERY_HINT["general"])
    head = doc[:200]
    query = f"{hint} {query_extra} {head}"
    query_tokens = _tokenize(query)
    chunk_tokens = [_tokenize(c) for c in chunks]

    recall_k = max(top_k * _RECALL_MULTIPLIER, top_k + 2)

    # 3a. 稠密召回
    dense = vector_store.query(
        query, top_k=recall_k, filter_metadata={"session_id": session_id}
    )
    text_to_idx = {c: i for i, c in enumerate(chunks)}
    dense_ranking: List[int] = []
    dense_scores: Dict[int, float] = {}
    for res in dense:
        idx = text_to_idx.get(res.get("text") or "")
        if idx is None or idx in dense_scores:
            continue
        dense_scores[idx] = float(res.get("score") or 0.0)
        dense_ranking.append(idx)

    # 3b. 稀疏召回
    bm25 = bm25_scores(query_tokens, chunk_tokens)
    bm25_ranking = _rank_indices(bm25, recall_k)

    # 4. 融合
    fused = _rrf_fuse([dense_ranking, bm25_ranking])
    if not fused:
        return {
            "enabled": False,
            "reason": "未找到相关片段",
            "chunks": [],
            "context_block": "",
        }

    # 5. 重排：RRF 归一到 [0,1] + 词面覆盖度
    max_rrf = max(fused.values()) or 1.0
    scored: List[Tuple[int, float, float]] = []
    for idx, rrf in fused.items():
        base = rrf / max_rrf
        cover = _coverage(query_tokens, chunk_tokens[idx])
        scored.append((idx, base + _COVERAGE_WEIGHT * cover, cover))
    scored.sort(key=lambda x: x[1], reverse=True)

    out_chunks = []
    lines = [
        "【检索片段】多路召回（向量 + BM25）后按相关度重排，"
        "请优先依据下列内容作答"
    ]
    for rank, (idx, final, cover) in enumerate(scored[:top_k], start=1):
        text = chunks[idx]
        out_chunks.append(
            {
                "id": rank,
                "text": text,
                "score": round(float(final), 3),
                "vector_score": round(dense_scores.get(idx, 0.0), 3),
                "bm25_score": round(float(bm25[idx]), 3),
                "coverage": round(float(cover), 3),
            }
        )
        lines.append(
            f"\n—— 片段{rank} (融合分: {final:.2f} / 向量: "
            f"{dense_scores.get(idx, 0.0):.2f} / BM25: {bm25[idx]:.2f}) ——\n{text}"
        )

    return {
        "enabled": True,
        "reason": (
            f"向量召回 {len(dense_ranking)} 条 + BM25 召回 {len(bm25_ranking)} 条，"
            f"RRF 融合后重排取前 {len(out_chunks)} 条"
        ),
        "chunks": out_chunks,
        "context_block": "\n".join(lines).strip(),
    }


def build_rag_user_prompt(original: str, context_block: str) -> str:
    original = (original or "").strip()
    return (
        f"{context_block}\n\n"
        "【用户原文 / 分析请求】\n"
        f"{original}\n\n"
        "请基于【检索片段】完成本次文书分析；片段未覆盖处写「原文未写清/未检索到」，"
        "不要编造数字与条款。"
    )

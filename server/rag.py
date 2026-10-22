"""
迷你 RAG（无向量库依赖）：对用户粘贴的长文切块 + 关键词重叠检索。
用于前端加分演示：检索增强后再生成，降低胡编、便于标注出处。
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

# 各文书模版检索查询偏置（叠加在用户原文前部）
SCENARIO_QUERY_HINT: Dict[str, str] = {
    "general": "费用 金额 期限 违约 解除 续约 管辖 付款",
    "rental": "押金 租金 涨租 退租 维修 转租 逾期 滞纳",
    "labor": "薪资 试用 竞业 培训 社保 公积金 解除 Offer",
    "training": "学费 退费 违约金 贷款 分期 课时 开课",
    "credit": "利息 手续费 逾期 罚息 提前还款 扣款 免息",
}


def _tokenize(text: str) -> List[str]:
    text = (text or "").lower()
    toks: List[str] = []
    for m in re.finditer(r"[a-z0-9]{2,}|[\u4e00-\u9fff]{2}", text):
        toks.append(m.group(0))
    # 中文单字对短句也给一点信号
    for ch in re.findall(r"[\u4e00-\u9fff]", text):
        toks.append(ch)
    return toks


def chunk_text(text: str, size: int = 280, overlap: int = 50) -> List[str]:
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


def _score(query_toks: List[str], chunk: str) -> float:
    if not query_toks:
        return 0.0
    ct = set(_tokenize(chunk))
    if not ct:
        return 0.0
    hit = sum(1 for t in query_toks if t in ct)
    # 略偏向更长命中
    return hit / (len(set(query_toks)) ** 0.5)


def retrieve_chunks(
    document: str,
    *,
    scenario_id: str = "general",
    query_extra: str = "",
    top_k: int = 4,
    min_doc_chars: int = 180,
) -> Dict[str, Any]:
    """
    返回 {enabled, reason?, chunks:[{id,text,score}], context_block}
    """
    doc = (document or "").strip()
    # 去掉我们自己加的照片标记，避免污染切块
    doc = re.sub(r"\n*【附文书照片】[\s\S]*$", "", doc).strip()

    if len(doc) < min_doc_chars:
        return {
            "enabled": False,
            "reason": "正文过短，跳过检索（直接全文分析）",
            "chunks": [],
            "context_block": "",
        }

    chunks = chunk_text(doc)
    if len(chunks) <= 1:
        return {
            "enabled": False,
            "reason": "无需切块，跳过检索",
            "chunks": [],
            "context_block": "",
        }

    hint = SCENARIO_QUERY_HINT.get(scenario_id, SCENARIO_QUERY_HINT["general"])
    # 用户前 200 字 + 模版关键词，当作检索 query
    head = doc[:200]
    q = f"{hint} {query_extra} {head}"
    q_toks = _tokenize(q)

    ranked: List[Tuple[float, int, str]] = []
    for idx, ch in enumerate(chunks):
        ranked.append((_score(q_toks, ch), idx, ch))
    ranked.sort(key=lambda x: (-x[0], x[1]))

    picked = ranked[: max(1, top_k)]
    # 若全 0 分，退回前 top_k 段（保底有上下文）
    if all(s <= 0 for s, _, _ in picked):
        picked = [(0.0, i, chunks[i]) for i in range(min(top_k, len(chunks)))]

    out_chunks = []
    lines = ["【检索片段】（请优先依据下列原文作答，并在要点中注明片段编号）"]
    for rank, (score, _idx, text) in enumerate(picked, start=1):
        out_chunks.append(
            {"id": rank, "text": text, "score": round(float(score), 3)}
        )
        lines.append(f"\n—— 片段{rank} ——\n{text}")

    return {
        "enabled": True,
        "reason": f"已检索 {len(out_chunks)} 段原文",
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

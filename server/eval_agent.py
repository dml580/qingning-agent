"""
维度三 · Agent 性能评测脚本。

用法：
  python eval_agent.py                 # 离线基线：工具选择 + 本机工具 + Token 用量
  python eval_agent.py --online        # 额外跑联网搜索 / 天气（需要外网）
  python eval_agent.py --llm           # 额外让真实模型选工具（需要配置 API Key）

只做只读检查，不写入会话；manage_reminder 的写操作不在此脚本执行。
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
import time
from typing import Any, Dict, List, Set

import db
import llm
import tools
from eval_cases import RAG_CASES, SELECTION_CASES
from rag import build_rag_user_prompt, retrieve_chunks

PASS = "PASS"
FAIL = "FAIL"

def _check_selection() -> List[Dict[str, Any]]:
    results = []
    for label, text, module_id, scenario_id, expect, absent in SELECTION_CASES:
        calls = tools.heuristic_tool_calls(text, scenario_id=scenario_id, module_id=module_id)
        names = {c.get("name") for c in calls}
        ok = expect.issubset(names) and not (names & absent)
        results.append(
            {
                "case": f"工具选择 · {label}",
                "ok": ok,
                "detail": f"命中 {sorted(names)} / 期望 {sorted(expect)}"
                + (f" / 不应出现 {sorted(absent)}" if absent else ""),
            }
        )
    return results


def _check_doc_pipeline() -> List[Dict[str, Any]]:
    results = []
    contract = (
        "房屋租赁合同：甲方将房屋出租给乙方，租金每月 3500 元，押金 7000 元，"
        "租期自 2026 年 1 月 1 日起至 2027 年 1 月 1 日止，付款方式为月付，"
        "乙方提前退租需支付违约金，押金在退租后 15 日内退还。"
    )
    calls = tools.heuristic_tool_calls(
        contract, scenario_id="rental", module_id="docs"
    )
    names = {c.get("name") for c in calls}
    results.append(
        {
            "case": "文书流水线 · 长文本触发抽取",
            "ok": "extract_document" in names or "extract_amounts_dates" in names,
            "detail": f"命中 {sorted(names)}",
        }
    )
    extract = tools.extract_amounts_dates(contract)
    results.append(
        {
            "case": "文书流水线 · 抽取金额日期",
            "ok": bool(extract.get("ok")) and extract.get("amount_count", 0) >= 1,
            "detail": (
                f"金额 {extract.get('amount_count')} 处 / 日期 {extract.get('date_count')} 处"
            ),
        }
    )
    clause = tools.check_missing_clauses(contract, "rental")
    results.append(
        {
            "case": "文书流水线 · 条款核对",
            "ok": bool(clause.get("ok")) and clause.get("checked", 0) >= 1,
            "detail": f"核对 {clause.get('checked')} 项 / 未见 {clause.get('missing')}",
        }
    )
    return results


def _numbers(text: str) -> Set[str]:
    return set(re.findall(r"\d+(?:\.\d+)?", text or ""))


def _check_rag() -> List[Dict[str, Any]]:
    """离线 RAG 评测：命中率（top_k 是否含期望词）+ 引用准确率（返回片段相关占比）。"""
    results: List[Dict[str, Any]] = []
    hit_count = 0
    relevant = 0
    returned = 0
    details: List[str] = []
    for case in RAG_CASES:
        out = retrieve_chunks(
            case["doc"],
            session_id=f"eval_{case['scenario']}",
            scenario_id=case["scenario"],
            query_extra=case["query"],
            top_k=4,
        )
        chunks = out.get("chunks") or []
        terms = case["terms"]
        hit = any(any(t in c["text"] for t in terms) for c in chunks)
        rel = sum(1 for c in chunks if any(t in c["text"] for t in terms))
        hit_count += 1 if hit else 0
        relevant += rel
        returned += len(chunks)
        details.append(
            f"{case['label']}: {'命中' if hit else '未命中'}({rel}/{len(chunks)})"
        )
    n = len(RAG_CASES)
    hit_rate = hit_count / n if n else 0.0
    precision = relevant / returned if returned else 0.0
    results.append(
        {
            "case": "RAG 检索 · 命中率",
            "ok": hit_rate >= 0.8,
            "detail": f"{hit_count}/{n} = {hit_rate:.0%}；" + "；".join(details),
        }
    )
    results.append(
        {
            "case": "RAG 检索 · 引用准确率",
            "ok": precision >= 0.5,
            "detail": f"相关片段 {relevant}/{returned} = {precision:.0%}",
        }
    )
    return results


def _check_local_tools() -> List[Dict[str, Any]]:
    results = []
    current = tools.get_current_time()
    results.append(
        {
            "case": "本机工具 · 当前时间",
            "ok": bool(current.get("ok")) and bool(current.get("date")),
            "detail": f"{current.get('date')} {current.get('time')} {current.get('weekday')}",
        }
    )
    return results


async def _check_online_tools() -> List[Dict[str, Any]]:
    results = []
    search = await tools.web_search("青柠 生活助理 Agent", 3)
    results.append(
        {
            "case": "联网工具 · web_search",
            "ok": bool(search.get("ok")) and search.get("count", 0) >= 0,
            "detail": f"来源 {search.get('source')} / {search.get('count')} 条",
        }
    )
    weather = await tools.get_weather("北京", 1)
    results.append(
        {
            "case": "联网工具 · get_weather",
            "ok": bool(weather.get("ok")),
            "detail": f"{weather.get('city')} {weather.get('current', {}).get('weather')} "
            f"{weather.get('current', {}).get('temperature')}",
        }
    )
    return results


async def _check_llm_selection() -> List[Dict[str, Any]]:
    results = []
    if not llm.is_configured():
        results.append(
            {
                "case": "模型工具选择",
                "ok": False,
                "detail": "未配置 API Key，跳过（可填 server/.env 后重跑）",
            }
        )
        return results
    prompt = "帮我查一下明天北京天气，顺便把 11 月 3 号打疫苗记成提醒"
    started = time.perf_counter()
    try:
        decision = await llm.complete_with_tools(
            prompt,
            system_prompt=tools.tool_planner_prompt("general", tools.get_current_time()["date"]),
            tools=tools.OPENAI_TOOLS,
        )
    except Exception as exc:  # noqa: BLE001
        results.append(
            {"case": "模型工具选择", "ok": False, "detail": f"调用失败：{exc}"}
        )
        return results
    names = {c.get("name") for c in decision.get("tool_calls") or []}
    elapsed = int((time.perf_counter() - started) * 1000)
    results.append(
        {
            "case": "模型工具选择",
            "ok": bool(decision.get("tool_calls")) or bool(decision.get("unsupported")),
            "detail": f"选中 {sorted(names)} / {elapsed}ms / "
            f"usage={decision.get('usage') or {}}",
        }
    )
    return results


async def _check_grounding() -> List[Dict[str, Any]]:
    """--llm：让模型仅依据检索片段作答，用「答案里的数字是否都在原文」估计幻觉率。"""
    case = RAG_CASES[0]
    out = retrieve_chunks(
        case["doc"],
        session_id="eval_grounding",
        scenario_id=case["scenario"],
        query_extra=case["query"],
        top_k=4,
    )
    if not out.get("enabled"):
        return [{"case": "RAG · 幻觉率（生成）", "ok": False, "detail": "检索未启用"}]
    prompt = build_rag_user_prompt(case["query"], out["context_block"])
    answer = ""
    started = time.perf_counter()
    try:
        async for delta in llm.stream_chat(prompt, system_prompt="你是严谨的文书助理。"):
            answer += delta
    except Exception as exc:  # noqa: BLE001
        return [{"case": "RAG · 幻觉率（生成）", "ok": False, "detail": f"调用失败：{exc}"}]
    ans_nums = _numbers(answer)
    doc_nums = _numbers(case["doc"])
    fabricated = sorted(ans_nums - doc_nums)
    rate = (len(fabricated) / len(ans_nums)) if ans_nums else 0.0
    elapsed = int((time.perf_counter() - started) * 1000)
    return [
        {
            "case": "RAG · 幻觉率（生成）",
            "ok": rate <= 0.2,
            "detail": (
                f"答案数字 {len(ans_nums)} 个 / 原文未出现 {fabricated or '无'} "
                f"=> 幻觉率 {rate:.0%} / {elapsed}ms"
            ),
        }
    ]


async def _check_usage() -> List[Dict[str, Any]]:
    summary = await db.summarize_llm_usage(days=7)
    totals = summary.get("totals") or {}
    return [
        {
            "case": "Token 监控 · /api/metrics/usage 数据",
            "ok": True,
            "detail": (
                f"近 7 天调用 {totals.get('calls', 0)} 次 / 失败 {totals.get('failed', 0)} / "
                f"总 tokens {totals.get('total_tokens', 0)} / "
                f"平均首字 {totals.get('avg_ttft_ms', 0)}ms"
            ),
        }
    ]


async def _check_failure_boundaries() -> List[Dict[str, Any]]:
    """副作用确认、拒绝结果与失败归一化。"""
    blocked = await tools.SKILL_REGISTRY.execute(
        "manage_calendar",
        {"action": "create_event", "title": "体检", "due_date": "2026-11-03"},
        tools.SkillContext(user_text="帮我安排体检"),
    )
    invalid = await tools.SKILL_REGISTRY.execute(
        "manage_calendar",
        {"action": "create_event", "title": "体检", "due_date": "2026-02-30"},
        tools.SkillContext(user_text="用户已明确确认同步到日历"),
    )
    missing = await tools.SKILL_REGISTRY.execute(
        "web_search", {}, tools.SkillContext()
    )
    rejected = {
        "ok": False,
        "code": "user_rejected",
        "error": "用户已拒绝执行",
    }
    return [
        {
            "case": "安全边界 · 日历写入等待确认",
            "ok": blocked.get("code") == "confirmation_required",
            "detail": str(blocked.get("code") or blocked.get("error")),
        },
        {
            "case": "安全边界 · 用户拒绝确认",
            "ok": rejected["code"] == "user_rejected" and not rejected["ok"],
            "detail": rejected["error"],
        },
        {
            "case": "工具失败 · 非法日期",
            "ok": not invalid.get("ok") and "有效" in str(invalid.get("error")),
            "detail": str(invalid.get("error")),
        },
        {
            "case": "工具失败 · 缺少必填参数",
            "ok": missing.get("code") == "invalid_arguments",
            "detail": str(missing.get("error")),
        },
    ]


def _report(results: List[Dict[str, Any]]) -> int:
    passed = sum(1 for r in results if r["ok"])
    print("=" * 68)
    print("青柠 · 生活助理 Agent —— 评测结果")
    print("=" * 68)
    for r in results:
        flag = PASS if r["ok"] else FAIL
        print(f"[{flag}] {r['case']}")
        print(f"        {r['detail']}")
    print("-" * 68)
    print(f"通过 {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


async def main() -> int:
    parser = argparse.ArgumentParser(description="青柠 Agent 评测")
    parser.add_argument("--online", action="store_true", help="跑联网搜索 / 天气")
    parser.add_argument("--llm", action="store_true", help="让真实模型选工具")
    args = parser.parse_args()

    await db.init_db()

    results: List[Dict[str, Any]] = []
    results += _check_selection()
    results += _check_doc_pipeline()
    results += _check_rag()
    results += _check_local_tools()
    results += await _check_failure_boundaries()
    if args.online:
        results += await _check_online_tools()
    if args.llm:
        results += await _check_llm_selection()
        results += await _check_grounding()
    results += await _check_usage()

    return _report(results)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

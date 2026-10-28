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
from typing import Any, Dict, List, Set, Tuple

import db
import llm
import tools
from rag import build_rag_user_prompt, retrieve_chunks

PASS = "PASS"
FAIL = "FAIL"

# (说明, 用户输入, module_id, scenario_id, 期望出现, 期望不出现)
SELECTION_CASES: List[Tuple[str, str, str, str, set, set]] = [
    ("记提醒", "帮我记一下 11月3号 打疫苗", "docs", "general", {"manage_reminder"}, set()),
    ("查时间", "现在几点了", "docs", "general", {"get_current_time"}, set()),
    ("查天气", "北京今天天气怎么样", "docs", "general", {"get_weather"}, set()),
    ("联网搜索", "帮我搜一下最新的房贷利率", "docs", "general", {"web_search"}, set()),
    (
        "非文书模块不放行文书工具",
        "帮我记一下 11月3号 打疫苗",
        "chat",
        "general",
        set(),
        {"manage_reminder"},
    ),
]

# RAG 检索评测：每例给「长文书 + 场景 + 问题 + 期望命中词」。
# 命中率：top_k 片段里是否至少命中一个期望词；
# 引用准确率：返回片段里真正相关（含期望词）的比例。
RAG_CASES: List[Dict[str, Any]] = [
    {
        "label": "租赁 · 押金退还",
        "scenario": "rental",
        "query": "押金什么时候退还，退多少",
        "terms": {"押金", "退还"},
        "doc": (
            "房屋租赁合同\n甲方出租方：张三\n乙方承租方：李四\n"
            "第一条 租赁物：甲方将位于北京市朝阳区某小区 3 号楼 801 室出租给乙方居住使用。\n"
            "第二条 租期：自 2026 年 1 月 1 日起至 2026 年 12 月 31 日止，共 12 个月。"
            "到期前 30 日乙方可提出续租，续租租金双方另行协商。\n"
            "第三条 租金：每月租金人民币 6500 元整，乙方应于每月 5 日前支付当月租金。"
            "逾期支付的，每逾期一日按应付租金的 0.5% 支付滞纳金。\n"
            "第四条 押金：乙方于签约时支付押金 13000 元（相当于两个月租金）。"
            "租赁期满且乙方无违约、房屋无损坏的，甲方应于 7 个工作日内无息退还押金。\n"
            "第五条 涨租：租赁期内租金保持不变；续租时甲方有权调整租金，涨幅不超过 5%。\n"
            "第六条 维修：房屋主体结构及原有设施的自然损坏由甲方负责维修；"
            "因乙方使用不当造成的损坏由乙方负责修复或赔偿。\n"
            "第七条 提前退租：乙方如需提前退租，应提前 30 日书面通知甲方，"
            "并支付相当于一个月租金的违约金。\n"
            "第八条 转租：未经甲方书面同意，乙方不得将房屋转租给第三方。\n"
            "第九条 争议解决：因本合同发生的争议，双方协商不成的，提交房屋所在地人民法院诉讼解决。"
        ),
    },
    {
        "label": "劳动 · 试用期与竞业",
        "scenario": "labor",
        "query": "试用期多久，离职后竞业限制怎么约定",
        "terms": {"试用期", "竞业"},
        "doc": (
            "劳动合同\n甲方用人单位：某科技公司\n乙方劳动者：王五\n"
            "第一条 岗位与期限：乙方担任后端工程师，合同期自 2026 年 3 月 1 日起至 2029 年 2 月 28 日止。\n"
            "第二条 试用期：试用期 3 个月，自 2026 年 3 月 1 日至 2026 年 5 月 31 日，"
            "试用期工资为转正后工资的 80%。\n"
            "第三条 薪资结构：月薪 20000 元，其中底薪 14000 元、绩效 6000 元，"
            "每月 15 日发放上月工资，另有交通补贴 500 元。\n"
            "第四条 五险一金：甲方依法为乙方缴纳社会保险与住房公积金，基数按实际工资核定。\n"
            "第五条 工作时间：标准工时制，加班可申请调休或依法支付加班费。\n"
            "第六条 竞业限制：乙方离职后 12 个月内不得入职与甲方有竞争关系的企业，"
            "甲方按月支付竞业补偿金 6000 元。\n"
            "第七条 解除条件：乙方提前 30 日书面通知可解除本合同；"
            "因严重违纪被辞退的，甲方无需支付经济补偿。"
        ),
    },
    {
        "label": "信贷 · 利率与逾期",
        "scenario": "credit",
        "query": "年化利率多少，逾期怎么罚息，能不能提前还款",
        "terms": {"利率", "逾期", "提前还款"},
        "doc": (
            "个人消费贷款合同\n贷款人：某消费金融公司\n借款人：赵六\n"
            "第一条 贷款金额：本金人民币 50000 元整，贷款期限 24 个月。\n"
            "第二条 利率：本合同采用固定利率，贷款年化利率 12%，"
            "另按贷款本金的 1% 收取一次性手续费。\n"
            "第三条 还款方式：等额本息，每月 10 日为还款日，"
            "账单日为每月 1 日，借款人应确保扣款账户余额充足。\n"
            "第四条 逾期罚息：借款人逾期还款的，自逾期之日起按日利率万分之五计收罚息，"
            "并可能产生滞纳金。\n"
            "第五条 提前还款：借款人可申请提前结清，"
            "提前还款需支付剩余本金 2% 的违约金。\n"
            "第六条 自动扣款：借款人授权贷款人在还款日从绑定账户自动扣款。"
        ),
    },
]


def _check_selection() -> List[Dict[str, Any]]:
    results = []
    for label, text, module_id, scenario_id, expect, absent in SELECTION_CASES:
        calls = tools.heuristic_tool_calls(text, scenario_id=scenario_id, module_id=module_id)
        names = {c.get("name") for c in calls}
        ok = (not expect or bool(names & expect)) and not (names & absent)
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
    if args.online:
        results += await _check_online_tools()
    if args.llm:
        results += await _check_llm_selection()
        results += await _check_grounding()
    results += await _check_usage()

    return _report(results)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

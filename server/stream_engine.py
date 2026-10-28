"""In-memory generation jobs: chunk buffer, cancel flag, resume by seq."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional

import db
import memory
from llm import complete_with_tools, is_configured, stream_chat
from tools import (
    DOC_TOOLS,
    LIFE_TOOLS,
    OPENAI_TOOLS,
    build_tool_context_block,
    execute_tool,
    heuristic_tool_calls,
    parse_tool_arguments,
    public_agent_meta,
    tool_call_meta,
    tool_planner_prompt,
)


@dataclass
class StreamChunk:
    seq: int
    text: str


@dataclass
class GenerationJob:
    message_id: str
    session_id: str
    prompt: str
    history: List[Dict[str, str]] = field(default_factory=list)
    system_prompt: Optional[str] = None
    image_data_url: Optional[str] = None
    user_text: str = ""
    module_id: str = "docs"
    scenario_id: str = "general"
    use_agent: bool = False
    agent_meta: Optional[Dict[str, Any]] = None
    agent_run_id: Optional[str] = None
    # 流式 tool 事件：规划 / 开始执行 / 执行完成，边跑边推给前端。
    tool_events: List[Dict[str, Any]] = field(default_factory=list)
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    chunks: List[StreamChunk] = field(default_factory=list)
    done: bool = False
    failed: bool = False
    error: Optional[str] = None
    waiters: List[asyncio.Event] = field(default_factory=list)

    def notify(self) -> None:
        for ev in self.waiters:
            ev.set()
        self.waiters.clear()

    def add_chunk(self, text: str) -> StreamChunk:
        seq = len(self.chunks)
        chunk = StreamChunk(seq=seq, text=text)
        self.chunks.append(chunk)
        self.notify()
        return chunk

    def chunks_from(self, from_seq: int) -> List[StreamChunk]:
        return [c for c in self.chunks if c.seq >= from_seq]

    def push_tool_event(self, phase: str, **fields: Any) -> Dict[str, Any]:
        """追加一条 tool 事件并唤醒 SSE 循环。seq 单调递增，便于前端整表替换。"""
        event = {"seq": len(self.tool_events), "phase": phase}
        event.update(fields)
        self.tool_events.append(event)
        self.notify()
        return event

    async def wait_next(self, after_seq: int, timeout: float = 30.0) -> bool:
        if self.done or self.failed or self.cancel_event.is_set():
            return True
        if any(c.seq > after_seq for c in self.chunks):
            return True
        ev = asyncio.Event()
        self.waiters.append(ev)
        try:
            await asyncio.wait_for(ev.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            if ev in self.waiters:
                self.waiters.remove(ev)
            return False


_jobs: Dict[str, GenerationJob] = {}


def get_job(message_id: str) -> Optional[GenerationJob]:
    return _jobs.get(message_id)


def register_job(job: GenerationJob) -> None:
    _jobs[job.message_id] = job


def remove_job(message_id: str) -> None:
    _jobs.pop(message_id, None)


def cancel_job(message_id: str) -> bool:
    job = _jobs.get(message_id)
    if not job:
        return False
    job.cancel_event.set()
    job.notify()
    return True


_DEMO_PARAGRAPHS = [
    "（演示模式）未配置 ARK_API_KEY，当前输出为本地假流，用于验证状态机与虚拟列表。",
    "在 server/.env 写入火山方舟密钥后，将改为豆包真流式回答。",
    "连接建立后进入 generating，只有收到 done 才能落库为 completed。",
    "中途断开时内容可能半截，状态必须是 failed 或 cancelled，不能写成成功。",
    "每个 chunk 带单调递增 seq；前端用 lastSeq 去重，重连从 from_seq 续传。",
    "长回复拆成多段虚拟行，滚动时只挂视口附近的节点。",
]


def build_reply_tokens(prompt: str) -> List[str]:
    header = f"收到：「{prompt[:80]}」\n\n"
    body_parts: List[str] = []
    for i in range(24):
        p = _DEMO_PARAGRAPHS[i % len(_DEMO_PARAGRAPHS)]
        body_parts.append(f"[{i + 1}] {p}\n")
    full = header + "".join(body_parts)
    tokens: List[str] = []
    i = 0
    while i < len(full):
        step = 12 if (i // 12) % 3 else 8
        tokens.append(full[i : i + step])
        i += step
    return tokens


async def _emit(job: GenerationJob, text: str, persist_chunk) -> None:
    chunk = job.add_chunk(text)
    await persist_chunk(chunk.seq, chunk.text)


def _cancelled(job: GenerationJob) -> bool:
    return job.cancel_event.is_set()


async def _record_usage(
    job: GenerationJob,
    *,
    kind: str,
    provider: str = "",
    model: str = "",
    usage: Optional[Dict[str, Any]] = None,
    ttft_ms: Optional[int] = None,
    total_ms: Optional[int] = None,
    ok: bool = True,
    error: str = "",
) -> None:
    """落库一条用量记录。监控失败不能影响正常生成，因此这里吞掉异常。"""
    payload = usage or {}
    try:
        await db.record_llm_usage(
            kind=kind,
            provider=provider,
            model=model,
            session_id=job.session_id,
            message_id=job.message_id,
            prompt_tokens=payload.get("prompt_tokens"),
            completion_tokens=payload.get("completion_tokens"),
            total_tokens=payload.get("total_tokens"),
            ttft_ms=ttft_ms,
            total_ms=total_ms,
            ok=ok,
            error=error,
        )
    except Exception:  # noqa: BLE001
        pass


async def _run_agent_round(job: GenerationJob) -> List[Dict[str, Any]]:
    """一轮 tool calling：模型选工具 → 本机执行 → 结果挂到 job。只跑一轮。"""
    if not job.use_agent:
        job.agent_meta = {"enabled": False, "calls": [], "wrote_reminders": False}
        job.notify()
        return []

    allowed = set(LIFE_TOOLS)
    if job.module_id == "docs":
        allowed |= DOC_TOOLS
    elif job.module_id == "reminders":
        allowed.add("manage_reminder")

    user_text = job.user_text or job.prompt
    run = await db.create_agent_run(job.session_id, job.message_id, user_text)
    job.agent_run_id = run["id"]
    runs: List[Dict[str, Any]] = []
    seen_calls = set()
    planner_input = user_text
    job.push_tool_event("planning")
    if is_configured() and not job.image_data_url:
        try:
            for round_index in range(5):
                decision = await complete_with_tools(
                    planner_input,
                    history=job.history if round_index == 0 else [],
                    system_prompt=(
                        tool_planner_prompt(job.scenario_id, date.today().isoformat())
                        + "\n每轮根据已有工具结果判断下一步；目标已完成时不要再调用工具。"
                    ),
                    tools=OPENAI_TOOLS,
                    should_cancel=lambda: job.cancel_event.is_set(),
                )
                if _cancelled(job):
                    return runs
                if "elapsed_ms" in decision:
                    await _record_usage(
                        job,
                        kind="tool",
                        provider=str(decision.get("provider") or ""),
                        model=str(decision.get("model") or ""),
                        usage=decision.get("usage"),
                        total_ms=decision.get("elapsed_ms"),
                        ok=not decision.get("error"),
                        error=str(decision.get("error") or ""),
                    )
                if decision.get("unsupported"):
                    planned = heuristic_tool_calls(
                        user_text, scenario_id=job.scenario_id, module_id=job.module_id
                    )
                else:
                    planned = []
                    round_names = set()
                    remaining = 5 - len(runs)
                    for call in decision.get("tool_calls") or []:
                        name = call.get("name") or ""
                        args = parse_tool_arguments(call.get("arguments"))
                        signature = (name, json.dumps(args, sort_keys=True, ensure_ascii=False))
                        if name in round_names or name not in allowed or signature in seen_calls:
                            continue
                        round_names.add(name)
                        seen_calls.add(signature)
                        planned.append({"id": call.get("id") or f"call_{len(runs)}", "name": name, "arguments": args})
                        if len(planned) >= remaining:
                            break
                if not planned:
                    if not runs:
                        job.push_tool_event("idle")
                    break
                for call in planned:
                    if _cancelled(job):
                        return runs
                    args = dict(call.get("arguments") or {})
                    if call["name"] in {"extract_amounts_dates", "check_missing_clauses"}:
                        if not str(args.get("document") or "").strip():
                            args["document"] = user_text
                        if call["name"] == "check_missing_clauses" and not args.get("scenario_id"):
                            args["scenario_id"] = job.scenario_id
                    job.push_tool_event("running", name=call["name"])
                    result = await execute_tool(
                        call["name"], args, scenario_id=job.scenario_id, user_text=user_text
                    )
                    item = {"name": call["name"], "arguments": args, "result": result}
                    runs.append(item)
                    await db.record_agent_step(job.agent_run_id, len(runs), call["name"], args, result)
                    job.push_tool_event("done", **tool_call_meta(call["name"], result))
                if len(runs) >= 5:
                    break
                planner_input = f"用户目标：{user_text}\n\n{build_tool_context_block(runs)}\n\n请判断是否还需要调用一个新的 Skill。"
                job.push_tool_event("planning", round=round_index + 2)
                job.agent_meta = public_agent_meta(runs, job.agent_run_id)
                job.notify()
                if decision.get("unsupported"):
                    break
        except Exception:  # noqa: BLE001
            if not runs:
                planned = heuristic_tool_calls(
                    user_text, scenario_id=job.scenario_id, module_id=job.module_id
                )
                for call in planned[:5]:
                    args = dict(call.get("arguments") or {})
                    result = await execute_tool(
                        call["name"], args, scenario_id=job.scenario_id, user_text=user_text
                    )
                    runs.append({"name": call["name"], "arguments": args, "result": result})
                    await db.record_agent_step(job.agent_run_id, len(runs), call["name"], args, result)
    else:
        planned = heuristic_tool_calls(
            user_text, scenario_id=job.scenario_id, module_id=job.module_id
        )
        for call in planned[:5]:
            if call["name"] not in allowed:
                continue
            args = dict(call.get("arguments") or {})
            job.push_tool_event("running", name=call["name"])
            result = await execute_tool(
                call["name"], args, scenario_id=job.scenario_id, user_text=user_text
            )
            runs.append({"name": call["name"], "arguments": args, "result": result})
            await db.record_agent_step(job.agent_run_id, len(runs), call["name"], args, result)
            job.push_tool_event("done", **tool_call_meta(call["name"], result))
        if not planned:
            job.push_tool_event("idle")

    job.agent_meta = public_agent_meta(runs, job.agent_run_id)
    job.notify()

    block = build_tool_context_block(runs)
    if block:
        job.prompt = f"{job.prompt}\n\n{block}"
        extra = (
            "\n\n【Agent 工具】若消息含【工具结果】，必须依据工具返回作答："
            "金额、日期、缺条款和提醒状态引用工具结果；联网命中附上来源链接；"
            "工具失败处写明失败原因，不要编造成功。"
        )
        job.system_prompt = f"{job.system_prompt or ''}{extra}"
    return runs


def build_agent_demo_tokens(job: GenerationJob) -> List[str]:
    meta = job.agent_meta or {}
    lines = ["（演示模式）未配置 API Key，下面根据本轮工具结果说明，不另起模型。\n\n"]
    calls = meta.get("calls") or []
    if not calls:
        lines.append("这一轮没有调用工具。配好密钥后，模型会自己决定抽条款、查缺项或改提醒。\n")
    else:
        lines.append("本轮调用：\n")
        for c in calls:
            mark = "完成" if c.get("ok") else "失败"
            lines.append(f"- {c.get('label') or c.get('name')}：{c.get('summary')}（{mark}）\n")
        lines.append("\n生活助理会按工具结果回答，而不是先编一段再核对。\n")
    full = "".join(lines)
    tokens: List[str] = []
    i = 0
    while i < len(full):
        tokens.append(full[i : i + 10])
        i += 10
    return tokens


async def _inject_memory(job: GenerationJob) -> None:
    """把本机轻量记忆拼进 system prompt；失败不影响生成。"""
    try:
        hint = memory.build_memory_hint(await memory.snapshot())
    except Exception:  # noqa: BLE001
        hint = ""
    if hint:
        job.system_prompt = f"{job.system_prompt or ''}{hint}"


async def run_generation(job: GenerationJob, persist_chunk, settle) -> None:
    """
    Produce tokens from Doubao when configured, else demo corpus.
    Guarantees: never settle(completed) after cancel/fail.
    """
    try:
        await _inject_memory(job)
        if job.use_agent:
            await _run_agent_round(job)
            if job.cancel_event.is_set():
                job.done = True
                job.notify()
                await settle("cancelled")
                return

        if is_configured():
            metrics: Dict[str, Any] = {}
            stream_error = ""
            try:
                async for text in stream_chat(
                    job.prompt,
                    history=job.history,
                    should_cancel=lambda: job.cancel_event.is_set(),
                    system_prompt=job.system_prompt,
                    image_data_url=job.image_data_url,
                    metrics=metrics,
                ):
                    if job.cancel_event.is_set():
                        job.done = True
                        job.notify()
                        await settle("cancelled")
                        return
                    if not text:
                        continue
                    await _emit(job, text, persist_chunk)
            except Exception as exc:  # noqa: BLE001
                stream_error = str(exc)
                raise
            finally:
                await _record_usage(
                    job,
                    kind=str(metrics.get("kind") or "chat"),
                    provider=str(metrics.get("provider") or ""),
                    model=str(metrics.get("model") or ""),
                    usage=metrics,
                    ttft_ms=metrics.get("ttft_ms"),
                    total_ms=metrics.get("total_ms"),
                    ok=not stream_error,
                    error=stream_error,
                )
        else:
            agent_used = bool((job.agent_meta or {}).get("enabled"))
            tokens = (
                build_agent_demo_tokens(job)
                if agent_used
                else build_reply_tokens(job.prompt)
            )
            for text in tokens:
                if job.cancel_event.is_set():
                    job.done = True
                    job.notify()
                    await settle("cancelled")
                    return
                await _emit(job, text, persist_chunk)
                await asyncio.sleep(0.035)

        if job.cancel_event.is_set():
            job.done = True
            job.notify()
            await settle("cancelled")
            return

        job.done = True
        job.notify()
        await settle("completed")
    except Exception as exc:  # noqa: BLE001
        if job.cancel_event.is_set():
            job.done = True
            job.notify()
            await settle("cancelled")
            return
        job.failed = True
        job.error = str(exc)
        job.notify()
        await settle("failed", error=str(exc))
    finally:
        if job.agent_run_id:
            run_status = (
                "cancelled"
                if job.cancel_event.is_set()
                else "failed"
                if job.failed
                else "waiting_confirmation"
                if any(
                    call.get("status") == "waiting_confirmation"
                    for call in (job.agent_meta or {}).get("calls", [])
                )
                else "completed"
            )
            try:
                await db.settle_agent_run(job.agent_run_id, run_status, job.error or "")
            except Exception:  # noqa: BLE001
                pass
        await asyncio.sleep(60)
        remove_job(job.message_id)

"""
Realtime workbench API.

States for assistant messages:
  connecting → generating → completed | failed | cancelled

Rules:
  - Only settle(completed) after a clean done.
  - Partial content on cancel/fail is kept, status is never rewritten to completed.
  - SSE chunks carry seq; clients reconnect with ?from_seq=N to resume without duplicates.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Dict, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import db
from catalog import (
    default_ids,
    get_module,
    get_scenario,
    list_catalog,
    resolve_system_prompt,
    scenario_image_expect,
)
from llm import (
    clear_runtime_settings,
    get_public_settings,
    provider_info,
    review_document_image,
    update_runtime_settings,
)
from stream_engine import GenerationJob, cancel_job, get_job, register_job, run_generation


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await db.init_db()
    yield


app = FastAPI(title="Realtime Workbench", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateSessionBody(BaseModel):
    title: str = "新会话"
    module_id: str = "docs"
    scenario_id: str = "general"


class SendMessageBody(BaseModel):
    content: str = Field("", max_length=8000)
    image_base64: Optional[str] = None
    image_mime: Optional[str] = "image/jpeg"
    module_id: Optional[str] = None
    scenario_id: Optional[str] = None


class RetryBody(BaseModel):
    """Retry creates a new assistant message; failed one stays failed."""

    prompt: Optional[str] = None
    module_id: Optional[str] = None
    scenario_id: Optional[str] = None


class PatchSessionBody(BaseModel):
    module_id: str
    scenario_id: str


class ReviewImageBody(BaseModel):
    image_base64: str = Field(..., min_length=32)
    image_mime: str = "image/jpeg"
    module_id: str = "docs"
    scenario_id: str = "general"


class LlmSettingsBody(BaseModel):
    """api_key 省略则保留原值；传空字符串可清除。"""

    provider: str = "doubao"
    api_key: Optional[str] = None
    model: str = ""
    vision_model: str = ""
    base_url: str = ""


class CreateReminderBody(BaseModel):
    category: str = Field(..., pattern="^(medicine|pet)$")
    title: str = Field(..., min_length=1, max_length=120)
    due_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    note: str = Field("", max_length=500)
    notify_browser: bool = True


class PatchReminderBody(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=120)
    due_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    note: Optional[str] = Field(None, max_length=500)
    done: Optional[bool] = None
    notify_browser: Optional[bool] = None
    category: Optional[str] = Field(None, pattern="^(medicine|pet)$")


def _sse(event: str, data: Dict[str, Any], event_id: Optional[int] = None) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.append(f"data: {payload}")
    lines.append("")
    lines.append("")
    return "\n".join(lines)


@app.get("/api/health")
async def health():
    return {"ok": True, **provider_info()}


@app.get("/api/llm/settings")
async def api_get_llm_settings():
    """返回提供商列表与当前配置（Key 仅脱敏提示，不含明文）。"""
    return get_public_settings()


@app.put("/api/llm/settings")
async def api_put_llm_settings(body: LlmSettingsBody):
    """写入本机运行时配置；Key 只落盘到 server/data/，不回传明文。"""
    payload = body.model_dump(exclude_unset=True)
    return update_runtime_settings(payload)


@app.delete("/api/llm/settings")
async def api_clear_llm_settings():
    """清除页面写入的运行时配置，回退到 .env / 演示模式。"""
    clear_runtime_settings()
    return get_public_settings()


@app.get("/api/catalog")
async def api_catalog():
    return list_catalog()


@app.get("/api/reminders")
async def api_list_reminders(
    category: Optional[str] = Query(None),
    include_done: bool = Query(False),
):
    if category and category not in db.REMINDER_CATEGORIES:
        raise HTTPException(400, "category 须为 medicine 或 pet")
    return await db.list_reminders(category=category, include_done=include_done)


@app.get("/api/reminders/due")
async def api_due_reminders(
    today: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    within_days: int = Query(0, ge=0, le=30),
):
    """打开看板时拉取：今天及过期（within_days=0）或未来 N 天内。"""
    from datetime import date

    day = today or date.today().isoformat()
    return {
        "today": day,
        "items": await db.list_due_reminders(day, within_days=within_days),
    }


@app.post("/api/reminders")
async def api_create_reminder(body: CreateReminderBody):
    return await db.create_reminder(
        category=body.category,
        title=body.title.strip(),
        due_date=body.due_date,
        note=(body.note or "").strip(),
        notify_browser=body.notify_browser,
    )


@app.patch("/api/reminders/{reminder_id}")
async def api_patch_reminder(reminder_id: str, body: PatchReminderBody):
    data = body.model_dump(exclude_unset=True)
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
    if "note" in data and data["note"] is not None:
        data["note"] = data["note"].strip()
    updated = await db.update_reminder(reminder_id, **data)
    if not updated:
        raise HTTPException(404, "提醒不存在")
    return updated


@app.delete("/api/reminders/{reminder_id}")
async def api_delete_reminder(reminder_id: str):
    ok = await db.delete_reminder(reminder_id)
    if not ok:
        raise HTTPException(404, "提醒不存在")
    return {"ok": True}


@app.post("/api/docs/review-image")
async def api_review_image(body: ReviewImageBody):
    """审核上传图片是否为当前文书模版相关照片。"""
    if body.module_id != "docs":
        raise HTTPException(400, "仅生活文书支持图片上传")
    _validate_ids(body.module_id, body.scenario_id)
    scen = get_scenario(body.module_id, body.scenario_id)
    assert scen is not None
    # 限制体积（约 4MB base64）
    if len(body.image_base64) > 5_500_000:
        return {
            "ok": False,
            "related": False,
            "reason": "图片太大了，请压缩后再上传（建议手机拍照后直接选图，或截图缩小）。",
        }
    mime = body.image_mime or "image/jpeg"
    if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
        return {
            "ok": False,
            "related": False,
            "reason": "只支持 JPG / PNG / WebP 图片。",
        }
    result = await review_document_image(
        body.image_base64,
        scenario_id=body.scenario_id,
        scenario_name=scen["name"],
        expect_desc=scenario_image_expect(body.scenario_id),
        mime=mime,
    )
    return result


def _validate_ids(module_id: str, scenario_id: str) -> None:
    mod = get_module(module_id)
    if not mod:
        raise HTTPException(400, f"unknown module: {module_id}")
    if mod.get("status") != "available":
        raise HTTPException(400, f"module not available: {module_id}")
    if not get_scenario(module_id, scenario_id):
        raise HTTPException(400, f"unknown scenario: {scenario_id}")


@app.get("/api/sessions")
async def api_list_sessions(module_id: Optional[str] = None):
    return await db.list_sessions(module_id=module_id)


@app.post("/api/sessions")
async def api_create_session(body: CreateSessionBody):
    _validate_ids(body.module_id, body.scenario_id)
    return await db.create_session(
        body.title,
        module_id=body.module_id,
        scenario_id=body.scenario_id,
    )


@app.patch("/api/sessions/{session_id}")
async def api_patch_session(session_id: str, body: PatchSessionBody):
    if not await db.get_session(session_id):
        raise HTTPException(404, "session not found")
    _validate_ids(body.module_id, body.scenario_id)
    updated = await db.update_session_scenario(
        session_id, body.module_id, body.scenario_id
    )
    return updated


@app.get("/api/sessions/{session_id}")
async def api_get_session(session_id: str):
    sess = await db.get_session(session_id)
    if not sess:
        raise HTTPException(404, "session not found")
    messages = await db.list_messages(session_id)
    return {**sess, "messages": messages}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    ok = await db.delete_session(session_id)
    if not ok:
        raise HTTPException(404, "session not found")
    return {"ok": True}


@app.get("/api/sessions/{session_id}/messages")
async def api_list_messages(session_id: str):
    if not await db.get_session(session_id):
        raise HTTPException(404, "session not found")
    return await db.list_messages(session_id)


def _history_for_llm(messages: list, *, exclude_ids: Optional[set] = None) -> list:
    """Completed turns only; skip empty / in-flight assistants."""
    exclude_ids = exclude_ids or set()
    history = []
    for m in messages:
        if m["id"] in exclude_ids:
            continue
        if m["role"] == "user" and m.get("content"):
            history.append({"role": "user", "content": m["content"]})
        elif (
            m["role"] == "assistant"
            and m.get("status") == "completed"
            and m.get("content")
        ):
            history.append({"role": "assistant", "content": m["content"]})
    return history


def _image_data_url(image_base64: Optional[str], mime: Optional[str]) -> Optional[str]:
    if not image_base64:
        return None
    raw = image_base64.strip()
    if raw.startswith("data:"):
        return raw
    return f"data:{mime or 'image/jpeg'};base64,{raw}"


async def _start_generation(
    session_id: str,
    prompt: str,
    *,
    module_id: Optional[str] = None,
    scenario_id: Optional[str] = None,
    insert_user: bool = True,
    image_base64: Optional[str] = None,
    image_mime: Optional[str] = None,
) -> Dict[str, Any]:
    sess = await db.get_session(session_id)
    if not sess:
        raise HTTPException(404, "session not found")

    mid = module_id or sess.get("module_id") or default_ids()["module_id"]
    sid = scenario_id or sess.get("scenario_id") or default_ids()["scenario_id"]
    _validate_ids(mid, sid)
    if mid != sess.get("module_id") or sid != sess.get("scenario_id"):
        await db.update_session_scenario(session_id, mid, sid)

    image_data_url = _image_data_url(image_base64, image_mime)
    if image_data_url:
        if mid != "docs":
            raise HTTPException(400, "仅生活文书支持图片")
        scen = get_scenario(mid, sid)
        assert scen is not None
        review = await review_document_image(
            image_base64 or "",
            scenario_id=sid,
            scenario_name=scen["name"],
            expect_desc=scenario_image_expect(sid),
            mime=image_mime or "image/jpeg",
        )
        if not review.get("ok"):
            raise HTTPException(
                400,
                detail={
                    "code": "image_rejected",
                    "reason": review.get("reason")
                    or "图片未通过文书相关性审核，请上传相关文书照片。",
                },
            )

    store_prompt = prompt.strip()
    if image_data_url and "【附文书照片】" not in store_prompt:
        store_prompt = (
            f"{store_prompt}\n\n【附文书照片】" if store_prompt else "【附文书照片】请根据照片分析"
        )
    if not store_prompt:
        raise HTTPException(400, "请输入文字或上传文书照片")

    user_msg = None
    if insert_user:
        user_msg = await db.insert_message(
            session_id, role="user", content=store_prompt, status="completed"
        )
        if sess["title"] in ("新会话", "New chat"):
            await db.touch_session(session_id, title=store_prompt[:24] or "新会话")

    assistant = await db.insert_message(
        session_id, role="assistant", content="", status="connecting"
    )

    prior = await db.list_messages(session_id)
    history = _history_for_llm(prior, exclude_ids={assistant["id"]})
    system_prompt = resolve_system_prompt(mid, sid)

    job = GenerationJob(
        message_id=assistant["id"],
        session_id=session_id,
        prompt=store_prompt,
        history=history,
        system_prompt=system_prompt,
        image_data_url=image_data_url,
    )
    register_job(job)

    async def persist_chunk(seq: int, text: str) -> None:
        await db.append_chunk(assistant["id"], seq, text)

    async def settle(status: str, error: Optional[str] = None) -> None:
        await db.settle_message(assistant["id"], status, error=error)

    asyncio.create_task(run_generation(job, persist_chunk, settle))

    result: Dict[str, Any] = {
        "assistant_message": {**assistant, "status": "connecting"},
        "module_id": mid,
        "scenario_id": sid,
    }
    if user_msg is not None:
        result["user_message"] = user_msg
    return result


@app.post("/api/sessions/{session_id}/messages")
async def api_send_message(session_id: str, body: SendMessageBody):
    if not await db.get_session(session_id):
        raise HTTPException(404, "session not found")
    text = (body.content or "").strip()
    if not text and not body.image_base64:
        raise HTTPException(400, "请输入文字或上传文书照片")
    return await _start_generation(
        session_id,
        text,
        module_id=body.module_id,
        scenario_id=body.scenario_id,
        insert_user=True,
        image_base64=body.image_base64,
        image_mime=body.image_mime,
    )


@app.post("/api/sessions/{session_id}/messages/{message_id}/retry")
async def api_retry(session_id: str, message_id: str, body: RetryBody = RetryBody()):
    """
    Failed/cancelled assistant message stays as-is.
    Retry starts a fresh assistant message (optionally reusing the prior user prompt).
    """
    if not await db.get_session(session_id):
        raise HTTPException(404, "session not found")
    old = await db.get_message(message_id)
    if not old or old["session_id"] != session_id:
        raise HTTPException(404, "message not found")
    if old["role"] != "assistant":
        raise HTTPException(400, "only assistant messages can be retried")
    if old["status"] not in ("failed", "cancelled"):
        raise HTTPException(400, "only failed/cancelled messages can be retried")

    prompt = (body.prompt or "").strip()
    if not prompt:
        # Find nearest preceding user message.
        msgs = await db.list_messages(session_id)
        for m in reversed(msgs):
            if m["created_at"] < old["created_at"] and m["role"] == "user":
                prompt = m["content"]
                break
    if not prompt:
        raise HTTPException(400, "no prompt available for retry")

    return await _start_generation(
        session_id,
        prompt,
        module_id=body.module_id,
        scenario_id=body.scenario_id,
        insert_user=False,
    )


@app.post("/api/sessions/{session_id}/messages/{message_id}/cancel")
async def api_cancel(session_id: str, message_id: str):
    msg = await db.get_message(message_id)
    if not msg or msg["session_id"] != session_id:
        raise HTTPException(404, "message not found")
    if msg["status"] in ("completed", "failed", "cancelled"):
        return {"ok": True, "message": msg}

    cancelled = cancel_job(message_id)
    # If job already gone (process restart), settle from DB side.
    if not cancelled:
        msg = await db.settle_message(message_id, "cancelled")
    else:
        # Generation loop will settle; wait briefly for consistency.
        for _ in range(20):
            msg = await db.get_message(message_id)
            if msg and msg["status"] == "cancelled":
                break
            await asyncio.sleep(0.05)
        msg = await db.get_message(message_id)
    return {"ok": True, "message": msg}


@app.get("/api/sessions/{session_id}/messages/{message_id}/stream")
async def api_stream(
    session_id: str,
    message_id: str,
    request: Request,
    from_seq: int = Query(0, ge=0),
):
    """
    SSE stream. Supports Last-Event-ID / from_seq resume.
    Events: status | chunk | done | error | heartbeat
    """
    msg = await db.get_message(message_id)
    if not msg or msg["session_id"] != session_id:
        raise HTTPException(404, "message not found")

    # Prefer Last-Event-ID header (browser EventSource reconnect).
    last_event_id = request.headers.get("last-event-id")
    if last_event_id is not None and last_event_id.isdigit():
        from_seq = max(from_seq, int(last_event_id) + 1)

    async def event_gen() -> AsyncIterator[str]:
        nonlocal from_seq
        yield _sse("status", {"message_id": message_id, "status": "connecting"})

        job = get_job(message_id)

        # If already terminal in DB and no live job: replay stored chunks then done/error.
        if msg["status"] in ("completed", "failed", "cancelled") and not job:
            for c in msg.get("chunks") or []:
                if c["seq"] >= from_seq:
                    yield _sse(
                        "chunk",
                        {
                            "message_id": message_id,
                            "seq": c["seq"],
                            "text": c["text"],
                        },
                        event_id=c["seq"],
                    )
            if msg["status"] == "completed":
                yield _sse(
                    "done",
                    {
                        "message_id": message_id,
                        "status": "completed",
                        "content": msg["content"],
                    },
                )
            elif msg["status"] == "cancelled":
                yield _sse(
                    "done",
                    {
                        "message_id": message_id,
                        "status": "cancelled",
                        "content": msg["content"],
                    },
                )
            else:
                yield _sse(
                    "error",
                    {
                        "message_id": message_id,
                        "status": "failed",
                        "error": msg.get("error") or "generation failed",
                        "content": msg["content"],
                    },
                )
            return

        # Wait briefly for job registration (race with POST).
        for _ in range(50):
            job = get_job(message_id)
            if job:
                break
            fresh = await db.get_message(message_id)
            if fresh and fresh["status"] in ("completed", "failed", "cancelled"):
                msg.update(fresh)
                break
            await asyncio.sleep(0.02)

        job = get_job(message_id)
        yield _sse("status", {"message_id": message_id, "status": "generating"})

        last_sent = from_seq - 1

        while True:
            if await request.is_disconnected():
                # Client left; generation continues server-side. Do NOT settle as failed.
                return

            job = get_job(message_id)
            if job:
                pending = job.chunks_from(last_sent + 1)
                for c in pending:
                    yield _sse(
                        "chunk",
                        {
                            "message_id": message_id,
                            "seq": c.seq,
                            "text": c.text,
                        },
                        event_id=c.seq,
                    )
                    last_sent = c.seq

                if job.cancel_event.is_set() or job.done or job.failed:
                    # Wait for DB settle so client sees authoritative status.
                    settled = None
                    for _ in range(40):
                        settled = await db.get_message(message_id)
                        if settled and settled["status"] in (
                            "completed",
                            "failed",
                            "cancelled",
                        ):
                            break
                        await asyncio.sleep(0.05)
                    settled = settled or await db.get_message(message_id)
                    status = (settled or {}).get("status", "failed")
                    content = (settled or {}).get("content", "")
                    if status == "completed":
                        yield _sse(
                            "done",
                            {
                                "message_id": message_id,
                                "status": "completed",
                                "content": content,
                            },
                        )
                    elif status == "cancelled":
                        yield _sse(
                            "done",
                            {
                                "message_id": message_id,
                                "status": "cancelled",
                                "content": content,
                            },
                        )
                    else:
                        yield _sse(
                            "error",
                            {
                                "message_id": message_id,
                                "status": "failed",
                                "error": (settled or {}).get("error")
                                or job.error
                                or "failed",
                                "content": content,
                            },
                        )
                    return

                # Heartbeat while waiting for next chunk.
                got = await job.wait_next(last_sent, timeout=15.0)
                if not got:
                    yield _sse("heartbeat", {"message_id": message_id})
                continue

            # No live job — poll DB.
            settled = await db.get_message(message_id)
            if not settled:
                yield _sse(
                    "error",
                    {
                        "message_id": message_id,
                        "status": "failed",
                        "error": "message missing",
                    },
                )
                return

            for c in settled.get("chunks") or []:
                if c["seq"] > last_sent:
                    yield _sse(
                        "chunk",
                        {
                            "message_id": message_id,
                            "seq": c["seq"],
                            "text": c["text"],
                        },
                        event_id=c["seq"],
                    )
                    last_sent = c["seq"]

            if settled["status"] in ("completed", "failed", "cancelled"):
                if settled["status"] == "completed":
                    yield _sse(
                        "done",
                        {
                            "message_id": message_id,
                            "status": "completed",
                            "content": settled["content"],
                        },
                    )
                elif settled["status"] == "cancelled":
                    yield _sse(
                        "done",
                        {
                            "message_id": message_id,
                            "status": "cancelled",
                            "content": settled["content"],
                        },
                    )
                else:
                    yield _sse(
                        "error",
                        {
                            "message_id": message_id,
                            "status": "failed",
                            "error": settled.get("error") or "failed",
                            "content": settled["content"],
                        },
                    )
                return

            yield _sse("heartbeat", {"message_id": message_id})
            await asyncio.sleep(0.2)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

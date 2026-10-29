"""
Realtime Agent API.

States for assistant messages:
  connecting → generating → completed | failed | cancelled

Rules:
  - Only settle(completed) after a clean done.
  - Partial content on cancel/fail is kept, status is never rewritten to completed.
  - SSE chunks carry seq; clients reconnect with ?from_seq=N to resume without duplicates.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from calendar_sync import (
    delete_calendar_event,
    local_alert_minutes,
    sync_status,
)
import auth
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
    extract_document_image_ocr,
    get_public_settings,
    provider_info,
    review_document_image,
    update_runtime_settings,
)
from rag import build_rag_user_prompt, retrieve_chunks
from reminder_skill import create_reminder_entry, sync_existing_reminder
from stream_engine import GenerationJob, cancel_job, get_job, register_job, run_generation
from tools import execute_tool


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await db.init_db()
    await db.purge_expired_auth_sessions()
    yield


app = FastAPI(title="青柠 · 生活助理 Agent", lifespan=lifespan)
audit_logger = logging.getLogger("qingning.audit")


@app.exception_handler(Exception)
async def api_unhandled_exception(_request: Request, error: Exception):
    """未知 API 异常返回中文，详细堆栈保留在服务端日志。"""
    import logging

    logging.getLogger("uvicorn.error").exception("未处理的 API 异常", exc_info=error)
    return JSONResponse({"detail": "服务器暂时出错，请稍后重试"}, status_code=500)


def _cors_origins() -> list[str]:
    raw = (os.getenv("CORS_ALLOW_ORIGINS") or "").strip()
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    return ["http://localhost:5173", "http://127.0.0.1:5173"]


def _trusted_origin(origin: str) -> bool:
    if origin in _cors_origins():
        return True
    parsed = urlparse(origin)
    return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}


# 公开接口：无需登录（健康检查 + 鉴权自身）。
PUBLIC_PATHS = frozenset(
    {"/api/health", "/api/auth/status", "/api/auth/setup", "/api/auth/login"}
)


@app.middleware("http")
async def auth_guard(request: Request, call_next):
    """除公开接口外，所有 /api/* 需有效会话 Cookie。"""
    path = request.url.path
    if (
        not path.startswith("/api/")
        or path in PUBLIC_PATHS
        or request.method == "OPTIONS"
    ):
        return await call_next(request)
    user = await auth.resolve_session(request.cookies.get(auth.SESSION_COOKIE))
    if not user:
        return JSONResponse({"detail": "请先登录"}, status_code=401)
    request.state.user_id = user["id"]
    token = db.set_current_user(user["id"])
    try:
        return await call_next(request)
    finally:
        db.reset_current_user(token)


@app.middleware("http")
async def request_observability(request: Request, call_next):
    """以 request_id 串联结构化日志，不记录正文、Cookie 或密钥。"""
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    request.state.request_id = request_id
    started = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        response.headers["X-Request-ID"] = request_id
        return response
    finally:
        audit_logger.info(json.dumps({
            "event": "http_request", "request_id": request_id,
            "method": request.method, "path": request.url.path, "status": status,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "user": hashlib.sha256(str(getattr(request.state, "user_id", "anonymous")).encode()).hexdigest()[:12],
        }, ensure_ascii=False))


@app.middleware("http")
async def csrf_origin_guard(request: Request, call_next):
    """Cookie 写请求拒绝跨站 Origin/Sec-Fetch-Site。"""
    if request.method not in {"GET", "HEAD", "OPTIONS"} and request.url.path.startswith("/api/"):
        if request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "已拒绝跨站请求"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and not _trusted_origin(origin):
            return JSONResponse({"detail": "请求来源不受信任"}, status_code=403)
    return await call_next(request)


class AuthPasswordBody(BaseModel):
    username: str = Field(..., min_length=1, max_length=40)
    password: str = Field(..., min_length=6, max_length=128)


class RestoreBackupBody(BaseModel):
    confirm_username: str = Field(..., min_length=1, max_length=40)
    backup: Dict[str, Any]


@app.get("/api/auth/status")
async def api_auth_status(request: Request):
    """前端启动探针：是否已设密码、当前是否已登录。"""
    owner = await db.get_owner()
    user = await auth.resolve_session(request.cookies.get(auth.SESSION_COOKIE))
    return {
        "configured": owner is not None,
        "authenticated": user is not None,
        "user_id": user["id"] if user else None,
    }


@app.post("/api/auth/setup")
@app.post("/api/auth/login")
async def api_auth_login(body: AuthPasswordBody, response: Response):
    """用户名存在则校验密码，否则注册并立即登录。旧账号用户名为 owner。"""
    username = body.username.strip()
    if not username:
        raise HTTPException(400, "请输入用户名")
    if len(body.password.encode("utf-8")) > 72:
        raise HTTPException(400, "密码不能超过 72 字节")
    identity = username.casefold()
    if auth.login_rate_limited(identity):
        raise HTTPException(429, "登录失败次数过多，请 5 分钟后再试")
    user = await db.get_user(username)
    registered = False
    if not user:
        policy_error = auth.password_policy_error(body.password)
        if policy_error:
            raise HTTPException(400, policy_error)
        password_hash = await auth.hash_password_async(body.password)
        try:
            user = await db.create_user(username, password_hash)
            registered = True
        except sqlite3.IntegrityError:
            # 并发注册同名账号时，仍须验证已创建账号的密码。
            user = await db.get_user(username)
    if not user or not await auth.verify_password_async(body.password, user["password_hash"]):
        auth.record_login_failure(identity)
        raise HTTPException(401, "用户名或密码不正确")
    auth.clear_login_failures(identity)
    sid = await auth.start_session(user["id"])
    auth.set_session_cookie(response, sid)
    return {"ok": True, "user_id": user["id"], "registered": registered}


@app.post("/api/auth/logout")
async def api_auth_logout(request: Request, response: Response):
    sid = request.cookies.get(auth.SESSION_COOKIE)
    if sid:
        await db.delete_auth_session(sid)
    auth.clear_session_cookie(response)
    return {"ok": True}


@app.get("/api/auth/me")
async def api_auth_me(request: Request):
    user = await auth.resolve_session(request.cookies.get(auth.SESSION_COOKIE))
    if not user:
        raise HTTPException(401, "请先登录")
    return {"user_id": user["id"], "created_at": user["created_at"]}


@app.get("/api/data/backup")
async def api_export_account_backup():
    """导出当前账号的业务数据；不包含密码、Cookie 或模型 API Key。"""
    return await db.export_current_user_data()


@app.get("/api/data/backup/status")
async def api_account_backup_status():
    return await db.backup_status()


@app.post("/api/data/restore")
async def api_restore_account_backup(body: RestoreBackupBody, request: Request):
    if body.confirm_username.strip() != request.state.user_id:
        raise HTTPException(400, "确认用户名与当前账号不一致")
    try:
        counts = await db.restore_current_user_data(body.backup)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "counts": counts, "restored_at": __import__("time").time()}


# CORS 最后加入 => 位于鉴权中间件外层，401 也能带上正确的 CORS 头。
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
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
    # 开启后对粘贴长文切块检索，再把片段注入提示词（迷你 RAG）
    use_rag: bool = False
    # 开启后先让模型选本机工具（抽条款 / 提醒 / 联网 / 天气 / 时间）
    use_agent: bool = False


class RetryBody(BaseModel):
    """Retry creates a new assistant message; failed one stays failed."""

    prompt: Optional[str] = None
    module_id: Optional[str] = None
    scenario_id: Optional[str] = None
    use_rag: bool = False
    use_agent: bool = False


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
    due_time: str = Field("", pattern=r"^$|^([01]\d|2[0-3]):[0-5]\d$")
    note: str = Field("", max_length=500)
    notify_browser: bool = True


class PatchReminderBody(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=120)
    due_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    due_time: Optional[str] = Field(None, pattern=r"^$|^([01]\d|2[0-3]):[0-5]\d$")
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
    created = await create_reminder_entry(
        category=body.category,
        title=body.title,
        due_date=body.due_date,
        due_time=body.due_time,
        note=body.note or "",
        notify_browser=body.notify_browser,
    )
    return created["item"]


@app.get("/api/calendar/status")
async def api_calendar_status():
    """日历同步能力与授权状态，供前端展示与授权引导。"""
    status = sync_status()
    return {
        **status,
        "alert_minutes": local_alert_minutes(),
        "guide": (
            "首次同步时 macOS 会弹出授权窗口，请点「允许」。"
            "若已拒绝，可在「系统设置 → 隐私与安全性 → 自动化」里重新勾选日历。"
        ),
    }


@app.post("/api/reminders/{reminder_id}/sync-calendar")
async def api_sync_reminder_calendar(reminder_id: str):
    """把已有提醒写入日历，首次调用会触发系统授权弹窗。"""
    target = await db.get_reminder(reminder_id)
    if not target:
        raise HTTPException(404, "提醒不存在")
    result = await sync_existing_reminder(target)
    if not result.get("ok"):
        error = str(result.get("reason") or "同步到日历失败")
        denied = "-1743" in error or "未获得系统授权" in error
        return {
            "ok": False,
            "code": "perm_denied" if denied else "sync_failed",
            "reason": error,
            "guide": (
                "请在「系统设置 → 隐私与安全性 → 自动化」里允许控制「日历」，然后重试。"
                if denied
                else "稍后重试，或先只保留应用内提醒。"
            ),
        }
    return {
        "ok": True,
        "provider": result.get("provider") or "",
        "event_url": result.get("event_url") or "",
        "alert_minutes": result.get("alert_minutes"),
        "already_synced": bool(result.get("already_synced")),
        "item": result.get("item") or target,
    }


@app.patch("/api/reminders/{reminder_id}")
async def api_patch_reminder(reminder_id: str, body: PatchReminderBody):
    existing = await db.get_reminder(reminder_id)
    if not existing:
        raise HTTPException(404, "提醒不存在")
    data = body.model_dump(exclude_unset=True)
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
    if "note" in data and data["note"] is not None:
        data["note"] = data["note"].strip()
    updated = await db.update_reminder(reminder_id, **data)
    if data.get("done") is True and existing.get("calendar_provider") and existing.get("calendar_event_id"):
        sync_result = await delete_calendar_event(
            provider=str(existing.get("calendar_provider") or ""),
            event_id=str(existing.get("calendar_event_id") or ""),
        )
        if sync_result.get("ok"):
            updated = await db.update_reminder(
                reminder_id,
                calendar_provider="",
                calendar_event_id="",
                calendar_event_url="",
            ) or updated
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
        raise HTTPException(400, "仅生活助理 Agent 支持图片上传")
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
    try:
        head = base64.b64decode(body.image_base64[:128], validate=False)[:16]
    except Exception:
        head = b""
    signatures = {"image/jpeg": (b"\xff\xd8\xff",), "image/png": (b"\x89PNG\r\n\x1a\n",), "image/webp": (b"RIFF",), "image/gif": (b"GIF87a", b"GIF89a")}
    if not any(head.startswith(signature) for signature in signatures[mime]):
        return {"ok": False, "related": False, "reason": "文件内容与图片格式不一致，请重新选择有效图片。"}
    result = await review_document_image(
        body.image_base64,
        scenario_id=body.scenario_id,
        scenario_name=scen["name"],
        expect_desc=scenario_image_expect(body.scenario_id),
        mime=mime,
    )
    return result


@app.get("/api/document-captures")
async def api_list_document_captures(
    session_id: Optional[str] = Query(None),
    kind: Optional[str] = Query(None),
    limit: int = Query(30, ge=1, le=100),
):
    return await db.list_document_captures(
        session_id=session_id,
        kind=kind,
        limit=limit,
    )

@app.get("/api/todos")
async def api_list_todos(include_done: bool = False):
    return await db.list_todos(include_done=include_done)

class TodoBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    note: str = Field(default="", max_length=500)
    due_date: str = ""
    due_time: str = ""

@app.post("/api/todos")
async def api_create_todo(body: TodoBody):
    return await db.create_todo(title=body.title.strip(), note=body.note.strip(), due_date=body.due_date, due_time=body.due_time)

@app.patch("/api/todos/{todo_id}")
async def api_patch_todo(todo_id: str, done: bool = False):
    item = await db.update_todo(todo_id, done=done)
    if not item: raise HTTPException(404, "待办不存在")
    return item

@app.delete("/api/todos/{todo_id}")
async def api_delete_todo(todo_id: str):
    if not await db.delete_todo(todo_id): raise HTTPException(404, "待办不存在")
    return {"ok": True}

@app.get("/api/memory")
async def api_list_memory():
    return await db.list_memory()

class MemoryBody(BaseModel):
    key: str
    value: str = ""

@app.put("/api/memory/{key}")
async def api_put_memory(key: str, body: MemoryBody):
    await db.set_memory(key, body.value)
    return {"ok": True}

@app.delete("/api/memory/{key}")
async def api_delete_memory(key: str):
    return {"ok": await db.delete_memory(key)}


@app.get("/api/todos")
async def api_list_todos(include_done: bool = False):
    return await db.list_todos(include_done=include_done)


@app.get("/api/memory")
async def api_list_memory():
    return await db.list_memory()


@app.get("/api/metrics/usage")
async def api_usage_metrics(days: int = Query(7, ge=1, le=90)):
    """近 N 天 Token 用量与耗时聚合，供评测与成本观察使用。"""
    return await db.summarize_llm_usage(days=days)


@app.get("/api/diagnostics/overview")
async def api_diagnostics_overview(days: int = Query(7, ge=1, le=90)):
    return await db.diagnostics_overview(days=days)


@app.get("/api/agent/runs")
async def api_agent_runs(limit: int = Query(30, ge=1, le=100)):
    """当前账号的 Agent 执行轨迹，用于失败回放和诊断。"""
    return await db.list_agent_runs(limit=limit)


@app.post("/api/agent/runs/{run_id}/steps/{step_index}/{action}")
async def api_agent_step_action(run_id: str, step_index: int, action: str):
    """批准、拒绝或重试单个 Agent 步骤。"""
    if action not in {"approve", "reject", "retry"}:
        raise HTTPException(400, "操作只能是 approve、reject 或 retry")
    step = await db.get_agent_step(run_id, step_index)
    if not step:
        raise HTTPException(404, "步骤不存在")
    if action == "reject":
        result = {"ok": False, "code": "user_rejected", "error": "用户已拒绝执行"}
        await db.update_agent_step_result(run_id, step_index, result, "rejected")
        return {"ok": True, "step": {**step, "status": "rejected", "result": result}}
    if action == "approve" and step["result"].get("code") != "confirmation_required":
        raise HTTPException(409, "该步骤不在等待确认状态")
    if action == "retry" and step["status"] != "failed":
        raise HTTPException(409, "只有失败的步骤可以重试")
    result = await execute_tool(
        step["skill_name"], step["arguments"], scenario_id="general",
        user_text="用户已明确确认同步到日历" if action == "approve" else "重试原步骤",
    )
    status = "completed" if result.get("ok") else "failed"
    await db.update_agent_step_result(run_id, step_index, result, status)
    await db.settle_agent_run(run_id, status if status == "failed" else "completed", str(result.get("error") or ""))
    return {"ok": bool(result.get("ok")), "step": {**step, "status": status, "result": result}}


@app.delete("/api/metrics/usage")
async def api_clear_usage_metrics(days: int = Query(0, ge=0, le=365)):
    """清理用量记录；days=0 表示全部清空。"""
    removed = await db.clear_llm_usage(older_than_days=days)
    return {"removed": removed}


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
    use_rag: bool = False,
    use_agent: bool = False,
) -> Dict[str, Any]:
    sess = await db.get_session(session_id)
    if not sess:
        raise HTTPException(404, "session not found")

    # 会话绑定模版后不可被单次请求改写，否则多模版问答会堆进同一条历史
    mid = sess.get("module_id") or default_ids()["module_id"]
    sid = sess.get("scenario_id") or default_ids()["scenario_id"]
    if module_id and module_id != mid:
        raise HTTPException(
            409,
            f"会话属于模块 {mid}，与请求的 {module_id} 不一致，请切换或新建会话",
        )
    if scenario_id and scenario_id != sid:
        raise HTTPException(
            409,
            f"会话属于模版 {sid}，与请求的 {scenario_id} 不一致，请切换模版打开对应对话",
        )
    _validate_ids(mid, sid)

    image_data_url = _image_data_url(image_base64, image_mime)
    ocr_meta: Dict[str, Any] = {
        "ok": False,
        "doc_type": "unknown",
    }
    if image_data_url:
        if mid != "docs":
            raise HTTPException(400, "仅生活助理 Agent 支持图片")
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
        ocr_meta = await extract_document_image_ocr(
            image_base64 or "",
            mime=image_mime or "image/jpeg",
        )

    store_prompt = prompt.strip()
    if image_data_url and "【附文书照片】" not in store_prompt:
        store_prompt = (
            f"{store_prompt}\n\n【附文书照片】" if store_prompt else "【附文书照片】请根据照片分析"
        )
    if not store_prompt:
        raise HTTPException(400, "请输入文字或上传文书照片")

    # 迷你 RAG：库里仍存用户原文；仅生成时注入检索片段
    llm_prompt = store_prompt
    system_prompt = resolve_system_prompt(mid, sid)
    rag_meta: Dict[str, Any] = {
        "requested": bool(use_rag),
        "enabled": False,
        "reason": "未开启检索增强",
        "chunks": [],
    }
    if use_rag and mid == "docs":
        retrieved = retrieve_chunks(store_prompt, session_id=session_id, scenario_id=sid)
        rag_meta = {
            "requested": True,
            "enabled": bool(retrieved.get("enabled")),
            "reason": retrieved.get("reason") or "",
            "chunks": [
                {"id": c["id"], "score": c["score"], "preview": c["text"][:80]}
                for c in (retrieved.get("chunks") or [])
            ],
        }
        if retrieved.get("enabled") and retrieved.get("context_block"):
            llm_prompt = build_rag_user_prompt(
                store_prompt, retrieved["context_block"]
            )
            system_prompt = (
                f"{system_prompt}\n\n"
                "【检索增强】用户消息含【检索片段】。请优先依据片段作答，"
                "并在要点中标注「片段N」；片段未覆盖处写「原文未写清」。"
            )
    elif use_rag:
        rag_meta["reason"] = "仅生活助理 Agent 支持检索增强"

    if image_data_url and ocr_meta.get("ok"):
        ocr_lines = [
            "【图片识别结果】以下内容来自本地 OCR 结构化提取，可用于辅助回答，但看不清的字段不要当成确定事实。",
            f"类型：{ocr_meta.get('doc_type')}",
        ]
        if ocr_meta.get("title"):
            ocr_lines.append(f"标题：{ocr_meta.get('title')}")
        if ocr_meta.get("summary"):
            ocr_lines.append(f"摘要：{ocr_meta.get('summary')}")
        points = ocr_meta.get("key_points") or []
        for idx, item in enumerate(points[:6], start=1):
            ocr_lines.append(f"要点{idx}：{item}")
        med = ocr_meta.get("medicine") or {}
        if isinstance(med, dict) and any(str(v).strip() for v in med.values()):
            ocr_lines.append("药品信息：" + json.dumps(med, ensure_ascii=False))
        bill = ocr_meta.get("bill") or {}
        if isinstance(bill, dict) and any(str(v).strip() for v in bill.values()):
            ocr_lines.append("账单信息：" + json.dumps(bill, ensure_ascii=False))
        if ocr_meta.get("raw_excerpt"):
            ocr_lines.append(f"原文摘录：{ocr_meta.get('raw_excerpt')}")
        llm_prompt = f"{llm_prompt}\n\n" + "\n".join(ocr_lines)
        system_prompt = (
            f"{system_prompt}\n\n"
            "【图片 OCR】若用户上传了图片且消息里带有【图片识别结果】，"
            "可结合这些结果帮助整理说明书、账单和文书重点；"
            "但模糊字段必须明确说不确定，不得编造。"
        )

    user_msg = None
    if insert_user:
        user_msg = await db.insert_message(
            session_id, role="user", content=store_prompt, status="completed"
        )
        # 第一条用户提问写成记录标题；之后再发不再改标题
        if await db.count_messages(session_id, role="user") == 1:
            await db.touch_session(
                session_id, title=db.ask_title(store_prompt, sess["title"])
            )
        if image_data_url and ocr_meta.get("ok"):
            await db.create_document_capture(
                session_id=session_id,
                source_message_id=user_msg["id"],
                kind=str(ocr_meta.get("doc_type") or "generic_document"),
                title=str(ocr_meta.get("title") or ""),
                summary=str(ocr_meta.get("summary") or ""),
                payload=ocr_meta,
            )

    assistant = await db.insert_message(
        session_id, role="assistant", content="", status="connecting"
    )

    prior = await db.list_messages(session_id)
    history = _history_for_llm(prior, exclude_ids={assistant["id"]})
    # 避免 history 末尾用户原文与 llm_prompt 重复成两条 user
    if llm_prompt != store_prompt and history and history[-1].get("role") == "user":
        history = history[:-1]

    job = GenerationJob(
        message_id=assistant["id"],
        session_id=session_id,
        prompt=llm_prompt,
        history=history,
        system_prompt=system_prompt,
        image_data_url=image_data_url,
        user_text=store_prompt,
        module_id=mid,
        scenario_id=sid,
        use_agent=bool(use_agent),
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
        "rag": rag_meta,
        "ocr": ocr_meta if ocr_meta.get("ok") else {"ok": False, "doc_type": "unknown"},
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
        use_rag=bool(body.use_rag),
        use_agent=bool(body.use_agent),
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
        use_rag=bool(body.use_rag),
        use_agent=bool(body.use_agent),
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
        agent_revision = ""
        tool_sent = 0

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

                # 流式 tool 事件：整表推送，前端替换即可，天然幂等（重连也能补齐）。
                if len(job.tool_events) != tool_sent:
                    tool_sent = len(job.tool_events)
                    yield _sse(
                        "tool",
                        {"message_id": message_id, "events": list(job.tool_events)},
                    )

                meta = job.agent_meta
                current_agent_revision = json.dumps(meta, sort_keys=True, ensure_ascii=False) if meta else ""
                if current_agent_revision != agent_revision and meta and meta.get("enabled"):
                    agent_revision = current_agent_revision
                    yield _sse(
                        "agent",
                        {"message_id": message_id, "agent": meta},
                    )

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


WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"


def _mount_frontend() -> None:
    """同一端口同时提供页面和 /api，公网只暴露这一个地址。"""
    if not WEB_DIST.is_dir():
        return
    assets = WEB_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="frontend-assets")

    @app.get("/", include_in_schema=False)
    async def spa_index():
        return FileResponse(WEB_DIST / "index.html")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_files(full_path: str):
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(404)
        root = WEB_DIST.resolve()
        candidate = (WEB_DIST / full_path).resolve()
        if not str(candidate).startswith(str(root)):
            raise HTTPException(404)
        if candidate.is_file():
            return FileResponse(candidate)
        index = WEB_DIST / "index.html"
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(404)


_mount_frontend()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

"""
用户名密码鉴权：bcrypt 哈希 + Cookie 会话。

- /api/auth/login 统一登录注册，用户名不存在时自动创建账号。
- 会话存 auth_sessions 表，Cookie 为 httpOnly + SameSite=Lax。
- 数据仍在本机 SQLite，当前工作台数据由本机账号共享。
- 选 Cookie session 而非 JWT：会话可服务端吊销，本地单机无需无状态扩展。
"""

from __future__ import annotations

import asyncio
import os
import secrets
import time
from collections import defaultdict, deque
from typing import Any, Dict, Optional

import bcrypt
from fastapi import Response

import db

SESSION_COOKIE = "qingning_sid"
OWNER_ID = db.OWNER_ID
SESSION_TTL_SECONDS = int(os.getenv("AUTH_SESSION_TTL_DAYS", "30") or "30") * 86400
# 本地 HTTP 下不能强制 Secure；上 HTTPS 后设 AUTH_COOKIE_SECURE=true。
COOKIE_SECURE = (os.getenv("AUTH_COOKIE_SECURE") or "").strip().lower() in {
    "1",
    "true",
    "yes",
}
LOGIN_WINDOW_SECONDS = 300
LOGIN_MAX_FAILURES = 5
_login_failures: Dict[str, deque] = defaultdict(deque)


def password_policy_error(password: str) -> str:
    if len(password) < 8:
        return "密码至少需要 8 位"
    if password.isdigit() or password.isalpha():
        return "密码需要同时包含字母和数字"
    return ""


def login_rate_limited(identity: str) -> bool:
    now = time.monotonic()
    failures = _login_failures[identity]
    while failures and now - failures[0] > LOGIN_WINDOW_SECONDS:
        failures.popleft()
    return len(failures) >= LOGIN_MAX_FAILURES


def record_login_failure(identity: str) -> None:
    _login_failures[identity].append(time.monotonic())


def clear_login_failures(identity: str) -> None:
    _login_failures.pop(identity, None)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    if not password or not password_hash:
        return False
    try:
        return bcrypt.checkpw(
            password.encode("utf-8"), password_hash.encode("utf-8")
        )
    except ValueError:
        return False


async def hash_password_async(password: str) -> str:
    """把 bcrypt 放到线程池，避免卡住主事件循环。"""
    return await asyncio.to_thread(hash_password, password)


async def verify_password_async(password: str, password_hash: str) -> bool:
    """登录校验同样放在线程池，避免页面长时间停在处理中。"""
    return await asyncio.to_thread(verify_password, password, password_hash)


def new_session_id() -> str:
    return secrets.token_urlsafe(32)


async def start_session(user_id: str) -> str:
    sid = new_session_id()
    await db.create_auth_session(sid, user_id, SESSION_TTL_SECONDS)
    return sid


async def resolve_session(sid: Optional[str]) -> Optional[Dict[str, Any]]:
    """Cookie 里的 sid -> 有效用户；无效返回 None。"""
    session = await db.get_auth_session(sid or "")
    if not session:
        return None
    return await db.get_user(session["user_id"])


def set_session_cookie(response: Response, sid: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        sid,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")

"""SQLite persistence. Message terminal status is only written on explicit settle."""

from __future__ import annotations

import hashlib
import json
import secrets
import time
import uuid
from contextvars import ContextVar, Token
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiosqlite

DB_PATH = Path(__file__).parent / "data" / "agent.db"

# Terminal statuses that must never be overwritten by a later partial write.
TERMINAL = frozenset({"completed", "failed", "cancelled"})
OWNER_ID = "owner"
_CURRENT_USER_ID: ContextVar[str] = ContextVar("current_user_id", default=OWNER_ID)


def set_current_user(user_id: str) -> Token:
    return _CURRENT_USER_ID.set(user_id)


def reset_current_user(token: Token) -> None:
    _CURRENT_USER_ID.reset(token)


def current_user_id() -> str:
    return _CURRENT_USER_ID.get()


async def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'owner',
                title TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                module_id TEXT NOT NULL DEFAULT 'docs',
                scenario_id TEXT NOT NULL DEFAULT 'general'
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                chunks_json TEXT NOT NULL DEFAULT '[]',
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session
                ON messages(session_id, created_at);

            CREATE TABLE IF NOT EXISTS reminders (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'owner',
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                due_date TEXT NOT NULL,
                due_time TEXT NOT NULL DEFAULT '',
                done INTEGER NOT NULL DEFAULT 0,
                notify_browser INTEGER NOT NULL DEFAULT 1,
                calendar_provider TEXT NOT NULL DEFAULT '',
                calendar_event_id TEXT NOT NULL DEFAULT '',
                calendar_event_url TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_reminders_due
                ON reminders(due_date, done, category);

            CREATE TABLE IF NOT EXISTS todos (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'owner',
                title TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                due_date TEXT NOT NULL DEFAULT '',
                due_time TEXT NOT NULL DEFAULT '',
                done INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_todos_user_due
                ON todos(user_id, done, due_date, due_time);

            CREATE TABLE IF NOT EXISTS document_captures (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                source_message_id TEXT,
                kind TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id),
                FOREIGN KEY (source_message_id) REFERENCES messages(id)
            );

            CREATE INDEX IF NOT EXISTS idx_document_captures_session
                ON document_captures(session_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS llm_usage (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL DEFAULT '',
                message_id TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'chat',
                provider TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                ttft_ms INTEGER,
                total_ms INTEGER,
                ok INTEGER NOT NULL DEFAULT 1,
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_llm_usage_created
                ON llm_usage(created_at DESC);

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS auth_sessions (
                sid TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
                ON auth_sessions(expires_at);

            CREATE TABLE IF NOT EXISTS agent_memory (
                key TEXT NOT NULL,
                user_id TEXT NOT NULL DEFAULT 'owner',
                value TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (user_id, key)
            );

            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                goal TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_steps (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                step_index INTEGER NOT NULL,
                skill_name TEXT NOT NULL,
                arguments_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY (run_id) REFERENCES agent_runs(id)
            );

            CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created
                ON agent_runs(user_id, created_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_steps_run_index
                ON agent_steps(run_id, step_index);

            CREATE TABLE IF NOT EXISTS data_backup_events (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                action TEXT NOT NULL,
                created_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_backup_events_user_created
                ON data_backup_events(user_id, created_at DESC);
            """
        )
        # Migrate older DBs that lack module columns.
        cur = await db.execute("PRAGMA table_info(sessions)")
        cols = {row[1] for row in await cur.fetchall()}
        if "module_id" not in cols:
            await db.execute(
                "ALTER TABLE sessions ADD COLUMN module_id TEXT NOT NULL DEFAULT 'docs'"
            )
        if "scenario_id" not in cols:
            await db.execute(
                "ALTER TABLE sessions ADD COLUMN scenario_id TEXT NOT NULL DEFAULT 'general'"
            )
        if "user_id" not in cols:
            await db.execute(
                "ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'"
            )
        cur = await db.execute("PRAGMA table_info(reminders)")
        reminder_cols = {row[1] for row in await cur.fetchall()}
        if "calendar_provider" not in reminder_cols:
            await db.execute(
                "ALTER TABLE reminders ADD COLUMN calendar_provider TEXT NOT NULL DEFAULT ''"
            )
        if "calendar_event_id" not in reminder_cols:
            await db.execute(
                "ALTER TABLE reminders ADD COLUMN calendar_event_id TEXT NOT NULL DEFAULT ''"
            )
        if "calendar_event_url" not in reminder_cols:
            await db.execute(
                "ALTER TABLE reminders ADD COLUMN calendar_event_url TEXT NOT NULL DEFAULT ''"
            )
        if "due_time" not in reminder_cols:
            await db.execute(
                "ALTER TABLE reminders ADD COLUMN due_time TEXT NOT NULL DEFAULT ''"
            )
        if "user_id" not in reminder_cols:
            await db.execute(
                "ALTER TABLE reminders ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner'"
            )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated_at DESC)"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_reminders_user_due ON reminders(user_id, due_date, done)"
        )
        cur = await db.execute("PRAGMA table_info(agent_memory)")
        memory_info = await cur.fetchall()
        memory_cols = {row[1] for row in memory_info}
        memory_pk = [row[1] for row in sorted(memory_info, key=lambda row: row[5]) if row[5]]
        if "user_id" not in memory_cols or memory_pk != ["user_id", "key"]:
            await db.execute(
                """
                CREATE TABLE agent_memory_v2 (
                    key TEXT NOT NULL,
                    user_id TEXT NOT NULL DEFAULT 'owner',
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (user_id, key)
                )
                """
            )
            user_expr = "user_id" if "user_id" in memory_cols else "'owner'"
            await db.execute(
                f"INSERT OR REPLACE INTO agent_memory_v2 (key, user_id, value, updated_at) "
                f"SELECT key, {user_expr}, value, updated_at FROM agent_memory"
            )
            await db.execute("DROP TABLE agent_memory")
            await db.execute("ALTER TABLE agent_memory_v2 RENAME TO agent_memory")
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_user_key ON agent_memory(user_id, key)"
        )
        await db.execute(
            "UPDATE agent_runs SET status = 'failed', error = '服务重启，运行已中断', "
            "updated_at = ? WHERE status = 'running'",
            (_now(),),
        )
        await db.commit()


def ask_title(content: str, fallback: str = "新会话") -> str:
    """历史记录标题：取用户第一条提问，去掉照片占位和多余空白。"""
    text = (content or "").replace("【附文书照片】", " ")
    text = " ".join(text.split())
    if not text:
        return fallback
    return text[:36]


def _session_dict(row: Dict[str, Any]) -> Dict[str, Any]:
    title = row["title"]
    ask = row.get("first_ask")
    if isinstance(ask, str) and ask.strip():
        title = ask_title(ask, title)
    return {
        "id": row["id"],
        "title": title,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "module_id": row.get("module_id") or "docs",
        "scenario_id": row.get("scenario_id") or "general",
    }


_SESSION_SELECT = """
    SELECT s.id, s.title, s.created_at, s.updated_at, s.module_id, s.scenario_id,
      (
        SELECT content FROM messages
        WHERE session_id = s.id AND role = 'user' AND length(trim(content)) > 0
        ORDER BY created_at ASC
        LIMIT 1
      ) AS first_ask
    FROM sessions s
"""


def _now() -> float:
    return time.time()


def _todo_dict(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "note": row.get("note") or "",
        "due_date": row.get("due_date") or "",
        "due_time": row.get("due_time") or "",
        "done": bool(row.get("done")),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


async def create_session(
    title: str = "新会话",
    module_id: str = "docs",
    scenario_id: str = "general",
) -> Dict[str, Any]:
    sid = new_id("sess")
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO sessions
            (id, user_id, title, created_at, updated_at, module_id, scenario_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (sid, current_user_id(), title, ts, ts, module_id, scenario_id),
        )
        await db.commit()
    return {
        "id": sid,
        "title": title,
        "created_at": ts,
        "updated_at": ts,
        "module_id": module_id,
        "scenario_id": scenario_id,
    }


async def list_sessions(module_id: Optional[str] = None) -> List[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if module_id:
            cur = await db.execute(
                _SESSION_SELECT
                + " WHERE s.user_id = ? AND s.module_id = ? ORDER BY s.updated_at DESC",
                (current_user_id(), module_id),
            )
        else:
            cur = await db.execute(
                _SESSION_SELECT + " WHERE s.user_id = ? ORDER BY s.updated_at DESC",
                (current_user_id(),),
            )
        rows = await cur.fetchall()
    return [_session_dict(dict(r)) for r in rows]


async def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            _SESSION_SELECT + " WHERE s.id = ? AND s.user_id = ?",
            (session_id, current_user_id()),
        )
        row = await cur.fetchone()
    return _session_dict(dict(row)) if row else None


async def update_session_scenario(
    session_id: str,
    module_id: str,
    scenario_id: str,
) -> Optional[Dict[str, Any]]:
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE sessions
            SET module_id = ?, scenario_id = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (module_id, scenario_id, ts, session_id, current_user_id()),
        )
        await db.commit()
    return await get_session(session_id)


async def touch_session(session_id: str, title: Optional[str] = None) -> None:
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        if title is not None:
            await db.execute(
                "UPDATE sessions SET updated_at = ?, title = ? WHERE id = ? AND user_id = ?",
                (ts, title, session_id, current_user_id()),
            )
        else:
            await db.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ? AND user_id = ?",
                (ts, session_id, current_user_id()),
            )
        await db.commit()


async def count_messages(session_id: str, role: Optional[str] = None) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        if role:
            cur = await db.execute(
                "SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = ?",
                (session_id, role),
            )
        else:
            cur = await db.execute(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?",
                (session_id,),
            )
        row = await cur.fetchone()
    return int(row[0] if row else 0)


async def delete_session(session_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "DELETE FROM sessions WHERE id = ? AND user_id = ?",
            (session_id, current_user_id()),
        )
        if cur.rowcount:
            await db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        await db.commit()
        return cur.rowcount > 0


async def insert_message(
    session_id: str,
    role: str,
    content: str = "",
    status: str = "completed",
) -> Dict[str, Any]:
    mid = new_id("msg")
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO messages
            (id, session_id, role, content, status, chunks_json, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, ?)
            """,
            (mid, session_id, role, content, status, ts, ts),
        )
        await db.commit()
    await touch_session(session_id)
    return {
        "id": mid,
        "session_id": session_id,
        "role": role,
        "content": content,
        "status": status,
        "chunks": [],
        "error": None,
        "created_at": ts,
        "updated_at": ts,
    }


async def get_message(message_id: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ? AND s.user_id = ?",
            (message_id, current_user_id()),
        )
        row = await cur.fetchone()
    if not row:
        return None
    return _row_to_message(dict(row))


def _row_to_message(row: Dict[str, Any]) -> Dict[str, Any]:
    chunks = json.loads(row.get("chunks_json") or "[]")
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "role": row["role"],
        "content": row["content"],
        "status": row["status"],
        "chunks": chunks,
        "error": row.get("error"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def list_messages(session_id: str) -> List[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.session_id = ? AND s.user_id = ? ORDER BY m.created_at ASC",
            (session_id, current_user_id()),
        )
        rows = await cur.fetchall()
    return [_row_to_message(dict(r)) for r in rows]


async def append_chunk(message_id: str, seq: int, text: str) -> Optional[Dict[str, Any]]:
    """Append a chunk while status is connecting/generating. Never upgrades to completed."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = await cur.fetchone()
        if not row:
            return None
        msg = dict(row)
        if msg["status"] in TERMINAL:
            return _row_to_message(msg)

        chunks = json.loads(msg["chunks_json"] or "[]")
        # Idempotent: skip if seq already stored (reconnect replay safety).
        if any(c.get("seq") == seq for c in chunks):
            return _row_to_message(msg)

        chunks.append({"seq": seq, "text": text})
        content = msg["content"] + text
        ts = _now()
        await db.execute(
            """
            UPDATE messages
            SET content = ?, chunks_json = ?, status = 'generating', updated_at = ?
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
            """,
            (content, json.dumps(chunks, ensure_ascii=False), ts, message_id),
        )
        await db.commit()

        cur = await db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = await cur.fetchone()
    return _row_to_message(dict(row)) if row else None


async def settle_message(
    message_id: str,
    status: str,
    error: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Write terminal status once.
    - completed: only when generation finished cleanly
    - failed / cancelled: keep partial content, never rewrite as completed
    """
    if status not in ("completed", "failed", "cancelled"):
        raise ValueError(f"invalid terminal status: {status}")

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = await cur.fetchone()
        if not row:
            return None
        msg = dict(row)
        if msg["status"] in TERMINAL:
            # Already settled — do not flip failed→completed or completed→failed.
            return _row_to_message(msg)

        ts = _now()
        await db.execute(
            """
            UPDATE messages
            SET status = ?, error = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
            """,
            (status, error, ts, message_id),
        )
        await db.commit()
        cur = await db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
        row = await cur.fetchone()
    return _row_to_message(dict(row)) if row else None


# —— General todos (account isolated) ——


async def create_todo(*, title: str, note: str = "", due_date: str = "", due_time: str = "") -> Dict[str, Any]:
    todo_id = new_id("todo")
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute(
            "INSERT INTO todos (id, user_id, title, note, due_date, due_time, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
            (todo_id, current_user_id(), title, note, due_date, due_time, ts, ts),
        )
        await conn.commit()
    return {"id": todo_id, "title": title, "note": note, "due_date": due_date, "due_time": due_time, "done": False, "created_at": ts, "updated_at": ts}


async def list_todos(include_done: bool = False) -> List[Dict[str, Any]]:
    clause = "" if include_done else " AND done = 0"
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute(
            f"SELECT * FROM todos WHERE user_id = ?{clause} ORDER BY done, CASE WHEN due_date = '' THEN 1 ELSE 0 END, due_date, due_time, created_at DESC",
            (current_user_id(),),
        )
        rows = await cur.fetchall()
    return [_todo_dict(dict(row)) for row in rows]


async def get_todo(todo_id: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("SELECT * FROM todos WHERE id = ? AND user_id = ?", (todo_id, current_user_id()))
        row = await cur.fetchone()
    return _todo_dict(dict(row)) if row else None


async def update_todo(todo_id: str, *, done: Optional[bool] = None) -> Optional[Dict[str, Any]]:
    existing = await get_todo(todo_id)
    if not existing:
        return None
    next_done = existing["done"] if done is None else done
    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute(
            "UPDATE todos SET done = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (int(next_done), _now(), todo_id, current_user_id()),
        )
        await conn.commit()
    return await get_todo(todo_id)


async def delete_todo(todo_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as conn:
        cur = await conn.execute("DELETE FROM todos WHERE id = ? AND user_id = ?", (todo_id, current_user_id()))
        await conn.commit()
    return cur.rowcount > 0


# —— Life reminders (medicine / pet) ——

REMINDER_CATEGORIES = frozenset({"medicine", "pet"})


def _reminder_dict(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "category": row["category"],
        "title": row["title"],
        "note": row.get("note") or "",
        "due_date": row["due_date"],
        "due_time": row.get("due_time") or "",
        "done": bool(row.get("done")),
        "notify_browser": bool(row.get("notify_browser", 1)),
        "calendar_provider": row.get("calendar_provider") or "",
        "calendar_event_id": row.get("calendar_event_id") or "",
        "calendar_event_url": row.get("calendar_event_url") or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def list_reminders(
    category: Optional[str] = None,
    include_done: bool = False,
) -> List[Dict[str, Any]]:
    clauses = ["user_id = ?"]
    params: List[Any] = [current_user_id()]
    if category:
        clauses.append("category = ?")
        params.append(category)
    if not include_done:
        clauses.append("done = 0")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            f"""
            SELECT * FROM reminders
            {where}
            ORDER BY done ASC, due_date ASC, due_time ASC, created_at DESC
            """,
            params,
        )
        rows = await cur.fetchall()
    return [_reminder_dict(dict(r)) for r in rows]


async def list_due_reminders(today: str, within_days: int = 0) -> List[Dict[str, Any]]:
    """due_date <= today+within_days, not done. within_days=0 → 仅今天及过期."""
    # due_date is YYYY-MM-DD; lexical compare works.
    from datetime import datetime, timedelta

    end = (
        datetime.strptime(today, "%Y-%m-%d") + timedelta(days=max(0, within_days))
    ).strftime("%Y-%m-%d")
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT * FROM reminders
            WHERE user_id = ? AND done = 0 AND due_date <= ?
            ORDER BY due_date ASC, due_time ASC
            """,
            (current_user_id(), end),
        )
        rows = await cur.fetchall()
    return [_reminder_dict(dict(r)) for r in rows]


async def create_reminder(
    *,
    category: str,
    title: str,
    due_date: str,
    due_time: str = "",
    note: str = "",
    notify_browser: bool = True,
    calendar_provider: str = "",
    calendar_event_id: str = "",
    calendar_event_url: str = "",
) -> Dict[str, Any]:
    rid = new_id("rem")
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO reminders
            (
                id, user_id, category, title, note, due_date, due_time, done, notify_browser,
                calendar_provider, calendar_event_id, calendar_event_url,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
            """,
            (
                rid,
                current_user_id(),
                category,
                title,
                note,
                due_date,
                due_time,
                1 if notify_browser else 0,
                calendar_provider,
                calendar_event_id,
                calendar_event_url,
                ts,
                ts,
            ),
        )
        await db.commit()
    return {
        "id": rid,
        "category": category,
        "title": title,
        "note": note,
        "due_date": due_date,
        "due_time": due_time,
        "done": False,
        "notify_browser": notify_browser,
        "calendar_provider": calendar_provider,
        "calendar_event_id": calendar_event_id,
        "calendar_event_url": calendar_event_url,
        "created_at": ts,
        "updated_at": ts,
    }


async def get_reminder(reminder_id: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM reminders WHERE id = ? AND user_id = ?",
            (reminder_id, current_user_id()),
        )
        row = await cur.fetchone()
    return _reminder_dict(dict(row)) if row else None


async def update_reminder(
    reminder_id: str,
    *,
    title: Optional[str] = None,
    note: Optional[str] = None,
    due_date: Optional[str] = None,
    due_time: Optional[str] = None,
    done: Optional[bool] = None,
    notify_browser: Optional[bool] = None,
    category: Optional[str] = None,
    calendar_provider: Optional[str] = None,
    calendar_event_id: Optional[str] = None,
    calendar_event_url: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    existing = await get_reminder(reminder_id)
    if not existing:
        return None
    next_title = title if title is not None else existing["title"]
    next_note = note if note is not None else existing["note"]
    next_due = due_date if due_date is not None else existing["due_date"]
    next_due_time = due_time if due_time is not None else existing.get("due_time", "")
    next_done = int(done) if done is not None else int(existing["done"])
    next_notify = (
        int(notify_browser)
        if notify_browser is not None
        else int(existing["notify_browser"])
    )
    next_cat = category if category is not None else existing["category"]
    next_provider = (
        calendar_provider
        if calendar_provider is not None
        else existing["calendar_provider"]
    )
    next_event_id = (
        calendar_event_id
        if calendar_event_id is not None
        else existing["calendar_event_id"]
    )
    next_event_url = (
        calendar_event_url
        if calendar_event_url is not None
        else existing["calendar_event_url"]
    )
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE reminders
            SET title = ?, note = ?, due_date = ?, due_time = ?, done = ?,
                notify_browser = ?, category = ?, calendar_provider = ?,
                calendar_event_id = ?, calendar_event_url = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                next_title,
                next_note,
                next_due,
                next_due_time,
                next_done,
                next_notify,
                next_cat,
                next_provider,
                next_event_id,
                next_event_url,
                ts,
                reminder_id,
                current_user_id(),
            ),
        )
        await db.commit()
    return await get_reminder(reminder_id)


async def delete_reminder(reminder_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "DELETE FROM reminders WHERE id = ? AND user_id = ?",
            (reminder_id, current_user_id()),
        )
        await db.commit()
        return cur.rowcount > 0


# —— OCR / document captures ——


def _document_capture_dict(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "source_message_id": row.get("source_message_id"),
        "kind": row["kind"],
        "title": row.get("title") or "",
        "summary": row.get("summary") or "",
        "payload": json.loads(row.get("payload_json") or "{}"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def create_document_capture(
    *,
    session_id: str,
    kind: str,
    payload: Dict[str, Any],
    source_message_id: Optional[str] = None,
    title: str = "",
    summary: str = "",
) -> Dict[str, Any]:
    if not await get_session(session_id):
        raise ValueError("会话不存在或无权访问")
    cid = new_id("cap")
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO document_captures
            (id, session_id, source_message_id, kind, title, summary, payload_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cid,
                session_id,
                source_message_id,
                kind,
                title,
                summary,
                json.dumps(payload, ensure_ascii=False),
                ts,
                ts,
            ),
        )
        await db.commit()
    return {
        "id": cid,
        "session_id": session_id,
        "source_message_id": source_message_id,
        "kind": kind,
        "title": title,
        "summary": summary,
        "payload": payload,
        "created_at": ts,
        "updated_at": ts,
    }


async def list_document_captures(
    *,
    session_id: Optional[str] = None,
    kind: Optional[str] = None,
    limit: int = 30,
) -> List[Dict[str, Any]]:
    clauses = ["s.user_id = ?"]
    params: List[Any] = [current_user_id()]
    if session_id:
        clauses.append("c.session_id = ?")
        params.append(session_id)
    if kind:
        clauses.append("c.kind = ?")
        params.append(kind)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(max(1, min(limit, 100)))
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            f"""
            SELECT c.* FROM document_captures c
            JOIN sessions s ON s.id = c.session_id
            {where}
            ORDER BY c.created_at DESC
            LIMIT ?
            """,
            params,
        )
        rows = await cur.fetchall()
    return [_document_capture_dict(dict(r)) for r in rows]


# —— LLM usage / performance metrics ——

USAGE_KINDS = frozenset({"chat", "vision", "tool"})


async def record_llm_usage(
    *,
    kind: str = "chat",
    provider: str = "",
    model: str = "",
    session_id: str = "",
    message_id: str = "",
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
    total_tokens: Optional[int] = None,
    ttft_ms: Optional[int] = None,
    total_ms: Optional[int] = None,
    ok: bool = True,
    error: str = "",
) -> Dict[str, Any]:
    rid = new_id("use")
    ts = _now()
    row = {
        "id": rid,
        "session_id": session_id,
        "message_id": message_id,
        "kind": kind if kind in USAGE_KINDS else "chat",
        "provider": provider,
        "model": model,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "ttft_ms": ttft_ms,
        "total_ms": total_ms,
        "ok": 1 if ok else 0,
        "error": error[:400],
        "created_at": ts,
    }
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO llm_usage
            (
                id, session_id, message_id, kind, provider, model,
                prompt_tokens, completion_tokens, total_tokens,
                ttft_ms, total_ms, ok, error, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["id"],
                row["session_id"],
                row["message_id"],
                row["kind"],
                row["provider"],
                row["model"],
                row["prompt_tokens"],
                row["completion_tokens"],
                row["total_tokens"],
                row["ttft_ms"],
                row["total_ms"],
                row["ok"],
                row["error"],
                row["created_at"],
            ),
        )
        await db.commit()
    return row


def _usage_rollup(rows: List[Dict[str, Any]], key: str) -> List[Dict[str, Any]]:
    bucket: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        name = str(r.get(key) or "(未标注)")
        item = bucket.setdefault(
            name,
            {
                "name": name,
                "calls": 0,
                "failed": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "avg_ttft_ms": 0,
                "avg_total_ms": 0,
            },
        )
        item["calls"] += 1
        if not r.get("ok"):
            item["failed"] += 1
        for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
            item[field] += int(r.get(field) or 0)
        item["avg_ttft_ms"] += int(r.get("ttft_ms") or 0)
        item["avg_total_ms"] += int(r.get("total_ms") or 0)
    out = []
    for item in bucket.values():
        calls = max(1, item["calls"])
        item["avg_ttft_ms"] = round(item["avg_ttft_ms"] / calls)
        item["avg_total_ms"] = round(item["avg_total_ms"] / calls)
        out.append(item)
    out.sort(key=lambda x: x["calls"], reverse=True)
    return out


async def summarize_llm_usage(days: int = 7) -> Dict[str, Any]:
    """按天/模型/类型聚合近 N 天用量与耗时，供 /api/metrics/usage 使用。"""
    span = max(1, min(int(days or 7), 90))
    since = _now() - span * 86400
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM llm_usage WHERE created_at >= ? ORDER BY created_at ASC",
            (since,),
        )
        rows = [dict(r) for r in await cur.fetchall()]

    totals = {
        "calls": len(rows),
        "failed": sum(1 for r in rows if not r.get("ok")),
        "prompt_tokens": sum(int(r.get("prompt_tokens") or 0) for r in rows),
        "completion_tokens": sum(int(r.get("completion_tokens") or 0) for r in rows),
        "total_tokens": sum(int(r.get("total_tokens") or 0) for r in rows),
    }
    avg_ttft = [int(r["ttft_ms"]) for r in rows if r.get("ttft_ms")]
    avg_total = [int(r["total_ms"]) for r in rows if r.get("total_ms")]
    totals["avg_ttft_ms"] = round(sum(avg_ttft) / len(avg_ttft)) if avg_ttft else 0
    totals["avg_total_ms"] = round(sum(avg_total) / len(avg_total)) if avg_total else 0

    by_day: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        day = time.strftime("%Y-%m-%d", time.localtime(r["created_at"]))
        item = by_day.setdefault(
            day, {"day": day, "calls": 0, "total_tokens": 0, "failed": 0}
        )
        item["calls"] += 1
        item["total_tokens"] += int(r.get("total_tokens") or 0)
        if not r.get("ok"):
            item["failed"] += 1

    return {
        "days": span,
        "totals": totals,
        "by_day": sorted(by_day.values(), key=lambda x: x["day"]),
        "by_model": _usage_rollup(rows, "model"),
        "by_kind": _usage_rollup(rows, "kind"),
    }


async def clear_llm_usage(older_than_days: int = 0) -> int:
    """清理用量记录；older_than_days=0 表示全部清空。"""
    async with aiosqlite.connect(DB_PATH) as db:
        if older_than_days > 0:
            cutoff = _now() - older_than_days * 86400
            cur = await db.execute(
                "DELETE FROM llm_usage WHERE created_at < ?", (cutoff,)
            )
        else:
            cur = await db.execute("DELETE FROM llm_usage")
        await db.commit()
        return cur.rowcount or 0


# --- 单用户密码登录 ---

def _user_dict(row: Any) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "password_hash": row["password_hash"],
        "created_at": row["created_at"],
    }


async def get_owner() -> Optional[Dict[str, Any]]:
    """单用户场景：返回唯一账号（最早创建的那个）。"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, password_hash, created_at FROM users ORDER BY created_at LIMIT 1"
        )
        row = await cur.fetchone()
    return _user_dict(row) if row else None


async def get_user(user_id: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT id, password_hash, created_at FROM users WHERE id = ?",
            (user_id,),
        )
        row = await cur.fetchone()
    return _user_dict(row) if row else None


async def create_user(user_id: str, password_hash: str) -> Dict[str, Any]:
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO users (id, password_hash, created_at) VALUES (?, ?, ?)",
            (user_id, password_hash, ts),
        )
        await db.commit()
    return {"id": user_id, "password_hash": password_hash, "created_at": ts}


async def update_user_password(user_id: str, password_hash: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (password_hash, user_id),
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


async def create_auth_session(
    sid: str, user_id: str, ttl_seconds: int
) -> Dict[str, Any]:
    ts = _now()
    expires = ts + ttl_seconds
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO auth_sessions (sid, user_id, created_at, expires_at) "
            "VALUES (?, ?, ?, ?)",
            (sid, user_id, ts, expires),
        )
        await db.commit()
    return {"sid": sid, "user_id": user_id, "created_at": ts, "expires_at": expires}


async def get_auth_session(sid: str) -> Optional[Dict[str, Any]]:
    """返回未过期的会话；过期或不存在返回 None。"""
    if not sid:
        return None
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT sid, user_id, created_at, expires_at FROM auth_sessions WHERE sid = ?",
            (sid,),
        )
        row = await cur.fetchone()
    if not row:
        return None
    if row["expires_at"] <= _now():
        await delete_auth_session(sid)
        return None
    return dict(row)


async def delete_auth_session(sid: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM auth_sessions WHERE sid = ?", (sid,))
        await db.commit()


async def purge_expired_auth_sessions() -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "DELETE FROM auth_sessions WHERE expires_at <= ?", (_now(),)
        )
        await db.commit()
        return cur.rowcount or 0


# --- Agent Memory（轻量 KV） ---


async def get_memory(key: str) -> Optional[str]:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT value FROM agent_memory WHERE user_id = ? AND key = ?",
            (current_user_id(), key),
        )
        row = await cur.fetchone()
    return row[0] if row else None


async def set_memory(key: str, value: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO agent_memory (key, user_id, value, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, "
            "updated_at = excluded.updated_at",
            (key, current_user_id(), value, _now()),
        )
        await db.commit()


async def list_memory() -> Dict[str, str]:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "SELECT key, value FROM agent_memory WHERE user_id = ? ORDER BY updated_at DESC",
            (current_user_id(),),
        )
        rows = await cur.fetchall()
    return {row[0]: row[1] for row in rows}


async def delete_memory(key: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "DELETE FROM agent_memory WHERE user_id = ? AND key = ?",
            (current_user_id(), key),
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


# --- Agent 运行轨迹 ---


async def create_agent_run(session_id: str, message_id: str, goal: str) -> Dict[str, Any]:
    run_id = new_id("run")
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO agent_runs
            (id, user_id, session_id, message_id, goal, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?)""",
            (run_id, current_user_id(), session_id, message_id, goal[:500], ts, ts),
        )
        await db.commit()
    return {"id": run_id, "status": "running"}


async def record_agent_step(
    run_id: str,
    step_index: int,
    skill_name: str,
    arguments: Dict[str, Any],
    result: Dict[str, Any],
) -> None:
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT OR REPLACE INTO agent_steps
            (id, run_id, step_index, skill_name, arguments_json, result_json,
             status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                f"{run_id}_step_{step_index}",
                run_id,
                step_index,
                skill_name,
                json.dumps(arguments, ensure_ascii=False)[:8000],
                json.dumps(result, ensure_ascii=False)[:12000],
                "waiting_confirmation"
                if result.get("code") == "confirmation_required"
                else "completed"
                if result.get("ok")
                else "failed",
                ts,
                ts,
            ),
        )
        await db.commit()


async def get_agent_step(run_id: str, step_index: int) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """SELECT st.* FROM agent_steps st
            JOIN agent_runs r ON r.id = st.run_id
            WHERE st.run_id = ? AND st.step_index = ? AND r.user_id = ?""",
            (run_id, step_index, current_user_id()),
        )
        row = await cur.fetchone()
    if not row:
        return None
    item = dict(row)
    item["arguments"] = json.loads(item.pop("arguments_json") or "{}")
    item["result"] = json.loads(item.pop("result_json") or "{}")
    return item


async def update_agent_step_result(
    run_id: str, step_index: int, result: Dict[str, Any], status: str
) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            """UPDATE agent_steps SET result_json = ?, status = ?, updated_at = ?
            WHERE run_id = ? AND step_index = ? AND EXISTS (
                SELECT 1 FROM agent_runs r WHERE r.id = agent_steps.run_id AND r.user_id = ?
            )""",
            (
                json.dumps(result, ensure_ascii=False)[:12000], status, _now(),
                run_id, step_index, current_user_id(),
            ),
        )
        await db.commit()
    return bool(cur.rowcount)


async def settle_agent_run(run_id: str, status: str, error: str = "") -> None:
    if status not in {"completed", "failed", "cancelled", "waiting_confirmation"}:
        raise ValueError("非法 Agent 运行状态")
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE agent_runs SET status = ?, error = ?, updated_at = ? "
            "WHERE id = ? AND user_id = ?",
            (status, error[:1000], _now(), run_id, current_user_id()),
        )
        await db.commit()


async def list_agent_runs(limit: int = 30) -> List[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM agent_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (current_user_id(), max(1, min(limit, 100))),
        )
        runs = [dict(row) for row in await cur.fetchall()]
        for run in runs:
            step_cur = await db.execute(
                "SELECT * FROM agent_steps WHERE run_id = ? ORDER BY step_index",
                (run["id"],),
            )
            steps = []
            for row in await step_cur.fetchall():
                item = dict(row)
                item["arguments"] = json.loads(item.pop("arguments_json") or "{}")
                item["result"] = json.loads(item.pop("result_json") or "{}")
                steps.append(item)
            run["steps"] = steps
    return runs


async def diagnostics_overview(days: int = 7) -> Dict[str, Any]:
    since = _now() - max(1, days) * 86400
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute(
            """SELECT st.skill_name, st.status, st.arguments_json, st.result_json, st.created_at, st.updated_at
            FROM agent_steps st JOIN agent_runs r ON r.id = st.run_id
            WHERE r.user_id = ? AND st.created_at >= ?""",
            (current_user_id(), since),
        )
        steps = [dict(row) for row in await cur.fetchall()]
        usage_cur = await conn.execute(
            """SELECT u.provider, u.model, u.ok, u.error, u.total_tokens, u.total_ms
            FROM llm_usage u JOIN sessions s ON s.id = u.session_id
            WHERE s.user_id = ? AND u.created_at >= ?""",
            (current_user_id(), since),
        )
        usage = [dict(row) for row in await usage_cur.fetchall()]
    skills: Dict[str, Dict[str, Any]] = {}
    for row in steps:
        item = skills.setdefault(row["skill_name"], {"calls": 0, "success": 0, "failed": 0, "latencies": []})
        item["calls"] += 1
        item["success" if row["status"] == "completed" else "failed"] += 1
        result = json.loads(row.get("result_json") or "{}")
        item["latencies"].append(max(0, int(result.get("duration_ms") or (row["updated_at"] - row["created_at"]) * 1000)))
    for item in skills.values():
        latencies = sorted(item.pop("latencies"))
        item["success_rate"] = round(item["success"] / item["calls"], 4) if item["calls"] else 0
        item["p95_ms"] = latencies[min(len(latencies) - 1, int(len(latencies) * .95))] if latencies else 0
    confirmation_steps = []
    for row in steps:
        arguments = json.loads(row.get("arguments_json") or "{}")
        action = str(arguments.get("action") or "")
        if (
            row["skill_name"] == "manage_calendar" and action in {"sync_reminder", "create_event"}
            or row["skill_name"] == "manage_reminder" and action == "sync"
            or row["skill_name"] == "manage_todo" and action == "delete"
        ):
            confirmation_steps.append(row)
    return {
        "days": days,
        "skills": skills,
        "confirmation_funnel": {
            "requested": len(confirmation_steps),
            "waiting": sum(1 for row in confirmation_steps if row["status"] == "waiting_confirmation"),
            "approved": sum(1 for row in confirmation_steps if row["status"] == "completed"),
            "rejected": sum(1 for row in confirmation_steps if row["status"] == "rejected"),
            "execution_failed": sum(1 for row in confirmation_steps if row["status"] == "failed"),
        },
        "llm": {
            "calls": len(usage),
            "failed": sum(1 for row in usage if not row["ok"]),
            "total_tokens": sum(int(row["total_tokens"] or 0) for row in usage),
            "total_ms": sum(int(row["total_ms"] or 0) for row in usage),
            "error_codes": sorted({str(row["error"])[:80] for row in usage if row["error"]}),
        },
    }


# --- Current-account backup / restore ---

BACKUP_SCHEMA_VERSION = 1
_BACKUP_TABLES = (
    "sessions", "messages", "reminders", "todos", "document_captures",
    "agent_memory", "agent_runs", "agent_steps",
)
_BACKUP_COLUMNS = {
    "sessions": {"id", "user_id", "title", "created_at", "updated_at", "module_id", "scenario_id"},
    "messages": {"id", "session_id", "role", "content", "status", "chunks_json", "error", "created_at", "updated_at"},
    "reminders": {"id", "user_id", "category", "title", "note", "due_date", "due_time", "done", "notify_browser", "calendar_provider", "calendar_event_id", "calendar_event_url", "created_at", "updated_at"},
    "todos": {"id", "user_id", "title", "note", "due_date", "due_time", "done", "created_at", "updated_at"},
    "document_captures": {"id", "session_id", "source_message_id", "kind", "title", "summary", "payload_json", "created_at", "updated_at"},
    "agent_memory": {"key", "user_id", "value", "updated_at"},
    "agent_runs": {"id", "user_id", "session_id", "message_id", "goal", "status", "error", "created_at", "updated_at"},
    "agent_steps": {"id", "run_id", "step_index", "skill_name", "arguments_json", "result_json", "status", "created_at", "updated_at"},
}


async def export_current_user_data() -> Dict[str, Any]:
    user_id = current_user_id()
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        queries = {
            "sessions": ("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at", (user_id,)),
            "messages": ("SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.user_id = ? ORDER BY m.created_at", (user_id,)),
            "reminders": ("SELECT * FROM reminders WHERE user_id = ? ORDER BY created_at", (user_id,)),
            "todos": ("SELECT * FROM todos WHERE user_id = ? ORDER BY created_at", (user_id,)),
            "document_captures": ("SELECT c.* FROM document_captures c JOIN sessions s ON s.id = c.session_id WHERE s.user_id = ? ORDER BY c.created_at", (user_id,)),
            "agent_memory": ("SELECT * FROM agent_memory WHERE user_id = ? ORDER BY key", (user_id,)),
            "agent_runs": ("SELECT * FROM agent_runs WHERE user_id = ? ORDER BY created_at", (user_id,)),
            "agent_steps": ("SELECT st.* FROM agent_steps st JOIN agent_runs r ON r.id = st.run_id WHERE r.user_id = ? ORDER BY st.created_at", (user_id,)),
        }
        data: Dict[str, List[Dict[str, Any]]] = {}
        for name, (sql, params) in queries.items():
            cur = await conn.execute(sql, params)
            data[name] = [dict(row) for row in await cur.fetchall()]
        now = _now()
        await conn.execute(
            "INSERT INTO data_backup_events (id, user_id, action, created_at) VALUES (?, ?, 'export', ?)",
            (new_id("backup"), user_id, now),
        )
        await conn.commit()
    result = {
        "format": "qingning-account-backup",
        "schema_version": BACKUP_SCHEMA_VERSION,
        "user_id": user_id,
        "created_at": now,
        "data": data,
    }
    canonical = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    result["integrity_sha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return result


def _validate_backup_payload(payload: Dict[str, Any], user_id: str) -> Dict[str, List[Dict[str, Any]]]:
    if payload.get("format") != "qingning-account-backup":
        raise ValueError("不是青柠账号备份文件")
    if payload.get("schema_version") != BACKUP_SCHEMA_VERSION:
        raise ValueError("备份版本不受支持")
    if payload.get("user_id") != user_id:
        raise ValueError("备份所属用户与当前登录用户不一致")
    integrity = str(payload.get("integrity_sha256") or "")
    unsigned = {key: value for key, value in payload.items() if key != "integrity_sha256"}
    canonical = json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if not integrity or not secrets.compare_digest(integrity, expected):
        raise ValueError("备份完整性校验失败，文件可能已被修改")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("备份缺少 data")
    clean: Dict[str, List[Dict[str, Any]]] = {}
    total = 0
    for table in _BACKUP_TABLES:
        rows = data.get(table, [])
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError(f"备份表 {table} 格式不正确")
        if any(not set(row).issubset(_BACKUP_COLUMNS[table]) for row in rows):
            raise ValueError(f"备份表 {table} 包含未知字段")
        total += len(rows)
        clean[table] = rows
    if total > 100_000:
        raise ValueError("备份记录过多，拒绝导入")
    return clean


async def restore_current_user_data(payload: Dict[str, Any]) -> Dict[str, int]:
    user_id = current_user_id()
    data = _validate_backup_payload(payload, user_id)
    session_ids = {str(row.get("id") or "") for row in data["sessions"]}
    run_ids = {str(row.get("id") or "") for row in data["agent_runs"]}
    if any(str(row.get("session_id") or "") not in session_ids for row in data["messages"] + data["document_captures"]):
        raise ValueError("备份中存在不属于会话的记录")
    if any(str(row.get("run_id") or "") not in run_ids for row in data["agent_steps"]):
        raise ValueError("备份中存在不属于 Agent 运行的步骤")

    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("BEGIN IMMEDIATE")
        try:
            await conn.execute("DELETE FROM agent_steps WHERE run_id IN (SELECT id FROM agent_runs WHERE user_id = ?)", (user_id,))
            await conn.execute("DELETE FROM agent_runs WHERE user_id = ?", (user_id,))
            await conn.execute("DELETE FROM document_captures WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)", (user_id,))
            await conn.execute("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)", (user_id,))
            await conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            await conn.execute("DELETE FROM reminders WHERE user_id = ?", (user_id,))
            await conn.execute("DELETE FROM todos WHERE user_id = ?", (user_id,))
            await conn.execute("DELETE FROM agent_memory WHERE user_id = ?", (user_id,))

            order = ("sessions", "messages", "reminders", "todos", "document_captures", "agent_memory", "agent_runs", "agent_steps")
            for table in order:
                for source in data[table]:
                    row = dict(source)
                    if table in {"sessions", "reminders", "todos", "agent_memory", "agent_runs"}:
                        row["user_id"] = user_id
                    columns = list(row.keys())
                    if not columns:
                        continue
                    placeholders = ",".join("?" for _ in columns)
                    names = ",".join(columns)
                    await conn.execute(
                        f"INSERT INTO {table} ({names}) VALUES ({placeholders})",
                        tuple(row[column] for column in columns),
                    )
            await conn.execute(
                "INSERT INTO data_backup_events (id, user_id, action, created_at) VALUES (?, ?, 'restore', ?)",
                (new_id("backup"), user_id, _now()),
            )
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise
    return {table: len(rows) for table, rows in data.items()}


async def backup_status() -> Dict[str, Optional[float]]:
    async with aiosqlite.connect(DB_PATH) as conn:
        cur = await conn.execute(
            "SELECT action, created_at FROM data_backup_events WHERE user_id = ? ORDER BY created_at DESC",
            (current_user_id(),),
        )
        rows = await cur.fetchall()
    return {
        "last_export_at": next((row[1] for row in rows if row[0] == "export"), None),
        "last_restore_at": next((row[1] for row in rows if row[0] == "restore"), None),
    }

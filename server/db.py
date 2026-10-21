"""SQLite persistence. Message terminal status is only written on explicit settle."""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiosqlite

DB_PATH = Path(__file__).parent / "data" / "workbench.db"

# Terminal statuses that must never be overwritten by a later partial write.
TERMINAL = frozenset({"completed", "failed", "cancelled"})


async def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
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
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                due_date TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0,
                notify_browser INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_reminders_due
                ON reminders(due_date, done, category);
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
        await db.commit()


def _session_dict(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "module_id": row.get("module_id") or "docs",
        "scenario_id": row.get("scenario_id") or "general",
    }


def _now() -> float:
    return time.time()


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
            (id, title, created_at, updated_at, module_id, scenario_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (sid, title, ts, ts, module_id, scenario_id),
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
                """
                SELECT id, title, created_at, updated_at, module_id, scenario_id
                FROM sessions WHERE module_id = ?
                ORDER BY updated_at DESC
                """,
                (module_id,),
            )
        else:
            cur = await db.execute(
                """
                SELECT id, title, created_at, updated_at, module_id, scenario_id
                FROM sessions ORDER BY updated_at DESC
                """
            )
        rows = await cur.fetchall()
    return [_session_dict(dict(r)) for r in rows]


async def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT id, title, created_at, updated_at, module_id, scenario_id
            FROM sessions WHERE id = ?
            """,
            (session_id,),
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
            WHERE id = ?
            """,
            (module_id, scenario_id, ts, session_id),
        )
        await db.commit()
    return await get_session(session_id)


async def touch_session(session_id: str, title: Optional[str] = None) -> None:
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        if title is not None:
            await db.execute(
                "UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?",
                (ts, title, session_id),
            )
        else:
            await db.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                (ts, session_id),
            )
        await db.commit()


async def delete_session(session_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        cur = await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
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
        cur = await db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
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
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
            (session_id,),
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


# —— Life reminders (medicine / pet) ——

REMINDER_CATEGORIES = frozenset({"medicine", "pet"})


def _reminder_dict(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "category": row["category"],
        "title": row["title"],
        "note": row.get("note") or "",
        "due_date": row["due_date"],
        "done": bool(row.get("done")),
        "notify_browser": bool(row.get("notify_browser", 1)),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


async def list_reminders(
    category: Optional[str] = None,
    include_done: bool = False,
) -> List[Dict[str, Any]]:
    clauses = []
    params: List[Any] = []
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
            ORDER BY done ASC, due_date ASC, created_at DESC
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
            WHERE done = 0 AND due_date <= ?
            ORDER BY due_date ASC
            """,
            (end,),
        )
        rows = await cur.fetchall()
    return [_reminder_dict(dict(r)) for r in rows]


async def create_reminder(
    *,
    category: str,
    title: str,
    due_date: str,
    note: str = "",
    notify_browser: bool = True,
) -> Dict[str, Any]:
    rid = new_id("rem")
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO reminders
            (id, category, title, note, due_date, done, notify_browser, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
            """,
            (
                rid,
                category,
                title,
                note,
                due_date,
                1 if notify_browser else 0,
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
        "done": False,
        "notify_browser": notify_browser,
        "created_at": ts,
        "updated_at": ts,
    }


async def get_reminder(reminder_id: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM reminders WHERE id = ?", (reminder_id,)
        )
        row = await cur.fetchone()
    return _reminder_dict(dict(row)) if row else None


async def update_reminder(
    reminder_id: str,
    *,
    title: Optional[str] = None,
    note: Optional[str] = None,
    due_date: Optional[str] = None,
    done: Optional[bool] = None,
    notify_browser: Optional[bool] = None,
    category: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    existing = await get_reminder(reminder_id)
    if not existing:
        return None
    next_title = title if title is not None else existing["title"]
    next_note = note if note is not None else existing["note"]
    next_due = due_date if due_date is not None else existing["due_date"]
    next_done = int(done) if done is not None else int(existing["done"])
    next_notify = (
        int(notify_browser)
        if notify_browser is not None
        else int(existing["notify_browser"])
    )
    next_cat = category if category is not None else existing["category"]
    ts = _now()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE reminders
            SET title = ?, note = ?, due_date = ?, done = ?,
                notify_browser = ?, category = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_title,
                next_note,
                next_due,
                next_done,
                next_notify,
                next_cat,
                ts,
                reminder_id,
            ),
        )
        await db.commit()
    return await get_reminder(reminder_id)


async def delete_reminder(reminder_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "DELETE FROM reminders WHERE id = ?", (reminder_id,)
        )
        await db.commit()
        return cur.rowcount > 0

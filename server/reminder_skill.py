"""提醒能力的内部复用层：供 API 与 Agent 工具共用。"""

from __future__ import annotations

from typing import Any, Dict

from calendar_sync import create_calendar_event, sync_status
import db


async def create_reminder_entry(
    *,
    category: str,
    title: str,
    due_date: str,
    due_time: str = "",
    note: str = "",
    notify_browser: bool = True,
    auto_sync_calendar: bool = True,
) -> Dict[str, Any]:
    item = await db.create_reminder(
        category=category,
        title=title.strip(),
        due_date=due_date,
        due_time=due_time,
        note=note.strip(),
        notify_browser=notify_browser,
    )
    sync_result: Dict[str, Any] | None = None
    if auto_sync_calendar and sync_status().get("configured"):
        sync_result = await create_calendar_event(
            title=item["title"],
            due_date=item["due_date"],
            note=item["note"],
            category=item["category"],
            due_time=item.get("due_time") or "",
        )
        if sync_result.get("ok"):
            item = await db.update_reminder(
                item["id"],
                calendar_provider=str(sync_result.get("provider") or ""),
                calendar_event_id=str(sync_result.get("event_id") or ""),
                calendar_event_url=str(sync_result.get("event_url") or ""),
            ) or item
    return {"item": item, "calendar_sync": sync_result}


async def sync_existing_reminder(reminder: Dict[str, Any]) -> Dict[str, Any]:
    if reminder.get("calendar_provider") and reminder.get("calendar_event_id"):
        return {
            "ok": True,
            "already_synced": True,
            "provider": reminder.get("calendar_provider") or "",
            "event_url": reminder.get("calendar_event_url") or "",
            "item": reminder,
        }
    if not sync_status().get("configured"):
        return {
            "ok": False,
            "code": "not_configured",
            "reason": "当前环境没有可用的日历同步（本地日历仅支持 macOS）。",
        }
    result = await create_calendar_event(
        title=str(reminder.get("title") or ""),
        due_date=str(reminder.get("due_date") or ""),
        note=str(reminder.get("note") or ""),
        category=str(reminder.get("category") or ""),
        due_time=str(reminder.get("due_time") or ""),
    )
    if not result.get("ok"):
        return {
            "ok": False,
            "code": "sync_failed",
            "reason": str(result.get("error") or "同步到日历失败"),
        }
    updated = await db.update_reminder(
        str(reminder["id"]),
        calendar_provider=str(result.get("provider") or ""),
        calendar_event_id=str(result.get("event_id") or ""),
        calendar_event_url=str(result.get("event_url") or ""),
    )
    return {
        "ok": True,
        "provider": result.get("provider") or "",
        "event_url": result.get("event_url") or "",
        "alert_minutes": result.get("alert_minutes"),
        "item": updated or reminder,
    }

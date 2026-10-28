"""
日历同步：支持本地系统日历（macOS Calendar）/ Google Calendar / 飞书日历。

设计原则：
- 未配置凭证时，不影响本地提醒正常工作。
- 默认优先使用 CALENDAR_SYNC_PROVIDER 指定的提供商；
  未指定时按 Google -> 飞书 的顺序自动选择，macOS 上无任何配置时
  默认使用本机系统日历（local）。
- 提醒只有日期时，远端日历默认创建为当天 09:00 的短日程，
  便于在日历中被看见，也避免全日程覆盖用户原有安排；
  提醒带 due_time（HH:MM）时按该时间点创建。
- 本地系统日历会额外写入一条系统提醒（display alarm），
  用户授权控制 Calendar 后即可在到点收到通知。
"""

from __future__ import annotations

import os
import platform
import re
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Any, Dict
from urllib.parse import quote

import httpx

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

_CST = timezone(timedelta(hours=8))
_TZ_NAME = "Asia/Shanghai"
_GOOGLE_BASE = "https://www.googleapis.com/calendar/v3"
_FEISHU_BASE = "https://open.feishu.cn/open-apis/calendar/v4"
_LOCAL_CALENDAR_NAME = "青柠提醒"
_LOCAL_ALERT_MINUTES = 10
_MONTH_NAMES = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]


def _normalize_provider(provider: str = "") -> str:
    raw = (provider or os.getenv("CALENDAR_SYNC_PROVIDER") or "").strip().lower()
    if raw in {"google", "feishu"}:
        return raw
    if raw in {"local", "apple", "system", "calendar"}:
        return "local"
    if (os.getenv("GOOGLE_CALENDAR_ACCESS_TOKEN") or "").strip():
        return "google"
    if (os.getenv("FEISHU_CALENDAR_ACCESS_TOKEN") or "").strip():
        return "feishu"
    if platform.system() == "Darwin":
        return "local"
    return ""


def sync_status(provider: str = "") -> Dict[str, Any]:
    chosen = _normalize_provider(provider)
    if chosen == "local":
        return {
            "configured": platform.system() == "Darwin",
            "provider": "local",
            "calendar_id": (os.getenv("LOCAL_CALENDAR_NAME") or _LOCAL_CALENDAR_NAME).strip()
            or _LOCAL_CALENDAR_NAME,
        }
    if chosen == "google":
        return {
            "configured": True,
            "provider": "google",
            "calendar_id": (os.getenv("GOOGLE_CALENDAR_ID") or "primary").strip() or "primary",
        }
    if chosen == "feishu":
        return {
            "configured": bool(
                (os.getenv("FEISHU_CALENDAR_ACCESS_TOKEN") or "").strip()
                and (os.getenv("FEISHU_CALENDAR_ID") or "").strip()
            ),
            "provider": "feishu",
            "calendar_id": (os.getenv("FEISHU_CALENDAR_ID") or "").strip(),
        }
    return {"configured": False, "provider": "", "calendar_id": ""}


def _event_note(note: str, category: str) -> str:
    lines = []
    if note.strip():
        lines.append(note.strip())
    if category.strip():
        lines.append(f"提醒类型：{category.strip()}")
    lines.append("来源：青柠 · 生活助理 Agent")
    return "\n".join(lines)[:2000]


def _parse_due_time(due_time: str) -> tuple[int, int] | None:
    """due_time 形如 HH:MM 时返回 (时, 分)，否则 None。"""
    m = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", (due_time or "").strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def _event_start(due_date: str, due_time: str = "") -> datetime:
    """提醒起始时间：有 due_time 用该时间点，否则默认当天 09:00。"""
    parsed = _parse_due_time(due_time)
    hour, minute = parsed if parsed else (9, 0)
    return datetime.strptime(due_date, "%Y-%m-%d").replace(
        hour=hour, minute=minute, second=0, microsecond=0
    )


def _reminder_window(due_date: str, due_time: str = "") -> tuple[int, int]:
    start = _event_start(due_date, due_time).replace(tzinfo=_CST)
    end = start + timedelta(minutes=30)
    return int(start.timestamp()), int(end.timestamp())


def _as_apple_string(value: str) -> str:
    return '"' + (value or "").replace("\\", "\\\\").replace('"', '\\"') + '"'


def _local_alert_minutes() -> int:
    raw = (os.getenv("LOCAL_CALENDAR_ALERT_MINUTES") or "").strip()
    if not raw:
        return _LOCAL_ALERT_MINUTES
    try:
        value = int(raw)
    except ValueError:
        return _LOCAL_ALERT_MINUTES
    if value < 0:
        return 0
    return min(value, 24 * 60)


def local_alert_minutes() -> int:
    """本地日历提前提醒分钟数（供接口展示）。"""
    return _local_alert_minutes()


def _run_osascript(script: str) -> Dict[str, Any]:
    proc = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        check=False,
    )
    ok = proc.returncode == 0
    return {
        "ok": ok,
        "stdout": (proc.stdout or "").strip(),
        "stderr": (proc.stderr or "").strip(),
        "code": proc.returncode,
    }


async def _create_local_event(
    *,
    title: str,
    due_date: str,
    note: str,
    category: str,
    due_time: str = "",
) -> Dict[str, Any]:
    if platform.system() != "Darwin":
        return {"ok": False, "provider": "local", "error": "本地系统日历仅支持 macOS"}
    start = _event_start(due_date, due_time)
    end = start + timedelta(minutes=30)
    calendar_name = (os.getenv("LOCAL_CALENDAR_NAME") or _LOCAL_CALENDAR_NAME).strip() or _LOCAL_CALENDAR_NAME
    desc = _event_note(note, category)
    alert_minutes = _local_alert_minutes()
    script = f"""
set calName to {_as_apple_string(calendar_name)}
set eventTitle to {_as_apple_string(title[:120])}
set eventNote to {_as_apple_string(desc)}
tell application "Calendar"
    if not (exists calendar calName) then
        make new calendar with properties {{name:calName}}
    end if
    set startDate to current date
    set year of startDate to {start.year}
    set month of startDate to {_MONTH_NAMES[start.month]}
    set day of startDate to {start.day}
    set time of startDate to ({start.hour} * hours + {start.minute} * minutes)
    set endDate to current date
    set year of endDate to {end.year}
    set month of endDate to {_MONTH_NAMES[end.month]}
    set day of endDate to {end.day}
    set time of endDate to ({end.hour} * hours + {end.minute} * minutes)
    tell calendar calName
        set newEvent to make new event with properties {{summary:eventTitle, start date:startDate, end date:endDate, description:eventNote}}
        tell newEvent
            try
                make new display alarm at end with properties {{trigger interval:-{alert_minutes}}}
            end try
        end tell
        return uid of newEvent
    end tell
end tell
""".strip()
    result = _run_osascript(script)
    if not result["ok"]:
        detail = result["stderr"] or result["stdout"] or "unknown"
        if "-1743" in detail:
            detail = "未获得系统授权控制 Calendar，请在系统设置里允许当前终端/后端控制日历。"
        return {"ok": False, "provider": "local", "error": detail}
    return {
        "ok": True,
        "provider": "local",
        "calendar_id": calendar_name,
        "event_id": result["stdout"],
        "event_url": "",
        "alert_minutes": alert_minutes,
    }


async def _delete_local_event(event_id: str) -> Dict[str, Any]:
    if platform.system() != "Darwin":
        return {"ok": False, "provider": "local", "error": "本地系统日历仅支持 macOS"}
    calendar_name = (os.getenv("LOCAL_CALENDAR_NAME") or _LOCAL_CALENDAR_NAME).strip() or _LOCAL_CALENDAR_NAME
    script = f"""
set calName to {_as_apple_string(calendar_name)}
set targetUid to {_as_apple_string(event_id)}
tell application "Calendar"
    if not (exists calendar calName) then
        return "missing"
    end if
    tell calendar calName
        set hits to every event whose uid is targetUid
        if (count of hits) is 0 then
            return "missing"
        end if
        delete item 1 of hits
        return "deleted"
    end tell
end tell
""".strip()
    result = _run_osascript(script)
    if not result["ok"]:
        detail = result["stderr"] or result["stdout"] or "unknown"
        if "-1743" in detail:
            detail = "未获得系统授权控制 Calendar，请在系统设置里允许当前终端/后端控制日历。"
        return {"ok": False, "provider": "local", "error": detail}
    return {
        "ok": True,
        "provider": "local",
        "calendar_id": calendar_name,
        "event_id": event_id,
    }


async def _create_google_event(
    *,
    title: str,
    due_date: str,
    note: str,
    category: str,
    due_time: str = "",
) -> Dict[str, Any]:
    token = (os.getenv("GOOGLE_CALENDAR_ACCESS_TOKEN") or "").strip()
    calendar_id = (os.getenv("GOOGLE_CALENDAR_ID") or "primary").strip() or "primary"
    if not token:
        return {"ok": False, "provider": "google", "error": "未配置 Google Calendar Access Token"}
    url = f"{_GOOGLE_BASE}/calendars/{quote(calendar_id, safe='')}/events"
    if _parse_due_time(due_time):
        start = _event_start(due_date, due_time)
        end = start + timedelta(minutes=30)
        payload = {
            "summary": title[:120],
            "description": _event_note(note, category),
            "start": {"dateTime": start.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": _TZ_NAME},
            "end": {"dateTime": end.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": _TZ_NAME},
            "reminders": {"useDefault": True},
        }
    else:
        next_day = (
            datetime.strptime(due_date, "%Y-%m-%d") + timedelta(days=1)
        ).strftime("%Y-%m-%d")
        payload = {
            "summary": title[:120],
            "description": _event_note(note, category),
            "start": {"date": due_date, "timeZone": _TZ_NAME},
            "end": {"date": next_day, "timeZone": _TZ_NAME},
            "reminders": {"useDefault": True},
        }
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        resp = await client.post(
            url,
            json=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        resp.raise_for_status()
        data = resp.json() or {}
    return {
        "ok": True,
        "provider": "google",
        "calendar_id": calendar_id,
        "event_id": str(data.get("id") or ""),
        "event_url": str(data.get("htmlLink") or ""),
    }


async def _delete_google_event(event_id: str) -> Dict[str, Any]:
    token = (os.getenv("GOOGLE_CALENDAR_ACCESS_TOKEN") or "").strip()
    calendar_id = (os.getenv("GOOGLE_CALENDAR_ID") or "primary").strip() or "primary"
    if not token:
        return {"ok": False, "provider": "google", "error": "未配置 Google Calendar Access Token"}
    url = (
        f"{_GOOGLE_BASE}/calendars/{quote(calendar_id, safe='')}"
        f"/events/{quote(event_id, safe='')}"
    )
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        resp = await client.delete(
            url,
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
    return {"ok": True, "provider": "google", "calendar_id": calendar_id, "event_id": event_id}


async def _create_feishu_event(
    *,
    title: str,
    due_date: str,
    note: str,
    category: str,
    due_time: str = "",
) -> Dict[str, Any]:
    token = (os.getenv("FEISHU_CALENDAR_ACCESS_TOKEN") or "").strip()
    calendar_id = (os.getenv("FEISHU_CALENDAR_ID") or "").strip()
    if not token or not calendar_id:
        return {"ok": False, "provider": "feishu", "error": "未配置飞书日历 Access Token 或 Calendar ID"}
    start_ts, end_ts = _reminder_window(due_date, due_time)
    url = f"{_FEISHU_BASE}/calendars/{quote(calendar_id, safe='')}/events"
    payload = {
        "summary": title[:120],
        "description": _event_note(note, category),
        "need_notification": True,
        "start_time": {"timestamp": str(start_ts), "timezone": _TZ_NAME},
        "end_time": {"timestamp": str(end_ts), "timezone": _TZ_NAME},
    }
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        resp = await client.post(
            url,
            json=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
        )
        resp.raise_for_status()
        data = resp.json() or {}
    event = (data.get("data") or {}).get("event") or data.get("data") or {}
    return {
        "ok": True,
        "provider": "feishu",
        "calendar_id": calendar_id,
        "event_id": str(event.get("event_id") or event.get("id") or ""),
        "event_url": str(event.get("link") or event.get("url") or ""),
    }


async def _delete_feishu_event(event_id: str) -> Dict[str, Any]:
    token = (os.getenv("FEISHU_CALENDAR_ACCESS_TOKEN") or "").strip()
    calendar_id = (os.getenv("FEISHU_CALENDAR_ID") or "").strip()
    if not token or not calendar_id:
        return {"ok": False, "provider": "feishu", "error": "未配置飞书日历 Access Token 或 Calendar ID"}
    url = (
        f"{_FEISHU_BASE}/calendars/{quote(calendar_id, safe='')}"
        f"/events/{quote(event_id, safe='')}"
    )
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        resp = await client.delete(
            url,
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
    return {"ok": True, "provider": "feishu", "calendar_id": calendar_id, "event_id": event_id}


async def create_calendar_event(
    *,
    title: str,
    due_date: str,
    note: str = "",
    category: str = "",
    provider: str = "",
    due_time: str = "",
) -> Dict[str, Any]:
    chosen = _normalize_provider(provider)
    if not chosen:
        return {"ok": False, "provider": "", "error": "未配置可用的日历同步"}
    try:
        if chosen == "local":
            return await _create_local_event(
                title=title, due_date=due_date, note=note, category=category, due_time=due_time
            )
        if chosen == "google":
            return await _create_google_event(
                title=title, due_date=due_date, note=note, category=category, due_time=due_time
            )
        return await _create_feishu_event(
            title=title, due_date=due_date, note=note, category=category, due_time=due_time
        )
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "provider": chosen,
            "error": f"同步到日历失败：{type(exc).__name__}",
        }


async def delete_calendar_event(
    *,
    event_id: str,
    provider: str = "",
) -> Dict[str, Any]:
    chosen = _normalize_provider(provider)
    if not chosen or not event_id.strip():
        return {"ok": False, "provider": chosen, "error": "缺少可删除的日历事件"}
    try:
        if chosen == "local":
            return await _delete_local_event(event_id.strip())
        if chosen == "google":
            return await _delete_google_event(event_id.strip())
        return await _delete_feishu_event(event_id.strip())
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "provider": chosen,
            "error": f"从日历移除失败：{type(exc).__name__}",
        }

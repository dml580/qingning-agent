"""
轻量 Agent Memory：只记可复用的小事实（常用城市、最近提醒、最近搜索、偏好）。

设计取舍：
- 不做向量记忆、不做全量对话摘要。单用户本地场景下，几 KB 的显式 KV
  比"把历史全塞回 prompt"更省 token，也更容易解释与清理。
- 写入时机统一在 `observe()`：工具成功执行后顺手记一笔，避免各处散落。
- 读取时机统一在 `build_memory_hint()`：拼进 system prompt，供模型参考。
"""

from __future__ import annotations

from typing import Any, Dict, List

import db

# key -> 给模型看的中文标签
MEMORY_LABELS: Dict[str, str] = {
    "city": "常用城市",
    "last_reminder": "最近一条提醒",
    "last_search": "最近搜索主题",
    "preference": "用户偏好",
}


def _clean(value: Any, limit: int = 80) -> str:
    return " ".join(str(value or "").split())[:limit]


async def remember(key: str, value: str) -> None:
    text = _clean(value)
    if not key or not text:
        return
    await db.set_memory(key, text)


async def recall(key: str) -> str:
    return (await db.get_memory(key)) or ""


async def forget(key: str) -> bool:
    return await db.delete_memory(key)


async def snapshot() -> Dict[str, str]:
    raw = await db.list_memory()
    return {k: v for k, v in raw.items() if k in MEMORY_LABELS and v}


def build_memory_hint(items: Dict[str, str]) -> str:
    """把记忆拼成 system prompt 片段；没有记忆时返回空串。"""
    lines = [
        f"- {MEMORY_LABELS[k]}：{v}" for k, v in items.items() if v and k in MEMORY_LABELS
    ]
    if not lines:
        return ""
    return (
        "\n\n【已知用户信息（来自本机记忆，可直接使用但不要主动炫耀）】\n"
        + "\n".join(lines)
        + "\n用户没说城市时，查天气默认用上面的常用城市。"
    )


async def observe(name: str, arguments: Dict[str, Any], result: Any) -> List[str]:
    """工具执行成功后记录可复用事实；返回被更新的 key 列表。"""
    if not isinstance(result, dict) or not result.get("ok"):
        return []
    updated: List[str] = []
    if name == "get_weather":
        city = _clean(result.get("city"), 20)
        if city:
            await remember("city", city)
            updated.append("city")
    elif name == "web_search":
        query = _clean(arguments.get("query"), 60)
        if query:
            await remember("last_search", query)
            updated.append("last_search")
    elif name == "manage_reminder":
        args = arguments or {}
        action = str(args.get("action") or "")
        if action == "add" and isinstance(result.get("item"), dict):
            item = result["item"]
            when = _clean(item.get("due_date"), 20)
            if item.get("due_time"):
                when = f"{when} {item['due_time']}".strip()
            await remember(
                "last_reminder", f"{_clean(item.get('title'), 40)} @ {when}".strip()
            )
            updated.append("last_reminder")
    return updated

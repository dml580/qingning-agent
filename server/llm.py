"""
多提供商 LLM（OpenAI 兼容 Chat Completions）+ 文书图片审核。

配置优先级：页面「模型设置」写入的本机运行时文件 > 环境变量（.env）。
API Key 只存在本机（.env 或 server/data/llm_runtime.json），接口对外只返回脱敏提示。

环境变量（默认豆包）：
  ARK_API_KEY / ARK_MODEL / ARK_VISION_MODEL / ARK_BASE_URL
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Union

import httpx

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

DATA_DIR = Path(__file__).parent / "data"
RUNTIME_PATH = DATA_DIR / "llm_runtime.json"
_runtime_lock = threading.Lock()

DEFAULT_ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_ARK_MODEL = "doubao-seed-2-0-lite-260428"

DEFAULT_SYSTEM_PROMPT = (
    "你是「青柠」生活文书助手。回答准确、简洁、有条理。"
    "用中文回复，除非用户要求其他语言。"
)

ContentPart = Union[str, List[Dict[str, Any]]]

# 预设提供商（均走 OpenAI 兼容 /chat/completions）
PROVIDERS: Dict[str, Dict[str, Any]] = {
    "doubao": {
        "id": "doubao",
        "label": "豆包（火山方舟）",
        "default_base_url": DEFAULT_ARK_BASE,
        "default_model": DEFAULT_ARK_MODEL,
        "hint": "模型名一般填推理接入点 ID（ep-xxxx）",
        "docs_url": "https://console.volcengine.com/ark",
    },
    "deepseek": {
        "id": "deepseek",
        "label": "DeepSeek",
        "default_base_url": "https://api.deepseek.com/v1",
        "default_model": "deepseek-chat",
        "hint": "开放平台创建 API Key 后填写",
        "docs_url": "https://platform.deepseek.com/",
    },
    "openai": {
        "id": "openai",
        "label": "OpenAI",
        "default_base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "hint": "需可访问 OpenAI；读图请选支持视觉的模型",
        "docs_url": "https://platform.openai.com/",
    },
    "siliconflow": {
        "id": "siliconflow",
        "label": "硅基流动",
        "default_base_url": "https://api.siliconflow.cn/v1",
        "default_model": "deepseek-ai/DeepSeek-V3",
        "hint": "OpenAI 兼容；模型名以控制台为准",
        "docs_url": "https://cloud.siliconflow.cn/",
    },
    "custom": {
        "id": "custom",
        "label": "自定义（OpenAI 兼容）",
        "default_base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "hint": "填写兼容 /v1/chat/completions 的 Base URL",
        "docs_url": "",
    },
}


def list_providers() -> List[Dict[str, Any]]:
    return [
        {
            "id": p["id"],
            "label": p["label"],
            "default_base_url": p["default_base_url"],
            "default_model": p["default_model"],
            "hint": p["hint"],
            "docs_url": p.get("docs_url") or "",
        }
        for p in PROVIDERS.values()
    ]


def _env_defaults() -> Dict[str, Optional[str]]:
    model = (os.getenv("ARK_MODEL") or DEFAULT_ARK_MODEL).strip()
    vision = (os.getenv("ARK_VISION_MODEL") or model).strip()
    key = (os.getenv("ARK_API_KEY") or "").strip() or None
    return {
        "provider": "doubao",
        "api_key": key,
        "model": model,
        "vision_model": vision,
        "base_url": (os.getenv("ARK_BASE_URL") or DEFAULT_ARK_BASE).rstrip("/"),
        "source": "env" if key else "none",
    }


def _read_runtime() -> Optional[Dict[str, Any]]:
    if not RUNTIME_PATH.exists():
        return None
    try:
        with _runtime_lock:
            raw = RUNTIME_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            return None
        return data
    except (OSError, json.JSONDecodeError):
        return None


def _write_runtime(data: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    with _runtime_lock:
        tmp = RUNTIME_PATH.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(RUNTIME_PATH)


def clear_runtime_settings() -> None:
    with _runtime_lock:
        if RUNTIME_PATH.exists():
            RUNTIME_PATH.unlink()


def get_config() -> Dict[str, Optional[str]]:
    """合并环境变量与本机运行时配置；运行时优先。"""
    base = _env_defaults()
    rt = _read_runtime()
    if not rt:
        return base

    provider = str(rt.get("provider") or "doubao").strip() or "doubao"
    if provider not in PROVIDERS:
        provider = "custom"
    preset = PROVIDERS[provider]

    api_key = (rt.get("api_key") or "").strip() or None
    model = (rt.get("model") or "").strip() or preset["default_model"]
    vision = (rt.get("vision_model") or "").strip() or model
    base_url = (rt.get("base_url") or "").strip() or preset["default_base_url"]

    # 运行时未填 Key 时，同为豆包则回退 .env Key，方便「只改模型」
    if not api_key and provider == "doubao" and base.get("api_key"):
        api_key = base["api_key"]

    return {
        "provider": provider,
        "api_key": api_key,
        "model": model,
        "vision_model": vision,
        "base_url": base_url.rstrip("/"),
        "source": "runtime",
    }


def is_configured() -> bool:
    return bool(get_config().get("api_key"))


def _mask_key(key: Optional[str]) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "••••"
    return f"{key[:3]}••••{key[-4:]}"


def provider_info() -> Dict[str, Any]:
    cfg = get_config()
    pid = cfg.get("provider") or "demo"
    configured = bool(cfg.get("api_key"))
    if not configured:
        return {
            "provider": "demo",
            "provider_label": "演示模式",
            "model": None,
            "configured": False,
            "source": cfg.get("source") or "none",
        }
    meta = PROVIDERS.get(str(pid)) or PROVIDERS["custom"]
    return {
        "provider": pid,
        "provider_label": meta["label"],
        "model": cfg.get("model"),
        "configured": True,
        "source": cfg.get("source") or "env",
    }


def get_public_settings() -> Dict[str, Any]:
    cfg = get_config()
    info = provider_info()
    return {
        "providers": list_providers(),
        "current": {
            "provider": cfg.get("provider") or "doubao",
            "provider_label": info.get("provider_label"),
            "model": cfg.get("model") or "",
            "vision_model": cfg.get("vision_model") or "",
            "base_url": cfg.get("base_url") or "",
            "configured": bool(cfg.get("api_key")),
            "api_key_set": bool(cfg.get("api_key")),
            "api_key_hint": _mask_key(cfg.get("api_key")),
            "source": cfg.get("source") or "none",
        },
        "privacy_note": (
            "API Key 只保存在本机后端（环境变量或 server/data/llm_runtime.json），"
            "不会写入前端仓库；请求由本机发出。文书内容仍会发往你所选的模型服务商。"
        ),
    }


def update_runtime_settings(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    更新本机运行时配置。
    api_key: 省略或 null = 保留原 Key；空字符串 = 清除 Key；非空 = 写入新 Key。
    """
    provider = str(body.get("provider") or "doubao").strip() or "doubao"
    if provider not in PROVIDERS:
        provider = "custom"
    preset = PROVIDERS[provider]

    prev = _read_runtime() or {}
    # 若尚无运行时文件，用当前生效配置作为底（含 .env）
    effective = get_config()

    if "api_key" not in body or body.get("api_key") is None:
        api_key = (prev.get("api_key") or effective.get("api_key") or "") or ""
        if isinstance(api_key, str):
            api_key = api_key.strip()
        else:
            api_key = ""
    else:
        api_key = str(body.get("api_key") or "").strip()

    model = str(body.get("model") or "").strip() or preset["default_model"]
    vision = str(body.get("vision_model") or "").strip() or model
    base_url = (
        str(body.get("base_url") or "").strip() or preset["default_base_url"]
    ).rstrip("/")

    payload = {
        "provider": provider,
        "api_key": api_key,
        "model": model,
        "vision_model": vision,
        "base_url": base_url,
    }
    _write_runtime(payload)
    return get_public_settings()


def build_chat_messages(
    prompt: str,
    history: Optional[List[Dict[str, str]]] = None,
    system_prompt: Optional[str] = None,
    image_data_url: Optional[str] = None,
) -> List[Dict[str, Any]]:
    sys = (system_prompt or DEFAULT_SYSTEM_PROMPT).strip()
    messages: List[Dict[str, Any]] = [{"role": "system", "content": sys}]
    if history:
        for m in history[-16:]:
            role = m.get("role")
            content = (m.get("content") or "").strip()
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})

    user_content: ContentPart
    if image_data_url:
        text = (prompt or "").strip() or "请根据上传的文书照片进行分析。"
        user_content = [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": image_data_url}},
        ]
    else:
        user_content = prompt

    if not messages or messages[-1].get("role") != "user":
        messages.append({"role": "user", "content": user_content})
    else:
        last = messages[-1].get("content")
        if last == prompt and not image_data_url:
            pass
        elif isinstance(last, str) and last == prompt and image_data_url:
            messages[-1] = {"role": "user", "content": user_content}
        elif not any(
            m.get("role") == "user" and m.get("content") == prompt
            for m in messages[-3:]
        ):
            messages.append({"role": "user", "content": user_content})
    return messages


def _data_url(image_base64: str, mime: str = "image/jpeg") -> str:
    raw = image_base64.strip()
    if raw.startswith("data:"):
        return raw
    return f"data:{mime};base64,{raw}"


async def stream_chat(
    prompt: str,
    history: Optional[List[Dict[str, str]]] = None,
    should_cancel=None,
    system_prompt: Optional[str] = None,
    image_data_url: Optional[str] = None,
) -> AsyncIterator[str]:
    """Yield text deltas from OpenAI-compatible chat/completions SSE."""
    cfg = get_config()
    if not cfg["api_key"]:
        raise RuntimeError("未配置 API Key，请在「模型设置」或 server/.env 中填写")

    model = cfg["vision_model"] if image_data_url else cfg["model"]
    url = f"{cfg['base_url']}/chat/completions"
    payload = {
        "model": model,
        "messages": build_chat_messages(
            prompt,
            history,
            system_prompt=system_prompt,
            image_data_url=image_data_url,
        ),
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    label = PROVIDERS.get(str(cfg.get("provider")), {}).get("label") or "模型"

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=300.0)) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode("utf-8", errors="replace")
                # 勿把完整响应（可能含敏感信息）打太长
                raise RuntimeError(f"{label} API {resp.status_code}: {body[:400]}")

            buffer = ""
            async for raw in resp.aiter_text():
                if should_cancel and should_cancel():
                    return
                buffer += raw
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        return
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    text = delta.get("content")
                    if text:
                        yield text


# 兼容旧导入名
stream_doubao = stream_chat


def _parse_review_json(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return {
        "related": False,
        "reason": "审核结果无法解析，请换一张更清晰的文书照片再试",
    }


async def review_document_image(
    image_base64: str,
    *,
    scenario_id: str,
    scenario_name: str,
    expect_desc: str,
    mime: str = "image/jpeg",
) -> Dict[str, Any]:
    """视觉审核：是否为与当前文书模版相关的照片。"""
    cfg = get_config()
    if not cfg["api_key"]:
        return {
            "ok": False,
            "related": False,
            "reason": "未配置 API Key，无法审核图片。请在「模型设置」中填写，或改用粘贴文本。",
        }

    data_url = _data_url(image_base64, mime)
    if scenario_id == "companion":
        system = (
            "你是青柠 App 闲聊场景的图片审核员。"
            "必须只输出一个 JSON 对象，不要 Markdown，不要其它文字。"
            '格式：{"related":true或false,"reason":"给用户看的一句中文说明","what_you_see":"画面里大致是什么"}'
        )
        user_text = f"""当前为桌宠闲聊（id=companion）。期望：{expect_desc}

判定规则：
1. related=true：能看清内容的日常照片、物品、单据、截图、文书等，可供闲聊讨论。
2. related=false：完全空白、严重模糊无法辨认、纯色块、明显恶意/违法内容。
3. 普通自拍、食物、风景若画面清晰，可 related=true。
4. reason 简短可展示。

请审核这张图片。"""
    else:
        system = (
            "你是青柠 App 的图片审核员。只判断用户上传的图片是否为「生活文书相关」照片。"
            "必须只输出一个 JSON 对象，不要 Markdown，不要其它文字。"
            '格式：{"related":true或false,"reason":"给用户看的一句中文说明","what_you_see":"画面里大致是什么"}'
        )
        user_text = f"""当前用户选择的文书模版：「{scenario_name}」（id={scenario_id}）。
本模版期望上传：{expect_desc}

判定规则：
1. related=true：图中主要是纸质/电子合同、协议、通知、清单、账单、表格、公函等文书，或手机拍摄的上述文书。
2. related=false：风景、自拍、美食、截图游戏、表情包、空白、纯广告海报、与文书无关的物品等。
3. 若是文书但明显属于其它模版（例如选了租房却是劳动合同），仍可 related=true，但 reason 里提示「更像××，可切换模版」。
4. reason 必须简短、直接、可展示给用户。

请审核这张图片。"""

    url = f"{cfg['base_url']}/chat/completions"
    payload = {
        "model": cfg["vision_model"],
        "messages": [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
        "stream": False,
        "temperature": 0.1,
    }
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0)) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                body = resp.text[:400]
                return {
                    "ok": False,
                    "related": False,
                    "reason": f"图片审核服务暂时不可用（{resp.status_code}）。可稍后再试或改用粘贴文本。",
                    "detail": body,
                }
            obj = resp.json()
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "related": False,
            "reason": f"图片审核失败：{exc}",
        }

    choices = obj.get("choices") or []
    content = ""
    if choices:
        content = (choices[0].get("message") or {}).get("content") or ""
    parsed = _parse_review_json(content)
    related = bool(parsed.get("related"))
    reason = str(parsed.get("reason") or "").strip()
    if related:
        reason = reason or (
            "已通过审核，可以发送。"
            if scenario_id == "companion"
            else "已通过审核，可以发送分析。"
        )
    else:
        reason = reason or (
            "这张图无法用于闲聊（空白或无法辨认），请换一张更清晰的照片。"
            if scenario_id == "companion"
            else (
                f"这张图看起来不是「{scenario_name}」相关的文书照片。"
                "请上传合同/协议/通知等文书的照片或扫描件。"
            )
        )
    return {
        "ok": related,
        "related": related,
        "reason": reason,
        "what_you_see": parsed.get("what_you_see"),
    }

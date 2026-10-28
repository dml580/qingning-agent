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
import time
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
    "你是「青柠」生活助理 Agent。回答准确、简洁、有条理。"
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


class _ApiError(RuntimeError):
    """HTTP 层错误，保留状态码与原始响应体，便于按需降级重试。"""

    def __init__(self, status: int, message: str, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _apply_usage(metrics: Optional[Dict[str, Any]], usage: Any) -> None:
    """把 OpenAI 兼容响应里的 usage 回填到 metrics，缺失字段保持 None。"""
    if metrics is None or not isinstance(usage, dict):
        return
    for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = usage.get(field)
        if isinstance(value, int):
            metrics[field] = value


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
    metrics: Optional[Dict[str, Any]] = None,
) -> AsyncIterator[str]:
    """Yield text deltas from OpenAI-compatible chat/completions SSE.

    传入可变 dict 作为 metrics 时，会回填 usage / ttft_ms / total_ms，用于 Token 监控。
    """
    cfg = get_config()
    if not cfg["api_key"]:
        raise RuntimeError("未配置 API Key，请在「模型设置」或 server/.env 中填写")

    model = cfg["vision_model"] if image_data_url else cfg["model"]
    url = f"{cfg['base_url']}/chat/completions"
    base_payload: Dict[str, Any] = {
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
    started = time.perf_counter()
    if metrics is not None:
        metrics.setdefault("provider", str(cfg.get("provider") or ""))
        metrics.setdefault("model", model)
        metrics["kind"] = "vision" if image_data_url else "chat"

    async def run(payload: Dict[str, Any]) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=300.0)) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode("utf-8", errors="replace")
                    # 勿把完整响应（可能含敏感信息）打太长
                    raise _ApiError(
                        resp.status_code,
                        f"{label} API {resp.status_code}: {body[:400]}",
                        body,
                    )

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
                        if metrics is not None:
                            _apply_usage(metrics, obj.get("usage"))
                        choices = obj.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        text = delta.get("content")
                        if text:
                            if metrics is not None and metrics.get("ttft_ms") is None:
                                metrics["ttft_ms"] = _elapsed_ms(started)
                            yield text

    try:
        with_usage = dict(base_payload, stream_options={"include_usage": True})
        try:
            async for text in run(with_usage):
                yield text
        except _ApiError as exc:
            # 少数兼容实现不认 stream_options，去掉后重试一次
            if exc.status != 400 or "stream_options" not in exc.body.lower():
                raise
            if metrics is not None:
                metrics["usage_supported"] = False
            async for text in run(base_payload):
                yield text
    finally:
        if metrics is not None:
            metrics["total_ms"] = _elapsed_ms(started)



# 兼容旧导入名
stream_doubao = stream_chat


def _tool_calls_from_message(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = message.get("tool_calls") or []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        fn = item.get("function") or {}
        name = (fn.get("name") or item.get("name") or "").strip()
        if not name:
            continue
        out.append(
            {
                "id": str(item.get("id") or f"call_{len(out)}"),
                "name": name,
                "arguments": fn.get("arguments") if "arguments" in fn else item.get("arguments"),
            }
        )
    legacy = message.get("function_call")
    if not out and isinstance(legacy, dict):
        name = (legacy.get("name") or "").strip()
        if name:
            out.append(
                {
                    "id": "call_legacy",
                    "name": name,
                    "arguments": legacy.get("arguments"),
                }
            )
    return out


async def complete_with_tools(
    prompt: str,
    *,
    history: Optional[List[Dict[str, str]]] = None,
    system_prompt: Optional[str] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    should_cancel=None,
) -> Dict[str, Any]:
    """
    一轮非流式补全，让模型选择 tools。
    返回 {content, tool_calls:[{id,name,arguments}], unsupported}。
    接口不支持 tools 时 unsupported=True，调用方改走本地启发式。
    """
    cfg = get_config()
    if not cfg["api_key"]:
        return {"content": "", "tool_calls": [], "unsupported": True}

    url = f"{cfg['base_url']}/chat/completions"
    payload: Dict[str, Any] = {
        "model": cfg["model"],
        "messages": build_chat_messages(
            prompt, history, system_prompt=system_prompt
        ),
        "stream": False,
        "tool_choice": "auto",
        "tools": tools or [],
    }
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    label = PROVIDERS.get(str(cfg.get("provider")), {}).get("label") or "模型"
    started = time.perf_counter()

    async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, read=60.0)) as client:
        resp = await client.post(url, headers=headers, json=payload)
        if should_cancel and should_cancel():
            return {"content": "", "tool_calls": [], "unsupported": False}
        if resp.status_code >= 400:
            body = resp.text[:400]
            lowered = body.lower()
            if resp.status_code in (400, 404, 422) or "tool" in lowered:
                return {
                    "content": "",
                    "tool_calls": [],
                    "unsupported": True,
                    "error": f"{label} API {resp.status_code}: {body}",
                }
            raise RuntimeError(f"{label} API {resp.status_code}: {body}")
        data = resp.json()
    choices = data.get("choices") or []
    message = (choices[0].get("message") if choices else {}) or {}
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    return {
        "content": message.get("content") or "",
        "tool_calls": _tool_calls_from_message(message),
        "unsupported": False,
        "usage": usage,
        "elapsed_ms": _elapsed_ms(started),
        "provider": str(cfg.get("provider") or ""),
        "model": str(cfg.get("model") or ""),
    }


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


def _parse_json_object(text: str, fallback: Dict[str, Any]) -> Dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return fallback
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else fallback
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return fallback
    try:
        data = json.loads(m.group(0))
        return data if isinstance(data, dict) else fallback
    except json.JSONDecodeError:
        return fallback


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
            "你是「生活助理 Agent」闲聊场景的图片审核员。"
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
            "你是「生活助理 Agent」的图片审核员。只判断用户上传的图片是否为「生活助理相关」照片。"
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


async def extract_document_image_ocr(
    image_base64: str,
    *,
    mime: str = "image/jpeg",
) -> Dict[str, Any]:
    """
    对生活文书图片做轻量结构化 OCR。
    重点支持：
    - 药盒说明书 / 用药提醒相关
    - 水电燃气 / 物业等费用账单
    - 其它通用文书
    """
    cfg = get_config()
    if not cfg["api_key"]:
        return {
            "ok": False,
            "doc_type": "unknown",
            "reason": "未配置 API Key，暂时无法识别图片内容。",
        }

    data_url = _data_url(image_base64, mime)
    system = (
        "你是「青柠」生活助理 Agent 的 OCR 与文书归档助手。"
        "你必须只输出一个 JSON 对象，不要 Markdown，不要解释，不要代码块。"
    )
    user_text = """请识别这张生活文书图片，并按下面 JSON 输出：
{
  "doc_type":"medicine_guide|utility_bill|generic_document|unknown",
  "title":"简短标题",
  "summary":"一句话摘要",
  "confidence":"high|medium|low",
  "key_points":["最多6条中文要点"],
  "medicine":{
    "name":"药品或用品名",
    "spec":"规格",
    "expiry_date":"YYYY-MM-DD 或原文",
    "usage":"用法或注意事项",
    "manufacturer":"厂家"
  },
  "bill":{
    "bill_type":"水费|电费|燃气费|物业费|话费|其它",
    "account":"户号/客户号",
    "amount":"金额原文",
    "due_date":"YYYY-MM-DD 或原文",
    "billing_period":"账期",
    "provider":"机构/公司"
  },
  "raw_excerpt":"摘出最关键的原文片段，控制在200字内"
}

规则：
1. 药盒、药品说明书、药店标签、疫苗单据、体检/复诊单等偏健康提醒材料，doc_type=medicine_guide。
2. 水电燃气、物业、宽带、话费、缴费通知、账单截图等，doc_type=utility_bill。
3. 其它合同、通知、清单、公函、票据等，doc_type=generic_document。
4. 完全看不清或无关图片，doc_type=unknown。
5. 看不清的字段留空，不要编造。
6. 日期尽量标准化为 YYYY-MM-DD；做不到就保留原文。
7. key_points 用白话，方便后续直接给用户看。
"""
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
    fallback = {
        "doc_type": "unknown",
        "title": "",
        "summary": "",
        "confidence": "low",
        "key_points": [],
        "medicine": {},
        "bill": {},
        "raw_excerpt": "",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(50.0)) as client:
            resp = await client.post(
                f"{cfg['base_url']}/chat/completions",
                headers=headers,
                json=payload,
            )
            if resp.status_code >= 400:
                return {
                    "ok": False,
                    "doc_type": "unknown",
                    "reason": f"OCR 服务暂时不可用（{resp.status_code}）",
                    "detail": resp.text[:400],
                }
            obj = resp.json()
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "doc_type": "unknown",
            "reason": f"OCR 识别失败：{exc}",
        }

    choices = obj.get("choices") or []
    content = ""
    if choices:
        content = (choices[0].get("message") or {}).get("content") or ""
    parsed = _parse_json_object(content, fallback)
    doc_type = str(parsed.get("doc_type") or "unknown").strip() or "unknown"
    if doc_type not in {"medicine_guide", "utility_bill", "generic_document", "unknown"}:
        doc_type = "unknown"
    key_points = parsed.get("key_points") or []
    if not isinstance(key_points, list):
        key_points = []
    return {
        "ok": doc_type != "unknown",
        "doc_type": doc_type,
        "title": str(parsed.get("title") or "").strip(),
        "summary": str(parsed.get("summary") or "").strip(),
        "confidence": str(parsed.get("confidence") or "low").strip() or "low",
        "key_points": [str(x).strip() for x in key_points if str(x).strip()][:6],
        "medicine": parsed.get("medicine") if isinstance(parsed.get("medicine"), dict) else {},
        "bill": parsed.get("bill") if isinstance(parsed.get("bill"), dict) else {},
        "raw_excerpt": str(parsed.get("raw_excerpt") or "").strip()[:200],
    }

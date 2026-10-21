"""
豆包（火山方舟）流式对话 + 文书图片审核。

环境变量：
  ARK_API_KEY        必填才走真模型，否则回退演示文案
  ARK_MODEL          推理接入点 ID 或模型名
  ARK_VISION_MODEL   可选，图片审核/读图专用；默认与 ARK_MODEL 相同
  ARK_BASE_URL       默认 https://ark.cn-beijing.volces.com/api/v3
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, AsyncIterator, Dict, List, Optional, Union

import httpx

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_MODEL = "doubao-seed-2-0-lite-260428"

DEFAULT_SYSTEM_PROMPT = (
    "你是「青柠」生活文书助手。回答准确、简洁、有条理。"
    "用中文回复，除非用户要求其他语言。"
)

ContentPart = Union[str, List[Dict[str, Any]]]


def get_config() -> Dict[str, Optional[str]]:
    model = (os.getenv("ARK_MODEL") or DEFAULT_MODEL).strip()
    vision = (os.getenv("ARK_VISION_MODEL") or model).strip()
    return {
        "api_key": (os.getenv("ARK_API_KEY") or "").strip() or None,
        "model": model,
        "vision_model": vision,
        "base_url": (os.getenv("ARK_BASE_URL") or DEFAULT_BASE).rstrip("/"),
    }


def is_configured() -> bool:
    return bool(get_config()["api_key"])


def provider_info() -> Dict[str, Any]:
    cfg = get_config()
    return {
        "provider": "doubao" if cfg["api_key"] else "demo",
        "model": cfg["model"] if cfg["api_key"] else None,
        "configured": bool(cfg["api_key"]),
    }


def _data_url(image_base64: str, mime: str = "image/jpeg") -> str:
    raw = image_base64.strip()
    if raw.startswith("data:"):
        return raw
    return f"data:{mime};base64,{raw}"


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
        # Replace last user if identical text-only; otherwise append
        last = messages[-1].get("content")
        if last == prompt and not image_data_url:
            pass
        elif (
            isinstance(last, str)
            and last == prompt
            and image_data_url
        ):
            messages[-1] = {"role": "user", "content": user_content}
        elif not any(
            m.get("role") == "user" and m.get("content") == prompt for m in messages[-3:]
        ):
            messages.append({"role": "user", "content": user_content})
    return messages


async def stream_doubao(
    prompt: str,
    history: Optional[List[Dict[str, str]]] = None,
    should_cancel=None,
    system_prompt: Optional[str] = None,
    image_data_url: Optional[str] = None,
) -> AsyncIterator[str]:
    """
    Yield text deltas from Ark chat/completions SSE.
    should_cancel: optional callable returning bool.
    """
    cfg = get_config()
    if not cfg["api_key"]:
        raise RuntimeError("ARK_API_KEY 未配置")

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

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=300.0)) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode("utf-8", errors="replace")
                raise RuntimeError(f"豆包 API {resp.status_code}: {body[:500]}")

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
    return {"related": False, "reason": "审核结果无法解析，请换一张更清晰的文书照片再试"}


async def review_document_image(
    image_base64: str,
    *,
    scenario_id: str,
    scenario_name: str,
    expect_desc: str,
    mime: str = "image/jpeg",
) -> Dict[str, Any]:
    """
    视觉审核：是否为与当前文书模版相关的照片。
    返回 { ok, related, reason, what_you_see? }
    """
    cfg = get_config()
    if not cfg["api_key"]:
        return {
            "ok": False,
            "related": False,
            "reason": "未配置豆包密钥，无法审核图片。请先配置 ARK_API_KEY，或改用粘贴文本。",
        }

    data_url = _data_url(image_base64, mime)
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
        reason = reason or "已通过审核，可以发送分析。"
    else:
        reason = reason or (
            f"这张图看起来不是「{scenario_name}」相关的文书照片。"
            "请上传合同/协议/通知等文书的照片或扫描件。"
        )
    return {
        "ok": related,
        "related": related,
        "reason": reason,
        "what_you_see": parsed.get("what_you_see"),
    }

"""项目内部 Skill 契约与注册表。

这里不对接任何外部平台。Skill 只负责把名称、用途、输入契约、适用模块和
执行器放在同一个可校验对象里，并按需导出 OpenAI function-calling 描述。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Mapping

SkillHandler = Callable[[Dict[str, Any], "SkillContext"], Awaitable[Dict[str, Any]]]


@dataclass(frozen=True)
class SkillContext:
    scenario_id: str = "general"
    user_text: str = ""


@dataclass(frozen=True)
class InternalSkill:
    name: str
    label: str
    description: str
    parameters: Dict[str, Any]
    modules: frozenset[str]
    handler: SkillHandler
    planner_hint: str
    side_effect: str = "read"
    timeout_seconds: float = 20.0
    confirmation_actions: frozenset[str] = frozenset()

    def as_openai_tool(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class SkillRegistry:
    def __init__(self, skills: Iterable[InternalSkill]):
        ordered = list(skills)
        self._skills: Mapping[str, InternalSkill] = {skill.name: skill for skill in ordered}
        if len(self._skills) != len(ordered):
            raise ValueError("内部 Skill 名称不能重复")
        for skill in ordered:
            if not skill.name or not skill.label or not skill.description:
                raise ValueError("内部 Skill 必须包含名称、中文标签和用途说明")
            if skill.parameters.get("type") != "object":
                raise ValueError(f"Skill {skill.name} 的参数契约必须是 object")
            if skill.side_effect not in {"read", "write", "external_write"}:
                raise ValueError(f"Skill {skill.name} 的副作用等级不合法")

    def get(self, name: str) -> InternalSkill | None:
        return self._skills.get(name)

    def names_for_module(self, module_id: str) -> frozenset[str]:
        return frozenset(
            skill.name for skill in self._skills.values() if module_id in skill.modules
        )

    def openai_tools(self) -> List[Dict[str, Any]]:
        return [skill.as_openai_tool() for skill in self._skills.values()]

    def labels(self) -> Dict[str, str]:
        return {skill.name: skill.label for skill in self._skills.values()}

    def planner_lines(self, module_id: str = "docs") -> List[str]:
        return [
            f"- {skill.name}：{skill.planner_hint}"
            for skill in self._skills.values()
            if module_id in skill.modules
        ]

    async def execute(
        self, name: str, arguments: Dict[str, Any], context: SkillContext
    ) -> Dict[str, Any]:
        skill = self.get(name)
        if not skill:
            return {"ok": False, "error": f"未知内部 Skill：{name}"}
        error = self._validate(arguments, skill.parameters)
        if error:
            return {"ok": False, "code": "invalid_arguments", "error": error}
        action = str(arguments.get("action") or "")
        if action in skill.confirmation_actions:
            intent_words = ("同步", "写入日历", "创建日程", "新建日程", "确认", "删除待办", "删除任务")
            if not any(word in context.user_text for word in intent_words):
                return {
                    "ok": False,
                    "code": "confirmation_required",
                    "error": "该操作会写入外部日历或删除数据，请在确认卡片中批准后再执行",
                }
        try:
            started = time.perf_counter()
            result = await asyncio.wait_for(
                skill.handler(arguments, context), timeout=skill.timeout_seconds
            )
        except asyncio.TimeoutError:
            return {"ok": False, "code": "skill_timeout", "error": "能力执行超时，请稍后重试"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "code": "skill_failed", "error": f"能力执行失败：{exc}"}
        if not isinstance(result, dict):
            return {"ok": False, "code": "invalid_result", "error": "能力返回格式不正确"}
        result.setdefault("ok", False)
        result.setdefault("duration_ms", round((time.perf_counter() - started) * 1000))
        return result

    @staticmethod
    def _validate(arguments: Any, schema: Dict[str, Any]) -> str:
        if not isinstance(arguments, dict):
            return "参数必须是对象"
        properties = schema.get("properties") or {}
        for key in schema.get("required") or []:
            if key not in arguments or arguments[key] in (None, ""):
                return f"缺少必填参数：{key}"
        for key, value in arguments.items():
            rule = properties.get(key)
            if not rule or value is None:
                continue
            expected = rule.get("type")
            valid = (
                expected == "string" and isinstance(value, str)
                or expected == "integer" and isinstance(value, int) and not isinstance(value, bool)
                or expected == "boolean" and isinstance(value, bool)
                or expected == "object" and isinstance(value, dict)
                or expected == "array" and isinstance(value, list)
                or expected is None
            )
            if not valid:
                return f"参数 {key} 类型不正确，应为 {expected}"
            if "enum" in rule and value not in rule["enum"]:
                return f"参数 {key} 取值不合法"
        return ""

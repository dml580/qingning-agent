"""
青柠 · 产品目录：大模块 → 场景模版 → 系统提示词。

当前上线：生活文书（docs）
预留：生活提醒（reminders）— 用药 / 宠物等，前端可展示「即将开放」
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

DISCLAIMER = (
    "【重要】你只做信息梳理与风险提示，不构成法律意见或专业建议。"
    "不得编造原文没有的条款、数字或义务。"
    "不确定就写「原文未写清」，并列出建议向对方确认的问题。"
)

OUTPUT_FORMAT = """
请严格按以下结构用中文输出（可用 Markdown）：

## 一句话摘要
（用白话说明这是什么文件、核心约定）

## 关键信息
用列表列出：主体、金额/费用、期限、付款方式、违约/解除、其他关键点。
每一项尽量附「原文摘录：……」；没有则写「原文未写清」。

## 风险点
按严重程度列出 3～8 条。每条格式：
- 【风险】……
  - 依据：原文摘录……
  - 可能影响：……

## 建议确认
列出签约/维权前应追问对方的问题（3～6 个）。

## 沟通话术（可选）
若用户可能需要协商，给 1～2 段简短、礼貌的话术草稿。

## 免责
一句话提醒：非正式法律意见，重要决定请咨询专业人士或当地主管部门。
""".strip()

BASE_DOCS = f"""你是「青柠」生活文书助手，帮助普通人读懂合同与通知类文本。
{DISCLAIMER}

工作方式：
1. 用户会粘贴合同/协议/通知全文或片段，也可能上传文书照片；若有图，请阅读图中文字与版式，与文本一并分析。
2. 先判断材料是否像当前场景；若明显属于其他场景，在摘要开头用一句话提示「更像××协议，可切换对应模版后再分析」，仍尽量完成本次分析。
3. 只依据用户提供的文本与图片；禁止用常识补造具体条款内容。图中看不清的写「图片不清晰/原文未写清」。

{OUTPUT_FORMAT}
"""

SCENARIO_EXTRA: Dict[str, str] = {
    "general": """
【当前模版：通用合同要点】
额外关注：付款节点与金额、有效期、违约责任、解除/退订方式、自动续约、管辖与争议解决。
若文本很短（如通知），可侧重：截止时间、金额、地点、必须办理的事项。
""".strip(),
    "rental": """
【当前模版：租房合同】
额外关注：押金数额与退还条件、租金与付款日、租期与续租、转租、提前退租违约金、维修义务、涨租条款、入住交接与物品清单。
可在「建议确认/话术」中提示：入住拍照取证清单（水电表、墙面、家电）；退租时按条款列可能扣款项，勿承诺「一定能退多少」。
""".strip(),
    "labor": """
【当前模版：劳动合同 / Offer】
额外关注：岗位与工作地、薪资结构（底薪/绩效/补贴）、发薪日、试用期时长与薪资、五险一金、竞业限制与补偿、培训服务期与违约金、解除条件、加班与调休。
若只有 Offer 无正式合同，标明哪些仍待劳动合同确认。
""".strip(),
    "training": """
【当前模版：培训 / 辅导班 / 线上课协议】
重点排查「卖课后再签高价违约金/绑贷」类套路。额外关注：
总价与分期/教育贷是否 bundling、退费与冷静期、开课后扣费规则、旷课/请假是否算违约、违约金是否畸高、课时数与有效期、师资更换、转班停课、自动续费与搭售教材设备、投诉渠道。
风险点请单独标出「高额违约金」「退费困难」「贷款绑定」若原文涉及。
话术偏向：协商退费/解除、要求出示完整费用与贷款合同。
""".strip(),
    "credit": """
【当前模版：分期 / 贷款 / 信用卡协议】
额外关注：年化/日利率或手续费表述、实际总成本、还款日与最低还款、逾期罚息与违约金、提前还款是否收费、自动扣款与账户授权、权益变更与单方通知、争议解决。
对「零利息」等营销话术，对照原文费用条款指出是否另有手续费。
数字务必来自原文；算不清就写未写清，不要自行换算后假装原文写明。
""".strip(),
}


MODULES: List[Dict[str, Any]] = [
    {
        "id": "docs",
        "name": "生活文书",
        "name_en": "Docs",
        "blurb": "合同与通知要点提取、风险提示",
        "status": "available",
        "scenarios": [
            {
                "id": "general",
                "name": "通用要点",
                "blurb": "付款、期限、违约、解除等通用条款",
                "placeholder": "粘贴合同/通知全文，或点「上传图片」交文书照片…",
            },
            {
                "id": "rental",
                "name": "租房合同",
                "blurb": "押金、违约、涨租、退租与入住取证",
                "placeholder": "粘贴租房合同，或上传租约/交割清单照片…",
            },
            {
                "id": "labor",
                "name": "劳动 / Offer",
                "blurb": "薪资、试用、竞业、违约金、五险一金",
                "placeholder": "粘贴劳动合同/Offer，或上传相关文书照片…",
            },
            {
                "id": "training",
                "name": "培训 / 辅导课",
                "blurb": "退费、高额违约金、绑贷与课时陷阱",
                "placeholder": "粘贴培训协议，或上传报名/退费相关文书照片…",
            },
            {
                "id": "credit",
                "name": "分期 / 贷款",
                "blurb": "利率、逾期、提前还款、自动扣款",
                "placeholder": "粘贴分期/贷款协议，或上传相关文书照片…",
            },
        ],
    },
    {
        "id": "reminders",
        "name": "生活提醒",
        "name_en": "Reminders",
        "blurb": "用药、宠物等家庭提醒（即将开放）",
        "status": "coming_soon",
        "scenarios": [
            {
                "id": "medicine",
                "name": "家庭药箱",
                "blurb": "说明书摘要、过期提醒（规划中）",
                "placeholder": "",
            },
            {
                "id": "pet",
                "name": "宠物补给",
                "blurb": "粮耗估算与复购提醒（规划中）",
                "placeholder": "",
            },
        ],
    },
]


def list_catalog() -> Dict[str, Any]:
    return {
        "modules": [
            {
                "id": m["id"],
                "name": m["name"],
                "name_en": m["name_en"],
                "blurb": m["blurb"],
                "status": m["status"],
                "scenarios": [
                    {
                        "id": s["id"],
                        "name": s["name"],
                        "blurb": s["blurb"],
                        "placeholder": s.get("placeholder") or "",
                    }
                    for s in m["scenarios"]
                ],
            }
            for m in MODULES
        ]
    }


def get_module(module_id: str) -> Optional[Dict[str, Any]]:
    for m in MODULES:
        if m["id"] == module_id:
            return m
    return None


def get_scenario(module_id: str, scenario_id: str) -> Optional[Dict[str, Any]]:
    mod = get_module(module_id)
    if not mod:
        return None
    for s in mod["scenarios"]:
        if s["id"] == scenario_id:
            return s
    return None


def resolve_system_prompt(module_id: str, scenario_id: str) -> str:
    """Return system prompt for generation. Falls back to docs/general."""
    mod = get_module(module_id) or get_module("docs")
    assert mod is not None
    if mod["id"] != "docs" or mod.get("status") != "available":
        # Future modules: safe fallback until implemented
        module_id, scenario_id = "docs", "general"
        mod = get_module("docs")
    scen = get_scenario(mod["id"], scenario_id) or get_scenario("docs", "general")
    assert scen is not None
    extra = SCENARIO_EXTRA.get(scen["id"], SCENARIO_EXTRA["general"])
    return f"{BASE_DOCS}\n\n{extra}"


def default_ids() -> Dict[str, str]:
    return {"module_id": "docs", "scenario_id": "general"}


# 上传审核：各模版期望看到的文书类型（给视觉模型）
SCENARIO_IMAGE_EXPECT: Dict[str, str] = {
    "general": "合同、协议、通知、账单、表格、公函等文书的照片或扫描件（含手机拍纸质件）",
    "rental": "租房合同、租约、房屋交割/验房清单、押金条、房东通知等租房相关文书",
    "labor": "劳动合同、聘用协议、Offer/录用通知、离职证明、竞业协议等劳动相关文书",
    "training": "培训/辅导班/线上课协议、报名须知、退费规则、教育分期相关文书",
    "credit": "分期、贷款、信用卡、借款合同、还款计划、费用说明等金融相关文书",
}


def scenario_image_expect(scenario_id: str) -> str:
    return SCENARIO_IMAGE_EXPECT.get(scenario_id, SCENARIO_IMAGE_EXPECT["general"])

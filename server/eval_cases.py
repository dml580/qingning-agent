"""青柠 Agent 的离线脱敏评测样例。"""

from typing import Any, Dict, List, Tuple


SelectionCase = Tuple[str, str, str, str, set, set]


SELECTION_CASES: List[SelectionCase] = [
    ("健康提醒", "明天下午3点提醒我体检", "docs", "general", {"manage_reminder"}, set()),
    ("宠物提醒", "11月3号提醒我买猫粮", "docs", "general", {"manage_reminder"}, set()),
    ("查询提醒", "还有哪些提醒快到期", "docs", "general", {"manage_reminder"}, set()),
    ("完成提醒", "猫粮买过了，帮我勾掉", "docs", "general", {"manage_reminder"}, set()),
    ("同步提醒", "把体检提醒同步到日历", "docs", "general", {"manage_reminder"}, set()),
    ("新增待办", "新增待办：周五交周报", "docs", "general", {"manage_todo"}, set()),
    ("查看待办", "查看我的任务清单", "docs", "general", {"manage_todo"}, set()),
    ("完成待办", "任务完成：整理发票", "docs", "general", {"manage_todo"}, set()),
    ("删除待办", "删除待办：旧的采购任务", "docs", "general", {"manage_todo"}, set()),
    ("日历状态", "日历现在是否配置好", "docs", "general", {"manage_calendar"}, set()),
    ("创建日程", "在日历创建明天下午3点体检", "docs", "general", {"manage_calendar"}, set()),
    ("查看记忆", "你记得什么", "docs", "general", {"manage_memory"}, set()),
    ("设置偏好", "记住我的偏好是少油少盐", "docs", "general", {"manage_memory"}, set()),
    ("当前时间", "现在几点了", "docs", "general", {"get_current_time"}, set()),
    ("当前日期", "今天几号星期几", "docs", "general", {"get_current_time"}, set()),
    ("天气", "北京明天天气冷不冷", "docs", "general", {"get_weather"}, set()),
    ("带伞", "杭州今天要带伞吗", "docs", "general", {"get_weather"}, set()),
    ("实时搜索", "帮我搜索最新的公积金政策", "docs", "general", {"web_search"}, set()),
    ("办事搜索", "查一下上海居住证怎么办理", "docs", "general", {"web_search"}, set()),
    ("组合天气提醒", "查一下北京天气，明天下午3点提醒我带伞", "docs", "general", {"web_search", "get_weather", "manage_reminder"}, set()),
    ("租赁文档", "房屋租赁合同约定月租5000元，押金10000元，租期一年，提前退租支付一个月租金。", "docs", "rental", {"extract_document"}, set()),
    ("劳动文档", "劳动合同约定试用期3个月，月薪20000元，每月15日发放，离职提前30日通知。", "docs", "labor", {"extract_document"}, set()),
    ("贷款文档", "贷款协议本金50000元，年化利率12%，每月10日还款，逾期按日万分之五计收罚息。", "docs", "credit", {"extract_document"}, set()),
    ("长通知", "通知：本次培训费用共计12800元，报名后7日内可申请退款，开课后不再退费。" * 3, "docs", "training", {"extract_document"}, set()),
    ("闲聊不选工具", "你好，今天心情不错", "docs", "general", set(), {"manage_reminder", "manage_calendar", "extract_document"}),
    ("空白输入", "   ", "docs", "general", set(), {"manage_reminder", "web_search", "extract_document"}),
    ("模糊日期提醒", "过几天提醒我复诊", "docs", "general", {"manage_reminder"}, set()),
    ("错误日期仍路由提醒", "2月30号提醒我复诊", "docs", "general", {"manage_reminder"}, set()),
    ("聊天模块提醒", "明天提醒我体检", "chat", "general", {"manage_reminder"}, set()),
    ("聊天模块禁用文档", "甲方乙方签订租赁合同，租金5000元，押金10000元。", "chat", "rental", set(), {"extract_document"}),
]


RAG_CASES: List[Dict[str, Any]] = [
    {"label": "租赁·押金", "scenario": "rental", "query": "押金何时退", "terms": {"押金", "7个工作日"}, "doc": "脱敏租赁合同。月租6500元，押金13000元。租期届满且无违约、房屋无损坏，出租方应在7个工作日内无息退还押金。提前退租须提前30日通知并支付一个月租金。"},
    {"label": "劳动·竞业", "scenario": "labor", "query": "竞业多久补偿多少", "terms": {"竞业", "6000元"}, "doc": "脱敏劳动合同。试用期3个月，月薪20000元。离职后竞业限制12个月，公司按月支付竞业补偿金6000元。劳动者正常离职应提前30日书面通知。"},
    {"label": "信贷·罚息", "scenario": "credit", "query": "逾期罚息和提前还款", "terms": {"万分之五", "提前还款"}, "doc": "脱敏贷款协议。本金50000元，固定年化利率12%。逾期之日起按日利率万分之五计收罚息。允许提前还款，但需支付剩余本金2%的违约金。"},
    {"label": "培训·退费", "scenario": "training", "query": "什么时间可以退款", "terms": {"7日", "退款"}, "doc": "脱敏培训协议。课程费用12800元，共80课时。付款后7日内且未开课可申请全额退款；开课后按已消耗课时扣费，超过20课时不再退款。"},
    {"label": "账单·缴费", "scenario": "general", "query": "应缴金额和截止日期", "terms": {"368.50元", "11月15日"}, "doc": "脱敏能源账单。账期为2026年10月，应缴金额368.50元，缴费截止日期为2026年11月15日。逾期每日加收欠费金额0.03%的违约金。"},
    {"label": "医疗·复诊", "scenario": "general", "query": "什么时候复诊", "terms": {"复诊", "11月6日"}, "doc": "脱敏门诊记录。患者姓名与证件号已移除。医嘱：每日晚饭后服药一次，连续7天；2026年11月6日上午复诊，如出现持续高热应提前就医。"},
    {"label": "保险·等待期", "scenario": "general", "query": "等待期与免赔额", "terms": {"等待期", "10000元"}, "doc": "脱敏医疗保险条款。疾病住院等待期90日，意外伤害无等待期。年度免赔额10000元，超过免赔额部分按80%比例赔付。"},
    {"label": "物业·维修", "scenario": "general", "query": "电梯维修什么时候进行", "terms": {"电梯", "11月2日"}, "doc": "脱敏物业通知。2号楼电梯将于2026年11月2日09:00至17:00停运检修。高层住户如需帮助，可提前一天联系物业前台。"},
    {"label": "网购·退货", "scenario": "general", "query": "退货时限和运费", "terms": {"7日", "运费"}, "doc": "脱敏购物订单条款。商品签收后7日内可无理由退货，商品须保持完好。质量问题退货运费由商家承担，个人原因退货运费由买家承担。"},
    {"label": "健身·有效期", "scenario": "training", "query": "会员有效期和转卡费", "terms": {"有效期", "300元"}, "doc": "脱敏健身会员协议。年卡有效期自2026年11月1日至2027年10月31日。有效期内可转卡一次，转卡手续费300元，停卡最多30日。"},
    {"label": "装修·付款", "scenario": "general", "query": "尾款何时支付", "terms": {"尾款", "验收"}, "doc": "脱敏装修合同。合同总价120000元，开工支付30%，水电验收后支付40%，竣工验收合格后7日内支付尾款30%。质保期为24个月。"},
    {"label": "订阅·续费", "scenario": "general", "query": "如何取消自动续费", "terms": {"自动续费", "24小时"}, "doc": "脱敏软件订阅协议。月费68元，默认自动续费。用户可在下个扣费日前至少24小时关闭自动续费，关闭后当前订阅周期权益不受影响。"},
]

_REDACTED_CONTEXT = (
    "本文档中的姓名、手机号、证件号、账号、地址和机构名称均已替换或删除，仅保留评测所需条款。"
    "双方应妥善保管本文件，发生争议时先协商处理；协商不成的，按文档约定渠道解决。"
    "除正文明确列出的金额、日期、期限和责任外，不应推断其他未写明事项。"
)
for _case in RAG_CASES:
    _case["doc"] = f"{_case['doc']} {_REDACTED_CONTEXT}"
    while len(_case["doc"]) < 220:
        _case["doc"] += " 本评测文档已完成隐私脱敏，未出现的事实应回答原文未写清。"

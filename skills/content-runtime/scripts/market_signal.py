#!/usr/bin/env python3
"""Strict TikOmni market intelligence for AIFIOS topic decisions.

Topic selection is intentionally live-only: no cache, local hit-library, or
LLM inference can substitute for a missing TikOmni response. The module also
owns immutable research snapshots that later content generation can verify.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import statistics
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse


# Keep a wider evidence pool for within-batch percentiles and conservative hit
# scoring. The desktop still presents only the top three rows per platform.
TOPIC_SAMPLES_PER_PLATFORM = 10
# The commercial gate requires at least one independently browseable public
# example from every mandatory platform. More samples improve the comparison,
# but a source returning only an empty result collection is never delivery-ready.
REQUIRED_SAMPLES_PER_PLATFORM = 1
DEFAULT_THEME_CHOICE_COUNT = 6
THEME_CHOICES = "ABCDEF"
DEFAULT_TOPIC_QUERY_LIMIT = 3
DEFAULT_WEEKLY_QUERY_LIMIT = 6
# Each source begins at the same time and gets this shared, per-platform
# deadline. The adapter's subprocess timeout is shorter, so production calls
# normally finish before this guard has to mark a worker unavailable.
# TikOmni's real endpoints regularly take 10-14s, and xiaohongshu cold-starts
# can exceed 40s. A short request timeout made every concurrent platform fetch
# time out. Keep the request timeout well above observed latency and the shared
# deadline above that.
DEFAULT_PLATFORM_FETCH_TIMEOUT_SECONDS = 55.0
DEFAULT_PLATFORM_REQUEST_TIMEOUT_MS = 50_000
DEFAULT_TRANSIENT_PLATFORM_RETRY_LIMIT = 1
TRANSIENT_PLATFORM_CHECK_CODES = frozenset({
    "tikomni_platform_unavailable",
    "tikomni_platform_request_failed",
    "tikomni_platform_timeout",
    "tikomni_platform_worker_failed",
})
MARKET_SNAPSHOT_SCHEMA_VERSION = 4

# The topic gate supports exactly the product's three primary platform lanes.
# A run may select any non-empty subset; each selected lane is researched and
# admitted independently, without a local-data fallback.
DEFAULT_MARKET_PLATFORMS = ("wechat_mp", "xiaohongshu", "wechat_channels")
MARKET_PLATFORM_ALIASES = {
    "wechat_mp": "wechat_mp",
    "wechat": "wechat_mp",
    "mp.weixin.qq.com": "wechat_mp",
    "公众号": "wechat_mp",
    "微信公众号": "wechat_mp",
    "xiaohongshu": "xiaohongshu",
    "xhs": "xiaohongshu",
    "rednote": "xiaohongshu",
    "小红书": "xiaohongshu",
    "wechat_channels": "wechat_channels",
    "wechat-channels": "wechat_channels",
    "shipinhao": "wechat_channels",
    "channels": "wechat_channels",
    "视频号": "wechat_channels",
    "微信视频号": "wechat_channels",
    "douyin": "wechat_channels",
    "dy": "wechat_channels",
    "抖音": "wechat_channels",
    "抖音号": "wechat_channels",
}
MARKET_PLATFORM_LABELS = {
    "wechat_mp": "公众号",
    "xiaohongshu": "小红书",
    "wechat_channels": "视频号",
}


def _required_market_platforms() -> tuple[str, ...]:
    """Return the non-configurable three-platform commercial contract."""
    return DEFAULT_MARKET_PLATFORMS


REQUIRED_MARKET_PLATFORMS = _required_market_platforms()

SENSITIVE_TERMS = ["蕲艾", "步步", "吴总", "严腾", "老板娘", "董事长", "CEO"]
FORBIDDEN_GATE_TERMS = [
    "内部分析",
    "角度报告",
    "蓝图过程",
    "素材理解报告",
    "角度生成报告",
    "思想母版蓝图",
    "资产包说明",
]

QUERY_RULES = [
    (("出海", "自媒体"), "企业出海 自媒体"),
    (("老板", "个人IP"), "老板 个人IP GTM"),
    (("经销商",), "经销商 内容营销"),
    (("AI", "老板"), "AI 企业转型 老板认知"),
    (("AI", "信任"), "AI 人的价值 信任"),
    (("产品力", "流量"), "产品力 流量 放大器"),
]

QUERY_TOPICS = {
    "企业出海 自媒体": {"enterprise_overseas"},
    "老板 个人IP GTM": {"boss_personal_ip"},
    "经销商 内容营销": {"dealer"},
    "AI 企业转型 老板认知": {"ai_transformation"},
    "AI 人的价值 信任": {"ai_transformation"},
    "产品力 流量 放大器": {"product_traffic"},
}

# These are deliberately narrow, material-derived fallbacks for topics that
# are outside the established enterprise-growth rules above. They only run
# when no curated query matched, so they cannot broaden or reorder existing
# research. Each query needs two independently supported concepts; this keeps
# a passing mention of a broad term such as "治理" from becoming a search.
MATERIAL_FALLBACK_QUERY_RULES = [
    (("content", "customer", "case"), "内容获客 客户案例"),
    (("content", "customer", "question"), "客户问题 内容选题"),
    (("scope_change", "delivery_scope"), "需求变更 交付范围"),
    (("law_firm", "governance"), "律所 治理"),
    (("founder", "recovery"), "创始人 恢复"),
]

MATERIAL_FALLBACK_TRIGGER_ALIASES = {
    "content": ("内容", "自媒体", "写作", "发布"),
    "customer": ("客户", "用户", "访谈"),
    "case": ("案例", "案例库", "客户故事"),
    "question": ("问题", "疑问", "常问", "反复问", "提问"),
    "scope_change": ("需求变更", "变更需求", "需求变动", "临时改需求", "追加需求", "增加需求", "追加修改", "顺便改一下"),
    "delivery_scope": ("交付", "原约定", "服务范围", "确认范围", "工作量", "排期"),
    "law_firm": ("律师事务所", "律所", "law firm"),
    "governance": ("合伙人治理", "治理结构", "治理", "合伙人制", "管理机制", "管理"),
    "founder": ("创始人", "创办人", "founder"),
    "recovery": ("恢复", "复原", "修复", "重建", "复苏", "重启", "recovery"),
}

EXCLUDED_TOPIC_PATTERNS = {
    "enterprise_overseas": [r"企业\s*出海", r"出海", r"海外"],
    "boss_personal_ip": [r"老板\s*个人\s*ip", r"个人\s*ip", r"老板\s*ip"],
    "dealer": [r"经销商"],
}

EXCLUSION_CLAUSE_RE = re.compile(
    r"(?:不讨论|不涉及|不聊|不谈|不做|不要|别谈|别聊|别做|别碰|"
    r"不想做|不想聊|不考虑|排除|避免|不碰|不用)"
    r"[^，。；;,.!?！？\n]{0,40}",
    re.IGNORECASE,
)

SAFE_SIGNAL_MECHANISM_PARTS = {
    "反常识标题",
    "方法论清单",
    "案例叙事",
    "评论诊断需求",
    "痛点开头",
}

ENTERPRISE_THEME_QUERIES = {
    "企业出海 自媒体",
    "老板 个人IP GTM",
    "经销商 内容营销",
    "AI 企业转型 老板认知",
    "产品力 流量 放大器",
}

WEAK_SIGNAL_MATCH_KEYWORDS = {
    "老板",
    "市场",
    "产品",
    "服务",
    "内容",
    "素材",
    "问题",
    "经验",
    "方法",
    "教育",
    "流量",
    "自媒体",
}

NEGATION_PREFIX_RE = re.compile(
    r"(?:(?:不讨论|不涉及|不聊|不谈|不做|不要|不是|并非|别谈|别聊|别做|别碰|"
    r"不想做|不想聊|不考虑|排除|避免|不碰|不用|无|未)[^，。；、,.!?！？]{0,10}|"
    r"没(?:有|做|谈|聊|涉及|考虑|碰|用|选|选择)?\s*)$"
)

HARD_EXCLUSION_PREFIX_RE = re.compile(
    r"(?:(?:不讨论|不涉及|不聊|不谈|不做|不要|不是|并非|别谈|别聊|别做|别碰|"
    r"不想做|不想聊|不考虑|排除|避免|不碰|不用|不选|未选择|无|未)[^，。；、,.!?！？]{0,10}|"
    r"(?:没有选|没有选择|没选|没选择)(?:做|用|走|采用|搞)?\s*|"
    r"(?:没有|没)\s*)$"
)
UNFINISHED_TOPIC_PREFIX_RE = re.compile(r"(?:未做过|未考虑过|未用过|未接触过|未尝试过)\s*$")
UNFINISHED_TOPIC_CONTEXT_RE = re.compile(
    r"(?:未做过|未考虑过|未用过|未接触过|未尝试过)[^，。；、,.!?！？\n]{0,10}$"
)
REVERSE_EMPHASIS_PREFIX_RE = re.compile(r"(?:不是|并非)\s*$")
REVERSE_EMPHASIS_CONTEXT_RE = re.compile(r"(?:不是|并非)[^，。；、,.!?！？\n]{0,10}$")
LIST_EXCLUSION_CONTEXT_RE = re.compile(
    r"(?:不讨论|不涉及|不聊|不谈|不做|不要|不是|并非|别谈|别聊|别做|别碰|"
    r"不想做|不想聊|不考虑|排除|避免|不碰|不用|无|未)[^，。；;,.!?！？\n]{0,30}[、和及与]\s*$"
)
CLAUSE_BOUNDARY_RE = re.compile(r"[，。；;,.!?！？\n]")
ABSENCE_TOKEN_RE = re.compile(
    r"(?:没有(?!选|选择)|没(?!有选|有选择|选|选择)|无|"
    r"未做过|未考虑过|未用过|未接触过|未尝试过)"
)
EXCLUSION_AFTER_ABSENCE_RE = re.compile(
    r"(?:不是|并非|不讨论|不涉及|不聊|不谈|不做|不要|别谈|别聊|别做|别碰|"
    r"不想做|不想聊|不考虑|排除|避免|不碰|不用|未选择|不选|没有选|没有选择|没选|没选择)"
)
DOUBLE_NEGATION_MARKERS_RE = (
    r"没有选择|没有选|没选择|没选|未选择|不想做|不想聊|不讨论|不涉及|"
    r"不考虑|不碰|不用|不选|不做|不要|不聊|不谈|排除|避免|别谈|别聊|别做|别碰"
)
DOUBLE_NEGATION_CLAUSE_RE = re.compile(
    r"(?:不是|并非)[^，。；;,.!?！？\n]{0,20}"
    rf"(?:{DOUBLE_NEGATION_MARKERS_RE})"
)
CONTRAST_SPLIT_RE = re.compile(r"(?:而是|但是|不过|但)")
DOUBLE_NEGATION_CONTEXT_RE = re.compile(
    r"(?:不是|并非)[^，。；;,.!?！？\n]{0,20}"
    rf"(?:{DOUBLE_NEGATION_MARKERS_RE})\s*$"
)
TOPIC_SUFFIX_EXCLUSION_RE = re.compile(
    r"^\s*(?:方向|渠道|主题|方案|这条线|这个方向)?"
    r"(?:暂时|先|现阶段)?(?:不做|不聊|不谈|不碰|避开|排除|放弃)"
)
POSITIVE_TOPIC_CONFIRMATION_RE = re.compile(
    r"(?:仍然|依然|还是|仍是|仍旧|现在|这次|确认|关键|要做|要聊|要谈|"
    r"应该|继续|切入|一起做|主线|重点|核心)"
)
REVERSE_EMPHASIS_CLAUSE_RE = re.compile(r"(?:不是|并非)[^，。；;,.!?！？\n]{0,30}不重要")
NON_EXCLUSION_TOPIC_SUFFIX_RE = re.compile(
    r"^\s*(?:经验|经历|案例|能力|资源|团队|预算|基础|打法|方法|方案|内容营销|"
    r"渠道|认知|意识|问题|价值|机会|客户|样板|项目|数据)"
)
REVERSE_EMPHASIS_SUFFIX_RE = re.compile(r"^\s*不")

THEME_LIBRARY = [
    {
        "title": "自媒体不是发内容，而是企业 GTM 的新入口",
        "keywords": ["自媒体", "GTM", "信任", "营销", "老板"],
        "reason": "素材反复讨论自媒体在老板信任、海外增长和成交入口中的作用。",
        "risk": "不写未核验播放量、金额和具体合作承诺。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "场景判断 + 信任入口",
    },
    {
        "title": "别再教育老板了，先从经销商切进去",
        "keywords": ["老板", "经销商", "教育", "切入", "市场"],
        "reason": "这是素材里最强的反常识判断，且出现多次。",
        "risk": "避免把所有老板写成负面群体，只写合作路径选择。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "反常识标题 + 评论诊断需求",
    },
    {
        "title": "一个实战派操盘手如何筛选合作对象",
        "keywords": ["操盘", "合作", "筛选", "实战", "产品"],
        "reason": "人物经验、合作挫折、筛选标准和商业判断都很鲜明。",
        "risk": "必须脱敏人名、公司名、地点、金额和合作细节。",
        "platforms": ["公众号"],
        "mechanism": "人物故事 + 标准提炼",
    },
    {
        "title": "产品力是底座，流量只是放大器",
        "keywords": ["产品力", "流量", "供应链", "服务", "放大器"],
        "reason": "这条判断稳定、可解释，也适合沉淀成商业方法论。",
        "risk": "不能点名批评具体品牌，不能把个案写成普遍事实。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "金句判断 + 案例叙事",
    },
    {
        "title": "AI 时代，企业真正的差距不是工具，而是老板会不会用",
        "keywords": ["AI", "AIGC", "智能体", "老板", "组织效率"],
        "reason": "素材里有大量 AI 使用、组织效率和认知差距讨论。",
        "risk": "不承诺 AI 一定降本增效，不夸大替代效果。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "趋势判断 + 认知差距",
    },
    {
        "title": "传统企业出海，先别谈战略，先跑一个低成本样板",
        "keywords": ["出海", "低成本", "样板", "产品", "验证"],
        "reason": "最贴合素材中的合作验证、样板案例和商业承接。",
        "risk": "不使用具体企业硬数据，先匿名处理案例。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "方法论清单 + 案例叙事",
    },
]

GENERIC_THEME_LIBRARY = [
    {
        "title": "把一个具体问题写成可传播的判断",
        "keywords": ["问题", "判断", "讨论", "核心", "选择"],
        "reason": "方向较宽时，先把一个具体问题讲透，比堆信息更稳。",
        "risk": "不补写素材里没有的人物、数据和结果。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "问题聚焦 + 清单表达",
    },
    {
        "title": "从真实场景切入，写出可执行经验",
        "keywords": ["场景", "经验", "安排", "习惯", "活动"],
        "reason": "用具体场景开头，能降低泛泛而谈的风险。",
        "risk": "避免把个人体验包装成普遍结论。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "场景开头 + 经验提炼",
    },
    {
        "title": "把一次经历提炼成普通人能照做的方法",
        "keywords": ["经历", "方法", "整理", "笔记", "复用"],
        "reason": "适合把零散素材整理成有结构的内容。",
        "risk": "方法只写可验证步骤，不做过度承诺。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "方法论清单 + 轻案例",
    },
    {
        "title": "用误区对比讲清一个选择",
        "keywords": ["误区", "选择", "对比", "长期", "普通人"],
        "reason": "对比结构能让主题更容易被理解和转发。",
        "risk": "对比不要制造对立，保留适用条件。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "误区对比 + 选择建议",
    },
    {
        "title": "把读者最关心的问题做成一张清单",
        "keywords": ["读者", "问题", "清单", "帮助", "分享"],
        "reason": "清单式表达适合低风险、强可读的泛素材。",
        "risk": "不虚构读者反馈，只从素材可见问题出发。",
        "platforms": ["小红书", "公众号"],
        "mechanism": "问题清单 + 行动建议",
    },
    {
        "title": "从风险边界出发，写一篇稳妥分析",
        "keywords": ["风险", "边界", "分析", "温和", "长期"],
        "reason": "当素材缺少强商业线索时，稳妥分析更合适。",
        "risk": "不使用具体硬数字，不放大个别经验。",
        "platforms": ["公众号"],
        "mechanism": "边界声明 + 稳健判断",
    },
    {
        "title": "先写一个可验证的小结论，不急着搭大框架",
        "keywords": ["验证", "结论", "框架", "小", "具体"],
        "reason": "素材支撑有限时，小结论比宏大框架更不容易失真。",
        "risk": "不把局部经验写成系统方法论。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "小结论 + 风险边界",
    },
    {
        "title": "把一个现场细节放大成读者能代入的问题",
        "keywords": ["现场", "细节", "读者", "代入", "问题"],
        "reason": "现场细节能增强真实感，也能避免开头过于抽象。",
        "risk": "细节必须来自素材，不补写人物和场景。",
        "platforms": ["小红书", "公众号"],
        "mechanism": "现场开头 + 痛点放大",
    },
    {
        "title": "把同一个话题拆给两类人看，先选更有行动的人",
        "keywords": ["话题", "两类人", "行动", "选择", "受众"],
        "reason": "同一话题可能对应不同受众，先选更可能评论和行动的人。",
        "risk": "不为了扩大受众而稀释核心判断。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "受众选择 + 评论诊断",
    },
    {
        "title": "把评论区问题预埋进正文，而不是结尾硬问一句",
        "keywords": ["评论区", "正文", "问题", "预埋", "互动"],
        "reason": "如果目标是引发评论，正文必须提前制造可回答的问题。",
        "risk": "不诱导私信，不承诺诊断结果。",
        "platforms": ["小红书", "公众号"],
        "mechanism": "评论诊断需求 + 结构预埋",
    },
]

READING_THEME_LIBRARY = [
    {
        "title": "长期阅读不是自律比赛，而是一套能坚持的生活秩序",
        "keywords": ["阅读", "长期", "习惯", "周末", "生活秩序"],
        "reason": "素材里的周末安排、长期阅读和普通人可坚持性形成了清晰主线。",
        "risk": "不把个人习惯包装成唯一正确方法，保留适用条件。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "反常识标题 + 场景判断",
    },
    {
        "title": "周末时间怎么安排，才不会被琐事切碎",
        "keywords": ["周末", "时间", "安排", "琐事", "生活"],
        "reason": "周末时间安排是读者容易代入的具体入口。",
        "risk": "不输出过度精细的时间管理承诺，只写可尝试的选择。",
        "platforms": ["小红书", "公众号"],
        "mechanism": "痛点开头 + 行动建议",
    },
    {
        "title": "普通人的笔记不是收藏夹，而是复盘自己的证据",
        "keywords": ["普通人", "笔记", "整理", "复盘", "证据"],
        "reason": "素材中的零散笔记和温和分享适合提炼成方法型内容。",
        "risk": "不夸大笔记效果，不虚构案例结果。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "金句判断 + 方法论清单",
    },
    {
        "title": "把一次社区讨论写成有用内容，关键不是总结而是抓问题",
        "keywords": ["社区", "讨论", "活动", "问题", "帮助"],
        "reason": "社区阅读活动里有真实讨论，适合从问题而不是流水账切入。",
        "risk": "不泄露参与者隐私，不替参与者下结论。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "场景开头 + 问题聚焦",
    },
    {
        "title": "温和分享也能有传播力，前提是说清一个具体选择",
        "keywords": ["温和", "分享", "选择", "具体", "普通人"],
        "reason": "素材语气温和，适合用具体选择承载传播张力。",
        "risk": "避免为了传播制造冲突或绝对化判断。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "选择建议 + 评论诊断需求",
    },
    {
        "title": "读书活动真正留下来的，不是打卡，而是可复用的问题",
        "keywords": ["读书", "阅读", "活动", "问题", "复用"],
        "reason": "能把一次活动沉淀成后续内容资产，而不是一次性记录。",
        "risk": "不把活动反馈伪装成大样本结论。",
        "platforms": ["公众号"],
        "mechanism": "边界声明 + 经验提炼",
    },
]

SERVICE_THEME_LIBRARY = [
    {
        "title": "服务流程里的小问题，往往决定用户愿不愿意再来",
        "keywords": ["服务流程", "排队", "提醒", "工作人员", "用户问题"],
        "reason": "素材里的排队、提醒和回应速度都指向用户体验的关键摩擦。",
        "risk": "不把单次门店复盘写成全行业结论。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "场景判断 + 痛点开头",
    },
    {
        "title": "减少排队不是运营口号，而是把提醒做在用户焦虑前面",
        "keywords": ["排队", "提醒", "用户", "焦虑", "运营"],
        "reason": "排队和提醒是素材中最具体、最容易被读者理解的改进点。",
        "risk": "不承诺固定提升比例，不虚构门店数据。",
        "platforms": ["小红书", "公众号"],
        "mechanism": "反常识标题 + 行动建议",
    },
    {
        "title": "产品体验不好，市场反馈再多也只是噪音",
        "keywords": ["产品体验", "市场反馈", "服务", "问题", "优化"],
        "reason": "素材把产品体验、服务流程和市场反馈放在同一个复盘里。",
        "risk": "不点名批评具体门店或品牌。",
        "platforms": ["公众号"],
        "mechanism": "金句判断 + 复盘清单",
    },
    {
        "title": "工作人员回应慢，表面是效率，底层是流程没有兜住人",
        "keywords": ["工作人员", "回应", "效率", "流程", "用户"],
        "reason": "回应速度能把用户体验问题讲得更具体。",
        "risk": "不归因到个人能力，聚焦流程设计。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "问题聚焦 + 边界声明",
    },
    {
        "title": "门店复盘最有价值的部分，是找到用户卡住的那一秒",
        "keywords": ["门店", "复盘", "用户", "卡住", "体验"],
        "reason": "适合把复盘写成有画面感的分析，而不是流水账。",
        "risk": "不泄露内部运营细节和客户隐私。",
        "platforms": ["公众号", "小红书"],
        "mechanism": "场景开头 + 案例叙事",
    },
    {
        "title": "服务优化先别做大全，先改一个用户最容易感到被忽略的点",
        "keywords": ["服务优化", "用户", "忽略", "改进", "反馈"],
        "reason": "把宽泛优化收敛成一个可执行的小动作，更容易落地。",
        "risk": "不把单点改进包装成完整解决方案。",
        "platforms": ["小红书", "公众号"],
        "mechanism": "方法论清单 + 风险边界",
    },
]

THEME_EXCLUDED_TOPICS = {
    "别再教育老板了，先从经销商切进去": {"dealer"},
    "传统企业出海，先别谈战略，先跑一个低成本样板": {"enterprise_overseas"},
}


@dataclass
class MarketSignal:
    provider: str
    platform: str
    query: str
    title: str
    hook: str
    metrics: dict[str, int | None]
    mechanism: str
    audience_pain: str
    source_url: str
    captured_at: str
    # These fields are deliberately normalized into the immutable snapshot so
    # the desktop can render research samples without opening or exposing the
    # provider's raw TikOmni payload again.
    account: str = ""
    published_at: str = ""
    content_form: str = ""
    sample_class: str = "related"
    hit_score: int = 0
    classification_reason: str = "缺少足够的公开表现指标，只能作为相关内容参考"
    evidence_status: str = "insufficient"
    confidence: int = 0
    metric_completeness: float = 0.0
    age_days: float | None = None
    score_components: dict[str, float] | None = None
    creator_baseline: float | None = None
    creator_lift: float | None = None
    engagement_rate: float | None = None
    score_version: str = "echo-founder.tikomni-hit-score.v5"


PLATFORM_HIT_THRESHOLDS: dict[str, dict[str, int]] = {
    "wechat_mp": {"reads": 10_000, "likes": 100, "interactions": 150},
    "xiaohongshu": {"likes": 1_000, "collects": 500, "interactions": 1_500},
    "wechat_channels": {"reads": 10_000, "likes": 500, "interactions": 800},
}


def classify_market_sample(platform: str, metrics: dict[str, int | None]) -> tuple[str, int, str]:
    """Compatibility classifier that deliberately cannot claim a verified hit.

    A v5 verified-hit decision needs URL, publication time, query relevance and
    batch/creator comparison. Callers with metrics alone therefore receive at
    most a potential label.
    """
    thresholds = PLATFORM_HIT_THRESHOLDS.get(platform, {})
    known = {key: value for key, value in metrics.items() if isinstance(value, int) and value > 0}
    if len(known) < 2:
        return "insufficient", 0, "有效表现指标少于两个，不能进入爆款排序"
    interactions = sum(known.get(key, 0) for key in ("likes", "collects", "comments", "shares"))
    values = {**known, "interactions": interactions}
    ratios = {
        key: values.get(key, 0) / threshold
        for key, threshold in thresholds.items()
        if threshold > 0 and key in values
    }
    best_key, best_ratio = max(ratios.items(), key=lambda item: item[1], default=("", 0.0))
    score = min(100, round(best_ratio * 100))
    metric_labels = {
        "reads": "阅读/播放",
        "likes": "点赞",
        "collects": "收藏",
        "interactions": "互动",
    }
    if best_ratio >= 1:
        return "potential", score, f"{metric_labels.get(best_key, best_key)}达到绝对参考线，但缺少批次比较证据"
    if best_ratio >= 0.5:
        return "potential", score, f"{metric_labels.get(best_key, best_key)}接近平台爆款参考线"
    return "related", score, "有公开指标，但尚未达到该平台的爆款参考线"


def _parse_market_datetime(value: str) -> datetime | None:
    compact = str(value or "").strip()
    if not compact:
        return None
    normalized = compact.replace("年", "-").replace("月", "-").replace("日", "")
    normalized = normalized.replace("/", "-").replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _percentile(values: list[float], current: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return 50.0
    below = sum(1 for value in values if value < current)
    equal = sum(1 for value in values if value == current)
    return round(100 * (below + max(0, equal - 1) / 2) / (len(values) - 1), 2)


def _volume_value(platform: str, metrics: dict[str, int | None]) -> float:
    thresholds = PLATFORM_HIT_THRESHOLDS.get(platform, {})
    interactions = sum(
        value for key in ("likes", "collects", "comments", "shares")
        if isinstance((value := metrics.get(key)), int) and value > 0
    )
    ratios: list[float] = []
    for key, threshold in thresholds.items():
        value = interactions if key == "interactions" else metrics.get(key)
        if isinstance(value, int) and value > 0 and threshold > 0:
            ratios.append(value / threshold)
    return max(ratios, default=0.0)


def market_volume_value(platform: str, metrics: dict[str, int | None]) -> float:
    """Expose the normalized v5 volume unit for compatible historical baselines."""
    return _volume_value(platform, metrics)


def _absolute_volume_score(platform: str, metrics: dict[str, int | None]) -> float:
    thresholds = PLATFORM_HIT_THRESHOLDS.get(platform, {})
    interactions = sum(
        value for key in ("likes", "collects", "comments", "shares")
        if isinstance((value := metrics.get(key)), int) and value > 0
    )
    scores: list[float] = []
    for key, threshold in thresholds.items():
        value = interactions if key == "interactions" else metrics.get(key)
        if isinstance(value, int) and value > 0 and threshold > 0:
            scores.append(min(100.0, value / threshold * 100))
    scores.sort(reverse=True)
    return round(statistics.fmean(scores[:2]), 2) if scores else 0.0


def _query_relevance_score(signal: MarketSignal) -> float:
    query = signal.query.strip().lower()
    if not query:
        return 0.0
    haystack = f"{signal.title} {signal.hook}".lower()
    tokens = [token for token in re.split(r"[\s,，、/]+", query) if len(token) >= 2]
    if not tokens:
        tokens = [query]
    matched = sum(1 for token in tokens if token in haystack)
    if query in haystack:
        return 100.0
    if not matched:
        return 20.0
    return round(min(100.0, 40 + 60 * matched / len(tokens)), 2)


def _freshness_score(age_days: float) -> float:
    if age_days <= 7:
        return 100.0
    if age_days <= 30:
        return 85.0
    if age_days <= 90:
        return 70.0
    if age_days <= 180:
        return 50.0
    if age_days <= 365:
        return 30.0
    return 15.0


def _evidence_score(signal: MarketSignal, valid_published_at: bool) -> float:
    known_count = sum(isinstance(value, int) for value in signal.metrics.values())
    positive_count = sum(isinstance(value, int) and value > 0 for value in signal.metrics.values())
    score = 25.0 if _is_public_http_url(signal.source_url) else 0.0
    score += 20.0 if valid_published_at else 0.0
    score += 10.0 if signal.account else 0.0
    score += 10.0 if signal.title and signal.hook else 0.0
    score += min(25.0, positive_count / 2 * 25.0)
    score += min(10.0, known_count / 5 * 10.0)
    return round(min(100.0, score), 2)


def score_market_signal_batch(
    signals: list[MarketSignal],
    captured_at: str,
    creator_history: dict[str, list[float]] | None = None,
) -> list[MarketSignal]:
    """Apply the immutable Echo Founder TikOmni hit-score v5 contract."""
    captured = _parse_market_datetime(captured_at) or datetime.now(timezone.utc)
    volume_values = [_volume_value(signal.platform, signal.metrics) for signal in signals]
    batch_median = statistics.median(volume_values) if volume_values else 0.0

    for index, signal in enumerate(signals):
        published = _parse_market_datetime(signal.published_at)
        valid_time = published is not None
        age_days = (captured - published).total_seconds() / 86_400 if published else None
        future = age_days is not None and age_days < -0.25
        known_count = sum(isinstance(value, int) for value in signal.metrics.values())
        positive_count = sum(isinstance(value, int) and value > 0 for value in signal.metrics.values())
        signal.metric_completeness = round(known_count / max(1, len(signal.metrics)), 4)
        signal.age_days = round(age_days, 2) if age_days is not None else None
        signal.engagement_rate = None
        reads = signal.metrics.get("reads")
        interactions = sum(
            value for key in ("likes", "collects", "comments", "shares")
            if isinstance((value := signal.metrics.get(key)), int) and value > 0
        )
        if isinstance(reads, int) and reads > 0:
            signal.engagement_rate = round(interactions / reads, 6)

        historical = list((creator_history or {}).get(signal.account, [])) if signal.account else []
        current_author_values = [
            value for candidate_index, (candidate, value) in enumerate(zip(signals, volume_values))
            if candidate_index != index and signal.account and candidate.account == signal.account
        ]
        if len(historical) >= 3:
            baseline = statistics.median(historical)
        elif len(current_author_values) >= 3:
            baseline = statistics.median(current_author_values)
        else:
            baseline = batch_median
        signal.creator_baseline = round(baseline, 6) if baseline > 0 else None
        current_volume = volume_values[index]
        signal.creator_lift = round(current_volume / baseline, 4) if baseline > 0 else None

        evidence = _evidence_score(signal, valid_time and not future)
        relevance = _query_relevance_score(signal)
        freshness = _freshness_score(max(0.0, age_days)) if age_days is not None and not future else 0.0
        absolute = _absolute_volume_score(signal.platform, signal.metrics)
        comparable_values = [
            value for candidate, value in zip(signals, volume_values)
            if candidate.platform == signal.platform and candidate.query == signal.query
        ]
        batch_percentile = _percentile(comparable_values, current_volume)
        engagement = 0.0
        if signal.engagement_rate is not None:
            comparable_rates = [
                candidate_interactions / candidate_reads
                for candidate in signals
                if candidate.platform == signal.platform and candidate.query == signal.query
                and isinstance((candidate_reads := candidate.metrics.get("reads")), int)
                and candidate_reads > 0
                and (candidate_interactions := sum(
                    value for key in ("likes", "collects", "comments", "shares")
                    if isinstance((value := candidate.metrics.get(key)), int) and value > 0
                )) >= 0
            ]
            engagement = _percentile([float(value) for value in comparable_rates], signal.engagement_rate)
        creator_lift_score = min(100.0, max(0.0, ((signal.creator_lift or 0.0) - 0.5) / 1.5 * 100))
        performance = round(
            absolute * 0.35 + engagement * 0.25 + batch_percentile * 0.20 + creator_lift_score * 0.20,
            2,
        )
        total = round(performance * 0.55 + relevance * 0.20 + freshness * 0.10 + evidence * 0.15, 2)
        signal.score_components = {
            "absolute_volume": absolute,
            "engagement_rate": round(engagement, 2),
            "batch_percentile": round(batch_percentile, 2),
            "creator_lift": round(creator_lift_score, 2),
            "performance": performance,
            "relevance": relevance,
            "freshness": freshness,
            "evidence": evidence,
            "total": total,
        }
        signal.hit_score = round(total)
        signal.confidence = round(min(evidence, 100.0 if positive_count >= 2 else 40.0))

        insufficiency_reason = ""
        if future:
            insufficiency_reason = "发布时间晚于抓取时间，样本时间证据异常"
        elif not valid_time:
            insufficiency_reason = "缺少有效发布时间，不能进入爆款排序"
        elif not _is_public_http_url(signal.source_url):
            insufficiency_reason = "缺少可公开核验的原文链接，不能进入爆款排序"
        elif positive_count < 2:
            insufficiency_reason = "有效表现指标少于两个，不能进入爆款排序"
        if insufficiency_reason:
            signal.evidence_status = "insufficient"
            signal.sample_class = "insufficient"
            signal.hit_score = 0
            signal.classification_reason = insufficiency_reason
            continue

        signal.evidence_status = "sufficient"
        strong_comparison = engagement >= 80 or batch_percentile >= 80 or (signal.creator_lift or 0) >= 1.8
        verified = (
            evidence >= 80 and performance >= 75 and relevance >= 60 and total >= 80
            and positive_count >= 2 and strong_comparison
        )
        if verified:
            signal.sample_class = "verified_hit"
            signal.classification_reason = (
                f"多证据通过：表现 {performance:.0f}、相关性 {relevance:.0f}、"
                f"证据 {evidence:.0f}、批次百分位 {batch_percentile:.0f}"
            )
        elif 60 <= total < 80:
            signal.sample_class = "potential"
            signal.classification_reason = (
                f"综合 {total:.0f} 分，具备参考价值，但未同时通过爆款证据与表现门槛"
            )
        else:
            signal.sample_class = "related"
            signal.classification_reason = (
                f"综合 {total:.0f} 分，但未同时通过可验证爆款的强制门槛，仅作为相关样本"
                if total >= 80
                else f"综合 {total:.0f} 分，仅作为相关样本，不称为爆款"
            )
    return signals


def extract_market_queries(material_text: str, limit: int = 5) -> list[str]:
    text = str(material_text or "")
    lower_text = text.lower()
    excluded_topics = _extract_excluded_topics(lower_text)
    queries: list[str] = []
    for triggers, query in QUERY_RULES:
        if all(_has_supported_trigger(lower_text, trigger.lower()) for trigger in triggers):
            queries.append(query)
    safe_queries = []
    for query in queries:
        if any(term in query for term in SENSITIVE_TERMS):
            continue
        if QUERY_TOPICS.get(query, set()).intersection(excluded_topics):
            continue
        if query not in safe_queries:
            safe_queries.append(query)
    if safe_queries:
        return safe_queries[:limit]
    return _extract_material_fallback_queries(lower_text, limit)


def _extract_material_fallback_queries(text: str, limit: int) -> list[str]:
    """Return only narrowly supported, non-identifying search terms.

    This is not a generic keyword extractor: fallback queries come from a
    small, reviewable vocabulary and require every concept in their rule to be
    positively supported by the current material. ``_has_supported_trigger``
    also preserves the existing negation handling for explicit exclusions.
    """
    queries: list[str] = []
    for concepts, query in MATERIAL_FALLBACK_QUERY_RULES:
        if not all(_has_supported_material_concept(text, concept) for concept in concepts):
            continue
        if any(term in query for term in SENSITIVE_TERMS):
            continue
        if query not in queries:
            queries.append(query)
    return queries[:limit]


def _has_supported_material_concept(text: str, concept: str) -> bool:
    return any(
        _has_supported_trigger(text, alias.lower())
        for alias in MATERIAL_FALLBACK_TRIGGER_ALIASES.get(concept, ())
    )


def _has_supported_trigger(text: str, trigger: str) -> bool:
    for match in re.finditer(_trigger_pattern(trigger), text, flags=re.IGNORECASE):
        prefix = text[max(0, match.start() - 12):match.start()]
        if NEGATION_PREFIX_RE.search(prefix):
            clause_prefix = _local_clause_prefix(text, match.start())
            if not (
                _has_double_negation_context(clause_prefix)
                and _is_double_negation_confirmed(text, match.start(), match.end())
            ):
                continue
        return True
    return False


def _extract_excluded_topics(text: str) -> set[str]:
    excluded = set()
    for clause_match in EXCLUSION_CLAUSE_RE.finditer(text):
        for clause in _effective_exclusion_clauses(text, clause_match):
            for topic, patterns in EXCLUDED_TOPIC_PATTERNS.items():
                if any(re.search(pattern, clause, flags=re.IGNORECASE) for pattern in patterns):
                    excluded.add(topic)
    for topic, patterns in EXCLUDED_TOPIC_PATTERNS.items():
        for pattern in patterns:
            for match in re.finditer(pattern, text, flags=re.IGNORECASE):
                if _is_hard_exclusion_match(text, match.start(), match.end()):
                    excluded.add(topic)
                    break
            if topic in excluded:
                break
    return excluded


def _effective_exclusion_clauses(text: str, clause_match: re.Match[str]) -> list[str]:
    clause = clause_match.group(0)
    local = _local_clause(text, clause_match.start(), clause_match.end())
    if not DOUBLE_NEGATION_CLAUSE_RE.search(local):
        return [clause]
    segments = CONTRAST_SPLIT_RE.split(clause)
    return [segment.strip() for segment in segments[1:] if EXCLUSION_CLAUSE_RE.match(segment.strip())]


def _is_hard_exclusion_match(text: str, start: int, end: int) -> bool:
    prefix = text[max(0, start - 12):start]
    list_prefix = text[max(0, start - 40):start]
    has_hard_prefix = bool(HARD_EXCLUSION_PREFIX_RE.search(prefix))
    has_list_context = bool(LIST_EXCLUSION_CONTEXT_RE.search(list_prefix))
    has_suffix_exclusion = bool(TOPIC_SUFFIX_EXCLUSION_RE.search(text[end:end + 16]))
    if not (has_hard_prefix or has_list_context or has_suffix_exclusion):
        return False
    suffix = text[end:end + 12]
    clause = _local_clause(text, start, end)
    clause_prefix = _local_clause_prefix(text, start)
    if NON_EXCLUSION_TOPIC_SUFFIX_RE.search(suffix) and _has_absence_non_exclusion_context(clause_prefix):
        return False
    if UNFINISHED_TOPIC_PREFIX_RE.search(prefix) or UNFINISHED_TOPIC_CONTEXT_RE.search(prefix):
        return False
    if _has_double_negation_context(clause_prefix) and _is_double_negation_confirmed(text, start, end):
        return False
    if REVERSE_EMPHASIS_CLAUSE_RE.search(clause):
        return False
    if (
        (REVERSE_EMPHASIS_PREFIX_RE.search(prefix) or REVERSE_EMPHASIS_CONTEXT_RE.search(prefix))
        and REVERSE_EMPHASIS_SUFFIX_RE.search(suffix)
    ):
        return False
    return True


def _local_clause(text: str, start: int, end: int) -> str:
    left = 0
    for match in CLAUSE_BOUNDARY_RE.finditer(text, 0, start):
        left = match.end()
    right_match = CLAUSE_BOUNDARY_RE.search(text, end)
    right = right_match.start() if right_match else len(text)
    return text[left:right]


def _local_clause_prefix(text: str, start: int) -> str:
    left = 0
    for match in CLAUSE_BOUNDARY_RE.finditer(text, 0, start):
        left = match.end()
    return text[left:start]


def _has_absence_non_exclusion_context(clause_prefix: str) -> bool:
    matches = list(ABSENCE_TOKEN_RE.finditer(clause_prefix))
    if not matches:
        return False
    tail = clause_prefix[matches[-1].end():]
    if len(tail) > 30:
        return False
    return not EXCLUSION_AFTER_ABSENCE_RE.search(tail)


def _has_double_negation_context(clause_prefix: str) -> bool:
    segment = clause_prefix
    for match in CONTRAST_SPLIT_RE.finditer(clause_prefix):
        segment = clause_prefix[match.end():]
    return bool(DOUBLE_NEGATION_CONTEXT_RE.search(segment))


def _is_double_negation_confirmed(text: str, start: int, end: int) -> bool:
    tail = text[end:end + 80]
    contrast = CONTRAST_SPLIT_RE.search(tail)
    if not contrast:
        return False
    after = tail[contrast.end():]
    topic = _topic_for_span(text, start, end)
    if topic and _contains_topic(after, topic) and POSITIVE_TOPIC_CONFIRMATION_RE.search(after):
        return True
    return bool(topic and _has_other_topic_exclusion(after, topic))


def _topic_for_span(text: str, start: int, end: int) -> str:
    value = text[start:end]
    for topic, patterns in EXCLUDED_TOPIC_PATTERNS.items():
        if any(re.search(pattern, value, flags=re.IGNORECASE) for pattern in patterns):
            return topic
    return ""


def _contains_topic(text: str, topic: str) -> bool:
    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in EXCLUDED_TOPIC_PATTERNS.get(topic, []))


def _has_other_topic_exclusion(text: str, current_topic: str) -> bool:
    if not EXCLUSION_AFTER_ABSENCE_RE.search(text[:40]):
        return False
    for topic in EXCLUDED_TOPIC_PATTERNS:
        if topic != current_topic and _contains_topic(text, topic):
            return True
    return False


def _trigger_pattern(trigger: str) -> str:
    chars = [re.escape(char) for char in str(trigger or "") if not char.isspace()]
    return r"\s*".join(chars)


def _unwrap_market_item(item: dict[str, Any]) -> dict[str, Any]:
    note = item.get("note")
    return {**item, **note} if isinstance(note, dict) else item


def _source_url_for_market_item(platform: str, item: dict[str, Any]) -> str:
    source_url = _first_text(item, ["url", "share_url", "web_url", "link", "doc_url"])
    if source_url:
        return source_url
    # Xiaohongshu search results commonly expose a note ID but not an explicit
    # public URL. Keep the immutable sample browseable without persisting its
    # short-lived xsec token from the provider response.
    if platform == "xiaohongshu":
        note_id = _first_text(item, ["note_id", "id"])
        if re.fullmatch(r"[A-Za-z0-9_-]{6,160}", note_id):
            return f"https://www.xiaohongshu.com/explore/{note_id}"
    # WeChat Channels rows expose a finder object id rather than a share URL.
    if platform == "wechat_channels":
        doc_id = _first_text(item, ["docID", "doc_id", "finder_id"])
        if doc_id and re.fullmatch(r"[A-Za-z0-9_=-]{6,200}", doc_id):
            return f"https://channels.weixin.qq.com/finder/{doc_id}"
    return ""


def normalize_tikomni_payload(platform: str, query: str, payload: dict[str, Any]) -> list[MarketSignal]:
    items = _extract_items(payload)
    signals: list[MarketSignal] = []
    identities: set[str] = set()
    captured_at = datetime.now().astimezone().isoformat(timespec="seconds")
    for raw_item in items:
        item = _unwrap_market_item(raw_item)
        title = _first_text(item, ["title", "display_title", "desc", "description", "content", "nickname"])
        hook = _first_text(item, ["desc", "description", "content", "summary", "note_card"])
        source_url = _source_url_for_market_item(platform, item)
        metrics = _extract_metrics(item)
        # A gate-counted example has to be independently inspectable. A
        # title-only provider row, a private URL, or a repeated result cannot
        # substitute for a public TikOmni sample.
        if not (title or hook) or not _is_public_http_url(source_url):
            continue
        identity = source_url.strip().lower() or title.strip().lower()
        if not identity or identity in identities:
            continue
        identities.add(identity)
        mechanism = infer_mechanism(title, hook, "")
        signals.append(
            MarketSignal(
                provider="tikomni",
                platform=platform,
                query=query,
                title=title[:120],
                hook=hook[:160],
                metrics=metrics,
                mechanism=mechanism,
                audience_pain=infer_audience_pain(title + " " + hook),
                source_url=source_url,
                captured_at=captured_at,
                account=_normalize_account(item),
                published_at=_normalize_published_at(item),
                content_form=_normalize_content_form(platform, item),
            )
        )
    score_market_signal_batch(signals, captured_at)
    class_order = {"verified_hit": 3, "potential": 2, "related": 1, "insufficient": 0}
    signals.sort(key=lambda signal: (class_order.get(signal.sample_class, 0), signal.hit_score), reverse=True)
    return signals[:TOPIC_SAMPLES_PER_PLATFORM]


def _is_public_http_url(value: str) -> bool:
    try:
        parsed = urlparse(str(value or "").strip())
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def infer_mechanism(title: str, hook: str, audience_pain: str) -> str:
    text = f"{title} {hook} {audience_pain}"
    parts = []
    if re.search(r"不是|别|不要|误区|错在|失败", text):
        parts.append("反常识标题")
    if re.search(r"第一步|清单|方法|步骤|框架", text):
        parts.append("方法论清单")
    if re.search(r"案例|故事|实战|亲历|老板|经销商", text):
        parts.append("案例叙事")
    if re.search(r"评论|留言|诊断|怎么做|怎么办", text):
        parts.append("评论诊断需求")
    return " + ".join(parts[:2]) or "痛点开头"


def infer_audience_pain(text: str) -> str:
    if re.search(r"老板|经销商", text):
        return "合作对象听不懂新打法，需要更低阻力的切入口"
    if re.search(r"出海|海外", text):
        return "想出海但不知道第一步怎么验证"
    if re.search(r"AI|AIGC|智能体", text, re.IGNORECASE):
        return "知道 AI 重要，但不知道如何真正用进业务"
    return "需要把模糊判断变成可执行内容"


def fetch_market_signals(
    material_text: str,
    target_platforms: list[str] | None = None,
    project: Path | str | None = None,
    *,
    queries: list[str] | None = None,
    mode: str = "topic",
    live_fetcher: Callable[[str, str], dict[str, Any]] | None = None,
    platform_timeout_seconds: float = DEFAULT_PLATFORM_FETCH_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Fetch only the selected platform lanes and preserve partial success.

    Each lane is independently auditable. A failed source blocks that platform
    lane, but successful selected platforms remain usable and snapshot-bound.
    """
    selected_platforms = _normalize_platforms(target_platforms or [])
    selected_mode = str(mode or "topic").strip().lower()
    if selected_mode not in {"topic", "weekly"}:
        raise ValueError("market research mode must be topic or weekly")
    try:
        timeout_seconds = float(platform_timeout_seconds)
    except (TypeError, ValueError):
        timeout_seconds = DEFAULT_PLATFORM_FETCH_TIMEOUT_SECONDS
    if timeout_seconds <= 0:
        timeout_seconds = DEFAULT_PLATFORM_FETCH_TIMEOUT_SECONDS

    generated_queries = _normalize_queries(queries if queries is not None else extract_market_queries(material_text))
    if not generated_queries:
        return _blocked_market_result(
            queries=[],
            blockers=[_blocker("query_missing", "无法从本期素材生成可执行的 TikOmni 检索词。")],
        )
    active_queries = generated_queries[:1] if selected_mode == "topic" else generated_queries[:DEFAULT_WEEKLY_QUERY_LIMIT]

    provider = os.getenv("AIFIOS_MARKET_SIGNAL_PROVIDER", "tikomni").strip().lower()
    if live_fetcher is None and provider in {"none", "off", "false"}:
        reason = "TikOmni 实时研究服务被禁用，不能进入选题或内容生产。"
        checks = _unavailable_platform_checks("tikomni_provider_disabled", reason, selected_platforms)
        return _blocked_market_result(
            queries=active_queries,
            blockers=[_platform_blocker(platform, checks[platform]) for platform in selected_platforms],
            platform_checks=checks,
            required_platforms=selected_platforms,
        )

    if live_fetcher is None:
        if project is None:
            reason = "实时 TikOmni 研究必须绑定本地项目和 run。"
            checks = _unavailable_platform_checks("project_required", reason, selected_platforms)
            return _blocked_market_result(
                queries=active_queries,
                blockers=[_platform_blocker(platform, checks[platform]) for platform in selected_platforms],
                platform_checks=checks,
                required_platforms=selected_platforms,
            )
        from tikomni_adapter import TikomniMarketResearchClient

        client = TikomniMarketResearchClient(project, timeout_ms=DEFAULT_PLATFORM_REQUEST_TIMEOUT_MS)
        health = client.health()
        if not health.get("available"):
            reason = "TikOmni Token 未配置、无效或当前不可用。"
            checks = _unavailable_platform_checks("tikomni_token_missing", reason, selected_platforms)
            return _blocked_market_result(
                queries=active_queries,
                blockers=[_platform_blocker(platform, checks[platform]) for platform in selected_platforms],
                platform_checks=checks,
                required_platforms=selected_platforms,
            )
        live_fetcher = client.fetch

    platform_results = _fetch_required_platforms_concurrently(
        selected_platforms,
        active_queries,
        live_fetcher,
        timeout_seconds=timeout_seconds,
    )
    # A single TikOmni endpoint can flap while the other two succeed. Retry
    # only transiently failed platforms inside this operation and retain the
    # fresh successful responses from its first batch. This is not a cache or
    # local fallback: every admitted platform result still comes from the
    # current live research operation.
    for _attempt in range(DEFAULT_TRANSIENT_PLATFORM_RETRY_LIMIT):
        retry_platforms = [
            platform
            for platform in selected_platforms
            if platform_results[platform][0].get("status") != "available"
            and platform_results[platform][0].get("code") in TRANSIENT_PLATFORM_CHECK_CODES
        ]
        if not retry_platforms:
            break
        retry_results = _fetch_required_platforms_concurrently(
            retry_platforms,
            active_queries,
            live_fetcher,
            timeout_seconds=timeout_seconds,
        )
        for platform in retry_platforms:
            platform_results[platform] = retry_results[platform]
    platform_checks: dict[str, dict[str, Any]] = {}
    raw_payloads: list[dict[str, Any]] = []
    signals: list[MarketSignal] = []
    blockers: list[dict[str, str]] = []
    for platform in selected_platforms:
        check, platform_signals, platform_raw = platform_results[platform]
        platform_checks[platform] = check
        if check.get("status") != "available":
            blockers.append(_platform_blocker(platform, check))
            continue
        signals.extend(platform_signals)
        raw_payloads.extend(platform_raw)

    sufficiency = score_cross_platform_sufficiency(signals, platform_checks, selected_platforms)
    if (
        selected_mode == "topic"
        and len(generated_queries) > len(active_queries)
        and any(check.get("sample_count", 0) == 0 for check in platform_checks.values())
    ):
        # A topic's first material-derived query can be too narrow for one
        # source even though the source is healthy. Enrich zero-hit sources
        # automatically without serially waiting for each source.
        supplemental_queries = generated_queries[len(active_queries):DEFAULT_TOPIC_QUERY_LIMIT]
        if supplemental_queries:
            retry_platforms = [
                platform
                for platform in selected_platforms
                if platform_checks[platform].get("status") == "available"
                and platform_checks[platform].get("sample_count", 0) == 0
            ]
            retry_results = _fetch_required_platforms_concurrently(
                retry_platforms,
                supplemental_queries,
                live_fetcher,
                timeout_seconds=timeout_seconds,
            )
            for platform in retry_platforms:
                current_check = platform_checks[platform]
                retry_check, retry_signals, retry_raw = retry_results[platform]
                # The initial request already proved the source is live. A
                # failed optional retry must not erase that valid result or
                # turn a narrow-query miss into a connectivity failure.
                if retry_check.get("status") != "available":
                    continue
                signals.extend(retry_signals)
                raw_payloads.extend(retry_raw)
                platform_checks[platform] = {
                    **current_check,
                    "sample_count": current_check.get("sample_count", 0) + retry_check.get("sample_count", 0),
                    "endpoint_ids": list(dict.fromkeys([
                        *current_check.get("endpoint_ids", []),
                        *retry_check.get("endpoint_ids", []),
                    ])),
                    "query_count": current_check.get("query_count", 0) + retry_check.get("query_count", 0),
                }
            active_queries = [*active_queries, *supplemental_queries]
            sufficiency = score_cross_platform_sufficiency(signals, platform_checks, selected_platforms)
    if not sufficiency.get("sufficient"):
        missing_platforms = [
            platform
            for platform in selected_platforms
            if (sufficiency.get("platform_sample_counts") or {}).get(platform, 0)
            < REQUIRED_SAMPLES_PER_PLATFORM
        ]
        for platform in missing_platforms:
            current_check = platform_checks[platform]
            if current_check.get("status") == "available":
                platform_checks[platform] = {
                    **current_check,
                    "status": "insufficient",
                    "code": "tikomni_platform_sample_missing",
                    "reason": (
                        "TikOmni 查询成功，但未返回至少 1 条带公开链接、"
                        "可独立核验的合格样本"
                    ),
                    "required_sample_count": REQUIRED_SAMPLES_PER_PLATFORM,
                }
        blockers.extend(
            _platform_blocker(platform, platform_checks[platform])
            for platform in missing_platforms
            if not any(item.get("platform") == platform for item in blockers)
        )
    ready_platforms = [
        platform for platform in selected_platforms
        if platform_checks.get(platform, {}).get("status") == "available"
        and (sufficiency.get("platform_sample_counts") or {}).get(platform, 0) >= REQUIRED_SAMPLES_PER_PLATFORM
    ]
    if not ready_platforms:
        return _blocked_market_result(
            queries=active_queries,
            blockers=blockers,
            platform_checks=platform_checks,
            sufficiency=sufficiency,
            required_platforms=selected_platforms,
        )
    return {
        "schema_version": MARKET_SNAPSHOT_SCHEMA_VERSION,
        "status": "ready",
        "mode": selected_mode,
        "mandatory": True,
        "partial": len(ready_platforms) != len(selected_platforms),
        "queries": active_queries,
        "generated_queries": generated_queries,
        "required_platforms": selected_platforms,
        "ready_platforms": ready_platforms,
        "platform_lanes": {
            platform: {
                "status": "ready" if platform in ready_platforms else "blocked",
                "sample_count": (sufficiency.get("platform_sample_counts") or {}).get(platform, 0),
                "reason": platform_checks.get(platform, {}).get("reason", ""),
            }
            for platform in selected_platforms
        },
        "platform_checks": platform_checks,
        "signals": [asdict(signal) for signal in signals[:100]],
        "raw_payloads": raw_payloads,
        "sufficiency": sufficiency,
        "blockers": blockers,
        "note": "已选平台的 TikOmni 实时研究已完成；各平台独立判断，只吸收可验证的结构和机制。",
        "no_fallback": True,
        "used_cache": False,
        "used_local_samples": False,
        "checked_at": datetime.now().astimezone().isoformat(),
    }


def normalize_market_platform(value: str) -> str:
    key = str(value or "").strip().lower()
    platform = MARKET_PLATFORM_ALIASES.get(key, key)
    if platform not in REQUIRED_MARKET_PLATFORMS:
        raise ValueError(f"未知 TikOmni 市场研究平台: {value}")
    return platform


def score_cross_platform_sufficiency(
    market_signals: list[MarketSignal | dict[str, Any]],
    platform_checks: dict[str, dict[str, Any]],
    required_platforms: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    """Score evidence and enforce one verifiable sample per live platform."""
    signals = _coerce_signals(market_signals)
    unique: dict[tuple[str, str], MarketSignal] = {}
    for signal in signals:
        identity = (signal.platform, signal.source_url or signal.title)
        if identity[1]:
            unique[identity] = signal
    rows = list(unique.values())
    selected_platforms = list(required_platforms or REQUIRED_MARKET_PLATFORMS)
    platform_sample_counts = {
        platform: sum(1 for signal in rows if signal.platform == platform)
        for platform in selected_platforms
    }
    sample_platforms = {
        platform
        for platform, sample_count in platform_sample_counts.items()
        if sample_count >= REQUIRED_SAMPLES_PER_PLATFORM
    }
    linked = sum(1 for signal in rows if signal.source_url.startswith(("https://", "http://")))
    metric_bearing = sum(1 for signal in rows if any(isinstance(value, int) and value > 0 for value in signal.metrics.values()))
    sample_score = min(60, len(rows) * 15)
    coverage_score = min(20, len(sample_platforms) * 10)
    evidence_score = min(20, (linked * 2) + (metric_bearing * 2))
    total = sample_score + coverage_score + evidence_score
    live_platform_count = sum(1 for check in platform_checks.values() if check.get("status") == "available")
    missing_platforms = [
        platform
        for platform in selected_platforms
        if platform_sample_counts[platform] < REQUIRED_SAMPLES_PER_PLATFORM
    ]
    sufficient = live_platform_count == len(selected_platforms) and not missing_platforms
    return {
        "score": total,
        "sufficient": sufficient,
        "sample_count": len(rows),
        "sample_platform_count": len(sample_platforms),
        "live_platform_count": live_platform_count,
        "required_samples_per_platform": REQUIRED_SAMPLES_PER_PLATFORM,
        "platform_sample_counts": platform_sample_counts,
        "missing_platforms": missing_platforms,
        "breakdown": {
            "sample_volume": sample_score,
            "cross_platform_coverage": coverage_score,
            "public_evidence": evidence_score,
        },
    }


def _blocked_market_result(
    *,
    queries: list[str],
    blockers: list[dict[str, str]],
    platform_checks: dict[str, dict[str, Any]] | None = None,
    sufficiency: dict[str, Any] | None = None,
    required_platforms: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    selected_platforms = list(required_platforms or REQUIRED_MARKET_PLATFORMS)
    checks = platform_checks or {}
    return {
        "schema_version": MARKET_SNAPSHOT_SCHEMA_VERSION,
        "status": "blocked",
        "mandatory": True,
        "queries": queries,
        "generated_queries": queries,
        "required_platforms": selected_platforms,
        "ready_platforms": [],
        "platform_lanes": {
            platform: {"status": "blocked", "sample_count": 0, "reason": checks.get(platform, {}).get("reason", "")}
            for platform in selected_platforms
        },
        "platform_checks": checks,
        "signals": [],
        "raw_payloads": [],
        "blockers": blockers,
        "sufficiency": sufficiency or {
            "score": 0,
            "sufficient": False,
            "sample_count": 0,
            "sample_platform_count": 0,
            "live_platform_count": sum(
                1 for check in checks.values() if check.get("status") == "available"
            ),
            "required_samples_per_platform": REQUIRED_SAMPLES_PER_PLATFORM,
            "platform_sample_counts": {
                platform: 0 for platform in selected_platforms
            },
            "missing_platforms": selected_platforms,
            "breakdown": {"sample_volume": 0, "cross_platform_coverage": 0, "public_evidence": 0},
        },
        "note": "已选平台暂时都没有形成可用研究证据；请按平台修复后重试。",
        "no_fallback": True,
        "used_cache": False,
        "used_local_samples": False,
        "checked_at": datetime.now().astimezone().isoformat(),
    }


def _blocker(code: str, message: str, *, platform: str = "") -> dict[str, str]:
    item = {"code": code, "message": message}
    if platform:
        item["platform"] = platform
    return item


def _unavailable_platform_checks(
    code: str,
    reason: str,
    platforms: list[str] | tuple[str, ...] | None = None,
) -> dict[str, dict[str, Any]]:
    return {
        platform: {
            "status": "unavailable",
            "code": code,
            "reason": reason,
            "sample_count": 0,
            "query_count": 0,
            "query_applied": False,
        }
        for platform in (platforms or REQUIRED_MARKET_PLATFORMS)
    }


def _platform_blocker(platform: str, check: dict[str, Any]) -> dict[str, str]:
    code = str(check.get("code") or "tikomni_platform_unavailable")
    reason = str(check.get("reason") or "未知错误")
    return _blocker(
        code,
        f"{MARKET_PLATFORM_LABELS[platform]} 的 TikOmni 实时数据不可用：{reason}",
        platform=platform,
    )


def _normalize_queries(values: list[str] | None) -> list[str]:
    result: list[str] = []
    for value in values or []:
        query = re.sub(r"\s+", " ", str(value or "")).strip()
        if len(query) < 2 or query in result or any(term in query for term in SENSITIVE_TERMS):
            continue
        result.append(query[:80])
    return result


def _fetch_platform_signals(
    platform: str,
    queries: list[str],
    live_fetcher: Callable[[str, str], dict[str, Any]],
) -> tuple[dict[str, Any], list[MarketSignal], list[dict[str, Any]]]:
    platform_signals: list[MarketSignal] = []
    raw_payloads: list[dict[str, Any]] = []
    endpoint_ids: list[str] = []
    for query in queries:
        try:
            response = live_fetcher(platform, query)
        except Exception as exc:
            return ({
                "status": "unavailable",
                "code": "tikomni_platform_request_failed",
                "reason": f"{type(exc).__name__}: {exc}",
                "sample_count": 0,
                "query_count": 0,
                "query_applied": False,
            }, [], [])
        if not isinstance(response, dict) or response.get("status") not in {"available", "ok", "fetched"}:
            reason = response.get("reason") if isinstance(response, dict) else "响应不是结构化 TikOmni 数据"
            code = response.get("code") if isinstance(response, dict) else "tikomni_platform_response_invalid"
            return ({
                "status": "unavailable",
                "code": str(code or "tikomni_platform_unavailable"),
                "reason": str(reason or "TikOmni 平台返回不可用"),
                "sample_count": 0,
                "query_count": 0,
                "query_applied": False,
            }, [], [])
        if response.get("query_applied") is False:
            return ({
                "status": "unavailable",
                "code": "tikomni_query_not_applied",
                "reason": "TikOmni 未执行本期目标查询",
                "sample_count": 0,
                "query_count": 0,
                "query_applied": False,
            }, [], [])
        raw_payload = response.get("raw_payload")
        if not isinstance(raw_payload, (dict, list)):
            return ({
                "status": "unavailable",
                "code": "tikomni_payload_missing",
                "reason": "TikOmni 未返回可验证公开数据",
                "sample_count": 0,
                "query_count": 0,
                "query_applied": False,
            }, [], [])
        if isinstance(raw_payload, list):
            payload: dict[str, Any] = {"items": raw_payload}
        else:
            payload = raw_payload
        if not _has_tikomni_result_collection(payload):
            return ({
                "status": "unavailable",
                "code": "tikomni_result_collection_missing",
                "reason": "TikOmni 返回的公开数据缺少结果集合",
                "sample_count": 0,
                "query_count": 0,
                "query_applied": False,
            }, [], [])
        normalized = normalize_tikomni_payload(platform, query, payload)
        if response.get("query_mode") == "public-account-filter":
            normalized = [signal for signal in normalized if _signal_matches_target_query(signal, query)]
        platform_signals.extend(normalized)
        endpoint_id = str(response.get("endpoint_id") or "").strip()
        if endpoint_id and endpoint_id not in endpoint_ids:
            endpoint_ids.append(endpoint_id)
        raw_payloads.append({
            "platform": platform,
            "query": query,
            "endpoint_id": endpoint_id,
            "query_mode": str(response.get("query_mode") or "platform-search"),
            "raw_path": str(response.get("raw_path") or ""),
            "payload": payload,
        })
    return (
        {
            "status": "available",
            "sample_count": len(platform_signals),
            "endpoint_ids": endpoint_ids,
            "query_count": len(queries),
            "query_applied": True,
        },
        platform_signals,
        raw_payloads,
    )


def _fetch_required_platforms_concurrently(
    platforms: tuple[str, ...] | list[str],
    queries: list[str],
    live_fetcher: Callable[[str, str], dict[str, Any]],
    *,
    timeout_seconds: float,
) -> dict[str, tuple[dict[str, Any], list[MarketSignal], list[dict[str, Any]]]]:
    """Start all independent platform requests together and bound each batch.

    The production adapter terminates its own caller subprocess before this
    deadline. The non-blocking executor shutdown is a second guard for custom
    fetchers: a timed-out response is never admitted into the current run,
    even if a third-party caller ignores cancellation.
    """
    requested = list(platforms)
    if not requested:
        return {}
    executor = ThreadPoolExecutor(max_workers=len(requested), thread_name_prefix="tikomni-market")
    futures = {
        executor.submit(_fetch_platform_signals, platform, queries, live_fetcher): platform
        for platform in requested
    }
    done, pending = wait(futures, timeout=timeout_seconds)
    results: dict[str, tuple[dict[str, Any], list[MarketSignal], list[dict[str, Any]]]] = {}
    for future, platform in futures.items():
        if future in pending:
            future.cancel()
            results[platform] = ({
                "status": "unavailable",
                "code": "tikomni_platform_timeout",
                "reason": f"超过 {timeout_seconds:g} 秒平台查询上限",
                "sample_count": 0,
                "query_count": 0,
                "query_applied": False,
            }, [], [])
            continue
        try:
            results[platform] = future.result()
        except Exception as exc:
            results[platform] = ({
                "status": "unavailable",
                "code": "tikomni_platform_worker_failed",
                "reason": f"{type(exc).__name__}: {exc}",
                "sample_count": 0,
                "query_count": 0,
                "query_applied": False,
            }, [], [])
    executor.shutdown(wait=False, cancel_futures=True)
    return results


def _signal_matches_target_query(signal: MarketSignal, query: str) -> bool:
    terms = [term.strip().lower() for term in re.split(r"\s+", query) if len(term.strip()) >= 2]
    if not terms:
        return False
    haystack = f"{signal.title} {signal.hook}".lower()
    return any(term in haystack for term in terms)


def _has_tikomni_result_collection(payload: dict[str, Any]) -> bool:
    for key in ("items", "results", "list", "aweme_list", "notes", "works", "articles", "business_data"):
        if isinstance(payload.get(key), list):
            return True
    data = payload.get("data")
    if isinstance(data, list):
        return True
    if isinstance(data, dict):
        return _has_tikomni_result_collection(data)
    normalized = payload.get("normalized")
    if isinstance(normalized, dict):
        return _has_tikomni_result_collection(normalized)
    return False


def persist_market_snapshot(
    *,
    project: Path | str,
    run_id: str,
    topic: str,
    source_path: str,
    result: dict[str, Any],
) -> dict[str, Any]:
    """Persist one immutable, verifiable live research snapshot under a run."""
    if result.get("status") != "ready":
        raise ValueError("只有至少一个已选平台形成可用证据的研究结果可以写入快照")
    project_path = Path(project).expanduser().resolve(strict=False)
    safe_run = _safe_run_id(run_id)
    if not safe_run:
        raise ValueError("run_id 无效，不能写入 TikOmni 快照")
    raw_source_path = Path(str(source_path or ""))
    if raw_source_path.is_absolute():
        source_file = _project_regular_file(project_path, raw_source_path)
        safe_source_path = _relative_to_project(project_path, source_file)
    else:
        safe_source_path = _safe_project_relative(source_path)
        source_file = _project_regular_file(project_path, safe_source_path)
    source_sha256 = _sha256_file(source_file)
    required = list(result.get("required_platforms") or [])
    if (
        not required
        or len(set(required)) != len(required)
        or any(platform not in REQUIRED_MARKET_PLATFORMS for platform in required)
    ):
        raise ValueError("研究结果缺少有效的已选平台契约")
    creator_mode = bool(result.get("creator_mode"))
    if creator_mode:
        raise ValueError("商业工作流不允许把创作模式写成可继续的研究快照")
    checks = result.get("platform_checks") if isinstance(result.get("platform_checks"), dict) else {}
    ready_platforms = [
        platform for platform in result.get("ready_platforms") or []
        if platform in required
    ]
    if not ready_platforms:
        ready_platforms = [
            platform for platform in required
            if (checks.get(platform) or {}).get("status") == "available"
            and int((checks.get(platform) or {}).get("sample_count") or 0) >= REQUIRED_SAMPLES_PER_PLATFORM
        ]
    if not ready_platforms:
        raise ValueError("研究结果没有可写入快照的已就绪平台")
    if any((checks.get(platform) or {}).get("status") != "available" for platform in ready_platforms):
        raise ValueError("已就绪平台的健康状态无效")
    if any(int((checks.get(platform) or {}).get("sample_count") or 0) < REQUIRED_SAMPLES_PER_PLATFORM for platform in ready_platforms):
        raise ValueError("已就绪平台缺少可核验样本")

    raw_payloads = result.get("raw_payloads") if isinstance(result.get("raw_payloads"), list) else []
    if not raw_payloads:
        raise ValueError("研究结果缺少 TikOmni 原始公开数据，不能写入快照")
    root = _market_research_root(project_path, safe_run)
    root.mkdir(parents=True, exist_ok=True)
    seed = _canonical_json_bytes({
        "run_id": safe_run,
        "topic": str(topic or ""),
        "source_path": safe_source_path,
        "source_sha256": source_sha256,
        "queries": result.get("queries") or [],
        "query_context": result.get("query_context") if isinstance(result.get("query_context"), dict) else {},
        "signals": result.get("signals") or [],
        "raw_payloads": raw_payloads,
        "captured_at": datetime.now().astimezone().isoformat(),
    })
    snapshot_id = f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S-%f')}-{hashlib.sha256(seed).hexdigest()[:12]}"
    snapshot_dir = root / snapshot_id
    try:
        snapshot_dir.mkdir(mode=0o700)
    except FileExistsError as exc:
        raise RuntimeError("TikOmni 快照 ID 冲突，请重新执行实时查询") from exc
    raw_dir = snapshot_dir / "raw"
    raw_dir.mkdir(mode=0o700)

    raw_entries: list[dict[str, Any]] = []
    for index, source in enumerate(raw_payloads, start=1):
        if not isinstance(source, dict):
            raise ValueError("TikOmni 原始数据结构无效")
        platform = normalize_market_platform(str(source.get("platform") or ""))
        payload = source.get("payload")
        if not isinstance(payload, (dict, list)):
            raise ValueError("TikOmni 原始数据缺少 payload")
        filename = f"{index:02d}-{platform}-{_safe_filename(str(source.get('query') or 'query'))}.json"
        raw_path = raw_dir / filename
        raw_bytes = _canonical_json_bytes(payload)
        _write_new_bytes(raw_path, raw_bytes)
        raw_entries.append({
            "platform": platform,
            "query": str(source.get("query") or ""),
            "endpoint_id": str(source.get("endpoint_id") or ""),
            "path": _relative_to_project(project_path, raw_path),
            "sha256": _sha256_bytes(raw_bytes),
        })

    normalized_path = snapshot_dir / "normalized-samples.json"
    normalized_bytes = _canonical_json_bytes({
        "schema_version": MARKET_SNAPSHOT_SCHEMA_VERSION,
        "signals": result.get("signals") or [],
        "platform_checks": checks,
        "sufficiency": result.get("sufficiency") or {},
        "platform_lanes": result.get("platform_lanes") or {},
        "ready_platforms": ready_platforms,
        "blockers": result.get("blockers") or [],
        "query_context": result.get("query_context") if isinstance(result.get("query_context"), dict) else {},
    })
    _write_new_bytes(normalized_path, normalized_bytes)

    manifest_without_digest = {
        "schema_version": MARKET_SNAPSHOT_SCHEMA_VERSION,
        "kind": "aifios.tikomni.topic-research-snapshot",
        "snapshot_id": snapshot_id,
        "run_id": safe_run,
        "topic": str(topic or "").strip(),
        "source_path": safe_source_path,
        "source_sha256": source_sha256,
        "created_at": datetime.now().astimezone().isoformat(),
        "mode": str(result.get("mode") or "topic"),
        "queries": [str(value) for value in result.get("queries") or []],
        "query_context": result.get("query_context") if isinstance(result.get("query_context"), dict) else {},
        "required_platforms": required,
        "ready_platforms": ready_platforms,
        "platform_lanes": result.get("platform_lanes") or {},
        "platform_checks": checks,
        "sufficiency": result.get("sufficiency") or {},
        "creator_mode": creator_mode,
        "warnings": result.get("warnings") if isinstance(result.get("warnings"), list) else [],
        "raw_entries": raw_entries,
        "normalized_path": _relative_to_project(project_path, normalized_path),
        "normalized_sha256": _sha256_bytes(normalized_bytes),
        "no_fallback": True,
        "used_cache": False,
        "used_local_samples": False,
    }
    manifest_digest = _sha256_bytes(_canonical_json_bytes(manifest_without_digest))
    manifest = {**manifest_without_digest, "sha256": manifest_digest}
    manifest_path = snapshot_dir / "snapshot.json"
    _write_new_bytes(manifest_path, _canonical_json_bytes(manifest))
    return {
        "status": "persisted",
        "snapshot_id": snapshot_id,
        "manifest_path": _relative_to_project(project_path, manifest_path),
        "snapshot_sha256": manifest_digest,
        "normalized_path": _relative_to_project(project_path, normalized_path),
        "raw_count": len(raw_entries),
    }


def verify_market_snapshot(
    project: Path | str,
    run_id: str,
    manifest_path: str | Path,
) -> dict[str, Any]:
    """Verify bytes, contract, and paths for a stored live research snapshot."""
    project_path = Path(project).expanduser().resolve(strict=False)
    safe_run = _safe_run_id(run_id)
    if not safe_run:
        return {"verified": False, "reason": "invalid_run_id"}
    try:
        manifest_file = _project_regular_file(project_path, manifest_path)
    except (OSError, ValueError) as exc:
        return {"verified": False, "reason": "manifest_missing", "detail": str(exc)}
    expected_prefix = (_market_research_root(project_path, safe_run)).resolve(strict=False)
    try:
        manifest_file.relative_to(expected_prefix)
    except ValueError:
        return {"verified": False, "reason": "manifest_outside_run"}
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"verified": False, "reason": "manifest_invalid", "detail": str(exc)}
    if not isinstance(manifest, dict):
        return {"verified": False, "reason": "manifest_invalid"}
    declared_digest = str(manifest.get("sha256") or "")
    digest_payload = dict(manifest)
    digest_payload.pop("sha256", None)
    if not declared_digest or declared_digest != _sha256_bytes(_canonical_json_bytes(digest_payload)):
        return {"verified": False, "reason": "manifest_sha256_mismatch"}
    if manifest.get("schema_version") != MARKET_SNAPSHOT_SCHEMA_VERSION or manifest.get("run_id") != safe_run:
        return {"verified": False, "reason": "manifest_contract_mismatch"}
    if manifest.get("kind") != "aifios.tikomni.topic-research-snapshot":
        return {"verified": False, "reason": "manifest_contract_mismatch"}
    try:
        source_file = _project_regular_file(project_path, str(manifest.get("source_path") or ""))
    except (OSError, ValueError):
        return {"verified": False, "reason": "source_material_missing"}
    if _sha256_file(source_file) != str(manifest.get("source_sha256") or ""):
        return {"verified": False, "reason": "source_material_sha256_mismatch"}
    required = list(manifest.get("required_platforms") or [])
    if (
        not required
        or len(set(required)) != len(required)
        or any(platform not in REQUIRED_MARKET_PLATFORMS for platform in required)
    ):
        return {"verified": False, "reason": "required_platforms_mismatch"}
    if not manifest.get("no_fallback") or manifest.get("used_cache") or manifest.get("used_local_samples"):
        return {"verified": False, "reason": "fallback_contract_mismatch"}
    creator_mode = bool(manifest.get("creator_mode"))
    if creator_mode:
        return {"verified": False, "reason": "creator_mode_not_permitted"}
    checks = manifest.get("platform_checks") if isinstance(manifest.get("platform_checks"), dict) else {}
    ready_platforms = [
        platform for platform in manifest.get("ready_platforms") or []
        if platform in required
    ]
    if not ready_platforms:
        ready_platforms = [
            platform for platform in required
            if (checks.get(platform) or {}).get("status") == "available"
            and int((checks.get(platform) or {}).get("sample_count") or 0) >= REQUIRED_SAMPLES_PER_PLATFORM
        ]
    if not ready_platforms:
        return {"verified": False, "reason": "platform_health_failed"}
    if any((checks.get(platform) or {}).get("status") != "available" for platform in ready_platforms):
        return {"verified": False, "reason": "platform_health_failed"}
    if any(int((checks.get(platform) or {}).get("sample_count") or 0) < REQUIRED_SAMPLES_PER_PLATFORM for platform in ready_platforms):
        return {"verified": False, "reason": "platform_evidence_insufficient"}
    raw_entries = manifest.get("raw_entries") if isinstance(manifest.get("raw_entries"), list) else []
    source_platforms = {str(entry.get("platform") or "") for entry in raw_entries if isinstance(entry, dict)}
    if not raw_entries or not set(ready_platforms).issubset(source_platforms):
        return {"verified": False, "reason": "raw_evidence_incomplete"}
    for entry in raw_entries:
        if not isinstance(entry, dict):
            return {"verified": False, "reason": "raw_entry_invalid"}
        try:
            raw_file = _project_regular_file(project_path, str(entry.get("path") or ""))
        except (OSError, ValueError):
            return {"verified": False, "reason": "raw_snapshot_missing"}
        try:
            raw_file.relative_to(manifest_file.parent / "raw")
        except ValueError:
            return {"verified": False, "reason": "raw_snapshot_outside_manifest"}
        if _sha256_file(raw_file) != str(entry.get("sha256") or ""):
            return {"verified": False, "reason": "raw_snapshot_sha256_mismatch"}
    try:
        normalized_file = _project_regular_file(project_path, str(manifest.get("normalized_path") or ""))
    except (OSError, ValueError):
        return {"verified": False, "reason": "normalized_snapshot_missing"}
    if _sha256_file(normalized_file) != str(manifest.get("normalized_sha256") or ""):
        return {"verified": False, "reason": "normalized_snapshot_sha256_mismatch"}
    return {
        "verified": True,
        "run_id": safe_run,
        "snapshot_id": manifest.get("snapshot_id"),
        "manifest_path": _relative_to_project(project_path, manifest_file),
        "snapshot_sha256": declared_digest,
        "source_path": str(manifest.get("source_path") or ""),
        "source_sha256": str(manifest.get("source_sha256") or ""),
        "queries": manifest.get("queries") or [],
        "required_platforms": required,
        "ready_platforms": ready_platforms,
    }


def freeze_market_snapshot(project: Path | str, run_id: str, manifest_path: str | Path) -> dict[str, Any]:
    """Bind the exact verified snapshot once topic/template receives approval."""
    project_path = Path(project).expanduser().resolve(strict=False)
    safe_run = _safe_run_id(run_id)
    verification = verify_market_snapshot(project_path, safe_run, manifest_path)
    if not verification.get("verified"):
        raise ValueError(f"TikOmni 快照不能冻结：{verification.get('reason') or '完整性校验失败'}")
    freeze_path = _market_research_root(project_path, safe_run) / "frozen-snapshot.json"
    freeze_without_digest = {
        "schema_version": MARKET_SNAPSHOT_SCHEMA_VERSION,
        "kind": "aifios.tikomni.frozen-topic-research",
        "run_id": safe_run,
        "manifest_path": verification["manifest_path"],
        "snapshot_sha256": verification["snapshot_sha256"],
        "frozen_at": datetime.now().astimezone().isoformat(),
    }
    freeze_payload = {
        **freeze_without_digest,
        "sha256": _sha256_bytes(_canonical_json_bytes(freeze_without_digest)),
    }
    if freeze_path.exists():
        try:
            existing = json.loads(freeze_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError("已存在的 TikOmni 冻结记录不可读取，不能覆盖") from exc
        if (
            isinstance(existing, dict)
            and existing.get("manifest_path") == freeze_payload["manifest_path"]
            and existing.get("snapshot_sha256") == freeze_payload["snapshot_sha256"]
        ):
            return {"frozen": True, "already_frozen": True, **freeze_payload}
        raise ValueError("本 run 的 TikOmni 研究快照已冻结，不能替换为后续查询结果")
    _write_new_bytes(freeze_path, _canonical_json_bytes(freeze_payload))
    return {"frozen": True, "already_frozen": False, **freeze_payload}


def verify_frozen_market_snapshot(project: Path | str, run_id: str) -> dict[str, Any]:
    """Validate that a run still points to the same immutable approved data."""
    project_path = Path(project).expanduser().resolve(strict=False)
    safe_run = _safe_run_id(run_id)
    if not safe_run:
        return {"verified": False, "reason": "invalid_run_id"}
    freeze_path = _market_research_root(project_path, safe_run) / "frozen-snapshot.json"
    if not freeze_path.is_file() or freeze_path.is_symlink():
        return {"verified": False, "reason": "frozen_snapshot_missing"}
    try:
        frozen = json.loads(freeze_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"verified": False, "reason": "frozen_snapshot_invalid", "detail": str(exc)}
    if not isinstance(frozen, dict) or frozen.get("run_id") != safe_run:
        return {"verified": False, "reason": "frozen_snapshot_contract_mismatch"}
    frozen_without_digest = dict(frozen)
    declared_freeze_digest = str(frozen_without_digest.pop("sha256", "") or "")
    if not declared_freeze_digest or declared_freeze_digest != _sha256_bytes(_canonical_json_bytes(frozen_without_digest)):
        return {"verified": False, "reason": "frozen_snapshot_sha256_mismatch"}
    verification = verify_market_snapshot(project_path, safe_run, str(frozen.get("manifest_path") or ""))
    if not verification.get("verified"):
        return {"verified": False, "reason": "snapshot_integrity_failed", "detail": verification.get("reason")}
    if verification.get("snapshot_sha256") != frozen.get("snapshot_sha256"):
        return {"verified": False, "reason": "frozen_snapshot_digest_mismatch"}
    return {"verified": True, "frozen_at": frozen.get("frozen_at"), **verification}


def _safe_run_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value or "").strip()).strip("-")[:80]


def _safe_filename(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value or "").strip()).strip("-")[:60] or "query"


def _market_research_root(project: Path, run_id: str) -> Path:
    return project / "runs" / run_id / "market-research"


def _canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_new_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(payload)
    except FileExistsError as exc:
        raise RuntimeError(f"不可变 TikOmni 快照文件已存在: {path.name}") from exc


def _relative_to_project(project: Path, path: Path) -> str:
    return path.resolve(strict=False).relative_to(project.resolve(strict=False)).as_posix()


def _safe_project_relative(value: str) -> str:
    candidate = str(value or "").replace("\\", "/").lstrip("/")
    if not candidate or ".." in candidate.split("/"):
        raise ValueError("source_path 必须是项目内相对路径")
    return candidate


def _project_regular_file(project: Path, value: str | Path) -> Path:
    candidate = (project / str(value)).resolve(strict=False) if not Path(value).is_absolute() else Path(value).resolve(strict=False)
    try:
        candidate.relative_to(project.resolve(strict=False))
    except ValueError as exc:
        raise ValueError("快照文件必须位于项目目录内") from exc
    if not candidate.is_file() or candidate.is_symlink():
        raise OSError("快照文件不存在或不是普通文件")
    return candidate


def score_theme_option(
    title: str,
    material_text: str,
    market_signals: list[MarketSignal | dict[str, Any]],
    target_platforms: list[str],
    realtime_available: bool,
) -> dict[str, Any]:
    theme = _theme_by_title(title)
    keywords = theme["keywords"] if theme else re.findall(r"[\u4e00-\u9fffA-Za-z0-9]{2,}", title)
    material_hits = sum(1 for keyword in keywords if keyword.lower() in material_text.lower())
    material_score = min(30, 12 + material_hits * 5)

    signals = _coerce_signals(market_signals)
    signal_keywords = _signal_keywords(keywords)
    matching_signals = []
    for signal in signals:
        haystack = f"{signal.title} {signal.hook} {signal.mechanism} {signal.audience_pain}"
        if any(keyword.lower() in haystack.lower() for keyword in signal_keywords):
            matching_signals.append(signal)
    signal_text = "\n".join(f"{s.title} {s.hook} {s.mechanism} {s.audience_pain}" for s in matching_signals)
    signal_hits = sum(1 for keyword in signal_keywords if keyword.lower() in signal_text.lower())
    if realtime_available:
        market_score = min(25, signal_hits * 6 + len(matching_signals) * 2)
    else:
        market_score = min(15, signal_hits * 4 + len(matching_signals))

    platform_labels = _platform_labels(target_platforms)
    recommended = set(theme["platforms"] if theme else ["公众号"])
    platform_score = 15 if not platform_labels or recommended.intersection(platform_labels) else 10

    commercial_score = (
        15
        if re.search(r"合作|经销商|GTM|转化|咨询|样板|出海|获客", material_text + title, re.IGNORECASE)
        else 9
    )

    sensitive_hits = sum(1 for term in SENSITIVE_TERMS if term in material_text)
    hard_number_hits = len(re.findall(r"\d+(?:\.\d+)?\s*(万|亿|%|块|美元|年)", material_text))
    risk_score = max(8, 15 - min(7, sensitive_hits + hard_number_hits // 4))

    total = material_score + market_score + platform_score + commercial_score + risk_score
    return {
        "total": min(100, int(total)),
        "breakdown": {
            "素材支撑": int(material_score),
            "实时爆款信号": int(market_score),
            "平台适配": int(platform_score),
            "商业承接": int(commercial_score),
            "风险可控": int(risk_score),
        },
        "market_note": "已接入实时爆款信号。" if realtime_available else "爆款参考不足：按素材支撑和平台适配优先评分。",
    }


def build_theme_gate_response(
    material_text: str,
    target_platforms: list[str] | None = None,
    project: Path | str | None = None,
    *,
    live_fetcher: Callable[[str, str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    text = str(material_text or "")
    target_platforms = _normalize_platforms(target_platforms or [])
    signal_result = fetch_market_signals(text, target_platforms, project, live_fetcher=live_fetcher)
    if signal_result.get("status") != "ready":
        blockers = signal_result.get("blockers") if isinstance(signal_result.get("blockers"), list) else []
        reason = "；".join(str(item.get("message") or "") for item in blockers if isinstance(item, dict))
        return {
            "body": f"研究快照暂不可用，当前无法绑定本期选题。{reason or '请重新执行本期研究。'}",
            "choice_count": 0,
            "options": [],
            "recommended": "",
            "queries": signal_result.get("queries", []),
            "market_signal_status": "blocked",
            "market_signal_note": signal_result.get("note") or "研究快照暂不可用。",
            "blocked": True,
            "blockers": blockers,
        }
    signals = _coerce_signals(signal_result.get("signals", []))
    realtime_available = bool(signals) and signal_result.get("status") == "ready"
    creator_mode = bool(signal_result.get("creator_mode"))
    excluded_topics = _extract_excluded_topics(text.lower())
    theme_library = _select_theme_library(text, signal_result.get("queries", []), excluded_topics)
    ranked_themes = []
    for theme in theme_library[:DEFAULT_THEME_CHOICE_COUNT]:
        score = score_theme_option(theme["title"], text, signals, target_platforms, realtime_available)
        mechanism = _best_mechanism(theme, signals) or theme["mechanism"]
        ranked_themes.append((theme, score, mechanism))
    ranked_themes.sort(key=lambda item: item[1]["total"], reverse=True)

    rows = []
    options = []
    for index, (theme, score, mechanism) in enumerate(ranked_themes):
        choice = THEME_CHOICES[index]
        platforms = " / ".join(theme["platforms"])
        audience = _theme_audience(theme, text)
        material_evidence = _material_evidence(theme, text)
        rows.append(
            f"| {choice} | {theme['title']} | {audience} | {score['total']} | {mechanism} | "
            f"{theme['reason']} | {theme['risk']} | {platforms} | {material_evidence} |"
        )
        option = dict(theme)
        option.update(
            {
                "choice": choice,
                "audience": audience,
                "score": score["total"],
                "breakdown": score["breakdown"],
                "market_note": score["market_note"],
                "material_evidence": material_evidence,
            }
        )
        options.append(option)
    recommended = options[0]
    note = signal_result.get("note") or "爆款参考不足：按素材支撑和平台适配优先评分。"
    body = f"""先确认一个最值得写的主题。

{note}

| 选项 | 主题 | 推荐受众 | 总分 | 爆款机制参考 | 适合原因 | 风险边界 | 推荐平台 | 素材命中依据 |
|---|---|---|---:|---|---|---|---|---|
{chr(10).join(rows)}

我推荐主题 {recommended['choice']}，默认受众是：{recommended['audience']}。因为它同时满足：素材反复支撑、爆款机制可迁移、商业承接更直接、风险可控。

回复 A-F 中任一主题；如果要换受众，可以写“主题 A + 受众：你想服务的人群”。"""
    for term in FORBIDDEN_GATE_TERMS:
        body = body.replace(term, "")
    return {
        "body": body,
        "choice_count": len(options),
        "options": options,
        "recommended": recommended["choice"],
        "queries": signal_result.get("queries", []),
        "market_signal_status": "creator_mode" if creator_mode else signal_result.get("status"),
        "market_signal_note": note,
        "blocked": False,
        "warning": creator_mode,
        "sufficiency": signal_result.get("sufficiency", {}),
    }


def _extract_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("items", "results", "list", "aweme_list", "notes"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    data = payload.get("data")
    if isinstance(data, dict):
        return _extract_items(data)
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    return []


def _first_text(item: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return re.sub(r"<[^>]+>", "", value).strip()
        if isinstance(value, dict):
            nested = _first_text(value, keys)
            if nested:
                return nested
    return ""


def _normalize_account(item: dict[str, Any]) -> str:
    """Return a compact creator/account label without retaining raw fields."""
    account = _first_text(item, [
        "author", "author_name", "nickname", "account_name", "user_name",
        "publisher", "creator", "user", "owner",
    ])
    return re.sub(r"\s+", " ", account).strip()[:100]


def _normalize_published_at(item: dict[str, Any]) -> str:
    """Keep a display-safe publication timestamp when TikOmni supplies one."""
    value = _first_text(item, [
        "published_at", "publish_time", "publish_at", "created_at", "create_time",
        "release_time", "date", "time",
    ])
    if not value:
        for key in ("published_at", "publish_time", "publish_at", "created_at", "create_time", "timestamp"):
            candidate = item.get(key)
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                seconds = float(candidate)
                if seconds > 10_000_000_000:
                    seconds /= 1000
                if 946_684_800 <= seconds <= 4_102_444_800:
                    try:
                        value = datetime.fromtimestamp(seconds).isoformat(timespec="seconds")
                    except (OverflowError, OSError, ValueError):
                        value = ""
                    break
    compact = re.sub(r"\s+", " ", value).strip()
    # Do not turn arbitrary provider prose into a date label. ISO-like values
    # and common Chinese date formats are enough for the research browser.
    if re.fullmatch(r"[0-9T:\-+/. 年月日]{4,64}", compact):
        return compact[:64]
    return ""


def _normalize_content_form(platform: str, item: dict[str, Any]) -> str:
    """Map provider type hints to a small, UI-safe content-form vocabulary."""
    raw = _first_text(item, ["content_form", "content_type", "media_type", "note_type", "type", "kind", "format"]).lower()
    if any(token in raw for token in ("video", "视频", "aweme", "reel", "clip")):
        return "视频"
    if any(token in raw for token in ("live", "直播")):
        return "直播"
    if any(token in raw for token in ("article", "文章", "公众号", "news")):
        return "文章"
    if any(token in raw for token in ("image", "图文", "note", "post", "图")):
        return "图文"
    if platform == "wechat_mp":
        return "文章"
    if platform == "wechat_channels":
        return "视频"
    if platform == "xiaohongshu":
        return "图文/视频"
    return "内容"


def _extract_metrics(item: dict[str, Any]) -> dict[str, int | None]:
    containers = [item]
    for key in ("statistics", "stats", "interact_info", "note_card"):
        value = item.get(key)
        if isinstance(value, dict):
            containers.append(value)
    metrics: dict[str, int | None] = {
        "likes": None,
        "comments": None,
        "shares": None,
        "reads": None,
        "collects": None,
    }
    aliases = {
        "likes": ["likes", "like_count", "digg_count", "liked_count"],
        "comments": ["comments", "comment_count", "comments_count"],
        "shares": ["shares", "share_count", "share_num", "shared_count"],
        "reads": ["reads", "read_count", "view_count", "play_count"],
        "collects": ["collects", "collect_count", "collected_count"],
    }
    for metric, keys in aliases.items():
        for container in containers:
            for key in keys:
                value = container.get(key)
                parsed: int | None = None
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    parsed = max(0, int(value))
                elif isinstance(value, str):
                    parsed = _parse_count(value)
                if parsed is not None:
                    current = metrics[metric]
                    metrics[metric] = parsed if current is None else max(current, parsed)
    return metrics


def _parse_count(value: str) -> int | None:
    text = value.strip().lower().replace(",", "")
    match = re.search(r"(\d+(?:\.\d+)?)", text)
    if not match:
        return None
    number = float(match.group(1))
    if "w" in text or "万" in text:
        number *= 10000
    if "k" in text or "千" in text:
        number *= 1000
    return int(number)


def _normalize_platforms(target_platforms: list[str]) -> list[str]:
    if not target_platforms:
        return list(REQUIRED_MARKET_PLATFORMS)
    normalized: list[str] = []
    for value in target_platforms:
        platform = normalize_market_platform(value)
        if platform not in normalized:
            normalized.append(platform)
    return [platform for platform in REQUIRED_MARKET_PLATFORMS if platform in normalized]


def _platform_labels(target_platforms: list[str]) -> set[str]:
    labels = set()
    for platform in target_platforms:
        try:
            key = normalize_market_platform(str(platform))
        except ValueError:
            key = str(platform)
        labels.add(MARKET_PLATFORM_LABELS.get(key, str(platform)))
    return labels


def _normalize_platform_key(platform: Any) -> str:
    return normalize_market_platform(str(platform or ""))


def _theme_by_title(title: str) -> dict[str, Any] | None:
    for library in _theme_libraries():
        for theme in library:
            if theme["title"] == title:
                return theme
    return None


def _theme_libraries() -> list[list[dict[str, Any]]]:
    return [
        THEME_LIBRARY,
        READING_THEME_LIBRARY,
        SERVICE_THEME_LIBRARY,
        GENERIC_THEME_LIBRARY,
    ]


def _select_theme_library(
    material_text: str,
    queries: list[str],
    excluded_topics: set[str] | None = None,
) -> list[dict[str, Any]]:
    excluded_topics = excluded_topics or set()
    if ENTERPRISE_THEME_QUERIES.intersection(queries):
        return _without_excluded_themes(THEME_LIBRARY, excluded_topics)
    text = str(material_text or "").lower()
    if _contains_any(text, ["阅读", "读书", "笔记", "周末", "社区阅读"]):
        return _without_excluded_themes(READING_THEME_LIBRARY, excluded_topics)
    if _contains_any(text, ["门店", "排队", "服务流程", "工作人员", "产品体验", "市场反馈", "提醒"]):
        return _without_excluded_themes(SERVICE_THEME_LIBRARY, excluded_topics)
    return _without_excluded_themes(GENERIC_THEME_LIBRARY, excluded_topics)


def _contains_any(text: str, keywords: list[str]) -> bool:
    return any(keyword.lower() in text for keyword in keywords)


def _without_excluded_themes(
    themes: list[dict[str, Any]],
    excluded_topics: set[str],
) -> list[dict[str, Any]]:
    filtered = [
        theme
        for theme in themes
        if not _theme_matches_excluded_topics(theme, excluded_topics)
    ]
    seen_titles = {theme["title"] for theme in filtered}
    for theme in GENERIC_THEME_LIBRARY:
        if len(filtered) >= DEFAULT_THEME_CHOICE_COUNT:
            break
        if _theme_matches_excluded_topics(theme, excluded_topics):
            continue
        if theme["title"] not in seen_titles:
            filtered.append(theme)
            seen_titles.add(theme["title"])
    return filtered[:DEFAULT_THEME_CHOICE_COUNT]


def _theme_matches_excluded_topics(theme: dict[str, Any], excluded_topics: set[str]) -> bool:
    if THEME_EXCLUDED_TOPICS.get(theme["title"], set()).intersection(excluded_topics):
        return True
    haystack = " ".join(
        [
            str(theme.get("title", "")),
            str(theme.get("reason", "")),
            str(theme.get("risk", "")),
            " ".join(str(keyword) for keyword in theme.get("keywords", [])),
        ]
    )
    for topic in excluded_topics:
        patterns = EXCLUDED_TOPIC_PATTERNS.get(topic, [])
        if any(re.search(pattern, haystack, flags=re.IGNORECASE) for pattern in patterns):
            return True
    return False


def _best_mechanism(theme: dict[str, Any], signals: list[MarketSignal | dict[str, Any]]) -> str:
    keywords = _signal_keywords(theme.get("keywords", []))
    for signal in _coerce_signals(signals):
        haystack = f"{signal.title} {signal.hook} {signal.audience_pain}"
        if any(keyword.lower() in haystack.lower() for keyword in keywords):
            return signal.mechanism
    return ""


def _material_evidence(theme: dict[str, Any], material_text: str) -> str:
    hits = []
    lower_text = material_text.lower()
    for keyword in theme.get("keywords", []):
        keyword_text = str(keyword).strip()
        if keyword_text and keyword_text.lower() in lower_text and keyword_text not in hits:
            hits.append(keyword_text)
    if hits:
        return f"素材命中：{'、'.join(hits[:4])}"
    return "素材命中：需人工确认"


def _theme_audience(theme: dict[str, Any], material_text: str) -> str:
    haystack = " ".join(
        [
            str(theme.get("title", "")),
            str(theme.get("reason", "")),
            " ".join(str(keyword) for keyword in theme.get("keywords", [])),
            material_text[:120],
        ]
    )
    if re.search(r"经销商|老板|GTM|出海|供应链|产品力|流量|AI|AIGC|智能体", haystack, re.IGNORECASE):
        return "传统企业老板 / 业务负责人 / 内容获客操盘手"
    if re.search(r"阅读|读书|笔记|周末|社区", haystack, re.IGNORECASE):
        return "想把阅读和日常经验写成内容的个人创作者"
    if re.search(r"门店|排队|服务流程|工作人员|产品体验|市场反馈", haystack, re.IGNORECASE):
        return "门店经营者 / 服务流程负责人 / 用户体验负责人"
    if re.search(r"评论区|受众|读者|互动", haystack, re.IGNORECASE):
        return "需要通过内容收集问题的创始人或内容负责人"
    return "需要把素材转成可发布内容的创始人或内容负责人"


def _signal_keywords(keywords: list[str]) -> list[str]:
    return [keyword for keyword in keywords if keyword not in WEAK_SIGNAL_MATCH_KEYWORDS]


def _coerce_signals(signals: Any) -> list[MarketSignal]:
    if not isinstance(signals, list):
        return []
    coerced = []
    for signal in signals:
        coerced_signal = _coerce_signal(signal)
        if coerced_signal is not None:
            coerced.append(coerced_signal)
    return coerced


def _coerce_signal(signal: MarketSignal | dict[str, Any]) -> MarketSignal | None:
    if isinstance(signal, MarketSignal):
        return MarketSignal(
            provider=signal.provider,
            platform=signal.platform,
            query=signal.query,
            title=signal.title,
            hook=signal.hook,
            metrics=signal.metrics,
            mechanism=_safe_signal_mechanism(signal.mechanism, signal.title, signal.hook, signal.audience_pain),
            audience_pain=signal.audience_pain,
            source_url=signal.source_url,
            captured_at=signal.captured_at,
            account=signal.account,
            published_at=signal.published_at,
            content_form=signal.content_form,
            sample_class=signal.sample_class,
            hit_score=signal.hit_score,
            classification_reason=signal.classification_reason,
            evidence_status=signal.evidence_status,
            confidence=signal.confidence,
            metric_completeness=signal.metric_completeness,
            age_days=signal.age_days,
            score_components=dict(signal.score_components or {}),
            creator_baseline=signal.creator_baseline,
            creator_lift=signal.creator_lift,
            engagement_rate=signal.engagement_rate,
            score_version=signal.score_version,
        )
    if not isinstance(signal, dict):
        return None
    metrics = signal.get("metrics", {})
    if not isinstance(metrics, dict):
        metrics = {}
    title = str(signal.get("title", ""))
    hook = str(signal.get("hook", ""))
    audience_pain = str(signal.get("audience_pain", ""))
    return MarketSignal(
        provider=str(signal.get("provider", "")),
        platform=str(signal.get("platform", "")),
        query=str(signal.get("query", "")),
        title=title,
        hook=hook,
        metrics={str(key): _safe_metric(value) for key, value in metrics.items()},
        mechanism=_safe_signal_mechanism(str(signal.get("mechanism", "")), title, hook, audience_pain),
        audience_pain=audience_pain,
        source_url=str(signal.get("source_url", "")),
        captured_at=str(signal.get("captured_at", "")),
        account=str(signal.get("account", "")),
        published_at=str(signal.get("published_at", "")),
        content_form=str(signal.get("content_form", "")),
        sample_class=str(signal.get("sample_class", "related")),
        hit_score=_safe_int(signal.get("hit_score", 0)),
        classification_reason=str(signal.get("classification_reason", "")),
        evidence_status=str(signal.get("evidence_status", "insufficient")),
        confidence=_safe_int(signal.get("confidence", 0)),
        metric_completeness=_safe_float(signal.get("metric_completeness")),
        age_days=_safe_optional_float(signal.get("age_days")),
        score_components={
            str(key): _safe_float(value)
            for key, value in (signal.get("score_components") or {}).items()
        } if isinstance(signal.get("score_components"), dict) else {},
        creator_baseline=_safe_optional_float(signal.get("creator_baseline")),
        creator_lift=_safe_optional_float(signal.get("creator_lift")),
        engagement_rate=_safe_optional_float(signal.get("engagement_rate")),
        score_version=str(signal.get("score_version", "echo-founder.tikomni-hit-score.v5")),
    )


def _safe_signal_mechanism(mechanism: str, title: str, hook: str, audience_pain: str) -> str:
    text = str(mechanism or "").strip()
    parts = [part.strip() for part in text.split("+") if part.strip()]
    if (
        text
        and "\n" not in text
        and "\r" not in text
        and "|" not in text
        and parts
        and all(part in SAFE_SIGNAL_MECHANISM_PARTS for part in parts)
    ):
        return " + ".join(parts[:2])
    return infer_mechanism(title, hook, audience_pain)


def _safe_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return _parse_count(value) or 0
    return 0


def _safe_optional_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    return None


def _safe_float(value: Any) -> float:
    return _safe_optional_float(value) or 0.0


def _safe_metric(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return max(0, int(value))
    if isinstance(value, str):
        return _parse_count(value)
    return None

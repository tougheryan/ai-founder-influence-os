#!/usr/bin/env python3
"""Echo Founder content quality gate.

Runs a lightweight, deterministic rubric against WeChat/XHS outputs and
writes a review report under the project quality directory.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from content_runtime import ContentRuntime


PLATFORM_STEP = {
    "wechat": "write",
    "xhs": "xhs",
}

PLATFORM_LABEL = {
    "wechat": "公众号",
    "xhs": "小红书",
}

PLATFORM_ALIASES = {
    "公众号": "wechat",
    "wechat": "wechat",
    "小红书": "xhs",
    "xhs": "xhs",
    "xiaohongshu": "xhs",
}

QUALITY_STEP_PREFIX = {
    "write": "pipeline/final/",
    "xhs": "pipeline/xhs/",
    "package": "pipeline/package/",
}

GOLDEN_RUBRICS = {
    "wechat": [
        ("opening_scene", "开头进入具体场景", r"场景|很多|当|如果|第一篇|误区|不是"),
        ("longform_structure", "有长文结构和展开", r"^##\s+|时代|变化|结构|信任", re.MULTILINE),
        ("trust_loop", "回到商业信任", r"信任|咨询|服务|交付|客户|交易成本"),
    ],
    "xhs": [
        ("cover_signal", "封面/标题第一眼清楚", r"封面|标题|第一张|卡片|三行"),
        ("scanable_notes", "正文可扫读", r"(^- |\n\d+\.|步骤|判断标准|适合谁)", re.MULTILINE),
        ("comment_demand", "能承接评论需求", r"评论|怎么做|多少钱|适合谁|私信|问题"),
    ],
}

STYLE_AUDIT_RULES = {
    "deep-narrative": {
        "label": "深度叙事型",
        "patterns": [r"场景|故事|事情|人物|细节", r"时代|变化|长期|结构|周期|文化|历史", r"转折|后来|直到|发现|回到"],
        "recommendation": "补出具体场景、人物细节、叙事转折和时代洞察，避免只有观点平铺。",
    },
    "founder-rise-fall": {
        "label": "企业家兴衰叙事型",
        "patterns": [r"企业家|创始人|公司|团队", r"时间线|关键决策|转折|高光|失败|周期", r"财报|公告|公开报道|来源|截至|公开"],
        "recommendation": "补公开时间线、关键决策和多方事实，避免把兴衰写成单因归因或道德审判。",
    },
    "business-insight": {
        "label": "商业洞察型",
        "patterns": [r"客户|业务|产品|服务|成交|转化", r"信任|交易成本|商业|增长|获客", r"误区|判断框架|机制|痛点|咨询"],
        "recommendation": "补客户处境、商业机制和可复述判断，避免把商业洞察写成泛泛观点。",
    },
    "method-playbook": {
        "label": "复盘方法论型",
        "patterns": [r"方法|步骤|清单|判断标准|具体怎么做", r"复盘|做对|做错|踩坑|失败|如果重来", r"可以先|下一步|第一步|动作|检查"],
        "recommendation": "补可执行步骤、做对做错和失败成本，让读者能照着检查或行动。",
    },
    "product-experience": {
        "label": "产品体验型",
        "patterns": [r"产品|工具|Codex|DeepSeek|模型|工作流", r"体验|实测|测试|使用|亲自|操作|页面|截图|代码", r"失败片段|人工把关|跑通|输出|对比"],
        "recommendation": "补真实使用过程、操作细节、失败片段和人工把关，不要把产品体验写成观点评论。",
    },
    "interview-speech": {
        "label": "访谈演讲转写型",
        "patterns": [r"访谈|采访|演讲|圆桌|播客|嘉宾|主讲", r"原话|他说|她说|提问|问答|现场|转录", r"观点|金句|分享|活动|二次传播"],
        "recommendation": "补现场感、原话和主讲人观点结构，避免把访谈稿改成失去说话人质感的评论稿。",
    },
    "hotspot-analysis": {
        "label": "热点解读型",
        "patterns": [r"热点|最近|今天|发布|新闻|政策|模型发布|行业动态", r"公告|报告|公开来源|多方|截至|来源", r"影响|短期|长期|预判|不确定"],
        "recommendation": "补最新公开来源、多方口径、影响范围和不确定性，避免过期信息或断言未来。",
    },
    "case-breakdown": {
        "label": "案例拆解型",
        "patterns": [r"客户案例|项目案例|案例|交付|客户", r"行动链路|采取动作|结果|反馈|前后对比|成交|转化", r"授权|匿名|不公开客户名|结果口径"],
        "recommendation": "补授权边界、问题场景、行动链路和结果口径，避免未授权细节或夸大成效。",
    },
    "personal-reflection": {
        "label": "个人成长反思型",
        "patterns": [r"我|自己|真实经历|第一次|最近|选择", r"压力|焦虑|迷茫|长期主义|心态|内心", r"反思|转折|重新理解|不确定|边界"],
        "recommendation": "补真实经历、情绪节点和反思边界，避免泛鸡汤或装深沉。",
    },
}

CONTRACT_FIELD_LABELS = {
    "上游 brief": "upstream_brief",
    "推荐风格": "style_line",
    "写作任务卡": "task_card",
    "证据台账": "evidence_ledger",
    "文章骨架": "article_outline",
    "必用证据": "required_evidence",
    "传播心理兑现": "psychology_fulfillment",
    "风险边界": "risk_boundary",
    "商业收口": "commercial_close",
    "质检结论": "quality_conclusion",
}


@dataclass
class CheckItem:
    id: str
    label: str
    passed: bool
    points: int
    max_points: int
    reason: str
    severity: str = "score"


@dataclass
class ClaimItem:
    text: str
    value: str
    context: str
    has_source_signal: bool
    has_time_signal: bool
    risk: str


@dataclass
class DeliveryAuditItem:
    id: str
    category: str
    label: str
    passed: bool
    points: int
    max_points: int
    evidence: str
    recommendation: str
    severity: str = "review"


def normalize_platform(value: str) -> str:
    key = str(value or "").strip().lower()
    platform = PLATFORM_ALIASES.get(key)
    if not platform:
        raise ValueError(f"未知平台: {value}，可用: wechat, xhs")
    return platform


def assert_quality_scope(rt: ContentRuntime, platform: str, path: str | Path | None = None, step: str | None = None) -> None:
    """Quality reports may inspect a platform draft or its validated content package."""
    expected_step = PLATFORM_STEP[platform]
    if step and step not in {expected_step, "package"}:
        raise ValueError(
            f"质量验收平台 {PLATFORM_LABEL[platform]} 只能读取 `{expected_step}` 成稿或 `package` 发布包，不能读取 `{step}`。"
        )
    if path is None:
        return
    rel = project_relative(rt, str(path)).replace("\\", "/").lstrip("/")
    if rel.startswith(QUALITY_STEP_PREFIX["package"]):
        return
    expected_prefix = QUALITY_STEP_PREFIX[expected_step]
    if rel.split("/").count("..") or not rel.startswith(expected_prefix):
        raise ValueError(
            "质量验收文件必须是对应平台的最终成稿或已校验发布包："
            "公众号使用 pipeline/final/，小红书使用 pipeline/xhs/，多平台发布包使用 pipeline/package/。"
        )


def strip_frontmatter(text: str) -> str:
    match = re.match(r"^---\n.*?\n---\n\n?(.*)$", text, re.DOTALL)
    return match.group(1) if match else text


def strip_delivery_check(text: str) -> str:
    """质量评分只看可见正文，隐藏交付自检块只用于追溯。"""
    return re.sub(r"<!--\s*AIFIOS-WRITE-CHECK\b.*?-->", "", text or "", flags=re.DOTALL)


def extract_delivery_check(text: str) -> str:
    match = re.search(r"<!--\s*AIFIOS-WRITE-CHECK\b(.*?)-->", text or "", flags=re.DOTALL)
    return match.group(1).strip() if match else ""


def parse_style_contract(raw_text: str) -> dict[str, Any] | None:
    block = extract_delivery_check(raw_text)
    if not block:
        return None
    style_line = next((line.strip() for line in block.splitlines() if "推荐风格" in line), "")
    if not style_line:
        return {"raw": block, "line": "", "final_style": ""}
    final_style = ""
    for pattern in [
        r"最终采用[：:]\s*([a-z][a-z-]+)",
        r"推荐风格\s*-\s*([a-z][a-z-]+)",
        r"推荐风格[：:]\s*([a-z][a-z-]+)",
    ]:
        match = re.search(pattern, style_line, re.IGNORECASE)
        if match:
            final_style = match.group(1).strip()
            break
    return {"raw": block, "line": style_line, "final_style": final_style}


def parse_delivery_contract(raw_text: str) -> dict[str, Any] | None:
    block = extract_delivery_check(raw_text)
    if not block:
        return None
    fields: dict[str, str] = {}
    for line in block.splitlines():
        clean = line.strip()
        if not clean:
            continue
        for label, key in CONTRACT_FIELD_LABELS.items():
            if clean.startswith(label):
                value = re.sub(rf"^{re.escape(label)}\s*[-：:]\s*", "", clean).strip()
                fields[key] = value
                break
    required = [key for key in CONTRACT_FIELD_LABELS.values()]
    missing = [key for key in required if not fields.get(key)]
    conclusion = fields.get("quality_conclusion", "")
    return {
        "raw": block,
        "fields": fields,
        "missing_fields": missing,
        "quality_conclusion": conclusion,
        "declared_review": "review" in conclusion.lower(),
        "declared_pass": "pass" in conclusion.lower(),
    }


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def contains(text: str, pattern: str) -> bool:
    return re.search(pattern, text, re.IGNORECASE) is not None


def contains_with_flags(text: str, pattern: str, flags: int = 0) -> bool:
    return re.search(pattern, text, re.IGNORECASE | flags) is not None


def item(check_id: str, label: str, passed: bool, max_points: int, reason: str) -> CheckItem:
    return CheckItem(
        id=check_id,
        label=label,
        passed=passed,
        points=max_points if passed else 0,
        max_points=max_points,
        reason=reason,
    )


def gate_item(check_id: str, label: str, passed: bool, reason: str, severity: str = "block") -> CheckItem:
    return CheckItem(
        id=check_id,
        label=label,
        passed=passed,
        points=0,
        max_points=0,
        reason=reason,
        severity=severity,
    )


def hard_claims(text: str) -> list[ClaimItem]:
    plain = compact(text)
    pattern = re.compile(r"\d+(?:\.\d+)?\s*(?:万|亿|%|元|美元|美金|人|次|篇|条|小时|天|年)")
    claims: list[ClaimItem] = []
    for match in pattern.finditer(plain):
        start = max(0, match.start() - 45)
        end = min(len(plain), match.end() + 45)
        context = plain[start:end]
        source_signal = contains(context, r"约|大概|估算|来源|根据|数据来自|公开|官方|公告|报告|调研|财报|统计|显示|左右|近似|口径")
        time_signal = contains(context, r"截至|截止|202\d|20\d{2}|今年|去年|本月|上月|本周|今天|昨日|日前|季度|Q[1-4]|近\s*\d+\s*(?:天|周|月|年)")
        if not source_signal:
            risk = "needs_source"
        elif not time_signal and contains(match.group(0), r"%|万|亿|元|美元|美金|人|次|篇|条"):
            risk = "needs_time"
        else:
            risk = "ok"
        claims.append(ClaimItem(
            text=match.group(0),
            value=match.group(0),
            context=context,
            has_source_signal=source_signal,
            has_time_signal=time_signal,
            risk=risk,
        ))
    return claims


HYPE_NEGATION_RE = re.compile(r"(?:不|非|无|未|勿|别|避免|禁止|不能|不作|不是|不应|不该|拒绝)[^。！？；;]{0,12}$")


def has_unqualified_hype(text: str, terms: tuple[str, ...]) -> bool:
    """Flag promotional claims, while allowing explicit risk-boundary disclaimers."""
    plain = compact(text)
    for term in terms:
        for match in re.finditer(re.escape(term), plain, re.IGNORECASE):
            context = plain[max(0, match.start() - 18):match.start()]
            if HYPE_NEGATION_RE.search(context):
                continue
            return True
    return False


def gate_checks(platform: str, text: str, claims: list[ClaimItem]) -> list[CheckItem]:
    plain = compact(text)
    severe_hype = has_unqualified_hype(plain, ("稳赚", "保证", "100%", "唯一", "最强", "暴富", "躺赚"))
    has_title_or_heading = bool(re.search(r"^#\s+.+", text, re.MULTILINE)) or len(plain[:80]) >= 8
    has_body = len(plain) >= 180
    unsourced_claims = [claim for claim in claims if claim.risk == "needs_source"]
    stale_claims = [claim for claim in claims if claim.risk == "needs_time"]
    gates = [
        gate_item("gate_title", "有可交付标题或明确开头", has_title_or_heading, "交付稿必须能被客户识别为完整产物。"),
        gate_item("gate_body", "正文达到最小交付长度", has_body, "内容过短时不能进入客户交付。"),
        gate_item("gate_no_severe_hype", "无阻断级夸大承诺", not severe_hype, "命中稳赚、保证、100% 等高风险表达时必须修改。"),
        gate_item("gate_claim_sources", "硬数字具备来源或保守口径", not unsourced_claims, "硬数字缺少来源、口径或保守表达时必须人工复核。"),
        gate_item("gate_claim_freshness", "硬数字具备时间口径", not stale_claims, "硬数字有来源但缺少截至时间、统计周期或口径时，建议交付前补齐。", "review"),
    ]
    if platform == "wechat":
        gates.append(gate_item(
            "gate_wechat_structure",
            "公众号具备长文结构",
            text.count("##") >= 1 or len(plain) >= 800,
            "公众号交付稿至少要有分段结构或足够展开。",
            "review",
        ))
    elif platform == "xhs":
        gates.append(gate_item(
            "gate_xhs_scanable",
            "小红书可扫读",
            text.count("- ") >= 2 or contains(plain, r"封面|标题|卡片|1\.|2\.|3\."),
            "小红书交付稿需要封面/标题/卡片/列表等可扫读结构。",
            "review",
        ))
    return gates


def common_checks(text: str) -> list[CheckItem]:
    plain = compact(text)
    hard_number_risk = contains(plain, r"\d+(?:\.\d+)?\s*(?:万|亿|%|元|美元|美金)")
    hype_risk = has_unqualified_hype(plain, ("暴富", "躺赚", "稳赚", "必然", "100%", "最强", "唯一", "保证", "封神", "爆单"))
    return [
        item(
            "target_reader",
            "目标用户明确",
            contains(plain, r"创始人|创业者|老板|客户|用户|读者|普通人|你"),
            12,
            "需要让读者知道这条内容写给谁。",
        ),
        item(
            "pain_or_context",
            "有具体痛点或场景",
            contains(plain, r"痛点|困境|问题|卡住|误区|场景|为什么|不是|踩坑"),
            12,
            "内容不能只表达观点，要落到具体处境。",
        ),
        item(
            "commercial_loop",
            "有商业闭环但不过度销售",
            contains(plain, r"咨询|私信|产品|服务|成交|信任|转化|购买|交付|客户"),
            12,
            "获客内容至少要解释信任或转化路径。",
        ),
        item(
            "hard_number_safety",
            "硬数字风险可控",
            not hard_number_risk or contains(plain, r"约|大概|估算|来源|根据|数据来自|公开"),
            10,
            "出现硬数字时需要来源、口径或保守表达。",
        ),
        item(
            "anti_hype",
            "无明显夸大承诺",
            not hype_risk,
            10,
            "避免广告法、平台风控和信任损耗。",
        ),
    ]


def platform_checks(platform: str, text: str) -> list[CheckItem]:
    plain = compact(text)
    if platform == "wechat":
        return [
            item(
                "wechat_opening",
                "开头不是口号",
                contains(plain[:400], r"场景|很多|一个|当|如果|不是|第一篇|开头"),
                11,
                "公众号长文开头要从场景或误区进入。",
            ),
            item(
                "wechat_depth",
                "有长文展开空间",
                len(plain) >= 800 or text.count("##") >= 2,
                11,
                "交付稿应能展开时代变化、创业者处境或方法论。",
            ),
            item(
                "wechat_insight",
                "有时代/信任/交易成本洞察",
                contains(plain, r"时代|变化|信任|交易成本|渠道|出海|结构|长期"),
                10,
                "公众号不能只做短笔记扩写。",
            ),
        ]
    if platform == "xhs":
        return [
            item(
                "xhs_cover_title",
                "封面/标题信号明确",
                contains(plain, r"封面|标题|第一张|卡片|三行|18|30|反常识"),
                11,
                "小红书需要第一眼能读懂。",
            ),
            item(
                "xhs_note_style",
                "像笔记而不是公众号缩写",
                text.count("- ") >= 3 or contains(plain, r"1\.|2\.|3\.|判断标准|步骤"),
                11,
                "小红书正文要可扫读。",
            ),
            item(
                "xhs_comment_demand",
                "能承接评论需求",
                contains(plain, r"评论|怎么做|多少钱|适合谁|卡在|问题|私信"),
                10,
                "小红书获客依赖评论区需求识别。",
            ),
        ]
    return []


def evidence_for(text: str, pattern: str, flags: int = 0, window: int = 42) -> str:
    match = re.search(pattern, text, re.IGNORECASE | flags)
    if not match:
        return ""
    start = max(0, match.start() - window)
    end = min(len(text), match.end() + window)
    return compact(text[start:end])


def audit_item(
    audit_id: str,
    category: str,
    label: str,
    passed: bool,
    max_points: int,
    evidence: str,
    recommendation: str,
    severity: str = "review",
) -> DeliveryAuditItem:
    return DeliveryAuditItem(
        id=audit_id,
        category=category,
        label=label,
        passed=passed,
        points=max_points if passed else 0,
        max_points=max_points,
        evidence=evidence or "未找到足够证据",
        recommendation=recommendation,
        severity=severity,
    )


def paragraph_count(text: str) -> int:
    return len([p for p in re.split(r"\n\s*\n", strip_frontmatter(text)) if compact(p)])


def evidence_type_hits(text: str) -> dict[str, bool]:
    plain = compact(text)
    return {
        "first_hand": contains(plain, r"我|我们|亲自|一手|真实|上周|昨天|最近|第一次|访谈|演讲|现场|项目|客户"),
        "scene": contains(plain, r"凌晨|会议|办公室|页面|截图|代码|评论区|私信|成交|地铁|现场|文档|白板"),
        "quote_or_voice": contains(plain, r"原话|他说|她说|有人问|评论|留言|反馈|问我|提到|觉得|担心"),
        "benchmark": contains(plain, r"爆款|对标|benchmark|hit-library|样本|同领域账号|评论区|封面|标题"),
        "public_source": contains(plain, r"根据|来源|公开|官方|公告|报告|调研|财报|论文|统计|数据显示|截至|截止"),
    }


AI_SLOP_PATTERNS = [
    r"赋能",
    r"闭环",
    r"抓手",
    r"底层逻辑",
    r"认知升级",
    r"系统性",
    r"生态",
    r"矩阵",
    r"壁垒",
    r"长期主义",
    r"降本增效",
    r"价值共创",
    r"飞轮",
    r"重塑",
    r"范式",
    r"全链路",
    r"从 0 到 1|从0到1",
    r"高质量发展",
    r"打造个人 IP",
    r"实现.*增长",
]

PLACEHOLDER_PATTERNS = [
    r"\b(?:TODO|TBD|FIXME|XXX|PLACEHOLDER)\b",
    r"\{\{[^}\n]{1,80}\}\}",
    r"\[[^\]\n]{0,24}(?:待填|待补|待替换|TODO|TBD|placeholder|xxx)[^\]\n]{0,24}\]",
    r"【[^】\n]{0,24}(?:待填|待补|待替换|占位|xxx)[^】\n]{0,24}】",
    r"<[^>\n]{0,24}(?:待填|待补|待替换|占位|xxx)[^>\n]{0,24}>",
    r"待补充|待填写|待替换|待完善|此处补充|此处填写|这里补充|这里填写|占位内容|示例占位",
    r"(?:客户名|项目名|公司名|作者名|标题名)[：:]\s*(?:待填|待补|xxx|XXX|TBD)",
]

CONCRETE_SIGNAL_PATTERN = (
    r"\d|上周|昨天|今天|最近|第一次|客户|项目|会议|页面|截图|代码|"
    r"评论区|私信|成交|访谈|演讲|原话|他说|她说|问我|反馈|"
    r"根据|来源|公开|官方|公告|报告|财报|调研|案例|现场"
)


def ai_slop_hits(text: str) -> list[str]:
    hits: list[str] = []
    for pattern in AI_SLOP_PATTERNS:
        if contains(text, pattern):
            hits.append(pattern)
    return hits


def placeholder_hits(text: str) -> list[str]:
    hits: list[str] = []
    for pattern in PLACEHOLDER_PATTERNS:
        for match in re.finditer(pattern, text or "", re.IGNORECASE):
            hits.append(compact(match.group(0))[:80])
            if len(hits) >= 8:
                return hits
    return hits


def abstract_paragraphs_without_evidence(text: str) -> list[str]:
    rows: list[str] = []
    paragraphs = [compact(p) for p in re.split(r"\n\s*\n", strip_frontmatter(text)) if compact(p)]
    abstract_pattern = r"系统|能力|价值|增长|品牌|影响力|内容|认知|结构|方法论|商业|长期|信任|效率|资产"
    for paragraph in paragraphs:
        if len(paragraph) < 80:
            continue
        abstract_hits = len(re.findall(abstract_pattern, paragraph, re.IGNORECASE))
        concrete = contains(paragraph, CONCRETE_SIGNAL_PATTERN)
        if abstract_hits >= 4 and not concrete:
            rows.append(paragraph[:180])
    return rows[:5]


def split_contract_clauses(value: str) -> list[str]:
    if not value:
        return []
    parts = re.split(r"\s*(?:；|;|、|,|，|\||→|->|=>|/|\n)\s*", value)
    return [part.strip(" -。.!！?？`") for part in parts if compact(part)]


def split_outline_stages(value: str) -> list[str]:
    if not value:
        return []
    parts = re.split(r"\s*(?:→|->|=>|；|;|\n)\s*", value)
    return [part.strip(" -。.!！?？`") for part in parts if compact(part)]


def _contract_tokens(value: str) -> list[str]:
    normalized = re.sub(r"\s+", "", value or "")
    ascii_tokens = re.findall(r"[A-Za-z][A-Za-z0-9_-]{1,}|\d+(?:\.\d+)?", normalized)
    zh = re.sub(r"[^\u4e00-\u9fff]", "", normalized)
    stop_tokens = {
        "一个", "这个", "那个", "自己", "内容", "文章", "客户", "读者", "问题",
        "引导", "商业", "收口", "风险", "边界", "真实", "需要", "可以",
        "进行", "判断", "说明", "不要", "不能", "没有", "使用",
    }
    zh_tokens = []
    for size in (4, 3, 2):
        for idx in range(0, max(0, len(zh) - size + 1)):
            token = zh[idx:idx + size]
            if token and token not in stop_tokens:
                zh_tokens.append(token)
    seen = set()
    tokens = []
    for token in [*ascii_tokens, *zh_tokens]:
        low = token.lower()
        if low not in seen:
            seen.add(low)
            tokens.append(token)
    return tokens[:24]


def contract_clause_visible(text: str, clause: str) -> tuple[bool, str]:
    plain = compact(text)
    normalized_text = re.sub(r"\s+", "", plain)
    normalized_clause = re.sub(r"\s+", "", clause or "")
    if normalized_clause and len(normalized_clause) >= 4 and normalized_clause in normalized_text:
        return True, clause
    tokens = _contract_tokens(clause)
    if not tokens:
        return False, ""
    hits = [token for token in tokens if re.search(re.escape(token), plain, re.IGNORECASE)]
    threshold = min(3, max(2, round(len(tokens) * 0.18)))
    if len(hits) >= threshold:
        return True, "、".join(hits[:5])
    return False, "、".join(hits[:5])


def _contract_visibility_summary(text: str, clauses: list[str]) -> tuple[bool, str]:
    if not clauses:
        return False, "隐藏自检块未声明可核对内容"
    checked = []
    matched = 0
    for clause in clauses:
        visible, evidence = contract_clause_visible(text, clause)
        checked.append(f"{'命中' if visible else '缺失'}:{clause}" + (f"({evidence})" if evidence else ""))
        matched += 1 if visible else 0
    required = max(1, round(len(clauses) * 0.7))
    return matched >= required, "；".join(checked[:6])


def delivery_contract_audit(text: str, contract: dict[str, Any] | None) -> list[DeliveryAuditItem]:
    if not contract:
        return []
    fields = contract.get("fields") or {}
    missing = contract.get("missing_fields") or []
    items = [
        audit_item(
            "delivery_contract_fields",
            "交付契约",
            "隐藏自检块字段完整",
            not missing,
            8,
            "字段完整" if not missing else "缺失字段：" + "、".join(missing),
            "补齐 AIFIOS-WRITE-CHECK 中的上游 brief、推荐风格、写作任务卡、证据台账、文章骨架、必用证据、传播心理兑现、风险边界、商业收口、质检结论。",
        )
    ]

    evidence_clauses = split_contract_clauses(fields.get("required_evidence", ""))
    evidence_passed, evidence_summary = _contract_visibility_summary(text, evidence_clauses)
    items.append(audit_item(
        "contract_required_evidence_visible",
        "交付契约",
        "必用证据已进入可见正文",
        evidence_passed,
        12,
        evidence_summary,
        "把隐藏自检块里的每条必用证据写进可见正文；不能公开的证据要转成匿名场景或保守判断。",
    ))

    psychology_clauses = split_contract_clauses(fields.get("psychology_fulfillment", ""))
    psychology_passed, psychology_summary = _contract_visibility_summary(text, psychology_clauses)
    psychology_signal = contains(text, r"焦虑|不安全感|怕|兴奋|希望|掌控感|被理解|站在|处境|确认|挑战|信念|还想听|下一篇|模板|清单|评论|转发")
    items.append(audit_item(
        "contract_psychology_visible",
        "交付契约",
        "传播心理兑现到可见正文",
        psychology_passed and psychology_signal,
        12,
        psychology_summary,
        "把写前传播心理假设写进正文的开头、冲突和收口：读者隐秘情绪、作者有效立场、信念冲突和读者还想听什么都要可见。",
    ))

    outline_stages = split_outline_stages(fields.get("article_outline", ""))
    outline_passed, outline_summary = _contract_visibility_summary(text, outline_stages)
    items.append(audit_item(
        "contract_outline_visible",
        "交付契约",
        "文章骨架在正文中有推进痕迹",
        outline_passed,
        10,
        outline_summary,
        "不要只在隐藏块写骨架。正文至少要呈现开头场景、读者处境、证据推进、洞察/方法和收口中的多数环节。",
    ))

    close_clauses = split_contract_clauses(fields.get("commercial_close", ""))
    close_passed, close_summary = _contract_visibility_summary(text, close_clauses)
    items.append(audit_item(
        "contract_commercial_close_visible",
        "交付契约",
        "商业收口兑现到可见正文",
        close_passed or contains(text, r"下一步|可以先|检查|复盘|咨询|私信|评论|梳理|成交场景|产品"),
        8,
        close_summary,
        "把商业收口写成读者看得见的轻动作，例如检查开头、评论问题、私信诊断、梳理产品/客户/成交场景。",
    ))

    risk_text = fields.get("risk_boundary", "")
    leaked = contains(text, r"客户姓名|客户名|项目名|真实姓名|聊天截图|代码细节|源码|保证\s*成交|100%\s*成交|稳赚")
    items.append(audit_item(
        "contract_risk_boundary_respected",
        "交付契约",
        "风险边界未被正文突破",
        bool(risk_text) and not leaked,
        8,
        risk_text if risk_text else "隐藏自检块未声明风险边界",
        "如果涉及客户、项目、截图、代码、硬数字或结果承诺，正文必须匿名化、保守化，并避免公开未授权细节。",
        "block" if leaked else "review",
    ))
    return items


def style_alignment_audit(text: str, style_contract: dict[str, Any] | None) -> DeliveryAuditItem | None:
    if not style_contract:
        return None
    style_id = style_contract.get("final_style", "")
    if not style_id:
        return audit_item(
            "style_alignment",
            "风格一致性",
            "隐藏自检块记录了可解析的最终风格",
            False,
            10,
            style_contract.get("line", ""),
            "在 `推荐风格 - ...` 中补充 `最终采用：{style-id}`，例如 `最终采用：business-insight`。",
        )
    rules = STYLE_AUDIT_RULES.get(style_id)
    if not rules:
        return audit_item(
            "style_alignment",
            "风格一致性",
            "最终采用风格属于系统风格矩阵",
            False,
            10,
            style_contract.get("line", ""),
            "使用 style-matrix.md 中定义的 style-id，避免临时自造风格导致后续无法复盘。",
        )
    matched = [pattern for pattern in rules["patterns"] if contains(text, pattern)]
    passed = len(matched) >= 2
    evidence = "；".join(evidence_for(text, pattern) for pattern in matched[:3])
    return audit_item(
        "style_alignment",
        "风格一致性",
        f"正文符合最终采用风格：{rules['label']}",
        passed,
        10,
        evidence or style_contract.get("line", ""),
        rules["recommendation"],
    )


def delivery_quality_audit(platform: str, text: str, claims: list[ClaimItem], style_contract: dict[str, Any] | None = None) -> list[DeliveryAuditItem]:
    plain = compact(text)
    first_part = plain[:700]
    heading_count = len(re.findall(r"^#{2,4}\s+", text, re.MULTILINE))
    para_count = paragraph_count(text)
    evidence_hits = evidence_type_hits(text)
    evidence_hit_count = sum(1 for hit in evidence_hits.values() if hit)
    has_benchmark = contains(plain, r"爆款|对标|benchmark|hit-library|可借鉴点|评论区|封面|前\s*3\s*秒|前三秒")
    has_topic_tension = contains(plain, r"不是.*而是|不是.*是|反常识|误区|冲突|别先|不要先|真正|为什么|卡住|痛点|第一篇")
    has_specific_reader = contains(plain, r"创始人|创业者|老板|CEO|顾问|咨询师|运营|产品经理|程序员|技术负责人|早期团队|出海团队|AI\s*创业")
    has_source_context = not claims or all(claim.risk == "ok" for claim in claims)
    has_any_time = not claims or all(claim.has_time_signal for claim in claims if claim.risk != "needs_source")
    has_story_progression = contains(plain, r"故事|事情|上周|昨天|最近|第一次|后来|直到|转折|发现|一开始|最后|回到")
    has_specific_detail = contains(plain, r"凌晨|会议|项目|页面|截图|代码|评论区|私信|成交|办公室|现场|访谈|案例|一手|真实|第一次|上周|昨天|最近一个")
    has_insight = contains(plain, r"交易成本|信任结构|内容结构|时代|渠道|长期|判断框架|方法论|路径|机制|飞轮|复利|资产")
    has_counterparty = contains(plain, r"我理解|很多人|客户会|读者会|你可能|对方|站在|不是.*不行|合理|处境")
    has_action = contains(plain, r"下一步|可以先|先做|具体|清单|步骤|判断标准|复盘|回填|咨询|私信|评论|检查")
    has_thesis = contains(first_part, r"不是.*而是|不是.*是|我越来越觉得|我一直觉得|我的判断|真正|核心|这篇|问题不是|关键不是|说到底|其实")
    has_method_takeaway = contains(plain, r"判断标准|具体怎么做|可以先|第一步|下一步|清单|步骤|方法|动作|复盘|检查|今天就")
    slop_hits = ai_slop_hits(plain)
    placeholders = placeholder_hits(text)
    abstract_without_evidence = abstract_paragraphs_without_evidence(text)

    items = [
        audit_item(
            "topic_reader",
            "选题质量",
            "目标读者足够具体",
            has_specific_reader,
            10,
            evidence_for(text, r"创始人|创业者|老板|CEO|顾问|咨询师|运营|产品经理|程序员|技术负责人|早期团队|出海团队|AI\s*创业"),
            "补一句这条内容写给谁，以及这个人正卡在哪个业务/表达场景。",
        ),
        audit_item(
            "topic_tension",
            "选题质量",
            "选题有反差、冲突或明确误区",
            has_topic_tension,
            12,
            evidence_for(text, r"不是.*而是|不是.*是|反常识|误区|冲突|别先|不要先|真正|为什么|卡住|痛点|第一篇"),
            "把标题或开头改成一个可争论的判断，避免只写正确但无张力的主题。",
        ),
        audit_item(
            "thesis_clarity",
            "选题质量",
            "开头有可复述的题眼",
            has_thesis,
            10,
            evidence_for(text, r"不是.*而是|不是.*是|我越来越觉得|我一直觉得|我的判断|真正|核心|问题不是|关键不是|说到底|其实"),
            "在前 700 字内补一句清晰题眼：这篇文章到底反对什么、支持什么、重新解释什么。",
        ),
        audit_item(
            "benchmark_reference",
            "爆款对标",
            "有对标样本或爆款机制输入",
            has_benchmark,
            10,
            evidence_for(text, r"爆款|对标|benchmark|hit-library|可借鉴点|评论区|封面|前\s*3\s*秒|前三秒"),
            "交付前至少补 3 个同平台对标样本，并说明标题、开头、评论需求和可借鉴点。",
        ),
        audit_item(
            "evidence_mix",
            "证据质量",
            "至少使用两类证据支撑判断",
            evidence_hit_count >= 2,
            12,
            "、".join(name for name, hit in evidence_hits.items() if hit) or "未找到足够证据类型",
            "至少补两类证据：一手素材、具体场景、用户原话、公开来源、对标样本或作者已验证体验。",
        ),
        audit_item(
            "structure_progression",
            "长文结构",
            "内容有叙事推进而不是观点平铺",
            has_story_progression,
            11,
            evidence_for(text, r"故事|事情|上周|昨天|最近|第一次|后来|直到|转折|发现|一开始|最后|回到"),
            "补出起点、发现、转折和回扣，让读者跟着一条线往下读。",
        ),
        audit_item(
            "structure_depth",
            "长文结构",
            "具备足够展开层级",
            (platform != "wechat" and para_count >= 4) or (platform == "wechat" and (heading_count >= 2 or para_count >= 10 or len(plain) >= 2200)),
            10,
            f"段落数 {para_count}，二级以上标题数 {heading_count}，正文字符数 {len(plain)}",
            "公众号成稿建议至少形成 3 个推进层次：具体场景、核心判断、案例/证据、商业回扣。",
        ),
        audit_item(
            "specific_details",
            "精彩度",
            "有具体场景、人物、动作或一手细节",
            has_specific_detail,
            12,
            evidence_for(text, r"凌晨|会议|项目|页面|截图|代码|评论区|私信|成交|办公室|现场|访谈|案例|一手|真实|第一次|上周|昨天|最近一个"),
            "把抽象观点落到一个真实场景，最好能出现人、时间、动作和可感知细节。",
        ),
        audit_item(
            "insight_layer",
            "精彩度",
            "有超出常识的洞察层",
            has_insight,
            11,
            evidence_for(text, r"交易成本|信任结构|内容结构|时代|渠道|长期|判断框架|方法论|路径|机制|飞轮|复利|资产"),
            "在现象后加一层机制解释，讲清楚为什么这件事会影响信任、渠道或交易成本。",
        ),
        audit_item(
            "counterparty_empathy",
            "可信表达",
            "理解对立面或读者处境",
            has_counterparty,
            8,
            evidence_for(text, r"我理解|很多人|客户会|读者会|你可能|对方|站在|不是.*不行|合理|处境"),
            "补一段对读者/客户处境的承认，避免文章像单向说教。",
        ),
        audit_item(
            "anti_ai_slop",
            "可信表达",
            "AI 套话和抽象大词密度可控",
            len(slop_hits) <= 4,
            10,
            "命中：" + "、".join(slop_hits[:8]) if slop_hits else "未发现明显套话密集表达",
            "删掉赋能、抓手、底层逻辑、生态、矩阵、重塑等泛词；每个抽象判断后补一个真实场景、用户原话或具体动作。",
            "review",
        ),
        audit_item(
            "no_placeholders",
            "交付完整性",
            "无占位符、模板变量或待补充标记进入正文",
            not placeholders,
            12,
            "命中：" + "、".join(placeholders) if placeholders else "未发现占位符或待补充标记",
            "交付稿不能保留 TODO、TBD、{{变量}}、待补充、此处填写等内部工作痕迹；必须补齐真实内容，或删除该段后再交付。",
            "block",
        ),
        audit_item(
            "abstract_claims_grounded",
            "证据质量",
            "抽象判断都有具体证据或场景承托",
            not abstract_without_evidence,
            12,
            "；".join(abstract_without_evidence) if abstract_without_evidence else "未发现缺证据的高抽象段落",
            "把高密度抽象段落拆开：先给具体人/事/动作/数据口径，再给方法论判断；没有证据的判断要删除或改成假设。",
            "review",
        ),
        audit_item(
            "method_takeaway",
            "商业交付",
            "读者能带走一个可执行判断或动作",
            has_method_takeaway,
            10,
            evidence_for(text, r"判断标准|具体怎么做|可以先|第一步|下一步|清单|步骤|方法|动作|复盘|检查|今天就"),
            "补一个判断标准、操作步骤或今天就能执行的小动作，避免只输出态度。",
        ),
        audit_item(
            "data_source_time",
            "数据准确及时",
            "硬数字同时有来源与时间口径",
            has_source_context and has_any_time,
            12,
            "无硬数字" if not claims else "；".join(f"{claim.value}:{claim.risk}" for claim in claims[:5]),
            "硬数字必须补来源、统计周期、截至时间；无法核实时改成保守表达或删除。",
            "block" if any(claim.risk == "needs_source" for claim in claims) else "review",
        ),
        audit_item(
            "conversion_action",
            "商业交付",
            "有自然的下一步或商业收口",
            has_action,
            10,
            evidence_for(text, r"下一步|可以先|先做|具体|清单|步骤|判断标准|复盘|回填|咨询|私信|评论|检查"),
            "结尾补一个轻量动作：评论问题、私信判断、回填数据、预约诊断或下一步清单。",
        ),
    ]

    if platform == "wechat":
        style_item = style_alignment_audit(text, style_contract)
        if style_item:
            items.append(style_item)
        non_heading_opening = not first_part.startswith("##")
        items.append(audit_item(
            "wechat_opening_scene",
            "长文结构",
            "公众号开头从人和事进入",
            non_heading_opening and contains(first_part, r"很多|一个|我|上周|最近|第一次|客户|项目|场景|故事|事情"),
            8,
            first_part[:160],
            "公众号开头不要先下定义，先给一个人、一个场景或一个反常识事实。",
        ))
    elif platform == "xhs":
        items.append(audit_item(
            "xhs_comment_asset",
            "爆款对标",
            "小红书有评论需求承接",
            contains(plain, r"评论|求|适合我吗|多少钱|怎么做|领取|私信|卡在"),
            8,
            evidence_for(text, r"评论|求|适合我吗|多少钱|怎么做|领取|私信|卡在"),
            "补评论区承接句，明确用户可以问什么、拿到什么判断。",
        ))
    return items


def golden_refs(platform: str) -> list[dict[str, str]]:
    repo_root = Path(__file__).resolve().parents[3]
    root = repo_root / "quality" / "golden-cases" / platform
    refs = []
    if not root.exists():
        return refs
    for path in sorted(root.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        title = next((line.lstrip("# ").strip() for line in text.splitlines() if line.startswith("#")), path.stem)
        refs.append({"title": title, "path": str(path)})
    return refs


def golden_matrix(platform: str, body: str, refs: list[dict[str, str]]) -> list[dict[str, Any]]:
    rubrics = GOLDEN_RUBRICS.get(platform, [])
    rows = []
    for check_id, label, pattern, *rest in rubrics:
        flags = rest[0] if rest else 0
        passed = contains_with_flags(body, pattern, flags)
        evidence = ""
        match = re.search(pattern, body, re.IGNORECASE | flags)
        if match:
            start = max(0, match.start() - 30)
            end = min(len(body), match.end() + 30)
            evidence = compact(body[start:end])
        rows.append({
            "id": check_id,
            "label": label,
            "passed": passed,
            "evidence": evidence,
            "golden_refs": [ref["title"] for ref in refs],
            "review_note": "达到基线" if passed else "建议对照 golden case 人工补强",
        })
    return rows


def load_content(rt: ContentRuntime, platform: str, file: str | None, step: str | None, slug: str | None) -> tuple[str, str, str]:
    if file:
        path = rt._project_path(file, must_exist=True)
        assert_quality_scope(rt, platform, path=path)
        raw = strip_frontmatter(path.read_text(encoding="utf-8"))
        return str(path), strip_delivery_check(raw), raw
    target_step = step or PLATFORM_STEP[platform]
    assert_quality_scope(rt, platform, step=target_step)
    data = rt.read(target_step, latest=True, slug=slug)
    assert_quality_scope(rt, platform, path=data["path"], step=target_step)
    raw = data["body"]
    return data["path"], strip_delivery_check(raw), raw


def project_relative(rt: ContentRuntime, path: str) -> str:
    resolved = Path(path).expanduser().resolve(strict=False)
    try:
        return str(resolved.relative_to(rt.project.resolve(strict=False)))
    except ValueError:
        return str(path)


def frontmatter_slug(path: str) -> str:
    try:
        text = Path(path).expanduser().resolve(strict=False).read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return ""
    for line in match.group(1).splitlines():
        if line.strip().startswith("slug:"):
            return line.split(":", 1)[1].strip()
    return ""


def path_matches_project_file(rt: ContentRuntime, candidate: str | None, target_rel: str) -> bool:
    if not candidate or not target_rel:
        return False
    if candidate == target_rel:
        return True
    if candidate.endswith(target_rel):
        return True
    try:
        return Path(candidate).expanduser().resolve(strict=False) == (rt.project / target_rel).resolve(strict=False)
    except Exception:
        return False


def resolve_quality_scope(rt: ContentRuntime, file_path: str, requested_slug: str | None) -> dict[str, str]:
    """Bind a quality report to the run that owns the checked artifact."""
    target_rel = project_relative(rt, file_path)
    matches: list[dict[str, Any]] = []
    for run_path in sorted(rt.runs.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            run = json.loads(run_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for meta in (run.get("steps") or {}).values():
            if isinstance(meta, dict) and path_matches_project_file(rt, meta.get("latest"), target_rel):
                matches.append(run)
                break
    if requested_slug:
        for run in matches:
            if run.get("slug") == requested_slug or run.get("run_id") == requested_slug:
                return {"run_id": str(run.get("run_id") or ""), "slug": str(run.get("slug") or requested_slug)}
    if matches:
        run = matches[0]
        return {"run_id": str(run.get("run_id") or ""), "slug": str(run.get("slug") or "")}
    artifact_slug = frontmatter_slug(file_path)
    if artifact_slug:
        for run_path in sorted(rt.runs.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                run = json.loads(run_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if run.get("slug") == artifact_slug or run.get("run_id") == artifact_slug:
                return {"run_id": str(run.get("run_id") or ""), "slug": str(run.get("slug") or artifact_slug)}
    state = rt.state()
    return {
        "run_id": str(state.get("active_run_id") or ""),
        "slug": str(requested_slug or state.get("current_slug") or ""),
    }


def render_report(result: dict[str, Any]) -> str:
    lines = [
        f"# Echo Founder 内容质量验收报告 · {result['platform_label']}",
        "",
        f"- 文件：`{result['file']}`",
        f"- 分数：{result['score']}/{result['max_score']}",
        f"- 结论：{result['status']}",
        f"- 交付门禁：{result['gate_status']}",
        f"- 生成时间：{result['created_at']}",
        "",
        "## 交付门禁",
        "",
    ]
    for check in result["gates"]:
        mark = "PASS" if check["passed"] else ("BLOCK" if check["severity"] == "block" else "REVIEW")
        lines.append(f"- {mark} · {check['label']}：{check['reason']}")
    lines.extend([
        "",
        "## 硬数字 Claim Ledger",
        "",
    ])
    if result["claims"]:
        for claim in result["claims"]:
            mark = "OK" if claim["risk"] == "ok" else ("BLOCK" if claim["risk"] == "needs_source" else "REVIEW")
            lines.append(f"- {mark} · `{claim['value']}`：{claim['context']}")
    else:
        lines.append("- 无硬数字 claim。")
    lines.extend([
        "",
        "## 内容交付质量审计",
        "",
        f"- 审计分：{result['delivery_audit_score']}/{result['delivery_audit_max_score']}",
        f"- 审计结论：{result['delivery_audit_status']}",
        "",
        "| 类别 | 维度 | 结果 | 证据 | 修改建议 |",
        "|---|---|---|---|---|",
    ])
    for row in result["delivery_audit"]:
        mark = "PASS" if row["passed"] else ("BLOCK" if row["severity"] == "block" else "REVIEW")
        evidence = str(row["evidence"]).replace("|", "\\|")
        recommendation = str(row["recommendation"]).replace("|", "\\|")
        lines.append(f"| {row['category']} | {row['label']} | {mark} | {evidence} | {recommendation} |")
    lines.extend([
        "",
        "## 检查项",
        "",
    ])
    for check in result["checks"]:
        mark = "PASS" if check["passed"] else "REVIEW"
        lines.append(f"- {mark} · {check['label']}：{check['points']}/{check['max_points']}。{check['reason']}")
    lines.extend(["", "## Golden Cases", ""])
    for ref in result["golden_refs"]:
        lines.append(f"- {ref['title']}：`{ref['path']}`")
    lines.extend(["", "## Golden Case 评测矩阵", ""])
    if result["golden_matrix"]:
        lines.extend([
            "| 维度 | 结果 | 证据 | 人工复核建议 |",
            "|---|---|---|---|",
        ])
        for row in result["golden_matrix"]:
            mark = "PASS" if row["passed"] else "REVIEW"
            evidence = row["evidence"].replace("|", "\\|") if row["evidence"] else "待补强"
            lines.append(f"| {row['label']} | {mark} | {evidence} | {row['review_note']} |")
    else:
        lines.append("- 暂无对应平台 golden case 矩阵。")
    lines.append("")
    return "\n".join(lines)


def run_quality_check(
    project: str | Path,
    platform: str,
    file: str | None = None,
    step: str | None = None,
    slug: str | None = None,
    min_score: int = 72,
) -> dict[str, Any]:
    rt = ContentRuntime(project)
    rt.init()
    normalized = normalize_platform(platform)
    path, body, raw_body = load_content(rt, normalized, file, step, slug)
    style_contract = parse_style_contract(raw_body) if normalized == "wechat" else None
    delivery_contract = parse_delivery_contract(raw_body) if normalized == "wechat" else None
    claims = hard_claims(body)
    gates = gate_checks(normalized, body, claims)
    checks = common_checks(body) + platform_checks(normalized, body)
    delivery_audit = delivery_quality_audit(normalized, body, claims, style_contract=style_contract)
    if normalized == "wechat":
        delivery_audit.extend(delivery_contract_audit(body, delivery_contract))
    refs = golden_refs(normalized)
    matrix = golden_matrix(normalized, body, refs)
    score = sum(check.points for check in checks)
    max_score = sum(check.max_points for check in checks)
    percent = round(score / max_score * 100) if max_score else 0
    audit_score = sum(item.points for item in delivery_audit)
    audit_max_score = sum(item.max_points for item in delivery_audit)
    audit_percent = round(audit_score / audit_max_score * 100) if audit_max_score else 0
    blocking = [check for check in gates if not check.passed and check.severity == "block"]
    audit_blocking = [item for item in delivery_audit if not item.passed and item.severity == "block"]
    review_gates = [check for check in gates if not check.passed and check.severity != "block"]
    audit_reviews = [item for item in delivery_audit if not item.passed and item.severity != "block"]
    delivery_audit_status = "blocked" if audit_blocking else ("pass" if audit_percent >= 72 and not audit_reviews else "review_required")
    gate_status = "blocked" if blocking or audit_blocking else ("review_required" if review_gates or audit_reviews else "pass")
    status = "blocked" if blocking or audit_blocking else ("pass" if percent >= min_score and delivery_audit_status == "pass" and not review_gates else "review_required")
    created_at = datetime.now().isoformat()
    result = {
        "status": status,
        "gate_status": gate_status,
        "platform": normalized,
        "platform_label": PLATFORM_LABEL[normalized],
        "file": path,
        "score": percent,
        "raw_score": score,
        "max_score": max_score,
        "min_score": min_score,
        "created_at": created_at,
        "gates": [asdict(check) for check in gates],
        "blocking_gates": [asdict(check) for check in blocking],
        "review_gates": [asdict(check) for check in review_gates],
        "claims": [asdict(claim) for claim in claims],
        "style_contract": style_contract,
        "delivery_contract": delivery_contract,
        "checks": [asdict(check) for check in checks],
        "delivery_audit": [asdict(item) for item in delivery_audit],
        "delivery_audit_score": audit_percent,
        "delivery_audit_raw_score": audit_score,
        "delivery_audit_max_score": audit_max_score,
        "delivery_audit_status": delivery_audit_status,
        "delivery_audit_blocking": [asdict(item) for item in audit_blocking],
        "delivery_audit_reviews": [asdict(item) for item in audit_reviews],
        "golden_refs": refs,
        "golden_matrix": matrix,
    }
    result.update(resolve_quality_scope(rt, path, slug))
    report_dir = rt.project / "quality" / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S-%f")
    report_path = report_dir / f"{stamp}-{normalized}-quality.md"
    report_path.write_text(render_report(result), encoding="utf-8")
    result["report_path"] = str(report_path)
    json_report_path = report_path.with_suffix(".json")
    result["json_report_path"] = str(json_report_path)
    json_report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Echo Founder content quality gate")
    parser.add_argument("--project", required=True)
    parser.add_argument("--platform", required=True, help="wechat | xhs")
    parser.add_argument("--file", default=None, help="要检查的文件；默认读取对应平台最新产物")
    parser.add_argument("--step", default=None, help="读取 latest 时指定步骤")
    parser.add_argument("--slug", default=None)
    parser.add_argument("--min-score", type=int, default=72)
    args = parser.parse_args()
    try:
        result = run_quality_check(args.project, args.platform, args.file, args.step, args.slug, args.min_score)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] == "pass" else 1
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

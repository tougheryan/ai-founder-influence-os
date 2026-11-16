#!/usr/bin/env python3
"""Deterministic quality audit for content-intake reports."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|缺失|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)

SCENARIO_KEYWORDS = [
    "个人履历", "经验", "知识分享", "访谈", "演讲", "嘉宾", "个人成长", "人生心得",
    "日常工作", "生活记录", "业务", "产品增长", "引流获客", "全球化", "跨境",
    "创始人 IP", "行业观察",
]

SOURCE_KEYWORDS = [
    "原文", "链接", "访谈", "演讲", "语音", "转写", "聊天记录", "图片", "OCR",
    "用户口述", "用户提供", "用户提交", "自述", "粘贴", "文字素材", "示例",
]
MATERIAL_VALUE_KEYWORDS = ["真实", "稀缺", "认知", "情绪", "方法", "背书", "商业", "时代"]
GENERIC_AUDIENCE_RE = re.compile(r"^(?:所有人|大众|泛人群|用户|客户|读者|创业者|职场人)$")
THEME_OPTION_CHOICES = "ABCDEF"
THEME_OPTION_COUNT = len(THEME_OPTION_CHOICES)
THEME_OPTION_MARKER_RE = re.compile(r"(?:^|[\s;；,，:：])([A-Z])(?:[.、:：\s])")
USABILITY_KEYWORDS = ["可直接立项", "可进入立项", "可继续写观点或方法", "需要补素材", "只适合做灵感备忘", "不可立项"]
LOW_SIGNAL_USABILITY_KEYWORDS = ["需要补素材", "只适合做灵感备忘", "不可立项", "暂不立项", "不建议立项", "无法立项"]
DECLARED_MATERIAL_GAP_KEYWORDS = ["缺少核心案例", "暂无核心案例", "没有核心案例", "缺少案例", "素材不足", "需补", "待补", "待核验"]


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    """Return an inline field value, or the nested bullets directly below it.

    Intake reports often make a field such as ``素材为什么值得被看见`` a
    short label followed by a nested list of concrete values. Treating that
    form as empty makes a structurally valid report fail its deterministic
    audit merely because it is easier for people to scan.
    """
    match = re.search(
        rf"(?m)^(?P<indent>[ \t]*)[-*][ \t]*(?:\*\*)?(?:{label_pattern})(?:\*\*)?[ \t]*[：:][ \t]*(?P<value>[^\r\n]*)$",
        section or "",
    )
    if not match:
        return ""
    inline_value = match.group("value").strip()
    if inline_value:
        return inline_value

    base_indent = len(match.group("indent").expandtabs(2))
    nested_values: list[str] = []
    for line in (section or "")[match.end():].splitlines():
        if not line.strip():
            continue
        line_indent = len(line) - len(line.lstrip(" \t"))
        if line_indent <= base_indent:
            break
        nested = re.sub(r"^[-*]\s*", "", line.strip())
        if nested:
            nested_values.append(nested)
    return " ".join(nested_values)


def meaningful_value(value: str, min_chars: int = 4) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    return not PLACEHOLDER_RE.search(value)


def text_mentions_any(text: str, needles: list[str]) -> bool:
    return any(re.search(re.escape(needle), text or "", re.IGNORECASE) for needle in needles)


def markdown_item_count(section: str) -> int:
    return len(re.findall(r"(?m)^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+", section or ""))


def option_marker_labels(text: str) -> list[str]:
    return THEME_OPTION_MARKER_RE.findall(text or "")


def option_marker_count(text: str) -> int:
    return len(option_marker_labels(text))


def has_exact_theme_option_labels(text: str) -> bool:
    labels = option_marker_labels(text)
    return len(labels) == THEME_OPTION_COUNT and labels == list(THEME_OPTION_CHOICES)


def audit_intake(body: str) -> dict[str, Any]:
    """Audit whether an intake report preserves usable source facts."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "scenario": (r"^##\s*0\.\s+素材场景", "缺少 `## 0. 素材场景`。"),
        "people": (r"^##\s*1\.\s+人物", "缺少 `## 1. 人物`。"),
        "scene": (r"^##\s*2\.\s+场景", "缺少 `## 2. 场景`。"),
        "viewpoint": (r"^##\s*3\.\s+观点", "缺少 `## 3. 观点`。"),
        "emotion": (r"^##\s*4\.\s+情绪", "缺少 `## 4. 情绪`。"),
        "case": (r"^##\s*5\.\s+案例", "缺少 `## 5. 案例`。"),
        "commercial": (r"^##\s*6\.\s+商业意图", "缺少 `## 6. 商业意图`。"),
        "private": (r"^##\s*7\.\s+不可公开信息", "缺少 `## 7. 不可公开信息`。"),
        "quality": (r"^##\s*9\.\s+素材质量判断", "缺少 `## 9. 素材质量判断`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    scenario = section_text(body, r"^##\s*0\.\s+素材场景")
    strategy = section_text(body, r"^##\s*0\.1\s+内容策略画像")
    people = section_text(body, r"^##\s*1\.\s+人物")
    scene = section_text(body, r"^##\s*2\.\s+场景")
    viewpoint = section_text(body, r"^##\s*3\.\s+观点")
    emotion = section_text(body, r"^##\s*4\.\s+情绪")
    case = section_text(body, r"^##\s*5\.\s+案例")
    commercial = section_text(body, r"^##\s*6\.\s+商业意图")
    private = section_text(body, r"^##\s*7\.\s+不可公开信息")
    quality = section_text(body, r"^##\s*9\.\s+素材质量判断")
    gap = line_value(quality, r"当前缺口|缺口")
    usability = line_value(quality, r"下游可用性")

    main_scenario = line_value(scenario, r"主场景")
    source = line_value(scenario, r"素材来源")
    fact_boundary = line_value(scenario, r"事实边界")
    if not meaningful_value(main_scenario) or not text_mentions_any(main_scenario, SCENARIO_KEYWORDS):
        blocking.append("素材场景缺少明确主场景或不在六类场景范围内。")
    if not meaningful_value(source, min_chars=2) or not text_mentions_any(source, SOURCE_KEYWORDS):
        blocking.append("素材场景缺少可追溯的素材来源。")
    if not meaningful_value(fact_boundary, min_chars=8):
        blocking.append("素材场景缺少事实边界，无法区分事实、转述和推断。")

    if not strategy:
        blocking.append("缺少 `## 0.1 内容策略画像`：素材摄入必须先判断为什么值得被看见、再判断给谁看、最后决定怎么写。")
    else:
        material_value = line_value(strategy, r"素材为什么值得被看见|为什么值得被看见")
        visibility_score = line_value(strategy, r"值得被看见指数|被看见指数")
        primary_audience = line_value(strategy, r"主受众|目标受众")
        secondary_audience = line_value(strategy, r"副受众|次要受众")
        theme_options = line_value(strategy, r"用户可选主题候选|主题候选|选题候选")
        core_judgment = line_value(strategy, r"核心判断句")
        content_structure = line_value(strategy, r"内容结构|怎么写")
        hit_reference = line_value(strategy, r"爆款参考范围|爆款机制参考")
        forbidden_style = line_value(strategy, r"禁止写法|禁止")

        # A source-backed opinion does not need invented claims of rarity,
        # authority or business value. Check for an explanation, not a quota
        # of promotional keywords; editorial value remains a human decision.
        explanation = re.sub(
            "(?:" + "|".join(MATERIAL_VALUE_KEYWORDS) + r")(?:价值)?|[\W\d_]",
            "",
            material_value,
        )
        if not meaningful_value(material_value, min_chars=24) or len(explanation) < 12:
            blocking.append("内容策略画像缺少素材用途说明，请说明原文中的哪条观点、事实或案例可以回答读者的什么问题。")
        if not re.search(r"(?:[0-9]|10)\s*/\s*10", visibility_score or ""):
            blocking.append("内容策略画像缺少 0-10 的“值得被看见指数”。")
        if (
            not meaningful_value(primary_audience, min_chars=8)
            or GENERIC_AUDIENCE_RE.search(re.sub(r"\s+", "", primary_audience))
        ):
            blocking.append("内容策略画像缺少具体主受众，不能只写所有人、用户、客户或泛泛人群。")
        if not meaningful_value(secondary_audience, min_chars=6):
            review.append("内容策略画像缺少副受众，后续平台改编可能过窄。")
        # This workbench deliberately generates the operator-facing six topic
        # suggestions only after TikOmni research is frozen. Intake must retain
        # a concrete topic boundary, but must not invent a pre-research list
        # simply to satisfy an obsolete A-F contract.
        if not meaningful_value(theme_options, min_chars=16):
            blocking.append("内容策略画像缺少本期选题边界或研究后主题生成说明。")
        if not meaningful_value(core_judgment, min_chars=12):
            blocking.append("内容策略画像缺少核心判断句，后续内容容易宽泛。")
        if not meaningful_value(content_structure, min_chars=18) or len(re.findall(r"->|→|第一|第二|第三|最后", content_structure)) < 2:
            blocking.append("内容策略画像缺少“最后怎么写”的内容结构路径。")
        if not meaningful_value(hit_reference, min_chars=16) or not text_mentions_any(hit_reference, ["同场景", "同平台", "同人群", "同行为目标", "公开", "机制"]):
            review.append("内容策略画像缺少可执行的爆款参考范围；后续只能按素材支撑评分。")
        if not meaningful_value(forbidden_style, min_chars=12):
            blocking.append("内容策略画像缺少禁止写法，容易把内部判断写成泛化套话或硬广。")

    if not meaningful_value(line_value(people, r"核心人物|说话人"), min_chars=4):
        review.append("人物部分缺少核心人物或说话人。")

    if not text_mentions_any(scene, ["关键事件链", "时间", "地点", "背景"]):
        blocking.append("场景部分缺少时间/背景或关键事件链。")
    if not text_mentions_any(scene, ["缺失信息", "缺口"]):
        review.append("场景部分未标注缺失信息。")

    if markdown_item_count(viewpoint) < 1:
        blocking.append("观点部分缺少可提炼观点。")
    if "证据位置" not in viewpoint:
        blocking.append("观点部分缺少证据位置，后续无法追溯来源。")

    if not meaningful_value(line_value(emotion, r"主情绪"), min_chars=2):
        review.append("情绪部分缺少主情绪。")
    if not text_mentions_any(emotion, ["情绪曲线", "文本依据", "可共鸣点"]):
        review.append("情绪部分缺少情绪曲线、文本依据或可共鸣点。")

    declared_material_gap = text_mentions_any(
        "\n".join([case, gap, usability]),
        DECLARED_MATERIAL_GAP_KEYWORDS + LOW_SIGNAL_USABILITY_KEYWORDS,
    )
    low_signal_usability = text_mentions_any(usability, LOW_SIGNAL_USABILITY_KEYWORDS)
    if not meaningful_value(line_value(case, r"核心案例"), min_chars=4):
        if declared_material_gap or low_signal_usability:
            review.append("案例部分缺少核心案例，已按素材缺口处理；立项报告只能承接为补素材/不立项判断。")
        else:
            blocking.append("案例部分缺少核心案例。")
    credibility = line_value(case, r"可信等级")
    if not meaningful_value(credibility, min_chars=3) or not text_mentions_any(credibility, ["一手", "转述", "推断", "待核验", "demo", "示例"]):
        if declared_material_gap or low_signal_usability:
            review.append("案例部分缺少可信等级，已按待核验素材处理；立项报告必须显式承接该风险。")
        else:
            blocking.append("案例部分缺少可信等级，无法判断素材能否进入立项。")

    if not meaningful_value(commercial, min_chars=10):
        review.append("商业意图过短，可能无法支撑立项判断。")
    if not text_mentions_any(commercial, ["产品", "服务", "品牌", "受众", "转化", "咨询", "陪跑", "信任", "获客"]):
        review.append("商业意图缺少产品/服务/受众/转化线索。")

    if not meaningful_value(private, min_chars=8) or PLACEHOLDER_RE.search(private):
        blocking.append("不可公开信息缺少具体隐私、商业机密或处理建议。")
    if not text_mentions_any(private, ["处理建议", "匿名", "不公开", "不可公开", "脱敏"]):
        review.append("不可公开信息缺少处理建议。")

    completeness = line_value(quality, r"信息完整度")
    credibility_quality = line_value(quality, r"可信度")
    if not meaningful_value(completeness, min_chars=1):
        review.append("素材质量判断缺少信息完整度。")
    if not meaningful_value(credibility_quality, min_chars=4):
        review.append("素材质量判断缺少可信度说明。")
    if not meaningful_value(gap, min_chars=4):
        review.append("素材质量判断缺少当前缺口。")
    if not meaningful_value(usability, min_chars=4) or not text_mentions_any(usability, USABILITY_KEYWORDS):
        blocking.append("素材质量判断缺少明确下游可用性。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "main_scenario": main_scenario,
            "strategy_profile": bool(strategy),
            "theme_option_count": option_marker_count(line_value(strategy, r"用户可选主题候选|主题候选|选题候选")) if strategy else 0,
            "source": source,
            "fact_boundary": fact_boundary,
            "viewpoint_items": markdown_item_count(viewpoint),
            "credibility": credibility,
            "usability": usability,
        },
    }

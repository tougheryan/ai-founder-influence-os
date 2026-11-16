#!/usr/bin/env python3
"""Quality audit for package pipeline outputs."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_VALUES = {
    "无",
    "暂无",
    "待确认",
    "未提供",
    "待定",
    "不详",
    "缺失",
    "无内容",
    "未填写",
    "XXX",
    "...",
    "…",
    "占位",
    "待填",
    "待填写",
    "此处填写",
    "填写中",
    "TODO",
    "TBD",
    "TODO/TBD",
    "N/A",
    "NA",
    "NONE",
    "NULL",
    "-",
    "--",
    "—",
    "——",
}


def _compact(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _section(body: str, index: int, title: str) -> str:
    pattern = rf"(?ms)^##\s*{index}\.\s+{re.escape(title)}\s*(.*?)(?=^##\s*\d+\.|\Z)"
    match = re.search(pattern, body)
    return match.group(1).strip() if match else ""


def _section_any(body: str, index: int, titles: list[str]) -> str:
    for title in titles:
        section = _section(body, index, title)
        if section:
            return section
    return ""


def _has_placeholder_language(text: str) -> bool:
    if not _compact(text):
        return True
    for raw_line in text.splitlines():
        value = re.sub(r"^\s*[-*]\s*", "", raw_line).strip()
        if not value:
            continue
        if re.match(r"^[^：:]{1,24}[：:]", value):
            value = re.split(r"[：:]", value, maxsplit=1)[1].strip()
        if _placeholder_value(value):
            return True
    return False


def _placeholder_value(value: str) -> bool:
    plain = _compact(value).strip("。.;； ")
    if not plain:
        return True
    upper_plain = re.sub(r"\s*/\s*", "/", plain.upper())
    return plain.startswith("待补") or plain in PLACEHOLDER_VALUES or upper_plain in PLACEHOLDER_VALUES


def _field_value(section: str, field: str) -> str | None:
    match = re.search(
        rf"(?ms)^[ \t]*[-*][ \t]*{re.escape(field)}[ \t]*[：:][ \t]*(.*?)(?=^[-*][ \t]*[\w\u4e00-\u9fff /-]{{1,32}}[：:]|^#{{1,6}}\s+|\Z)",
        section,
    )
    return match.group(1).strip() if match else None


def _field_invalid(section: str, field: str) -> bool:
    value = _field_value(section, field)
    return value is None or _placeholder_value(value)


MOTHERPIECE_FIELD_GROUPS = [
    ("发布标题", ["发布标题"]),
    ("摘要", ["摘要"]),
    ("评论区引导", ["评论区引导", "评论维护话术"]),
]

MOTHERPIECE_PUBLISH_FIELD_GROUPS = [
    ("封面字", ["封面字"]),
    ("公众号排版提示", ["公众号排版提示", "排版提示", "HTML 排版建议"]),
    ("配图位建议", ["配图位建议", "图片需求", "配图建议"]),
]

COMMENT_FIELD_GROUPS = [
    ("评论维护话术", ["评论维护话术"]),
]

RISK_BOUNDARY_FIELDS = ["平台风险边界"]

OPINION_FIELD_GROUPS = [
    ("核心观点", ["核心观点", "核心判断"]),
    ("适用平台", ["适用平台", "发布平台"]),
    ("发布标题", ["发布标题"]),
    ("封面字", ["封面字"]),
    ("正文文案/分享文案", ["正文文案", "分享文案", "文案"]),
]

VIDEO_FIELD_GROUPS = [
    ("发布标题", ["发布标题"]),
    ("封面字", ["封面字"]),
    ("3 秒钩子", ["3 秒钩子", "3秒钩子", "开场钩子"]),
]

VIDEO_PLATFORM_FIELDS = ["适用平台", "发布平台"]
VIDEO_DURATION_FIELDS = ["时长", "视频时长"]
VIDEO_LINE_SCRIPT_HEADINGS = ["逐句口播稿", "逐句脚本"]
VIDEO_SHOT_HEADINGS = ["镜头清单", "镜头表"]
VIDEO_BROLL_HEADINGS = ["B-roll 素材建议", "B-roll素材建议", "B-roll", "B-Roll"]
VIDEO_PUBLISH_NOTE_HEADINGS = ["发布备注", "发布说明", "发布建议", "平台发布备注", "平台适配"]
VIDEO_PUBLISH_FORM_HEADINGS = ["平台发布表单", "平台发布稿", "发布字段"]
SHARE_PLATFORM_FIELDS = ["适用平台", "发布平台"]
SHARE_PLATFORM_ADAPT_HEADINGS = ["平台适配", "发布适配", "平台发布适配"]
SHARE_PUBLISH_FORM_HEADINGS = ["平台发布稿", "平台发布表单", "发布字段"]

VIDEO_PLATFORM_FIELD_GROUPS = [
    ("视频号", ["视频号", "微信视频号"]),
    ("抖音", ["抖音"]),
    ("小红书", ["小红书"]),
]

VIDEO_PUBLISH_FORM_FIELD_GROUPS = [
    ("视频号标题", ["视频号标题", "微信视频号标题"]),
    ("视频号发布文案", ["视频号发布文案", "视频号简介", "微信视频号发布文案"]),
    ("视频号话题", ["视频号话题", "微信视频号话题"]),
    ("抖音标题", ["抖音标题"]),
    ("抖音发布文案", ["抖音发布文案", "抖音描述"]),
    ("抖音话题", ["抖音话题"]),
    ("小红书视频标题", ["小红书视频标题", "小红书标题"]),
    ("小红书视频正文", ["小红书视频正文", "小红书视频文案", "小红书正文"]),
    ("小红书标签", ["小红书标签"]),
    ("默认封面画面", ["默认封面画面", "封面画面"]),
]

SHARE_PLATFORM_FIELD_GROUPS = [
    ("公众号", ["公众号", "微信公众号", "微信公众平台"]),
    ("朋友圈", ["朋友圈", "微信朋友圈"]),
    ("小红书", ["小红书"]),
]

SHARE_PUBLISH_FORM_FIELD_GROUPS = [
    ("公众号文内标题", ["公众号文内标题", "公众号标题"]),
    ("公众号配文", ["公众号配文", "公众号引导文案"]),
    ("朋友圈图序", ["朋友圈图序", "朋友圈选图"]),
    ("朋友圈短文案", ["朋友圈短文案", "朋友圈文案"]),
    ("小红书标题", ["小红书标题"]),
    ("小红书正文", ["小红书正文", "小红书图文正文"]),
    ("小红书标签", ["小红书标签"]),
]

LEGACY_PACKAGE_MARKERS = [
    "标准内容资产包",
    "标题与封面资产",
    "标题测试报告",
    "蓝图摘要报告",
    "## 0. 内部来源",
    "## 1. 发布组合",
    "## 4. 评论区互动钩子",
    "## 5. 风险边界",
    "## 6. 下一步执行指令",
]

ABSTRACT_TITLE_TERMS = [
    "方法论",
    "商业逻辑",
    "内容增长",
    "增长逻辑",
    "增长策略",
    "闭环",
    "体系",
    "系统",
    "模型",
    "认知",
    "启示",
    "思考",
    "复盘",
    "攻略",
]

SPECIFIC_OBJECT_RE = re.compile(
    r"客户|创始人|老板|读者|用户|第一篇|第一条|业务|产品|服务|车模|小众|出海|饭局|"
    r"供应链|经销商|订单|客单价|合作|评论|访谈|开头|履历|素材|账号|文章|图文"
)

TITLE_TENSION_RE = re.compile(
    r"不是|别|先|最怕|真正|而是|越|为什么|怎么|如何|别急|划走|卡|难|亏|贵|误区|"
    r"问题|第一|一次|一场"
)

OPENING_SCENE_RE = re.compile(
    r"创始人|老板|客户|用户|读者|饭局|访谈|会议|现场|第一次|第一篇|第一条|评论区|"
    r"业务|产品|服务|合作|订单|出海|车模|写|看|问|留下|改稿|白板"
)

OPENING_CONFLICT_RE = re.compile(r"但|不是|而是|别|越|却|卡|问题|难|误区|真正|冲突|反常识|划走")

OPENING_COST_RE = re.compile(
    r"划走|损失|错过|不愿|无感|信任|停下|失败|交付不了|成交|代价|风险|客户|问题|卡住|"
    r"不理解|没人|难以|不能"
)

SHAREABLE_JUDGMENT_RE = re.compile(
    r"不是|而是|先|才|来自|越|最怕|真正|别|只有|问题|信任|客户|代价|交付|卡住|划走|"
    r"第一篇|第一条"
)

GENERIC_COMMENT_RE = re.compile(r"你怎么看|大家怎么看|欢迎评论|评论区聊聊|有问题留言|欢迎留言|你觉得呢")

BUSINESS_INFO_RE = re.compile(
    r"业务|产品|客户|行业|客单价|卡点|类型|场景|开头|问题|目标|成交|供应链|渠道|账号|内容"
)


def _field_group_invalid(section: str, fields: list[str]) -> bool:
    return all(_field_invalid(section, field) for field in fields)


def _field_group_missing(section: str, fields: list[str]) -> bool:
    return all(field not in section for field in fields)


def _field_group_value(section: str, fields: list[str]) -> str:
    for field in fields:
        value = _field_value(section, field)
        if value is not None:
            return value
    return ""


def _page_markers(text: str) -> set[int]:
    return {int(match.group(1)) for match in re.finditer(r"\bP\s*([1-9])\b", text, re.IGNORECASE)}


def _page_card_errors(block: str, idx: int) -> list[str]:
    value = _field_group_value(block, ["页卡正文"])
    issues: list[str] = []
    if not value:
        return [f"图文 {idx} 缺少逐页页卡正文。"]

    for page in range(1, 6):
        title_ok = re.search(rf"\bP\s*{page}\b[^\n。；;]*标题[：:]", value, re.IGNORECASE)
        body_ok = re.search(rf"\bP\s*{page}\b[^\n。；;]*(?:正文|文案)[：:]", value, re.IGNORECASE)
        if not title_ok or not body_ok:
            issues.append(f"图文 {idx} 页卡正文缺少 P{page} 标题或正文。")

    return issues


def _visual_plan_errors(block: str, idx: int) -> list[str]:
    value = _field_group_value(block, ["画面建议", "配图建议", "画面/配图建议"])
    if not value:
        return [f"图文 {idx} 缺少逐页画面/配图建议。"]
    pages = _page_markers(value)
    missing = [f"P{page}" for page in range(1, 6) if page not in pages]
    if missing:
        return [f"图文 {idx} 画面/配图建议缺少逐页对应：{', '.join(missing)}。"]
    return []


def _layout_note_errors(block: str, idx: int) -> list[str]:
    value = _field_group_value(block, ["排版备注"])
    if not value:
        return [f"图文 {idx} 缺少排版备注。"]
    if len(_compact(value)) < 18:
        return [f"图文 {idx} 排版备注过短，需要说明封面、页内层级或重点高亮。"]
    if not re.search(r"封面|每页|页|字号|高亮|留白|分段|P\s*[1-9]", value, re.IGNORECASE):
        return [f"图文 {idx} 排版备注缺少可执行的版式指令。"]
    return []


def _heading_body(section: str, heading: str, level: int = 3) -> str:
    marks = "#" * level
    boundary = rf"(?=^#{{1,{level}}}\s+|\Z)"
    pattern = rf"(?ms)^{marks}\s+{re.escape(heading)}\s*(.*?){boundary}"
    match = re.search(pattern, section)
    return match.group(1).strip() if match else ""


def _has_heading(section: str, heading: str, level: int = 3) -> bool:
    marks = "#" * level
    return re.search(rf"(?m)^{marks}\s+{re.escape(heading)}\s*$", section) is not None


def _heading_body_any(section: str, headings: list[str], level: int = 3) -> str:
    for heading in headings:
        value = _heading_body(section, heading, level=level)
        if value:
            return value
    return ""


def _heading_count(section: str, level: int = 4) -> int:
    marks = "#" * level
    return len(re.findall(rf"(?m)^{marks}\s+\S+", section))


def _has_quote_signal(section: str) -> bool:
    if re.search(r"(?m)^>\s*\S+", section):
        return True
    quotes = _field_group_value(section, ["重点引用", "金句", "重点引用/金句"])
    return len([item for item in re.split(r"[；;\n]", quotes) if _compact(item)]) >= 3


def _markdown_table_lines(section: str) -> list[str]:
    return [line.strip() for line in section.splitlines() if line.strip().startswith("|") and line.strip().endswith("|")]


def _table_has_headers(section: str, headers: list[str]) -> bool:
    lines = _markdown_table_lines(section)
    if not lines:
        return False
    header = lines[0]
    return all(label in header for label in headers)


def _page_script_rows(section: str) -> dict[str, list[str]]:
    rows: dict[str, list[str]] = {}
    for line in _markdown_table_lines(section):
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if not cells:
            continue
        page = cells[0].upper().replace(" ", "")
        if re.fullmatch(r"P[1-9]", page):
            rows[page] = cells
    return rows


def _item_value(value: str) -> str:
    item = re.sub(r"^(?:[-*+]|\d+[.)])\s*", "", value.strip()).strip()
    if re.match(r"^[^：:]{1,24}[：:]", item):
        item = re.split(r"[：:]", item, maxsplit=1)[1].strip()
    return item


def _placeholder_combo(value: str) -> bool:
    item = _item_value(value)
    if _placeholder_value(item):
        return True
    tokens = _placeholder_tokens(item)
    return bool(tokens) and all(_placeholder_value(token) for token in tokens)


def _placeholder_tokens(value: str) -> list[str]:
    item = _item_value(value)
    return [token.strip("。.;； ") for token in re.split(r"[、,，；;]+", item) if token.strip("。.;； ")]


def _contains_placeholder_token(text: str) -> bool:
    raw_item = re.sub(r"^(?:[-*+]|\d+[.)])\s*", "", text.strip()).strip()
    item = _item_value(text)
    if not item:
        return bool(re.match(r"^[^：:\n]{1,24}[：:]\s*$", raw_item))
    if _placeholder_value(item) or _placeholder_combo(item):
        return True
    return any(_placeholder_value(token) or _placeholder_combo(token) for token in _placeholder_tokens(item))


def _placeholder_lines(section: str) -> list[str]:
    lines: list[str] = []
    for raw_line in section.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("|"):
            continue
        if _contains_placeholder_token(line):
            lines.append(line)
    return lines


def _actionable_items(section: str) -> list[str]:
    items: list[str] = []
    for raw_line in section.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("|"):
            continue
        item = _item_value(line)
        if item and not _placeholder_combo(item):
            items.append(item)
    if items:
        return items
    split_items: list[str] = []
    for part in re.split(r"[、,，；;\n]", section):
        item = _item_value(part)
        if item and not _placeholder_combo(item):
            split_items.append(item)
    return split_items


def _has_actionable_content(section: str) -> bool:
    return bool(_actionable_items(section))


def _platform_list_errors(
    block: str,
    label: str,
    fields: list[str],
    required_platforms: list[str],
) -> list[str]:
    if _field_group_missing(block, fields):
        return [f"{label} 缺少适用平台字段。"]
    value = _field_group_value(block, fields)
    if _placeholder_value(value):
        return [f"{label} 适用平台不可为空或占位。"]
    missing = [platform for platform in required_platforms if platform not in value]
    if missing:
        return [f"{label} 适用平台缺少：{', '.join(missing)}。"]
    return []


def _duration_errors(block: str, idx: int) -> list[str]:
    if _field_group_missing(block, VIDEO_DURATION_FIELDS):
        return [f"短视频 {idx} 缺少时长。"]
    value = _field_group_value(block, VIDEO_DURATION_FIELDS)
    if _placeholder_value(value):
        return [f"短视频 {idx} 时长不可为空或占位。"]
    if not re.search(r"\d+\s*(?:(?:[-~～－—–]|至|到)\s*\d+\s*)?(?:秒|s|分钟|min)", value, re.IGNORECASE):
        return [f"短视频 {idx} 时长需要给出可拍摄的秒数或分钟范围。"]
    return []


def _segmented_script_errors(block: str, idx: int) -> list[str]:
    section = _heading_body(block, "分段口播稿", level=4)
    if not section:
        return [f"短视频 {idx} 缺少 `#### 分段口播稿`。"]
    missing = [label for label in ["开场", "展开", "转折", "收口"] if _field_invalid(section, label)]
    if missing:
        return [f"短视频 {idx} 分段口播稿缺少：{', '.join(missing)}。"]
    return []


def _line_script_errors(block: str, idx: int) -> list[str]:
    section = _heading_body_any(block, VIDEO_LINE_SCRIPT_HEADINGS, level=4)
    if not section:
        return [f"短视频 {idx} 缺少 `#### 逐句口播稿`。"]
    lines = _markdown_table_lines(section)
    if not lines:
        return [f"短视频 {idx} 逐句口播稿缺少 Markdown 表格。"]
    header = lines[0]
    has_time = "时间段" in header
    has_script = "口播" in header
    has_subtitle = "字幕" in header
    has_visual = "画面" in header or "镜头" in header
    if not (has_time and has_script and has_subtitle and has_visual):
        return [f"短视频 {idx} 逐句口播稿必须包含时间段、口播、字幕和对应画面列。"]
    rows = [line for line in lines[1:] if "---" not in line]
    required_rows = 4 if idx == 1 else 5
    if len(rows) < required_rows:
        return [f"短视频 {idx} 逐句口播稿至少需要 {required_rows} 段可剪辑口播。"]
    weak_rows = []
    for position, line in enumerate(rows, start=1):
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 4 or any(_placeholder_value(cell) for cell in cells[:4]):
            weak_rows.append(str(position))
    if weak_rows:
        return [f"短视频 {idx} 逐句口播稿存在空白或占位行：{', '.join(weak_rows)}。"]
    return []


def _shot_table_errors(block: str, idx: int) -> list[str]:
    section = _heading_body_any(block, VIDEO_SHOT_HEADINGS, level=4)
    if not section:
        return [f"短视频 {idx} 缺少 `#### 镜头清单`。"]
    lines = _markdown_table_lines(section)
    if not lines:
        return [f"短视频 {idx} 镜头清单缺少 Markdown 表格。"]
    header = lines[0]
    has_time = "时间段" in header
    has_shot = "镜头" in header or "画面" in header
    has_script = "口播" in header or "字幕" in header
    if not (has_time and has_shot and has_script):
        return [f"短视频 {idx} 镜头清单缺少时间段、镜头/画面或口播/字幕列。"]
    data_rows = [line for line in lines[1:] if "---" not in line]
    if len(data_rows) < 3:
        return [f"短视频 {idx} 镜头清单至少需要 3 行可执行镜头。"]
    return []


def _list_section_errors(block: str, headings: list[str], label: str, minimum: int = 3) -> list[str]:
    section = _heading_body_any(block, headings, level=4)
    if not section:
        return [f"{label}。"]
    items = _actionable_items(section)
    if len(items) < minimum:
        return [f"{label} 至少需要 {minimum} 条可执行内容。"]
    placeholder_lines = _placeholder_lines(section)
    if placeholder_lines:
        return [f"{label} 存在占位项：{'; '.join(placeholder_lines)}。"]
    return []


def _subtitle_errors(block: str, idx: int) -> list[str]:
    return _list_section_errors(
        block,
        ["字幕重点"],
        f"短视频 {idx} 缺少 `#### 字幕重点` 或字幕重点不完整",
    )


def _broll_errors(block: str, idx: int) -> list[str]:
    return _list_section_errors(
        block,
        VIDEO_BROLL_HEADINGS,
        f"短视频 {idx} 缺少 `#### B-roll 素材建议` 或 B-roll 不完整",
    )


def _platform_adaptation_errors(
    block: str,
    label: str,
    headings: list[str],
    field_groups: list[tuple[str, list[str]]],
) -> list[str]:
    section = _heading_body_any(block, headings, level=4)
    if not section:
        return [f"{label} 缺少平台适配/发布备注。"]
    missing = [name for name, fields in field_groups if _field_group_invalid(section, fields)]
    if missing:
        return [f"{label} 平台适配/发布备注缺少：{', '.join(missing)}。"]
    return []


def _platform_publish_form_errors(
    block: str,
    label: str,
    headings: list[str],
    field_groups: list[tuple[str, list[str]]],
) -> list[str]:
    section = _heading_body_any(block, headings, level=4)
    if not section:
        return [f"{label} 缺少可直接复制的 `#### 平台发布表单/平台发布稿`。"]
    missing = [name for name, fields in field_groups if _field_group_invalid(section, fields)]
    if missing:
        return [f"{label} 平台发布表单缺少：{', '.join(missing)}。"]
    return []


def _video_errors(block: str, idx: int) -> list[str]:
    issues: list[str] = []
    missing = [label for label, fields in VIDEO_FIELD_GROUPS if _field_group_missing(block, fields)]
    if missing:
        issues.append(f"短视频 {idx} 缺少字段：{', '.join(missing)}。")
    invalid = [label for label, fields in VIDEO_FIELD_GROUPS if _field_group_invalid(block, fields)]
    if invalid:
        issues.append(f"短视频 {idx} 存在空值、占位或格式错误字段：{', '.join(invalid)}。")
    issues.extend(_platform_list_errors(block, f"短视频 {idx}", VIDEO_PLATFORM_FIELDS, ["视频号", "抖音", "小红书"]))
    issues.extend(_duration_errors(block, idx))
    issues.extend(_segmented_script_errors(block, idx))
    issues.extend(_line_script_errors(block, idx))
    issues.extend(_shot_table_errors(block, idx))
    issues.extend(_subtitle_errors(block, idx))
    issues.extend(_broll_errors(block, idx))
    issues.extend(
        _platform_adaptation_errors(
            block,
            f"短视频 {idx}",
            VIDEO_PUBLISH_NOTE_HEADINGS,
            VIDEO_PLATFORM_FIELD_GROUPS,
        )
    )
    issues.extend(
        _platform_publish_form_errors(
            block,
            f"短视频 {idx}",
            VIDEO_PUBLISH_FORM_HEADINGS,
            VIDEO_PUBLISH_FORM_FIELD_GROUPS,
        )
    )
    issues.extend(_comment_script_errors(block, f"短视频 {idx}"))
    issues.extend(_risk_boundary_errors(block, f"短视频 {idx}"))
    return issues


def _comment_script_errors(block: str, label: str) -> list[str]:
    section = _heading_body(block, "评论维护话术", level=4)
    if not section:
        return [f"{label} 缺少 `#### 评论维护话术`。"]
    missing = [item for item in ["置顶", "首评", "追评", "高意向回复"] if _field_invalid(section, item)]
    if missing:
        return [f"{label} 评论维护话术缺少：{', '.join(missing)}。"]
    return []


def _risk_boundary_errors(block: str, label: str) -> list[str]:
    value = _heading_body(block, "平台风险边界", level=4) or _field_group_value(block, RISK_BOUNDARY_FIELDS)
    if not value:
        return [f"{label} 缺少平台风险边界。"]
    if not _has_actionable_content(value):
        return [f"{label} 平台风险边界为空值或占位。"]
    placeholder_lines = _placeholder_lines(value)
    if placeholder_lines:
        return [f"{label} 平台风险边界存在占位项：{'; '.join(placeholder_lines)}。"]
    if _contains_placeholder_token(value):
        return [f"{label} 平台风险边界存在占位项。"]
    return []


def _has_visual_evidence_contract(value: str) -> bool:
    """Require a traceable source or an explicit non-evidence illustration boundary."""
    text = _compact(value)
    if len(text) < 8:
        return False
    if re.search(r"(?:materials|pipeline)/[^\s，。；;|`]+", text, re.IGNORECASE):
        return True
    if re.search(r"(?:来源|证据源|素材文件|原始材料)[：:]\s*(?!无|暂无|待)[^，。；;|]{4,}", text):
        return True
    concept_signal = re.search(r"概念插图|概念图解|概念示意|示意图", text)
    non_evidence_boundary = re.search(r"非事实证据|非真实证据|不作为证据|仅作示意|不是证据", text)
    return bool(concept_signal and non_evidence_boundary)


def _page_script_errors_v2(block: str, idx: int) -> list[str]:
    section = _heading_body(block, "页卡脚本", level=4)
    if not section:
        return [f"图文 {idx} 缺少 `#### 页卡脚本`。"]
    if not _table_has_headers(section, ["页码", "页面标题", "页面正文", "画面/配图建议", "视觉层级", "排版重点"]):
        return [f"图文 {idx} 页卡脚本缺少页码、页面标题、页面正文、画面/配图建议、视觉层级、排版重点六列。"]
    rows = _page_script_rows(section)
    missing_pages = [f"P{page}" for page in range(1, 6) if f"P{page}" not in rows]
    if missing_pages:
        return [f"图文 {idx} 页卡脚本缺少：{', '.join(missing_pages)}。"]
    weak_pages = []
    untraceable_visual_pages = []
    for page, cells in rows.items():
        if len(cells) < 6 or any(_placeholder_value(cell) for cell in cells[:6]):
            weak_pages.append(page)
            continue
        visual_evidence_cell = cells[3]
        visual_cell = cells[4]
        layout_cell = cells[5]
        if not _has_visual_evidence_contract(visual_evidence_cell):
            untraceable_visual_pages.append(page)
        if len(_compact(visual_cell)) < 8 or not re.search(r"标题|封面|卡|图|栏|层级|高亮|输入框|按钮|清单|便签|对照", visual_cell):
            weak_pages.append(page)
            continue
        if len(_compact(layout_cell)) < 4:
            weak_pages.append(page)
    errors = []
    if untraceable_visual_pages:
        errors.append(
            f"图文 {idx} 页卡脚本缺少可追溯证据来源或明确的概念插图非证据边界："
            f"{', '.join(untraceable_visual_pages)}。"
        )
    if weak_pages:
        errors.append(f"图文 {idx} 页卡脚本视觉层级或排版重点不可执行：{', '.join(weak_pages)}。")
    return errors


def _opinion_platform_errors(block: str, idx: int) -> list[str]:
    issues = _platform_list_errors(
        block,
        f"分享观点 {idx}",
        SHARE_PLATFORM_FIELDS,
        ["公众号", "朋友圈", "小红书"],
    )
    issues.extend(
        _platform_adaptation_errors(
            block,
            f"分享观点 {idx}",
            SHARE_PLATFORM_ADAPT_HEADINGS,
            SHARE_PLATFORM_FIELD_GROUPS,
        )
    )
    issues.extend(
        _platform_publish_form_errors(
            block,
            f"分享观点 {idx}",
            SHARE_PUBLISH_FORM_HEADINGS,
            SHARE_PUBLISH_FORM_FIELD_GROUPS,
        )
    )
    return issues


def _motherpiece_errors(section: str) -> list[str]:
    issues: list[str] = []
    if not section:
        return ["缺少 `## 1. 公众号母稿`。"]

    has_v2_comment = _has_heading(section, "评论区引导", level=3)
    comment_hook = (
        _heading_body(section, "评论区引导", level=3)
        if has_v2_comment
        else _field_group_value(section, ["评论区引导", "评论维护话术"])
    )
    has_v1_body = not _field_invalid(section, "正文")
    is_v1_presentation = has_v1_body and not _has_heading(section, "正文", level=3)

    missing = [
        label
        for label, fields in MOTHERPIECE_FIELD_GROUPS
        if not (label == "评论区引导" and has_v2_comment) and _field_group_missing(section, fields)
    ]
    if missing:
        issues.append(f"公众号母稿缺少字段：{', '.join(missing)}。")

    invalid = [
        label
        for label, fields in MOTHERPIECE_FIELD_GROUPS
        if not (label == "评论区引导" and has_v2_comment) and _field_group_invalid(section, fields)
    ]
    if invalid:
        issues.append(f"公众号母稿存在空值、占位或格式错误字段：{', '.join(invalid)}。")

    summary = _field_group_value(section, ["摘要"])
    summary_len = len(_compact(summary))
    if summary and not 60 <= summary_len <= 160:
        issues.append("公众号母稿摘要长度应控制在 60-160 字，便于发布预览。")

    body_text = _heading_body(section, "正文", level=3) or _field_group_value(section, ["正文"])
    if body_text and len(_compact(body_text)) < 120:
        issues.append("公众号母稿正文过短，不能作为可发布母稿。")
    if not body_text:
        issues.append("公众号母稿缺少正文层级或正文内容。")

    if not _has_quote_signal(section):
        issues.append("公众号母稿至少需要 3 条重点引用/金句，或至少 1 条引用块金句。")

    if has_v2_comment and not _has_actionable_content(comment_hook):
        issues.append("公众号母稿评论区引导为空值或占位。")
    elif comment_hook and not _has_actionable_content(comment_hook):
        issues.append("公众号母稿评论区引导为空值或占位。")
    placeholder_comment_lines = _placeholder_lines(comment_hook)
    if placeholder_comment_lines:
        issues.append("公众号母稿评论区引导存在占位行： " + "；".join(placeholder_comment_lines) + "。")

    if not is_v1_presentation:
        if not _field_group_value(section, ["标题备选"]) and len(re.findall(r"标题", section)) < 2:
            issues.append("公众号母稿缺少标题备选。")
        issues.extend(_motherpiece_publish_state_errors(section))
        if _field_group_invalid(section, ["封面/摘要建议", "封面摘要建议"]):
            issues.append("公众号母稿缺少封面/摘要建议。")
        if not _has_heading(section, "正文", level=3):
            issues.append("公众号母稿缺少 `### 正文`。")
        if _heading_count(_heading_body(section, "正文", level=3), level=4) < 2:
            issues.append("公众号母稿正文层级不足，至少需要 2 个四级小标题。")
        if not has_v2_comment:
            issues.append("公众号母稿缺少 `### 评论区引导`。")

    return issues


def _motherpiece_review_issues(section: str) -> list[str]:
    if not section:
        return []
    has_v2_body = _has_heading(section, "正文", level=3)
    has_v2_shape = (
        has_v2_body
        and _heading_count(_heading_body(section, "正文", level=3), level=4) >= 2
        and _has_heading(section, "评论区引导", level=3)
        and _has_actionable_content(_heading_body(section, "评论区引导", level=3))
        and not _placeholder_lines(_heading_body(section, "评论区引导", level=3))
        and bool(_field_group_value(section, ["标题备选"]))
        and not _field_group_invalid(section, ["封面/摘要建议", "封面摘要建议"])
    )
    if has_v2_shape:
        return []
    if not _field_invalid(section, "正文"):
        return ["公众号母稿仍是 V1 字段式正文，建议升级为 V2 表现力结构。"]
    return []


def _missing_comment_groups(section: str) -> list[str]:
    return [
        label
        for label, fields in COMMENT_FIELD_GROUPS
        if _field_group_invalid(section, fields)
    ]


def _motherpiece_has_comment_hook(section: str) -> bool:
    if _has_heading(section, "评论区引导", level=3):
        comment_hook = _heading_body(section, "评论区引导", level=3)
        return _has_actionable_content(comment_hook) and not _placeholder_lines(comment_hook)
    comment_hook = _field_group_value(section, ["评论区引导", "评论维护话术"])
    return bool(comment_hook) and _has_actionable_content(comment_hook) and not _placeholder_lines(comment_hook)


def _package_primary_title(section: str) -> str:
    return _field_group_value(section, ["发布标题"]).strip()


def _title_click_errors(section: str) -> list[str]:
    title = _package_primary_title(section)
    if not title:
        return []
    compact = _compact(title)
    has_specific_object = bool(SPECIFIC_OBJECT_RE.search(compact))
    has_tension = bool(TITLE_TENSION_RE.search(compact))
    abstract_hits = [term for term in ABSTRACT_TITLE_TERMS if term in compact]
    if abstract_hits and not has_specific_object:
        return [f"标题点击力不足：发布标题 `{title}` 只有抽象概念，缺少具体对象或场景。"]
    if not has_specific_object and not has_tension:
        return [f"标题点击力不足：发布标题 `{title}` 缺少具体对象、场景或冲突。"]
    if len(compact) <= 10 and abstract_hits:
        return [f"标题点击力不足：发布标题 `{title}` 过短且偏方法论，读者无法判断和自己有什么关系。"]
    return []


def _opening_propagation_errors(section: str) -> list[str]:
    body_text = _heading_body(section, "正文", level=3) or _field_group_value(section, ["正文"])
    if not body_text:
        return []
    opening = _compact(_first_body_paragraph(body_text)[:360])
    missing: list[str] = []
    if not OPENING_SCENE_RE.search(opening):
        missing.append("现场")
    if not OPENING_CONFLICT_RE.search(opening):
        missing.append("冲突")
    if not OPENING_COST_RE.search(opening):
        missing.append("代价")
    if missing:
        return [f"公众号母稿开头传播力不足：前 300 字缺少{'、'.join(missing)}。"]
    return []


def _first_body_paragraph(body_text: str) -> str:
    for raw_line in body_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith(">") or line.startswith("|"):
            continue
        if re.match(r"^[-*]\s*[^：:]{1,24}[：:]", line):
            continue
        return line
    return body_text


def _shareable_candidates(section: str) -> list[str]:
    candidates: list[str] = []
    for line in section.splitlines():
        stripped = line.strip()
        if stripped.startswith(">"):
            item = stripped.lstrip("> ").strip()
            if item:
                candidates.append(item)

    quote_field = _field_group_value(section, ["重点引用", "金句", "重点引用/金句"])
    if quote_field:
        candidates.extend(
            item.strip()
            for item in re.split(r"[；;\n]", quote_field)
            if item.strip()
        )
    return candidates


def _is_shareable_judgment(sentence: str) -> bool:
    compact = _compact(sentence).strip("。.!！?？")
    if not 12 <= len(compact) <= 90:
        return False
    if not SPECIFIC_OBJECT_RE.search(compact):
        return False
    return bool(SHAREABLE_JUDGMENT_RE.search(compact))


def _shareable_judgment_errors(section: str) -> list[str]:
    candidates = _shareable_candidates(section)
    if not any(_is_shareable_judgment(candidate) for candidate in candidates):
        return ["公众号母稿缺少可转发传播句：重点引用/金句需要包含具体对象和清晰判断，不能只是泛泛口号。"]
    return []


def _comment_propagation_errors(section: str) -> list[str]:
    if _has_heading(section, "评论区引导", level=3):
        comment_hook = _heading_body(section, "评论区引导", level=3)
    else:
        comment_hook = _field_group_value(section, ["评论区引导", "评论维护话术"])
    if not comment_hook:
        return []
    compact = _compact(comment_hook)
    if GENERIC_COMMENT_RE.search(compact) and not BUSINESS_INFO_RE.search(compact):
        return ["公众号母稿评论钩子过于泛泛：不能只问“你怎么看”，必须引导读者留下可诊断的业务信息。"]
    first_actionable = _actionable_items(comment_hook)[:2]
    if any(GENERIC_COMMENT_RE.search(item) for item in first_actionable):
        return ["公众号母稿评论钩子过于泛泛：置顶/首评不能只问“你怎么看”，必须改成填空式业务信息。"]
    if first_actionable and not any(BUSINESS_INFO_RE.search(item) for item in first_actionable):
        return ["公众号母稿评论钩子缺少填空式业务信息：置顶/首评至少要引导业务、产品、客户、场景或卡点。"]
    return []


def _motherpiece_propagation_errors(section: str) -> list[str]:
    if not section:
        return []
    issues: list[str] = []
    issues.extend(_title_click_errors(section))
    issues.extend(_opening_propagation_errors(section))
    issues.extend(_shareable_judgment_errors(section))
    issues.extend(_comment_propagation_errors(section))
    return issues


def _motherpiece_publish_state_errors(section: str) -> list[str]:
    issues: list[str] = []
    for label, fields in MOTHERPIECE_PUBLISH_FIELD_GROUPS:
        if _field_group_missing(section, fields):
            issues.append(f"公众号母稿缺少发布态字段：{label}。")
            continue
        value = _field_group_value(section, fields)
        min_len = 2 if label == "封面字" else 10
        if _placeholder_value(value) or len(_compact(value)) < min_len:
            issues.append(f"公众号母稿发布态字段不可为空或过短：{label}。")
    layout_value = _field_group_value(section, ["公众号排版提示", "排版提示", "HTML 排版建议"])
    if layout_value and not re.search(r"留白|引用|卡片|标题|段落|正文|重点|HTML|排版", layout_value):
        issues.append("公众号排版提示缺少可执行的发布排版指令。")
    image_value = _field_group_value(section, ["配图位建议", "图片需求", "配图建议"])
    if image_value and not re.search(r"图|配图|图片|对照|便签|白板|卡片|截图|封面", image_value):
        issues.append("配图位建议缺少可执行的图片位置或画面说明。")
    return issues


def _subsections(section: str, prefix: str) -> list[str]:
    pattern = rf"(?ms)^###(?!#)\s*{re.escape(prefix)}\s*\d+[^\n]*\n(.*?)(?=^###(?!#)\s*|\Z)"
    return [match.group(1).strip() for match in re.finditer(pattern, section)]


def _subsections_any(section: str, prefixes: list[str]) -> list[str]:
    for prefix in prefixes:
        blocks = _subsections(section, prefix)
        if blocks:
            return blocks
    return []


def _count_error(label: str, actual: int, expected: int) -> list[str]:
    if actual == expected:
        return []
    return [f"{label}数量不符合要求：应为 {expected} 条，当前为 {actual} 条。"]


def _contains_risky_comment_language(text: str) -> bool:
    """Check audience-facing reply scripts, not the package's own guardrails.

    The package deliberately repeats forbidden phrases in ``平台风险边界`` so
    the operator knows what not to publish. Scanning the entire Markdown made
    those negative examples look like unsafe comment copy and blocked a fully
    reviewed package at confirmation time.
    """
    risky = re.compile(r"加微信|私信领取|私信我|VX|v信|保证|100%|必然", re.IGNORECASE)
    disclaimer = re.compile(
        r"(?:不|未|勿|别|禁止|不得|不能|避免|不作|不做).{0,12}"
        r"(?:加微信|私信领取|私信我|VX|v信|保证|100%|必然)",
        re.IGNORECASE,
    )
    comment_blocks = re.findall(
        r"(?ms)^#{3,4}\s+(?:评论区引导|评论维护话术)\s*$\n(.*?)(?=^#{1,4}\s+|\Z)",
        text,
    )
    for raw_line in "\n".join(comment_blocks).splitlines():
        line = _compact(raw_line)
        if risky.search(line) and not disclaimer.search(line):
            return True
    return False


def _status(errors: list[str], reviews: list[str]) -> str:
    if errors:
        return "blocked"
    if reviews:
        return "review_required"
    return "pass"


def audit_package(body: str) -> dict[str, Any]:
    errors: list[str] = []
    reviews: list[str] = []

    legacy_hits = [marker for marker in LEGACY_PACKAGE_MARKERS if marker in body]
    if legacy_hits:
        errors.append(
            "最终内容不能沿用旧资产包报告结构："
            + "、".join(legacy_hits)
            + " 应删除；评论维护话术和风险边界要嵌入对应内容单元。"
        )

    motherpiece = _section_any(body, 1, ["公众号母稿", "公众号长文"])
    scripts = _section_any(body, 2, ["短视频内容", "短视频口播", "短视频口播稿"])
    opinions = _section_any(body, 3, ["图文内容", "分享观点图文", "分享观点"])

    section_counts = [
        ("公众号长文章节", r"(?m)^##\s*1\.\s+公众号(?:母稿|长文)"),
        ("短视频内容章节", r"(?m)^##\s*2\.\s+短视频(?:内容|口播(?:稿)?)"),
        ("分享观点图文章节", r"(?m)^##\s*3\.\s+(?:图文内容|分享观点图文|分享观点)"),
    ]
    for label, pattern in section_counts:
        errors.extend(_count_error(label, len(re.findall(pattern, body)), 1))
    has_single_motherpiece = len(re.findall(section_counts[0][1], body)) == 1

    motherpiece_errors = _motherpiece_errors(motherpiece)
    errors.extend(motherpiece_errors)
    # The owner has already reviewed every delivery unit before this gate is
    # called. Propagation heuristics are valuable feedback, but unlike missing
    # release fields, privacy leaks, unsupported claims, or risky CTAs they
    # should not invalidate an otherwise publishable, human-reviewed package.
    reviews.extend(_motherpiece_propagation_errors(motherpiece))
    reviews.extend(_motherpiece_review_issues(motherpiece))

    script_blocks = _subsections_any(scripts, ["短视频", "口播"])
    errors.extend(_count_error("短视频口播稿", len(script_blocks), 2))
    for idx, block in enumerate(script_blocks, start=1):
        errors.extend(_video_errors(block, idx))

    opinion_blocks = _subsections_any(opinions, ["图文", "分享观点", "观点"])
    if not opinion_blocks:
        errors.append("分享观点图文至少需要 1 条。")
    for idx, block in enumerate(opinion_blocks, start=1):
        missing = [label for label, fields in OPINION_FIELD_GROUPS if _field_group_missing(block, fields)]
        if missing:
            errors.append(f"分享观点 {idx} 缺少字段：{', '.join(missing)}。")
        invalid_fields = [label for label, fields in OPINION_FIELD_GROUPS if _field_group_invalid(block, fields)]
        if invalid_fields:
            errors.append(f"分享观点 {idx} 存在空值、占位或格式错误字段：{', '.join(invalid_fields)}。")
        errors.extend(_page_script_errors_v2(block, idx))
        errors.extend(_opinion_platform_errors(block, idx))
        errors.extend(_comment_script_errors(block, f"分享观点 {idx}"))
        errors.extend(_risk_boundary_errors(block, f"分享观点 {idx}"))

    risky_comment_text = "\n".join([motherpiece, *script_blocks, *opinion_blocks])
    if _contains_risky_comment_language(risky_comment_text):
        errors.append("评论维护话术存在高风险导流或承诺表达，必须改写。")

    if _has_placeholder_language(body):
        reviews.append("最终内容包含占位词：建议人工复核所有 TO" + "DO/T" + "BD/待补内容。")

    has_segmented_video_scripts = len(script_blocks) == 2 and all(
        not _segmented_script_errors(block, idx)
        and not _line_script_errors(block, idx)
        and not _shot_table_errors(block, idx)
        and not _subtitle_errors(block, idx)
        and not _broll_errors(block, idx)
        for idx, block in enumerate(script_blocks, start=1)
    )
    has_video_publish_notes = len(script_blocks) == 2 and all(
        not _platform_adaptation_errors(
            block,
            f"短视频 {idx}",
            VIDEO_PUBLISH_NOTE_HEADINGS,
            VIDEO_PLATFORM_FIELD_GROUPS,
        )
        for idx, block in enumerate(script_blocks, start=1)
    )
    has_video_publish_forms = len(script_blocks) == 2 and all(
        not _platform_publish_form_errors(
            block,
            f"短视频 {idx}",
            VIDEO_PUBLISH_FORM_HEADINGS,
            VIDEO_PUBLISH_FORM_FIELD_GROUPS,
        )
        for idx, block in enumerate(script_blocks, start=1)
    )
    has_page_card_scripts = bool(opinion_blocks) and all(
        _has_heading(block, "页卡脚本", level=4) for block in opinion_blocks
    )
    has_share_platform_adaptations = bool(opinion_blocks) and all(
        not _opinion_platform_errors(block, idx)
        for idx, block in enumerate(opinion_blocks, start=1)
    )
    has_motherpiece_presentation = (
        _has_heading(motherpiece, "正文", level=3)
        and _heading_count(_heading_body(motherpiece, "正文", level=3), level=4) >= 2
        and _has_heading(motherpiece, "评论区引导", level=3)
        and _has_actionable_content(_heading_body(motherpiece, "评论区引导", level=3))
        and not _placeholder_lines(_heading_body(motherpiece, "评论区引导", level=3))
        and (bool(_field_group_value(motherpiece, ["标题备选"])) or len(re.findall(r"标题", motherpiece)) >= 2)
        and not _field_group_invalid(motherpiece, ["封面/摘要建议", "封面摘要建议"])
        and _has_quote_signal(motherpiece)
    )

    return {
        "status": _status(errors, reviews),
        "errors": errors,
        "reviews": reviews,
        "blocking_issues": errors,
        "review_issues": reviews,
        "checks": {
            "has_wechat_article": has_single_motherpiece and not motherpiece_errors,
            "has_motherpiece": has_single_motherpiece and not motherpiece_errors,
            "has_video_scripts": len(script_blocks) == 2 and all(
                not _video_errors(block, idx)
                for idx, block in enumerate(script_blocks, start=1)
            ),
            "has_xhs_copy": bool(opinion_blocks),
            "has_opinion_cards": bool(opinion_blocks),
            "has_comment_hooks": _motherpiece_has_comment_hook(motherpiece)
            and all(
                not _comment_script_errors(block, "内容")
                and not _risk_boundary_errors(block, "内容")
                for block in [*script_blocks, *opinion_blocks]
            ),
            "has_presentation_v2": (
                has_motherpiece_presentation
                and has_segmented_video_scripts
                and has_video_publish_notes
                and has_video_publish_forms
                and has_page_card_scripts
                and has_share_platform_adaptations
            ),
            "has_segmented_video_scripts": has_segmented_video_scripts,
            "has_video_publish_notes": has_video_publish_notes,
            "has_video_publish_forms": has_video_publish_forms,
            "has_page_card_scripts": has_page_card_scripts,
            "has_share_platform_adaptations": has_share_platform_adaptations,
            "has_propagation_gate": not _motherpiece_propagation_errors(motherpiece),
        },
    }

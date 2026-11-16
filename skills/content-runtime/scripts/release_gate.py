#!/usr/bin/env python3
"""Unit-level release gate for the fixed 1+2+3 content package.

The gate is deliberately local and inspectable. It does not invent facts or
silently rewrite protected material: quotations, tables, numerical claims,
links, citations, brand names, and approved CTA fields are left unchanged.
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from package_quality import audit_package
from generated_language_quality import inspect_generated_language


ALL_PLATFORMS = ["wechat", "xiaohongshu", "shipinhao", "douyin", "moments"]
PRIMARY_PLATFORMS = ["wechat", "xhs", "shipinhao"]
PLATFORM_LABEL_TO_ID = {"公众号": "wechat", "小红书": "xhs", "视频号": "shipinhao"}

SAFE_AI_FILLER = {
    "值得注意的是，": "",
    "需要指出的是，": "",
    "在这个过程中，": "",
    "总的来说，": "",
    "综上所述，": "",
    "由此可见，": "",
    "此外，": "",
    "某种意义上，": "",
}

# These substitutions are intentionally narrow and applied only to ordinary
# prose. They remove the most obvious stock phrasing without changing facts,
# named entities, quotations, tables, links, or approved calls to action.
SAFE_AI_TONE_REPAIRS = (
    (re.compile(r"(?:首先|其次|最后)，"), ""),
    (re.compile(r"不仅仅是"), "不只是"),
    (re.compile(r"并非只是"), "不是"),
    (re.compile(r"更是"), "也"),
    (re.compile(r"赋能"), "帮助"),
    (re.compile(r"闭环"), "完整过程"),
    (re.compile(r"抓手"), "做法"),
    (re.compile(r"底层逻辑"), "原因"),
    (re.compile(r"全链路"), "完整流程"),
)
MAX_AI_REPAIR_PASSES = 3

RESIDUAL_AI_PATTERNS = (
    r"\b(?:首先|其次|最后)，",
    r"(?:不仅仅是|并非只是).{0,16}(?:更是|而是)",
    r"(?:赋能|闭环|抓手|底层逻辑|全链路)",
)

EXPLICIT_CLAIM_RE = re.compile(
    r"(?:据统计|数据显示|研究(?:显示|表明)|调查(?:显示|表明)|报告(?:显示|指出)|"
    r"\d+(?:\.\d+)?%|增长\s*\d+(?:\.\d+)?%|提升\s*\d+(?:\.\d+)?%)"
)
SOURCE_RE = re.compile(r"(?:来源|资料来源|数据源|据[^。；\n]{2,40}(?:显示|统计)|https?://|materials/)" )
PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
COPYRIGHT_RE = re.compile(r"(?:图片来源网络|转载自|未经授权|盗图|搬运)")
HIGH_RISK_PLATFORM_RE = re.compile(r"(?:保证收益|稳赚不赔|治愈疾病|百分之百(?:有效|成功)|100%\s*(?:有效|成功|收益))", re.IGNORECASE)
REVIEW_PLATFORM_RE = re.compile(r"(?:最[好高强快]|唯一|顶级|国家级|绝对)")


@dataclass(frozen=True)
class UnitSpan:
    unit_id: str
    kind: str
    title: str
    start: int
    end: int
    platform_bindings: list[str]


def _section_span(body: str, heading: str) -> tuple[int, int] | None:
    match = re.search(rf"(?m)^##\s*{re.escape(heading)}\s*$", body)
    if not match:
        return None
    next_match = re.search(r"(?m)^##\s+", body[match.end():])
    end = match.end() + next_match.start() if next_match else len(body)
    return match.start(), end


def _heading_spans(section: str, offset: int, prefixes: tuple[str, ...]) -> list[tuple[str, int, int]]:
    pattern = re.compile(r"(?m)^###\s+(.+?)\s*$")
    headings = [(match.group(1).strip(), offset + match.start(), offset + match.end()) for match in pattern.finditer(section)]
    matches = [item for item in headings if item[0].startswith(prefixes)]
    rows: list[tuple[str, int, int]] = []
    for index, (title, start, heading_end) in enumerate(matches):
        next_start = matches[index + 1][1] if index + 1 < len(matches) else offset + len(section)
        rows.append((title, start, next_start))
    return rows


def _title_from_heading(value: str) -> str:
    return re.sub(r"^(?:短视频|图文|分享观点)\s*\d+\s*[：:]?\s*", "", value).strip() or value


def _structural_issues(kind: str, text: str, index: int) -> list[str]:
    if kind == "article":
        return [] if "### 正文" in text else ["公众号母稿缺少正文。"]
    if kind == "video_script":
        issues = []
        for heading in ("#### 逐句口播稿", "#### 镜头清单", "#### 字幕重点", "#### B-roll 素材建议"):
            if heading not in text:
                issues.append(f"短视频 {index} 缺少 `{heading}`。")
        return issues
    issues = []
    if "#### 页卡脚本" not in text:
        issues.append(f"图文 {index} 缺少 `#### 页卡脚本`。")
    else:
        pages = {match.upper() for match in re.findall(r"\bP\s*([1-5])\b", text, re.IGNORECASE)}
        missing = [f"P{page}" for page in range(1, 6) if str(page) not in pages]
        if missing:
            issues.append(f"图文 {index} 页卡脚本缺少：{', '.join(missing)}。")
    return issues


def _native_structural_issues(platform: str, text: str) -> list[str]:
    required = {
        "wechat": ("### 正文", "### 评论区承接"),
        "xhs": ("### 封面三句话", "### 图文卡片脚本", "### 发布正文", "### 结尾标签"),
        "shipinhao": ("### 逐句口播稿", "### 镜头清单", "### 字幕重点", "### B-roll 建议", "### 发布文案"),
    }[platform]
    issues = [f"{PLATFORM_LABEL_TO_ID_INV[platform]}原生内容缺少 `{heading}`。" for heading in required if heading not in text]
    if not _native_field(text, "标题" if platform == "xhs" else "发布标题"):
        issues.append(f"{PLATFORM_LABEL_TO_ID_INV[platform]}原生内容缺少可发布标题。")
    elif "\n" in _native_field(text, "标题" if platform == "xhs" else "发布标题"):
        issues.append(f"{PLATFORM_LABEL_TO_ID_INV[platform]}发布标题包含多行文字，请保留一个明确标题。")
    if platform == "xhs" and "### 图文卡片脚本" in text:
        pages = {int(value) for value in re.findall(r"(?m)^\s*\|\s*P([1-8])\s*\|", text, re.IGNORECASE)}
        missing = [f"P{page}" for page in range(1, 9) if page not in pages]
        if missing:
            issues.append(f"小红书原生图文卡片缺少：{', '.join(missing)}。")
    return issues


def _native_visible(text: str) -> str:
    """Mask examples without moving source offsets or treating them as fields."""
    mask = lambda value: re.sub(r"[^\r\n]", " ", value)
    text = re.sub(r"<!--[\s\S]*?(?:-->|$)", lambda match: mask(match[0]), text)
    fence = None
    lines = []
    for line in text.splitlines(keepends=True):
        marker = re.match(r"^[ \t]*(`{3,}|~{3,})", line)
        if marker:
            if fence is None:
                fence = marker[1]
            elif marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                fence = None
            lines.append(mask(line))
        else:
            lines.append(mask(line) if fence else line)
    return "".join(lines)


def _native_field_values(text: str, *labels: str) -> list[str]:
    visible = _native_visible(text)
    boundaries = []
    for line in re.finditer(r"[^\r\n]*(?:\r\n|\r|\n|$)", visible):
        if not line[0]:
            continue
        value = line[0].rstrip("\r\n")
        heading = re.match(r"^(#{1,6})[ \t]+(.+?)[ \t]*$", value)
        field = re.match(r"^[ \t]*[-*][ \t]+(?:\*\*)?([^：:\r\n]{1,60}?)(?:\*\*)?[ \t]*[：:][ \t]*", value)
        if heading:
            boundaries.append((line.start(), line.end(), re.sub(r"[：:][ \t]*$", "", heading[2]).strip(), True))
        elif field:
            boundaries.append((line.start(), line.start() + field.end(), field[1].strip(), False))
    values = []
    for index, (_, start, label, _) in enumerate(boundaries):
        if label in labels:
            end = next((entry[0] for entry in boundaries[index + 1:]
                        if label != "正文" or entry[3] or entry[2] in ("标题", "正文", "结尾问题")), len(visible))
            values.append(visible[start:end].strip())
    return values


def _native_field(text: str, *labels: str) -> str:
    values = _native_field_values(text, *labels)
    return values[0] if len(values) == 1 else ""


def _native_heading_body(text: str, heading: str) -> str:
    match = re.search(rf"(?m)^###\s*{re.escape(heading)}\s*$", text)
    if not match:
        return ""
    next_heading = re.search(r"(?m)^#{1,3}\s+", text[match.end():])
    end = match.end() + next_heading.start() if next_heading else len(text)
    return text[match.end():end].strip()


def _native_table_rows(section: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for raw_line in section.splitlines():
        line = raw_line.strip()
        if not line.startswith("|") or not line.endswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if not cells or all(re.fullmatch(r":?-{2,}:?", cell or "-") for cell in cells):
            continue
        rows.append(cells)
    return rows[1:] if len(rows) >= 2 else []


def _native_list_items(section: str) -> list[str]:
    return [
        match.group(1).strip()
        for line in section.splitlines()
        if (match := re.match(r"^\s*[-*]\s+(.+?)\s*$", line))
    ]


def _native_text_length(text: str) -> int:
    plain = re.sub(r"(?m)^#{1,6}\s+", "", text)
    plain = re.sub(r"(?m)^\s*[-*]\s*", "", plain)
    plain = re.sub(r"[\s|`*_>#-]+", "", plain)
    return len(plain)


def _audit_native_package(body: str, manifest: dict[str, Any]) -> dict[str, Any]:
    """Audit meaning and platform usability beyond the Markdown shell.

    Hard blockers are reserved for missing publishable fields or collapsed
    platform contracts. Editorial heuristics remain review items so a human can
    approve an intentionally concise style without weakening fact safeguards.
    """
    errors: list[str] = []
    reviews: list[str] = []
    checks: dict[str, bool] = {}

    shared_span = _section_span(body, "0. 共享事实底稿")
    shared = body[shared_span[0]:shared_span[1]] if shared_span else ""
    for label in ("事实与案例", "共同观点", "不可公开边界"):
        if not _native_field(shared, label):
            reviews.append(f"请补充本篇的{label}，发布前由你核对。")
    checks["shared_fact_boundary_complete"] = all(
        _native_field(shared, label) for label in ("事实与案例", "共同观点", "不可公开边界")
    )

    derivation = re.compile(
        r"(?:由|从|基于)(?:公众号|长文|母稿).{0,12}(?:改写|拆解|拆成|提炼|摘要)|"
        r"(?:公众号|长文|母稿)(?:改写|拆解|拆成|摘要)|基于上文|沿用上文",
        re.IGNORECASE,
    )
    if derivation.search(body):
        errors.append("平台内容出现母稿改写或跨平台派生痕迹；必须从共享事实和本平台蓝图独立生成。")
    checks["platform_lanes_independent"] = not bool(derivation.search(body))

    sections = {
        "wechat": _section_span(body, "1. 公众号原生长文"),
        "xhs": _section_span(body, "2. 小红书原生图文"),
        "shipinhao": _section_span(body, "3. 视频号原生口播"),
    }
    titles: dict[str, str] = {}

    if "wechat" in manifest.get("target_platforms", []) and sections["wechat"]:
        start, end = sections["wechat"]
        section = body[start:end]
        titles["wechat"] = _native_field(section, "发布标题")
        required_fields = {
            "标题备选": _native_field(section, "标题备选"),
            "摘要": _native_field(section, "摘要"),
            "头图文案": _native_field(section, "头图文案", "封面字"),
            "排版提示": _native_field(section, "排版提示", "公众号排版提示"),
            "正文插图位置": _native_field(section, "正文插图位置", "插图位置", "配图位建议"),
        }
        missing = [label for label, value in required_fields.items() if not value]
        if missing:
            errors.append("公众号原生长文缺少可发布字段：" + "、".join(missing) + "。")
        summary_length = _native_text_length(required_fields["摘要"])
        if required_fields["摘要"] and not 60 <= summary_length <= 160:
            reviews.append(f"公众号摘要当前约 {summary_length} 字，建议控制在 60-160 字。")
        article = _native_heading_body(section, "正文")
        article_length = _native_text_length(article)
        reviews.append(f"公众号正文当前约 {article_length} 字；请按本篇已确认的篇幅要求核对，不必为了默认长文篇幅补字。")
        heading_count = len(re.findall(r"(?m)^####\s+\S", article))
        if heading_count < 2:
            reviews.append("请核对正文是否需要分段或小标题，按本篇的结构要求决定。")
        checks["wechat_publish_fields_complete"] = not missing
        checks["wechat_article_nonempty"] = article_length > 0

    if "xhs" in manifest.get("target_platforms", []) and sections["xhs"]:
        start, end = sections["xhs"]
        section = body[start:end]
        cover = _native_heading_body(section, "封面三句话")
        cover_fields = [_native_field(cover, label) for label in ("主句", "副句", "补充句")]
        if any(not value for value in cover_fields):
            errors.append("小红书封面必须完整填写主句、副句和补充句。")
        script = _native_heading_body(section, "图文卡片脚本")
        rows = _native_table_rows(script)
        page_rows = {cells[0].upper().replace(" ", ""): cells for cells in rows if cells}
        weak_pages: list[str] = []
        for page in (f"P{index}" for index in range(1, 9)):
            cells = page_rows.get(page, [])
            if len(cells) < 6 or any(not cell for cell in cells[:6]):
                weak_pages.append(page)
        if weak_pages:
            errors.append("小红书 P1-P8 必须逐页包含页面任务、标题、正文、视觉提示和证据边界；不完整页面：" + "、".join(weak_pages) + "。")
        elif any(_native_text_length(page_rows[f"P{index}"][3]) < 8 for index in range(1, 9)):
            reviews.append("小红书部分页面正文信息过少，建议让每页只推进一个完整判断，而不是口号。")
        publish = _native_heading_body(section, "发布正文")
        titles["xhs"] = _native_field(publish, "标题")
        missing_publish = [
            label for label, value in {
                "标题": titles["xhs"],
                "正文": _native_field(publish, "正文"),
                "结尾问题": _native_field(publish, "结尾问题"),
            }.items() if not value
        ]
        if missing_publish:
            errors.append("小红书发布正文缺少：" + "、".join(missing_publish) + "。")
        tags = re.findall(r"#[^\s#]+", _native_heading_body(section, "结尾标签"))
        if not 3 <= len(tags) <= 6:
            reviews.append(f"小红书当前有 {len(tags)} 个标签，建议保留 3-6 个准确标签。")
        checks["xhs_exact_p1_p8"] = not weak_pages and len(page_rows) == 8
        checks["xhs_publish_fields_complete"] = not missing_publish and all(cover_fields)

    if "shipinhao" in manifest.get("target_platforms", []) and sections["shipinhao"]:
        start, end = sections["shipinhao"]
        section = body[start:end]
        titles["shipinhao"] = _native_field(section, "发布标题")
        hook = _native_field(section, "3秒钩子", "3 秒钩子", "开场钩子")
        duration = _native_field(section, "建议时长", "时长")
        if not hook or not duration:
            errors.append("视频号原生口播缺少 3 秒钩子或建议时长。")
        script_rows = _native_table_rows(_native_heading_body(section, "逐句口播稿"))
        shot_rows = _native_table_rows(_native_heading_body(section, "镜头清单"))
        if len(script_rows) < 3:
            errors.append("视频号逐句口播稿至少需要 3 个可剪辑时间段，不能用一段文章代替。")
        if len(shot_rows) < 2:
            errors.append("视频号镜头清单至少需要 2 个可执行镜头。")
        subtitles = _native_list_items(_native_heading_body(section, "字幕重点"))
        broll = _native_list_items(_native_heading_body(section, "B-roll 建议"))
        if len(subtitles) < 2:
            reviews.append("视频号字幕重点过少，建议至少标出核心判断和关键转折。")
        if len(broll) < 2:
            reviews.append("视频号 B-roll 过少，建议至少准备两个能支撑口播节奏的真实画面。")
        publish = _native_heading_body(section, "发布文案")
        missing_publish = [
            label for label, value in {
                "简介": _native_field(publish, "简介"),
                "话题": _native_field(publish, "话题"),
                "置顶评论": _native_field(publish, "置顶评论"),
            }.items() if not value
        ]
        if missing_publish:
            errors.append("视频号发布文案缺少：" + "、".join(missing_publish) + "。")
        checks["shipinhao_editable_script"] = len(script_rows) >= 3 and len(shot_rows) >= 2
        checks["shipinhao_publish_fields_complete"] = not missing_publish

    normalized_titles = [re.sub(r"\W+", "", value) for value in titles.values() if value]
    if len(normalized_titles) >= 2 and len(set(normalized_titles)) != len(normalized_titles):
        reviews.append("多个平台使用了相同发布标题；请确认这不是跨平台直接复制，而是各自符合平台入口。")
        checks["platform_titles_distinct"] = False
    else:
        checks["platform_titles_distinct"] = True

    return {
        "status": "blocked" if errors else "review_required" if reviews else "pass",
        "errors": errors,
        "blocking_issues": errors,
        "reviews": reviews,
        "review_issues": reviews,
        "checks": checks,
    }


PLATFORM_LABEL_TO_ID_INV = {value: key for key, value in PLATFORM_LABEL_TO_ID.items()}


def _build_native_package_manifest(body: str) -> dict[str, Any]:
    units: list[UnitSpan] = []
    errors: list[str] = []
    visible = _native_visible(body)
    for title in ("0. 共享事实底稿", "1. 公众号原生长文", "2. 小红书原生图文", "3. 视频号原生口播"):
        if len(re.findall(rf"(?m)^##[ \t]+{re.escape(title)}[ \t]*$", visible)) > 1:
            errors.append(f"“{title}”重复，请保留一个明确的章节。")
    shared_span = _section_span(visible, "0. 共享事实底稿")
    shared = visible[shared_span[0]:shared_span[1]] if shared_span else ""
    selected_labels = _native_field(shared, "本期平台")
    aliases = {**PLATFORM_LABEL_TO_ID, **{platform: platform for platform in PRIMARY_PLATFORMS}, "xiaohongshu": "xhs"}
    tokens = [token for token in re.split(r"[\s,，、;；/|]+", selected_labels.strip()) if token]
    selected = [aliases[token] for token in tokens if token in aliases]
    if len(_native_field_values(shared, "本期平台")) > 1 or len(selected) != len(tokens) or len(set(selected)) != len(selected):
        errors.append("本期平台重复、冲突或包含未知名称，请核对已选平台。")
    if not selected:
        errors.append("共享事实底稿缺少有效的本期平台。")

    sections = {
        "wechat": _section_span(visible, "1. 公众号原生长文"),
        "xhs": _section_span(visible, "2. 小红书原生图文"),
        "shipinhao": _section_span(visible, "3. 视频号原生口播"),
    }
    scope_errors = list(errors)
    if set(selected) != {platform for platform, span in sections.items() if span}:
        scope_errors.append("本期平台声明与实际原生章节不一致。")
    kinds = {"wechat": "article", "xhs": "xhs_post", "shipinhao": "video_script"}
    for platform in PRIMARY_PLATFORMS:
        span = sections[platform]
        if platform in selected and not span:
            errors.append(f"已选{PLATFORM_LABEL_TO_ID_INV[platform]}但缺少对应原生内容。")
            continue
        if platform not in selected and span:
            errors.append(f"未选择{PLATFORM_LABEL_TO_ID_INV[platform]}，不应生成该平台内容。")
            continue
        if not span:
            continue
        section = body[span[0]:span[1]]
        for labels in (("发布标题",), ("标题",), ("3秒钩子", "3 秒钩子", "开场钩子"), ("建议时长", "时长"), ("简介",), ("话题",), ("置顶评论",)):
            if len(_native_field_values(section, *labels)) > 1:
                errors.append(f"{PLATFORM_LABEL_TO_ID_INV[platform]}的“{labels[0]}”重复或冲突，请保留一个明确值。")
        units.append(UnitSpan(
            f"platform-{platform}",
            kinds[platform],
            _native_field(section, "发布标题") or f"{PLATFORM_LABEL_TO_ID_INV[platform]}原生内容",
            span[0], span[1], [platform],
        ))
        errors.extend(_native_structural_issues(platform, section))

    if not units:
        errors.append("至少需要一个已选平台的原生内容。")
    return {
        "schema": "echo-founder.platform-native-package.v2",
        "target_platforms": selected,
        "platform_scope_errors": scope_errors,
        "valid": not errors,
        "errors": errors,
        "units": [
            {
                "id": unit.unit_id,
                "kind": unit.kind,
                "title": unit.title,
                "platform_bindings": unit.platform_bindings,
                "structural_issues": _native_structural_issues(unit.platform_bindings[0], body[unit.start:unit.end]),
            }
            for unit in units
        ],
        "_spans": units,
    }


def build_package_manifest(body: str) -> dict[str, Any]:
    """Extract the six release units without turning Markdown into a fragile UI API."""
    if "## 0. 共享事实底稿" in body:
        return _build_native_package_manifest(body)
    units: list[UnitSpan] = []
    errors: list[str] = []
    article_span = _section_span(body, "1. 公众号母稿") or _section_span(body, "1. 公众号长文")
    video_span = _section_span(body, "2. 短视频内容")
    opinions_span = _section_span(body, "3. 图文内容") or _section_span(body, "3. 分享观点图文")

    if article_span:
        article_text = body[article_span[0]:article_span[1]]
        title_match = re.search(r"(?m)^\s*-\s*发布标题\s*[：:]\s*(.+?)\s*$", article_text)
        units.append(UnitSpan("article", "article", title_match.group(1).strip() if title_match else "公众号长文", article_span[0], article_span[1], ["wechat"]))
    else:
        errors.append("缺少 1 篇公众号长文。")

    if video_span:
        section = body[video_span[0]:video_span[1]]
        video_rows = _heading_spans(section, video_span[0], ("短视频",))
        for index, (title, start, end) in enumerate(video_rows[:2], start=1):
            units.append(UnitSpan(f"video-{index}", "video_script", _title_from_heading(title), start, end, ["shipinhao", "douyin", "xiaohongshu"]))
        if len(video_rows) != 2:
            errors.append(f"短视频口播稿必须恰好为 2 条，当前为 {len(video_rows)} 条。")
    else:
        errors.append("缺少 2 条短视频口播稿。")

    if opinions_span:
        section = body[opinions_span[0]:opinions_span[1]]
        opinion_rows = _heading_spans(section, opinions_span[0], ("图文", "分享观点"))
        for index, (title, start, end) in enumerate(opinion_rows, start=1):
            units.append(UnitSpan(f"opinion-{index}", "opinion_post", _title_from_heading(title), start, end, ["wechat", "moments", "xiaohongshu"]))
        if not opinion_rows:
            errors.append("分享观点图文至少需要 1 条。")
    else:
        errors.append("缺少分享观点图文。")

    unit_rows = []
    for index, unit in enumerate(units, start=1):
        local_index = 1 if unit.kind == "article" else int(unit.unit_id.rsplit("-", 1)[-1])
        text = body[unit.start:unit.end]
        unit_rows.append({
            "id": unit.unit_id,
            "kind": unit.kind,
            "title": unit.title,
            "platform_bindings": unit.platform_bindings,
            "structural_issues": _structural_issues(unit.kind, text, local_index),
        })

    if len(units) < 4:
        errors.append("最终交付必须包含 1 篇长文、2 条短视频执行稿和至少 1 条观点图文。")
    for unit in unit_rows:
        errors.extend(unit["structural_issues"])
    return {
        "schema": "aifios.content-package-manifest.v1",
        "target_platforms": ALL_PLATFORMS,
        "valid": not errors,
        "errors": errors,
        "units": unit_rows,
        "_spans": units,
    }


def _is_protected_line(line: str) -> bool:
    return (
        line.lstrip().startswith((">", "|", "```"))
        or bool(re.search(r"(?:\d|https?://|来源|引用|品牌|CTA|行动|置顶|首评|追评)", line))
    )


def _repair_safe_ai_filler(text: str) -> tuple[str, int]:
    repaired: list[str] = []
    count = 0
    for line in text.splitlines(keepends=True):
        if _is_protected_line(line):
            repaired.append(line)
            continue
        updated = line
        for source, replacement in SAFE_AI_FILLER.items():
            if source in updated:
                updated = updated.replace(source, replacement)
                count += 1
        repaired.append(updated)
    return "".join(repaired), count


def _repair_safe_ai_tone(text: str) -> tuple[str, int]:
    repaired: list[str] = []
    count = 0
    for line in text.splitlines(keepends=True):
        if _is_protected_line(line):
            repaired.append(line)
            continue
        updated = line
        for pattern, replacement in SAFE_AI_TONE_REPAIRS:
            updated, replacements = pattern.subn(replacement, updated)
            count += replacements
        repaired.append(updated)
    return "".join(repaired), count


def _repair_ai_expression_until_stable(text: str) -> tuple[str, int, int]:
    """Apply bounded local repairs, then recheck before returning the unit."""
    current = text
    repair_count = 0
    passes = 0
    for _ in range(MAX_AI_REPAIR_PASSES):
        current, filler_count = _repair_safe_ai_filler(current)
        current, tone_count = _repair_safe_ai_tone(current)
        changed = filler_count + tone_count
        if not changed:
            break
        repair_count += changed
        passes += 1
        # Do not keep rewriting once the obvious AI markers are gone. Other
        # review categories (copyright and compliance) remain for a human.
        residual = sum(len(re.findall(pattern, current)) for pattern in RESIDUAL_AI_PATTERNS)
        if residual < 2:
            break
    return current, repair_count, passes


def _unit_issues(text: str) -> tuple[list[str], list[str]]:
    blocked: list[str] = []
    review: list[str] = []
    # Fixed labels, evidence tables and machine-readable fields must still be
    # checked for secrets and local paths, but they are not author prose and
    # should not trigger tone warnings such as repeated sentence openings.
    voice_text = "\n".join(
        line
        for line in text.splitlines()
        if line.strip()
        and not _is_protected_line(line)
        and not line.lstrip().startswith(("#", "-", "*"))
    )
    language = inspect_generated_language(text, voice_text)
    blocked.extend(item["message"] for item in language["blocking"])
    review.extend(item["message"] for item in language["warnings"])
    if PHONE_RE.search(text) or EMAIL_RE.search(text):
        blocked.append("检测到可能的个人联系方式或隐私信息。")
    if EXPLICIT_CLAIM_RE.search(text) and not SOURCE_RE.search(text):
        blocked.append("存在明确数据/研究/比例主张，但缺少可追溯来源。")
    if HIGH_RISK_PLATFORM_RE.search(text):
        blocked.append("存在高风险平台承诺或绝对效果表述。")
    if COPYRIGHT_RE.search(text):
        review.append("检测到第三方图片或转载来源，需要核验授权边界。")
    residual = sum(len(re.findall(pattern, text)) for pattern in RESIDUAL_AI_PATTERNS)
    if residual >= 2:
        review.append("仍有明显模板化 AI 表达，需要人工确认语气。")
    if REVIEW_PLATFORM_RE.search(text):
        review.append("存在可能的夸张宣传用语，需要人工确认平台合规性。")
    return blocked, review


def run_release_gate(body: str) -> dict[str, Any]:
    """Assess and safely repair a package. No original/rewrite diff is retained."""
    manifest = build_package_manifest(body)
    spans = manifest.pop("_spans")
    package_audit = (
        _audit_native_package(body, manifest)
        if manifest.get("schema") == "echo-founder.platform-native-package.v2"
        else audit_package(body)
    )
    blocking_issues = list(manifest["errors"])
    package_review_issues = [
        str(item)
        for item in package_audit.get("review_issues", package_audit.get("reviews", []))
    ]
    if package_audit.get("status") == "blocked":
        blocking_issues.extend(str(item) for item in package_audit.get("errors", []))

    repaired_body = body
    results: list[dict[str, Any]] = []
    replacements: list[tuple[int, int, str]] = []
    for unit, row in zip(spans, manifest["units"]):
        source = body[unit.start:unit.end]
        repaired_text, repair_count, repair_passes = _repair_ai_expression_until_stable(source)
        blocked, review = _unit_issues(repaired_text)
        if blocked:
            status = "blocked"
            blocking_issues.extend(f"{row['title']}：{issue}" for issue in blocked)
        else:
            if repair_count:
                # Persist only the current repaired unit. The original model
                # output is intentionally never stored as a rewrite diff.
                replacements.append((unit.start, unit.end, repaired_text))
            if review:
                status = "review_required"
            elif repair_count:
                status = "repaired"
            else:
                status = "passed"
        results.append({
            **row,
            "status": status,
            "repair_count": repair_count,
            "repair_passes": repair_passes,
            "blocking_issues": blocked,
            "review_issues": review,
        })

    if not blocking_issues:
        for start, end, replacement in sorted(replacements, reverse=True):
            repaired_body = repaired_body[:start] + replacement + repaired_body[end:]

    review_issues = package_review_issues + [
        issue for unit in results for issue in unit["review_issues"]
    ]
    has_review = bool(review_issues) or any(unit["status"] == "review_required" for unit in results)
    status = "blocked" if blocking_issues else "review_required" if has_review else "pass"
    return {
        "schema": "aifios.release-gate.v1",
        "status": status,
        "repaired": bool(replacements) and status != "blocked",
        "blocking_issues": blocking_issues,
        "review_issues": review_issues,
        "units": results,
        "package_manifest": manifest,
        "quality_checks": package_audit.get("checks", {}),
        "repaired_body": repaired_body,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local AIFIOS 1+2+3 release gate")
    parser.add_argument("--file", required=True, help="package Markdown file")
    parser.add_argument("--report", default="", help="optional JSON report output")
    parser.add_argument("--write-repaired", action="store_true", help="replace source only when the gate is not blocked")
    args = parser.parse_args()

    source = Path(args.file)
    result = run_release_gate(source.read_text(encoding="utf-8"))
    if args.write_repaired and result["repaired"] and result["status"] != "blocked":
        source.write_text(result["repaired_body"], encoding="utf-8")
    if args.report:
        Path(args.report).write_text(json.dumps({k: v for k, v in result.items() if k != "repaired_body"}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "repaired_body"}, ensure_ascii=False, indent=2))
    return 0 if result["status"] != "blocked" else 2


if __name__ == "__main__":
    raise SystemExit(main())

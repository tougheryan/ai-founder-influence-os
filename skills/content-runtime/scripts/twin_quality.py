#!/usr/bin/env python3
"""Deterministic quality audit for content-twin observation reports."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)
UNPUBLISHED_RE = re.compile(r"(?:未真实发布|未发布|demo|示例项目|模拟发布|内部演示)", re.IGNORECASE)
DEMO_MODE_RE = re.compile(r"(?:demo|示例项目|流程演示|演示样例|内部演示)", re.IGNORECASE)
SIMULATED_DATA_RE = re.compile(
    r"(?:非真实数据|模拟数据|样例数据|demo\s*预设|demo|示例|流程样例|待验证|无真实数据|未真实发布|不作为真实发布反馈|不写入真实)",
    re.IGNORECASE,
)
GENERIC_RE = re.compile(
    r"(?:内容很重要|继续写|风格不错|挺好|很好|比较好|比较专业|值得学习|可以复用|保持风格)"
)
TWIN_MEMORY_FILES = [
    "brain/twin/content-dna.md",
    "brain/twin/pattern-library.md",
    "brain/twin/voice-signature.md",
    "brain/twin/evolution-log.md",
    "brain/twin/reader-profile.md",
]
TWIN_SYNC_FILES = [
    "brain/no-fly-zone.md",
    "brain/style-evolution.md",
]
TWIN_PLAN_FILES = TWIN_MEMORY_FILES + TWIN_SYNC_FILES
DOWNSTREAM_SKILL_RE = re.compile(
    r"(?:wechat-writer|content-breakdown|content-angle|content-review|content-twin)",
    re.IGNORECASE,
)
MERGE_STRATEGY_RE = re.compile(r"(?:新增|更新|去重|合并|追加|同步|frequency\s*\+?\s*1|last_seen)", re.IGNORECASE)


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    match = re.search(
        rf"(?m)^\s*[-*]\s*(?:\*\*)?\s*(?:{label_pattern})\s*(?:\*\*)?\s*[：:]\s*(.+?)\s*$",
        section or "",
    )
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 2) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    if PLACEHOLDER_RE.search(value):
        return False
    return True


def table_or_list_rows(section: str) -> int:
    rows = 0
    for line in (section or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("|") and "---" not in stripped:
            rows += 1
        elif re.match(r"^(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+", stripped):
            rows += 1
    return rows


def split_item_count(value: str) -> int:
    if not value:
        return 0
    normalized = re.sub(r"\d+[.)、]\s*", "；", value)
    parts = [
        part.strip(" 「」\"'`")
        for part in re.split(r"[、,，；;|/]+", normalized)
        if part.strip(" 「」\"'`")
    ]
    return len(parts) if parts else 1


def mentions_file(text: str, file_path: str) -> bool:
    basename = Path(file_path).name
    return file_path in (text or "") or basename in (text or "")


def has_evidence_signal(section: str) -> bool:
    return bool(re.search(r"(?:原文片段|证据|例句|摘录|来自原文|「.+?」|\".+?\")", section or ""))


def rows_for_file(section: str, file_path: str) -> list[str]:
    basename = Path(file_path).name
    return [
        line.strip()
        for line in (section or "").splitlines()
        if file_path in line or basename in line
    ]


def table_cells(row: str) -> list[str]:
    stripped = (row or "").strip()
    if not stripped.startswith("|"):
        return []
    return [cell.strip() for cell in stripped.strip("|").split("|")]


def plan_row_fields(row: str) -> dict[str, str]:
    cells = table_cells(row)
    if len(cells) >= 5:
        return {
            "file": cells[0],
            "update": cells[1],
            "evidence": cells[2],
            "merge": cells[3],
            "downstream": cells[4],
        }
    return {
        "file": row,
        "update": row,
        "evidence": row,
        "merge": row,
        "downstream": row,
    }


def has_downstream_signal(row: str) -> bool:
    return bool(DOWNSTREAM_SKILL_RE.search(row or ""))


def has_merge_strategy(row: str) -> bool:
    return bool(MERGE_STRATEGY_RE.search(row or ""))


def simulated_context_present(*sections: str) -> bool:
    return bool(SIMULATED_DATA_RE.search("\n".join(section or "" for section in sections)))


def audit_twin(body: str) -> dict[str, Any]:
    """Audit whether a twin report can update reusable style memory."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "meta": (r"^##\s*1\.\s+内容元信息", "缺少 `## 1. 内容元信息`。"),
        "dna": (r"^##\s*2\.\s+内容\s*DNA\s+提取", "缺少 `## 2. 内容 DNA 提取`。"),
        "structure": (r"^##\s*3\.\s+结构模式识别", "缺少 `## 3. 结构模式识别`。"),
        "expression": (r"^##\s*4\.\s+表达特征提取", "缺少 `## 4. 表达特征提取`。"),
        "reader": (r"^##\s*5\.\s+读者画像观察", "缺少 `## 5. 读者画像观察`。"),
        "consistency": (r"^##\s*6\.\s+风格一致性评分", "缺少 `## 6. 风格一致性评分`。"),
        "reusable": (r"^##\s*7\.\s+可复用模式归档", "缺少 `## 7. 可复用模式归档`。"),
        "nofly": (r"^##\s*8\.\s+禁区/禁忌更新建议", "缺少 `## 8. 禁区/禁忌更新建议`。"),
        "conclusion": (r"^##\s*9\.\s+观察结论", "缺少 `## 9. 观察结论`。"),
        "memory_plan": (
            r"^##\s*9\.1\s+.*记忆(?:写入计划|更新索引)",
            "缺少 `## 9.1 Twin 记忆写入计划`。",
        ),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    meta = section_text(body, r"^##\s*1\.\s+内容元信息")
    dna = section_text(body, r"^##\s*2\.\s+内容\s*DNA\s+提取")
    structure = section_text(body, r"^##\s*3\.\s+结构模式识别")
    expression = section_text(body, r"^##\s*4\.\s+表达特征提取")
    reader = section_text(body, r"^##\s*5\.\s+读者画像观察")
    consistency = section_text(body, r"^##\s*6\.\s+风格一致性评分")
    reusable = section_text(body, r"^##\s*7\.\s+可复用模式归档")
    nofly = section_text(body, r"^##\s*8\.\s+禁区/禁忌更新建议")
    conclusion = section_text(body, r"^##\s*9\.\s+观察结论")
    memory_plan = section_text(body, r"^##\s*9\.1\s+.*记忆(?:写入计划|更新索引)")
    unpublished = bool(UNPUBLISHED_RE.search("\n".join([body, meta, reader, consistency, conclusion, memory_plan])))
    demo_mode = bool(DEMO_MODE_RE.search(body))

    meta_values = {
        "observed_at": line_value(meta, r"观察日期|观察时间"),
        "title": line_value(meta, r"原文标题|标题"),
        "platform": line_value(meta, r"平台|目标平台|目标阵地"),
        "content_type": line_value(meta, r"内容类型|类型"),
        "source_path": line_value(meta, r"来源路径|原文路径|成稿路径|文件路径"),
    }
    for key, label in [
        ("title", "原文标题"),
        ("platform", "平台"),
        ("content_type", "内容类型"),
        ("source_path", "来源路径"),
    ]:
        if not meaningful_value(meta_values[key], 3 if key in {"title", "source_path"} else 2):
            blocking.append(f"内容元信息缺少可追溯的{label}。")
    if not meaningful_value(meta_values["observed_at"], 6):
        review.append("内容元信息缺少观察日期。")

    dna_values = {
        "theme": line_value(dna, r"核心主题|核心隐喻"),
        "emotion": line_value(dna, r"情绪基调|情绪曲线"),
        "pov": line_value(dna, r"叙事视角"),
        "density": line_value(dna, r"论证密度"),
    }
    for key, label in [("theme", "核心主题"), ("emotion", "情绪基调"), ("pov", "叙事视角"), ("density", "论证密度")]:
        if not meaningful_value(dna_values[key], 3):
            blocking.append(f"内容 DNA 缺少具体的{label}。")
    if table_or_list_rows(dna) < 4:
        blocking.append("内容 DNA 过薄，至少需要主题、情绪、视角和论证密度四项。")

    structure_values = {
        "prototype": line_value(structure, r"文章原型|内容原型|结构原型"),
        "opening": line_value(structure, r"开头技法|开头"),
        "rhythm": line_value(structure, r"推进节奏|节奏"),
        "ending": line_value(structure, r"结尾方式|结尾"),
        "callback": line_value(structure, r"钩子与\s*callback|钩子|callback"),
    }
    for key, label in [
        ("prototype", "文章原型"),
        ("opening", "开头技法"),
        ("rhythm", "推进节奏"),
        ("ending", "结尾方式"),
        ("callback", "钩子与 callback"),
    ]:
        if not meaningful_value(structure_values[key], 3):
            blocking.append(f"结构模式缺少具体的{label}。")

    signature = line_value(expression, r"标志性句式|高频句式|句式模板")
    signature_count = max(split_item_count(signature), table_or_list_rows(expression) - 4)
    expression_values = {
        "signature": signature,
        "transition": line_value(expression, r"过渡方式|段落衔接"),
        "punctuation": line_value(expression, r"情绪标点使用|标点习惯|标点"),
        "oral_density": line_value(expression, r"口语化密度"),
        "knowledge_mode": line_value(expression, r"知识输出方式|知识交付方式"),
    }
    if signature_count < 3:
        blocking.append("表达特征至少需要 3 个可复用的标志性句式模板。")
    for key, label in [
        ("transition", "过渡方式"),
        ("punctuation", "情绪标点使用"),
        ("oral_density", "口语化密度"),
        ("knowledge_mode", "知识输出方式"),
    ]:
        if not meaningful_value(expression_values[key], 2):
            blocking.append(f"表达特征缺少具体的{label}。")

    high_freq = line_value(reader, r"评论区高频词|高频词|读者高频词")
    reader_values = {
        "high_freq": high_freq,
        "question_style": line_value(reader, r"读者提问方式|提问方式"),
        "desire": line_value(reader, r"读者核心焦虑/渴望|核心焦虑/渴望|焦虑/渴望"),
        "interactive_traits": line_value(reader, r"高互动读者特征|互动读者特征"),
    }
    if split_item_count(high_freq) < 3:
        blocking.append("读者画像至少需要 3 个高频词或读者语言信号。")
    for key, label in [
        ("question_style", "读者提问方式"),
        ("desire", "读者核心焦虑/渴望"),
        ("interactive_traits", "高互动读者特征"),
    ]:
        if not meaningful_value(reader_values[key], 3):
            blocking.append(f"读者画像缺少具体的{label}。")

    score = line_value(consistency, r"与历史\s*DNA\s*匹配度|匹配度")
    new_features = line_value(consistency, r"新增特征")
    drift = line_value(consistency, r"偏离点")
    consistency_conclusion = line_value(consistency, r"一致性结论|结论")
    if unpublished:
        if not demo_mode:
            blocking.append("未真实发布的非 demo 内容不能写入数字孪生记忆；请先补真实发布或只做 readonly 草稿观察。")
        if re.search(r"\d{1,3}\s*%", score or ""):
            blocking.append("未真实发布/demo 观察不能计算真实历史 DNA 匹配度百分比。")
        if not simulated_context_present(reader, consistency, conclusion, memory_plan):
            blocking.append("未真实发布/demo 的读者画像、风格评分、观察结论和记忆计划必须标注 demo/待验证口径。")
    elif not re.search(r"\d{1,3}\s*%", score or ""):
        blocking.append("风格一致性评分缺少百分比匹配度。")
    if not meaningful_value(new_features, 3):
        blocking.append("风格一致性评分缺少新增特征。")
    if not meaningful_value(drift, 3):
        blocking.append("风格一致性评分缺少偏离点说明。")
    if not re.search(r"稳定|进化|偏离|初始基线|流程样例|待验证|临时观察", consistency_conclusion or ""):
        blocking.append("风格一致性结论需明确为稳定、进化、偏离、初始基线、流程样例或待验证。")
    if unpublished and re.search(r"稳定|进化|偏离", consistency_conclusion or "") and not re.search(
        r"流程样例|待验证|临时观察|demo|示例", consistency_conclusion or "", re.IGNORECASE
    ):
        blocking.append("未真实发布/demo 不能把风格一致性结论写成真实稳定、进化或偏离。")

    reusable_values = {
        "structure": line_value(reusable, r"可复用结构"),
        "expression": line_value(reusable, r"可复用表达"),
        "rhythm": line_value(reusable, r"可复用节奏"),
    }
    for key, label in [("structure", "可复用结构"), ("expression", "可复用表达"), ("rhythm", "可复用节奏")]:
        if not meaningful_value(reusable_values[key], 4):
            blocking.append(f"可复用模式缺少{label}。")
    if table_or_list_rows(reusable) < 3:
        blocking.append("可复用模式归档过薄，至少需要结构、表达和节奏三类模式。")
    if not has_evidence_signal(reusable):
        blocking.append("可复用模式必须附原文片段、例句或证据。")

    nofly_values = {
        "ai_flavor": line_value(nofly, r"本次发现的\s*AI\s*味表达|AI\s*味表达"),
        "cliche": line_value(nofly, r"本次发现的过度套话|过度套话"),
        "target": line_value(nofly, r"建议写入\s*no-fly-zone\.md|建议写入|no-fly-zone\.md"),
    }
    for key, label in [("ai_flavor", "AI 味表达"), ("cliche", "过度套话"), ("target", "no-fly-zone 写入建议")]:
        if not meaningful_value(nofly_values[key], 3):
            blocking.append(f"禁区/禁忌更新建议缺少{label}。")

    recognizability = line_value(conclusion, r"这篇内容的核心辨识度是什么|核心辨识度")
    keep_adjust = line_value(conclusion, r"如果让我模仿这篇写下一篇，我会保留什么、调整什么|保留什么、调整什么")
    memory_update = line_value(conclusion, r"对\s*twin\s*记忆文件的更新建议|记忆文件更新建议|更新建议")
    if not meaningful_value(recognizability, 6):
        blocking.append("观察结论缺少核心辨识度。")
    if not meaningful_value(keep_adjust, 8) or "保留" not in keep_adjust or "调整" not in keep_adjust:
        blocking.append("观察结论需要同时写明下一篇应保留什么、调整什么。")
    if not meaningful_value(memory_update, 8):
        blocking.append("观察结论缺少 twin 记忆文件更新建议。")

    missing_memory = [file_path for file_path in TWIN_MEMORY_FILES if not mentions_file(conclusion, file_path)]
    if missing_memory:
        blocking.append("观察结论缺少 twin 记忆文件写入建议：" + "、".join(missing_memory) + "。")
    if "brain/no-fly-zone.md" not in body and "no-fly-zone.md" not in body:
        blocking.append("报告未明确是否同步更新 `brain/no-fly-zone.md`。")
    if "brain/style-evolution.md" not in body and "style-evolution.md" not in body:
        blocking.append("报告未明确是否同步更新 `brain/style-evolution.md`。")

    memory_plan_rows = [line for line in (memory_plan or "").splitlines() if line.strip().startswith("|") and "---" not in line]
    missing_plan_files: list[str] = []
    missing_plan_evidence: list[str] = []
    missing_plan_merge: list[str] = []
    missing_plan_downstream: list[str] = []
    twin_memory_real_write_rows: list[str] = []
    for file_path in TWIN_PLAN_FILES:
        file_rows = rows_for_file(memory_plan, file_path)
        if not file_rows:
            missing_plan_files.append(file_path)
            continue
        row_text = " ".join(file_rows)
        row_fields = plan_row_fields(file_rows[0])
        if not has_evidence_signal(row_fields["evidence"]):
            missing_plan_evidence.append(file_path)
        if not has_merge_strategy(row_fields["merge"]):
            missing_plan_merge.append(file_path)
        if not has_downstream_signal(row_fields["downstream"]):
            missing_plan_downstream.append(file_path)
        meaningful_cells = " ".join(
            row_fields[key] for key in ["update", "evidence", "merge", "downstream"]
        )
        if PLACEHOLDER_RE.search(meaningful_cells) or GENERIC_RE.search(meaningful_cells):
            blocking.append(f"`{file_path}` 的记忆写入计划仍是占位或泛化表达。")
        if unpublished and not simulated_context_present(row_text):
            twin_memory_real_write_rows.append(row_text)

    if missing_plan_files:
        blocking.append("Twin 记忆写入计划缺少目标文件：" + "、".join(missing_plan_files) + "。")
    if missing_plan_evidence:
        blocking.append("Twin 记忆写入计划缺少原文/观察证据：" + "、".join(missing_plan_evidence) + "。")
    if missing_plan_merge:
        blocking.append("Twin 记忆写入计划缺少合并策略：" + "、".join(missing_plan_merge) + "。")
    if missing_plan_downstream:
        blocking.append("Twin 记忆写入计划缺少下游调用 skill：" + "、".join(missing_plan_downstream) + "。")
    if memory_plan and len(memory_plan_rows) < len(TWIN_PLAN_FILES) + 1:
        blocking.append("Twin 记忆写入计划需要用表格逐行覆盖 5 个 twin 文件和 2 个同步 brain 文件。")
    if twin_memory_real_write_rows:
        blocking.append("未真实发布/demo 记忆写入计划不能写成真实记忆更新，需标注 demo/待验证口径。")

    placeholder_hits = len(PLACEHOLDER_RE.findall(body))
    generic_hits = len(GENERIC_RE.findall(body))
    if placeholder_hits >= 3:
        blocking.append("报告中仍有过多占位表达，不能写入孪生记忆。")
    elif placeholder_hits:
        review.append("报告中仍有少量占位表达，建议发布后补齐。")
    if generic_hits >= 3:
        blocking.append("报告中泛化判断过多，需要改成可复用的句式、结构或证据片段。")
    elif generic_hits:
        review.append("报告中存在泛化判断，建议替换为原文证据。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "meta": meta_values,
            "dna": dna_values,
            "structure": structure_values,
            "signature_count": signature_count,
            "reader_high_freq_count": split_item_count(high_freq),
            "match_score": score,
            "missing_memory_files": missing_memory,
            "missing_memory_plan_files": missing_plan_files,
            "missing_memory_plan_evidence": missing_plan_evidence,
            "missing_memory_plan_merge": missing_plan_merge,
            "missing_memory_plan_downstream": missing_plan_downstream,
            "memory_plan_rows": len(memory_plan_rows),
            "placeholder_hits": placeholder_hits,
            "generic_hits": generic_hits,
            "reusable_has_evidence": has_evidence_signal(reusable),
            "unpublished": unpublished,
            "demo_mode": demo_mode,
            "twin_memory_real_write_rows": twin_memory_real_write_rows,
        },
    }

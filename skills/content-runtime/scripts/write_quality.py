#!/usr/bin/env python3
"""Deterministic quality audit for WeChat longform drafts."""
from __future__ import annotations

import re
from typing import Any


CONTRACT_LABELS = {
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
    "母稿字数": "motherpiece_word_count",
    "标题决策来源": "title_decision_source",
    "排版交接卡": "layout_handoff",
}

PSYCHOLOGY_TERMS = {
    "沉默解除": ["沉默解除", "说出", "替他说出来", "不敢说", "憋着"],
    "满足动机": ["满足动机", "身份认同", "情绪宣泄", "信息价值", "社交资本", "使用与满足"],
    "有效立场": ["有效立场", "立场框架", "站在", "不站在", "不是教练", "一边"],
    "传播入口": ["传播入口", "第一批传播者", "转发", "评论区", "讨论", "两级传播"],
    "信念结构": ["信念结构", "确认", "挑战", "信念", "行为", "认知一致"],
    "受众情绪底层": ["受众情绪底层", "焦虑", "兴奋", "恐惧", "希望", "安全感", "掌控感"],
    "受众还想听什么": ["受众还想听什么", "还想听", "下一篇", "延展选题", "模板", "清单"],
}

TITLE_SOURCE_NEGATIVE_RE = re.compile(
    r"临时拟定|无来源|缺失|未追溯|不追溯|无\s*blueprint|无标题假设|无\s*package",
    re.IGNORECASE,
)
TITLE_SOURCE_BLUEPRINT_CLAUSE_RE = re.compile(
    r"^blueprint\s*标题假设\s*[：:]\s*工作标题\s*《([^》]+)》\s*[。.!！?？]?$",
    re.IGNORECASE,
)
TITLE_SOURCE_PACKAGE_CLAUSE_RE = re.compile(
    r"^package\s*标题候选\s*[：:]\s*(?:主标题|备选标题)\s*《([^》]+)》\s*[。.!！?？]?$",
    re.IGNORECASE,
)
PLACEHOLDER_VALUE_RE = re.compile(
    r"^(?:待补|待生成|待\s*[\w\u4e00-\u9fff-]*\s*生成|待确认|TBD|TODO|占位|暂无|未提供|\.{3}|…)$",
    re.IGNORECASE,
)
EMPTY_OR_PLACEHOLDER_VALUE_RE = re.compile(
    r"^(?:无|没有|缺失|待补|待生成|待\s*[\w\u4e00-\u9fff-]*\s*生成|待确认|TBD|TODO|占位|暂无|未提供|\.{3}|…)$",
    re.IGNORECASE,
)
DUMMY_VALUE_RE = re.compile(r"^([A-Za-z0-9])\1{3,}$")
QUOTED_TITLE_VALUE_RE = re.compile(r"《([^》]+)》|“([^”]+)”|\"([^\"]+)\"|'([^']+)'")
TITLE_SOURCE_TAIL_MARKER_RE = re.compile(
    r"外部来源|人工修改|人工给定|人工调整|人工改成|热搜标题|\bexternal\s+source\b|\bmanual\s+(?:source|title)\b",
    re.IGNORECASE,
)
LAYOUT_HANDOFF_NEGATIVE_RE = re.compile(
    r"缺失|待定|暂无|未提供|TBD|TODO|占位|待补|稍后补|待确认|没有封面|封面缺失",
    re.IGNORECASE,
)
LAYOUT_PRIVACY_ONLY_RE = re.compile(
    r"^(?:无客户隐私信息|不含客户隐私(?:信息)?|已脱敏|客户隐私已脱敏|不涉及客户隐私|无隐私信息)$",
    re.IGNORECASE,
)
LAYOUT_GENERIC_VALUE_TOKENS = ("封面字", "封面", "摘要", "HTML排版", "HTML", "排版", "CTA", "互动")
LAYOUT_GENERIC_VALUE_SUFFIXES = ("文案", "内容", "互动文案")
LAYOUT_GENERIC_PLACEHOLDER_PATTERNS = ("封面文案", "摘要文案", "排版内容", "互动文案")
LAYOUT_GENERIC_FILLER_RE = re.compile(
    r"^(?:这(?:是|里是)?|这是|说明|请写|用于|用来|作为|生成|提供|填写|补充|输出|撰写)*"
    r"(?:封面文案|摘要文案|排版内容|互动文案)"
    r"(?:即可|就行|内容|说明|文本|文字|部分|占位)?$",
    re.IGNORECASE,
)
LAYOUT_HANDOFF_CORE_SIGNALS = {
    "cover": ["封面"],
    "summary": ["摘要"],
    "layout": ["HTML", "排版"],
}
LAYOUT_HANDOFF_DELIVERY_SIGNALS = ["重点卡片", "引用", "配图", "CTA", "评论区"]


def _extract_check_block(body: str) -> str:
    match = re.search(r"<!--\s*AIFIOS-WRITE-CHECK\b(.*?)-->", body or "", flags=re.DOTALL)
    return match.group(1).strip() if match else ""


def _strip_check_block(body: str) -> str:
    return re.sub(r"<!--\s*AIFIOS-WRITE-CHECK\b.*?-->", "", body or "", flags=re.DOTALL)


def _compact(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _parse_contract(block: str) -> tuple[dict[str, str], list[str]]:
    fields: dict[str, str] = {}
    seen_labels: set[str] = set()
    duplicate_labels: list[str] = []
    for line in block.splitlines():
        clean = line.strip()
        if not clean:
            continue
        for label, key in CONTRACT_LABELS.items():
            if clean.startswith(label):
                value = re.sub(rf"^{re.escape(label)}\s*[-：:]\s*", "", clean).strip()
                if label in seen_labels and label not in duplicate_labels:
                    duplicate_labels.append(label)
                seen_labels.add(label)
                fields[key] = value
                break
    return fields, duplicate_labels


def _text_mentions_any(text: str, needles: list[str]) -> bool:
    return any(re.search(re.escape(needle), text or "", re.IGNORECASE) for needle in needles)


def _contract_tokens(value: str) -> list[str]:
    normalized = re.sub(r"\s+", "", value or "")
    ascii_tokens = re.findall(r"[A-Za-z][A-Za-z0-9_-]{1,}|\d+(?:\.\d+)?", normalized)
    zh = re.sub(r"[^\u4e00-\u9fff]", "", normalized)
    stop_tokens = {
        "一个", "这个", "那个", "自己", "内容", "文章", "客户", "读者", "问题",
        "引导", "商业", "收口", "风险", "边界", "真实", "需要", "可以",
        "进行", "判断", "说明", "不要", "不能", "没有", "使用", "受众",
        "传播", "心理", "兑现", "满足", "动机", "信念", "结构",
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
        key = token.lower()
        if key not in seen:
            seen.add(key)
            tokens.append(token)
    return tokens[:28]


def _clause_visible(text: str, clause: str) -> bool:
    plain = _compact(text)
    normalized_text = re.sub(r"\s+", "", plain)
    normalized_clause = re.sub(r"\s+", "", clause or "")
    if normalized_clause and len(normalized_clause) >= 4 and normalized_clause in normalized_text:
        return True
    tokens = _contract_tokens(clause)
    if not tokens:
        return False
    hits = [token for token in tokens if re.search(re.escape(token), plain, re.IGNORECASE)]
    threshold = min(3, max(2, round(len(tokens) * 0.2)))
    return len(hits) >= threshold


def _split_clauses(value: str) -> list[str]:
    if not value:
        return []
    parts: list[str] = []
    current: list[str] = []
    quote_stack: list[str] = []
    closing_quotes = {"《": "》", "“": "”", '"': '"', "'": "'"}
    delimiters = {"；", ";", "、", ",", "，", "|", "→", "/", "\n"}
    idx = 0
    while idx < len(value):
        char = value[idx]
        next_pair = value[idx:idx + 2]
        if not quote_stack and next_pair in {"->", "=>"}:
            parts.append("".join(current))
            current = []
            idx += 2
            continue
        if quote_stack and char == quote_stack[-1]:
            quote_stack.pop()
            current.append(char)
            idx += 1
            continue
        if char in closing_quotes and (char not in {'"', "'"} or not quote_stack):
            quote_stack.append(closing_quotes[char])
            current.append(char)
            idx += 1
            continue
        if not quote_stack and char in delimiters:
            parts.append("".join(current))
            current = []
            idx += 1
            continue
        current.append(char)
        idx += 1
    parts.append("".join(current))
    return [part.strip(" -。.!！?？`") for part in parts if _compact(part)]


def _field_value(clause: str) -> str:
    match = re.search(r"[：:\-]\s*(.+)$", clause or "")
    return match.group(1).strip(" -。.!！?？`") if match else ""


def _terminal_field_value(value: str) -> str:
    parts = re.split(r"[：:]", value or "")
    return parts[-1].strip(" -。.!！?？`") if parts else ""


def _is_meaningful_value(value: str, *, allow_none_phrase: bool = False) -> bool:
    clean = _compact(value).strip(" -。.!！?？`")
    if not clean:
        return False
    placeholder_re = PLACEHOLDER_VALUE_RE if allow_none_phrase else EMPTY_OR_PLACEHOLDER_VALUE_RE
    return not placeholder_re.fullmatch(clean)


def _is_meaningful_title_source_value(value: str) -> bool:
    clean = re.sub(r"[\W_]+", "", value or "", flags=re.UNICODE)
    terminal = _terminal_field_value(value)
    clean_terminal = re.sub(r"[\W_]+", "", terminal or "", flags=re.UNICODE)
    quoted_values = [
        next(group for group in match.groups() if group is not None).strip()
        for match in QUOTED_TITLE_VALUE_RE.finditer(value or "")
    ]
    return (
        _is_meaningful_value(value)
        and _is_meaningful_value(terminal)
        and not TITLE_SOURCE_TAIL_MARKER_RE.search(value or "")
        and not TITLE_SOURCE_TAIL_MARKER_RE.search(terminal or "")
        and not DUMMY_VALUE_RE.fullmatch(clean)
        and not DUMMY_VALUE_RE.fullmatch(clean_terminal)
        and not any(
            TITLE_SOURCE_TAIL_MARKER_RE.search(item)
            or DUMMY_VALUE_RE.fullmatch(re.sub(r"[\W_]+", "", item, flags=re.UNICODE))
            for item in quoted_values
        )
    )


def _extract_motherpiece_word_counts(value: str) -> list[int]:
    counts: list[int] = []
    range_spans: list[tuple[int, int]] = []
    for match in re.finditer(r"(?<!\d)(\d{3,5})\s*(?:-|~|～|至|到)\s*(\d{3,5})(?!\d)", value or ""):
        counts.extend([int(match.group(1)), int(match.group(2))])
        range_spans.append(match.span())

    def _inside_range(match: re.Match[str]) -> bool:
        return any(start <= match.start() and match.end() <= end for start, end in range_spans)

    for match in re.finditer(r"(?<!\d)(\d{3,5})\s*(?:字|中文字|中文字符|汉字)", value or ""):
        if not _inside_range(match):
            counts.append(int(match.group(1)))

    if counts:
        return counts

    bare_match = re.fullmatch(r"\s*(\d{3,5})\s*[,，。.!！?？]?\s*", value or "")
    return [int(bare_match.group(1))] if bare_match else []


def _title_source_clause_value(clause: str) -> str:
    for pattern in (TITLE_SOURCE_BLUEPRINT_CLAUSE_RE, TITLE_SOURCE_PACKAGE_CLAUSE_RE):
        match = pattern.fullmatch(_compact(clause))
        if match:
            return match.group(1).strip()
    return ""


def _has_valid_title_source(title_source: str) -> bool:
    found_supported_source = False
    found_valid_source = False
    for clause in _split_clauses(title_source):
        title_value = _title_source_clause_value(clause)
        if not title_value:
            return False
        if not _is_meaningful_title_source_value(title_value):
            return False
        found_supported_source = True
        found_valid_source = True
    return found_supported_source and found_valid_source


def _is_privacy_only_layout_value(value: str) -> bool:
    clean = _compact(value).strip(" -。.!！?？`")
    return bool(LAYOUT_PRIVACY_ONLY_RE.fullmatch(clean))


def _is_dummy_layout_value(value: str) -> bool:
    clean = re.sub(r"[\W_]+", "", value or "", flags=re.UNICODE)
    return bool(DUMMY_VALUE_RE.fullmatch(clean))


def _is_generic_layout_placeholder_value(value: str) -> bool:
    clean = re.sub(r"[\W_]+", "", value or "", flags=re.UNICODE).upper()
    if not clean:
        return False
    clean_text = _compact(value).strip(" -。.!！?？`")
    compact_text = re.sub(r"\s+", "", clean_text)
    if any(pattern in compact_text for pattern in LAYOUT_GENERIC_PLACEHOLDER_PATTERNS):
        return bool(LAYOUT_GENERIC_FILLER_RE.fullmatch(compact_text))
    tokens = tuple(token.upper() for token in LAYOUT_GENERIC_VALUE_TOKENS)
    suffixes = tuple(suffix.upper() for suffix in LAYOUT_GENERIC_VALUE_SUFFIXES)
    return (
        clean in suffixes
        or any(clean == token * 2 for token in tokens)
        or any(clean == f"{token}{suffix}" for token in tokens for suffix in suffixes)
    )


def _is_substantive_layout_value(value: str) -> bool:
    clean = _compact(value).strip(" -。.!！?？`")
    substantive_chars = re.sub(r"[^\w\u4e00-\u9fff]", "", clean)
    return (
        _is_meaningful_value(value)
        and not _is_privacy_only_layout_value(value)
        and not _is_dummy_layout_value(value)
        and not _is_generic_layout_placeholder_value(value)
        and len(substantive_chars) >= 4
    )


def _layout_signal_categories(clause: str) -> set[str]:
    label_text = re.split(r"[：:\-]", clause or "", maxsplit=1)[0]
    categories: set[str] = set()
    for signal_key, aliases in LAYOUT_HANDOFF_CORE_SIGNALS.items():
        if any(re.search(re.escape(alias), label_text, re.IGNORECASE) for alias in aliases):
            categories.add(signal_key)
    if any(re.search(re.escape(signal), label_text, re.IGNORECASE) for signal in LAYOUT_HANDOFF_DELIVERY_SIGNALS):
        categories.add("delivery")
    return categories


def _has_required_layout_handoff(layout_handoff: str) -> bool:
    core_signals: set[str] = set()
    delivery_signal_found = False
    for clause in _split_clauses(layout_handoff):
        value = _field_value(clause)
        if not _is_substantive_layout_value(value):
            continue
        categories = _layout_signal_categories(clause)
        if len(categories) != 1:
            continue
        category = next(iter(categories))
        if category in LAYOUT_HANDOFF_CORE_SIGNALS:
            core_signals.add(category)
        elif category == "delivery":
            delivery_signal_found = True
    return core_signals == set(LAYOUT_HANDOFF_CORE_SIGNALS) and delivery_signal_found


def _body_mentions_psychology(body: str) -> bool:
    plain = _compact(body)
    signals = [
        r"焦虑|不安全感|怕|兴奋|希望|掌控感|被理解",
        r"读者|客户|创始人|技术人|服务型业务负责人",
        r"你可能|很多人|我理解|站在|处境",
        r"转发|评论|下一篇|还想听|模板|清单|私信",
        r"不是.*而是|确认|挑战|信念|误区|行为",
    ]
    return sum(1 for pattern in signals if re.search(pattern, plain, re.IGNORECASE)) >= 3


def audit_write(body: str) -> dict[str, Any]:
    """Audit whether a WeChat draft fulfills the longform delivery contract."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []
    block = _extract_check_block(body)
    visible_body = _strip_check_block(body)
    fields, duplicate_labels = _parse_contract(block) if block else ({}, [])

    if not block:
        blocking.append("缺少 `AIFIOS-WRITE-CHECK` 隐藏交付自检块。")

    if duplicate_labels:
        blocking.append("隐藏交付自检块存在重复字段：" + "、".join(duplicate_labels) + "。")

    missing_fields = [label for label, key in CONTRACT_LABELS.items() if not fields.get(key)]
    if missing_fields:
        blocking.append("隐藏交付自检块缺少字段：" + "、".join(missing_fields) + "。")

    conclusion = fields.get("quality_conclusion", "")
    if conclusion and not re.search(r"\b(pass|review)\b", conclusion, re.IGNORECASE):
        blocking.append("`质检结论` 只能写 `pass` 或 `review`。")

    word_count_value = fields.get("motherpiece_word_count", "")
    word_counts = _extract_motherpiece_word_counts(word_count_value)
    if not word_counts:
        blocking.append("隐藏交付自检块缺少可解析的 `母稿字数`。")
    else:
        if any(word_count < 3000 or word_count > 4000 for word_count in word_counts):
            blocking.append("公众号母稿必须声明为 3000-4000 字，避免过短无法建立信任或过长超过理解承受。")

    title_source = fields.get("title_decision_source", "")
    if TITLE_SOURCE_NEGATIVE_RE.search(title_source) or not _has_valid_title_source(title_source):
        blocking.append("标题决策来源必须追溯到 blueprint 标题假设或 package 标题候选，不能临时拟定。")

    layout_handoff = fields.get("layout_handoff", "")
    if LAYOUT_HANDOFF_NEGATIVE_RE.search(layout_handoff) or not _has_required_layout_handoff(layout_handoff):
        blocking.append("排版交接卡必须包含封面、摘要、HTML/排版，以及至少一类后续交付或互动元素（重点卡片、引用、配图、CTA 或评论区），且不能是缺失/待定。")

    psychology = fields.get("psychology_fulfillment", "")
    missing_psychology = [
        label for label, aliases in PSYCHOLOGY_TERMS.items()
        if not _text_mentions_any(psychology, [label, *aliases])
    ]
    if psychology and missing_psychology:
        blocking.append("传播心理兑现缺少关键维度：" + "、".join(missing_psychology) + "。")
    if psychology and len(re.sub(r"\s+", "", psychology)) < 60:
        blocking.append("传播心理兑现过薄，不能证明正文承接了写前传播心理假设。")

    psychology_clauses = _split_clauses(psychology)
    if psychology_clauses:
        visible_count = sum(1 for clause in psychology_clauses if _clause_visible(visible_body, clause))
        required_count = max(1, round(len(psychology_clauses) * 0.45))
        if visible_count < required_count or not _body_mentions_psychology(visible_body):
            review.append(
                f"传播心理兑现没有充分落到可见正文：{visible_count}/{len(psychology_clauses)} 条可追踪，建议补出读者隐秘情绪、有效立场、信念冲突和下一步需求。"
            )

    required_evidence = fields.get("required_evidence", "")
    evidence_clauses = _split_clauses(required_evidence)
    if evidence_clauses:
        visible_evidence = sum(1 for clause in evidence_clauses if _clause_visible(visible_body, clause))
        if visible_evidence < max(1, round(len(evidence_clauses) * 0.6)):
            review.append("必用证据没有充分进入可见正文，不能只留在隐藏自检块里。")

    risk_boundary = fields.get("risk_boundary", "")
    if risk_boundary and re.search(r"客户姓名|客户名|项目名|真实姓名|聊天截图|代码细节|源码|保证\s*成交|100%\s*成交|稳赚", visible_body):
        blocking.append("可见正文疑似突破风险边界，请匿名化客户/项目/截图/代码细节并删除夸大承诺。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "missing_fields": missing_fields,
            "missing_psychology": missing_psychology if psychology else list(PSYCHOLOGY_TERMS),
            "psychology_clause_count": len(psychology_clauses),
            "body_has_psychology_signals": _body_mentions_psychology(visible_body),
            "declared_conclusion": conclusion,
            "duplicate_contract_labels": duplicate_labels,
        },
    }

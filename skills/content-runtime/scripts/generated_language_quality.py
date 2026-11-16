#!/usr/bin/env python3
"""Shared deterministic language checks for generated product copy.

The checker never rewrites content and never calls a model. Callers pass only
system-generated prose for voice warnings; source quotations and fixed
machine-readable fields stay outside that warning scope.
"""
from __future__ import annotations

import re
from typing import Any


Pattern = tuple[str, re.Pattern[str], str]

BLOCKING_PATTERNS: tuple[Pattern, ...] = (
    (
        "assistant_identity",
        re.compile(r"作为(?:一个|一名)?\s*(?:AI|人工智能|语言模型)", re.IGNORECASE),
        "内容中出现了聊天助手式说明。",
    ),
    (
        "assistant_signoff",
        re.compile(r"希望(?:以上|这些|这份)?内容.{0,18}(?:对你|对您)?(?:有帮助|有所帮助|有用)", re.IGNORECASE),
        "内容中出现了聊天助手式结尾。",
    ),
    (
        "assistant_offer",
        re.compile(r"如果(?:你|您)(?:还)?(?:需要|想要).{0,24}(?:请告诉我|我可以继续|我能继续)", re.IGNORECASE),
        "内容中出现了聊天助手式邀约。",
    ),
    (
        "local_path",
        re.compile(
            r"(?:file:///|/(?:Users|home|root|private|var|tmp|Volumes|Applications|Library|System|opt|srv|workspace|app|mnt)/[^\s`\"'<>]+|[A-Za-z]:\\[^\s`\"'<>]+)",
            re.IGNORECASE,
        ),
        "内容中出现了本机路径。",
    ),
    (
        "secret_like_value",
        re.compile(
            r"(?:\bsk-[A-Za-z0-9_-]{8,}\b|(?:api[_ -]?key|access[_ -]?token|authorization|cookie|password|app[_ -]?secret|client[_ -]?secret|pairing[_ -]?token|token|密钥|令牌|密码)\s*[:=：]\s*\S+)",
            re.IGNORECASE,
        ),
        "内容中出现了疑似密钥或账号凭据。",
    ),
    (
        "template_placeholder",
        re.compile(r"(?:\{\{[^{}]+\}\}|\$\{[^{}]+\}|\[(?:待补充|待填写|占位|placeholder)\]|<placeholder>|\b(?:TODO|TBD)\b)", re.IGNORECASE),
        "内容中还有未填写的模板占位符。",
    ),
    (
        "raw_exception",
        re.compile(r"(?:\n\s*at\s+|\b(?:TypeError|ReferenceError|SyntaxError|Unhandled|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\b)", re.IGNORECASE),
        "内容中出现了原始异常信息。",
    ),
)

WARNING_PATTERNS: tuple[Pattern, ...] = (
    (
        "formulaic_conclusion",
        re.compile(r"(?:综上所述|总而言之|由此可见)"),
        "结尾像模板总结，建议直接保留结论。",
    ),
    (
        "inflated_claim",
        re.compile(r"(?:标志着.{0,16}(?:关键|重要).{0,8}(?:时刻|转折)|不可磨灭的印记|不断演变的格局)"),
        "有一处结论被写得过大，建议改成具体事实。",
    ),
    (
        "negative_parallelism",
        re.compile(r"(?:不仅仅是|并非只是|不只是).{0,24}(?:更是|而是)"),
        "有一处否定式排比，建议直接说明判断。",
    ),
    (
        "mechanical_sequence",
        re.compile(r"首先[\s\S]{0,120}其次[\s\S]{0,120}(?:最后|再次)"),
        "段落像固定模板，建议按内容本身安排节奏。",
    ),
    (
        "unsupported_grand_claim",
        re.compile(r"(?:必将|彻底|全面).{0,16}(?:改变|颠覆|重塑).{0,12}(?:行业|所有人|世界)"),
        "有一处宏大结论缺少具体依据。",
    ),
    (
        "generic_platform_alias",
        re.compile(r"(?:长文平台|图文内容源|短视频内容源)"),
        "请直接写真实平台名称。",
    ),
)


def _findings(text: str, patterns: tuple[Pattern, ...]) -> list[dict[str, str]]:
    return [
        {"code": code, "message": message}
        for code, pattern, message in patterns
        if pattern.search(text)
    ]


def _density_warning(text: str) -> list[dict[str, str]]:
    matches = re.findall(r"(?:赋能|沉淀|闭环|抓手|底层逻辑|全链路|关键洞察|持续优化)", text)
    if len(matches) < 2:
        return []
    return [{"code": "abstract_phrase_density", "message": "抽象套话出现较多，建议换成具体动作或事实。"}]


def _repeated_opening_warning(text: str) -> list[dict[str, str]]:
    sentences = [item.strip() for item in re.findall(r"[^。！？!?]+[。！？!?]?", text) if item.strip()]
    counts: dict[str, int] = {}
    for sentence in sentences:
        opening = re.sub(r"^[\d一二三四五六七八九十]+[、.．]\s*", "", sentence)[:4]
        if len(opening) >= 3:
            counts[opening] = counts.get(opening, 0) + 1
    if not any(count >= 3 for count in counts.values()):
        return []
    return [{"code": "repeated_sentence_opening", "message": "多个句子用相同方式起头，建议调整节奏。"}]


def inspect_generated_language(safety_text: Any, voice_text: Any | None = None) -> dict[str, Any]:
    safety = str(safety_text or "")
    voice = safety if voice_text is None else str(voice_text or "")
    blocking = _findings(safety, BLOCKING_PATTERNS)
    warnings = [
        *_findings(voice, WARNING_PATTERNS),
        *_density_warning(voice),
        *_repeated_opening_warning(voice),
    ]
    status = "blocked" if blocking else "review_required" if warnings else "pass"
    return {"status": status, "blocking": blocking, "warnings": warnings}

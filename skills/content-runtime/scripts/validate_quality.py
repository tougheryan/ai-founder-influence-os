#!/usr/bin/env python3
"""Deterministic quality audit for content-validate reports."""
from __future__ import annotations

import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|缺失|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)

PLATFORM_ALIASES = [
    "wechat", "xhs", "xiaohongshu", "shipinhao", "douyin", "moments",
    "公众号", "小红书", "视频号", "微信视频号", "抖音", "抖音号", "朋友圈", "微信朋友圈",
]
MARKET_REPORT_PATH_RE = re.compile(r"^materials/research/[^\\/\s]+-market-signal\.md$")
MARKET_SAMPLE_INSUFFICIENT_RE = re.compile(
    r"样本不足|sample[\s_-]*insufficient|未取得(?:可验证)?公开样本|无可验证公开样本",
    re.IGNORECASE,
)
MARKET_CREATOR_MODE_RE = re.compile(
    r"创作模式|公开样本(?:暂不可用|不可用)|creator[\s_-]*mode",
    re.IGNORECASE,
)
MARKET_SAMPLE_READY_RE = re.compile(
    r"已完成|完成|ready|completed|已有(?:可验证)?公开样本|有(?:可验证)?公开样本",
    re.IGNORECASE,
)


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    match = re.search(rf"(?m)^\s*[-*]\s*(?:\*\*)?(?:{label_pattern})(?:\*\*)?\s*[：:]\s*(.+?)\s*$", section or "")
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 4) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    return not PLACEHOLDER_RE.search(value)


def checkbox_count(section: str, checked: bool | None = None) -> int:
    if checked is True:
        pattern = r"(?m)^\s*[-*]\s*\[[xX]\]\s+"
    elif checked is False:
        pattern = r"(?m)^\s*[-*]\s*\[\s*\]\s+"
    else:
        pattern = r"(?m)^\s*[-*]\s*\[[ xX]\]\s+"
    return len(re.findall(pattern, section or ""))


def hkr_scores(section: str) -> dict[str, int]:
    scores: dict[str, int] = {}
    for key, aliases in {
        "H": ["H", "Happy", "有趣"],
        "K": ["K", "Knowledge", "信息量"],
        "R": ["R", "Resonance", "共鸣"],
    }.items():
        best = 0
        for line in (section or "").splitlines():
            if any(alias in line for alias in aliases):
                stars = line.count("⭐")
                if stars:
                    best = max(best, stars)
                digit = re.search(r"(?<!\d)([1-5])(?:\s*/\s*5|星|分)?(?!\d)", line)
                if digit:
                    best = max(best, int(digit.group(1)))
        scores[key] = best
    return scores


def detect_decision(section: str) -> str:
    decision = line_value(section, r"决策|立项结论")
    if "有条件通过" in decision:
        return "有条件通过"
    if "不通过" in decision:
        return "不通过"
    if "通过" in decision:
        return "通过"
    if "有条件通过" in section:
        return "有条件通过"
    if "不通过" in section:
        return "不通过"
    if "通过" in section:
        return "通过"
    return ""


def allows_next_step(section: str) -> bool | None:
    value = line_value(section, r"是否允许进入下一步|允许进入下一步")
    if not value:
        return None
    if re.search(r"是|允许|yes|true", value, re.IGNORECASE):
        return True
    if re.search(r"否|不允许|no|false", value, re.IGNORECASE):
        return False
    return None


def platform_present(value: str) -> bool:
    return any(alias.lower() in (value or "").lower() for alias in PLATFORM_ALIASES)


def is_yes(value: str) -> bool:
    compact = re.sub(r"\s+", "", value or "")
    if re.match(r"^(否|不|没有|无|待验证)", compact):
        return False
    return bool(re.search(r"^(是|成立|清晰|有|明确)|yes|true", compact, re.IGNORECASE))


def is_no(value: str) -> bool:
    compact = re.sub(r"\s+", "", value or "")
    if re.match(r"^(是|成立|清晰|有|明确)", compact):
        return False
    return bool(re.search(r"^(否|不|没有|无|待验证)|no|false", compact, re.IGNORECASE))


def normalize_market_sample_status(value: str) -> str:
    """Return the declared market-gate state without making a fallback valid."""
    compact = re.sub(r"\s+", "", value or "")
    if MARKET_SAMPLE_INSUFFICIENT_RE.search(compact):
        return "sample_insufficient"
    if MARKET_CREATOR_MODE_RE.search(compact):
        return "creator_mode"
    if MARKET_SAMPLE_READY_RE.search(compact):
        return "ready"
    return ""


def parse_market_sample_count(value: str) -> int | None:
    match = re.search(r"(?<![0-9])([0-9]+)(?![0-9])", value or "")
    return int(match.group(1)) if match else None


def valid_market_report_path(value: str) -> bool:
    path = (value or "").strip().strip("`")
    return bool(MARKET_REPORT_PATH_RE.fullmatch(path))


def audit_validate(body: str) -> dict[str, Any]:
    """Audit whether a validate report is a coherent production gate."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    required_sections = {
        "source": (r"^##\s*0\.\s+素材来源", "缺少 `## 0. 素材来源`。"),
        "decision": (r"^##\s*1\.\s+立项决策", "缺少 `## 1. 立项决策`。"),
        "hkr": (r"^##\s*2\.\s+HKR\s+质检", "缺少 `## 2. HKR 质检`。"),
        "business": (r"^##\s*3\.\s+商业成立性判断", "缺少 `## 3. 商业成立性判断`。"),
        "platform": (r"^##\s*4\.\s+平台首发策略", "缺少 `## 4. 平台首发策略`。"),
        "supplement": (r"^##\s*5\.\s+素材补充清单", "缺少 `## 5. 素材补充清单`。"),
        "risk": (r"^##\s*6\.\s+风险提示", "缺少 `## 6. 风险提示`。"),
        "next": (r"^##\s*7\.\s+下一步", "缺少 `## 7. 下一步`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    source = section_text(body, r"^##\s*0\.\s+素材来源")
    decision_section = section_text(body, r"^##\s*1\.\s+立项决策")
    hkr_section = section_text(body, r"^##\s*2\.\s+HKR\s+质检")
    business = section_text(body, r"^##\s*3\.\s+商业成立性判断")
    platform = section_text(body, r"^##\s*4\.\s+平台首发策略")
    supplement = section_text(body, r"^##\s*5\.\s+素材补充清单")
    risk = section_text(body, r"^##\s*6\.\s+风险提示")
    next_section = section_text(body, r"^##\s*7\.\s+下一步")

    decision = detect_decision(decision_section)
    reason = line_value(decision_section, r"决策理由|理由")
    confidence = line_value(decision_section, r"置信度")
    allow_next = allows_next_step(decision_section)
    scores = hkr_scores(hkr_section)
    low_hkr_count = sum(1 for score in scores.values() if score and score < 3)
    missing_hkr = [key for key, score in scores.items() if score == 0]

    if not decision:
        blocking.append("立项决策缺少明确 `通过 / 有条件通过 / 不通过`。")
    if not meaningful_value(reason, min_chars=6):
        blocking.append("立项决策缺少具体决策理由。")
    if not meaningful_value(confidence, min_chars=1):
        review.append("立项决策缺少置信度。")
    if allow_next is None:
        review.append("立项决策缺少 `是否允许进入下一步`。")

    if missing_hkr:
        blocking.append(f"HKR 质检缺少评分：{', '.join(missing_hkr)}。")
    if decision == "通过" and (low_hkr_count or any(score and score < 4 for score in scores.values())):
        review.append("立项为通过，但 HKR 未达到三项 4 星以上，建议确认是否应改为有条件通过。")
    if allow_next is False:
        review.append("立项报告建议暂停，但创作模式会继续生成并保留风险边界。")

    source_summary = line_value(source, r"核心人物/观点/案例|核心素材|主场景")
    if not meaningful_value(source_summary, min_chars=6):
        review.append("素材来源缺少可判断的核心人物/观点/案例。")

    market_report_path = line_value(
        source,
        r"公开样本(?:对标)?报告(?:路径)?|爆款抓取与(?:公开)?对标报告(?:路径)?",
    )
    market_status_value = line_value(source, r"公开样本(?:对标)?状态|样本状态")
    market_status = normalize_market_sample_status(market_status_value)
    market_sample_count_value = line_value(source, r"可验证(?:公开)?样本数|公开(?:可验证)?样本数|样本数量")
    market_sample_count = parse_market_sample_count(market_sample_count_value)
    if not meaningful_value(market_report_path, min_chars=12):
        blocking.append("素材来源缺少公开样本对标报告路径。")
    elif not valid_market_report_path(market_report_path):
        blocking.append("公开样本对标报告必须指向 `materials/research/{slug}-market-signal.md`。")
    if not market_status:
        blocking.append("素材来源必须声明 TikOmni 公开样本状态为已完成。")
    elif market_status in {"sample_insufficient", "creator_mode"}:
        blocking.append("TikOmni 三平台样本不足；不得用创作模式或透明声明绕过研究门禁。")
    if market_sample_count is None:
        blocking.append("素材来源必须声明可验证样本数。")
    elif market_sample_count < 3:
        blocking.append("可验证样本数至少为 3，且公众号、小红书、视频号必须分别至少 1 条。")
    business_checks = {
        "目标是否空转": line_value(business, r"目标是否空转"),
        "商业模式是否成立": line_value(business, r"商业模式是否成立"),
        "是否有产品/服务承接": line_value(business, r"是否有产品/服务承接"),
        "转化路径是否清晰": line_value(business, r"转化路径是否清晰"),
    }
    for label, value in business_checks.items():
        if not meaningful_value(value, min_chars=1):
            review.append(f"商业成立性判断缺少 `{label}`；后续内容按未验证处理。")
    if decision == "通过":
        negative_business = []
        if is_yes(business_checks["目标是否空转"]):
            negative_business.append("目标是否空转")
        for label in ["商业模式是否成立", "是否有产品/服务承接", "转化路径是否清晰"]:
            if is_no(business_checks[label]):
                negative_business.append(label)
        if negative_business:
            review.append(f"立项为通过，但商业成立性仍需确认：{', '.join(negative_business)}。后续内容必须保留这一边界。")

    first_platform = line_value(platform, r"推荐首发平台|首发平台")
    platform_reason = line_value(platform, r"理由")
    if not platform_present(first_platform):
        blocking.append("平台首发策略缺少明确平台。")
    if not meaningful_value(platform_reason, min_chars=6):
        review.append("平台首发策略缺少具体理由；不阻断内容生成。")

    open_supplements = checkbox_count(supplement, checked=False)
    all_supplements = checkbox_count(supplement)
    if decision == "通过" and open_supplements >= 3:
        review.append(f"立项为通过，但仍有 {open_supplements} 项素材补充未完成，建议确认是否应为有条件通过。")
    if decision == "有条件通过" and all_supplements == 0:
        blocking.append("有条件通过必须提供可执行素材补充清单。")

    risk_items = [
        line.strip()
        for line in risk.splitlines()
        if re.match(r"\s*[-*]\s+", line)
    ]
    if not risk_items:
        blocking.append("风险提示缺少具体风险项。")
    elif any(PLACEHOLDER_RE.search(line) for line in risk_items):
        blocking.append("风险提示存在 `无/暂无/待补` 等占位表述。")

    if decision and not re.search(r"/content-blueprint|content-blueprint|进入", next_section):
        blocking.append("下一步没有明确进入 `/content-blueprint` 生成创作蓝图。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "decision": decision,
            "confidence": confidence,
            "allow_next": allow_next,
            "hkr_scores": scores,
            "first_platform": first_platform,
            "open_supplements": open_supplements,
            "risk_items": len(risk_items),
            "business_checks": business_checks,
            "market_report_path": market_report_path.strip().strip("`"),
            "market_sample_status": market_status,
            "market_sample_count": market_sample_count,
            "market_signal": {
                "report_path": market_report_path.strip().strip("`"),
                "status": market_status,
                "sample_count": market_sample_count,
            },
        },
    }

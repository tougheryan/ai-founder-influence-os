#!/usr/bin/env python3
"""Deterministic quality audit for content-visual production plans."""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any


PLACEHOLDER_RE = re.compile(
    r"(?:^|[\s:：,，。；;])(?:无|暂无|待补|待确认|未提供|不详|待定|TODO|xxx|x{2,}|\.{3,}|…)(?:$|[\s,，。；;])",
    re.IGNORECASE,
)

EXECUTION_TOOLS = [
    "ian-xiaohei-illustrations",
    "xhs-card",
    "dbs-wechat-html",
    "baoyu-diagram",
    "baoyu-comic",
]

DESIGN_TOOLS = [
    "baoyu-cover-image",
    "baoyu-xhs-images",
    "baoyu-infographic",
    "baoyu-article-illustrator",
    "baoyu-image-gen",
]

EXECUTION_TOOL_LABEL = "ian-xiaohei-illustrations / xhs-card / dbs-wechat-html"
COMMAND_RE = re.compile(
    r"read --step visual|content_runtime\.py|pipeline/visual|/content-visual|"
    r"xhs-card|ian-xiaohei-illustrations|"
    r"dbs-wechat-html|/dbs-wechat-html|/公众号HTML|公众号HTML输出|"
    r"baoyu-cover-image|baoyu-xhs-images|baoyu-infographic|baoyu-diagram|baoyu-comic|"
    r"baoyu-article-illustrator|baoyu-image-gen|promptfile|prompt 文件",
    re.IGNORECASE,
)
VISUAL_PATH_RE = re.compile(r"pipeline/visual/[^\s`|，。；;)\]]+", re.IGNORECASE)
MANIFEST_HEADING_RE = r"^##\s*6\.\s+(?:交付\s*Manifest|视觉资产\s*Manifest|资产\s*Manifest|交付清单)"
COMPLETED_STATUS_RE = re.compile(
    r"\bPASS\b|已生成|已完成|已落盘|真实落盘|generated|completed|done",
    re.IGNORECASE,
)
PLANNED_STATUS_RE = re.compile(
    r"planned|待生成|计划|生成后|待执行|待检查|review|人工|检查方式|验收方式",
    re.IGNORECASE,
)
PUBLISH_RECORD_FORBIDDEN_RE = re.compile(r"视觉生产计划|资产包说明|蓝图摘要|标题测试报告|爆款拆解报告")

DEFAULT_RECIPE_MIN_DENSITY = 0.62
DEFAULT_MIN_EVIDENCE_DETAIL = 0.08
EVIDENCE_REQUIRED_MODES = {"screenshot_first", "data_first", "artifact_first"}


def native_page_evidence(copy: dict[str, Any], source: str = "") -> dict[str, str]:
    """Classify the approved page copy, never its decorative concept disclaimer.

    This is a conservative routing check, not a fact checker. Unrecognized
    assertions require review; merely calling an image conceptual is not proof.
    Both recipe production and release QA recompute this same contract.
    """
    normalized = {key: str(copy.get(key) or "") for key in ("headline", "supporting", "cover")}
    text = "\n".join(normalized.values())
    digest = hashlib.sha256(json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    factual = re.search(
        r"\d+(?:\.\d+)?\s*(?:%|％|倍)|(?:增长|提升|降低|节省|减少|转化|营收|收入|获客).{0,10}\d|"
        r"(?:研究|调查|调研|数据|统计).{0,8}(?:表明|显示|发现|证明|结果)|"
        r"(?:真实|实际)产品(?:界面|截图)|(?:客户|用户).{0,12}(?:实现|获得|增长|提升|减少|节省)|"
        r"(?:我们|我|客户|用户).{0,8}(?:赚了|赚到|卖出|成交|实测|验证了)", text,
    )
    if source or factual:
        status, reason = "required", "本页引用素材或包含需核对的事实、数据或成果，请绑定本页来源。"
    else:
        body = normalized["supporting"] or normalized["headline"]
        sentences = [s.strip() for s in re.split(r"[。！!\n]", body) if s.strip()]
        advice = re.compile(r"先|请|建议|可以|不要|不能|需要|核对|确认|列出|写下|写清|记录|检查|询问|保留|待确认|自查|假设|虚构|练习|？|\?")
        if sentences and all(advice.search(s) for s in sentences):
            status, reason = "not_required", "文字建议或明确的假设练习，无需额外证据图片。"
        else:
            status, reason = "review_required", "无法自动确认本页是否包含事实断言，请核对原稿并为事实绑定来源。"
    return {"schema": "echo-founder.page-evidence.v1", "status": status, "copy_sha256": digest, "reason": reason}
R5_DENSITY_RE = re.compile(
    r"\bR5\b[^\r\n]{0,240}?\bdensity\s*(?:[:=]\s*)?(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>%|percent\b)?",
    re.IGNORECASE,
)
R5_RE = re.compile(r"\bR5\b", re.IGNORECASE)
RENDER_SECTION_RE = re.compile(
    r"^\s*\[(?:PASS|WARN|FAIL)\]\s+(?P<asset>[^·\s]+).*?·\s*(?P<board>xhs|square|wide|unknown)\b",
    re.IGNORECASE,
)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_records(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _text_value(value: Any) -> str:
    return str(value or "").strip() if isinstance(value, (str, int, float)) else ""


def _source_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, (list, tuple, set)):
        return [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return []


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "approved", "allowed"}
    return bool(value)


def _ratio(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed > 1:
        parsed /= 100
    return parsed if 0 < parsed <= 1 else default


def _is_recipe_release(index: dict[str, Any]) -> bool:
    """A pre-recipe index stays legacy unless it opts into recipe release fields."""
    if index.get("legacy") is True:
        return False
    if index.get("legacy") is False:
        return True
    return bool(_text_value(index.get("recipe_path")) or _text_value(index.get("revision_id")))


def _recipe_context(index: dict[str, Any]) -> dict[str, Any]:
    recipe = _as_dict(index.get("recipe"))
    quality_policy = _as_dict(index.get("quality_policy")) or _as_dict(recipe.get("quality_policy"))
    recipe_assets = _as_records(index.get("recipe_assets")) or _as_records(recipe.get("assets"))
    platforms = _as_dict(index.get("platforms")) or _as_dict(recipe.get("platforms"))
    return {
        "quality_policy": quality_policy,
        "recipe_assets": recipe_assets,
        "platforms": platforms,
        "content_archetype": _text_value(index.get("content_archetype")) or _text_value(recipe.get("content_archetype")),
        "evidence_mode": _text_value(index.get("evidence_mode")) or _text_value(recipe.get("evidence_mode")),
        "recipe_schema": _text_value(index.get("recipe_schema")) or _text_value(recipe.get("schema")),
    }


def _is_xhs_3_4(output: dict[str, Any]) -> bool:
    kind = _text_value(output.get("kind")).lower()
    asset_id = _text_value(output.get("id")).lower()
    platform = _text_value(output.get("platform")).lower()
    output_path = _text_value(output.get("output")).lower()
    width = output.get("width")
    height = output.get("height")
    if kind == "xhs_card" or platform == "xhs" or asset_id.startswith("xhs-") or "/xhs/" in output_path:
        return True
    try:
        return abs((float(width) / float(height)) - 0.75) < 0.02
    except (TypeError, ValueError, ZeroDivisionError):
        return False


def _quality_text(index: dict[str, Any], render_html: str) -> tuple[str, bool]:
    """Collect QA diagnostics without treating aesthetic_status alone as density proof."""
    parts: list[str] = []
    seen: set[str] = set()

    def add_part(value: Any) -> None:
        text = str(value).strip() if isinstance(value, (str, int, float)) else ""
        if text and text not in seen:
            seen.add(text)
            parts.append(text)

    add_part(render_html)
    for field in ("render_quality_report", "validator_output", "quality_report"):
        if field not in index:
            continue
        value = index.get(field)
        if isinstance(value, str):
            add_part(value)
        elif isinstance(value, (list, tuple)):
            for item in value:
                add_part(item)
    if not parts:
        for item in index.get("density_warnings", []) if isinstance(index.get("density_warnings"), list) else []:
            add_part(item)
    return "\n".join(parts), bool(parts)


def _density_qa_assets(text: str) -> set[str]:
    return {
        match.group("asset")
        for line in text.splitlines()
        if (match := RENDER_SECTION_RE.match(line)) and match.group("board").lower() == "xhs"
    }


def _r5_density_findings(text: str) -> list[tuple[str, float, str]]:
    findings: list[tuple[str, float, str]] = []
    current_asset = ""
    current_is_xhs = True
    for line in text.splitlines() or [text]:
        header = RENDER_SECTION_RE.match(line)
        if header:
            current_asset = header.group("asset")
            current_is_xhs = header.group("board").lower() == "xhs"
        if not current_is_xhs:
            continue
        for match in R5_DENSITY_RE.finditer(line):
            raw_value = match.group("value")
            value = _ratio(raw_value, default=-1)
            if value < 0:
                continue
            label = f"{raw_value}%" if match.group("unit") or value > 1 else f"{value * 100:g}%"
            finding = (current_asset, value, label)
            if finding not in findings:
                findings.append(finding)
    return findings


def _measured_ratio(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed > 1:
        parsed /= 100
    return parsed if 0 <= parsed <= 1 else None


def _ocr_tokens(value: Any) -> list[str]:
    return re.findall(r"[\u4e00-\u9fff]{2,}|\d+(?:\.\d+)?%?", _text_value(value))


def _is_ai_raster(output: dict[str, Any]) -> bool:
    if _text_value(output.get("source_svg")) or _text_value(output.get("render_html")):
        return False
    if _text_value(output.get("format")).upper() in {"HTML", "SVG", "CANVAS"}:
        return False
    provider = _text_value(output.get("provider")).lower()
    return _truthy(output.get("ai_generated")) or provider in {
        "baoyu-comic",
        "baoyu-cover-image",
        "baoyu-xhs-images",
        "baoyu-infographic",
        "ian-xiaohei-illustrations",
    }


def _has_bound_ai_human_review(output: dict[str, Any]) -> bool:
    review = output.get("human_review")
    if not isinstance(review, dict):
        return False
    digest = _text_value(output.get("sha256"))
    return (
        review.get("schema") == "aifios.visual-human-review.v1"
        and review.get("status") == "pass"
        and review.get("method") == "human_visual_review"
        and review.get("reviewed_sha256") == digest
        and bool(re.fullmatch(r"[0-9a-f]{64}", digest))
        and review.get("text_status") == "no_text_confirmed"
        and review.get("concept_boundary_status") == "pass"
    )


def _has_unparseable_r5_warning(text: str) -> bool:
    for line in text.splitlines():
        if R5_RE.search(line) and "WARN" in line.upper():
            return True
    return False


def _repeated_series_is_explicit(index: dict[str, Any], context: dict[str, Any]) -> bool:
    candidates = [index.get("repeated_series")]
    xhs = _as_dict(context.get("platforms")).get("xhs")
    if isinstance(xhs, dict):
        candidates.append(xhs.get("repeated_series"))
    return any(_truthy(candidate) for candidate in candidates)


def _result_status(checks: dict[str, str], errors: list[str], reviews: list[str], *, legacy: bool = False) -> dict[str, Any]:
    status = "blocked" if errors else ("review_required" if reviews else "pass")
    return {
        "status": status,
        "checks": checks,
        "errors": errors,
        "blocking_issues": errors,
        "review_issues": reviews,
        "legacy": legacy,
    }


def audit_visual_golden_sample(index: dict[str, Any]) -> dict[str, Any]:
    """Measure a rendered revision against the Echo Founder reference set.

    This is a readiness report, not the normal release gate: a short article
    may still be publishable without being broad enough to become a reusable
    golden sample.
    """
    index = _as_dict(index)
    standard = _as_dict(index.get("golden_sample_standard"))
    if not standard:
        return {"status": "not_applicable", "checks": {}, "errors": []}

    outputs = _as_records(index.get("outputs"))
    outputs_by_id = {
        _text_value(output.get("id")): output
        for output in outputs
        if _text_value(output.get("id"))
    }
    checks: dict[str, str] = {
        "brand_identity": "pass",
        "wechat_directions": "pass",
        "inline_semantics": "pass",
        "share_narrative": "pass",
        "asset_differentiation": "pass",
        "source_evidence": "pass",
        "mobile_preview": "pass",
        "release_quality": "pass",
    }
    errors: list[str] = []
    platforms = _as_dict(index.get("platforms"))
    wechat_platform = _as_dict(platforms.get("wechat"))
    xhs_platform = _as_dict(platforms.get("xhs"))
    native_wechat_layout = (
        "wechat-html" in outputs_by_id
        and wechat_platform.get("asset_ids") == ["wechat-html"]
    )
    native_xhs = xhs_platform.get("platform_bindings") == ["xiaohongshu"]

    if _text_value(index.get("brand_profile")) != "echo-founder":
        checks["brand_identity"] = "blocked"
        errors.append("golden sample must use the echo-founder brand profile")

    if native_wechat_layout:
        checks["wechat_directions"] = "not_applicable"
        checks["inline_semantics"] = "not_applicable"
    else:
        required_directions = int(standard.get("required_wechat_directions") or 3)
        direction_pairs = (
            ("wechat-cover", "wechat-share"),
            ("wechat-cover-alt-01", "wechat-share-alt-01"),
            ("wechat-cover-alt-02", "wechat-share-alt-02"),
        )
        complete_directions = sum(all(asset_id in outputs_by_id for asset_id in pair) for pair in direction_pairs)
        if complete_directions < required_directions:
            checks["wechat_directions"] = "blocked"
            errors.append(f"golden sample requires {required_directions} complete WeChat cover directions")

        required_inline = int(standard.get("required_inline_visuals_min") or 2)
        inline_outputs = [asset_id for asset_id in outputs_by_id if re.fullmatch(r"inline-\d+", asset_id)]
        if len(inline_outputs) < required_inline:
            checks["inline_semantics"] = "blocked"
            errors.append(f"golden sample requires at least {required_inline} semantic inline visuals")

    required_series = 1 if native_xhs else int(standard.get("required_share_series") or 3)
    pages_per_series = 8 if native_xhs else int(standard.get("required_pages_per_series") or 5)
    series_pages: dict[str, set[int]] = {}
    for asset_id in outputs_by_id:
        match = re.fullmatch(r"xhs-(\d+)-p([1-8])", asset_id, re.IGNORECASE)
        if match:
            series_pages.setdefault(match.group(1), set()).add(int(match.group(2)))
    complete_series = sum(len(pages) == pages_per_series for pages in series_pages.values())
    if complete_series < required_series:
        checks["share_narrative"] = "blocked"
        errors.append(
            f"golden sample requires {required_series} complete P1-P{pages_per_series} share narratives"
        )

    if standard.get("require_distinct_render_hashes") is True:
        hashes: dict[str, list[str]] = {}
        for asset_id, output in outputs_by_id.items():
            if _text_value(output.get("format")).upper() == "HTML":
                continue
            digest = _text_value(output.get("sha256"))
            if digest:
                hashes.setdefault(digest, []).append(asset_id)
        duplicate = next((ids for ids in hashes.values() if len(ids) > 1), None)
        if duplicate:
            checks["asset_differentiation"] = "blocked"
            errors.append("golden sample contains duplicate rendered assets: " + ", ".join(sorted(duplicate)))

    source_assets = _source_values(index.get("source_assets"))
    if standard.get("require_source_backed_evidence_when_available") is True and source_assets:
        has_evidence = any(_source_values(output.get("evidence_sources")) for output in outputs)
        if not has_evidence:
            checks["source_evidence"] = "blocked"
            errors.append("golden sample has source materials but no source-backed evidence visual")

    if standard.get("require_mobile_preview") is True:
        tools = _source_values(index.get("quality_tools"))
        if not any("validate-social-deck" in tool for tool in tools):
            checks["mobile_preview"] = "blocked"
            errors.append("golden sample requires Playwright social-card preview validation")

    quality_summary = _as_dict(index.get("quality_summary"))
    if quality_summary.get("status") != "pass":
        checks["release_quality"] = "blocked"
        errors.append("golden sample requires quality_summary.status=pass")

    return {
        "status": "ready" if not errors else "not_ready",
        "checks": checks,
        "errors": errors,
        "standard_schema": _text_value(standard.get("schema")),
    }


def _verified_native_text_layout(output: dict[str, Any]) -> bool:
    """A measured text-card composition, not a blanket density exemption.

    Only the native renderer emits this proof after checking the actual DOM
    against all approved fields. Recheck the measurements and copy binding;
    a status label alone is insufficient. Evidence cards keep the density gate.
    """
    layout = _as_dict(output.get("native_layout"))
    fidelity = _as_dict(output.get("copy_fidelity"))
    fields = _as_records(layout.get("fields"))
    text = output.get("expected_text")
    def number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if not (
        layout.get("schema") == "echo-founder.native-card-layout.v1"
        and layout.get("status") == "pass" and layout.get("errors") == []
        and layout.get("mode") == "text" and layout.get("overlapping") is False
        and layout.get("width") == 1080 and layout.get("height") == 1440
        and 2 <= len(fields) <= 5 and layout.get("field_count") == len(fields)
        and fidelity.get("status") == "pass" and fidelity.get("errors") == []
        and fidelity.get("field_count") == len(fields)
        and isinstance(text, str) and text.strip()
        and layout.get("copy_sha256") == hashlib.sha256(text.encode("utf-8")).hexdigest()
        and number(layout.get("text_span")) and 288 <= layout["text_span"] <= 1328
        and number(layout.get("safe_margin")) and layout["safe_margin"] >= 56
        and isinstance(layout.get("short_copy"), bool)
    ):
        return False
    for field in fields:
        floor = {"title": 48, "body": 42, "note": 36}.get(field.get("role"))
        size, contrast, opacity = field.get("font_size"), field.get("contrast"), field.get("opacity")
        if floor is None or not number(size) or not floor - .1 <= size <= 144:
            return False
        if not number(contrast) or contrast < (3 if size >= 72 else 4.5) or not number(opacity) or opacity < .95:
            return False
    return not layout["short_copy"] or max(field["font_size"] for field in fields) >= 96


def _density_text_for_unverified_layouts(text: str, verified: set[str]) -> str:
    asset_id = ""
    lines = []
    for line in text.splitlines():
        header = RENDER_SECTION_RE.match(line)
        if header:
            asset_id = header.group("asset")
        if asset_id in verified and R5_RE.search(line) and "WARN" in line.upper():
            continue
        lines.append(line)
    return "\n".join(lines)


def audit_rendered_visual_index(index: dict[str, Any], render_html: str) -> dict[str, Any]:
    """Audit a selected recipe release using its rendered xhs-card QA report.

    ``render_html`` is the renderer's persisted QA text (normally the
    ``validate-social-deck`` report), not an aesthetic_status shortcut.  The
    returned object is intentionally JSON-safe so publishers can persist it as
    ``index["quality_summary"]``.
    """
    index = _as_dict(index)
    if not _is_recipe_release(index):
        return _result_status(
            {
                "recipe": "legacy",
                "density": "not_applicable",
                "evidence": "not_applicable",
                "layout_diversity": "not_applicable",
                "ocr_text": "not_applicable",
            },
            [],
            ["legacy visual index has no selected recipe revision"],
            legacy=True,
        )

    context = _recipe_context(index)
    errors: list[str] = []
    reviews: list[str] = []
    checks = {
        "recipe": "pass",
        "density": "pass",
        "evidence": "pass",
        "evidence_detail": "pass",
        "layout_diversity": "pass",
        "asset_differentiation": "pass",
        "moments_delivery": "pass",
        "ocr_text": "pass",
        "platform_native_contract": "pass",
        "visual_consistency": "pass",
    }

    for field in ("recipe_path", "revision_id"):
        if not _text_value(index.get(field)):
            checks["recipe"] = "blocked"
            errors.append(f"recipe release is missing {field}")

    outputs = _as_records(index.get("outputs"))
    for output in outputs:
        if (output.get("kind") == "wechat_html" or output.get("id") == "wechat-html") and output.get("renderer") == "local":
            from wechat_fidelity import verified_fidelity

            checks.setdefault("wechat_fidelity", "pass")
            if not verified_fidelity(output):
                checks["wechat_fidelity"] = "blocked"
                errors.append("公众号排版缺少与当前文件绑定的全文及引用保真检查，请重新排版。")
    xhs_outputs = [output for output in outputs if _is_xhs_3_4(output)]
    outputs_by_id = { _text_value(output.get("id")): output for output in outputs if _text_value(output.get("id")) }

    differentiation_groups = {
        "wechat cover directions": ("wechat-cover", "wechat-cover-alt-01", "wechat-cover-alt-02"),
        "wechat share directions": ("wechat-share", "wechat-share-alt-01", "wechat-share-alt-02"),
    }
    for label, asset_ids in differentiation_groups.items():
        hashes: dict[str, list[str]] = {}
        paths: dict[str, list[str]] = {}
        for asset_id in asset_ids:
            output = outputs_by_id.get(asset_id)
            if not output:
                continue
            digest = _text_value(output.get("sha256"))
            path = _text_value(output.get("output"))
            if digest:
                hashes.setdefault(digest, []).append(asset_id)
            if path:
                paths.setdefault(path, []).append(asset_id)
        duplicates = [ids for ids in (*hashes.values(), *paths.values()) if len(ids) > 1]
        if duplicates:
            checks["asset_differentiation"] = "blocked"
            ids = ", ".join(sorted(set(duplicates[0])))
            errors.append(f"{label} must be visually distinct; duplicate output detected: {ids}")

    xhs_hashes: dict[str, list[str]] = {}
    for output in xhs_outputs:
        digest = _text_value(output.get("sha256"))
        asset_id = _text_value(output.get("id"))
        if digest and asset_id:
            xhs_hashes.setdefault(digest, []).append(asset_id)
    duplicate_xhs = next((ids for ids in xhs_hashes.values() if len(ids) > 1), None)
    if duplicate_xhs:
        checks["asset_differentiation"] = "blocked"
        errors.append("XHS pages must not reuse an identical rendered image: " + ", ".join(sorted(duplicate_xhs)))

    quality_text, quality_text_supplied = _quality_text(index, render_html)
    min_density = _ratio(context["quality_policy"].get("min_density"), DEFAULT_RECIPE_MIN_DENSITY)
    expected_qa_assets = {_text_value(output.get("id")) for output in xhs_outputs if _text_value(output.get("id"))}
    native_text_assets = set()
    for output in xhs_outputs:
        if _as_dict(output.get("native_layout")).get("mode") != "text":
            continue
        checks.setdefault("native_text_layout", "pass")
        if context["recipe_schema"] == "aifios.visual-recipe.v2" and _verified_native_text_layout(output):
            native_text_assets.add(_text_value(output.get("id")))
        else:
            checks["native_text_layout"] = "blocked"
            errors.append(f"{_text_value(output.get('id'))} native text layout measurements are missing, invalid or no longer match its copy")
    density_text = _density_text_for_unverified_layouts(quality_text, native_text_assets)
    density_findings = _r5_density_findings(density_text)
    if native_text_assets and native_text_assets == expected_qa_assets:
        checks["density"] = "not_applicable"
    reported_qa_assets = _density_qa_assets(quality_text)
    if density_findings:
        for asset_id, density, label in density_findings:
            if density < min_density:
                checks["density"] = "blocked"
                name = asset_id or "3:4 xhs asset"
                errors.append(
                    f"{name} density {label} is below {min_density * 100:g}%"
                )
        if checks["density"] == "pass":
            checks["density"] = "review_required"
            reviews.append("R5 density warning is above the release threshold and needs visual review")
    if _has_unparseable_r5_warning(density_text) and not density_findings:
        checks["density"] = "review_required"
        reviews.append("R5 density warning has no parseable percentage")
    if expected_qa_assets and (not quality_text_supplied or reported_qa_assets != expected_qa_assets):
        checks["density"] = "blocked"
        missing_assets = sorted(expected_qa_assets - reported_qa_assets)
        detail = f": missing {', '.join(missing_assets)}" if missing_assets else ""
        errors.append(f"complete 3:4 render QA report is required{detail}")

    recipe_assets = { _text_value(asset.get("id")): asset for asset in context["recipe_assets"] if _text_value(asset.get("id")) }
    if context["recipe_schema"] == "aifios.visual-recipe.v2":
        xhs_ids = sorted(asset_id for asset_id in recipe_assets if re.fullmatch(r"xhs-01-p[1-8]", asset_id, re.IGNORECASE))
        expected_xhs = [f"xhs-01-p{page}" for page in range(1, 9)]
        if xhs_ids and sorted(value.lower() for value in xhs_ids) != sorted(expected_xhs):
            checks["platform_native_contract"] = "blocked"
            errors.append("native XHS visual recipe must contain exactly P1-P8")
        xhs_groups = {
            _text_value(asset.get("consistency_group"))
            for asset_id, asset in recipe_assets.items()
            if asset_id.lower().startswith("xhs-")
        }
        if xhs_ids and (len(xhs_groups) != 1 or "" in xhs_groups):
            checks["visual_consistency"] = "blocked"
            errors.append("native XHS P1-P8 must share one consistency_group")
        for asset_id, asset in recipe_assets.items():
            overlay = _as_dict(asset.get("text_overlay"))
            if overlay.get("renderer") != "html-playwright" or not isinstance(overlay.get("expected_text"), str):
                checks["platform_native_contract"] = "blocked"
                errors.append(f"{asset_id} is missing deterministic text_overlay")
            if _text_value(asset.get("source_type")) == "ai_concept":
                output = outputs_by_id.get(asset_id)
                if not isinstance(output, dict) or output.get("ai_generated") is not True:
                    continue
                generation = _as_dict(output.get("generation"))
                required_generation = (
                    "benchmark_id", "route_id", "model_id", "operation_id",
                    "request_sha256", "output_sha256", "human_review_status",
                )
                missing_generation = [key for key in required_generation if not generation.get(key)]
                if missing_generation:
                    checks["platform_native_contract"] = "blocked"
                    errors.append(f"{asset_id} is missing paid generation evidence: {', '.join(missing_generation)}")
                if generation.get("human_review_status") != "accepted":
                    if checks["visual_consistency"] == "pass":
                        checks["visual_consistency"] = "review_required"
                    reviews.append(f"{asset_id} requires human visual acceptance before release")
    moments_assets = {
        asset_id: asset
        for asset_id, asset in recipe_assets.items()
        if _text_value(asset.get("platform")) == "moments"
    }
    if context["recipe_schema"] == "aifios.visual-recipe.v2" and moments_assets:
        checks["platform_native_contract"] = "blocked"
        errors.append("visual-recipe.v2 must not create Moments static assets")
    if moments_assets:
        expected_moments = {
            asset_id
            for asset_id in moments_assets
            if re.fullmatch(r"moments-\d+-p[135]", asset_id, re.IGNORECASE)
        }
        if len(expected_moments) != len(moments_assets):
            checks["moments_delivery"] = "blocked"
            errors.append("moments delivery assets must use moments-NN-p1/p3/p5 ids")
        for asset_id in sorted(expected_moments):
            output = outputs_by_id.get(asset_id)
            if not output:
                checks["moments_delivery"] = "blocked"
                errors.append(f"moments square asset {asset_id} was not rendered")
                continue
            width = output.get("width")
            height = output.get("height")
            if (
                _text_value(output.get("kind")) != "moments_card"
                or width != 1080
                or height != 1080
                or _text_value(output.get("upload_format")) != "1:1"
            ):
                checks["moments_delivery"] = "blocked"
                errors.append(f"moments square asset {asset_id} is not a 1080x1080 upload-ready card")
        declared_posts = {
            int(match.group(1))
            for asset_id in expected_moments
            if (match := re.fullmatch(r"moments-(\d+)-p[135]", asset_id, re.IGNORECASE))
        }
        for post in sorted(declared_posts):
            expected_triptych = {f"moments-{post:02d}-p{page}" for page in (1, 3, 5)}
            if not expected_triptych.issubset(expected_moments):
                checks["moments_delivery"] = "blocked"
                errors.append(f"moments post {post} is missing a P1/P3/P5 square triptych")
    elif len({
        match.group(1)
        for asset_id in recipe_assets
        if (match := re.fullmatch(r"xhs-(\d+)-p[1-5]", asset_id, re.IGNORECASE))
    }) >= 3:
        # Current recipes intentionally render one portrait P1-P5 suite and
        # bind those exact files to both Xiaohongshu and Moments. Older
        # recipes may omit the metadata; dedicated moments-* assets above are
        # still audited under their legacy square contract.
        xhs_platform = _as_dict(context["platforms"].get("xhs"))
        bindings = xhs_platform.get("platform_bindings")
        if bindings is not None and bindings != ["xiaohongshu", "moments"]:
            checks["moments_delivery"] = "blocked"
            errors.append("shared social suites must bind Xiaohongshu and Moments")

    evidence_ids: set[str] = set()
    page_policy_ids: set[str] = set()
    for asset_id, asset in recipe_assets.items():
        policy = asset.get("page_evidence")
        if policy is not None:
            expected = native_page_evidence(_as_dict(asset.get("copy")), _text_value(asset.get("source")))
            if policy != expected:
                checks["evidence"] = "blocked"
                errors.append(f"{asset_id} page evidence requirement is stale or invalid; regenerate from the current approved copy")
            else:
                page_policy_ids.add(asset_id)
                if expected["status"] == "required":
                    evidence_ids.add(asset_id)
                elif expected["status"] == "review_required":
                    checks["evidence"] = "review_required"
                    reviews.append(f"{asset_id}: {expected['reason']}")
        role = _text_value(asset.get("role")).lower()
        if role in {"evidence", "evidence_required"} or _truthy(asset.get("evidence_required")):
            evidence_ids.add(asset_id)
    for output in outputs:
        role = _text_value(output.get("role")).lower()
        if role in {"evidence", "evidence_required"} or _truthy(output.get("evidence_required")):
            evidence_ids.add(_text_value(output.get("id")))

    evidence_mode = context["evidence_mode"].lower()
    wechat_only = (
        set(context["platforms"]) == {"wechat"}
        and bool(recipe_assets)
        and all(asset.get("platform") == "wechat" for asset in recipe_assets.values())
        and not xhs_outputs
    )
    if not evidence_ids and evidence_mode in EVIDENCE_REQUIRED_MODES and not wechat_only:
        inferred = [output for output in xhs_outputs if re.search(r"-p2$", _text_value(output.get("id")), re.IGNORECASE)
                    and _text_value(output.get("id")) not in page_policy_ids]
        if inferred:
            evidence_ids.update(_text_value(output.get("id")) for output in inferred)
        elif not xhs_outputs or any(_text_value(output.get("id")) not in page_policy_ids for output in xhs_outputs):
            checks["evidence"] = "blocked"
            errors.append("recipe requires an evidence asset but no XHS evidence page was rendered")
    elif not evidence_ids and evidence_mode == "illustration_allowed":
        ai_rasters = [output for output in outputs if _is_ai_raster(output)]
        if ai_rasters and not all(_has_bound_ai_human_review(output) for output in ai_rasters):
            checks["evidence"] = "review_required"
            reviews.append("recipe explicitly permits illustration instead of source-backed evidence")

    for asset_id in sorted(evidence_ids):
        output = outputs_by_id.get(asset_id)
        if not output:
            checks["evidence"] = "blocked"
            errors.append(f"evidence-required asset {asset_id} was not rendered")
            continue
        sources = _source_values(output.get("evidence_sources")) or _source_values(output.get("evidence_source"))
        if not sources:
            checks["evidence"] = "blocked"
            errors.append(f"evidence-required asset {asset_id} is missing evidence source")
            continue
        required_ratio = _ratio(context["quality_policy"].get("require_evidence_ratio"), 0.4)
        evidence_ratio = _measured_ratio(output.get("evidence_ratio"))
        approved_shortfall = _truthy(output.get("evidence_shortfall_approved"))
        if evidence_ratio is None:
            checks["evidence"] = "blocked"
            errors.append(f"evidence-required asset {asset_id} has no measurable evidence visual area")
        elif evidence_ratio < required_ratio and not approved_shortfall:
            checks["evidence"] = "blocked"
            errors.append(
                f"evidence-required asset {asset_id} uses {evidence_ratio * 100:g}% evidence area, below {required_ratio * 100:g}%"
            )
        elif evidence_ratio < required_ratio:
            checks["evidence"] = "review_required"
            reviews.append(f"evidence shortfall for {asset_id} was explicitly approved")
        image_evidence = _text_value(output.get("evidence_kind")) == "image" or any(
            re.search(r"\.(?:png|jpe?g|webp|gif)$", source, re.IGNORECASE)
            for source in sources
        )
        if image_evidence:
            detail_score = _measured_ratio(output.get("evidence_detail_score"))
            required_detail = _ratio(
                context["quality_policy"].get("min_evidence_detail"),
                DEFAULT_MIN_EVIDENCE_DETAIL,
            )
            if detail_score is None:
                checks["evidence_detail"] = "blocked"
                errors.append(f"image evidence asset {asset_id} has no measurable visual detail score")
            elif detail_score < required_detail:
                checks["evidence_detail"] = "blocked"
                errors.append(
                    f"image evidence asset {asset_id} visual detail {detail_score * 100:g}% < {required_detail * 100:g}%"
                )

    for output in outputs:
        if not _is_ai_raster(output):
            continue
        explicit_mismatches = _source_values(output.get("ocr_mismatches"))
        ocr_text = _text_value(output.get("ocr_text"))
        expected_text = _text_value(output.get("expected_text"))
        expected_tokens = set(_ocr_tokens(expected_text))
        unexpected_tokens = [token for token in _ocr_tokens(ocr_text) if token not in expected_tokens]
        mismatches = explicit_mismatches or unexpected_tokens
        asset_id = _text_value(output.get("id")) or "AI raster asset"
        if mismatches:
            checks["ocr_text"] = "blocked"
            errors.append(f"{asset_id} OCR found unexpected Chinese/number text: {', '.join(mismatches)}")
        elif _has_bound_ai_human_review(output) and not ocr_text:
            pass
        elif not ocr_text:
            if checks["ocr_text"] == "pass":
                checks["ocr_text"] = "review_required"
            reviews.append(f"{asset_id} AI raster has no OCR verification result")

    layouts_by_series: dict[str, dict[str, list[str]]] = {}
    missing_layouts: list[str] = []
    for output in xhs_outputs:
        asset_id = _text_value(output.get("id")) or "<unknown>"
        layout = _text_value(output.get("layout_recipe"))
        if not layout:
            missing_layouts.append(asset_id)
            continue
        match = re.fullmatch(r"(xhs-\d+)-p[1-8]", asset_id, re.IGNORECASE)
        series_id = match.group(1) if match else "all"
        layouts_by_series.setdefault(series_id, {}).setdefault(layout, []).append(asset_id)
    if missing_layouts:
        checks["layout_diversity"] = "review_required"
        reviews.append("xhs assets lack layout_recipe: " + ", ".join(missing_layouts))
    duplicate_layouts = {
        f"{series_id}:{layout}": asset_ids
        for series_id, layouts in layouts_by_series.items()
        for layout, asset_ids in layouts.items()
        if len(asset_ids) > 1
    }
    if duplicate_layouts and context.get("recipe_schema") != "aifios.visual-recipe.v2" and not _repeated_series_is_explicit(index, context):
        checks["layout_diversity"] = "blocked"
        descriptions = ", ".join(f"{layout} ({', '.join(asset_ids)})" for layout, asset_ids in sorted(duplicate_layouts.items()))
        errors.append(f"duplicate XHS layout recipes require explicit repeated series: {descriptions}")

    return _result_status(checks, errors, reviews)


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms)(?:{heading_pattern})(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def line_value(section: str, label_pattern: str) -> str:
    match = re.search(rf"(?m)^\s*[-*]\s*(?:\*\*)?\s*(?:{label_pattern})(?:\s*/\s*(?:{label_pattern}))?\s*(?:\*\*)?\s*[：:]\s*(.+?)\s*$", section or "")
    return match.group(1).strip() if match else ""


def meaningful_value(value: str, min_chars: int = 4) -> bool:
    if not value:
        return False
    compact = re.sub(r"\s+", "", value)
    if len(compact) < min_chars:
        return False
    return not PLACEHOLDER_RE.search(value)


def markdown_item_count(section: str) -> int:
    return len(re.findall(r"(?m)^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+", section or ""))


def table_rows(section: str) -> int:
    return len([
        line for line in (section or "").splitlines()
        if line.strip().startswith("|") and "---" not in line
    ])


def text_mentions_any(text: str, needles: list[str]) -> bool:
    return any(re.search(re.escape(needle), text or "", re.IGNORECASE) for needle in needles)


def has_dimension(text: str) -> bool:
    return bool(re.search(r"(?:\d+\s*[:xX×]\s*\d+|16\s*:\s*9|21\s*:\s*9|1\s*:\s*1|3\s*:\s*4|9\s*:\s*16|1080|1920|30fps|MP4|mp4|封面|头图|分享卡|HTML|html|style|样式|排版)", text or ""))


def has_prompt_signal(text: str) -> bool:
    return bool(re.search(r"(?:prompt|提示词|画面|构图|主体|背景|镜头|风格|文案|封面|卡片|插图|HTML|安全区)", text or "", re.IGNORECASE))


def claimed_done_manifest_rows(manifest: str) -> list[str]:
    rows: list[str] = []
    for line in (manifest or "").splitlines():
        stripped = line.strip()
        if "pipeline/visual/" not in stripped:
            continue
        if not COMPLETED_STATUS_RE.search(stripped):
            continue
        if PLANNED_STATUS_RE.search(stripped):
            continue
        rows.append(stripped[:220])
    return rows


def audit_visual_publish_record(body: str) -> dict[str, Any]:
    blocking: list[str] = []
    review: list[str] = []
    source = section_text(body, r"^##\s*0\.\s+来源")
    files = section_text(body, r"^##\s*1\.\s+已生成文件")
    index_section = section_text(body, r"^##\s*2\.\s+生成索引")
    output_paths = sorted({path.strip(" `|，。；;)）]") for path in VISUAL_PATH_RE.findall(files + "\n" + index_section)})
    if "Package" not in source and "package" not in source:
        blocking.append("视觉发布产物缺少 Package 来源。")
    if len(output_paths) < 6:
        blocking.append("视觉发布产物记录至少需要 6 个 pipeline/visual 输出路径。")
    if "index.json" not in index_section:
        blocking.append("视觉发布产物记录缺少 index.json。")
    if not re.search(r"generated|已生成|pass", files, re.IGNORECASE):
        blocking.append("视觉发布产物记录缺少生成状态。")
    if PUBLISH_RECORD_FORBIDDEN_RE.search(body):
        blocking.append("视觉发布产物记录包含禁止的中间报告措辞。")
    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "source_path": line_value(source, r"Package|package|来源"),
            "visual_output_paths": output_paths,
            "publish_record": True,
        },
    }


def audit_visual(body: str) -> dict[str, Any]:
    """Audit whether a visual plan can be executed by downstream visual tools."""
    body = body or ""
    blocking: list[str] = []
    review: list[str] = []

    if re.search(r"(?m)^##\s*0\.\s+来源", body) and re.search(r"(?m)^##\s*1\.\s+已生成文件", body):
        return audit_visual_publish_record(body)

    required_sections = {
        "meta": (r"^##\s*0\.\s+原文与视觉目标", "缺少 `## 0. 原文与视觉目标`。"),
        "system": (r"^##\s*1\.\s+视觉系统", "缺少 `## 1. 视觉系统`。"),
        "assets": (r"^##\s*2\.\s+视觉资产清单", "缺少 `## 2. 视觉资产清单`。"),
        "prompts": (r"^##\s*3\.\s+资产生产说明", "缺少 `## 3. 资产生产说明`。"),
        "acceptance": (r"^##\s*4\.\s+验收清单", "缺少 `## 4. 验收清单`。"),
        "next": (r"^##\s*5\.\s+下一步执行指令", "缺少 `## 5. 下一步执行指令`。"),
        "manifest": (MANIFEST_HEADING_RE, "缺少 `## 6. 交付 Manifest`。"),
    }
    for pattern, message in required_sections.values():
        if not re.search(pattern, body, re.MULTILINE):
            blocking.append(message)

    meta = section_text(body, r"^##\s*0\.\s+原文与视觉目标")
    system = section_text(body, r"^##\s*1\.\s+视觉系统")
    assets = section_text(body, r"^##\s*2\.\s+视觉资产清单")
    prompts = section_text(body, r"^##\s*3\.\s+资产生产说明")
    acceptance = section_text(body, r"^##\s*4\.\s+验收清单")
    next_section = section_text(body, r"^##\s*5\.\s+下一步执行指令")
    manifest = section_text(body, MANIFEST_HEADING_RE)

    source_path = line_value(meta, r"原文路径|来源路径|成稿路径|文件路径")
    title = line_value(meta, r"标题|原文标题")
    platforms = line_value(meta, r"目标平台|目标阵地|平台")
    visual_goal = line_value(meta, r"视觉目标|目标")
    if not meaningful_value(source_path, 4):
        blocking.append("原文与视觉目标缺少可追溯的原文路径。")
    if not meaningful_value(title, 3):
        blocking.append("原文与视觉目标缺少标题。")
    if not meaningful_value(platforms, 2):
        blocking.append("原文与视觉目标缺少目标平台。")
    if not meaningful_value(visual_goal, 6):
        blocking.append("原文与视觉目标缺少可执行的视觉目标。")

    style = line_value(system, r"统一风格|风格方向|主风格")
    palette = line_value(system, r"配色|色彩|色板")
    typography = line_value(system, r"字体|字形|文字系统")
    layout = line_value(system, r"版式|构图|网格|布局")
    for value, label in [(style, "统一风格"), (palette, "配色"), (typography, "字体/文字系统"), (layout, "版式/构图")]:
        if not meaningful_value(value, 4):
            blocking.append(f"视觉系统缺少{label}。")
    if text_mentions_any(system, ["混用", "随意", "都可以"]):
        review.append("视觉系统出现风格不统一信号，建议收敛到一种主风格。")

    asset_rows = table_rows(assets)
    if asset_rows < 3 and markdown_item_count(assets) < 3:
        blocking.append("视觉资产清单过薄，至少需要 3 个资产或表格行。")
    if not text_mentions_any(assets, EXECUTION_TOOLS):
        blocking.append(f"视觉资产清单缺少明确执行工具：{EXECUTION_TOOL_LABEL}。")
    if not has_dimension(assets):
        blocking.append("视觉资产清单缺少尺寸、比例或 HTML 样式。")
    if not text_mentions_any(assets, ["产物路径", "输出路径", "pipeline/visual", "文件名"]):
        review.append("视觉资产清单未明确产物路径或文件名。")
    if text_mentions_any(assets, ["公众号", "微信"]) and text_mentions_any(assets, ["排版", "正文", "HTML", "html"]) and not text_mentions_any(assets, ["dbs-wechat-html", "公众号HTML输出"]):
        review.append("公众号正文排版建议显式使用 `dbs-wechat-html`，并写明 `公众号HTML输出/` 产物目录。")
    if text_mentions_any(body, DESIGN_TOOLS) and not text_mentions_any(f"{assets}\n{prompts}\n{manifest}", ["prompt", "Prompt", "提示词", "prompts/"]):
        review.append("使用 Baoyu 设计层时，建议在资产清单或 Manifest 中登记 prompt 文件路径。")

    prompt_items = markdown_item_count(prompts)
    if prompt_items < 3:
        blocking.append("资产生产说明过薄，至少需要 3 条 prompt/文案/构图说明。")
    if not has_prompt_signal(prompts):
        blocking.append("资产生产说明缺少 prompt、画面、构图、主体或文案。")
    if not text_mentions_any(prompts, EXECUTION_TOOLS):
        blocking.append("资产生产说明缺少每个资产对应的执行工具。")
    if re.search(r"(?:生成一张好看的图|高级感|科技感|配一张图)", prompts or "") and prompt_items < 5:
        blocking.append("资产生产说明过于空泛，需要具体主体、场景、构图、文字和尺寸。")

    acceptance_items = markdown_item_count(acceptance)
    if acceptance_items < 4:
        blocking.append("验收清单过薄，至少需要尺寸、文字安全、风格一致、版权/隐私四类检查。")
    for keyword in ["尺寸", "文字", "风格", "版权", "隐私"]:
        if keyword not in acceptance:
            review.append(f"验收清单建议补充 `{keyword}` 检查。")

    if not text_mentions_any(next_section, EXECUTION_TOOLS):
        blocking.append("下一步执行指令缺少要调用的视觉执行工具。")
    if not COMMAND_RE.search(next_section or ""):
        blocking.append("下一步执行指令缺少可执行命令或明确工具入口。")

    manifest_rows = table_rows(manifest)
    manifest_items = markdown_item_count(manifest)
    output_paths = sorted({path.strip(" `|，。；;)）]") for path in VISUAL_PATH_RE.findall(manifest)})
    if manifest and manifest_rows < 3 and manifest_items < 3:
        blocking.append("交付 Manifest 过薄，至少需要 3 个资产条目或表格行。")
    if manifest and not re.search(r"资产\s*ID|asset[_ -]?id|产物|输出文件|输出路径|output", manifest, re.IGNORECASE):
        blocking.append("交付 Manifest 缺少资产 ID 或输出文件字段。")
    if manifest and not re.search(r"源文件|来源|input|原文|source", manifest, re.IGNORECASE):
        blocking.append("交付 Manifest 缺少源文件/来源字段。")
    if manifest and not re.search(r"格式|format|PNG|JPG|JPEG|HTML|MD|PDF|SVG|MP4|MOV|H\.264|AAC", manifest, re.IGNORECASE):
        blocking.append("交付 Manifest 缺少格式字段。")
    if manifest and not re.search(r"尺寸|比例|size|16\s*:\s*9|21\s*:\s*9|3\s*:\s*4|1\s*:\s*1|HTML", manifest, re.IGNORECASE):
        blocking.append("交付 Manifest 缺少尺寸/比例字段。")
    if manifest and not text_mentions_any(manifest, EXECUTION_TOOLS):
        blocking.append(f"交付 Manifest 缺少执行工具：{EXECUTION_TOOL_LABEL}。")
    if manifest and len(output_paths) < 3:
        blocking.append("交付 Manifest 至少需要 3 个 `pipeline/visual/...` 输出路径。")
    if manifest and not re.search(r"验收|检查|exists|存在|preview|人工|状态|planned|generated|review", manifest, re.IGNORECASE):
        blocking.append("交付 Manifest 缺少验收状态或产物检查方式。")
    if manifest and not re.search(r"打包|交付包|delivery-pack|deliveries/|share|下载", manifest, re.IGNORECASE):
        review.append("交付 Manifest 建议写明交付包/下载打包路径，便于分享和交付。")
    done_rows = claimed_done_manifest_rows(manifest)
    if done_rows:
        blocking.append("视觉计划阶段不能把 Manifest 资产标记为 PASS/已生成/已落盘；请使用 planned/review/待生成，真实资产由生成工具和 delivery-audit 校验。")

    placeholder_hits = len(PLACEHOLDER_RE.findall(body))
    if placeholder_hits >= 3:
        blocking.append("视觉计划中占位表达过多，不能交给视觉工具执行。")
    elif placeholder_hits:
        review.append("视觉计划中仍有少量占位表达，下游生成前需补齐。")

    status = "blocked" if blocking else ("review_required" if review else "pass")
    return {
        "status": status,
        "blocking_issues": blocking,
        "review_issues": review,
        "checks": {
            "source_path": source_path,
            "title": title,
            "platforms": platforms,
            "visual_goal": visual_goal,
            "style": style,
            "asset_rows": asset_rows,
            "prompt_items": prompt_items,
            "acceptance_items": acceptance_items,
            "manifest_rows": manifest_rows,
            "manifest_items": manifest_items,
            "visual_output_paths": output_paths,
            "claimed_done_manifest_rows": done_rows,
            "placeholder_hits": placeholder_hits,
        },
    }

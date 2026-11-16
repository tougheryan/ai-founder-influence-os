#!/usr/bin/env python3
"""Create constrained, immutable revisions of Visual Director recipes.

This module intentionally accepts a small, declarative request contract.  A
revision request may describe an approved operation, but it can never carry a
raw recipe replacement or choose a filesystem destination.
"""
from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat as stat_module
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from visual_director import next_recipe_id, validate_visual_recipe


ALLOWED_OPERATIONS = frozenset(
    {
        "change_system",
        "replace_evidence",
        "change_layout",
        "reduce_copy",
    }
)
_LEGACY_READ_ONLY_OPERATIONS = frozenset({"change_palette", "regenerate_illustration"})

_REQUEST_FIELDS = frozenset(
    {
        "schema",
        "base_revision_id",
        "request",
        "operations",
        "target_asset_ids",
        "constraints",
        "status",
        "diagnostic_reason",
        "revision_id",
        "index_path",
        "wechat_layout",
    }
)
_RAW_PATCH_FIELDS = frozenset(
    {
        "recipe",
        "recipe_patch",
        "patch",
        "patches",
        "replacement_recipe",
        "overrides",
        "override",
        "changes",
        "assets",
        "platforms",
        "recipePath",
        "recipe_path",
    }
)
_REQUEST_STATUSES = frozenset({"queued", "review_required", "rendered", "blocked"})
_REVISION_ID_RE = re.compile(r"r\d{3,}$")
_RECIPE_FILE_RE = re.compile(r"(r\d+)\.visual-recipe\.json$")
_SAFE_SLUG_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff][0-9A-Za-z._\-\u4e00-\u9fff]*$")
_CONSUMER_SLUG_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff-]{1,50}$")
_REQUEST_ID_RE = re.compile(r"r\d{3,}-request(?:-\d{2})?$")
_ASSET_ID_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z._\-]*$")
_PERSISTED_ASSET_ID_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z\-]{0,79}$")
_LAYOUT_CODE_RE = re.compile(r"\b([SM]\d{2})\b", re.IGNORECASE)
_MD2WECHAT_THEME_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}$")

_SYSTEM_LAYOUTS = {
    "swiss": ["S01", "S08", "S06", "S10", "S12"],
    "editorial": ["M01", "M05", "M08", "M11", "M15"],
    "hybrid": ["M01", "S10", "S06", "M10", "S12"],
}
_SYSTEM_TERMS = {
    "editorial": ("editorial", "magazine", "杂志", "编辑风", "刊物"),
    "swiss": ("swiss", "瑞士", "国际主义"),
    "hybrid": ("hybrid", "混合"),
}
_SCREENSHOT_SOURCE_EXTENSIONS = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".gif"}
)
_DATA_SOURCE_EXTENSIONS = frozenset({".csv", ".json", ".tsv"})


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _asset_ids(recipe: dict[str, Any]) -> set[str]:
    assets = recipe.get("assets")
    if not isinstance(assets, list):
        return set()
    return {
        asset["id"]
        for asset in assets
        if isinstance(asset, dict) and isinstance(asset.get("id"), str) and asset["id"].strip()
    }


def _request_target_ids(request: dict[str, Any]) -> list[str]:
    value = request.get("target_asset_ids")
    return list(value) if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


def _requested_system(text: str) -> str | None:
    normalized = text.lower()
    matches = [
        (normalized.rfind(term), system)
        for system, terms in _SYSTEM_TERMS.items()
        for term in terms
        if term in normalized
    ]
    if not matches:
        return None
    # Requests often name the old system before the requested one (for example,
    # "from Swiss to editorial"); the final explicit system is the target.
    return max(matches, key=lambda item: item[0])[1]


def _safe_source_assets(recipe: dict[str, Any]) -> list[str]:
    source_assets = recipe.get("source_assets")
    if not isinstance(source_assets, list):
        return []
    sources: list[str] = []
    for value in source_assets:
        if not isinstance(value, str):
            continue
        segments = value.split("/")
        if (
            not value.strip()
            or value.startswith("/")
            or "\\" in value
            or "\x00" in value
            or any(not segment or segment in {".", ".."} for segment in segments)
            or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value)
        ):
            continue
        sources.append(value)
    return sources


def _requested_evidence_intent(request_text: str) -> str:
    normalized = request_text.lower()
    if re.search(r"截图|截屏|界面|图片|照片|screenshot|screen|\bui\b|image|photo", normalized):
        return "screenshot"
    if re.search(r"数据|表格|电子表格|csv|json|excel|\bxls\b|xlsx|dataset|spreadsheet", normalized):
        return "data"
    return "any"


def _evidence_source_matches_intent(source: str, intent: str) -> bool:
    normalized = source.lower()
    suffix = Path(normalized).suffix
    if intent == "any":
        return suffix in (_DATA_SOURCE_EXTENSIONS | _SCREENSHOT_SOURCE_EXTENSIONS)
    if intent == "data":
        return suffix in _DATA_SOURCE_EXTENSIONS
    return suffix in _SCREENSHOT_SOURCE_EXTENSIONS


def _evidence_source_candidates(
    recipe: dict[str, Any],
    asset: dict[str, Any],
    request_text: str,
) -> list[str]:
    intent = _requested_evidence_intent(request_text)
    current = asset.get("source")
    return [
        source
        for source in _safe_source_assets(recipe)
        if source != current and _evidence_source_matches_intent(source, intent)
    ]


def _assets_for_operation(recipe: dict[str, Any], request: dict[str, Any], operation: str) -> list[dict[str, Any]]:
    assets = recipe.get("assets")
    if not isinstance(assets, list):
        return []
    target_ids = set(_request_target_ids(request))
    selected = [asset for asset in assets if isinstance(asset, dict) and asset.get("id") in target_ids]
    if target_ids:
        return selected
    if operation == "replace_evidence":
        return [
            asset
            for asset in assets
            if isinstance(asset, dict) and asset.get("role") in {"evidence", "evidence_required"}
        ]
    if operation == "change_layout":
        return [
            asset
            for asset in assets
            if isinstance(asset, dict) and asset.get("platform") == "xhs" and asset.get("layout_recipe")
        ]
    if operation == "reduce_copy":
        return [
            asset
            for asset in assets
            if isinstance(asset, dict) and isinstance(asset.get("copy"), dict)
        ]
    return []


def _operation_errors(recipe: dict[str, Any], request: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    operations = request.get("operations")
    if not isinstance(operations, list):
        return errors
    text = str(request.get("request") or "")
    for operation in operations:
        if operation not in ALLOWED_OPERATIONS:
            continue
        if operation == "change_system" and _requested_system(text) is None:
            errors.append("change_system request must name swiss, editorial, or hybrid")
        if operation == "change_system" and _requested_system(text) == recipe.get("platforms", {}).get("xhs", {}).get("system"):
            errors.append("change_system must change the current visual system")
        if operation == "change_system" and _request_target_ids(request):
            errors.append("change_system is global and does not accept target_asset_ids")
        if operation == "replace_evidence" and not _safe_source_assets(recipe):
            errors.append("replace_evidence requires a safe source asset declared by the recipe")
        target_ids = set(_request_target_ids(request))
        target_assets = [
            asset for asset in recipe.get("assets", [])
            if isinstance(asset, dict) and asset.get("id") in target_ids
        ]
        if operation == "replace_evidence" and target_ids:
            if any(asset.get("role") not in {"evidence", "evidence_required"} for asset in target_assets):
                errors.append("replace_evidence targets are not evidence assets")
            if any(not _evidence_source_candidates(recipe, asset, text) for asset in target_assets):
                errors.append("replace_evidence requires a matching alternative evidence source")
        if operation == "reduce_copy" and target_ids:
            if any(not _asset_has_reducible_copy(asset) for asset in target_assets):
                errors.append("reduce_copy targets must contain reducible copy")
        applicable_assets = _assets_for_operation(recipe, request, operation)
        if operation == "reduce_copy" and not any(_asset_has_reducible_copy(asset) for asset in applicable_assets):
            errors.append("reduce_copy requires at least one asset with reducible copy")
        if operation == "replace_evidence" and applicable_assets:
            if any(not _evidence_source_candidates(recipe, asset, text) for asset in applicable_assets):
                errors.append("replace_evidence requires a matching alternative evidence source")
        if operation == "change_layout" and applicable_assets:
            requested_layout = _requested_layout(text)
            if requested_layout and all(asset.get("layout_recipe") == requested_layout for asset in applicable_assets):
                errors.append("change_layout must change the current layout")
            if any(asset.get("id") == "wechat-html" for asset in applicable_assets):
                selection = _wechat_layout_selection(recipe)
                selected_theme = selection.get("selected") if isinstance(selection, dict) else None
                try:
                    next_theme = _next_wechat_theme(recipe, text, request.get("wechat_layout"))
                except ValueError as exc:
                    errors.append(str(exc))
                    continue
                if next_theme is None:
                    errors.append("wechat-html layout revision requires multiple md2wechat candidates")
                elif next_theme == selected_theme:
                    current_layout = recipe.get("platforms", {}).get("wechat", {}).get("wechat_layout") or {}
                    requested_layout_options = request.get("wechat_layout") or {}
                    if requested_layout_options.get("refinement") == current_layout.get("refinement"):
                        errors.append("change_layout must change the current md2wechat theme or refinement")
        if operation in {"replace_evidence", "change_layout", "reduce_copy"}:
            if not applicable_assets:
                errors.append(f"{operation} has no applicable target assets")
    return errors


def validate_revision_request(
    recipe: dict[str, Any],
    request: dict[str, Any],
    *,
    allow_legacy_read_only: bool = False,
) -> list[str]:
    """Return validation errors for a bounded revision request.

    Compact requests (without the optional schema/status fields) are accepted so
    the renderer can use the same validator as the request-recording API.
    """
    errors: list[str] = []
    if not isinstance(recipe, dict):
        return ["recipe must be an object"]
    if not isinstance(request, dict):
        return ["revision request must be an object"]

    visual_preferences = recipe.get("visual_preferences")
    if (
        not allow_legacy_read_only
        and isinstance(visual_preferences, dict)
        and visual_preferences.get("mode") != "stable"
    ):
        errors.append("visual revisions require stable visual mode")

    raw_patch_present = any(field in request for field in _RAW_PATCH_FIELDS)
    if raw_patch_present:
        errors.append("raw recipe patches are not allowed")
    for field in request:
        if field not in _REQUEST_FIELDS and field not in _RAW_PATCH_FIELDS:
            errors.append(f"unsupported revision request field: {field}")

    schema = request.get("schema")
    if schema is not None and schema != "aifios.visual-revision-request.v1":
        errors.append("unsupported visual revision request schema")

    base_revision_id = request.get("base_revision_id")
    if not isinstance(base_revision_id, str) or not _REVISION_ID_RE.fullmatch(base_revision_id):
        errors.append("base_revision_id must match rNNN")
    elif base_revision_id != recipe.get("revision_id"):
        errors.append("base_revision_id does not match recipe revision_id")

    text = request.get("request")
    if not isinstance(text, str) or not text.strip():
        errors.append("revision request text is required")
    elif len(text) > 2000:
        errors.append("revision request text exceeds 2000 characters")

    operations = request.get("operations")
    if not isinstance(operations, list) or not operations:
        errors.append("revision operations must be a non-empty list")
    else:
        for operation in operations:
            is_legacy_read_only = (
                allow_legacy_read_only
                and request.get("status") == "review_required"
                and isinstance(operation, str)
                and operation in _LEGACY_READ_ONLY_OPERATIONS
            )
            if not isinstance(operation, str) or (
                operation not in ALLOWED_OPERATIONS and not is_legacy_read_only
            ):
                errors.append(f"unsupported revision operation: {operation}")

    target_asset_ids = request.get("target_asset_ids")
    if target_asset_ids is not None:
        if not isinstance(target_asset_ids, list):
            errors.append("target_asset_ids must be a list")
        else:
            known_asset_ids = _asset_ids(recipe)
            seen: set[str] = set()
            for asset_id in target_asset_ids:
                if not isinstance(asset_id, str) or not asset_id.strip():
                    errors.append("target asset id must be a non-empty string")
                    continue
                if asset_id in seen:
                    errors.append(f"duplicate target asset id: {asset_id}")
                seen.add(asset_id)
                if ".." in Path(asset_id).parts or "/" in asset_id or "\\" in asset_id or not _ASSET_ID_RE.fullmatch(asset_id):
                    errors.append(f"invalid target asset id: {asset_id}")
                if asset_id not in known_asset_ids:
                    errors.append(f"unknown target asset id: {asset_id}")

    if "wechat_layout" in request:
        from wechat_layout_refinement import validate_wechat_layout

        errors.extend(validate_wechat_layout(request["wechat_layout"]))
        if operations != ["change_layout"] or target_asset_ids != ["wechat-html"]:
            errors.append("wechat_layout requires only change_layout targeting wechat-html")

    constraints = request.get("constraints")
    if constraints is not None and (
        not isinstance(constraints, list)
        or any(not isinstance(constraint, str) or not constraint.strip() for constraint in constraints)
    ):
        errors.append("constraints must be a list of non-empty strings")

    status = request.get("status")
    if status is not None and status not in _REQUEST_STATUSES:
        errors.append("unsupported revision request status")

    diagnostic_reason = request.get("diagnostic_reason")
    if diagnostic_reason is not None and (
        not isinstance(diagnostic_reason, str)
        or not diagnostic_reason.strip()
        or len(diagnostic_reason) > 2000
    ):
        errors.append("diagnostic_reason must be a non-empty string of at most 2000 characters")

    rendered_revision_id = request.get("revision_id")
    if rendered_revision_id is not None and (
        not isinstance(rendered_revision_id, str) or not _REVISION_ID_RE.fullmatch(rendered_revision_id)
    ):
        errors.append("revision_id must match rNNN")

    index_path = request.get("index_path")
    if index_path is not None and (
        not isinstance(index_path, str)
        or not index_path.strip()
        or Path(index_path).is_absolute()
        or ".." in Path(index_path).parts
        or "\\" in index_path
    ):
        errors.append("index_path must be a safe project-relative path")

    if status == "blocked" and not isinstance(diagnostic_reason, str):
        errors.append("blocked revision request requires diagnostic_reason")
    if status == "blocked" and (rendered_revision_id is not None or index_path is not None):
        errors.append("blocked revision request must not carry rendered revision fields")
    if status in {"rendered", "review_required"}:
        if not isinstance(rendered_revision_id, str):
            errors.append(f"{status} revision request requires revision_id")
        if not isinstance(index_path, str):
            errors.append(f"{status} revision request requires index_path")
        if diagnostic_reason is not None:
            errors.append(f"{status} revision request must not carry diagnostic_reason")
    if status == "queued" and any(
        value is not None for value in (diagnostic_reason, rendered_revision_id, index_path)
    ):
        errors.append("queued revision request must not carry terminal result fields")

    if not errors:
        errors.extend(_operation_errors(recipe, request))
    return errors


def validate_persisted_revision_request(
    recipe: dict[str, Any],
    request: dict[str, Any],
    *,
    allow_legacy_read_only: bool = False,
) -> list[str]:
    """Validate the complete on-disk request schema used by the consumer."""
    errors = validate_revision_request(
        recipe,
        request,
        allow_legacy_read_only=allow_legacy_read_only,
    )
    if request.get("schema") != "aifios.visual-revision-request.v1":
        errors.append("persisted revision request requires the canonical schema")
    constraints = request.get("constraints")
    if not isinstance(constraints, list) or not constraints:
        errors.append("persisted revision request requires non-empty constraints")
    elif any(len(constraint) > 200 for constraint in constraints if isinstance(constraint, str)):
        errors.append("persisted revision request constraint exceeds 200 characters")
    if request.get("status") not in _REQUEST_STATUSES:
        errors.append("persisted revision request requires a status")
    target_asset_ids = request.get("target_asset_ids")
    if isinstance(target_asset_ids, list):
        if len(target_asset_ids) > 20:
            errors.append("persisted revision request has more than 20 target assets")
        for asset_id in target_asset_ids:
            if isinstance(asset_id, str) and not _PERSISTED_ASSET_ID_RE.fullmatch(asset_id):
                errors.append(f"persisted target asset id does not match the schema: {asset_id}")
    return list(dict.fromkeys(errors))


def _safe_base_recipe_path(project: Path, base_recipe_path: Path) -> tuple[Path, str]:
    raw = Path(base_recipe_path).expanduser()
    if ".." in raw.parts:
        raise ValueError("base recipe path must not contain path traversal")
    candidate = raw if raw.is_absolute() else project / raw
    resolved = candidate.resolve(strict=False)
    if not _is_relative_to(resolved, project):
        raise ValueError("base recipe path must be inside the project")
    if not resolved.is_file():
        raise FileNotFoundError(f"base visual recipe does not exist: {resolved}")

    try:
        relative = resolved.relative_to(project)
    except ValueError as exc:  # pragma: no cover - guarded above
        raise ValueError("base recipe path must be inside the project") from exc
    parts = relative.parts
    if len(parts) != 5 or parts[:2] != ("pipeline", "visual") or parts[3] != "recipes":
        raise ValueError("base recipe must be in pipeline/visual/{slug}/recipes")
    slug = parts[2]
    if not _SAFE_SLUG_RE.fullmatch(slug) or slug in {".", ".."}:
        raise ValueError("base recipe has an unsafe slug directory")
    if not _RECIPE_FILE_RE.fullmatch(parts[4]):
        raise ValueError("base recipe filename must be rNNN.visual-recipe.json")
    return resolved, slug


def _load_base_recipe(path: Path, expected_slug: str) -> tuple[dict[str, Any], str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"base visual recipe is not valid JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError("base visual recipe must be an object")

    filename_match = _RECIPE_FILE_RE.fullmatch(path.name)
    if filename_match is None:  # pragma: no cover - guarded by _safe_base_recipe_path
        raise ValueError("base recipe filename must be rNNN.visual-recipe.json")
    revision_id = filename_match.group(1)
    if payload.get("revision_id") != revision_id:
        raise ValueError("base recipe revision_id does not match its filename")
    if payload.get("slug") != expected_slug:
        raise ValueError("base recipe slug does not match its directory")

    platforms = payload.get("platforms")
    if (
        not isinstance(platforms, dict)
        or not platforms
        or any(not isinstance(platform, dict) for platform in platforms.values())
    ):
        raise ValueError("base visual recipe must define its selected platforms as objects")
    if "xhs" in platforms and not isinstance(platforms["xhs"].get("page_recipes"), list):
        raise ValueError("base visual recipe xhs page_recipes must be a list")

    recipe_errors = validate_visual_recipe(payload)
    if recipe_errors:
        raise ValueError("invalid base visual recipe: " + "; ".join(recipe_errors))
    return payload, revision_id


def _set_system(recipe: dict[str, Any], system: str) -> None:
    platforms = recipe["platforms"]
    wechat = platforms.get("wechat")
    xhs = platforms.get("xhs")
    moments = platforms.get("moments") if isinstance(platforms.get("moments"), dict) else None
    layouts = list(_SYSTEM_LAYOUTS[system])
    if isinstance(wechat, dict):
        wechat["system"] = system
    if isinstance(xhs, dict):
        xhs["system"] = system
        xhs["page_recipes"] = layouts
    if moments is not None:
        moments["system"] = system
    if isinstance(wechat, dict) and "cover_recipe" in wechat:
        wechat["cover_recipe"] = layouts[0]

    page_layouts = {index + 1: layout for index, layout in enumerate(layouts)}
    for asset in recipe.get("assets", []):
        if not isinstance(asset, dict):
            continue
        asset_id = str(asset.get("id") or "")
        page_match = re.fullmatch(r"xhs-\d+-p([1-5])", asset_id)
        if page_match:
            asset["layout_recipe"] = page_layouts[int(page_match.group(1))]
        elif (moments_match := re.fullmatch(r"moments-\d+-p([135])", asset_id)):
            asset["layout_recipe"] = page_layouts[int(moments_match.group(1))]
        elif asset_id in {"wechat-cover", "wechat-share", "wechat-cover-alt-01", "wechat-share-alt-01"}:
            asset["layout_recipe"] = layouts[0]


def _requested_layout(text: str) -> str | None:
    match = _LAYOUT_CODE_RE.search(text.upper())
    return match.group(1).upper() if match else None


def _wechat_layout_selection(recipe: dict[str, Any]) -> dict[str, Any] | None:
    platforms = recipe.get("platforms")
    wechat = platforms.get("wechat") if isinstance(platforms, dict) else None
    selection = wechat.get("layout_selection") if isinstance(wechat, dict) else None
    return selection if isinstance(selection, dict) else None


def _wechat_theme_candidates(recipe: dict[str, Any]) -> list[str]:
    selection = _wechat_layout_selection(recipe)
    candidates = selection.get("candidates") if isinstance(selection, dict) else None
    if not isinstance(candidates, list):
        return []
    return list(dict.fromkeys(
        candidate
        for candidate in candidates
        if isinstance(candidate, str) and _MD2WECHAT_THEME_RE.fullmatch(candidate)
    ))


def _requested_wechat_theme(text: str, candidates: list[str]) -> str | None:
    normalized = text.lower()
    found: set[str] = set()
    for candidate in candidates:
        if re.search(
            rf"(?<![a-z0-9_-]){re.escape(candidate.lower())}(?![a-z0-9_-])",
            normalized,
        ):
            found.add(candidate)
    # An explicit id outside the old recipe's shortlist must never fall through
    # into generic rotation. Only theme-shaped ids/context are considered;
    # unrelated English words in a writing request are not theme choices.
    found.update(re.findall(r"(?<![a-z0-9_-])([a-z0-9]+(?:[-_][a-z0-9]+)+)(?![a-z0-9_-])", normalized))
    found.update(re.findall(
        r"(?:主题|样式|\btheme\b)\s*(?:(?:改为|换为|改成|换成|设为|为|成|to)\s*)?[:：=]?\s*[`\"']?([a-z0-9][a-z0-9_-]{0,63})(?![a-z0-9_-])",
        normalized,
    ))
    found.difference_update({"wechat-html", "title-spacing-v1"})
    if len(found) > 1:
        raise ValueError("公众号排版请求包含多个主题，请明确选择一个主题。")
    return next(iter(found), None)


def _next_wechat_theme(recipe: dict[str, Any], request_text: str, layout: dict[str, Any] | None = None) -> str | None:
    selection = _wechat_layout_selection(recipe)
    candidates = _wechat_theme_candidates(recipe)
    if selection is None or not candidates:
        return None
    selected = selection.get("selected")
    requested = _requested_wechat_theme(request_text, candidates)
    if layout is not None:
        explicit = layout.get("theme")
        if requested is not None and explicit != requested:
            raise ValueError("公众号排版说明与指定主题不一致。")
        return explicit
    if requested is not None:
        return requested
    if selected in candidates and len(candidates) > 1:
        return candidates[(candidates.index(selected) + 1) % len(candidates)]
    return candidates[0] if candidates and candidates[0] != selected else None


def _available_md2wechat_themes() -> set[str]:
    """Read the installed CLI's catalog, without conversion or API calls."""
    binary = str(os.environ.get("MD2WECHAT_BINARY") or "").strip() or shutil.which("md2wechat")
    if not binary:
        raise ValueError("无法读取 md2wechat 主题目录，请先检查排版工具。")
    try:
        result = subprocess.run(
            [binary, "themes", "list", "--json"], capture_output=True,
            text=True, timeout=8, check=False,
        )
        if result.returncode != 0 or len(result.stdout) > 2 * 1024 * 1024:
            raise ValueError("invalid theme catalog response")
        payload = json.loads(result.stdout)
        themes = payload.get("data", {}).get("themes")
        if payload.get("success") is not True or not isinstance(themes, list) or len(themes) > 1000:
            raise ValueError("invalid theme catalog")
        available = {
            item["name"] for item in themes
            if isinstance(item, dict) and item.get("type") == "api"
            and item.get("selectable") is True
            and isinstance(item.get("name"), str) and _MD2WECHAT_THEME_RE.fullmatch(item["name"])
        }
        if not available:
            raise ValueError("empty API theme catalog")
        return available
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError) as exc:
        raise ValueError("无法读取可用的 md2wechat 主题目录，请检查排版工具后重试。") from exc


def _verify_wechat_layout_request(project: Path, recipe: dict[str, Any], request: dict[str, Any]) -> None:
    if "change_layout" not in request.get("operations", []):
        return
    articles = [asset for asset in _assets_for_operation(recipe, request, "change_layout") if asset.get("id") == "wechat-html"]
    if not articles:
        return
    layout = request.get("wechat_layout")
    explicit = _requested_wechat_theme(str(request.get("request") or ""), _wechat_theme_candidates(recipe))
    if layout is not None or explicit is not None:
        theme = _next_wechat_theme(recipe, str(request.get("request") or ""), layout)
        if theme not in _available_md2wechat_themes():
            raise ValueError("所选 md2wechat 主题不存在或不可用，请重新选择。")
    if layout is not None:
        from visual_publish import parse_package_body
        from wechat_layout_refinement import validate_refinement_source

        package = _project_relative_file(project, recipe.get("source_package"), "visual recipe source_package")
        content = package.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest != layout["source_package_sha256"]:
            raise ValueError("正文内容包已变化，请重新确认排版参数。")
        parsed = parse_package_body(content.decode("utf-8"))
        article = parsed.get("wechat") or {}
        errors = validate_refinement_source(str(article.get("title") or parsed.get("title") or ""), str(article.get("body") or ""), layout, digest)
        if errors:
            raise ValueError("公众号排版参数与原稿不一致：" + "; ".join(errors))


def _next_layout(current: str, system: str) -> str:
    candidates = _SYSTEM_LAYOUTS.get(system) or _SYSTEM_LAYOUTS["swiss"]
    try:
        return candidates[(candidates.index(current) + 1) % len(candidates)]
    except ValueError:
        return candidates[0]


def _sync_layout_references(recipe: dict[str, Any]) -> None:
    xhs_layouts: dict[int, str] = {}
    for asset in recipe.get("assets", []):
        if not isinstance(asset, dict):
            continue
        match = re.fullmatch(r"xhs-\d+-p([1-5])", str(asset.get("id") or ""))
        if match and isinstance(asset.get("layout_recipe"), str):
            xhs_layouts[int(match.group(1))] = asset["layout_recipe"]
    platforms = recipe.get("platforms")
    if not isinstance(platforms, dict):
        return
    xhs = platforms.get("xhs")
    if isinstance(xhs, dict) and len(xhs_layouts) == 5:
        xhs["page_recipes"] = [xhs_layouts[index] for index in range(1, 6)]
    wechat = platforms.get("wechat")
    if isinstance(wechat, dict):
        cover = next(
            (
                asset.get("layout_recipe")
                for asset in recipe.get("assets", [])
                if isinstance(asset, dict) and asset.get("id") == "wechat-cover"
            ),
            None,
        )
        if isinstance(cover, str):
            wechat["cover_recipe"] = cover


def _shorten_copy(value: str) -> str:
    text = value.strip()
    if len(text) <= 24:
        return text
    sentence = re.split(r"(?<=[。！？.!?])\s*", text, maxsplit=1)[0].strip()
    if sentence and len(sentence) < len(text):
        return sentence[:80].rstrip()
    return text[:24].rstrip() + "..."


def _asset_has_reducible_copy(asset: dict[str, Any]) -> bool:
    copy_block = asset.get("copy")
    if not isinstance(copy_block, dict):
        return False
    return any(
        isinstance(value, str) and _shorten_copy(value) != value.strip()
        for value in (copy_block.get("headline"), copy_block.get("supporting"))
    )


def _select_evidence_source(recipe: dict[str, Any], asset: dict[str, Any], request_text: str) -> str:
    candidates = _evidence_source_candidates(recipe, asset, request_text)
    if not candidates:
        raise ValueError("replace_evidence requires a matching alternative evidence source")
    return candidates[0]


def _apply_operations(recipe: dict[str, Any], request: dict[str, Any]) -> None:
    operations = request["operations"]
    text = str(request["request"]).strip()
    for operation in operations:
        if operation == "change_system":
            system = _requested_system(text)
            if system is None:  # pragma: no cover - validator prevents this
                raise ValueError("change_system request must name swiss, editorial, or hybrid")
            _set_system(recipe, system)
        elif operation == "replace_evidence":
            for asset in _assets_for_operation(recipe, request, operation):
                asset["source"] = _select_evidence_source(recipe, asset, text)
                asset["role"] = "evidence"
                asset["status"] = "planned"
        elif operation == "change_layout":
            requested_layout = _requested_layout(text)
            system = str(recipe.get("platforms", {}).get("xhs", {}).get("system") or "swiss")
            applicable_assets = _assets_for_operation(recipe, request, operation)
            wechat_articles = [asset for asset in applicable_assets if asset.get("id") == "wechat-html"]
            if wechat_articles:
                layout_selection = _wechat_layout_selection(recipe)
                selected_theme = _next_wechat_theme(recipe, text, request.get("wechat_layout"))
                if layout_selection is None or selected_theme is None:  # pragma: no cover - validated
                    raise ValueError("wechat-html layout revision requires multiple md2wechat candidates")
                layout_selection["selected"] = selected_theme
                layout_selection["candidates"] = list(dict.fromkeys([*layout_selection["candidates"], selected_theme]))
                layout_selection["reason"] = f"根据修订请求采用 md2wechat 主题 {selected_theme}"
                if "wechat_layout" in request:
                    recipe["platforms"]["wechat"]["wechat_layout"] = copy.deepcopy(request["wechat_layout"])
                elif "wechat_layout" in recipe["platforms"]["wechat"]:
                    # Carry article-bound refinements forward when only the theme
                    # changes, so the recorded theme cannot disagree with output.
                    recipe["platforms"]["wechat"]["wechat_layout"]["theme"] = selected_theme
                for asset in wechat_articles:
                    asset["layout_style"] = selected_theme
            for asset in applicable_assets:
                if asset.get("id") == "wechat-html":
                    continue
                current = str(asset.get("layout_recipe") or "")
                asset["layout_recipe"] = requested_layout or _next_layout(current, system)
            _sync_layout_references(recipe)
        elif operation == "reduce_copy":
            for asset in _assets_for_operation(recipe, request, operation):
                copy_block = asset.get("copy")
                if not isinstance(copy_block, dict):
                    continue
                for key in ("headline", "supporting"):
                    value = copy_block.get(key)
                    if isinstance(value, str):
                        copy_block[key] = _shorten_copy(value)


def create_recipe_revision(project: Path, base_recipe_path: Path, request: dict[str, Any]) -> dict[str, Any]:
    """Build the next recipe candidate without persisting it.

    The base recipe path is checked against the canonical Visual Director layout
    before it is read. Only ``consume_revision_request`` may persist the returned
    candidate after renderer and quality-gate success.
    """
    project_root = Path(project).expanduser().resolve(strict=False)
    base_path, directory_slug = _safe_base_recipe_path(project_root, Path(base_recipe_path))
    base_recipe, base_revision_id = _load_base_recipe(base_path, directory_slug)

    errors = validate_revision_request(base_recipe, request)
    if errors:
        raise ValueError("invalid visual revision request: " + "; ".join(errors))
    if request.get("status") not in {None, "queued"}:
        raise ValueError("only queued revision requests can create a recipe revision")

    _verify_wechat_layout_request(project_root, base_recipe, request)

    revised = copy.deepcopy(base_recipe)
    _apply_operations(revised, request)
    if revised == base_recipe:
        raise ValueError("revision operations produced no renderer-consumable semantic diff")
    revised["parent_revision_id"] = base_revision_id
    revised["created_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    recipe_dir = project_root / "pipeline" / "visual" / directory_slug / "recipes"
    revised["revision_id"] = next_recipe_id(recipe_dir.glob("*.visual-recipe.json"))
    final_errors = validate_visual_recipe(revised)
    if final_errors:
        raise ValueError("invalid revised visual recipe: " + "; ".join(final_errors))
    return revised


def _assert_no_symlink_components(path: Path, label: str) -> None:
    current = path
    while current != current.parent:
        try:
            if stat_module.S_ISLNK(os.lstat(current).st_mode):
                raise ValueError(f"{label} contains a symlinked directory")
        except FileNotFoundError:
            pass
        current = current.parent


def _read_json_object(path: Path, label: str) -> dict[str, Any]:
    _assert_no_symlink_components(path.parent, label)
    if path.is_symlink():
        raise ValueError(f"{label} cannot be a symlink")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"{label} does not exist") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _assert_no_symlink_components(path.parent, "atomic JSON destination")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory_fd = os.open(path.parent, directory_flags)
    temporary_name = f".{path.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp"
    file_fd: int | None = None
    try:
        try:
            destination_stat = os.stat(path.name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            destination_stat = None
        if destination_stat is not None and stat_module.S_ISLNK(destination_stat.st_mode):
            raise ValueError("atomic JSON destination cannot be a symlink")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        file_fd = os.open(temporary_name, flags, 0o600, dir_fd=directory_fd)
        with os.fdopen(file_fd, "w", encoding="utf-8") as handle:
            file_fd = None
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(
            temporary_name,
            path.name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
    finally:
        if file_fd is not None:
            os.close(file_fd)
        try:
            os.unlink(temporary_name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        os.close(directory_fd)


def _project_relative_file(project: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} is required")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts or "\x00" in value:
        raise ValueError(f"{label} must be a safe project-relative path")
    resolved = (project / relative).resolve(strict=False)
    if not _is_relative_to(resolved, project) or not resolved.is_file():
        raise ValueError(f"{label} must resolve to an existing file inside the project")
    return resolved


def _load_verified_base_revision(
    project: Path,
    slug: str,
    revision_id: str,
) -> tuple[Path, dict[str, Any]]:
    """Load the exact request-bound revision after checking its real outputs."""
    if not _CONSUMER_SLUG_RE.fullmatch(slug) or not _REVISION_ID_RE.fullmatch(revision_id):
        raise ValueError("base visual revision slug or revision_id is invalid")

    recipe_relative = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
    raw_recipe_path = project / recipe_relative
    _assert_no_symlink_components(raw_recipe_path.parent, "base visual recipe")
    if raw_recipe_path.is_symlink():
        raise ValueError("base visual recipe cannot be a symlink")
    recipe_path, directory_slug = _safe_base_recipe_path(project, raw_recipe_path)
    if directory_slug != slug:
        raise ValueError("base visual recipe slug does not match the request")
    recipe, loaded_revision_id = _load_base_recipe(recipe_path, slug)
    if loaded_revision_id != revision_id:
        raise ValueError("base visual recipe revision does not match the request")

    index_relative = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
    index_path = project / index_relative
    index = _read_json_object(index_path, "base visual revision index")
    metadata_errors: list[str] = []
    if index.get("schema") != "aifios.visual-publish.v1":
        metadata_errors.append("index has an unsupported schema")
    if index.get("legacy") is not False:
        metadata_errors.append("index must declare legacy=false")
    if index.get("renderer") not in (None, "local"):
        metadata_errors.append("index renderer must be local")
    if index.get("revision_index_path") != index_relative:
        metadata_errors.append("index revision_index_path is not canonical")
    if index.get("errors") not in (None, []):
        metadata_errors.append("index contains renderer errors")
    gate_error = _quality_gate_error(
        index,
        slug,
        revision_id,
        recipe_relative,
        project,
    )
    if gate_error:
        metadata_errors.append(gate_error)
    if metadata_errors:
        raise ValueError(
            "base visual revision failed provenance and quality verification: "
            + "; ".join(metadata_errors)
        )

    # This read-only builder verifies exact recipe asset coverage plus each
    # output's declared size and SHA-256 against its current on-disk bytes.
    from visual_release import build_visual_selection_manifest

    try:
        build_visual_selection_manifest(project, slug, revision_id)
    except ValueError as exc:
        raise ValueError(
            f"base visual revision failed output integrity verification: {exc}"
        ) from exc

    from minimal_loop_acceptance import check_recipe_visual_release

    quality_gate = check_recipe_visual_release(project, index)
    if quality_gate.get("status") != "pass":
        details = [
            str(item).strip()
            for field in ("errors", "review_issues")
            for item in quality_gate.get(field, [])
            if str(item).strip()
        ]
        raise ValueError(
            "base visual revision did not pass the complete visual quality gate"
            + (f": {'; '.join(details)}" if details else "")
        )
    return recipe_path, recipe


def _request_record_path(project: Path, slug: str, request_id: str) -> Path:
    if not _CONSUMER_SLUG_RE.fullmatch(slug):
        raise ValueError("revision slug is invalid")
    if not _REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("revision request id is invalid")
    path = project / "pipeline" / "visual" / slug / "revisions" / f"{request_id}.json"
    resolved = path.resolve(strict=False)
    if not _is_relative_to(resolved, project):
        raise ValueError("revision request id resolves outside the project")
    return resolved


def _diagnostic_reason(project: Path, error: BaseException) -> str:
    reason = str(error).strip() or error.__class__.__name__
    return reason.replace(str(project), "<project>")[:2000]


def _mark_request_blocked(project: Path, path: Path, record: dict[str, Any], error: BaseException) -> dict[str, Any]:
    reason = _diagnostic_reason(project, error)
    blocked = {
        **record,
        "status": "blocked",
        "diagnostic_reason": reason,
    }
    blocked.pop("revision_id", None)
    blocked.pop("index_path", None)
    _write_json_atomic(path, blocked)
    return {
        "status": "blocked",
        "reason": reason,
        "request_path": str(path.relative_to(project)),
    }


def _revision_output_path(
    project: Path,
    slug: str,
    revision_id: str,
    value: Any,
) -> Path | None:
    if not isinstance(value, str) or not value.strip() or "\\" in value or "\x00" in value:
        return None
    segments = value.split("/")
    expected_root = ["pipeline", "visual", slug, "publish", revision_id]
    if (
        len(segments) <= len(expected_root)
        or segments[: len(expected_root)] != expected_root
        or any(not segment or segment in {".", ".."} for segment in segments)
    ):
        return None
    resolved = (project / Path(*segments)).resolve(strict=False)
    output_root = (project / Path(*expected_root)).resolve(strict=False)
    if not _is_relative_to(resolved, output_root) or resolved == output_root:
        return None
    return resolved


def _quality_gate_error(
    index: dict[str, Any],
    slug: str,
    revision_id: str,
    expected_recipe_path: str | None = None,
    project: Path | None = None,
    accepted_statuses: frozenset[str] = frozenset({"pass"}),
) -> str | None:
    summary = index.get("quality_summary")
    if index.get("slug") != slug or index.get("revision_id") != revision_id:
        return "renderer index does not match the requested visual revision"
    if index.get("status") != "generated":
        return f"renderer index status is {index.get('status') or 'missing'}"
    if not isinstance(summary, dict):
        return "renderer index is missing quality_summary"
    if summary.get("status") not in accepted_statuses:
        for field in ("errors", "blocking_issues", "review_issues"):
            values = summary.get(field)
            if isinstance(values, list):
                reason = next((str(value).strip() for value in values if str(value).strip()), "")
                if reason:
                    return reason
        return f"visual quality gate status is {summary.get('status') or 'missing'}"
    outputs = index.get("outputs")
    if (
        not isinstance(outputs, list)
        or not outputs
        or any(not isinstance(output, dict) or output.get("renderer") != "local" for output in outputs)
    ):
        return "rendered visual index must contain only real local renderer outputs"
    if expected_recipe_path is not None and (
        index.get("recipe_path") != expected_recipe_path
        or any(output.get("recipe_path") != expected_recipe_path for output in outputs)
    ):
        return "rendered visual index has stale recipe provenance"
    if project is not None:
        for output in outputs:
            value = output.get("output")
            if not isinstance(value, str) or not value.strip():
                return "rendered visual index has an empty output path"
            resolved = _revision_output_path(project, slug, revision_id, value)
            if resolved is None:
                return "rendered visual index output is outside the expected revision output root"
            if not resolved.is_file() or resolved.stat().st_size <= 0:
                return f"rendered visual output is missing or empty: {value}"
    return None


def _rewrite_index_recipe_path(path: Path, slug: str, revision_id: str, recipe_path: str) -> None:
    if not path.is_file():
        return
    index = _read_json_object(path, "rendered visual revision index")
    if index.get("slug") == slug and index.get("revision_id") == revision_id:
        index["recipe_path"] = recipe_path
        for output in index.get("outputs", []):
            if isinstance(output, dict):
                output["recipe_path"] = recipe_path
        _write_json_atomic(path, index)


def _cleanup_candidate_state(project: Path, slug: str, revision_id: str) -> None:
    visual_root = project / "pipeline" / "visual" / slug
    (visual_root / "recipes" / f"{revision_id}.visual-recipe.json").unlink(missing_ok=True)
    (visual_root / "revisions" / f"{revision_id}.index.json").unlink(missing_ok=True)
    shutil.rmtree(visual_root / "publish" / revision_id, ignore_errors=True)
    shutil.rmtree(visual_root / "publish" / "render" / revision_id, ignore_errors=True)


def _transaction_paths(project: Path, slug: str, request_id: str) -> tuple[Path, Path]:
    revisions = project / "pipeline" / "visual" / slug / "revisions"
    # Keep deleting the former index-backup file when recovering transactions
    # created before revision rendering became fully isolated.
    return (
        revisions / f".{request_id}.visual-revision-transaction.json",
        revisions / f".{request_id}.publish-index.before",
    )


def _remove_transaction_files(
    project: Path,
    slug: str,
    request_id: str,
    revision_id: str,
) -> None:
    marker_path, legacy_index_backup_path = _transaction_paths(project, slug, request_id)
    marker_path.unlink(missing_ok=True)
    legacy_index_backup_path.unlink(missing_ok=True)
    revisions = marker_path.parent
    for pending in revisions.glob(f".{revision_id}.{request_id}.visual-recipe.pending.json*"):
        pending.unlink(missing_ok=True)
    recipes = project / "pipeline" / "visual" / slug / "recipes"
    for temporary in recipes.glob(f".{revision_id}.{request_id}.tmp*"):
        temporary.unlink(missing_ok=True)


def _recover_incomplete_transactions(project: Path, slug: str, current_request_id: str) -> None:
    revisions = project / "pipeline" / "visual" / slug / "revisions"
    if not revisions.is_dir():
        return
    for marker_path in sorted(revisions.glob(".*.visual-revision-transaction.json")):
        try:
            marker = _read_json_object(marker_path, "visual revision transaction marker")
            request_id = str(marker.get("request_id") or "")
            revision_id = str(marker.get("revision_id") or "")
            if (
                marker.get("schema") != "aifios.visual-revision-transaction.v1"
                or marker.get("slug") != slug
                or not _REQUEST_ID_RE.fullmatch(request_id)
                or not _REVISION_ID_RE.fullmatch(revision_id)
                or marker_path.name != f".{request_id}.visual-revision-transaction.json"
            ):
                continue
            request_path = revisions / f"{request_id}.json"
            request = _read_json_object(request_path, "visual revision request")
            if request.get("status") in {"rendered", "review_required"}:
                try:
                    _validate_terminal_request(project, slug, request_path, request)
                except (FileNotFoundError, ValueError):
                    pass
                else:
                    _remove_transaction_files(project, slug, request_id, revision_id)
                    continue
            base_revision_id = request.get("base_revision_id")
            marker_base_revision_id = marker.get("base_revision_id")
            unsafe_marker = (
                not isinstance(base_revision_id, str)
                or not _REVISION_ID_RE.fullmatch(base_revision_id)
                or marker_base_revision_id != base_revision_id
                or revision_id == base_revision_id
            )
            reason = (
                "rejected an untrusted visual revision transaction marker"
                if unsafe_marker
                else "recovered incomplete visual revision transaction without deleting persisted revision assets"
            )
            _mark_request_blocked(project, request_path, request, RuntimeError(reason))
            _remove_transaction_files(project, slug, request_id, revision_id)
        except (FileNotFoundError, ValueError):
            marker_path.unlink(missing_ok=True)


def _validate_terminal_request(
    project: Path,
    slug: str,
    request_path: Path,
    request: dict[str, Any],
) -> dict[str, Any]:
    status = str(request.get("status") or "")
    base_revision_id = request.get("base_revision_id")
    if not isinstance(base_revision_id, str) or not _REVISION_ID_RE.fullmatch(base_revision_id):
        raise ValueError(f"invalid terminal {status} revision request: invalid base_revision_id")
    if not request_path.name.startswith(f"{base_revision_id}-request"):
        raise ValueError(f"invalid terminal {status} revision request: request path does not match base revision")
    base_path = project / "pipeline" / "visual" / slug / "recipes" / f"{base_revision_id}.visual-recipe.json"
    base_recipe, _ = _load_base_recipe(base_path, slug)
    errors = validate_persisted_revision_request(
        base_recipe,
        request,
        allow_legacy_read_only=status == "review_required",
    )
    if errors:
        raise ValueError(f"invalid terminal {status} revision request: " + "; ".join(errors))
    request_relative = str(request_path.relative_to(project))
    if status == "blocked":
        return {
            "status": "blocked",
            "reason": str(request["diagnostic_reason"]),
            "request_path": request_relative,
        }

    revision_id = str(request.get("revision_id") or "")
    try:
        recipe_path = project / "pipeline" / "visual" / slug / "recipes" / f"{revision_id}.visual-recipe.json"
        revised_recipe, _ = _load_base_recipe(recipe_path, slug)
        if revised_recipe.get("parent_revision_id") != base_revision_id:
            raise ValueError("recipe parent does not match base")
        index_relative = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
        if request.get("index_path") != index_relative:
            raise ValueError("index path is not server-resolved")
        index = _read_json_object(project / index_relative, "terminal rendered visual index")
        recipe_relative = str(recipe_path.relative_to(project))
        if status == "review_required":
            gate_error = _quality_gate_error(
                index,
                slug,
                revision_id,
                recipe_relative,
                project,
                frozenset({"pass", "review_required"}),
            )
        else:
            gate_error = _quality_gate_error(index, slug, revision_id, recipe_relative, project)
        if gate_error:
            raise ValueError(gate_error)
    except (FileNotFoundError, ValueError) as exc:
        raise ValueError(f"invalid terminal {status} revision request: {exc}") from exc
    result = {
        "status": status,
        "revision_id": revision_id,
        "index_path": index_relative,
        "request_path": request_relative,
    }
    if status == "review_required":
        result["read_only"] = True
    return result


def consume_revision_request(project: Path | str, slug: str, request_id: str) -> dict[str, Any]:
    """Consume a queued request through the real local renderer and quality gate.

    The candidate recipe is staged outside ``recipes/``. It is promoted into the
    immutable recipe lineage only after stable local rendering passes every gate.
    Historical review-required records remain readable but cannot be resumed.
    """
    project_root = Path(project).expanduser().resolve(strict=False)
    request_path = _request_record_path(project_root, slug, request_id)
    request_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = request_path.parent / ".visual-revision-consumer.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return _consume_revision_request_locked(project_root, slug, request_id)


def _consume_revision_request_locked(project_root: Path, slug: str, request_id: str) -> dict[str, Any]:
    _recover_incomplete_transactions(project_root, slug, request_id)
    request_path = _request_record_path(project_root, slug, request_id)
    request = _read_json_object(request_path, "visual revision request")

    if request.get("status") in {"rendered", "review_required", "blocked"}:
        return _validate_terminal_request(project_root, slug, request_path, request)

    staged_path: Path | None = None
    revision_id: str | None = None
    candidate_committed = False
    final_recipe_path: Path | None = None
    recipe_temporary_path: Path | None = None
    transaction_marker_path: Path | None = None
    legacy_index_backup_path: Path | None = None
    transaction: dict[str, Any] | None = None
    try:
        base_revision_id = request.get("base_revision_id")
        if not isinstance(base_revision_id, str) or not _REVISION_ID_RE.fullmatch(base_revision_id):
            raise ValueError("revision request base_revision_id must match rNNN")
        if not request_path.name.startswith(f"{base_revision_id}-request"):
            raise ValueError("revision request path does not match base revision")
        base_path, base_recipe = _load_verified_base_revision(
            project_root,
            slug,
            base_revision_id,
        )
        errors = validate_persisted_revision_request(base_recipe, request)
        if errors:
            raise ValueError("invalid visual revision request: " + "; ".join(errors))
        if request.get("status") != "queued":
            raise ValueError("only queued visual revision requests can be consumed")

        recipe_dir = base_path.parent
        revised = create_recipe_revision(project_root, base_path, request)
        revision_id = str(revised["revision_id"])

        revisions_dir = project_root / "pipeline" / "visual" / slug / "revisions"
        transaction_marker_path, legacy_index_backup_path = _transaction_paths(project_root, slug, request_id)
        legacy_index_backup_path.unlink(missing_ok=True)
        transaction = {
            "schema": "aifios.visual-revision-transaction.v1",
            "slug": slug,
            "request_id": request_id,
            "base_revision_id": base_revision_id,
            "revision_id": revision_id,
            "phase": "rendering",
            "publish_current_index": False,
        }
        _write_json_atomic(transaction_marker_path, transaction)
        _cleanup_candidate_state(project_root, slug, revision_id)
        staged_path = revisions_dir / f".{revision_id}.{request_id}.visual-recipe.pending.json"
        _write_json_atomic(staged_path, revised)
        package_path = _project_relative_file(project_root, revised.get("source_package"), "visual recipe source_package")

        from visual_publish import LEGACY_MD2WECHAT_THEME_ALIASES, generate_publish_outputs

        generate_publish_outputs(
            project_root,
            slug,
            package_path=package_path,
            recipe_path=staged_path,
            renderer="local",
            write_runtime_record=False,
            publish_current_index=False,
        )

        revision_index_path = revisions_dir / f"{revision_id}.index.json"
        revision_index = _read_json_object(revision_index_path, "rendered visual revision index")
        # A request to change the article theme must actually apply that theme.
        # The first layout may fall back to the bundled basic style; a theme
        # revision cannot silently turn that same fallback into a successful change.
        targets = request.get("target_asset_ids") or []
        if "change_layout" in request.get("operations", []) and (not targets or "wechat-html" in targets):
            article = next((asset for asset in revised.get("assets", []) if asset.get("id") == "wechat-html"), None)
            if article and article.get("renderer") == "md2wechat":
                rendered = next((output for output in revision_index.get("outputs", []) if output.get("id") == "wechat-html"), {})
                expected_theme = LEGACY_MD2WECHAT_THEME_ALIASES.get(article.get("layout_style"), article.get("layout_style"))
                if rendered.get("layout_fallback_reason") or rendered.get("renderer_theme") != expected_theme:
                    raise ValueError("所选排版样式未应用，已保留原成品。请检查排版服务后重试。")
                layout = revised.get("platforms", {}).get("wechat", {}).get("wechat_layout") or {}
                refinement = layout.get("refinement")
                if refinement is not None and (
                    rendered.get("local_refinements") != refinement
                    or rendered.get("base_renderer") != "md2wechat-cli"
                    or rendered.get("base_theme") != expected_theme
                    or rendered.get("output_is_raw_api_result") is not False
                    or not isinstance(rendered.get("raw_html_sha256"), str)
                    or re.fullmatch(r"[a-f0-9]{64}", rendered["raw_html_sha256"]) is None
                ):
                    raise ValueError("标题和间距调整未完整应用，已保留原成品。请重新排版后再确认。")
        staged_recipe_relative = str(staged_path.relative_to(project_root))
        gate_error = _quality_gate_error(
            revision_index,
            slug,
            revision_id,
            staged_recipe_relative,
            project_root,
        )
        if gate_error is None and any(
            isinstance(output, dict) and output.get("ai_generated") is True
            for output in revision_index.get("outputs", [])
        ):
            gate_error = "stable visual revision must not contain AI-generated outputs"
        if gate_error:
            raise ValueError(gate_error)
        transaction["phase"] = "rendered"
        _write_json_atomic(transaction_marker_path, transaction)

        final_recipe_path = recipe_dir / f"{revision_id}.visual-recipe.json"
        final_recipe_relative = str(final_recipe_path.relative_to(project_root))
        _rewrite_index_recipe_path(revision_index_path, slug, revision_id, final_recipe_relative)
        if final_recipe_path.exists():
            raise ValueError(f"visual recipe revision already exists: {revision_id}")
        recipe_temporary_path = recipe_dir / f".{revision_id}.{request_id}.tmp"
        with recipe_temporary_path.open("x", encoding="utf-8") as handle:
            json.dump(revised, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        transaction["phase"] = "promoting"
        _write_json_atomic(transaction_marker_path, transaction)
        os.replace(recipe_temporary_path, final_recipe_path)
        recipe_temporary_path = None
        candidate_committed = True
        transaction["phase"] = "recipe_promoted"
        _write_json_atomic(transaction_marker_path, transaction)

        index_relative = str(revision_index_path.relative_to(project_root))
        rendered_request = {
            **request,
            "status": "rendered",
            "revision_id": revision_id,
            "index_path": index_relative,
        }
        rendered_request.pop("diagnostic_reason", None)
        _write_json_atomic(request_path, rendered_request)
        transaction["phase"] = "committed"
        _write_json_atomic(transaction_marker_path, transaction)
        _validate_terminal_request(project_root, slug, request_path, rendered_request)
        staged_path.unlink(missing_ok=True)
        staged_path = None
        _remove_transaction_files(project_root, slug, request_id, revision_id)
        transaction_marker_path = None
        legacy_index_backup_path = None
        return {
            "status": "rendered",
            "revision_id": revision_id,
            "index_path": index_relative,
            "request_path": str(request_path.relative_to(project_root)),
        }
    except Exception as exc:
        if candidate_committed and final_recipe_path is not None:
            final_recipe_path.unlink(missing_ok=True)
            candidate_committed = False
        return _mark_request_blocked(project_root, request_path, request, exc)
    finally:
        if revision_id is not None and not candidate_committed:
            _cleanup_candidate_state(project_root, slug, revision_id)
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)
        if recipe_temporary_path is not None:
            recipe_temporary_path.unlink(missing_ok=True)
        if transaction_marker_path is not None:
            transaction_marker_path.unlink(missing_ok=True)
        if legacy_index_backup_path is not None:
            legacy_index_backup_path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Consume constrained AIFIOS visual revision requests")
    parser.add_argument("--project", required=True)
    subparsers = parser.add_subparsers(dest="command", required=True)
    consume = subparsers.add_parser("consume")
    consume.add_argument("--slug", required=True)
    consume.add_argument("--request-id", required=True)
    args = parser.parse_args(argv)

    try:
        if args.command == "consume":
            result = consume_revision_request(args.project, args.slug, args.request_id)
        else:  # pragma: no cover - argparse guards this
            return 2
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

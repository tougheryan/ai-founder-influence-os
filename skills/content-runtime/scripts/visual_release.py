#!/usr/bin/env python3
"""Resolve and integrity-check the explicitly adopted Visual Director release."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


REVISION_ID_RE = re.compile(r"r\d{3,}")
SAFE_SLUG_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff-]{1,80}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
SELECTION_SCHEMA = "aifios.visual-selection.v1"
ASSET_SELECTION_SCHEMA = "aifios.visual-asset-manifest.v1"
ASSET_SELECTION_PROVENANCE_SCHEMA = "aifios.visual-asset-selection-provenance.v1"
RECIPE_SCHEMA = "aifios.visual-recipe.v1"
INDEX_SCHEMA = "aifios.visual-publish.v1"
INTEGRITY_ALGORITHM = "sha256"


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _safe_relative_path(value: Any) -> Path | None:
    if not isinstance(value, str) or not value.strip() or "\\" in value or "\x00" in value:
        return None
    relative = Path(value)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        return None
    return relative


def _symlink_component(project: Path, relative: Path) -> Path | None:
    current = project
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return current
    return None


def _project_file(
    project: Path,
    value: Any,
    label: str,
    errors: list[str],
    *,
    allowed_roots: tuple[Path, ...] = (),
) -> Path | None:
    relative = _safe_relative_path(value)
    if relative is None:
        errors.append(f"{label} must be a safe project-relative path")
        return None
    symlink = _symlink_component(project, relative)
    if symlink is not None:
        errors.append(f"{label} must not use a symlink: {relative}")
        return None
    candidate = (project / relative).resolve(strict=False)
    if not _is_relative_to(candidate, project):
        errors.append(f"{label} resolves outside the project: {relative}")
        return None
    if allowed_roots and not any(_is_relative_to(candidate, root.resolve(strict=False)) for root in allowed_roots):
        errors.append(f"{label} is outside the selected visual revision: {relative}")
        return None
    if not candidate.is_file() or candidate.stat().st_size <= 0:
        errors.append(f"{label} does not exist or is empty: {relative}")
        return None
    return candidate


def _read_json_object_bytes(
    path: Path | None,
    label: str,
    errors: list[str],
) -> tuple[dict[str, Any] | None, bytes | None]:
    if path is None:
        return None, None
    try:
        payload = path.read_bytes()
        value = json.loads(payload.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"{label} is not valid JSON: {exc}")
        return None, None
    if not isinstance(value, dict):
        errors.append(f"{label} must be a JSON object")
        return None, payload
    return value, payload


def _read_json_object(path: Path | None, label: str, errors: list[str]) -> dict[str, Any] | None:
    value, _payload = _read_json_object_bytes(path, label, errors)
    return value


def _recipe_asset_ids(recipe: dict[str, Any] | None) -> set[str]:
    assets = recipe.get("assets") if isinstance(recipe, dict) else None
    if not isinstance(assets, list):
        return set()
    return {
        asset_id
        for asset in assets
        if isinstance(asset, dict)
        for asset_id in [asset.get("id")]
        if isinstance(asset_id, str) and asset_id.strip()
    }


def _semantic_role_for_asset_id(asset_id: str) -> str:
    """Return the stable role written by the per-asset adoption UI."""
    if re.fullmatch(r"wechat-cover(?:-alt-\d+)?", asset_id, re.IGNORECASE):
        return "wechat_cover"
    if re.fullmatch(r"wechat-share(?:-alt-\d+)?", asset_id, re.IGNORECASE):
        return "wechat_share"
    return asset_id


def _safe_asset_id(value: Any) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", value):
        return None
    return value


def _safe_platform_bindings(value: Any) -> list[str] | None:
    if not isinstance(value, list) or not value:
        return None
    bindings: list[str] = []
    for item in value:
        if not isinstance(item, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,40}", item):
            return None
        if item in bindings:
            return None
        bindings.append(item)
    return bindings


def _validate_output_asset_id(
    output: dict[str, Any],
    position: int,
    recipe_asset_ids: set[str],
    seen_output_ids: set[str],
    errors: list[str],
) -> str | None:
    label = f"selected output {position + 1}"
    asset_id = output.get("id")
    if not isinstance(asset_id, str) or not asset_id.strip():
        errors.append(f"{label} requires a non-empty id")
        return None
    if asset_id in seen_output_ids:
        errors.append(f"{label} duplicates asset id: {asset_id}")
    else:
        seen_output_ids.add(asset_id)
    if asset_id not in recipe_asset_ids:
        errors.append(f"{label} id does not belong to selected recipe.assets: {asset_id}")
    return asset_id


def _validate_output_asset_coverage(
    recipe_asset_ids: set[str],
    seen_output_ids: set[str],
    errors: list[str],
) -> None:
    missing = sorted(recipe_asset_ids - seen_output_ids)
    if missing:
        errors.append("selected index outputs do not cover recipe.assets: " + ", ".join(missing))


def _moments_recipe_assets(recipe: dict[str, Any] | None) -> set[str]:
    assets = recipe.get("assets") if isinstance(recipe, dict) else None
    if not isinstance(assets, list):
        return set()
    return {
        str(asset.get("id"))
        for asset in assets
        if isinstance(asset, dict)
        and asset.get("platform") == "moments"
        and isinstance(asset.get("id"), str)
        and re.fullmatch(r"moments-\d+-p[135]", str(asset.get("id")), re.IGNORECASE)
    }


def _validate_platform_delivery_manifest(
    manifest: dict[str, Any] | None,
    recipe: dict[str, Any] | None,
    index: dict[str, Any] | None,
    slug: str,
    revision_id: str,
    errors: list[str],
) -> None:
    """Bind legacy or shared social assets to the delivery manifest."""
    expected_asset_ids = _moments_recipe_assets(recipe)
    platforms = recipe.get("platforms") if isinstance(recipe, dict) else None
    xhs = platforms.get("xhs") if isinstance(platforms, dict) else None
    shared_social = (
        isinstance(xhs, dict)
        and xhs.get("platform_bindings") == ["xiaohongshu", "moments"]
    )
    if not expected_asset_ids and not shared_social:
        return
    if not isinstance(manifest, dict):
        errors.append("selected moments recipe requires a platform delivery manifest")
        return
    if manifest.get("schema") != "aifios.platform-visual-delivery.v1":
        errors.append("selected platform delivery manifest has an unsupported schema")
        return
    if manifest.get("slug") != slug or manifest.get("revision_id") != revision_id:
        errors.append("selected platform delivery manifest does not match the selected recipe")
        return
    moments = manifest.get("moments")
    posts = moments.get("posts") if isinstance(moments, dict) else None
    if not isinstance(posts, list):
        errors.append("selected platform delivery manifest is missing moments posts")
        return
    output_paths = {
        str(output.get("id")): str(output.get("output"))
        for output in (index or {}).get("outputs", [])
        if isinstance(output, dict) and isinstance(output.get("id"), str) and isinstance(output.get("output"), str)
    }
    seen: set[str] = set()
    if shared_social:
        shared_asset_ids = {
            str(asset.get("id"))
            for asset in (recipe or {}).get("assets", [])
            if isinstance(asset, dict)
            and isinstance(asset.get("id"), str)
            and re.fullmatch(r"xhs-\d+-p[1-5]", str(asset.get("id")), re.IGNORECASE)
        }
        for post in posts:
            if not isinstance(post, dict):
                errors.append("selected platform delivery manifest has an invalid shared social post")
                continue
            if post.get("upload_mode") != "shared_carousel" or post.get("upload_format") != "3:4":
                errors.append("selected Moments post must reuse the Xiaohongshu 3:4 carousel")
            pages = post.get("pages")
            if not isinstance(pages, list) or len(pages) != 5:
                errors.append("selected shared social post must contain five pages")
                continue
            page_ids = [page.get("page_id") for page in pages if isinstance(page, dict)]
            if page_ids != ["P1", "P2", "P3", "P4", "P5"]:
                errors.append("selected shared social post must keep P1-P5 upload order")
            for page in pages:
                if not isinstance(page, dict):
                    continue
                asset_id = page.get("asset_id")
                if not isinstance(asset_id, str) or asset_id not in shared_asset_ids:
                    errors.append("selected shared social page references an unknown XHS asset")
                    continue
                seen.add(asset_id)
                if page.get("path") != output_paths.get(asset_id):
                    errors.append(f"selected shared social page path does not match output: {asset_id}")
        missing = sorted(shared_asset_ids - seen)
        if missing:
            errors.append("selected platform delivery manifest is missing shared social assets: " + ", ".join(missing))
        return
    for post in posts:
        if not isinstance(post, dict):
            errors.append("selected platform delivery manifest has an invalid moments post")
            continue
        if post.get("upload_mode") != "square_triptych" or post.get("upload_format") != "1:1":
            errors.append("selected moments post must declare a 1:1 square_triptych upload mode")
        pages = post.get("pages")
        if not isinstance(pages, list) or len(pages) != 3:
            errors.append("selected moments post must contain three square pages")
            continue
        page_ids = [page.get("page_id") for page in pages if isinstance(page, dict)]
        if page_ids != ["P1", "P3", "P5"]:
            errors.append("selected moments post must keep P1, P3, P5 upload order")
        for page in pages:
            if not isinstance(page, dict):
                continue
            asset_id = page.get("asset_id")
            if not isinstance(asset_id, str) or asset_id not in expected_asset_ids:
                errors.append("selected moments page references an unknown square asset")
                continue
            seen.add(asset_id)
            if page.get("path") != output_paths.get(asset_id):
                errors.append(f"selected moments page path does not match output: {asset_id}")
            if page.get("width") != 1080 or page.get("height") != 1080:
                errors.append(f"selected moments page is not 1080x1080: {asset_id}")
    missing = sorted(expected_asset_ids - seen)
    if missing:
        errors.append("selected platform delivery manifest is missing moments square assets: " + ", ".join(missing))


def _looks_like_recipe_release(index: dict[str, Any] | None) -> bool:
    if not isinstance(index, dict):
        return False
    if index.get("legacy") is False:
        return True
    return bool(index.get("recipe_path") or index.get("revision_id"))


def _release_kind(visual_root: Path) -> str:
    """Distinguish an old flat publish from a recipe release/candidate."""
    if (visual_root / "selected-revision.json").exists():
        return "recipe"

    publish_index: dict[str, Any] | None = None
    publish_index_path = visual_root / "publish" / "index.json"
    if publish_index_path.is_file():
        try:
            value = json.loads(publish_index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            value = None
        publish_index = value if isinstance(value, dict) else None
        if _looks_like_recipe_release(publish_index):
            return "recipe"

    revisions = visual_root / "revisions"
    if revisions.is_dir() and any(revisions.glob("r*.index.json")):
        return "recipe"
    if publish_index and publish_index.get("legacy") is True:
        return "legacy"
    recipes = visual_root / "recipes"
    if recipes.is_dir() and any(recipes.glob("r*.visual-recipe.json")):
        return "recipe"
    return "legacy"


def _blocked(errors: list[str], *, code: str = "visual-release-invalid") -> dict[str, Any]:
    return {
        "status": "blocked",
        "kind": "recipe",
        "code": code,
        "errors": errors,
        "copy_paths": [],
        "integrity_files": [],
    }


def _digest(path: Path) -> tuple[int, str]:
    payload = path.read_bytes()
    return len(payload), hashlib.sha256(payload).hexdigest()


def _integrity_record(role: str, relative: str, path: Path, asset_id: str | None = None) -> dict[str, Any]:
    size, sha256 = _digest(path)
    record: dict[str, Any] = {
        "role": role,
        "path": relative,
        "size": size,
        "sha256": sha256,
    }
    if asset_id:
        record["id"] = asset_id
    return record


def build_visual_selection_manifest(project: Path | str, slug: str, revision_id: str) -> dict[str, Any]:
    """Build the immutable SHA-256 manifest persisted when a revision is adopted."""
    project_path = Path(project).expanduser().resolve(strict=False)
    if not SAFE_SLUG_RE.fullmatch(slug) or not REVISION_ID_RE.fullmatch(revision_id):
        raise ValueError("visual selection slug or revision_id is invalid")
    visual_root = project_path / "pipeline" / "visual" / slug
    recipe_rel = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
    index_rel = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
    output_root = visual_root / "publish" / revision_id
    errors: list[str] = []
    recipe_path = _project_file(project_path, recipe_rel, "selected recipe", errors, allowed_roots=(visual_root,))
    index_path = _project_file(project_path, index_rel, "selected index", errors, allowed_roots=(visual_root,))
    recipe = _read_json_object(recipe_path, "selected recipe", errors)
    index = _read_json_object(index_path, "selected index", errors)
    recipe_asset_ids = _recipe_asset_ids(recipe)
    seen_output_ids: set[str] = set()
    records: list[dict[str, Any]] = []
    if recipe_path:
        records.append(_integrity_record("recipe", recipe_rel, recipe_path))
    if index_path:
        records.append(_integrity_record("index", index_rel, index_path))
    if index is not None:
        if index.get("slug") != slug or index.get("revision_id") != revision_id:
            errors.append("selected index does not match the requested slug and revision")
        outputs = index.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            errors.append("selected index must contain outputs before adoption")
        else:
            for position, output in enumerate(outputs):
                if not isinstance(output, dict):
                    errors.append(f"selected output {position + 1} must be an object")
                    continue
                output_rel = output.get("output")
                output_path = _project_file(
                    project_path,
                    output_rel,
                    f"selected output {position + 1}",
                    errors,
                    allowed_roots=(output_root,),
                )
                asset_id = _validate_output_asset_id(
                    output,
                    position,
                    recipe_asset_ids,
                    seen_output_ids,
                    errors,
                )
                if output_path and isinstance(output_rel, str):
                    declared_size = output.get("size")
                    declared_sha256 = output.get("sha256")
                    actual_size, actual_sha256 = _digest(output_path)
                    if not isinstance(declared_size, int) or isinstance(declared_size, bool) or declared_size <= 0:
                        errors.append(f"selected output {position + 1} requires a positive size")
                    elif declared_size != actual_size:
                        errors.append(f"selected output {position + 1} size does not match current bytes")
                    if not isinstance(declared_sha256, str) or not SHA256_RE.fullmatch(declared_sha256):
                        errors.append(f"selected output {position + 1} requires a valid sha256")
                    elif declared_sha256 != actual_sha256:
                        errors.append(f"selected output {position + 1} sha256 does not match current bytes")
                    records.append(_integrity_record("output", output_rel, output_path, str(asset_id or "")))
        platform_delivery: dict[str, Any] | None = None
        delivery_manifest_rel = index.get("platform_delivery_manifest")
        if delivery_manifest_rel is not None:
            delivery_manifest_path = _project_file(
                project_path,
                delivery_manifest_rel,
                "selected platform delivery manifest",
                errors,
                allowed_roots=(output_root,),
            )
            if delivery_manifest_path and isinstance(delivery_manifest_rel, str):
                records.append(_integrity_record("platform_delivery", delivery_manifest_rel, delivery_manifest_path))
                platform_delivery = _read_json_object(
                    delivery_manifest_path,
                    "selected platform delivery manifest",
                    errors,
                )
        _validate_platform_delivery_manifest(
            platform_delivery,
            recipe,
            index,
            slug,
            revision_id,
            errors,
        )
    _validate_output_asset_coverage(recipe_asset_ids, seen_output_ids, errors)
    if errors:
        raise ValueError("; ".join(errors))
    return {
        "schema": SELECTION_SCHEMA,
        "slug": slug,
        "revision_id": revision_id,
        "integrity": {
            "algorithm": INTEGRITY_ALGORITHM,
            "files": records,
        },
    }


def _validate_integrity_manifest(
    selection: dict[str, Any],
    expected: list[dict[str, Any]],
    errors: list[str],
) -> list[dict[str, Any]]:
    integrity = selection.get("integrity")
    if not isinstance(integrity, dict):
        errors.append("selected visual revision pointer requires an integrity manifest")
        return []
    if integrity.get("algorithm") != INTEGRITY_ALGORITHM:
        errors.append("selected visual integrity algorithm must be sha256")
    files = integrity.get("files")
    if not isinstance(files, list):
        errors.append("selected visual integrity files must be a list")
        return []

    expected_by_key = {(item["role"], item["path"]): item for item in expected}
    actual_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for position, record in enumerate(files):
        if not isinstance(record, dict):
            errors.append(f"selected visual integrity file {position + 1} must be an object")
            continue
        role = record.get("role")
        relative = record.get("path")
        if not isinstance(role, str) or not isinstance(relative, str):
            errors.append(f"selected visual integrity file {position + 1} requires role and path")
            continue
        key = (role, relative)
        if key in actual_by_key:
            errors.append(f"selected visual integrity manifest duplicates {relative}")
            continue
        actual_by_key[key] = record

    missing = sorted(set(expected_by_key) - set(actual_by_key))
    extra = sorted(set(actual_by_key) - set(expected_by_key))
    if missing:
        errors.append("selected visual integrity manifest is missing: " + ", ".join(path for _role, path in missing))
    if extra:
        errors.append("selected visual integrity manifest contains unexpected paths: " + ", ".join(path for _role, path in extra))

    verified: list[dict[str, Any]] = []
    for key, expected_record in expected_by_key.items():
        record = actual_by_key.get(key)
        if record is None:
            continue
        expected_id = expected_record.get("id")
        if expected_id is not None and record.get("id") != expected_id:
            errors.append(f"selected visual integrity id does not match for {key[1]}")
        size = record.get("size")
        sha256 = record.get("sha256")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            errors.append(f"selected visual integrity size is invalid for {key[1]}")
            continue
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            errors.append(f"selected visual integrity sha256 is invalid for {key[1]}")
            continue
        actual_size, actual_sha256 = _digest(expected_record["absolute"])
        declared_size = expected_record.get("size")
        declared_sha256 = expected_record.get("sha256")
        if declared_size is not None and size != declared_size:
            errors.append(f"selected visual pointer size does not match index for {key[1]}")
        if declared_sha256 is not None and sha256 != declared_sha256:
            errors.append(f"selected visual pointer sha256 does not match index for {key[1]}")
        if actual_size != size:
            errors.append(f"selected visual integrity size mismatch for {key[1]}")
        if actual_sha256 != sha256:
            errors.append(f"selected visual integrity sha256 mismatch for {key[1]}")
        if actual_size == size and actual_sha256 == sha256:
            verified.append(dict(record))
    return verified


def _validate_render_provenance(
    project: Path,
    visual_root: Path,
    revision_id: str,
    errors: list[str],
) -> None:
    render_roots = (
        visual_root / "publish" / revision_id / "render",
        visual_root / "publish" / "render" / revision_id,
    )
    for render_root in render_roots:
        try:
            relative_root = render_root.relative_to(project)
        except ValueError:
            errors.append("selected render root resolves outside the project")
            continue
        symlink = _symlink_component(project, relative_root)
        if symlink is not None:
            errors.append(f"selected render root must not use a symlink: {relative_root}")
            continue
        if not render_root.exists():
            continue
        if not render_root.is_dir():
            errors.append(f"selected render root is not a directory: {relative_root}")
            continue
        for candidate in render_root.rglob("*"):
            relative = candidate.relative_to(project)
            if candidate.is_symlink():
                errors.append(f"selected render provenance must not use a symlink: {relative}")
                continue
            if not candidate.is_file():
                continue
            validated = _project_file(
                project,
                str(relative),
                "selected render provenance",
                errors,
                allowed_roots=(render_root,),
            )
            if validated is None:
                continue


def _asset_manifest_blocked(errors: list[str], *, code: str = "visual-asset-selection-invalid") -> dict[str, Any]:
    result = _blocked(errors, code=code)
    result["kind"] = "asset_manifest"
    return result


def _resolve_selected_asset_manifest(
    project_path: Path,
    slug: str,
    manifest_path: Path,
) -> dict[str, Any]:
    """Resolve the authoritative, per-asset visual adoption manifest.

    A revision pointer is deliberately not consulted here.  Each selected
    asset brings its own recipe/index provenance, so a newly regenerated card
    can coexist with an already accepted cover or inline illustration.
    """
    errors: list[str] = []
    manifest_rel = f"pipeline/visual/{slug}/selected-assets.json"
    manifest, manifest_payload = _read_json_object_bytes(
        manifest_path,
        "selected visual asset manifest",
        errors,
    )
    if manifest is None:
        return _asset_manifest_blocked(errors)
    if manifest.get("schema") != ASSET_SELECTION_SCHEMA:
        errors.append("selected visual asset manifest has an unsupported schema")
    if manifest.get("slug") != slug:
        errors.append("selected visual asset manifest does not match the current slug")
    source_content_hash = manifest.get("sourceContentHash")
    if not isinstance(source_content_hash, str) or not SHA256_RE.fullmatch(source_content_hash):
        errors.append("selected visual asset manifest requires a valid sourceContentHash")

    required_roles = manifest.get("requiredRoles")
    selections = manifest.get("selections")
    if (
        not isinstance(required_roles, list)
        or not required_roles
        or not all(isinstance(role, str) and role.strip() for role in required_roles)
        or len(set(required_roles)) != len(required_roles)
    ):
        errors.append("selected visual asset manifest requires unique non-empty requiredRoles")
        required_roles = []
    if not isinstance(selections, dict):
        errors.append("selected visual asset manifest requires selections")
        selections = {}
    if set(selections) != set(required_roles):
        errors.append("selected visual asset manifest selections must exactly cover requiredRoles")

    visual_root = project_path / "pipeline" / "visual" / slug
    copy_paths: set[str] = {manifest_rel}
    manifest_record = _integrity_record("asset_manifest", manifest_rel, manifest_path)
    integrity_files: list[dict[str, Any]] = [manifest_record]
    selected_assets: list[dict[str, Any]] = []
    revision_state: dict[str, dict[str, Any]] = {}
    seen_asset_keys: set[tuple[str, str]] = set()
    seen_asset_paths: set[str] = set()

    for role in required_roles:
        selection = selections.get(role)
        label = f"selected visual asset {role}"
        if not isinstance(selection, dict):
            errors.append(f"{label} must be an object")
            continue
        asset_id = _safe_asset_id(selection.get("assetId"))
        revision_id = selection.get("revisionId")
        asset_rel = selection.get("path")
        asset_sha256 = selection.get("sha256")
        if asset_id is None:
            errors.append(f"{label} has an invalid assetId")
            continue
        if selection.get("semanticRole") != role or _semantic_role_for_asset_id(asset_id) != role:
            errors.append(f"{label} semanticRole does not match the selected asset")
        if not isinstance(revision_id, str) or not REVISION_ID_RE.fullmatch(revision_id):
            errors.append(f"{label} has an invalid revisionId")
            continue
        if not isinstance(asset_sha256, str) or not SHA256_RE.fullmatch(asset_sha256):
            errors.append(f"{label} has an invalid sha256")
            continue
        if _safe_platform_bindings(selection.get("platformBindings")) is None:
            errors.append(f"{label} requires non-empty unique platformBindings")
        output_prefix = f"pipeline/visual/{slug}/publish/{revision_id}/"
        if not isinstance(asset_rel, str) or not asset_rel.startswith(output_prefix):
            errors.append(f"{label} path is not under its selected revision publish root")
            continue
        if (revision_id, asset_id) in seen_asset_keys:
            errors.append(f"{label} duplicates an adopted revision asset: {revision_id}/{asset_id}")
            continue
        if asset_rel in seen_asset_paths:
            errors.append(f"{label} duplicates an adopted asset path: {asset_rel}")
            continue
        seen_asset_keys.add((revision_id, asset_id))
        seen_asset_paths.add(asset_rel)
        asset_path = _project_file(
            project_path,
            asset_rel,
            label,
            errors,
            allowed_roots=(visual_root / "publish" / revision_id,),
        )
        if asset_path is not None:
            actual_size, actual_sha256 = _digest(asset_path)
            if actual_sha256 != asset_sha256:
                errors.append(f"{label} sha256 does not match current bytes")
            copy_paths.add(asset_rel)

        state = revision_state.get(revision_id)
        if state is None:
            recipe_rel = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
            index_rel = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
            recipe_path = _project_file(
                project_path,
                recipe_rel,
                f"selected visual recipe {revision_id}",
                errors,
                allowed_roots=(visual_root,),
            )
            index_path = _project_file(
                project_path,
                index_rel,
                f"selected visual index {revision_id}",
                errors,
                allowed_roots=(visual_root,),
            )
            recipe = _read_json_object(recipe_path, f"selected visual recipe {revision_id}", errors)
            index = _read_json_object(index_path, f"selected visual index {revision_id}", errors)
            state = {
                "recipe_rel": recipe_rel,
                "index_rel": index_rel,
                "recipe_path": recipe_path,
                "index_path": index_path,
                "recipe": recipe,
                "index": index,
            }
            revision_state[revision_id] = state
            if recipe_path is not None:
                copy_paths.add(recipe_rel)
                record = _integrity_record("recipe", recipe_rel, recipe_path)
                record["revision_id"] = revision_id
                integrity_files.append(record)
            if index_path is not None:
                copy_paths.add(index_rel)
                record = _integrity_record("index", index_rel, index_path)
                record["revision_id"] = revision_id
                integrity_files.append(record)

            recipe = state["recipe"]
            index = state["index"]
            if not isinstance(recipe, dict) or recipe.get("schema") not in {RECIPE_SCHEMA, "aifios.visual-recipe.v2"}:
                errors.append(f"selected visual recipe {revision_id} has an unsupported schema")
            elif recipe.get("slug") != slug or recipe.get("revision_id") != revision_id:
                errors.append(f"selected visual recipe {revision_id} does not match the selected slug and revision")
            else:
                source_package = recipe.get("source_package")
                source_path = _project_file(
                    project_path,
                    source_package,
                    f"selected visual recipe {revision_id} source package",
                    errors,
                )
                if source_path is not None and isinstance(source_content_hash, str):
                    _size, source_sha256 = _digest(source_path)
                    if source_sha256 != source_content_hash:
                        errors.append(f"selected visual recipe {revision_id} source package does not match sourceContentHash")
            if not isinstance(index, dict) or index.get("schema") != INDEX_SCHEMA:
                errors.append(f"selected visual index {revision_id} has an unsupported schema")
            else:
                if index.get("slug") != slug or index.get("revision_id") != revision_id:
                    errors.append(f"selected visual index {revision_id} does not match the selected slug and revision")
                if index.get("legacy") is not False:
                    errors.append(f"selected visual index {revision_id} requires legacy=false")
                if index.get("status") != "generated":
                    errors.append(f"selected visual index {revision_id} status must be generated")
                if index.get("recipe_path") != recipe_rel:
                    errors.append(f"selected visual index {revision_id} recipe_path is not canonical")
                if index.get("revision_index_path") != index_rel:
                    errors.append(f"selected visual index {revision_id} revision_index_path is not canonical")
                summary = index.get("quality_summary")
                if isinstance(summary, dict) and summary.get("status") not in (None, "pass"):
                    errors.append(f"selected visual index {revision_id} did not pass its quality summary")

        recipe = state.get("recipe")
        index = state.get("index")
        if isinstance(recipe, dict) and asset_id not in _recipe_asset_ids(recipe):
            errors.append(f"{label} is not declared by its selected visual recipe")
        indexed_output: dict[str, Any] | None = None
        if isinstance(index, dict):
            matches = [
                output for output in (index.get("outputs") or [])
                if isinstance(output, dict) and output.get("id") == asset_id
            ]
            if len(matches) != 1:
                errors.append(f"{label} must have exactly one matching output in its selected index")
            else:
                indexed_output = matches[0]
                if indexed_output.get("output") != asset_rel:
                    errors.append(f"{label} path does not match its selected index output")
                if indexed_output.get("sha256") != asset_sha256:
                    errors.append(f"{label} sha256 does not match its selected index output")
                if indexed_output.get("revision_id") != revision_id:
                    errors.append(f"{label} revisionId does not match its selected index output")
                if indexed_output.get("recipe_path") != state.get("recipe_rel"):
                    errors.append(f"{label} recipe_path does not match its selected recipe")
                if indexed_output.get("status") != "generated":
                    errors.append(f"{label} status must be generated")
                if indexed_output.get("renderer") != "local":
                    errors.append(f"{label} renderer must be local")
                declared_size = indexed_output.get("size")
                declared_sha256 = indexed_output.get("sha256")
                if asset_path is not None:
                    actual_size, actual_sha256 = _digest(asset_path)
                    if not isinstance(declared_size, int) or isinstance(declared_size, bool) or declared_size <= 0:
                        errors.append(f"{label} index output requires a positive size")
                    elif declared_size != actual_size:
                        errors.append(f"{label} index output size does not match current bytes")
                    if declared_sha256 != actual_sha256:
                        errors.append(f"{label} index output sha256 does not match current bytes")
                output_quality = indexed_output.get("quality")
                if isinstance(output_quality, str) and output_quality not in {"", "pass"}:
                    errors.append(f"{label} did not pass its output quality status")

        if asset_path is not None:
            record = _integrity_record("output", asset_rel, asset_path, asset_id)
            record["revision_id"] = revision_id
            record["semantic_role"] = role
            integrity_files.append(record)
            selected_assets.append({
                "semantic_role": role,
                "asset_id": asset_id,
                "revision_id": revision_id,
                "path": asset_rel,
                "sha256": asset_sha256,
                "size": _digest(asset_path)[0],
            })

    if errors:
        return _asset_manifest_blocked(errors)

    return {
        "status": "pass",
        "kind": "asset_manifest",
        "code": None,
        "errors": [],
        "selection": manifest,
        "selection_path": manifest_rel,
        "selection_integrity": {
            "path": manifest_rel,
            "size": len(manifest_payload or b""),
            "sha256": hashlib.sha256(manifest_payload or b"").hexdigest(),
        },
        "source_content_hash": source_content_hash,
        "selected_assets": selected_assets,
        "copy_paths": sorted(copy_paths),
        "integrity_files": integrity_files,
    }


def _resolve_selected_revision_release(project: Path | str, slug: str) -> dict[str, Any]:
    """Return the selected release only after provenance and digest gates pass."""
    project_path = Path(project).expanduser().resolve(strict=False)
    if not SAFE_SLUG_RE.fullmatch(slug):
        return _blocked(["visual slug is unsafe"])
    visual_root = project_path / "pipeline" / "visual" / slug
    if not _is_relative_to(visual_root.resolve(strict=False), project_path):
        return _blocked(["visual root resolves outside the project"])

    kind = _release_kind(visual_root)
    if kind == "legacy":
        return {"status": "legacy", "kind": "legacy", "errors": [], "copy_paths": [], "integrity_files": []}

    selection_rel = f"pipeline/visual/{slug}/selected-revision.json"
    selection_path = _project_file(
        project_path,
        selection_rel,
        "selected visual revision pointer",
        [],
        allowed_roots=(visual_root,),
    )
    if selection_path is None:
        return _blocked(
            ["recipe visual release requires an explicit selected-revision.json adoption pointer"],
            code="visual-release-unselected" if not (visual_root / "selected-revision.json").exists() else "visual-release-invalid",
        )

    errors: list[str] = []
    selection, selection_payload = _read_json_object_bytes(
        selection_path,
        "selected visual revision pointer",
        errors,
    )
    if selection is None:
        return _blocked(errors)
    if selection.get("schema") != SELECTION_SCHEMA:
        errors.append("selected visual revision pointer has an unsupported schema")
    if selection.get("slug") != slug:
        errors.append("selected visual revision pointer does not match the current slug")
    revision_id = selection.get("revision_id")
    if not isinstance(revision_id, str) or not REVISION_ID_RE.fullmatch(revision_id):
        errors.append("selected visual revision pointer has an invalid revision_id")
    if errors:
        return _blocked(errors)

    recipe_rel = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
    index_rel = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
    output_root = visual_root / "publish" / revision_id
    old_render_root = visual_root / "publish" / "render" / revision_id
    allowed_release_roots = (output_root, old_render_root)
    recipe_path = _project_file(project_path, recipe_rel, "selected canonical visual recipe", errors, allowed_roots=(visual_root,))
    index_path = _project_file(project_path, index_rel, "selected immutable visual index", errors, allowed_roots=(visual_root,))
    recipe = _read_json_object(recipe_path, "selected canonical visual recipe", errors)
    index = _read_json_object(index_path, "selected immutable visual index", errors)
    if recipe is None or index is None:
        return _blocked(errors)

    from visual_director import validate_visual_recipe

    recipe_errors = validate_visual_recipe(recipe)
    errors.extend(f"visual recipe: {item}" for item in recipe_errors)
    if recipe.get("slug") != slug or recipe.get("revision_id") != revision_id:
        errors.append("selected recipe does not match the current slug and revision")

    if index.get("schema") != INDEX_SCHEMA:
        errors.append("selected index has an unsupported schema")
    if index.get("slug") != slug or index.get("revision_id") != revision_id:
        errors.append("selected index does not match the current slug and revision")
    if index.get("legacy") is not False:
        errors.append("selected recipe index requires legacy=false")
    if index.get("status") != "generated":
        errors.append("selected index status must be generated")
    if index.get("recipe_path") != recipe_rel:
        errors.append("selected index recipe_path is not the canonical recipe path")
    if index.get("revision_index_path") != index_rel:
        errors.append("selected index revision_index_path is not canonical")
    if index.get("renderer") not in (None, "local"):
        errors.append("selected index renderer must be local")
    if index.get("errors") not in (None, []):
        errors.append("selected generated index must not contain errors")
    quality_summary = index.get("quality_summary")
    if not isinstance(quality_summary, dict) or quality_summary.get("status") != "pass":
        errors.append("selected index requires quality_summary.status=pass")

    outputs = index.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        errors.append("selected index must contain generated outputs")
        outputs = []
    output_prefix = f"pipeline/visual/{slug}/publish/{revision_id}/"
    recipe_asset_ids = _recipe_asset_ids(recipe)
    seen_output_ids: set[str] = set()
    copy_paths = {selection_rel, recipe_rel, index_rel}
    integrity_expected: list[dict[str, Any]] = []
    if recipe_path:
        integrity_expected.append({"role": "recipe", "path": recipe_rel, "absolute": recipe_path})
    if index_path:
        integrity_expected.append({"role": "index", "path": index_rel, "absolute": index_path})
    for position, output in enumerate(outputs):
        label = f"selected output {position + 1}"
        if not isinstance(output, dict):
            errors.append(f"{label} must be an object")
            continue
        asset_id = _validate_output_asset_id(
            output,
            position,
            recipe_asset_ids,
            seen_output_ids,
            errors,
        )
        if output.get("status") != "generated":
            errors.append(f"{label} status must be generated")
        if output.get("renderer") != "local":
            errors.append(f"{label} renderer must be local")
        if output.get("recipe_path") != recipe_rel:
            errors.append(f"{label} recipe_path does not match the selected recipe")
        if output.get("revision_id") != revision_id:
            errors.append(f"{label} revision_id does not match the selected revision")
        output_rel = output.get("output")
        if not isinstance(output_rel, str) or not output_rel.startswith(output_prefix):
            errors.append(f"{label} must belong to {output_prefix}")
            continue
        output_path = _project_file(
            project_path,
            output_rel,
            label,
            errors,
            allowed_roots=(output_root,),
        )
        if output_path:
            copy_paths.add(output_rel)
            declared_size = output.get("size")
            declared_sha256 = output.get("sha256")
            actual_size, actual_sha256 = _digest(output_path)
            if not isinstance(declared_size, int) or isinstance(declared_size, bool) or declared_size <= 0:
                errors.append(f"{label} requires a positive size")
            elif declared_size != actual_size:
                errors.append(f"{label} size does not match current bytes")
            if not isinstance(declared_sha256, str) or not SHA256_RE.fullmatch(declared_sha256):
                errors.append(f"{label} requires a valid sha256")
            elif declared_sha256 != actual_sha256:
                errors.append(f"{label} sha256 does not match current bytes")
            integrity_expected.append({
                "role": "output",
                "path": output_rel,
                "id": str(asset_id or ""),
                "absolute": output_path,
                "size": declared_size,
                "sha256": declared_sha256,
            })
        for provenance_field in ("render_html", "source_svg"):
            provenance_rel = output.get(provenance_field)
            if provenance_rel is None:
                continue
            provenance_path = _project_file(
                project_path,
                provenance_rel,
                f"{label} {provenance_field}",
                errors,
                allowed_roots=allowed_release_roots,
            )
            # Renderer work files are validated for containment but are not
            # customer artifacts unless they are separately digest-bound.
            _ = provenance_path

    platform_delivery: dict[str, Any] | None = None
    delivery_manifest_rel = index.get("platform_delivery_manifest")
    if delivery_manifest_rel is not None:
        delivery_manifest_path = _project_file(
            project_path,
            delivery_manifest_rel,
            "selected platform delivery manifest",
            errors,
            allowed_roots=(output_root,),
        )
        if delivery_manifest_path and isinstance(delivery_manifest_rel, str):
            copy_paths.add(delivery_manifest_rel)
            integrity_expected.append({
                "role": "platform_delivery",
                "path": delivery_manifest_rel,
                "absolute": delivery_manifest_path,
            })
            platform_delivery = _read_json_object(
                delivery_manifest_path,
                "selected platform delivery manifest",
                errors,
            )

    _validate_platform_delivery_manifest(
        platform_delivery,
        recipe,
        index,
        slug,
        revision_id,
        errors,
    )

    _validate_output_asset_coverage(recipe_asset_ids, seen_output_ids, errors)

    _validate_render_provenance(project_path, visual_root, revision_id, errors)
    integrity_files = _validate_integrity_manifest(selection, integrity_expected, errors)
    if errors:
        return _blocked(errors)

    from minimal_loop_acceptance import check_recipe_visual_release

    quality_gate = check_recipe_visual_release(project_path, index)
    if quality_gate.get("status") != "pass":
        details = [
            str(item)
            for field in ("errors", "review_issues")
            for item in quality_gate.get(field, [])
            if str(item).strip()
        ]
        return _blocked(details or ["selected recipe release did not pass the complete visual quality gate"])

    return {
        "status": "pass",
        "kind": "recipe",
        "code": None,
        "errors": [],
        "selection": selection,
        "selection_path": selection_rel,
        "selection_integrity": {
            "path": selection_rel,
            "size": len(selection_payload or b""),
            "sha256": hashlib.sha256(selection_payload or b"").hexdigest(),
        },
        "revision_id": revision_id,
        "recipe": recipe,
        "recipe_path": recipe_rel,
        "index": index,
        "index_path": index_rel,
        "quality_gate": quality_gate,
        "copy_paths": sorted(copy_paths),
        "integrity_files": integrity_files,
    }


def resolve_selected_visual_release(project: Path | str, slug: str) -> dict[str, Any]:
    """Resolve the current visual selection using the newest selection model.

    ``selected-assets.json`` is authoritative whenever it exists.  The former
    whole-revision pointer remains a read-only compatibility path for projects
    created before per-asset adoption; a malformed asset manifest must never
    silently fall back to that pointer.
    """
    project_path = Path(project).expanduser().resolve(strict=False)
    if not SAFE_SLUG_RE.fullmatch(slug):
        return _blocked(["visual slug is unsafe"])
    visual_root = project_path / "pipeline" / "visual" / slug
    if not _is_relative_to(visual_root.resolve(strict=False), project_path):
        return _blocked(["visual root resolves outside the project"])

    asset_manifest_rel = f"pipeline/visual/{slug}/selected-assets.json"
    raw_asset_manifest = visual_root / "selected-assets.json"
    if raw_asset_manifest.exists() or raw_asset_manifest.is_symlink():
        errors: list[str] = []
        asset_manifest_path = _project_file(
            project_path,
            asset_manifest_rel,
            "selected visual asset manifest",
            errors,
            allowed_roots=(visual_root,),
        )
        if asset_manifest_path is None:
            return _asset_manifest_blocked(errors)
        return _resolve_selected_asset_manifest(project_path, slug, asset_manifest_path)

    return _resolve_selected_revision_release(project_path, slug)

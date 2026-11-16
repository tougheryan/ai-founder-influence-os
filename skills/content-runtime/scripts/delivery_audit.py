#!/usr/bin/env python3
"""System-level delivery audit for Echo Founder runs."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from content_pipeline import PipelineDirector
from content_runtime import ContentRuntime
import native_delivery
from dbs_fusion_apply import extract_target_path, parse_writeback_rows, pipeline_step_for_path
from delivery_pack import (
    DRAFT_QUEUE_SCHEMA,
    FORMAL_DELIVERY_SCOPE,
    INTERNAL_REVIEW_MARKER,
    INTERNAL_REVIEW_SCOPE,
    REQUIRED_DELIVERY_PLATFORMS,
    build_delivery_pack,
    is_allowed_publication_asset_path,
    is_sensitive_path,
    opinion_count_from_jobs,
    privacy_scan,
    publication_contract,
    publication_delivery_prerequisites,
    expected_audit_steps_for_run,
    safe_name,
)
from visual_release import (
    ASSET_SELECTION_PROVENANCE_SCHEMA,
    ASSET_SELECTION_SCHEMA,
    REVISION_ID_RE,
    SAFE_SLUG_RE,
    SELECTION_SCHEMA,
    SHA256_RE,
    resolve_selected_visual_release,
)


DRAFT_STEPS = ["write"]
FINAL_DRAFT_STEPS = ["write", "xhs"]
# ``package`` is an already validated multi-platform publish source. It does
# not replace the platform-specific quality-report steps above, but publish and
# lifecycle records may legitimately bind to it.
PUBLISHABLE_CONTENT_STEPS = ["write", "xhs", "package"]
REQUIRED_CORE_STEPS = ["intake", "validate", "blueprint", "write", "package", "visual"]
OPTIONAL_LEGACY_STEPS = ["angle", "breakdown", "xhs", "platform-adapt"]
CHECK_STEPS = ["prelaunch", "compliance", "audit"]
OPTIONAL_LIFECYCLE_STEPS = ["publish", "performance", "review", "archive", "twin"]
OPTIONAL_EVIDENCE_STEPS = ["dbs-fusion"]
VISUAL_PATH_RE = re.compile(r"pipeline/visual/[^\s`|，。；;)\]）]+", re.IGNORECASE)
PUBLISH_FINAL_PATH_LINE_RE = re.compile(r"(?m)^\s*[-*]\s*(?:最终版路径|成稿路径|原文路径|内容路径)\s*[：:]\s*(.+?)\s*$")
PUBLISH_FINAL_PATH_RE = re.compile(r"pipeline/(?:final|xhs|package|platform-adapt)/[^\s`|，。；;)\]）]+", re.IGNORECASE)
PUBLISH_PLATFORM_LINE_RE = re.compile(r"(?m)^\s*[-*]\s*(?:发布平台|目标阵地|平台)\s*[：:]\s*(.+?)\s*$")
DRAFT_SOURCE_PATH_RE = re.compile(r"pipeline/(?:final|xhs|package)/[^\s`|，。；;)\]）]+", re.IGNORECASE)
DIRECTORY_PATH_SUFFIX_RE = re.compile(r"/公众号HTML输出/?$", re.IGNORECASE)
ABSOLUTE_LOCAL_PATH_RE = re.compile(r"(?<![\w:])/(?:Users|private|tmp|var/folders|home|Volumes)/[^\s`\"'，。；;]+")
REQUIRED_CUSTOMER_FILES = [
    "README.md",
    "客户交付说明.md",
    "客户成果报告.md",
    "修改意见回填.md",
    "隐私检查清单.md",
    "manifest.json",
]
PLATFORM_TO_DRAFT = {
    "wechat": "write",
    "xhs": "write",
    "xiaohongshu": "write",
}
LEGACY_PLATFORM_TO_DRAFT = {
    "xhs": "xhs",
    "xiaohongshu": "xhs",
}
QUALITY_REPORT_STEPS = {
    "write": "wechat",
    "xhs": "xhs",
}
APPLIED_STATES = {"applied"}
STATUS_LABELS = {
    "pass": "通过",
    "review_required": "需人工复核",
    "blocked": "阻断",
}
SEVERITY_LABELS = {
    "blocked": "阻断",
    "review": "复核",
}
ACTION_GROUPS = [
    (
        "repair-runtime",
        "修复 runtime 产物",
        {"missing-step", "validate-error", "invalid-step", "step-review", "pipeline-warning"},
        "content-runtime",
    ),
    (
        "repair-publish",
        "修复发布记录",
        {
            "publish-final-path-missing",
            "publish-final-missing",
            "publish-final-wrong-run",
            "publish-stale-final",
            "publish-final-not-current",
            "publish-platform-mismatch",
        },
        "content-publish",
    ),
    (
        "repair-lifecycle",
        "修复复盘/沉淀记录",
        {
            "review-source-missing",
            "review-source-file-missing",
            "review-source-wrong-run",
            "review-stale-source",
            "review-source-not-current",
            "archive-source-missing",
            "archive-source-file-missing",
            "archive-source-wrong-run",
            "archive-stale-source",
            "archive-source-not-current",
            "twin-source-missing",
            "twin-source-file-missing",
            "twin-source-wrong-run",
            "twin-stale-source",
            "twin-source-not-current",
        },
        "content-review/archive/twin",
    ),
    (
        "repair-checks",
        "修复发布前检查",
        {
            "prelaunch-source-missing",
            "prelaunch-source-file-missing",
            "prelaunch-source-wrong-run",
            "prelaunch-stale-source",
            "prelaunch-source-not-current",
            "compliance-source-missing",
            "compliance-source-file-missing",
            "compliance-source-wrong-run",
            "compliance-stale-source",
            "compliance-source-not-current",
            "audit-source-missing",
            "audit-source-file-missing",
            "audit-source-wrong-run",
            "audit-stale-source",
            "audit-source-not-current",
        },
        "content-prelaunch/compliance/audit",
    ),
    (
        "refresh-quality",
        "刷新内容质量验收",
        {"missing-quality-report", "quality-report-stale", "quality-blocked", "quality-review"},
        "quality-check",
    ),
    (
        "realize-assets",
        "补齐视觉实物资产",
        {
            "visual-assets-unreadable",
            "visual-asset-wrong-slug",
            "visual-assets-missing",
            "visual-assets-not-declared",
            "visual-release-invalid",
            "visual-release-unselected",
        },
        "content-visual",
    ),
    (
        "apply-dbs-fusion",
        "写回 DBS 融合诊断",
        {"dbs-fusion-invalid", "dbs-fusion-not-applied"},
        "dbs-fusion-apply",
    ),
    (
        "rebuild-delivery-pack",
        "重建交付包",
        {
            "missing-delivery-pack",
            "delivery-dir-missing",
            "delivery-zip-missing",
            "privacy-scan",
            "delivery-pack-incomplete",
            "delivery-pack-local-path-leak",
            "delivery-manifest-missing-file",
            "delivery-zip-manifest-mismatch",
            "delivery-zip-corrupt",
            "delivery-zip-unsafe-entry",
            "delivery-zip-incomplete",
            "delivery-zip-missing-manifest-file",
            "delivery-visual-integrity-mismatch",
            "delivery-zip-visual-integrity-mismatch",
            "delivery-publish-assets-invalid-sidecar",
            "delivery-publish-assets-rejected",
            "delivery-publish-assets-missing",
            "delivery-publish-assets-sensitive",
            "delivery-publish-assets-not-copied",
            "delivery-zip-missing-platform-publish-assets",
            "delivery-draft-queue-invalid",
            "delivery-draft-queue-missing",
            "delivery-zip-missing-draft-queue",
            "delivery-formal-gate-failed",
            "delivery-formal-zip-missing",
            "delivery-internal-review-zip",
            "delivery-internal-review-marker-missing",
            "delivery-manifest-scope-invalid",
            "delivery-platform-contract-invalid",
            "sensitive-source",
            "artifact-not-copied",
        },
        "delivery-pack",
    ),
]
ACTION_FALLBACK_GROUP = ("manual-review", "人工复核", "manual")


def rel_to_project(project: Path, value: str | None) -> str | None:
    if not value:
        return None
    path = Path(value)
    if path.is_absolute():
        try:
            return str(path.relative_to(project))
        except ValueError:
            return str(path)
    return str(path)


def newest_files(root: Path, pattern: str) -> list[Path]:
    if not root.exists():
        return []
    return sorted(root.glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)


def parse_iso_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def issue(severity: str, code: str, message: str, fix: str, artifact: str | None = None) -> dict[str, str]:
    payload = {
        "severity": severity,
        "code": code,
        "message": message,
        "fix": fix,
    }
    if artifact:
        payload["artifact"] = artifact
    return payload


def action_group_for_code(code: str | None) -> tuple[str, str, str]:
    for group_id, title, codes, owner in ACTION_GROUPS:
        if code in codes:
            return group_id, title, owner
    return ACTION_FALLBACK_GROUP


def action_command(group_id: str, run: dict[str, Any], issue_items: list[dict[str, Any]]) -> str:
    run_id = str(run.get("run_id") or "").strip()
    slug = str(run.get("slug") or "").strip()
    run_arg = f"RUN_ID={run_id}" if run_id else (f"SLUG={slug}" if slug else "")
    slug_arg = f"SLUG={slug}" if slug else ""
    if group_id == "refresh-quality":
        drafts = []
        for item in issue_items:
            artifact = str(item.get("artifact") or "")
            for step, platform in QUALITY_REPORT_STEPS.items():
                if f"/{step}/" in artifact or artifact.startswith(f"pipeline/{step}/"):
                    drafts.append(platform)
        platform = drafts[0] if drafts else "wechat"
        return f"make quality-check PLATFORM={platform} {slug_arg}".strip()
    if group_id == "apply-dbs-fusion":
        artifact = next((str(item.get("artifact") or "") for item in issue_items if item.get("artifact")), "")
        return f"make dbs-fusion-apply FILE={artifact}".strip() if artifact else "make dbs-fusion-apply"
    if group_id == "rebuild-delivery-pack":
        return f"make delivery-audit {run_arg} AUTO_PACK=1".strip()
    if group_id == "realize-assets":
        return "先在视觉页面生成 Manifest 中声明的实物资产，再运行 make delivery-audit AUTO_PACK=1"
    if group_id == "repair-runtime":
        return "回到对应 pipeline 步骤重生成产物，并运行 make delivery-audit AUTO_PACK=1"
    if group_id == "repair-publish":
        current = ", ".join(
            str(run.get("steps", {}).get(step, {}).get("latest") or "")
            for step in FINAL_DRAFT_STEPS
            if run.get("steps", {}).get(step, {}).get("latest")
        )
        suffix = f"当前最终稿：{current}" if current else "先生成当前 run 的最终稿"
        return f"重新保存发布记录，确保最终版路径指向当前 run 最新成稿；{suffix}；然后运行 make delivery-audit AUTO_PACK=1"
    if group_id == "repair-lifecycle":
        current = ", ".join(
            str(run.get("steps", {}).get(step, {}).get("latest") or "")
            for step in FINAL_DRAFT_STEPS
            if run.get("steps", {}).get(step, {}).get("latest")
        )
        suffix = f"当前最终稿：{current}" if current else "当前 run 尚无可绑定成稿"
        return f"基于当前 run 重新生成 review/archive/twin，确保原文/成稿路径引用 latest；{suffix}；然后运行 make delivery-audit AUTO_PACK=1"
    if group_id == "repair-checks":
        current = ", ".join(
            str(run.get("steps", {}).get(step, {}).get("latest") or "")
            for step in FINAL_DRAFT_STEPS
            if run.get("steps", {}).get(step, {}).get("latest")
        )
        suffix = f"当前最终稿：{current}" if current else "当前 run 尚无可绑定成稿"
        return f"基于当前 run 重新生成 prelaunch/compliance/audit，确保检查对象引用 latest；{suffix}；然后运行 make delivery-audit AUTO_PACK=1"
    return "人工确认后重新运行 make delivery-audit AUTO_PACK=1"


def build_recommended_actions(issues: list[dict[str, Any]], run: dict[str, Any]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for item in issues:
        group_id, title, owner = action_group_for_code(item.get("code"))
        if group_id not in grouped:
            grouped[group_id] = {
                "id": group_id,
                "title": title,
                "owner": owner,
                "severity": item.get("severity") or "review",
                "issue_codes": [],
                "issue_count": 0,
                "artifacts": [],
                "messages": [],
                "_items": [],
            }
            order.append(group_id)
        group = grouped[group_id]
        if item.get("severity") == "blocked":
            group["severity"] = "blocked"
        code = item.get("code")
        if code and code not in group["issue_codes"]:
            group["issue_codes"].append(code)
        artifact = item.get("artifact")
        if artifact and artifact not in group["artifacts"]:
            group["artifacts"].append(artifact)
        message = item.get("message") or code
        if message and message not in group["messages"]:
            group["messages"].append(message)
        group["issue_count"] += 1
        group["_items"].append(item)

    def priority(group: dict[str, Any]) -> tuple[int, int]:
        severity_rank = 0 if group.get("severity") == "blocked" else 1
        action_rank = {group_id: index for index, (group_id, *_rest) in enumerate(ACTION_GROUPS)}
        return severity_rank, action_rank.get(str(group.get("id")), 99)

    actions = []
    for group_id in order:
        group = grouped[group_id]
        group["command"] = action_command(group_id, run, group["_items"])
        group["summary"] = "；".join(str(item) for item in group["messages"][:3])
        group["artifacts"] = group["artifacts"][:5]
        group["messages"] = group["messages"][:5]
        group.pop("_items", None)
        actions.append(group)
    return sorted(actions, key=priority)


def visual_paths_from_text(text: str) -> list[str]:
    paths: list[str] = []
    for raw in VISUAL_PATH_RE.findall(text or ""):
        path = raw.strip(" `|，。；;,.、)）]】")
        if "/prompts/" in path.lower():
            continue
        if re.search(r"^pipeline/visual/[^/]+-visual\.md$", path, re.IGNORECASE):
            continue
        if path not in paths:
            paths.append(path)
    return paths


def expected_asset_paths_from_validation(validation: dict[str, Any]) -> list[str]:
    checks = validation.get("quality_checks") or {}
    paths: list[str] = []
    for key in ("visual_output_paths", "asset_paths", "manifest_paths"):
        for path in checks.get(key) or []:
            clean = str(path).strip(" `|，。；;,.、)）]】")
            if "/prompts/" in clean.lower():
                continue
            if re.search(r"^pipeline/visual/[^/]+-visual\.md$", clean, re.IGNORECASE):
                continue
            if clean.startswith("pipeline/visual/") and clean not in paths:
                paths.append(clean)
    return paths


def project_asset_exists(rt: ContentRuntime, rel: str) -> tuple[bool, str]:
    try:
        path = rt._project_path(rel, must_exist=False)
    except Exception as exc:
        return False, f"路径越界或非法：{exc}"
    if not path.exists():
        return False, "文件或目录不存在"
    if path.is_file():
        if path.stat().st_size <= 0:
            return False, "文件为空"
        return True, "ok"
    if path.is_dir():
        has_file = any(item.is_file() and item.stat().st_size > 0 for item in path.rglob("*"))
        return (True, "ok") if has_file else (False, "目录内没有非空文件")
    return False, "不是可交付文件或目录"



def path_inside(parent: Path, child: Path) -> bool:
    try:
        child.resolve(strict=False).relative_to(parent.resolve(strict=False))
        return True
    except ValueError:
        return False


def delivery_member_exists(delivery_dir: Path, value: str | None) -> tuple[bool, str]:
    if not value:
        return False, "路径为空"
    raw = Path(str(value))
    if raw.is_absolute():
        if not path_inside(delivery_dir, raw):
            return False, "路径指向交付目录外"
        target = raw
    else:
        if any(part == ".." for part in raw.parts):
            return False, "路径包含上级目录"
        target = delivery_dir / raw
    if not path_inside(delivery_dir, target):
        return False, "路径指向交付目录外"
    if not target.exists():
        return False, "文件或目录不存在"
    if target.is_file():
        return (True, "ok") if target.stat().st_size > 0 else (False, "文件为空")
    if target.is_dir():
        has_nonempty_file = any(item.is_file() and item.stat().st_size > 0 for item in target.rglob("*"))
        return (True, "ok") if has_nonempty_file else (False, "目录内没有非空文件")
    return False, "不是普通文件或目录"


def manifest_string_values(value: Any, prefix: str = "") -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).startswith("_"):
                continue
            rows.extend(manifest_string_values(item, f"{prefix}.{key}" if prefix else str(key)))
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            rows.extend(manifest_string_values(item, f"{prefix}[{idx}]"))
    elif isinstance(value, str):
        rows.append((prefix, value))
    return rows


def absolute_local_path_hits(manifest: dict[str, Any]) -> list[str]:
    hits: list[str] = []
    for key, value in manifest_string_values(manifest):
        if ABSOLUTE_LOCAL_PATH_RE.search(value):
            hits.append(f"{key}: {value[:160]}")
        elif Path(value).is_absolute() and not re.match(r"^[a-z][a-z0-9+.-]*://", value, re.IGNORECASE):
            hits.append(f"{key}: {value[:160]}")
        if len(hits) >= 8:
            break
    return hits


def delivery_manifest_referenced_files(manifest: dict[str, Any], delivery_dir: Path) -> set[str]:
    files: set[str] = set()

    def add_member(value: Any) -> None:
        if not value:
            return
        raw = Path(str(value))
        if raw.is_absolute():
            if not path_inside(delivery_dir, raw):
                return
            target = raw
        else:
            if any(part == ".." for part in raw.parts):
                return
            target = delivery_dir / raw
        if not path_inside(delivery_dir, target) or not target.exists():
            return
        if target.is_file() and target.stat().st_size > 0:
            files.add(str(target.relative_to(delivery_dir)).replace("\\", "/"))
        elif target.is_dir():
            for item in target.rglob("*"):
                if item.is_file() and item.stat().st_size > 0:
                    files.add(str(item.relative_to(delivery_dir)).replace("\\", "/"))

    for rel in REQUIRED_CUSTOMER_FILES:
        add_member(rel)
    for artifact in manifest.get("artifacts", []) or []:
        add_member(artifact.get("copied_to"))
        for file_path in artifact.get("files") or []:
            add_member(file_path)
    for report_path in manifest.get("reports", []) or []:
        add_member(report_path)
    for report_key in ("benchmark_reports", "quality_reports", "system_audit_reports"):
        for report_path in manifest.get(report_key, []) or []:
            add_member(report_path)
    return files


def _manifest_count(artifact: dict[str, Any], key: str) -> int:
    value = artifact.get(key, 0)
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return 0


def inspect_platform_publish_asset_manifest(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Require a publish-assets sidecar to be complete before delivery."""
    issues: list[dict[str, Any]] = []
    found = False
    for artifact in manifest.get("artifacts", []) or []:
        if not isinstance(artifact, dict) or artifact.get("step") != "publish-assets":
            continue
        found = True
        errors = artifact.get("errors") or []
        rejected = _manifest_count(artifact, "rejected_count")
        missing = _manifest_count(artifact, "missing_count")
        sensitive = _manifest_count(artifact, "skipped_sensitive_count")
        if errors:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-invalid-sidecar",
                "平台发布成稿清单无法安全解析。",
                "重新生成当前 slug 的平台发布成稿，再重新打包。",
            ))
        if rejected:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-rejected",
                f"平台发布成稿清单有 {rejected} 条非当前任务或不安全路径，未被收录。",
                "只保留当前 slug 的 pipeline/publish-assets 生成文件，再重新打包。",
            ))
        if missing:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-missing",
                f"平台发布成稿清单有 {missing} 个声明文件不存在或无法复制。",
                "重新生成缺失发布稿，确认文件落盘后再重新打包。",
            ))
        if sensitive:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-sensitive",
                f"平台发布成稿清单有 {sensitive} 个敏感文件被隐私规则拦截。",
                "移除敏感内容或改用已授权的发布稿后重新打包。",
            ))
        if artifact.get("source") and not artifact.get("copied_to") and not (errors or rejected or missing or sensitive):
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-not-copied",
                "平台发布成稿清单存在，但没有复制进交付包。",
                "重新运行 delivery-pack，确认平台发布成稿清单和文件均进入 ZIP。",
            ))
    if not found:
        issues.append(issue(
            "blocked",
            "delivery-publish-assets-missing",
            "交付包缺少当前任务的五平台发布成稿清单。",
            "重新生成平台发布成稿和草稿队列后再运行 delivery-pack。",
        ))
    return issues


PUBLISH_ASSET_SOURCE_ROOT = Path("pipeline") / "publish-assets"
PUBLISH_ASSET_DELIVERY_ROOT = Path("artifacts") / "publish-assets"


def _safe_delivery_regular_file_relative(delivery_dir: Path, value: Any) -> Path | None:
    """Return a regular, non-symlink delivery member relative to its root."""
    if not isinstance(value, str) or not value.strip() or delivery_dir.is_symlink():
        return None
    raw = Path(value)
    root = delivery_dir.resolve(strict=False)
    if raw.is_absolute():
        try:
            relative = raw.relative_to(root)
        except ValueError:
            return None
    else:
        relative = raw
    if (
        relative.is_absolute()
        or "\\" in value
        or "\x00" in value
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        return None

    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return None
    if not current.is_file():
        return None
    try:
        if current.stat().st_size <= 0:
            return None
    except OSError:
        return None
    if not path_inside(root, current):
        return None
    return relative


def _platform_publish_asset_destination(raw_path: Any, slug: str) -> Path | None:
    """Map one trusted sidecar source path to its required delivery member."""
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    relative = Path(raw_path)
    if (
        relative.is_absolute()
        or "\\" in raw_path
        or "\x00" in raw_path
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        return None

    safe_slug = safe_name(slug)
    generated_root = PUBLISH_ASSET_SOURCE_ROOT / safe_slug
    report_path = PUBLISH_ASSET_SOURCE_ROOT / f"{safe_slug}-publish-assets.md"
    sidecar_path = PUBLISH_ASSET_SOURCE_ROOT / f"{safe_slug}-platform-deliverables.json"
    if relative == generated_root:
        return None
    if relative != report_path and relative != sidecar_path and not relative.is_relative_to(generated_root):
        return None
    if not is_allowed_publication_asset_path(relative, safe_slug):
        return None
    return PUBLISH_ASSET_DELIVERY_ROOT / relative.relative_to(PUBLISH_ASSET_SOURCE_ROOT)


def inspect_platform_publish_asset_delivery_members(
    manifest: dict[str, Any],
    delivery_dir: Path,
) -> tuple[set[str], list[dict[str, Any]]]:
    """Validate the copied sidecar and return its required ZIP member names.

    The sidecar is the source of truth for direct-publish forms such as the
    three WeChat share posts and two Xiaohongshu video forms.  Manifest counts
    alone are not sufficient: they can be stale or hand-edited after packing.
    """
    members: set[str] = set()
    issues: list[dict[str, Any]] = []
    slug = str(manifest.get("slug") or "").strip()
    if not slug:
        return members, issues

    safe_slug = safe_name(slug)
    sidecar_source = PUBLISH_ASSET_SOURCE_ROOT / f"{safe_slug}-platform-deliverables.json"
    sidecar_member = PUBLISH_ASSET_DELIVERY_ROOT / sidecar_source.relative_to(PUBLISH_ASSET_SOURCE_ROOT)
    found = False

    for artifact in manifest.get("artifacts", []) or []:
        if not isinstance(artifact, dict) or artifact.get("step") != "publish-assets":
            continue
        found = True

        source = artifact.get("source")
        if source and str(source) != str(sidecar_source):
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-rejected",
                "平台发布成稿清单引用了非当前 slug 的来源。",
                "只保留当前 slug 的 pipeline/publish-assets 清单后重新打包。",
                str(source),
            ))

        copied_relative = _safe_delivery_regular_file_relative(delivery_dir, artifact.get("copied_to"))
        if copied_relative != sidecar_member:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-not-copied",
                "平台发布成稿清单没有以安全的标准路径复制进交付目录。",
                "重新运行 delivery-pack，确认平台发布成稿清单进入 artifacts/publish-assets。",
                str(artifact.get("copied_to") or sidecar_member),
            ))
            continue

        payload = _safe_delivery_file_payload(delivery_dir, copied_relative)
        try:
            sidecar = json.loads(payload.decode("utf-8")) if payload is not None else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            sidecar = None
        archive = sidecar.get("archive") if isinstance(sidecar, dict) else None
        generated_paths = archive.get("generatedPaths") if isinstance(archive, dict) else None
        if not isinstance(generated_paths, list):
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-invalid-sidecar",
                "交付目录中的平台发布成稿清单无法解析 archive.generatedPaths。",
                "重新生成当前 slug 的平台发布成稿清单后重新打包。",
                str(copied_relative),
            ))
            continue

        declared_paths = [str(path) for path in generated_paths if isinstance(path, str)]
        opinion_indices = {
            int(match.group(1))
            for path in declared_paths
            for match in [re.search(r"xiaohongshu-(\d+)\.md$", path.replace("\\", "/"))]
            if match
        }
        opinion_count = len(opinion_indices)
        required_paths = {
            str(PUBLISH_ASSET_SOURCE_ROOT / template.format(slug=safe_slug))
            for template in (item[3] for item in publication_contract(opinion_count))
        }
        missing_required_paths = sorted(required_paths - set(declared_paths))
        if missing_required_paths:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-incomplete",
                f"平台发布成稿清单缺少 {len(missing_required_paths)} 项固定交付文件。",
                "重新生成完整 1+3+3+2+2 五平台发布成稿后再打包。",
                "；".join(missing_required_paths[:5]),
            ))
        duplicate_required_paths = sorted(path for path in required_paths if declared_paths.count(path) != 1)
        if duplicate_required_paths:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-incomplete",
                f"平台发布成稿清单没有精确声明每项固定交付文件一次，共 {len(duplicate_required_paths)} 项异常。",
                "重新生成完整的五平台发布成稿清单，避免重复或替代固定交付项。",
                "；".join(duplicate_required_paths[:5]),
            ))

        invalid_paths: list[str] = []
        sensitive_paths: list[str] = []
        missing_members: list[str] = []
        for raw_path in generated_paths:
            target = _platform_publish_asset_destination(raw_path, slug)
            if target is None:
                invalid_paths.append(str(raw_path))
                continue
            if is_sensitive_path(raw_path):
                sensitive_paths.append(str(raw_path))
                continue
            members.add(str(target).replace("\\", "/"))
            actual = _safe_delivery_regular_file_relative(delivery_dir, str(target))
            if actual != target:
                missing_members.append(str(target))

        # The sidecar itself is always copied even when an old producer did not
        # list it in generatedPaths.
        members.add(str(sidecar_member).replace("\\", "/"))
        if invalid_paths:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-rejected",
                f"平台发布成稿清单有 {len(invalid_paths)} 条越界或非法路径。",
                "只保留当前 slug 的 pipeline/publish-assets 生成文件后重新打包。",
                "；".join(invalid_paths[:5]),
            ))
        if sensitive_paths:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-sensitive",
                f"平台发布成稿清单有 {len(sensitive_paths)} 条敏感路径。",
                "移除敏感文件或改用已授权的发布稿后重新打包。",
                "；".join(sensitive_paths[:5]),
            ))
        if missing_members:
            issues.append(issue(
                "blocked",
                "delivery-publish-assets-missing",
                f"平台发布成稿清单声明的 {len(missing_members)} 个文件未进入交付目录。",
                "重新生成缺失发布稿，确认文件落盘并重新打包。",
                "；".join(missing_members[:5]),
            ))
    if not found:
        issues.append(issue(
            "blocked",
            "delivery-publish-assets-missing",
            "交付包未声明当前任务的平台发布成稿清单。",
            "重新生成平台发布成稿后再运行 delivery-pack。",
            str(sidecar_member),
        ))
    return members, issues


DRAFT_QUEUE_SOURCE_ROOT = Path("materials") / "publication" / "drafts"
DRAFT_QUEUE_DELIVERY_ROOT = Path("artifacts") / "publication-draft-queue"


def _safe_queue_source_path(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip() or "\\" in value or "\x00" in value:
        return False
    path = Path(value)
    return not path.is_absolute() and not any(part in {"", ".", ".."} for part in path.parts)


def _queue_job_payload_matches_contract(
    job: dict[str, Any],
    expected_path: str,
) -> list[str]:
    errors: list[str] = []
    item_id = str(job.get("item_id") or "unknown")
    payload = job.get("payload")
    if not isinstance(payload, dict):
        return [f"{item_id} 缺少 payload"]
    if not isinstance(payload.get("title"), str) or not str(payload.get("title") or "").strip():
        errors.append(f"{item_id} 缺少标题")
    copy_path = payload.get("copy_path")
    platform = str(job.get("platform") or "")
    delivery_kind = str(job.get("delivery_kind") or "")
    if platform == "wechat":
        if not _safe_queue_source_path(copy_path):
            errors.append(f"{item_id} 缺少安全的公众号正文路径")
    elif copy_path != expected_path:
        errors.append(f"{item_id} 未绑定固定发布稿")
    if delivery_kind == "execution_package" and payload.get("execution_package_path") != expected_path:
        errors.append(f"{item_id} 未绑定固定视频执行包")
    return errors


def _publication_queue_contract_errors(queue: Any, run_id: str, slug: str) -> list[str]:
    if not isinstance(queue, dict) or queue.get("schema") != DRAFT_QUEUE_SCHEMA:
        return ["草稿队列 schema 无效"]
    errors: list[str] = []
    if run_id and queue.get("run_id") != run_id:
        errors.append("草稿队列 run_id 不属于当前任务")
    if queue.get("run_slug") != safe_name(slug):
        errors.append("草稿队列 run_slug 不属于当前任务")
    if not isinstance(queue.get("queue_id"), str) or not str(queue.get("queue_id") or "").strip():
        errors.append("草稿队列缺少 queue_id")
    if not _safe_queue_source_path(queue.get("package_path")):
        errors.append("草稿队列缺少安全的内容包路径")
    package_sha = queue.get("package_sha256")
    if not isinstance(package_sha, str) or not SHA256_RE.fullmatch(package_sha):
        errors.append("草稿队列缺少有效 package_sha256")

    jobs = queue.get("jobs")
    if not isinstance(jobs, list):
        return errors + ["草稿队列缺少 jobs"]
    opinion_count = opinion_count_from_jobs(jobs)
    contract_items = publication_contract(opinion_count)
    contract_jobs = frozenset(item[:3] for item in contract_items)
    expected_paths = {
        (platform, item_id, delivery_kind): str(PUBLISH_ASSET_SOURCE_ROOT / template.format(slug=safe_name(slug)))
        for platform, item_id, delivery_kind, template in contract_items
    }
    actual_jobs: set[tuple[str, str, str]] = set()
    job_ids: set[str] = set()
    for job in jobs:
        if not isinstance(job, dict):
            errors.append("草稿队列包含非对象任务")
            continue
        contract = (
            str(job.get("platform") or ""),
            str(job.get("item_id") or ""),
            str(job.get("delivery_kind") or ""),
        )
        job_id = job.get("job_id")
        if not isinstance(job_id, str) or not re.fullmatch(r"draft_[a-f0-9]{20}", job_id) or job_id in job_ids:
            errors.append(f"{contract[1] or 'unknown'} 的 job_id 无效")
        elif job_id:
            job_ids.add(job_id)
        if contract not in contract_jobs or contract in actual_jobs:
            errors.append(f"任务不符合当前契约：{'/'.join(contract)}")
            continue
        actual_jobs.add(contract)
        for key in ("payload_hash", "content_hash"):
            value = job.get(key)
            if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
                errors.append(f"{contract[1]} 缺少有效 {key}")
        errors.extend(_queue_job_payload_matches_contract(job, expected_paths[contract]))
    if len(jobs) != len(contract_jobs) or actual_jobs != contract_jobs:
        errors.append(f"草稿队列未精确覆盖 1+{opinion_count}+{opinion_count}+2+2 当前任务")
    return errors


def inspect_publication_draft_queue_delivery_members(
    manifest: dict[str, Any],
    delivery_dir: Path,
) -> tuple[set[str], list[dict[str, Any]]]:
    """Require the exact local 1+3+3+2+2 queue in every formal delivery."""
    members: set[str] = set()
    issues: list[dict[str, Any]] = []
    slug = str(manifest.get("slug") or "").strip()
    run_id = str(manifest.get("run_id") or "").strip()
    if not slug:
        return members, [issue(
            "blocked",
            "delivery-draft-queue-missing",
            "交付包缺少当前任务 slug，无法核验五平台草稿队列。",
            "重新从当前内容生产任务生成交付包。",
        )]

    safe_slug = safe_name(slug)
    expected_source = DRAFT_QUEUE_SOURCE_ROOT / safe_slug / "draft-queue.json"
    expected_member = DRAFT_QUEUE_DELIVERY_ROOT / "draft-queue.json"
    found = False
    for artifact in manifest.get("artifacts", []) or []:
        if not isinstance(artifact, dict) or artifact.get("step") != "publication-draft-queue":
            continue
        found = True
        if artifact.get("source") and str(artifact.get("source")) != str(expected_source):
            issues.append(issue(
                "blocked",
                "delivery-draft-queue-invalid",
                "交付包草稿队列引用了非当前任务来源。",
                "重新生成当前任务的五平台草稿队列后再打包。",
                str(artifact.get("source")),
            ))
        copied = _safe_delivery_regular_file_relative(delivery_dir, artifact.get("copied_to"))
        if copied != expected_member:
            issues.append(issue(
                "blocked",
                "delivery-draft-queue-missing",
                "交付包没有以标准路径包含五平台草稿队列。",
                "重新运行 delivery-pack，确认 draft-queue.json 进入 artifacts/publication-draft-queue。",
                str(artifact.get("copied_to") or expected_member),
            ))
            continue
        members.add(str(expected_member).replace("\\", "/"))
        payload = _safe_delivery_file_payload(delivery_dir, copied)
        try:
            queue = json.loads(payload.decode("utf-8")) if payload is not None else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            queue = None
        contract_errors = _publication_queue_contract_errors(queue, run_id, slug)
        if contract_errors:
            issues.append(issue(
                "blocked",
                "delivery-draft-queue-invalid",
                "交付包中的五平台草稿队列未通过固定 1+3+3+2+2 发布契约校验。",
                "回到发布信息阶段重新生成并确认完整草稿队列。",
                "；".join(contract_errors[:4]),
            ))
    if not found:
        issues.append(issue(
            "blocked",
            "delivery-draft-queue-missing",
            "交付包缺少五平台草稿队列。",
            "先生成平台发布成稿与草稿队列，再运行 delivery-pack。",
            str(expected_source),
        ))
    return members, issues


def _visual_delivery_root(
    manifest: dict[str, Any],
    delivery_dir: Path,
) -> tuple[Path | None, list[str]]:
    errors: list[str] = []
    if delivery_dir.is_symlink():
        return None, ["delivery directory must not use a symlink"]
    visual_artifacts = [
        item
        for item in manifest.get("artifacts", []) or []
        if isinstance(item, dict) and item.get("step") == "visual-assets" and item.get("copied_to")
    ]
    if not visual_artifacts:
        return None, errors
    if len(visual_artifacts) != 1:
        errors.append("manifest must declare exactly one visual-assets delivery root")
        return None, errors

    raw = Path(str(visual_artifacts[0]["copied_to"]))
    if raw.is_absolute():
        try:
            relative = raw.relative_to(delivery_dir)
        except ValueError:
            errors.append("visual-assets delivery root points outside the delivery directory")
            return None, errors
    else:
        relative = raw
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        errors.append("visual-assets delivery root is not a safe relative path")
        return None, errors
    target = delivery_dir / relative
    if not path_inside(delivery_dir, target):
        errors.append("visual-assets delivery root resolves outside the delivery directory")
        return None, errors
    return relative, errors


def _selection_integrity_expectations(
    pointer_payload: bytes,
    visual_root_relative: Path,
    expected_slug: str | None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    try:
        selection = json.loads(pointer_payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return [], None, [f"selected-revision.json is not valid UTF-8 JSON: {exc}"]
    if not isinstance(selection, dict):
        return [], None, ["selected-revision.json must contain a JSON object"]
    if selection.get("schema") != SELECTION_SCHEMA:
        errors.append("selected-revision.json has an unsupported schema")
    slug = selection.get("slug")
    if not isinstance(slug, str) or not SAFE_SLUG_RE.fullmatch(slug):
        errors.append("selected-revision.json has an unsafe slug")
        return [], None, errors
    if expected_slug and slug != expected_slug:
        errors.append("selected-revision.json slug does not match the delivery manifest")
    revision_id = selection.get("revision_id")
    if not isinstance(revision_id, str) or not REVISION_ID_RE.fullmatch(revision_id):
        errors.append("selected-revision.json has an invalid revision_id")
        return [], None, errors
    integrity = selection.get("integrity")
    if not isinstance(integrity, dict) or integrity.get("algorithm") != "sha256":
        errors.append("selected-revision.json requires sha256 integrity metadata")
        return [], None, errors
    records = integrity.get("files")
    if not isinstance(records, list):
        errors.append("selected-revision.json integrity files must be a list")
        return [], None, errors

    source_root = Path("pipeline") / "visual" / slug
    canonical_recipe = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
    canonical_index = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
    canonical_output_prefix = f"pipeline/visual/{slug}/publish/{revision_id}/"
    expectations: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    seen_output_ids: set[str] = set()
    pointer_outputs: list[tuple[str, str]] = []
    pointer_platform_delivery: list[str] = []
    role_counts = {"recipe": 0, "index": 0, "output": 0, "platform_delivery": 0}
    for position, record in enumerate(records):
        if not isinstance(record, dict):
            errors.append(f"selected integrity record {position + 1} must be an object")
            continue
        role = record.get("role")
        if role not in role_counts:
            errors.append(f"selected integrity record {position + 1} has an unsupported role")
            continue
        role_counts[role] += 1
        label = f"selected {role} integrity record {position + 1}"
        source_value = record.get("path")
        if not isinstance(source_value, str) or "\\" in source_value or "\x00" in source_value:
            errors.append(f"{label} has an invalid path")
            continue
        source_relative = Path(source_value)
        if source_relative.is_absolute() or any(part in {"", ".", ".."} for part in source_relative.parts):
            errors.append(f"{label} has an unsafe path")
            continue
        if role == "recipe" and source_value != canonical_recipe:
            errors.append(f"{label} path is not the canonical selected recipe path")
        elif role == "index" and source_value != canonical_index:
            errors.append(f"{label} path is not the canonical selected index path")
        elif role in {"output", "platform_delivery"} and not source_value.startswith(canonical_output_prefix):
            errors.append(f"{label} path is not under the canonical selected publish root")
        try:
            delivery_suffix = source_relative.relative_to(source_root)
        except ValueError:
            errors.append(f"{label} escapes its visual root")
            continue
        size = record.get("size")
        sha256 = record.get("sha256")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            errors.append(f"{label} has an invalid size")
            continue
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            errors.append(f"{label} has an invalid sha256")
            continue
        member_relative = visual_root_relative / delivery_suffix
        member = str(member_relative).replace("\\", "/")
        if member in seen_paths:
            errors.append(f"selected integrity path is duplicated: {source_value}")
            continue
        asset_id = record.get("id") if role == "output" else None
        if role == "output":
            if not isinstance(asset_id, str) or not asset_id:
                errors.append(f"{label} requires a non-empty id")
                continue
            if asset_id in seen_output_ids:
                errors.append(f"selected output integrity id is duplicated: {asset_id}")
                continue
            seen_output_ids.add(asset_id)
            pointer_outputs.append((asset_id, source_value))
        elif role == "platform_delivery":
            pointer_platform_delivery.append(source_value)
        seen_paths.add(member)
        expectations.append({
            "role": role,
            "id": asset_id,
            "member": member,
            "source": source_value,
            "size": size,
            "sha256": sha256,
        })
    if role_counts["recipe"] != 1:
        errors.append("selected-revision.json must bind exactly one recipe")
    if role_counts["index"] != 1:
        errors.append("selected-revision.json must bind exactly one index")
    if role_counts["output"] < 1:
        errors.append("selected-revision.json must bind at least one output")
    if role_counts["platform_delivery"] > 1:
        errors.append("selected-revision.json must bind at most one platform delivery manifest")
    contract = {
        "slug": slug,
        "revision_id": revision_id,
        "recipe_path": canonical_recipe,
        "index_path": canonical_index,
        "outputs": pointer_outputs,
        "platform_delivery_path": pointer_platform_delivery[0] if pointer_platform_delivery else None,
    }
    return expectations, contract, errors


def _asset_semantic_role(asset_id: str) -> str:
    if re.fullmatch(r"wechat-cover(?:-alt-\d+)?", asset_id, re.IGNORECASE):
        return "wechat_cover"
    if re.fullmatch(r"wechat-share(?:-alt-\d+)?", asset_id, re.IGNORECASE):
        return "wechat_share"
    return asset_id


def _safe_asset_manifest_path(value: Any) -> Path | None:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        return None
    relative = Path(value)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        return None
    return relative


def _asset_manifest_expectations(
    manifest_payload: bytes,
    provenance_payload: bytes,
    visual_root_relative: Path,
    expected_slug: str | None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, list[str]]:
    """Build delivery expectations for a mixed per-asset selection.

    Unlike the former whole-revision pointer, the adoption manifest does not
    carry immutable recipe/index digests.  delivery-pack writes a small local
    provenance sidecar with those digests for exactly the adopted assets.
    """
    errors: list[str] = []
    try:
        manifest = json.loads(manifest_payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return [], None, [f"selected-assets.json is not valid UTF-8 JSON: {exc}"]
    if not isinstance(manifest, dict):
        return [], None, ["selected-assets.json must contain a JSON object"]
    if manifest.get("schema") != ASSET_SELECTION_SCHEMA:
        errors.append("selected-assets.json has an unsupported schema")
    slug = manifest.get("slug")
    if not isinstance(slug, str) or not SAFE_SLUG_RE.fullmatch(slug):
        errors.append("selected-assets.json has an unsafe slug")
        return [], None, errors
    if expected_slug and slug != expected_slug:
        errors.append("selected-assets.json slug does not match the delivery manifest")
    source_content_hash = manifest.get("sourceContentHash")
    if not isinstance(source_content_hash, str) or not SHA256_RE.fullmatch(source_content_hash):
        errors.append("selected-assets.json requires a valid sourceContentHash")

    required_roles = manifest.get("requiredRoles")
    selections = manifest.get("selections")
    if (
        not isinstance(required_roles, list)
        or not required_roles
        or not all(isinstance(role, str) and role for role in required_roles)
        or len(set(required_roles)) != len(required_roles)
    ):
        errors.append("selected-assets.json requires unique non-empty requiredRoles")
        required_roles = []
    if not isinstance(selections, dict):
        errors.append("selected-assets.json requires selections")
        selections = {}
    if set(selections) != set(required_roles):
        errors.append("selected-assets.json selections must exactly cover requiredRoles")

    source_root = Path("pipeline") / "visual" / slug
    adopted: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str]] = set()
    seen_paths: set[str] = set()
    for role in required_roles:
        selection = selections.get(role)
        label = f"selected asset {role}"
        if not isinstance(selection, dict):
            errors.append(f"{label} must be an object")
            continue
        asset_id = selection.get("assetId")
        revision_id = selection.get("revisionId")
        source_value = selection.get("path")
        sha256 = selection.get("sha256")
        bindings = selection.get("platformBindings")
        if not isinstance(asset_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", asset_id):
            errors.append(f"{label} has an invalid assetId")
            continue
        if selection.get("semanticRole") != role or _asset_semantic_role(asset_id) != role:
            errors.append(f"{label} semanticRole does not match its assetId")
        if not isinstance(revision_id, str) or not REVISION_ID_RE.fullmatch(revision_id):
            errors.append(f"{label} has an invalid revisionId")
            continue
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            errors.append(f"{label} has an invalid sha256")
            continue
        if (
            not isinstance(bindings, list)
            or not bindings
            or any(not isinstance(item, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,40}", item) for item in bindings)
            or len(set(bindings)) != len(bindings)
        ):
            errors.append(f"{label} requires non-empty unique platformBindings")
        source_relative = _safe_asset_manifest_path(source_value)
        prefix = f"pipeline/visual/{slug}/publish/{revision_id}/"
        if source_relative is None or not isinstance(source_value, str) or not source_value.startswith(prefix):
            errors.append(f"{label} path is not under its selected revision publish root")
            continue
        if (revision_id, asset_id) in seen_keys:
            errors.append(f"{label} duplicates a selected revision asset")
            continue
        if source_value in seen_paths:
            errors.append(f"{label} duplicates a selected asset path")
            continue
        seen_keys.add((revision_id, asset_id))
        seen_paths.add(source_value)
        try:
            delivery_suffix = source_relative.relative_to(source_root)
        except ValueError:
            errors.append(f"{label} escapes its visual root")
            continue
        adopted.append({
            "role": role,
            "asset_id": asset_id,
            "revision_id": revision_id,
            "path": source_value,
            "sha256": sha256,
            "member": str(visual_root_relative / delivery_suffix).replace("\\", "/"),
        })

    try:
        provenance = json.loads(provenance_payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return [], None, errors + [f"selected asset provenance is not valid UTF-8 JSON: {exc}"]
    if not isinstance(provenance, dict):
        return [], None, errors + ["selected asset provenance must contain a JSON object"]
    if provenance.get("schema") != ASSET_SELECTION_PROVENANCE_SCHEMA:
        errors.append("selected asset provenance has an unsupported schema")
    if provenance.get("slug") != slug:
        errors.append("selected asset provenance slug does not match selected-assets.json")
    source_manifest = provenance.get("source_manifest")
    canonical_manifest = f"pipeline/visual/{slug}/selected-assets.json"
    if not isinstance(source_manifest, dict):
        errors.append("selected asset provenance requires source_manifest")
    else:
        manifest_size = source_manifest.get("size")
        manifest_sha256 = source_manifest.get("sha256")
        if source_manifest.get("path") != canonical_manifest:
            errors.append("selected asset provenance source_manifest path is not canonical")
        if not isinstance(manifest_size, int) or isinstance(manifest_size, bool) or manifest_size <= 0:
            errors.append("selected asset provenance source_manifest has an invalid size")
        elif manifest_size != len(manifest_payload):
            errors.append("selected asset provenance source_manifest size does not match selected-assets.json")
        if not isinstance(manifest_sha256, str) or not SHA256_RE.fullmatch(manifest_sha256):
            errors.append("selected asset provenance source_manifest has an invalid sha256")
        elif manifest_sha256 != hashlib.sha256(manifest_payload).hexdigest():
            errors.append("selected asset provenance source_manifest sha256 does not match selected-assets.json")

    files = provenance.get("files")
    if not isinstance(files, list):
        errors.append("selected asset provenance files must be a list")
        files = []
    expected_records: list[dict[str, Any]] = []
    expected_by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    revisions = sorted({item["revision_id"] for item in adopted})
    adopted_by_key = {(item["revision_id"], item["asset_id"]): item for item in adopted}
    seen_records: set[tuple[str, str, str]] = set()
    for position, record in enumerate(files):
        if not isinstance(record, dict):
            errors.append(f"selected asset provenance record {position + 1} must be an object")
            continue
        role = record.get("role")
        revision_id = record.get("revision_id")
        source_value = record.get("path")
        size = record.get("size")
        sha256 = record.get("sha256")
        if role not in {"recipe", "index", "output"}:
            errors.append(f"selected asset provenance record {position + 1} has an unsupported role")
            continue
        if not isinstance(revision_id, str) or not REVISION_ID_RE.fullmatch(revision_id):
            errors.append(f"selected asset provenance record {position + 1} has an invalid revision_id")
            continue
        if revision_id not in revisions:
            errors.append(f"selected asset provenance record {position + 1} references an unselected revision")
            continue
        source_relative = _safe_asset_manifest_path(source_value)
        if source_relative is None or not isinstance(source_value, str):
            errors.append(f"selected asset provenance record {position + 1} has an unsafe path")
            continue
        canonical_path = (
            f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
            if role == "recipe"
            else f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
            if role == "index"
            else None
        )
        asset_id = record.get("id") if role == "output" else ""
        if role in {"recipe", "index"}:
            if source_value != canonical_path:
                errors.append(f"selected asset provenance {role} path is not canonical")
        else:
            adopted_asset = adopted_by_key.get((revision_id, asset_id)) if isinstance(asset_id, str) else None
            if adopted_asset is None:
                errors.append(f"selected asset provenance output does not match an adopted asset")
                continue
            if source_value != adopted_asset["path"]:
                errors.append(f"selected asset provenance output path does not match selected-assets.json")
            if sha256 != adopted_asset["sha256"]:
                errors.append(f"selected asset provenance output sha256 does not match selected-assets.json")
            if record.get("semantic_role") != adopted_asset["role"]:
                errors.append(f"selected asset provenance output semantic_role does not match selected-assets.json")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            errors.append(f"selected asset provenance record {position + 1} has an invalid size")
            continue
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            errors.append(f"selected asset provenance record {position + 1} has an invalid sha256")
            continue
        try:
            delivery_suffix = source_relative.relative_to(source_root)
        except ValueError:
            errors.append(f"selected asset provenance record {position + 1} escapes its visual root")
            continue
        record_key = (str(role), revision_id, str(asset_id))
        if record_key in seen_records:
            errors.append(f"selected asset provenance record is duplicated: {role}/{revision_id}/{asset_id}")
            continue
        seen_records.add(record_key)
        expected = {
            "role": role,
            "revision_id": revision_id,
            "id": asset_id if role == "output" else None,
            "semantic_role": record.get("semantic_role") if role == "output" else None,
            "source": source_value,
            "member": str(visual_root_relative / delivery_suffix).replace("\\", "/"),
            "size": size,
            "sha256": sha256,
        }
        expected_records.append(expected)
        expected_by_key[record_key] = expected

    for revision_id in revisions:
        for role in ("recipe", "index"):
            if (role, revision_id, "") not in expected_by_key:
                errors.append(f"selected asset provenance is missing {role} for revision {revision_id}")
    for adopted_asset in adopted:
        key = ("output", adopted_asset["revision_id"], adopted_asset["asset_id"])
        if key not in expected_by_key:
            errors.append(
                "selected asset provenance is missing adopted output: "
                f"{adopted_asset['revision_id']}/{adopted_asset['asset_id']}"
            )
    contract = {
        "slug": slug,
        "source_content_hash": source_content_hash,
        "adopted": adopted,
        "revisions": revisions,
        "expected_by_key": expected_by_key,
    }
    return expected_records, contract, errors


def _validate_bound_asset_manifest_documents(
    contract: dict[str, Any] | None,
    payloads: dict[tuple[str, str], bytes | None],
) -> list[str]:
    if contract is None:
        return []
    errors: list[str] = []
    slug = str(contract["slug"])
    adopted = list(contract.get("adopted") or [])
    expected_by_key = contract.get("expected_by_key") or {}
    for revision_id in contract.get("revisions") or []:
        recipe_payload = payloads.get(("recipe", revision_id))
        index_payload = payloads.get(("index", revision_id))
        recipe = _parse_bound_visual_document(recipe_payload, f"asset recipe {revision_id}", errors)
        index = _parse_bound_visual_document(index_payload, f"asset index {revision_id}", errors)
        recipe_path = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
        index_path = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
        revision_assets = [item for item in adopted if item.get("revision_id") == revision_id]
        if recipe is not None:
            if recipe.get("schema") not in {"aifios.visual-recipe.v1", "aifios.visual-recipe.v2"}:
                errors.append(f"selected asset recipe {revision_id} has an unsupported schema")
            if recipe.get("slug") != slug or recipe.get("revision_id") != revision_id:
                errors.append(f"selected asset recipe {revision_id} does not match selected-assets.json")
            source_package = recipe.get("source_package")
            if _safe_asset_manifest_path(source_package) is None:
                errors.append(f"selected asset recipe {revision_id} has an unsafe source_package")
            recipe_ids = {
                item.get("id")
                for item in recipe.get("assets", [])
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            for adopted_asset in revision_assets:
                if adopted_asset.get("asset_id") not in recipe_ids:
                    errors.append(
                        f"selected asset recipe {revision_id} does not declare {adopted_asset.get('asset_id')}"
                    )
        if index is not None:
            if index.get("schema") != "aifios.visual-publish.v1":
                errors.append(f"selected asset index {revision_id} has an unsupported schema")
            if index.get("slug") != slug or index.get("revision_id") != revision_id:
                errors.append(f"selected asset index {revision_id} does not match selected-assets.json")
            if index.get("legacy") is not False or index.get("status") != "generated":
                errors.append(f"selected asset index {revision_id} is not a generated non-legacy release")
            if index.get("recipe_path") != recipe_path or index.get("revision_index_path") != index_path:
                errors.append(f"selected asset index {revision_id} has stale recipe/index provenance")
            summary = index.get("quality_summary")
            if isinstance(summary, dict) and summary.get("status") not in (None, "pass"):
                errors.append(f"selected asset index {revision_id} did not pass its quality summary")
            outputs = index.get("outputs")
            if not isinstance(outputs, list):
                errors.append(f"selected asset index {revision_id} outputs must be a list")
                outputs = []
            for adopted_asset in revision_assets:
                asset_id = adopted_asset.get("asset_id")
                matches = [
                    output for output in outputs
                    if isinstance(output, dict) and output.get("id") == asset_id
                ]
                if len(matches) != 1:
                    errors.append(f"selected asset index {revision_id} must contain exactly one output for {asset_id}")
                    continue
                output = matches[0]
                record = expected_by_key.get(("output", revision_id, asset_id))
                if (
                    output.get("output") != adopted_asset.get("path")
                    or output.get("sha256") != adopted_asset.get("sha256")
                    or output.get("revision_id") != revision_id
                    or output.get("recipe_path") != recipe_path
                    or output.get("status") != "generated"
                    or output.get("renderer") != "local"
                ):
                    errors.append(f"selected asset index {revision_id} output provenance does not match {asset_id}")
                if not isinstance(record, dict):
                    continue
                if output.get("size") != record.get("size") or output.get("sha256") != record.get("sha256"):
                    errors.append(f"selected asset index {revision_id} output digest does not match {asset_id}")
                quality = output.get("quality")
                if isinstance(quality, str) and quality not in {"", "pass"}:
                    errors.append(f"selected asset index {revision_id} output did not pass quality: {asset_id}")
    return errors


def _parse_bound_visual_document(
    payload: bytes | None,
    label: str,
    errors: list[str],
) -> dict[str, Any] | None:
    if payload is None:
        return None
    try:
        document = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"selected {label} is not valid UTF-8 JSON: {exc}")
        return None
    if not isinstance(document, dict):
        errors.append(f"selected {label} must contain a JSON object")
        return None
    return document


def _validate_bound_visual_documents(
    contract: dict[str, Any] | None,
    recipe_payload: bytes | None,
    index_payload: bytes | None,
    platform_delivery_payload: bytes | None,
) -> list[str]:
    if contract is None:
        return []
    errors: list[str] = []
    recipe = _parse_bound_visual_document(recipe_payload, "recipe", errors)
    index = _parse_bound_visual_document(index_payload, "index", errors)
    platform_delivery = _parse_bound_visual_document(
        platform_delivery_payload,
        "platform delivery manifest",
        errors,
    )
    slug = contract["slug"]
    revision_id = contract["revision_id"]

    if recipe is not None:
        if recipe.get("slug") != slug:
            errors.append("selected recipe slug does not match selected-revision.json")
        if recipe.get("revision_id") != revision_id:
            errors.append("selected recipe revision_id does not match selected-revision.json")

    if index is not None:
        if index.get("slug") != slug:
            errors.append("selected index slug does not match selected-revision.json")
        if index.get("revision_id") != revision_id:
            errors.append("selected index revision_id does not match selected-revision.json")
        if index.get("recipe_path") != contract["recipe_path"]:
            errors.append("selected index recipe_path is not the canonical selected recipe path")
        if index.get("revision_index_path") != contract["index_path"]:
            errors.append("selected index revision_index_path is not the canonical selected index path")

        index_outputs = index.get("outputs")
        index_output_refs: set[tuple[str, str]] = set()
        if not isinstance(index_outputs, list):
            errors.append("selected index outputs must be a list")
        else:
            for position, output in enumerate(index_outputs):
                if not isinstance(output, dict):
                    errors.append(f"selected index output {position + 1} must be an object")
                    continue
                asset_id = output.get("id")
                output_path = output.get("output")
                if (
                    not isinstance(asset_id, str)
                    or not asset_id
                    or not isinstance(output_path, str)
                    or not output_path
                ):
                    errors.append(f"selected index output {position + 1} requires id and output")
                    continue
                reference = (asset_id, output_path)
                if reference in index_output_refs:
                    errors.append(f"selected index output is duplicated: {asset_id}")
                    continue
                index_output_refs.add(reference)
        if index_output_refs != set(contract["outputs"]):
            errors.append("selected index outputs do not exactly match selected-revision.json output records")
        index_platform_delivery = index.get("platform_delivery_manifest")
        if index_platform_delivery is not None and not isinstance(index_platform_delivery, str):
            errors.append("selected index platform_delivery_manifest must be a string")
        elif index_platform_delivery != contract["platform_delivery_path"]:
            errors.append("selected index platform_delivery_manifest does not match selected-revision.json")

    if contract["platform_delivery_path"] is not None and platform_delivery is not None:
        if platform_delivery.get("schema") != "aifios.platform-visual-delivery.v1":
            errors.append("selected platform delivery manifest has an unsupported schema")
        if platform_delivery.get("slug") != slug:
            errors.append("selected platform delivery manifest slug does not match selected-revision.json")
        if platform_delivery.get("revision_id") != revision_id:
            errors.append("selected platform delivery manifest revision_id does not match selected-revision.json")
    return errors


def _safe_delivery_file_digest(
    delivery_dir: Path,
    relative: Path,
) -> tuple[int, str] | None:
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        return None
    current = delivery_dir
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return None
    if not path_inside(delivery_dir, current) or not current.is_file():
        return None
    digest = hashlib.sha256()
    size = 0
    try:
        with current.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
    except OSError:
        return None
    return size, digest.hexdigest()


def _safe_delivery_file_payload(delivery_dir: Path, relative: Path) -> bytes | None:
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        return None
    current = delivery_dir
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return None
    if not path_inside(delivery_dir, current) or not current.is_file():
        return None
    try:
        payload = current.read_bytes()
    except OSError:
        return None
    if current.is_symlink() or not path_inside(delivery_dir, current):
        return None
    return payload


def _directory_has_selected_visual_markers(visual_root: Path) -> bool:
    if (visual_root / "recipes").exists() or (visual_root / "revisions").exists():
        return True
    publish_root = visual_root / "publish"
    if publish_root.is_symlink():
        return True
    try:
        return publish_root.is_dir() and any(
            child.is_dir() and re.fullmatch(r"r\d{3,}", child.name)
            for child in publish_root.iterdir()
        )
    except OSError:
        return True


def _inspect_delivery_selected_asset_manifest_integrity(
    manifest: dict[str, Any],
    delivery_dir: Path,
    visual_root_relative: Path,
) -> tuple[list[str], dict[str, bytes] | None]:
    errors: list[str] = []
    asset_manifest_relative = visual_root_relative / "selected-assets.json"
    provenance_relative = visual_root_relative / "selected-assets.provenance.json"
    asset_manifest_payload = _safe_delivery_file_payload(delivery_dir, asset_manifest_relative)
    if asset_manifest_payload is None:
        return ["selected-assets.json is missing, unreadable, or uses a symlink"], None
    provenance_payload = _safe_delivery_file_payload(delivery_dir, provenance_relative)
    if provenance_payload is None:
        return ["selected asset delivery is missing selected-assets.provenance.json"], None
    expectations, contract, selection_errors = _asset_manifest_expectations(
        asset_manifest_payload,
        provenance_payload,
        visual_root_relative,
        str(manifest.get("slug") or "") or None,
    )
    errors.extend(selection_errors)
    allowed_members = {
        str(asset_manifest_relative).replace("\\", "/"),
        str(provenance_relative).replace("\\", "/"),
        *(str(expected["member"]) for expected in expectations),
    }
    visual_root = delivery_dir / visual_root_relative
    try:
        candidates = list(visual_root.rglob("*"))
    except OSError:
        candidates = []
        errors.append("selected asset visual delivery root cannot be traversed")
    extras = [
        str(candidate.relative_to(delivery_dir)).replace("\\", "/")
        for candidate in candidates
        if (candidate.is_file() or candidate.is_symlink())
        and str(candidate.relative_to(delivery_dir)).replace("\\", "/") not in allowed_members
    ]
    if extras:
        errors.append("selected asset delivery contains unadopted visual members: " + ", ".join(sorted(extras)[:5]))
    document_payloads: dict[tuple[str, str], bytes | None] = {}
    for expected in expectations:
        member = Path(str(expected["member"]))
        role = str(expected["role"])
        revision_id = str(expected["revision_id"])
        if role in {"recipe", "index"}:
            payload = _safe_delivery_file_payload(delivery_dir, member)
            document_payloads[(role, revision_id)] = payload
            actual = (len(payload), hashlib.sha256(payload).hexdigest()) if payload is not None else None
        else:
            actual = _safe_delivery_file_digest(delivery_dir, member)
        if actual is None:
            errors.append(
                f"selected asset {role} integrity file is missing, unreadable, or uses a symlink: {member}"
            )
            continue
        if actual != (expected["size"], expected["sha256"]):
            errors.append(f"selected asset {role} integrity file size/sha256 mismatch: {member}")
    errors.extend(_validate_bound_asset_manifest_documents(contract, document_payloads))
    return errors, {
        "selected-assets.json": asset_manifest_payload,
        "selected-assets.provenance.json": provenance_payload,
    }


def _inspect_delivery_selected_visual_integrity(
    manifest: dict[str, Any],
    delivery_dir: Path,
) -> tuple[list[str], dict[str, bytes] | None]:
    visual_root_relative, errors = _visual_delivery_root(manifest, delivery_dir)
    if visual_root_relative is None:
        return errors, None
    visual_root = delivery_dir / visual_root_relative
    asset_manifest_relative = visual_root_relative / "selected-assets.json"
    asset_manifest_path = delivery_dir / asset_manifest_relative
    if asset_manifest_path.exists() or asset_manifest_path.is_symlink():
        return _inspect_delivery_selected_asset_manifest_integrity(
            manifest,
            delivery_dir,
            visual_root_relative,
        )
    pointer_relative = visual_root_relative / "selected-revision.json"
    pointer_path = delivery_dir / pointer_relative
    if not pointer_path.exists() and not pointer_path.is_symlink():
        if _directory_has_selected_visual_markers(visual_root):
            errors.append("selected visual delivery is missing selected-revision.json")
        return errors, None
    pointer_payload = _safe_delivery_file_payload(delivery_dir, pointer_relative)
    if pointer_payload is None:
        errors.append("selected-revision.json is missing, unreadable, or uses a symlink")
        return errors, None

    expectations, contract, pointer_errors = _selection_integrity_expectations(
        pointer_payload,
        visual_root_relative,
        str(manifest.get("slug") or "") or None,
    )
    errors.extend(pointer_errors)
    document_payloads: dict[str, bytes | None] = {
        "recipe": None,
        "index": None,
        "platform_delivery": None,
    }
    for expected in expectations:
        if expected["role"] in document_payloads:
            payload = _safe_delivery_file_payload(delivery_dir, Path(expected["member"]))
            document_payloads[expected["role"]] = payload
            actual = (
                (len(payload), hashlib.sha256(payload).hexdigest())
                if payload is not None
                else None
            )
        else:
            actual = _safe_delivery_file_digest(delivery_dir, Path(expected["member"]))
        if actual is None:
            errors.append(
                f"selected {expected['role']} integrity file is missing, unreadable, or uses a symlink: "
                f"{expected['member']}"
            )
            continue
        if actual != (expected["size"], expected["sha256"]):
            errors.append(
                f"selected {expected['role']} integrity file size/sha256 mismatch: {expected['member']}"
            )
    errors.extend(_validate_bound_visual_documents(
        contract,
        document_payloads["recipe"],
        document_payloads["index"],
        document_payloads["platform_delivery"],
    ))
    return errors, {"selected-revision.json": pointer_payload}


def _inspect_zip_selected_asset_manifest_integrity(
    manifest: dict[str, Any],
    archive: zipfile.ZipFile,
    visual_root_relative: Path,
    infos_by_name: dict[str, list[zipfile.ZipInfo]],
    disk_selection_payloads: dict[str, bytes] | None,
) -> list[str]:
    errors: list[str] = []
    visual_prefix = str(visual_root_relative).replace("\\", "/").rstrip("/")
    members = {
        "selected-assets.json": f"{visual_prefix}/selected-assets.json",
        "selected-assets.provenance.json": f"{visual_prefix}/selected-assets.provenance.json",
    }
    payloads: dict[str, bytes] = {}
    for label, member in members.items():
        infos = infos_by_name.get(member, [])
        if len(infos) != 1:
            reason = "missing" if not infos else "duplicated"
            errors.append(f"zip {label} is {reason}")
            continue
        info = infos[0]
        if stat.S_ISLNK(info.external_attr >> 16):
            errors.append(f"zip {label} must not be a symlink")
            continue
        try:
            payload = archive.read(info)
        except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
            errors.append(f"zip {label} cannot be read: {exc}")
            continue
        payloads[label] = payload
        disk_payload = (disk_selection_payloads or {}).get(label)
        if disk_payload is not None and payload != disk_payload:
            errors.append(f"zip {label} differs from the delivery directory copy")
    if set(payloads) != set(members):
        return errors

    expectations, contract, selection_errors = _asset_manifest_expectations(
        payloads["selected-assets.json"],
        payloads["selected-assets.provenance.json"],
        visual_root_relative,
        str(manifest.get("slug") or "") or None,
    )
    errors.extend(selection_errors)
    allowed_members = {
        *members.values(),
        *(str(expected["member"]) for expected in expectations),
    }
    extras = [
        name
        for name, rows in infos_by_name.items()
        if name.startswith(f"{visual_prefix}/")
        and not name.endswith("/")
        and name not in allowed_members
        and rows
    ]
    if extras:
        errors.append("zip selected asset delivery contains unadopted visual members: " + ", ".join(sorted(extras)[:5]))
    document_payloads: dict[tuple[str, str], bytes | None] = {}
    for expected in expectations:
        member = str(expected["member"])
        infos = infos_by_name.get(member, [])
        role = str(expected["role"])
        revision_id = str(expected["revision_id"])
        if len(infos) != 1:
            reason = "missing" if not infos else "duplicated"
            errors.append(f"zip selected asset {role} integrity file is {reason}: {member}")
            continue
        info = infos[0]
        if stat.S_ISLNK(info.external_attr >> 16):
            errors.append(f"zip selected asset {role} integrity file must not be a symlink: {member}")
            continue
        try:
            if role in {"recipe", "index"}:
                payload = archive.read(info)
                document_payloads[(role, revision_id)] = payload
                size = len(payload)
                actual_sha256 = hashlib.sha256(payload).hexdigest()
            else:
                digest = hashlib.sha256()
                size = 0
                with archive.open(info, "r") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        size += len(chunk)
                        digest.update(chunk)
                actual_sha256 = digest.hexdigest()
        except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
            errors.append(f"zip selected asset {role} integrity file cannot be read: {member}: {exc}")
            continue
        if size != expected["size"] or actual_sha256 != expected["sha256"]:
            errors.append(f"zip selected asset {role} integrity file size/sha256 mismatch: {member}")
    errors.extend(_validate_bound_asset_manifest_documents(contract, document_payloads))
    return errors


def _inspect_zip_selected_visual_integrity(
    manifest: dict[str, Any],
    delivery_dir: Path,
    archive: zipfile.ZipFile,
    disk_selection_payloads: dict[str, bytes] | None,
) -> list[str]:
    visual_root_relative, errors = _visual_delivery_root(manifest, delivery_dir)
    if visual_root_relative is None:
        return errors
    visual_prefix = str(visual_root_relative).replace("\\", "/").rstrip("/")
    asset_manifest_member = f"{visual_prefix}/selected-assets.json"
    pointer_member = f"{visual_prefix}/selected-revision.json"
    infos_by_name: dict[str, list[zipfile.ZipInfo]] = {}
    for info in archive.infolist():
        infos_by_name.setdefault(info.filename, []).append(info)
    if asset_manifest_member in infos_by_name:
        return _inspect_zip_selected_asset_manifest_integrity(
            manifest,
            archive,
            visual_root_relative,
            infos_by_name,
            disk_selection_payloads,
        )
    if (disk_selection_payloads or {}).get("selected-assets.json") is not None:
        return ["zip selected asset delivery is missing selected-assets.json"]
    pointer_infos = infos_by_name.get(pointer_member, [])
    if not pointer_infos:
        selected_markers = (
            f"{visual_prefix}/recipes/",
            f"{visual_prefix}/revisions/",
        )
        selected_publish_re = re.compile(rf"^{re.escape(visual_prefix)}/publish/r\d{{3,}}/")
        if any(
            any(name.startswith(prefix) for prefix in selected_markers) or selected_publish_re.match(name)
            for name in infos_by_name
        ):
            errors.append("zip selected visual delivery is missing selected-revision.json")
        return errors
    if len(pointer_infos) != 1:
        errors.append("zip contains duplicate selected-revision.json entries")
        return errors
    pointer_info = pointer_infos[0]
    if stat.S_ISLNK(pointer_info.external_attr >> 16):
        errors.append("zip selected-revision.json must not be a symlink")
        return errors
    try:
        pointer_payload = archive.read(pointer_info)
    except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
        errors.append(f"zip selected-revision.json cannot be read: {exc}")
        return errors
    disk_pointer_payload = (disk_selection_payloads or {}).get("selected-revision.json")
    if disk_pointer_payload is not None and pointer_payload != disk_pointer_payload:
        errors.append("zip selected-revision.json differs from the delivery directory pointer")

    expectations, contract, pointer_errors = _selection_integrity_expectations(
        pointer_payload,
        visual_root_relative,
        str(manifest.get("slug") or "") or None,
    )
    errors.extend(pointer_errors)
    document_payloads: dict[str, bytes | None] = {
        "recipe": None,
        "index": None,
        "platform_delivery": None,
    }
    for expected in expectations:
        member = expected["member"]
        infos = infos_by_name.get(member, [])
        if len(infos) != 1:
            reason = "missing" if not infos else "duplicated"
            errors.append(f"zip selected {expected['role']} integrity file is {reason}: {member}")
            continue
        info = infos[0]
        if stat.S_ISLNK(info.external_attr >> 16):
            errors.append(f"zip selected {expected['role']} integrity file must not be a symlink: {member}")
            continue
        if expected["role"] in document_payloads:
            try:
                payload = archive.read(info)
            except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                errors.append(
                    f"zip selected {expected['role']} integrity file cannot be read: {member}: {exc}"
                )
                continue
            document_payloads[expected["role"]] = payload
            size = len(payload)
            actual_sha256 = hashlib.sha256(payload).hexdigest()
        else:
            digest = hashlib.sha256()
            size = 0
            try:
                with archive.open(info, "r") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        size += len(chunk)
                        digest.update(chunk)
            except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
                errors.append(
                    f"zip selected {expected['role']} integrity file cannot be read: {member}: {exc}"
                )
                continue
            actual_sha256 = digest.hexdigest()
        if size != expected["size"] or actual_sha256 != expected["sha256"]:
            errors.append(f"zip selected {expected['role']} integrity file size/sha256 mismatch: {member}")
    errors.extend(_validate_bound_visual_documents(
        contract,
        document_payloads["recipe"],
        document_payloads["index"],
        document_payloads["platform_delivery"],
    ))
    return errors


def inspect_delivery_package_integrity(manifest: dict[str, Any], delivery_dir: Path, zip_path: str | None) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    disk_manifest = manifest
    manifest_path = delivery_dir / "manifest.json"
    if manifest_path.exists():
        try:
            disk_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            disk_manifest = manifest
    scope = disk_manifest.get("manifest_scope")
    gate = disk_manifest.get("delivery_gate") or {}
    zip_exists = bool(zip_path and Path(zip_path).exists())
    if scope == FORMAL_DELIVERY_SCOPE:
        raw_platforms = disk_manifest.get("platforms")
        normalized_platforms = [
            "xiaohongshu" if str(platform).strip() == "xhs" else str(platform).strip()
            for platform in raw_platforms
        ] if isinstance(raw_platforms, list) else []
        if not disk_manifest.get("selected_platform_contract") and (
            len(normalized_platforms) != len(REQUIRED_DELIVERY_PLATFORMS)
            or set(normalized_platforms) != REQUIRED_DELIVERY_PLATFORMS
        ):
            issues.append(issue(
                "blocked",
                "delivery-platform-contract-invalid",
                "正式交付包没有精确覆盖公众号、小红书、朋友圈、视频号和抖音。",
                "回到发布信息阶段重新生成完整五平台队列和交付包。",
            ))
        if gate.get("status") != "pass" or gate.get("can_deliver") is not True:
            issues.append(issue(
                "blocked",
                "delivery-formal-gate-failed",
                "交付目录被标记为正式交付，但其交付门禁并未通过。",
                "重新运行 delivery-audit，只有门禁通过后才能生成正式 ZIP。",
            ))
        if not zip_exists:
            issues.append(issue(
                "blocked",
                "delivery-formal-zip-missing",
                "正式交付目录缺少 ZIP，不能作为可分发交付包。",
                "在门禁通过后重新运行 delivery-pack 生成正式 ZIP。",
            ))
    elif scope == INTERNAL_REVIEW_SCOPE:
        marker_ok, _marker_reason = delivery_member_exists(delivery_dir, INTERNAL_REVIEW_MARKER)
        if not marker_ok:
            issues.append(issue(
                "blocked",
                "delivery-internal-review-marker-missing",
                "内部复核目录缺少“禁止直接交付”标识文件。",
                "重新运行 delivery-pack，确保内部复核资料带有明确标识。",
                INTERNAL_REVIEW_MARKER,
            ))
        if zip_exists:
            issues.append(issue(
                "blocked",
                "delivery-internal-review-zip",
                "未通过门禁的内部复核目录不应存在可误发的 ZIP。",
                "删除该 ZIP 并在门禁通过后重新生成正式交付包。",
                str(zip_path),
            ))
    else:
        issues.append(issue(
            "blocked",
            "delivery-manifest-scope-invalid",
            "交付包未声明可识别的正式交付或内部复核范围。",
            "重新运行 delivery-pack，写入正确的 manifest_scope 后再审查。",
            str(scope or "missing"),
        ))
    missing_customer_files = []
    for rel in REQUIRED_CUSTOMER_FILES:
        ok, reason = delivery_member_exists(delivery_dir, rel)
        if not ok:
            missing_customer_files.append(f"{rel}（{reason}）")
    if missing_customer_files:
        issues.append(issue(
            "blocked",
            "delivery-pack-incomplete",
            f"交付包缺少 {len(missing_customer_files)} 个客户必读文件。",
            "重新运行 `delivery-pack`，确认 README、客户成果报告、修改意见和隐私清单完整生成。",
            "；".join(missing_customer_files[:5]),
        ))

    absolute_hits = absolute_local_path_hits(manifest)
    if absolute_hits:
        issues.append(issue(
            "blocked",
            "delivery-pack-local-path-leak",
            "交付包 manifest 泄露本机绝对路径。",
            "重新生成交付包，确保 manifest 只保留相对路径和客户可读信息。",
            "；".join(absolute_hits[:5]),
        ))

    missing_manifest_files: list[str] = []
    for artifact in manifest.get("artifacts", []) or []:
        copied = artifact.get("copied_to")
        if copied:
            ok, reason = delivery_member_exists(delivery_dir, copied)
            if not ok:
                missing_manifest_files.append(f"{copied}（{reason}）")
        for file_path in artifact.get("files") or []:
            ok, reason = delivery_member_exists(delivery_dir, file_path)
            if not ok:
                missing_manifest_files.append(f"{file_path}（{reason}）")
    for report_path in manifest.get("reports", []) or []:
        ok, reason = delivery_member_exists(delivery_dir, report_path)
        if not ok:
            missing_manifest_files.append(f"{report_path}（{reason}）")
    if missing_manifest_files:
        issues.append(issue(
            "blocked",
            "delivery-manifest-missing-file",
            f"manifest 声明了 {len(missing_manifest_files)} 个不存在或不可用的交付文件。",
            "删除失效 manifest 条目或重新打包，确保 manifest 中每个 copied_to/files/reports 都能在交付目录中打开。",
            "；".join(missing_manifest_files[:5]),
        ))

    native_contract = disk_manifest.get("selected_platform_contract")
    if native_contract:
        native_files = native_contract.get("files") if isinstance(native_contract, dict) else None
        platform_publish_members = {p for p in native_files if p.startswith("artifacts/publish-assets/")} if isinstance(native_files, dict) else set()
        platform_publish_issues = []
        draft_queue_members = {"artifacts/publication-draft-queue/draft-queue.json"}
        draft_queue_issues = []
        for error in native_delivery.inspect_bundle(disk_manifest, delivery_dir, zip_path):
            issues.append(issue("blocked", "selected-platform-integrity", error, "重新核对本期成品后运行交付审查。"))
    else:
        platform_publish_members, platform_publish_issues = inspect_platform_publish_asset_delivery_members(disk_manifest, delivery_dir)
        draft_queue_members, draft_queue_issues = inspect_publication_draft_queue_delivery_members(disk_manifest, delivery_dir)
    issues.extend(inspect_platform_publish_asset_manifest(disk_manifest))
    issues.extend(platform_publish_issues)
    issues.extend(draft_queue_issues)

    visual_integrity_errors, disk_pointer_payload = _inspect_delivery_selected_visual_integrity(
        disk_manifest,
        delivery_dir,
    )
    if visual_integrity_errors:
        issues.append(issue(
            "blocked",
            "delivery-visual-integrity-mismatch",
            "交付目录中的已选视觉资产未通过采用清单完整性校验。",
            "不要手工修改交付资产；重新运行 `delivery-pack`，并再次执行 delivery-audit。",
            "；".join(visual_integrity_errors[:5]),
        ))

    gate = disk_manifest.get("delivery_gate") or {}
    actions = gate.get("recommended_actions") or []
    gate_status = gate.get("status")
    if gate_status in {"blocked", "review_required", "not_audited"} and not actions:
        issues.append(issue(
            "blocked",
            "delivery-actions-missing",
            "交付包门禁非通过状态，但 manifest 缺少 recommended_actions。",
            "重新运行 `delivery-audit AUTO_PACK=1`，确保阻断/复核状态同时给出可执行建议动作。",
            gate_status,
        ))
    malformed_actions = []
    for index, item in enumerate(actions):
        missing_fields = [
            field for field in ("id", "title", "owner", "severity", "issue_count", "command", "summary")
            if not item.get(field)
        ]
        if missing_fields:
            malformed_actions.append(f"recommended_actions[{index}] 缺少 {','.join(missing_fields)}")
    if malformed_actions:
        issues.append(issue(
            "blocked",
            "delivery-actions-malformed",
            f"交付包 recommended_actions 有 {len(malformed_actions)} 条结构不完整。",
            "重新生成交付包，确保每个建议动作包含 id/title/owner/severity/issue_count/command/summary。",
            "；".join(malformed_actions[:5]),
        ))
    if actions:
        missing_action_docs = []
        first_title = str((actions[0] or {}).get("title") or "")
        for rel in ("README.md", "客户成果报告.md"):
            path = delivery_dir / rel
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            if "建议动作" not in text or (first_title and first_title not in text):
                missing_action_docs.append(rel)
        if missing_action_docs:
            issues.append(issue(
                "blocked",
                "delivery-actions-doc-missing",
                "交付包 manifest 已包含建议动作，但客户可读文档没有同步展示。",
                "重新运行 `delivery-pack`，确保 README 和客户成果报告都包含“建议动作”并展示动作标题与执行命令。",
                "；".join(missing_action_docs),
            ))

    if zip_path and Path(zip_path).exists():
        zip_visual_integrity_errors: list[str] = []
        zip_platform_publish_errors: list[str] = []
        zip_draft_queue_errors: list[str] = []
        try:
            with zipfile.ZipFile(zip_path) as archive:
                names = set(archive.namelist())
                infos_by_name: dict[str, list[zipfile.ZipInfo]] = {}
                for info in archive.infolist():
                    infos_by_name.setdefault(info.filename, []).append(info)
                zip_manifest = None
                if "manifest.json" in names:
                    try:
                        zip_manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
                    except Exception:
                        zip_manifest = {"_invalid": True}
                zip_visual_integrity_errors = _inspect_zip_selected_visual_integrity(
                    disk_manifest,
                    delivery_dir,
                    archive,
                    disk_pointer_payload,
                )
                for member in sorted(platform_publish_members):
                    infos = infos_by_name.get(member, [])
                    if len(infos) != 1:
                        reason = "缺失" if not infos else "重复"
                        zip_platform_publish_errors.append(f"{reason}：{member}")
                        continue
                    info = infos[0]
                    if stat.S_ISLNK(info.external_attr >> 16):
                        zip_platform_publish_errors.append(f"符号链接：{member}")
                    elif info.is_dir() or info.file_size <= 0:
                        zip_platform_publish_errors.append(f"为空或不是普通文件：{member}")
                for member in sorted(draft_queue_members):
                    infos = infos_by_name.get(member, [])
                    if len(infos) != 1:
                        reason = "缺失" if not infos else "重复"
                        zip_draft_queue_errors.append(f"{reason}：{member}")
                        continue
                    info = infos[0]
                    if stat.S_ISLNK(info.external_attr >> 16):
                        zip_draft_queue_errors.append(f"符号链接：{member}")
                    elif info.is_dir() or info.file_size <= 0:
                        zip_draft_queue_errors.append(f"为空或不是普通文件：{member}")
        except zipfile.BadZipFile:
            issues.append(issue(
                "blocked",
                "delivery-zip-corrupt",
                "交付包 zip 已损坏，无法打开。",
                "重新运行 `delivery-pack` 生成 zip。",
                zip_path,
            ))
            return issues
        if zip_visual_integrity_errors:
            issues.append(issue(
                "blocked",
                "delivery-zip-visual-integrity-mismatch",
            "交付 ZIP 中的已选视觉资产未通过采用清单完整性校验。",
                "不要手工修改 ZIP；重新运行 `delivery-pack` 生成目录和压缩包。",
                "；".join(zip_visual_integrity_errors[:5]),
            ))
        if zip_platform_publish_errors:
            issues.append(issue(
                "blocked",
                "delivery-zip-missing-platform-publish-assets",
                f"交付 ZIP 缺少或损坏 {len(zip_platform_publish_errors)} 个平台发布成稿文件。",
                "重新运行 delivery-pack，确认 sidecar 的 archive.generatedPaths 全部进入 ZIP。",
                "；".join(zip_platform_publish_errors[:5]),
            ))
        if zip_draft_queue_errors:
            issues.append(issue(
                "blocked",
                "delivery-zip-missing-draft-queue",
                "交付 ZIP 缺少或损坏五平台草稿队列文件。",
                "重新运行 delivery-pack，确认 draft-queue.json 与平台发布成稿一起进入 ZIP。",
                "；".join(zip_draft_queue_errors[:5]),
            ))
        unsafe_names = [
            name for name in names
            if name.startswith("/") or ".." in Path(name).parts or is_sensitive_path(name)
        ][:8]
        if unsafe_names:
            issues.append(issue(
                "blocked",
                "delivery-zip-unsafe-entry",
                "交付包 zip 中包含不安全或敏感路径。",
                "移除敏感文件后重新打包。",
                "；".join(unsafe_names),
            ))
        missing_zip_files = [name for name in REQUIRED_CUSTOMER_FILES if name not in names]
        if missing_zip_files:
            issues.append(issue(
                "blocked",
                "delivery-zip-incomplete",
                f"交付包 zip 缺少 {len(missing_zip_files)} 个客户必读文件。",
                "重新运行 `delivery-pack`，并确认 zip 内含 README、客户成果报告、修改意见和隐私清单。",
                "；".join(missing_zip_files),
            ))
        if zip_manifest != disk_manifest:
            issues.append(issue(
                "blocked",
                "delivery-zip-manifest-mismatch",
                "zip 内 manifest.json 与交付目录 manifest.json 不一致。",
                "重新运行 `delivery-pack`，确保最终 manifest 写入后再打包，并不要手工改写交付目录或 zip。",
                zip_path,
            ))
        referenced_files = delivery_manifest_referenced_files(manifest, delivery_dir)
        missing_manifest_zip_files = sorted(name for name in referenced_files if name not in names)
        if missing_manifest_zip_files:
            issues.append(issue(
                "blocked",
                "delivery-zip-missing-manifest-file",
                f"zip 缺少 {len(missing_manifest_zip_files)} 个 manifest 声明的交付文件。",
                "重新运行 `delivery-pack`，确认 zip 包含 manifest 声明的所有 artifacts、reports 和客户文档。",
                "；".join(missing_manifest_zip_files[:5]),
            ))
    return issues


def audit_visual_asset_realization(rt: ContentRuntime, run: dict[str, Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    slug = run.get("slug") or ""
    visual_rel = run.get("steps", {}).get("visual", {}).get("latest")
    if visual_rel:
        try:
            visual = rt.read("visual", file=visual_rel)
            validation = rt.validate("visual", visual_rel)
        except Exception as exc:
            issues.append(issue(
                "blocked",
                "visual-assets-unreadable",
                f"视觉计划无法读取或校验：{exc}",
                "修复 visual 产物后重新运行交付审查。",
                visual_rel,
            ))
            return issues
        release = resolve_selected_visual_release(rt.project, slug)
        if release.get("kind") in {"recipe", "asset_manifest"}:
            if release.get("status") != "pass":
                details = "；".join(str(item) for item in release.get("errors", [])[:5])
                issues.append(issue(
                    "blocked",
                    str(release.get("code") or "visual-release-invalid"),
                    f"已选视觉资产未通过正式交付校验：{details or '缺少可验证的采用与质量来源。'}",
                    "在视觉工作台逐项采用通过质量门的本地渲染资产，再重新运行交付审查。",
                    str(release.get("selection_path") or release.get("index_path") or visual_rel),
                ))
            return issues
        expected = expected_asset_paths_from_validation(validation)
        if not expected:
            expected = visual_paths_from_text(visual.get("body", ""))
        slug_prefix = f"pipeline/visual/{slug}/" if slug else "pipeline/visual/"
        checked = 0
        missing: list[str] = []
        for rel in expected:
            if slug and not rel.startswith(slug_prefix):
                issues.append(issue(
                    "blocked",
                    "visual-asset-wrong-slug",
                    f"视觉 Manifest 引用了非当前 run 的资产路径：{rel}",
                    f"将视觉产物写入 `{slug_prefix}` 下，避免串用其它 run 的资产。",
                    rel,
                ))
                continue
            if DIRECTORY_PATH_SUFFIX_RE.search(rel) or Path(rel).suffix:
                checked += 1
                ok, reason = project_asset_exists(rt, rel)
                if not ok:
                    missing.append(f"{rel}（{reason}）")
        if checked and missing:
            issues.append(issue(
                "blocked",
                "visual-assets-missing",
                f"视觉计划声明了 {checked} 个交付资产，但 {len(missing)} 个不存在或为空。",
                "先执行 content-visual/xhs-card/dbs-wechat-html/配图生成，确认文件落盘后再交付。",
                "；".join(missing[:5]),
            ))
        elif checked == 0:
            issues.append(issue(
                "review",
                "visual-assets-not-declared",
                "视觉计划没有声明可验证的实际资产文件路径。",
                "在 `## 6. 交付 Manifest` 中写明具体输出文件，例如 `pipeline/visual/{slug}/cover.png`。",
                visual_rel,
            ))

    return issues


def validate_run_artifacts(rt: ContentRuntime, run: dict[str, Any], required_steps: list[str]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    for step in required_steps:
        rel = run.get("steps", {}).get(step, {}).get("latest")
        if not rel:
            issues.append(issue(
                "blocked",
                "missing-step",
                f"缺少 `{step}` 步骤产物。",
                f"先补齐 `{step}`，再重新运行交付审计。",
            ))
            continue
        try:
            result = rt.validate(step, rel)
        except Exception as exc:
            issues.append(issue(
                "blocked",
                "validate-error",
                f"`{step}` 无法完成结构/质量校验：{exc}",
                f"修复 `{rel}` 或重新生成 `{step}` 产物。",
                rel,
            ))
            continue
        if not result.get("valid"):
            detail = "; ".join((result.get("quality_errors") or result.get("missing_patterns") or [])[:3])
            issues.append(issue(
                "blocked",
                "invalid-step",
                f"`{step}` 未通过 runtime 校验。{detail}",
                f"按 `quality_errors` 修复 `{rel}` 后重新 validate。",
                rel,
            ))
        elif result.get("quality_status") == "review_required" or result.get("quality_reviews"):
            detail = "; ".join((result.get("quality_reviews") or [])[:3])
            issues.append(issue(
                "review",
                "step-review",
                f"`{step}` 可继续但需要人工复核。{detail}",
                f"交付前人工确认 `{step}` 的复核提醒。",
                rel,
            ))
    return issues


def extract_publish_final_path(rt: ContentRuntime, body: str) -> str | None:
    """Return a project-relative published draft path from a publish record."""
    candidates: list[str] = []
    line_match = PUBLISH_FINAL_PATH_LINE_RE.search(body or "")
    if line_match:
        candidates.append(line_match.group(1).strip())
    candidates.extend(PUBLISH_FINAL_PATH_RE.findall(body or ""))
    for candidate in candidates:
        clean = str(candidate).strip().strip("`'\"<> ，。；;、)）]】")
        embedded = PUBLISH_FINAL_PATH_RE.search(clean)
        if embedded:
            return embedded.group(0).strip("`'\"<> ，。；;、)）]】")
        try:
            rel = rel_to_project(rt.project, clean)
        except Exception:
            rel = clean
        if rel and PUBLISH_FINAL_PATH_RE.search(rel):
            return PUBLISH_FINAL_PATH_RE.search(rel).group(0).strip("`'\"<> ，。；;、)）]】")
    return None


def extract_publish_platform(body: str) -> str:
    match = PUBLISH_PLATFORM_LINE_RE.search(body or "")
    return match.group(1).strip() if match else ""


def normalize_publish_platform(value: str) -> str | None:
    compact = re.sub(r"\s+", "", value or "").lower()
    if not compact:
        return None
    aliases = {
        "公众号": "wechat",
        "微信": "wechat",
        "wechat": "wechat",
        "小红书": "xhs",
        "xiaohongshu": "xhs",
        "xhs": "xhs",
        "视频号": "shipinhao",
        "微信视频号": "shipinhao",
        "shipinhao": "shipinhao",
        "抖音": "douyin",
        "douyin": "douyin",
        "朋友圈": "moments",
        "moments": "moments",
        "多平台": "all",
        "all": "all",
    }
    for alias, platform in aliases.items():
        if alias in compact:
            return platform
    return None


def platform_compatible(published_platform: str | None, target_platforms: list[str]) -> bool:
    if not published_platform or not target_platforms or published_platform == "all":
        return True
    normalized_targets = {normalize_publish_platform(platform) or platform for platform in target_platforms}
    if "all" in normalized_targets:
        return True
    return published_platform in normalized_targets


def run_draft_paths(run: dict[str, Any]) -> dict[str, str]:
    return {
        step: rel
        for step in PUBLISHABLE_CONTENT_STEPS
        for rel in [run.get("steps", {}).get(step, {}).get("latest")]
        if rel
    }


def run_history_contains_draft(run: dict[str, Any], rel: str) -> bool:
    return any(
        item.get("step") in PUBLISHABLE_CONTENT_STEPS and item.get("path") == rel
        for item in run.get("history", []) or []
    )


def find_artifact_owner_run(rt: ContentRuntime, rel: str, current_run_id: str | None) -> dict[str, Any] | None:
    if not rel or not rt.runs.exists():
        return None
    for path in sorted(rt.runs.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            candidate = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if candidate.get("run_id") == current_run_id:
            continue
        for step in PUBLISHABLE_CONTENT_STEPS:
            if candidate.get("steps", {}).get(step, {}).get("latest") == rel:
                return candidate
        if run_history_contains_draft(candidate, rel):
            return candidate
    return None


def extract_draft_source_paths(rt: ContentRuntime, body: str) -> list[str]:
    """Extract project-relative draft paths from lifecycle records."""
    paths: list[str] = []
    for candidate in DRAFT_SOURCE_PATH_RE.findall(body or ""):
        clean = candidate.strip("`'\"<> ，。；;、)）]】")
        embedded = DRAFT_SOURCE_PATH_RE.search(clean)
        rel = embedded.group(0) if embedded else clean
        try:
            normalized = rel_to_project(rt.project, rel) or rel
        except Exception:
            normalized = rel
        embedded_normalized = DRAFT_SOURCE_PATH_RE.search(normalized)
        if embedded_normalized:
            normalized = embedded_normalized.group(0).strip("`'\"<> ，。；;、)）]】")
        if normalized not in paths:
            paths.append(normalized)
    return paths


def lifecycle_binding_issue(
    step: str,
    code_suffix: str,
    message: str,
    fix: str,
    artifact: str | None = None,
) -> dict[str, str]:
    return issue("blocked", f"{step}-{code_suffix}", message, fix, artifact)


def audit_lifecycle_source_bindings(rt: ContentRuntime, run: dict[str, Any]) -> list[dict[str, Any]]:
    """Block delivery when review/archive/twin records cite stale or foreign drafts."""
    issues: list[dict[str, Any]] = []
    current_drafts = run_draft_paths(run)
    current_paths = set(current_drafts.values())
    latest_summary = "、".join(f"{step}: {rel}" for step, rel in current_drafts.items()) or "当前 run 尚无最新成稿"

    for step in ("review", "archive", "twin"):
        lifecycle_rel = run.get("steps", {}).get(step, {}).get("latest")
        if not lifecycle_rel:
            continue
        try:
            record = rt.read(step, file=lifecycle_rel)
        except Exception as exc:
            issues.append(lifecycle_binding_issue(
                step,
                "source-file-missing",
                f"`{step}` 生命周期记录无法读取：{exc}",
                f"重新生成 `{step}` 记录后再交付。",
                lifecycle_rel,
            ))
            continue

        source_paths = extract_draft_source_paths(rt, record.get("body", ""))
        if not source_paths:
            issues.append(lifecycle_binding_issue(
                step,
                "source-missing",
                f"`{step}` 没有可追溯的当前成稿路径，无法证明它属于当前 run。",
                f"重新生成 `{step}`，并写明当前 run latest 成稿路径：{latest_summary}。",
                lifecycle_rel,
            ))
            continue

        for source_rel in source_paths:
            if source_rel in current_paths:
                continue
            try:
                rt._project_path(source_rel, must_exist=True)
            except Exception as exc:
                issues.append(lifecycle_binding_issue(
                    step,
                    "source-file-missing",
                    f"`{step}` 引用的成稿不存在或不可读：{exc}",
                    f"把 `{step}` 中的原文/成稿路径改为当前 run latest：{latest_summary}。",
                    source_rel,
                ))
                continue
            owner = find_artifact_owner_run(rt, source_rel, run.get("run_id"))
            if owner:
                issues.append(lifecycle_binding_issue(
                    step,
                    "source-wrong-run",
                    f"`{step}` 引用了其它 run 的成稿：{owner.get('run_id') or owner.get('slug')}。",
                    f"重新生成 `{step}`，只能沉淀当前 run 的最新成稿。",
                    source_rel,
                ))
                continue
            if run_history_contains_draft(run, source_rel):
                issues.append(lifecycle_binding_issue(
                    step,
                    "stale-source",
                    f"`{step}` 引用的是当前 run 的旧成稿，不是最新成稿。",
                    f"重新生成 `{step}`，原文/成稿路径改为当前 latest：{latest_summary}。",
                    source_rel,
                ))
                continue
            issues.append(lifecycle_binding_issue(
                step,
                "source-not-current",
                f"`{step}` 引用的成稿存在，但不属于当前 run 的最新草稿链路。",
                f"重新生成 `{step}`，确保生命周期记录与当前 run 绑定。",
                source_rel,
            ))
    return issues


def audit_check_source_bindings(rt: ContentRuntime, run: dict[str, Any]) -> list[dict[str, Any]]:
    """Block delivery when prelaunch/compliance/audit cite stale or foreign drafts."""
    issues: list[dict[str, Any]] = []
    current_drafts = run_draft_paths(run)
    current_paths = set(current_drafts.values())
    latest_summary = "、".join(f"{step}: {rel}" for step, rel in current_drafts.items()) or "当前 run 尚无最新成稿"

    for step in CHECK_STEPS:
        check_rel = run.get("steps", {}).get(step, {}).get("latest")
        if not check_rel:
            continue
        try:
            record = rt.read(step, file=check_rel)
        except Exception as exc:
            issues.append(lifecycle_binding_issue(
                step,
                "source-file-missing",
                f"`{step}` 发布前检查记录无法读取：{exc}",
                f"重新生成 `{step}` 记录后再交付。",
                check_rel,
            ))
            continue

        source_paths = extract_draft_source_paths(rt, record.get("body", ""))
        if not source_paths:
            issues.append(lifecycle_binding_issue(
                step,
                "source-missing",
                f"`{step}` 没有可追溯的当前成稿路径，无法证明发布前检查对象属于当前 run。",
                f"重新生成 `{step}`，并写明当前 run latest 成稿路径：{latest_summary}。",
                check_rel,
            ))
            continue

        for source_rel in source_paths:
            if source_rel in current_paths:
                continue
            try:
                rt._project_path(source_rel, must_exist=True)
            except Exception as exc:
                issues.append(lifecycle_binding_issue(
                    step,
                    "source-file-missing",
                    f"`{step}` 引用的检查对象不存在或不可读：{exc}",
                    f"把 `{step}` 中的检查对象/成稿路径改为当前 run latest：{latest_summary}。",
                    source_rel,
                ))
                continue
            owner = find_artifact_owner_run(rt, source_rel, run.get("run_id"))
            if owner:
                issues.append(lifecycle_binding_issue(
                    step,
                    "source-wrong-run",
                    f"`{step}` 引用了其它 run 的成稿：{owner.get('run_id') or owner.get('slug')}。",
                    f"重新生成 `{step}`，只能检查当前 run 的最新成稿。",
                    source_rel,
                ))
                continue
            if run_history_contains_draft(run, source_rel):
                issues.append(lifecycle_binding_issue(
                    step,
                    "stale-source",
                    f"`{step}` 引用的是当前 run 的旧成稿，不是最新检查对象。",
                    f"重新生成 `{step}`，检查对象/成稿路径改为当前 latest：{latest_summary}。",
                    source_rel,
                ))
                continue
            issues.append(lifecycle_binding_issue(
                step,
                "source-not-current",
                f"`{step}` 引用的检查对象存在，但不属于当前 run 的最新草稿链路。",
                f"重新生成 `{step}`，确保发布前检查与当前 run 绑定。",
                source_rel,
            ))
    return issues


def audit_publish_record_bindings(rt: ContentRuntime, run: dict[str, Any]) -> list[dict[str, Any]]:
    """Block delivery when publish records point to a stale or foreign final draft."""
    issues: list[dict[str, Any]] = []
    publish_rel = run.get("steps", {}).get("publish", {}).get("latest")
    if not publish_rel:
        return issues
    try:
        publish = rt.read("publish", file=publish_rel)
    except Exception as exc:
        return [issue(
            "blocked",
            "validate-error",
            f"`publish` 发布记录无法读取：{exc}",
            "修复发布记录或重新保存发布记录后再交付。",
            publish_rel,
        )]

    body = publish.get("body", "")
    final_rel = extract_publish_final_path(rt, body)
    if not final_rel:
        issues.append(issue(
            "blocked",
            "publish-final-path-missing",
            "发布记录没有解析到最终版成稿路径，无法证明发布对象属于当前 run。",
            "重新保存发布记录，并在 `## 0. 最终版` 中写明当前 run 最新成稿路径。",
            publish_rel,
        ))
        return issues

    try:
        final_abs = rt._project_path(final_rel, must_exist=True)
    except Exception as exc:
        issues.append(issue(
            "blocked",
            "publish-final-missing",
            f"发布记录引用的最终稿不存在或不可读：{exc}",
            "重新选择当前 run 的最新成稿保存发布记录。",
            final_rel,
        ))
        return issues

    current_drafts = run_draft_paths(run)
    if final_rel in current_drafts.values():
        published_platform = normalize_publish_platform(extract_publish_platform(body))
        if not platform_compatible(published_platform, run.get("target_platforms") or []):
            issues.append(issue(
                "blocked",
                "publish-platform-mismatch",
                "发布记录平台与当前 run 目标阵地不一致。",
                "重新保存发布记录，或修正当前 run 的目标阵地配置。",
                publish_rel,
            ))
        return issues

    owner = find_artifact_owner_run(rt, final_rel, run.get("run_id"))
    if owner:
        issues.append(issue(
            "blocked",
            "publish-final-wrong-run",
            f"发布记录引用了其它 run 的最终稿：{owner.get('run_id') or owner.get('slug')}。",
            "重新保存发布记录，最终版路径必须指向当前 run 的最新成稿。",
            final_rel,
        ))
        return issues

    if run_history_contains_draft(run, final_rel):
        latest_summary = "、".join(f"{step}: {rel}" for step, rel in current_drafts.items()) or "当前 run 尚无最新成稿"
        issues.append(issue(
            "blocked",
            "publish-stale-final",
            "发布记录引用的是当前 run 的旧成稿，不是最新最终版。",
            f"重新发布/保存记录，最终版路径改为当前 latest：{latest_summary}。",
            final_rel,
        ))
        return issues

    issues.append(issue(
        "blocked",
        "publish-final-not-current",
        "发布记录引用的最终稿存在，但不属于当前 run 的最新草稿链路。",
        "重新生成或重新保存发布记录，确保 publish 与当前 run lifecycle 绑定。",
        str(final_abs.relative_to(rt.project)),
    ))
    return issues


def draft_step_rel(run: dict[str, Any], step: str) -> str:
    return run.get("steps", {}).get(step, {}).get("latest") or ""


def report_file_matches(project: Path, report_file: str, step_rel: str) -> bool:
    if not report_file or not step_rel:
        return False
    report_rel = rel_to_project(project, report_file)
    if report_rel == step_rel:
        return True
    if report_file.endswith(step_rel):
        return True
    try:
        report_abs = Path(report_file).resolve(strict=False)
        step_abs = (project / step_rel).resolve(strict=False)
        return report_abs == step_abs
    except Exception:
        return False


def platform_matches(report_platform: str | None, expected_platform: str) -> bool:
    if not report_platform:
        return True
    if report_platform == expected_platform:
        return True
    return False


def quality_report_scope_matches(report: dict[str, Any], run: dict[str, Any], platform: str) -> bool:
    if not platform_matches(report.get("platform"), platform):
        return False
    if report.get("run_id") and report.get("run_id") == run.get("run_id"):
        return True
    if report.get("slug") and report.get("slug") == run.get("slug"):
        return True
    return False


def quality_report_matches(project: Path, report: dict[str, Any], run: dict[str, Any], step: str, platform: str) -> bool:
    step_rel = draft_step_rel(run, step)
    report_file = str(report.get("file") or "")
    if report_file and not report_file_matches(project, report_file, step_rel):
        return False
    report_platform = report.get("platform")
    if not platform_matches(report_platform, platform):
        return False
    if report.get("run_id") and report.get("run_id") == run.get("run_id"):
        return True
    if report.get("slug") and report.get("slug") == run.get("slug"):
        return True
    return bool(report_file and report_file_matches(project, report_file, step_rel))


def quality_report_stale_candidate_issue(project: Path, report: dict[str, Any], run: dict[str, Any], step: str, platform: str) -> dict[str, Any]:
    report_file = str(report.get("file") or "")
    step_rel = draft_step_rel(run, step)
    if report_file and not report_file_matches(project, report_file, step_rel):
        return issue(
            "blocked",
            "quality-report-stale",
            f"`{step}` 质量验收报告指向旧成稿文件，不是当前 run 的最新成稿。",
            f"重新运行 `quality-check PLATFORM={platform} SLUG={run.get('slug')}`，或指定 FILE={step_rel}。",
            report.get("_path"),
        )
    stale_issue = quality_report_stale_issue(report, run, step, platform)
    if stale_issue:
        return stale_issue
    return issue(
        "blocked",
        "quality-report-stale",
        f"`{step}` 质量验收报告无法证明它覆盖当前成稿。",
        f"重新运行 `quality-check PLATFORM={platform} SLUG={run.get('slug')}`，或指定 FILE={step_rel}。",
        report.get("_path"),
    )


def quality_report_stale_issue(report: dict[str, Any], run: dict[str, Any], step: str, platform: str) -> dict[str, Any] | None:
    report_created_at = parse_iso_datetime(report.get("created_at"))
    step_updated_at = parse_iso_datetime(run.get("steps", {}).get(step, {}).get("updated_at"))
    if not report_created_at:
        return issue(
            "blocked",
            "quality-report-stale",
            f"`{step}` 质量验收报告缺少可解析生成时间，不能证明它覆盖当前成稿。",
            f"重新运行 `quality-check PLATFORM={platform} SLUG={run.get('slug')}`，或指定 FILE={draft_step_rel(run, step)}。",
            report.get("_path"),
        )
    if step_updated_at and report_created_at < step_updated_at:
        return issue(
            "blocked",
            "quality-report-stale",
            f"`{step}` 质量验收报告早于当前成稿，不能复用旧验收结论。",
            f"重新运行 `quality-check PLATFORM={platform} SLUG={run.get('slug')}`，或指定 FILE={draft_step_rel(run, step)}。",
            report.get("_path"),
        )
    return None


def load_quality_reports(project: Path, run: dict[str, Any], required_drafts: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    reports: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    root = project / "quality" / "reports"
    json_reports = newest_files(root, "*.json")
    for step in required_drafts:
        platform = QUALITY_REPORT_STEPS.get(step)
        if not platform:
            continue
        matched: dict[str, Any] | None = None
        stale_candidate: dict[str, Any] | None = None
        for path in json_reports:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if quality_report_matches(project, data, run, step, platform):
                data["_path"] = str(path)
                matched = data
                break
            if not stale_candidate and quality_report_scope_matches(data, run, platform):
                data["_path"] = str(path)
                stale_candidate = data
        if not matched:
            if stale_candidate:
                reports.append(stale_candidate)
                issues.append(quality_report_stale_candidate_issue(project, stale_candidate, run, step, platform))
                continue
            rel = draft_step_rel(run, step)
            issues.append(issue(
                "blocked",
                "missing-quality-report",
                f"`{step}` 缺少质量验收报告。",
                f"运行 `quality-check PLATFORM={platform} SLUG={run.get('slug')}`，或指定 FILE={rel}。",
                rel,
            ))
            continue
        reports.append(matched)
        stale_issue = quality_report_stale_issue(matched, run, step, platform)
        if stale_issue:
            issues.append(stale_issue)
        if matched.get("status") == "blocked" or matched.get("gate_status") == "blocked":
            issues.append(issue(
                "blocked",
                "quality-blocked",
                f"`{step}` 质量验收为 blocked。",
                f"根据 `{matched.get('_path')}` 的 blocking gates 返修正文。",
                matched.get("_path"),
            ))
        elif matched.get("status") != "pass" or matched.get("delivery_audit_status") == "review_required":
            issues.append(issue(
                "review",
                "quality-review",
                f"`{step}` 质量验收需要人工复核。",
                f"查看 `{matched.get('_path')}`，确认 delivery audit 与 claim ledger。",
                matched.get("_path"),
            ))
    return reports, issues


def dbs_fusion_files_for_run(run: dict[str, Any]) -> list[str]:
    files: list[str] = []
    latest = run.get("steps", {}).get("dbs-fusion", {}).get("latest")
    if latest:
        files.append(latest)
    for item in run.get("history", []) or []:
        if item.get("step") != "dbs-fusion":
            continue
        rel = item.get("path")
        if rel and rel not in files:
            files.append(rel)
    return files


def latest_dbs_apply_report(rt: ContentRuntime, fusion_file: str) -> dict[str, Any] | None:
    root = rt.project / "quality" / "dbs-fusion-applies"
    if not root.exists():
        return None
    fusion_abs = str((rt.project / fusion_file).resolve(strict=False))
    for path in newest_files(root, "*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("dry_run"):
            continue
        report_file = str(data.get("fusion_file") or "")
        report_abs = str(Path(report_file).resolve(strict=False)) if report_file else ""
        report_rel = rel_to_project(rt.project, report_file)
        if report_file == fusion_file or report_rel == fusion_file or report_abs == fusion_abs:
            data["_path"] = str(path)
            return data
    return None


def apply_report_finished(report: dict[str, Any] | None) -> bool:
    if not report:
        return False
    rows = report.get("rows") or []
    if not rows:
        return False
    if report.get("status") not in {"pass", "review_required"}:
        return False
    return all(row.get("status") in APPLIED_STATES for row in rows)


def pipeline_target_has_apply_marker(rt: ContentRuntime, run: dict[str, Any], target_path: str, fusion_file: str) -> bool:
    step = pipeline_step_for_path(target_path)
    if not step:
        return False
    rel = run.get("steps", {}).get(step, {}).get("latest")
    if not rel:
        return False
    try:
        data = rt.read(step, file=rel)
    except Exception:
        return False
    source = data.get("frontmatter", {}).get("source") or ""
    body = data.get("body", "")
    return source == f"dbs-fusion-apply:{fusion_file}" or (
        "dbs-fusion apply" in body and fusion_file in body
    )


def run_history_created_at(run: dict[str, Any], step: str, rel_path: str) -> datetime | None:
    """Return the newest recorded time for one exact run artifact path."""
    matches = [
        parse_iso_datetime(item.get("created_at"))
        for item in run.get("history", []) or []
        if item.get("step") == step and item.get("path") == rel_path
    ]
    valid = [item for item in matches if item is not None]
    return max(valid) if valid else None


def current_confirmed_blueprint(rt: ContentRuntime, run: dict[str, Any]) -> dict[str, Any] | None:
    """Resolve the current, confirmed blueprint without trusting stale history."""
    blueprint_rel = str(run.get("steps", {}).get("blueprint", {}).get("latest") or "").strip()
    if not blueprint_rel:
        return None
    try:
        record = rt.read("blueprint", file=blueprint_rel)
        validation = rt.validate("blueprint", blueprint_rel)
    except Exception:
        return None
    approval = rt.blueprint_approval_status(blueprint_rel, run_id=run.get("run_id"))
    if not validation.get("valid") or approval.get("approved") is not True:
        return None
    if record.get("frontmatter", {}).get("slug") != run.get("slug"):
        return None
    created_at = parse_iso_datetime(record.get("frontmatter", {}).get("created_at"))
    if created_at is None:
        created_at = run_history_created_at(run, "blueprint", blueprint_rel)
    if created_at is None:
        return None
    return {"path": blueprint_rel, "created_at": created_at}


def superseded_dbs_fusion_target_paths(
    rt: ContentRuntime,
    run: dict[str, Any],
    fusion_created_at: str | None,
    body: str,
) -> set[str]:
    """Identify old planning writebacks superseded by a newer confirmed blueprint.

    This is deliberately narrow: only historical breakdown/blueprint rows that
    explicitly feed the writing path may be skipped. All other pending DBS
    writebacks retain their normal blocking behavior.
    """
    fusion_time = parse_iso_datetime(fusion_created_at)
    blueprint = current_confirmed_blueprint(rt, run)
    if fusion_time is None or blueprint is None or fusion_time >= blueprint["created_at"]:
        return set()

    superseded: set[str] = set()
    for row in parse_writeback_rows(body):
        target_path = extract_target_path(row.get("target", ""))
        if not target_path.startswith(("pipeline/breakdown/", "pipeline/blueprint/")):
            continue
        downstream = row.get("downstream", "")
        if "content-blueprint" not in downstream and "content-write" not in downstream:
            continue
        target_step = "blueprint" if target_path.startswith("pipeline/blueprint/") else pipeline_step_for_path(target_path)
        target_time = run_history_created_at(run, target_step, target_path)
        if target_time is None or target_time > fusion_time:
            continue
        if target_path.startswith("pipeline/blueprint/") and target_path == blueprint["path"]:
            continue
        superseded.add(target_path)
    return superseded


def unresolved_dbs_fusion_rows(
    rt: ContentRuntime,
    run: dict[str, Any],
    fusion_file: str,
    body: str,
    *,
    ignored_target_paths: set[str] | None = None,
) -> list[dict[str, str]]:
    unresolved: list[dict[str, str]] = []
    ignored = ignored_target_paths or set()
    for row in parse_writeback_rows(body):
        target_path = extract_target_path(row.get("target", ""))
        if not target_path:
            unresolved.append({
                "target": row.get("target", ""),
                "target_path": "",
                "message": "写回位置缺少 pipeline/、brain/ 或 sessions/ 路径。",
            })
            continue
        if target_path in ignored:
            continue
        if target_path.startswith("pipeline/") and pipeline_target_has_apply_marker(rt, run, target_path, fusion_file):
            continue
        unresolved.append({
            "target": row.get("target", ""),
            "target_path": target_path,
            "downstream": row.get("downstream", ""),
            "state": row.get("state", ""),
        })
    return unresolved


def audit_dbs_fusion_writebacks(rt: ContentRuntime, run: dict[str, Any]) -> list[dict[str, Any]]:
    """Block delivery when external dbskill findings exist but were not written back."""
    issues: list[dict[str, Any]] = []
    for fusion_file in dbs_fusion_files_for_run(run):
        try:
            fusion = rt.read("dbs-fusion", file=fusion_file)
            validation = rt.validate("dbs-fusion", fusion_file)
        except Exception as exc:
            issues.append(issue(
                "blocked",
                "dbs-fusion-invalid",
                f"`dbs-fusion` 证据无法校验：{exc}",
                "修复融合报告或移除无效外部诊断证据后重新交付审查。",
                fusion_file,
            ))
            continue
        if not validation.get("valid"):
            detail = "; ".join((validation.get("quality_errors") or validation.get("missing_patterns") or [])[:3])
            issues.append(issue(
                "blocked",
                "dbs-fusion-invalid",
                f"`dbs-fusion` 报告未通过校验。{detail}",
                "先修复融合报告并重新 validate，再进入交付。",
                fusion_file,
            ))
            continue
        report = latest_dbs_apply_report(rt, fusion_file)
        if apply_report_finished(report):
            continue
        superseded = superseded_dbs_fusion_target_paths(
            rt,
            run,
            fusion.get("frontmatter", {}).get("created_at"),
            fusion.get("body", ""),
        )
        unresolved = unresolved_dbs_fusion_rows(
            rt,
            run,
            fusion_file,
            fusion.get("body", ""),
            ignored_target_paths=superseded,
        )
        if not unresolved:
            continue
        target_summary = "、".join((row.get("target_path") or row.get("target") or "未知目标") for row in unresolved[:3])
        report_note = ""
        if report and report.get("status") == "blocked":
            report_note = f" 最近 apply 报告为 blocked：{report.get('_path')}"
        issues.append(issue(
            "blocked",
            "dbs-fusion-not-applied",
            f"`dbs-fusion` 仍有 {len(unresolved)} 项诊断未写回：{target_summary}。{report_note}".strip(),
            f"先运行 `dbs-fusion-apply --file {fusion_file}`，确认写回成功后重新生成/审查交付包。",
            fusion_file,
        ))
    return issues


def inspect_delivery_pack(rt: ContentRuntime, run: dict[str, Any], auto_pack: bool) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    issues: list[dict[str, Any]] = []
    manifest: dict[str, Any] | None = None
    delivery_root = rt.project / "deliveries"
    if auto_pack:
        try:
            packed = build_delivery_pack(rt.project, run_id=run.get("run_id"))
            manifest_path = Path(packed.get("delivery_dir") or "") / "manifest.json"
            if manifest_path.exists():
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                except Exception:
                    manifest = packed
            else:
                manifest = packed
            if packed.get("delivery_dir"):
                manifest["_actual_delivery_dir"] = packed.get("delivery_dir")
            if packed.get("zip_path"):
                manifest["_actual_zip_path"] = packed.get("zip_path")
        except Exception as exc:
            issues.append(issue(
                "blocked",
                "delivery-auto-pack-failed",
                f"自动刷新交付包失败：{exc}",
                f"修复交付包生成问题后重新运行 `delivery-audit RUN_ID={run.get('run_id')} --auto-pack`。",
            ))
    manifests = newest_files(delivery_root, "*/manifest.json")
    if not manifest:
        for path in manifests:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if data.get("run_id") == run.get("run_id") or data.get("slug") == run.get("slug"):
                data["_manifest_path"] = str(path)
                data["_actual_delivery_dir"] = str(path.parent)
                zip_candidate = Path(f"{path.parent}.zip")
                if zip_candidate.exists():
                    data["_actual_zip_path"] = str(zip_candidate)
                manifest = data
                break
    if not manifest:
        issues.append(issue(
            "blocked",
            "missing-delivery-pack",
            "缺少交付包 manifest。",
            f"运行 `delivery-pack RUN_ID={run.get('run_id')}` 生成交付包。",
        ))
        return None, issues

    delivery_dir = Path(manifest.get("_actual_delivery_dir") or manifest.get("delivery_dir") or "")
    if not delivery_dir.exists():
        issues.append(issue(
            "blocked",
            "delivery-dir-missing",
            "交付包目录不存在。",
            f"重新运行 `delivery-pack RUN_ID={run.get('run_id')}`。",
            str(delivery_dir) if str(delivery_dir) else manifest.get("delivery_dir"),
        ))
    zip_path = manifest.get("_actual_zip_path") or manifest.get("zip_path")
    if not zip_path and delivery_dir:
        inferred_zip = Path(f"{delivery_dir}.zip")
        if inferred_zip.exists():
            zip_path = str(inferred_zip)
            manifest["_actual_zip_path"] = zip_path
    internal_review = manifest.get("manifest_scope") == INTERNAL_REVIEW_SCOPE
    if zip_path and not Path(zip_path).exists():
        issues.append(issue(
            "blocked" if not internal_review else "review",
            "delivery-zip-missing",
            "正式交付包 zip 不存在。" if not internal_review else "内部复核目录未生成 ZIP，符合禁止直接交付规则。",
            f"重新运行 `delivery-pack RUN_ID={run.get('run_id')}` 生成 zip。",
            zip_path,
        ))
    elif not zip_path and not internal_review:
        issues.append(issue(
            "blocked",
            "delivery-zip-missing",
            "正式交付包 zip 未记录或不存在。",
            f"重新运行 `delivery-pack RUN_ID={run.get('run_id')}` 生成 zip。",
            str(delivery_dir) if str(delivery_dir) else None,
        ))
    privacy = privacy_scan(delivery_dir) if delivery_dir.exists() else (manifest.get("privacy_scan") or {})
    if delivery_dir.exists():
        manifest["privacy_scan"] = privacy
    if privacy.get("status") != "pass":
        flagged = privacy.get("flagged") or []
        content_flagged = privacy.get("content_flagged") or []
        detail_items = [*flagged[:3]]
        detail_items.extend(
            f"{item.get('path')}:{','.join(item.get('hits') or [])}"
            for item in content_flagged[:3]
        )
        issues.append(issue(
            "blocked",
            "privacy-scan",
            "交付包隐私扫描未通过。",
            "移除登录态、cookie、trace、session 状态、本机绝对路径、API key 和未授权截图等敏感内容。",
            "；".join(detail_items) or manifest.get("delivery_dir"),
        ))
    for artifact in manifest.get("artifacts", []):
        source = artifact.get("source")
        copied = artifact.get("copied_to")
        if source and is_sensitive_path(source):
            issues.append(issue(
                "blocked",
                "sensitive-source",
                f"交付包引用敏感来源：{source}",
                "移除敏感来源，重新打包。",
                source,
            ))
        if artifact.get("step") in {"write", "xhs", "package", "visual", "prelaunch", "compliance", "audit"} and source and not copied:
            issues.append(issue(
                "review",
                "artifact-not-copied",
                f"交付项 `{artifact.get('label')}` 有来源但未复制入交付包。",
                "确认是否被隐私规则过滤；如非敏感文件，重新打包。",
                source,
            ))
    if delivery_dir.exists():
        issues.extend(inspect_delivery_package_integrity(manifest, delivery_dir, zip_path))
    return manifest, issues


def required_drafts_for_run(run: dict[str, Any]) -> list[str]:
    if native_delivery.is_native_run(run):
        return ["package"]
    if run.get("steps", {}).get("write", {}).get("latest"):
        return ["write"]
    legacy_steps: list[str] = []
    for platform in run.get("target_platforms") or []:
        step = LEGACY_PLATFORM_TO_DRAFT.get(platform)
        if step and run.get("steps", {}).get(step, {}).get("latest") and step not in legacy_steps:
            legacy_steps.append(step)
    if legacy_steps:
        return legacy_steps
    available = [
        step for step in FINAL_DRAFT_STEPS
        if run.get("steps", {}).get(step, {}).get("latest")
    ]
    return available or ["write"]


def markdown_escape(value: Any) -> str:
    text = str(value or "").replace("\n", " ").strip()
    return text.replace("|", "\\|")


def render_issue_table(issues: list[dict[str, Any]]) -> str:
    if not issues:
        return "- 无。\n"
    lines = [
        "| 级别 | 代码 | 问题 | 建议动作 | 证据 |",
        "|---|---|---|---|---|",
    ]
    for item in issues:
        lines.append(
            "| "
            f"{markdown_escape(SEVERITY_LABELS.get(item.get('severity'), item.get('severity')))} | "
            f"`{markdown_escape(item.get('code'))}` | "
            f"{markdown_escape(item.get('message'))} | "
            f"{markdown_escape(item.get('fix'))} | "
            f"{markdown_escape(item.get('artifact') or '-')}"
            " |"
        )
    return "\n".join(lines) + "\n"


def render_quality_reports(reports: list[dict[str, Any]]) -> str:
    if not reports:
        return "- 未匹配到质量报告。\n"
    lines = [
        "| 报告 | 状态 | Gate | 交付审计 | 分数 |",
        "|---|---|---|---|---:|",
    ]
    for report in reports:
        lines.append(
            "| "
            f"{markdown_escape(report.get('path') or '-')} | "
            f"{markdown_escape(report.get('status') or '-')} | "
            f"{markdown_escape(report.get('gate_status') or '-')} | "
            f"{markdown_escape(report.get('delivery_audit_status') or '-')} | "
            f"{markdown_escape(report.get('score') or '-')}"
            " |"
        )
    return "\n".join(lines) + "\n"


def render_delivery_pack_summary(pack: dict[str, Any]) -> str:
    lines = [
        f"- 状态：{pack.get('status') or '未生成'}",
        f"- 交付目录：`{pack.get('delivery_dir') or '-'}`",
        f"- Zip：`{pack.get('zip_path') or '-'}`",
        f"- 隐私扫描：{pack.get('privacy_status') or '-'}",
    ]
    return "\n".join(lines) + "\n"


def render_recommended_actions(actions: list[dict[str, Any]]) -> str:
    if not actions:
        return "- 无需额外动作。\n"
    lines = [
        "| 优先级 | 状态 | 动作 | 负责模块 | 建议命令/操作 | 覆盖问题 |",
        "|---:|---|---|---|---|---|",
    ]
    for index, item in enumerate(actions, 1):
        status = SEVERITY_LABELS.get(item.get("severity"), item.get("severity"))
        codes = ", ".join(f"`{code}`" for code in item.get("issue_codes", [])[:4]) or "-"
        lines.append(
            "| "
            f"{index} | "
            f"{markdown_escape(status)} | "
            f"{markdown_escape(item.get('title'))} | "
            f"`{markdown_escape(item.get('owner'))}` | "
            f"{markdown_escape(item.get('command'))} | "
            f"{codes}"
            " |"
        )
    return "\n".join(lines) + "\n"


def render_delivery_audit_markdown(result: dict[str, Any]) -> str:
    blocked = [item for item in result.get("issues", []) if item.get("severity") == "blocked"]
    review = [item for item in result.get("issues", []) if item.get("severity") == "review"]
    status = result.get("status")
    status_label = STATUS_LABELS.get(status, status)
    can_deliver = "是" if result.get("summary", {}).get("can_deliver") else "否"
    human_review = "是" if result.get("summary", {}).get("needs_human_review") else "否"
    dbs_files = result.get("dbs_fusion_files") or []
    dbs_lines = "\n".join(f"- `{item}`" for item in dbs_files) if dbs_files else "- 无。"
    target_platforms = "、".join(result.get("target_platforms") or []) or "未指定"
    return f"""# Echo Founder 交付前对抗审查报告

## 1. 审查结论
- 状态：**{status_label}**
- 是否可交付：{can_deliver}
- 是否需要人工复核：{human_review}
- 阻断问题数：{result.get('blocking_count', 0)}
- 复核问题数：{result.get('review_count', 0)}
- 审查时间：{result.get('audited_at') or '-'}

## 2. Run 信息
- 项目：`{result.get('project')}`
- Run ID：`{result.get('run_id')}`
- Slug：`{result.get('slug')}`
- 主题：{result.get('topic') or '未记录'}
- 目标阵地：{target_platforms}
- 必需步骤：{', '.join(result.get('required_steps') or [])}
- 草稿步骤：{', '.join(result.get('required_drafts') or [])}

## 3. 必须修复
{render_issue_table(blocked)}

## 4. 建议动作
{render_recommended_actions(result.get('recommended_actions') or [])}

## 5. 人工复核
{render_issue_table(review)}

## 6. 质量报告
{render_quality_reports(result.get('quality_reports') or [])}

## 7. 交付包
{render_delivery_pack_summary(result.get('delivery_pack') or {})}

## 8. DBS 融合证据
- 文件数：{len(dbs_files)}
- 未写回问题数：{result.get('dbs_fusion_issue_count', 0)}
{dbs_lines}

## 9. 下一步
- 若状态为 `blocked`：按“建议动作”从上到下修复，再重新运行 `delivery-audit`。
- 若状态为 `review_required`：人工确认复核项后，再决定是否交付。
- 若状态为 `pass`：可以进入交付包确认和客户/团队交付。
"""


def run_delivery_audit(
    project: str | Path,
    run_id: str | None = None,
    slug: str | None = None,
    auto_pack: bool = False,
) -> dict[str, Any]:
    rt = ContentRuntime(project)
    rt.init()
    run = rt.run_state(run_id=run_id, slug=slug)
    required_drafts = required_drafts_for_run(run)
    native = native_delivery.is_native_run(run)
    selected_prerequisites = publication_delivery_prerequisites(rt.project, run) if native else None
    if native:
        required_steps, optional_steps = expected_audit_steps_for_run(run)
        issues = [issue("blocked", "selected-platform-delivery", error,
                        "返回对应阶段核对当前来源、成稿和发布信息后重新审查。")
                  for error in selected_prerequisites["errors"]]
        for step in required_steps:
            if not run.get("steps", {}).get(step, {}).get("latest"):
                issues.append(issue("blocked", "missing-step", f"缺少 `{step}` 步骤产物。",
                                    f"先补齐 `{step}`，再重新运行交付审查。"))
        if selected_prerequisites.get("internal_only"):
            issues.append(issue("review", "offline-demo-internal", "虚构素材和自动化确认仅供内部演示。", "真实客户验收需使用真实素材并由负责人确认。"))
        quality_reports = []
        dbs_fusion_issues = audit_dbs_fusion_writebacks(rt, run)
        issues.extend(dbs_fusion_issues)
    else:
        required_steps = REQUIRED_CORE_STEPS + CHECK_STEPS
        optional_steps = [
            step for step in OPTIONAL_LEGACY_STEPS + OPTIONAL_LIFECYCLE_STEPS + OPTIONAL_EVIDENCE_STEPS
            if run.get("steps", {}).get(step, {}).get("latest") and step not in required_steps
        ]
    
        issues: list[dict[str, Any]] = []
        pipeline_status = PipelineDirector(rt.project, slug=run.get("slug")).status()
        for warning in pipeline_status.get("warnings") or []:
            issues.append(issue(
                "blocked",
                "pipeline-warning",
                f"流水线依赖异常：{warning.get('step')} - {warning.get('warning')}",
                "先修复缺失上游或绕过闸门的产物，再进入交付。",
            ))
        issues.extend(validate_run_artifacts(rt, run, required_steps + optional_steps))
        issues.extend(audit_check_source_bindings(rt, run))
        issues.extend(audit_publish_record_bindings(rt, run))
        issues.extend(audit_lifecycle_source_bindings(rt, run))
        dbs_fusion_issues = audit_dbs_fusion_writebacks(rt, run)
        issues.extend(dbs_fusion_issues)
        quality_reports, quality_issues = load_quality_reports(rt.project, run, required_drafts)
        issues.extend(quality_issues)
        issues.extend(audit_visual_asset_realization(rt, run))
    delivery_manifest, delivery_issues = inspect_delivery_pack(rt, run, auto_pack)
    issues.extend(delivery_issues)

    blocked = [item for item in issues if item["severity"] == "blocked"]
    review = [item for item in issues if item["severity"] == "review"]
    status = "blocked" if blocked else ("review_required" if review else "pass")
    recommended_actions = build_recommended_actions(issues, run)
    result = {
        "status": status,
        "project": str(rt.project),
        "run_id": run.get("run_id"),
        "slug": run.get("slug"),
        "topic": run.get("topic", ""),
        "target_platforms": run.get("target_platforms", []),
        "audited_at": datetime.now().isoformat(),
        "required_steps": required_steps,
        **({"selected_platform_contract_sha256": (selected_prerequisites.get("contract") or {}).get("sha256")} if native else {}),
        "optional_validated_steps": optional_steps,
        "dbs_fusion_files": dbs_fusion_files_for_run(run),
        "dbs_fusion_issue_count": len(dbs_fusion_issues),
        "required_drafts": required_drafts,
        "quality_reports": [
            {
                "path": report.get("_path"),
                "status": report.get("status"),
                "gate_status": report.get("gate_status"),
                "delivery_audit_status": report.get("delivery_audit_status"),
                "score": report.get("score"),
            }
            for report in quality_reports
        ],
        "delivery_pack": {
            "status": delivery_manifest.get("status") if delivery_manifest else None,
            "delivery_dir": (
                delivery_manifest.get("_actual_delivery_dir")
                or delivery_manifest.get("delivery_dir")
            ) if delivery_manifest else None,
            "zip_path": (
                delivery_manifest.get("_actual_zip_path")
                or delivery_manifest.get("zip_path")
            ) if delivery_manifest else None,
            "privacy_status": (delivery_manifest.get("privacy_scan") or {}).get("status") if delivery_manifest else None,
        },
        "issues": issues,
        "recommended_actions": recommended_actions,
        "blocking_count": len(blocked),
        "review_count": len(review),
        "summary": {
            "can_deliver": status == "pass",
            "needs_human_review": status == "review_required",
            "must_fix": [item["message"] for item in blocked[:8]],
            "review_before_delivery": [item["message"] for item in review[:8]],
            "next_actions": [item["title"] for item in recommended_actions[:5]],
        },
    }
    reports_dir = rt.project / "quality" / "system-audits"
    reports_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    report_stem = reports_dir / f"{stamp}-{rt.normalize_slug(run.get('run_id') or run.get('slug') or 'run')}-delivery-audit"
    markdown_report_path = report_stem.with_suffix(".md")
    json_report_path = report_stem.with_suffix(".json")
    result["report_path"] = str(json_report_path)
    result["json_report_path"] = str(json_report_path)
    result["markdown_report_path"] = str(markdown_report_path)
    markdown_report_path.write_text(render_delivery_audit_markdown(result), encoding="utf-8")
    json_report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if auto_pack:
        refreshed_pack = build_delivery_pack(rt.project, run_id=run.get("run_id"))
        result["delivery_pack"] = {
            "status": refreshed_pack.get("status"),
            "delivery_dir": refreshed_pack.get("delivery_dir"),
            "zip_path": refreshed_pack.get("zip_path"),
            "privacy_status": (refreshed_pack.get("privacy_scan") or {}).get("status"),
        }
        markdown_report_path.write_text(render_delivery_audit_markdown(result), encoding="utf-8")
        json_report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Echo Founder system-level delivery audit")
    parser.add_argument("--project", required=True)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--slug", default=None)
    parser.add_argument("--auto-pack", action="store_true", help="generate delivery pack if missing")
    args = parser.parse_args()
    try:
        result = run_delivery_audit(args.project, args.run_id, args.slug, args.auto_pack)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] in {"pass", "review_required"} else 2
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

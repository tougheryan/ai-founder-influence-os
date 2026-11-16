#!/usr/bin/env python3
"""AIFIOS minimal loop acceptance gate."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from content_runtime import ContentRuntime
from visual_quality import audit_rendered_visual_index


FORBIDDEN_USER_TERMS = [
    "爆款对标报告",
    "标题测试报告",
    "视觉生产计划",
    "资产包说明",
    "蓝图摘要",
]


def _project_rel(project: Path, path: Path | str) -> str:
    target = Path(path).expanduser().resolve(strict=False)
    return str(target.relative_to(project.resolve(strict=False)))


def _blocked(step: str, reason: str, next_action: str) -> dict[str, Any]:
    summary = f"blocked: {step}\n原因：{reason}\n下一步：{next_action}"
    return {
        "status": "blocked",
        "blocked_step": step,
        "reason": reason,
        "next_action": next_action,
        "summary": summary,
    }


def _read_latest(runtime: ContentRuntime, slug: str, step: str) -> dict[str, Any] | None:
    try:
        return runtime.read(step, latest=True, slug=slug)
    except FileNotFoundError:
        return None


def _validate_latest(
    runtime: ContentRuntime,
    project: Path,
    slug: str,
    step: str,
    label: str,
    action: str,
) -> tuple[dict[str, Any], dict[str, Any]] | dict[str, Any]:
    record = _read_latest(runtime, slug, step)
    if not record:
        return _blocked(step, f"缺少{label}。", action)
    rel = _project_rel(project, record["path"])
    validation = runtime.validate(step, rel)
    quality_status = validation.get("quality_status")
    native_reviewed = False
    if step == "blueprint" and validation.get("contract") == "echo-founder.platform-blueprint.v1" and validation.get("valid"):
        scope = validation["platform_scope"]
        approval = runtime.approval_status("topic_template", rel, scope.get("run_id"))
        if not approval.get("approved"):
            return _blocked(step, "平台范围已核对，但当前方案仍需作者确认。", "核对完整方案后确认。")
        # A human's digest-bound review is distinct from automated quality approval.
        native_reviewed = True
    if not validation.get("valid") or (not native_reviewed and quality_status not in (None, "pass")):
        first_error = ""
        if validation.get("quality_errors"):
            first_error = str(validation["quality_errors"][0])
        elif validation.get("missing_patterns"):
            first_error = str(validation["missing_patterns"][0])
        elif validation.get("missing_sections"):
            first_error = str(validation["missing_sections"][0])
        reason = f"{label}没有通过质量门"
        if first_error:
            reason = f"{reason}：{first_error}"
        return _blocked(step, reason, action)
    return record, validation


def _run_has_theme_selection(project: Path, slug: str) -> bool:
    safe_slug = ContentRuntime.normalize_slug(slug)
    run_path = project / "runs" / f"{safe_slug}.json"
    if not run_path.exists():
        return False
    run = json.loads(run_path.read_text(encoding="utf-8"))
    sources = [str(item.get("source", "")) for item in run.get("history", [])]
    sources.append(str(run.get("steps", {}).get("package", {}).get("source", "")))
    return any("theme:" in source and "material:" in source for source in sources)


def _extract_visual_index_rel(visual_body: str) -> str | None:
    match = re.search(r"index\.json\s*[：:]\s*([^\s`|，。；;]+index\.json)", visual_body or "")
    if not match:
        return None
    return match.group(1).strip()


def _load_visual_index(project: Path, visual_body: str) -> tuple[str, dict[str, Any]] | dict[str, Any]:
    index_rel = _extract_visual_index_rel(visual_body)
    if not index_rel:
        return _blocked("visual", "视觉发布产物记录缺少 index.json 路径。", "重新运行 visual_publish.py --renderer local。")
    index_path = project / index_rel
    if not index_path.exists():
        return _blocked("visual", "视觉 index.json 文件不存在。", "重新运行 visual_publish.py --renderer local。")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    return index_rel, index


def resolve_selected_visual_index(
    project: Path | str,
    slug: str,
    fallback_index_rel: str,
    fallback_index: dict[str, Any],
) -> tuple[str, dict[str, Any]] | dict[str, Any]:
    """Use the explicit adopted revision index when a selection pointer exists."""
    project_path = Path(project).expanduser().resolve(strict=False)
    selection_path = project_path / "pipeline" / "visual" / slug / "selected-revision.json"
    if not selection_path.exists():
        if _is_legacy_visual_index(fallback_index):
            return fallback_index_rel, fallback_index
        return _blocked(
            "visual",
            "视觉版本尚未在工作台明确采用。",
            "在视觉工作台检查通过质量门的版本并点击采用此版本。",
        )
    from visual_release import resolve_selected_visual_release

    release = resolve_selected_visual_release(project_path, slug)
    if release.get("status") != "pass":
        details = "；".join(str(item) for item in release.get("errors", [])[:3])
        return _blocked(
            "visual",
            f"已选视觉版本完整性校验未通过：{details or '缺少可信采用记录。'}",
            "重新渲染并在视觉工作台采用一个摘要校验通过的版本。",
        )
    return str(release["index_path"]), dict(release["index"])


def _check_visual_outputs(project: Path, index: dict[str, Any]) -> dict[str, Any] | None:
    if index.get("status") != "generated":
        return _blocked("visual", "视觉索引状态不是 generated。", "重新运行 visual_publish.py --renderer local。")
    if index.get("aesthetic_status") != "pass":
        return _blocked("visual", "视觉索引缺少 aesthetic_status=pass。", "重新运行 visual_publish.py --renderer local。")
    outputs = index.get("outputs", [])
    if len(outputs) < 6:
        return _blocked("visual", "视觉索引输出文件少于 6 个。", "重新运行 visual_publish.py --renderer local。")
    for item in outputs:
        output = item.get("output")
        if not output:
            return _blocked("visual", "视觉索引存在空输出路径。", "重新运行 visual_publish.py --renderer local。")
        output_path = project / output
        if not output_path.exists() or output_path.stat().st_size <= 0:
            return _blocked("visual", f"视觉文件不存在或为空：{output}。", "重新运行 visual_publish.py --renderer local。")
    return None


def _is_legacy_visual_index(index: dict[str, Any]) -> bool:
    if index.get("legacy") is True:
        return True
    if index.get("legacy") is False:
        return False
    return not index.get("recipe_path") and not index.get("revision_id")


def _recipe_release_result(
    status: str,
    checks: dict[str, str],
    errors: list[str] | None = None,
    reviews: list[str] | None = None,
    *,
    legacy: bool = False,
) -> dict[str, Any]:
    errors = errors or []
    reviews = reviews or []
    return {
        "status": status,
        "checks": checks,
        "errors": errors,
        "blocking_issues": errors,
        "review_issues": reviews,
        "legacy": legacy,
    }


def _project_index_path(project: Path, relative_path: str) -> Path | None:
    candidate = Path(relative_path)
    if candidate.is_absolute():
        return None
    resolved = (project / candidate).resolve(strict=False)
    try:
        resolved.relative_to(project.resolve(strict=False))
    except ValueError:
        return None
    return resolved


def _render_html_from_index(project: Path, index: dict[str, Any]) -> str:
    render_paths: set[str] = set()
    for output in index.get("outputs", []):
        if not isinstance(output, dict):
            continue
        value = output.get("render_html")
        if isinstance(value, str) and value.strip():
            render_paths.add(value.strip())
    top_level = index.get("render_html")
    if isinstance(top_level, str) and top_level.strip():
        render_paths.add(top_level.strip())

    rendered: list[str] = []
    for relative_path in sorted(render_paths):
        path = _project_index_path(project, relative_path)
        if path and path.exists() and path.is_file():
            rendered.append(path.read_text(encoding="utf-8"))
    return "\n".join(rendered)


def check_recipe_visual_release(project: Path | str, index: dict[str, Any]) -> dict[str, Any]:
    """Check the selected recipe revision without making legacy records invalid."""
    project_path = Path(project).expanduser().resolve(strict=False)
    if not isinstance(index, dict):
        return _recipe_release_result(
            "blocked",
            {"recipe": "blocked", "quality_summary": "blocked"},
            ["visual index must be an object"],
        )
    if _is_legacy_visual_index(index):
        return _recipe_release_result(
            "review_required",
            {"recipe": "legacy", "quality_summary": "not_applicable"},
            reviews=["legacy visual index has no selected recipe release"],
            legacy=True,
        )

    errors: list[str] = []
    checks = {"recipe": "pass", "quality_summary": "pass"}
    recipe_rel = str(index.get("recipe_path") or "").strip()
    revision_id = str(index.get("revision_id") or "").strip()
    if not recipe_rel:
        checks["recipe"] = "blocked"
        errors.append("recipe release is missing recipe_path")
    if not revision_id:
        checks["recipe"] = "blocked"
        errors.append("recipe release is missing revision_id")

    recipe: dict[str, Any] = {}
    recipe_path = _project_index_path(project_path, recipe_rel) if recipe_rel else None
    if recipe_rel and recipe_path is None:
        checks["recipe"] = "blocked"
        errors.append("recipe_path must be inside the project")
    elif recipe_path and not recipe_path.exists():
        checks["recipe"] = "blocked"
        errors.append("recipe_path does not exist")
    elif recipe_path:
        try:
            loaded_recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            checks["recipe"] = "blocked"
            errors.append("recipe_path does not contain valid JSON")
        else:
            if not isinstance(loaded_recipe, dict):
                checks["recipe"] = "blocked"
                errors.append("recipe_path does not contain a recipe object")
            else:
                recipe = loaded_recipe
                if revision_id and str(recipe.get("revision_id") or "") != revision_id:
                    checks["recipe"] = "blocked"
                    errors.append("recipe revision_id does not match the selected index revision")

    quality_summary = index.get("quality_summary")
    if not isinstance(quality_summary, dict) or quality_summary.get("status") != "pass":
        checks["quality_summary"] = "blocked"
        errors.append("recipe release is missing quality_summary.status=pass")

    if errors:
        return _recipe_release_result("blocked", checks, errors)

    audit_index = dict(index)
    for field in ("quality_policy", "assets", "platforms", "content_archetype", "evidence_mode"):
        if field not in audit_index and field in recipe:
            if field == "assets":
                audit_index["recipe_assets"] = recipe[field]
            else:
                audit_index[field] = recipe[field]
    rendered_html = _render_html_from_index(project_path, index)
    audit = audit_rendered_visual_index(audit_index, rendered_html)
    if any((item.get("kind") == "wechat_html" or item.get("id") == "wechat-html") and item.get("renderer") == "local" for item in index.get("outputs", []) if isinstance(item, dict)):
        from visual_publish import check_wechat_outputs

        fidelity = check_wechat_outputs(project_path, index)
        if fidelity["status"] != "pass":
            audit["status"] = "blocked"
            audit.setdefault("checks", {})["wechat_fidelity"] = "blocked"
            audit.setdefault("errors", []).extend(fidelity["errors"])
    audit_checks = dict(audit.get("checks") or {})
    audit_checks["quality_summary"] = "pass"
    return _recipe_release_result(
        str(audit.get("status") or "review_required"),
        audit_checks,
        [str(item) for item in audit.get("errors", [])],
        [str(item) for item in audit.get("review_issues", [])],
        legacy=bool(audit.get("legacy")),
    )


def _first_output(index: dict[str, Any], suffix: str) -> str:
    for item in index.get("outputs", []):
        output = str(item.get("output", ""))
        if output.endswith(suffix):
            return output
    return ""


def _first_xhs_dir(index: dict[str, Any]) -> str:
    for item in index.get("outputs", []):
        output = str(item.get("output", ""))
        if "/xhs/" in output:
            return str(Path(output).parent)
    return ""


def _render_summary(slug: str, package_rel: str, visual_index_rel: str, index: dict[str, Any]) -> str:
    wechat_html = _first_output(index, "wechat-article.html")
    wechat_cover = _first_output(index, "wechat-cover-21x9.png")
    xhs_dir = _first_xhs_dir(index)
    return (
        f"# AIFIOS 最小闭环验收 · {slug}\n\n"
        "## 1. 最终内容\n"
        f"- 公众号母稿：{package_rel}\n"
        f"- 图文内容：{package_rel}\n\n"
        "## 2. 视觉文件\n"
        f"- 公众号 HTML：{wechat_html}\n"
        f"- 公众号头图：{wechat_cover}\n"
        f"- 小红书图卡目录：{xhs_dir}\n"
        f"- 视觉索引：{visual_index_rel}\n\n"
        "## 3. 发布前状态\n"
        "- 是否可发布：是\n"
        "- 阻断项：无\n"
        "- 下一步：发布后回填数据，进入收获总结\n\n"
        "## 4. 收获总结入口\n"
        "- 数据回流输入：阅读、互动、评论问题、转化线索\n"
        "- 复盘目标：判断本次主题、标题、开头、视觉和评论钩子哪一项最值得复用\n"
    )


def _summary_contains_forbidden(summary: str) -> bool:
    return any(term in summary for term in FORBIDDEN_USER_TERMS)


def run_acceptance(project: Path | str, slug: str) -> dict[str, Any]:
    project_path = Path(project).expanduser().resolve(strict=False)
    safe_slug = ContentRuntime.normalize_slug(slug)
    runtime = ContentRuntime(project_path)

    package = _validate_latest(runtime, project_path, safe_slug, "package", "最终内容 package", "重新运行 content-package。")
    if isinstance(package, dict):
        return package
    package_record, package_validation = package
    package_rel = _project_rel(project_path, package_record["path"])

    if not _run_has_theme_selection(project_path, safe_slug):
        return _blocked("theme", "未找到素材来源和主题选择证据。", "重新从素材进入主题选择门，并保留 theme 来源。")

    blueprint = _validate_latest(runtime, project_path, safe_slug, "blueprint", "母版蓝图", "重新运行 content-blueprint。")
    if isinstance(blueprint, dict):
        return blueprint

    visual = _validate_latest(runtime, project_path, safe_slug, "visual", "视觉发布产物", "重新运行 visual_publish.py --renderer local。")
    if isinstance(visual, dict):
        return visual
    visual_record, visual_validation = visual
    loaded_index = _load_visual_index(project_path, visual_record["body"])
    if isinstance(loaded_index, dict):
        return loaded_index
    visual_index_rel, visual_index = loaded_index
    selected_index = resolve_selected_visual_index(project_path, safe_slug, visual_index_rel, visual_index)
    if isinstance(selected_index, dict):
        return selected_index
    visual_index_rel, visual_index = selected_index
    visual_block = _check_visual_outputs(project_path, visual_index)
    if visual_block:
        return visual_block
    recipe_release = check_recipe_visual_release(project_path, visual_index)
    if recipe_release.get("legacy"):
        return _blocked(
            "visual",
            "视觉发布仍是 legacy 产物，缺少已选 recipe revision。",
            "补齐项目内证据并重新运行 visual_publish.py --renderer local，再在视觉工作台采用通过质量门的版本。",
        )
    if recipe_release.get("status") != "pass":
        issues = recipe_release.get("errors") or recipe_release.get("review_issues") or ["visual recipe release requires review"]
        return _blocked(
            "visual",
            f"视觉 recipe 发布质量未通过：{issues[0]}",
            "修复 visual recipe、证据或 3:4 密度后重新运行 visual_publish.py --renderer local。",
        )

    for step, label, action in [
        ("prelaunch", "发布前检查", "重新运行 content-prelaunch。"),
        ("compliance", "平台合规检查", "重新运行 content-compliance。"),
        ("audit", "可信审核", "重新运行 content-audit。"),
    ]:
        gate = _validate_latest(runtime, project_path, safe_slug, step, label, action)
        if isinstance(gate, dict):
            return gate

    summary = _render_summary(safe_slug, package_rel, visual_index_rel, visual_index)
    if _summary_contains_forbidden(summary):
        return _blocked("summary", "用户可见验收摘要包含内部报告词。", "收敛验收摘要，只保留最终内容、视觉文件、发布状态和收获总结入口。")

    return {
        "status": "accepted",
        "slug": safe_slug,
        "summary": summary,
        "artifacts": {
            "package": package_rel,
            "visual_index": visual_index_rel,
            "wechat_html": _first_output(visual_index, "wechat-article.html"),
            "wechat_cover": _first_output(visual_index, "wechat-cover-21x9.png"),
            "xhs_cards": _first_xhs_dir(visual_index),
        },
        "checks": {
            "theme_selection": True,
            "package_quality": package_validation.get("quality_status"),
            "visual_quality": visual_validation.get("quality_status"),
            "aesthetic_status": visual_index.get("aesthetic_status"),
            "recipe_visual_release": recipe_release.get("status"),
            "prelaunch": "pass",
            "compliance": "pass",
            "audit": "pass",
            "review_entry": "waiting_for_real_data",
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run AIFIOS minimal loop acceptance")
    parser.add_argument("--project", required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = run_acceptance(args.project, args.slug)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["summary"])
    return 0 if result["status"] == "accepted" else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Apply dbs-fusion writeback plans into AIFIOS pipeline artifacts."""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from content_runtime import ContentRuntime


class TikomniGateBlockedError(ValueError):
    """The target write is blocked by the frozen market-evidence gate."""


DIR_TO_STEP = {
    "intake": "intake",
    "validate": "validate",
    "angles": "angle",
    "breakdown": "breakdown",
    "dbs-fusion": "dbs-fusion",
    "final": "write",
    "xhs": "xhs",
    "platform-adapt": "platform-adapt",
    "visual": "visual",
    "prelaunch": "prelaunch",
    "compliance": "compliance",
    "audit": "audit",
    "publish": "publish",
    "review": "review",
    "archive": "archive",
    "twin": "twin",
}

DEFAULT_HEADINGS = {
    "breakdown": "DBS 融合补充",
    "validate": "DBS 立项诊断补充",
    "prelaunch": "5. 共鸣诊断",
    "visual": "6. 交付 Manifest",
    "audit": "5. 修改建议",
}

TARGET_HEADING_HINTS = [
    "传播心理假设",
    "标题方案",
    "开场钩子库",
    "阵地适配建议",
    "共鸣诊断",
    "交付 Manifest",
    "交付写回",
    "视觉资产 Manifest",
    "发布资产准备度检查",
    "修改建议",
    "商业成立性判断",
    "平台首发策略",
]


def strip_frontmatter(text: str) -> tuple[dict[str, str], str]:
    match = re.match(r"^---\n(.*?)\n---\n\n?(.*)$", text or "", re.DOTALL)
    if not match:
        return {}, text
    frontmatter: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            frontmatter[key.strip()] = value.strip()
    return frontmatter, match.group(2)


def section_text(body: str, heading_pattern: str) -> str:
    match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
    return match.group(1).strip() if match else ""


def split_markdown_row(line: str) -> list[str]:
    text = line.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|"):
        text = text[:-1]
    cells: list[str] = []
    current: list[str] = []
    escaped = False
    for char in text:
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == "|":
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    cells.append("".join(current).strip())
    return cells


def is_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells if cell.strip())


def normalize_header(value: str) -> str:
    return re.sub(r"[\s`*_]+", "", value or "")


def parse_writeback_rows(body: str) -> list[dict[str, str]]:
    section = section_text(body, r"^##\s*4\.\s+写回计划")
    rows: list[dict[str, str]] = []
    headers: list[str] | None = None
    for line in section.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = split_markdown_row(line)
        if is_separator_row(cells):
            continue
        if headers is None:
            headers = [normalize_header(cell) for cell in cells]
            continue
        row = {headers[index]: cells[index] for index in range(min(len(headers), len(cells)))}
        rows.append({
            "target": row.get("写回位置") or row.get("目标") or row.get("target") or "",
            "content": row.get("写回内容") or row.get("内容") or row.get("content") or "",
            "downstream": row.get("下游调用") or row.get("下游") or row.get("downstream") or "",
            "state": row.get("状态") or row.get("state") or "",
        })
    return rows


def extract_target_path(target: str) -> str:
    match = re.search(r"(?:^|\s)((?:pipeline|brain|sessions)/[^\s`|，。；;]+)", target or "")
    if not match:
        return ""
    return match.group(1).strip().strip(".,，。；;")


def pipeline_step_for_path(path: str) -> str:
    parts = Path(path).parts
    if len(parts) < 2 or parts[0] != "pipeline":
        return ""
    return DIR_TO_STEP.get(parts[1], "")


def clean_heading(raw: str) -> str:
    heading = re.sub(r"^#+\s*", "", raw or "").strip()
    heading = heading.strip("` ")
    return heading or "DBS 融合补充"


def heading_from_target(target: str, step: str) -> str:
    backtick = re.search(r"`\s*(##\s*[^`]+?)\s*`", target or "")
    if backtick:
        return clean_heading(backtick.group(1))
    inline = re.search(r"(##\s*[^|，。；;]+)", target or "")
    if inline:
        return clean_heading(inline.group(1))
    for hint in TARGET_HEADING_HINTS:
        if hint in (target or ""):
            return hint
    return DEFAULT_HEADINGS.get(step, "DBS 融合补充")


def normalize_heading_value(value: str) -> str:
    text = clean_heading(value)
    text = re.sub(r"^\d+(?:\.\d+)?[\.、]?\s*", "", text)
    text = re.sub(r"\s+", "", text).lower()
    return text


def find_section_span(body: str, heading: str) -> tuple[int, int, str] | None:
    target = normalize_heading_value(heading)
    matches = list(re.finditer(r"(?m)^##\s+(.+?)\s*$", body or ""))
    for index, match in enumerate(matches):
        if normalize_heading_value(match.group(1)) != target:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        return match.start(), end, match.group(0)
    return None


def format_insert_content(content: str, fusion_rel: str, downstream: str) -> str:
    normalized = (content or "").replace("<br>", "\n").replace("<br/>", "\n").strip()
    if not normalized:
        normalized = "需要人工补充写回内容。"
    if "\n" not in normalized and "；" in normalized:
        parts = [part.strip() for part in re.split(r"[；;]\s*", normalized) if part.strip()]
        normalized = "\n".join(f"- {part}" for part in parts)
    elif "\n" not in normalized and not normalized.lstrip().startswith(("-", "*", "|")):
        normalized = f"- {normalized}"
    source_lines = [
        f"- 来源：`dbs-fusion apply`（{fusion_rel}，上游已通过 `/dbs-spread` / dbskill 融合审计）。",
    ]
    if downstream:
        source_lines.append(f"- 下游调用：{downstream}")
    return "\n".join(source_lines + [normalized]).strip() + "\n"


def replace_or_append_section(body: str, heading: str, content: str) -> tuple[str, str]:
    span = find_section_span(body, heading)
    if not span:
        clean = clean_heading(heading)
        appended = body.rstrip() + f"\n\n## {clean}\n{content}\n"
        return appended, "appended-section"
    start, end, existing_heading = span
    replacement = existing_heading + "\n" + content.strip() + "\n\n"
    return body[:start] + replacement + body[end:].lstrip("\n"), "replaced-section"


def resolve_pipeline_source(
    rt: ContentRuntime,
    step: str,
    target_rel: str,
    slug: str,
) -> dict[str, Any]:
    target_path = rt.project / target_rel
    if target_rel and target_path.exists() and target_path.is_file():
        return rt.read(step, file=target_rel)
    return rt.read(step, latest=True, slug=slug)


def apply_pipeline_row(
    rt: ContentRuntime,
    *,
    row: dict[str, str],
    target_rel: str,
    step: str,
    slug: str,
    run_id: str,
    fusion_rel: str,
    dry_run: bool,
) -> dict[str, Any]:
    try:
        rt.assert_frozen_tikomni_market_snapshot(step, run_id)
    except ValueError as exc:
        raise TikomniGateBlockedError(str(exc)) from exc
    source = resolve_pipeline_source(rt, step, target_rel, slug)
    source_slug = source.get("frontmatter", {}).get("slug") or slug
    heading = heading_from_target(row["target"], step)
    insert = format_insert_content(row["content"], fusion_rel, row.get("downstream", ""))
    updated, mode = replace_or_append_section(source["body"], heading, insert)
    result: dict[str, Any] = {
        "action": mode,
        "target_type": "pipeline",
        "target": row["target"],
        "target_path": target_rel,
        "step": step,
        "slug": source_slug,
        "heading": clean_heading(heading),
        "dry_run": dry_run,
    }
    if dry_run:
        result["status"] = "planned"
        return result
    written = rt.write(
        step,
        source_slug,
        updated,
        source=f"dbs-fusion-apply:{fusion_rel}",
        run_id=run_id,
    )
    result["output_path"] = written["path"]
    validation = rt.validate(step, written["path"])
    result["validation"] = {
        "valid": validation.get("valid"),
        "quality_status": validation.get("quality_status"),
        "quality_errors": validation.get("quality_errors"),
        "quality_reviews": validation.get("quality_reviews"),
    }
    result["status"] = "applied" if validation.get("valid") else "blocked"
    return result


def apply_brain_row(
    rt: ContentRuntime,
    *,
    row: dict[str, str],
    target_rel: str,
    fusion_rel: str,
    dry_run: bool,
) -> dict[str, Any]:
    brain_file = target_rel.removeprefix("brain/").strip("/")
    content = format_insert_content(row["content"], fusion_rel, row.get("downstream", ""))
    result: dict[str, Any] = {
        "action": "append-brain",
        "target_type": "brain",
        "target": row["target"],
        "target_path": target_rel,
        "brain_file": brain_file,
        "dry_run": dry_run,
    }
    if dry_run:
        result["status"] = "planned"
        return result
    written = rt.brain(brain_file, content=content)
    result["status"] = "applied"
    result["output_path"] = written["path"]
    return result


def apply_sessions_row(
    rt: ContentRuntime,
    *,
    row: dict[str, str],
    target_rel: str,
    fusion_rel: str,
    dry_run: bool,
) -> dict[str, Any]:
    target = rt.project / target_rel
    resolved = target.resolve(strict=False)
    sessions_root = rt.sessions.resolve(strict=False)
    if sessions_root not in resolved.parents and resolved != sessions_root:
        raise ValueError(f"sessions 写回路径越界: {target_rel}")
    content = format_insert_content(row["content"], fusion_rel, row.get("downstream", ""))
    result: dict[str, Any] = {
        "action": "append-session",
        "target_type": "sessions",
        "target": row["target"],
        "target_path": target_rel,
        "dry_run": dry_run,
    }
    if dry_run:
        result["status"] = "planned"
        return result
    target.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    with target.open("a", encoding="utf-8") as handle:
        handle.write(f"\n\n## {timestamp} dbs-fusion apply\n\n{content}\n")
    result["status"] = "applied"
    result["output_path"] = str(target)
    return result


def apply_row(
    rt: ContentRuntime,
    *,
    row: dict[str, str],
    slug: str,
    run_id: str,
    fusion_rel: str,
    dry_run: bool,
    force: bool,
) -> dict[str, Any]:
    target_rel = extract_target_path(row.get("target", ""))
    if not target_rel:
        return {
            "status": "blocked",
            "action": "unresolved-target",
            "target": row.get("target", ""),
            "message": "写回位置缺少 pipeline/、brain/ 或 sessions/ 路径。",
        }
    if target_rel.startswith("pipeline/"):
        step = pipeline_step_for_path(target_rel)
        if not step or step == "dbs-fusion":
            return {
                "status": "blocked",
                "action": "unsupported-pipeline-target",
                "target": row.get("target", ""),
                "target_path": target_rel,
                "message": "当前只支持写回下游 pipeline 步骤，不能写回 dbs-fusion 自身。",
            }
        try:
            return apply_pipeline_row(
                rt,
                row=row,
                target_rel=target_rel,
                step=step,
                slug=slug,
                run_id=run_id,
                fusion_rel=fusion_rel,
                dry_run=dry_run,
            )
        except Exception as exc:
            return {
                "status": "blocked",
                "action": "tikomni-gate-blocked" if isinstance(exc, TikomniGateBlockedError) else "pipeline-apply-error",
                "target": row.get("target", ""),
                "target_path": target_rel,
                "step": step,
                "message": str(exc),
            }
    if target_rel.startswith("brain/"):
        return apply_brain_row(rt, row=row, target_rel=target_rel, fusion_rel=fusion_rel, dry_run=dry_run)
    if target_rel.startswith("sessions/"):
        try:
            return apply_sessions_row(rt, row=row, target_rel=target_rel, fusion_rel=fusion_rel, dry_run=dry_run)
        except Exception as exc:
            return {
                "status": "blocked",
                "action": "sessions-apply-error",
                "target": row.get("target", ""),
                "target_path": target_rel,
                "message": str(exc),
            }
    return {
        "status": "blocked",
        "action": "unsupported-target",
        "target": row.get("target", ""),
        "target_path": target_rel,
        "message": "只支持 pipeline/、brain/、sessions/ 写回。",
    }


def rel_to_project(project: Path, path: str) -> str:
    target = Path(path)
    if target.is_absolute():
        try:
            return str(target.relative_to(project))
        except ValueError:
            return str(target)
    return str(target)


def apply_dbs_fusion(
    project: str | Path,
    file: str | None = None,
    slug: str | None = None,
    *,
    dry_run: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    rt = ContentRuntime(project)
    rt.init()
    fusion = rt.read("dbs-fusion", file=file, latest=file is None, slug=slug)
    fusion_path = fusion["path"]
    validation = rt.validate("dbs-fusion", fusion_path)
    if not validation.get("valid"):
        result = {
            "status": "blocked",
            "project": str(rt.project),
            "fusion_file": fusion_path,
            "slug": fusion.get("frontmatter", {}).get("slug") or slug,
            "dry_run": dry_run,
            "validation": validation,
            "rows": [],
            "issues": ["dbs-fusion 报告未通过 validate，禁止写回下游。"],
        }
        return write_apply_report(rt, result)

    target_slug = fusion.get("frontmatter", {}).get("slug") or slug or rt.state().get("current_slug")
    if not target_slug:
        raise ValueError("无法确定 slug，请指定 --slug。")
    try:
        run = rt.run_state(slug=target_slug)
    except (FileNotFoundError, ValueError) as exc:
        result = {
            "status": "blocked",
            "project": str(rt.project),
            "fusion_file": fusion_path,
            "slug": target_slug,
            "dry_run": dry_run,
            "force": force,
            "validation": {
                "valid": validation.get("valid"),
                "quality_status": validation.get("quality_status"),
                "quality_reviews": validation.get("quality_reviews"),
            },
            "rows": [],
            "issues": [f"无法定位该 DBS 写回所属 runtime run：{exc}"],
        }
        return write_apply_report(rt, result)
    run_id = str(run.get("run_id") or "")
    if not run_id:
        result = {
            "status": "blocked",
            "project": str(rt.project),
            "fusion_file": fusion_path,
            "slug": target_slug,
            "dry_run": dry_run,
            "force": force,
            "validation": {
                "valid": validation.get("valid"),
                "quality_status": validation.get("quality_status"),
                "quality_reviews": validation.get("quality_reviews"),
            },
            "rows": [],
            "issues": ["DBS 写回所属 runtime run 缺少 run_id。"],
        }
        return write_apply_report(rt, result)
    previous_run_id = str(rt.state().get("active_run_id") or "")
    fusion_rel = rel_to_project(rt.project, fusion_path)
    rows = parse_writeback_rows(fusion["body"])
    try:
        applied_rows = [
            apply_row(rt, row=row, slug=target_slug, run_id=run_id, fusion_rel=fusion_rel, dry_run=dry_run, force=force)
            for row in rows
        ]
    finally:
        # A fusion report can target an older run while another run is open in
        # the desktop UI. Explicit writes stay bound to the target run, then
        # restore the operator's current workspace focus.
        if previous_run_id and previous_run_id != run_id:
            try:
                rt.switch_run(previous_run_id)
            except (FileNotFoundError, ValueError):
                pass
    blocked = [row for row in applied_rows if row.get("status") == "blocked"]
    review = [row for row in applied_rows if row.get("status") == "review_required"]
    status = "blocked" if blocked else ("review_required" if review else "pass")
    if dry_run and not blocked:
        status = "planned"
    result = {
        "status": status,
        "project": str(rt.project),
        "fusion_file": fusion_path,
        "slug": target_slug,
        "run_id": run_id,
        "dry_run": dry_run,
        "force": force,
        "validation": {
            "valid": validation.get("valid"),
            "quality_status": validation.get("quality_status"),
            "quality_reviews": validation.get("quality_reviews"),
        },
        "row_count": len(rows),
        "rows": applied_rows,
        "summary": {
            "applied": len([row for row in applied_rows if row.get("status") == "applied"]),
            "planned": len([row for row in applied_rows if row.get("status") == "planned"]),
            "blocked": len(blocked),
            "review_required": len(review),
        },
    }
    return write_apply_report(rt, result)


def write_apply_report(rt: ContentRuntime, result: dict[str, Any]) -> dict[str, Any]:
    reports_dir = rt.project / "quality" / "dbs-fusion-applies"
    reports_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    slug = rt.normalize_slug(str(result.get("slug") or "dbs-fusion"))
    path = reports_dir / f"{stamp}-{slug}-apply.json"
    result["report_path"] = str(path)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply dbs-fusion writeback plans")
    parser.add_argument("--project", required=True)
    parser.add_argument("--file", default=None, help="dbs-fusion report path; defaults to latest")
    parser.add_argument("--slug", default=None, help="read latest dbs-fusion for slug or fallback target slug")
    parser.add_argument("--dry-run", action="store_true", help="parse and validate without writing")
    parser.add_argument("--force", action="store_true", help="apply rows even when their status says already written")
    args = parser.parse_args()
    try:
        result = apply_dbs_fusion(args.project, args.file, args.slug, dry_run=args.dry_run, force=args.force)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] in {"pass", "planned", "review_required"} else 2
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

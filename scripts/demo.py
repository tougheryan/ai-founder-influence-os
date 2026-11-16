#!/usr/bin/env python3
"""Create AIFIOS demo projects and print their pipeline status."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
sys.path.insert(0, str(RUNTIME_DIR))

from content_pipeline import PipelineDirector  # noqa: E402
from content_runtime import ContentRuntime, STEP_DIRS  # noqa: E402
from native_demo import create_native_demo, verify_native_demo, offline_layout  # noqa: E402
from visual_publish import generate_publish_outputs  # noqa: E402
from visual_release import build_visual_selection_manifest  # noqa: E402


PLATFORM_DEMOS = ["wechat", "xhs", "shipinhao"]


def project_relative(project: Path, path: str) -> str:
    return str(Path(path).resolve(strict=False).relative_to(project.resolve(strict=False)))


def materialize_demo_references(content: str, slug: str, written_paths: dict[str, str]) -> str:
    """Replace readable demo placeholders with actual runtime artifact paths."""
    result = content
    for step, rel in written_paths.items():
        directory = STEP_DIRS.get(step, step)
        result = result.replace(f"pipeline/{directory}/...-{slug}-{step}.md", rel)
        result = result.replace(f"pipeline/{directory}/{slug}-{step}.md", rel)
    draft_rel = written_paths.get("write") or written_paths.get("xhs")
    if draft_rel:
        result = result.replace(f"pipeline/final/...-{slug}-write.md", draft_rel)
    return result


def write_demo_visual_assets(project: Path, slug: str) -> dict[str, object]:
    """Render a real selected recipe and keep legacy demo aliases readable."""
    screenshot_source = REPO_ROOT / "skills" / "content-runtime" / "fixtures" / "visual-director" / "product-flow.png"
    screenshot_target = project / "materials" / "screenshots" / "product-flow.png"
    screenshot_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(screenshot_source, screenshot_target)

    with offline_layout():
        result = generate_publish_outputs(
            project=project,
            slug=slug,
            renderer="local",
            write_runtime_record=True,
        )
    index_path = Path(str(result["index_path"]))
    index = json.loads(index_path.read_text(encoding="utf-8"))
    quality_summary = index.get("quality_summary") if isinstance(index, dict) else None
    if not isinstance(quality_summary, dict) or quality_summary.get("status") != "pass":
        raise RuntimeError(f"demo visual recipe did not pass quality gate: {quality_summary}")

    revision_id = str(index.get("revision_id") or "")
    if not revision_id:
        raise RuntimeError("demo visual recipe is missing revision_id")
    visual_dir = project / "pipeline" / "visual" / slug
    selection_path = visual_dir / "selected-revision.json"
    selection = build_visual_selection_manifest(project, slug, revision_id)
    selection_path.write_text(
        json.dumps(selection, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    outputs = {str(item.get("id") or ""): project / str(item.get("output") or "") for item in index.get("outputs", [])}
    visual_dir = project / "pipeline" / "visual" / slug
    html_dir = visual_dir / "公众号HTML输出"
    html_dir.mkdir(parents=True, exist_ok=True)
    aliases = {
        visual_dir / "cover.png": outputs.get("wechat-cover"),
        visual_dir / "share-card.png": outputs.get("wechat-share"),
        visual_dir / "inline-xiaohei.png": outputs.get("xhs-01-p2"),
        html_dir / "index.html": outputs.get("wechat-html"),
    }
    for alias, source in aliases.items():
        if source is None or not source.is_file():
            raise RuntimeError(f"demo visual output is missing for alias: {alias.name}")
        shutil.copyfile(source, alias)
    return result


def create_full_demo(project: Path, slug: str) -> dict[str, object]:
    rt = ContentRuntime(project)
    init_result = rt.init(demo=True)
    write_demo_visual_assets(project, slug)
    director = PipelineDirector(project, slug=slug)
    status = director.status()
    return {
        "status": "demo_ready",
        "mode": "full",
        "project": str(project),
        "slug": slug,
        "demo_files": len(init_result.get("demo_files", [])),
        "current_step": status.get("current_step"),
        "active_slug": status.get("active_slug"),
        "target_platforms": status.get("target_platforms", []),
        "warnings": status.get("warnings", []),
    }


def create_platform_demo(project: Path, platform: str, slug: str | None = None) -> dict[str, object]:
    if platform not in PLATFORM_DEMOS:
        raise ValueError(f"unsupported demo platform: {platform}")
    return create_native_demo(project, [platform], slug or f"{platform}-demo")


def main() -> int:
    parser = argparse.ArgumentParser(description="Create an AIFIOS demo project")
    parser.add_argument("--project", default="/private/tmp/aifios-demo", help="demo project directory")
    parser.add_argument("--slug", default="codex-demo", help="demo slug")
    parser.add_argument(
        "--platform",
        default="full",
        choices=["full", "all", *PLATFORM_DEMOS],
        help="full (legacy compatibility) | all | wechat | xhs | shipinhao",
    )
    parser.add_argument("--reset", action="store_true", help="remove existing demo project before creating it")
    parser.add_argument("--verify", action="store_true", help="read-only verification of a current single-platform demo")
    args = parser.parse_args()
    if args.verify and (args.reset or args.platform not in PLATFORM_DEMOS):
        parser.error("--verify requires a single platform and cannot use --reset")

    project = Path(args.project).expanduser().resolve(strict=False)
    if args.verify:
        slug = f"{args.platform}-demo" if args.slug == "codex-demo" else args.slug
        print(json.dumps(verify_native_demo(project, [args.platform], slug), ensure_ascii=False, indent=2))
        return 0
    if args.reset and project.exists():
        shutil.rmtree(project)

    if args.platform == "full":
        result: dict[str, object] = create_full_demo(project, args.slug)
    elif args.platform == "all":
        result = {
            "status": "demo_ready",
            "mode": "platform-suite",
            "project": str(project),
            "demos": [
                create_platform_demo(project / platform, platform)
                for platform in PLATFORM_DEMOS
            ],
        }
    else:
        result = create_platform_demo(project, args.platform, None if args.slug == "codex-demo" else args.slug)

    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"Demo project: {project}")
    print("虚构离线演示：自动确认不代表真人验收；delivery 仅输出内部检查目录。")
    print("Try:")
    if result.get("mode") == "platform-suite":
        for demo in result.get("demos", []):
            print(f"  python3 scripts/demo.py --project {demo['project']} --platform {demo['target_platforms'][0]} --verify")
            print(f"  python3 scripts/aifios.py --project {demo['project']} delivery --run-id {demo['run_id']}")
    else:
        print(f"  make status PROJECT={project} SLUG={result.get('slug', args.slug)}")
        print(f"  make read PROJECT={project} STEP=intake SLUG={result.get('slug', args.slug)}")
        if result.get("mode") == "single-platform":
            print(f"  python3 scripts/aifios.py --project {project} delivery --run-id {result['run_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

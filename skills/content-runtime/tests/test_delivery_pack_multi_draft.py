from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import delivery_pack as delivery_pack_module
from delivery_pack import (
    DRAFT_QUEUE_SCHEMA,
    FORMAL_DELIVERY_SCOPE,
    INTERNAL_REVIEW_MARKER,
    INTERNAL_REVIEW_SCOPE,
    REQUIRED_DRAFT_QUEUE_JOBS,
    REQUIRED_PLATFORM_PUBLISH_FILE_TEMPLATES,
    build_delivery_pack,
    matched_benchmark_reports,
    packaged_draft_paths,
    publication_delivery_prerequisites,
)
from delivery_audit import (
    inspect_delivery_package_integrity,
    inspect_publication_draft_queue_delivery_members,
)


def _required_publish_paths(slug: str) -> list[str]:
    return [f"pipeline/publish-assets/{template.format(slug=slug)}" for template in REQUIRED_PLATFORM_PUBLISH_FILE_TEMPLATES]


def _write_complete_publication_contract(project: Path, slug: str) -> dict[str, object]:
    package_path = f"pipeline/package/{slug}-package.md"
    (project / package_path).parent.mkdir(parents=True, exist_ok=True)
    (project / package_path).write_text("# content package\n", encoding="utf-8")
    paths = _required_publish_paths(slug)
    for relative in paths:
        target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"# {target.stem}\n", encoding="utf-8")

    sidecar_path = project / f"pipeline/publish-assets/{slug}-platform-deliverables.json"
    sidecar_path.write_text(json.dumps({
        "archive": {"generatedPaths": [*paths, f"pipeline/publish-assets/{slug}-platform-deliverables.json"]},
    }), encoding="utf-8")

    expected_path_by_job = {("wechat", "wechat-article", "draft_fill"): package_path}
    # Explicit paths keep this fixture easy to audit when the production
    # contract changes: the WeChat job is intentionally bound to the package,
    # while the other ten jobs bind to their direct publishing forms.
    expected_path_by_job.update({
        ("xiaohongshu", "xiaohongshu-opinion-1", "draft_fill"): f"pipeline/publish-assets/{slug}/xiaohongshu-01.md",
        ("xiaohongshu", "xiaohongshu-opinion-2", "draft_fill"): f"pipeline/publish-assets/{slug}/xiaohongshu-02.md",
        ("xiaohongshu", "xiaohongshu-opinion-3", "draft_fill"): f"pipeline/publish-assets/{slug}/xiaohongshu-03.md",
        ("moments", "moments-opinion-1", "draft_fill"): f"pipeline/publish-assets/{slug}/moments-01.md",
        ("moments", "moments-opinion-2", "draft_fill"): f"pipeline/publish-assets/{slug}/moments-02.md",
        ("moments", "moments-opinion-3", "draft_fill"): f"pipeline/publish-assets/{slug}/moments-03.md",
        ("shipinhao", "shipinhao-video-execution-1", "execution_package"): f"pipeline/publish-assets/{slug}/shipinhao-short-01.md",
        ("shipinhao", "shipinhao-video-execution-2", "execution_package"): f"pipeline/publish-assets/{slug}/shipinhao-short-02.md",
        ("douyin", "douyin-video-execution-1", "execution_package"): f"pipeline/publish-assets/{slug}/douyin-short-01.md",
        ("douyin", "douyin-video-execution-2", "execution_package"): f"pipeline/publish-assets/{slug}/douyin-short-02.md",
    })
    jobs = []
    for index, (platform, item_id, delivery_kind) in enumerate(sorted(REQUIRED_DRAFT_QUEUE_JOBS), start=1):
        copy_path = expected_path_by_job[(platform, item_id, delivery_kind)]
        payload: dict[str, object] = {
            "title": f"{item_id} title",
            "copy_path": copy_path,
            "asset_paths": [],
        }
        if delivery_kind == "execution_package":
            payload["execution_package_path"] = copy_path
        jobs.append({
            "job_id": f"draft_{index:020x}",
            "platform": platform,
            "item_id": item_id,
            "delivery_kind": delivery_kind,
            "payload": payload,
            "payload_hash": "a" * 64,
            "content_hash": "b" * 64,
        })
    queue_path = project / f"materials/publication/drafts/{slug}/draft-queue.json"
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    queue_path.write_text(json.dumps({
        "schema": DRAFT_QUEUE_SCHEMA,
        "queue_id": f"queue_{slug}",
        "run_id": slug,
        "run_slug": slug,
        "package_path": package_path,
        "package_sha256": "c" * 64,
        "jobs": jobs,
    }), encoding="utf-8")
    return {
        "run_id": slug,
        "slug": slug,
        "topic": "五平台交付",
        "target_platforms": ["wechat", "xiaohongshu", "moments", "shipinhao", "douyin"],
        "steps": {},
    }


def test_packaged_draft_paths_keeps_every_current_member_referenced_by_package() -> None:
    run = {
        "steps": {
            "package": {
                "source": (
                    "write:pipeline/final/01-write.md;"
                    "write:pipeline/final/02-write.md;"
                    "write:pipeline/final/03-write.md;"
                    "xhs:pipeline/xhs/01-xhs.md;"
                    "xhs:pipeline/xhs/02-xhs.md;"
                    "xhs:pipeline/xhs/03-xhs.md"
                ),
            },
            "write": {"latest": "pipeline/final/03-write.md"},
            "xhs": {"latest": "pipeline/xhs/03-xhs.md"},
        },
    }

    assert packaged_draft_paths(run, "write") == [
        "pipeline/final/01-write.md",
        "pipeline/final/02-write.md",
        "pipeline/final/03-write.md",
    ]
    assert packaged_draft_paths(run, "xhs") == [
        "pipeline/xhs/01-xhs.md",
        "pipeline/xhs/02-xhs.md",
        "pipeline/xhs/03-xhs.md",
    ]


def test_packaged_draft_paths_falls_back_to_latest_when_package_has_no_member() -> None:
    run = {"steps": {"write": {"latest": "pipeline/final/current.md"}}}

    assert packaged_draft_paths(run, "write") == ["pipeline/final/current.md"]


def test_publication_prerequisites_require_the_exact_five_platform_contract(tmp_path: Path) -> None:
    slug = "exact-five-platform-contract"
    run = _write_complete_publication_contract(tmp_path, slug)

    assert len(REQUIRED_PLATFORM_PUBLISH_FILE_TEMPLATES) == 11
    assert publication_delivery_prerequisites(tmp_path, run)["errors"] == []

    sidecar_path = tmp_path / f"pipeline/publish-assets/{slug}-platform-deliverables.json"
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sidecar["archive"]["generatedPaths"].append(_required_publish_paths(slug)[0])
    sidecar_path.write_text(json.dumps(sidecar), encoding="utf-8")

    errors = publication_delivery_prerequisites(tmp_path, run)["errors"]
    assert any("精确声明每项固定交付文件一次" in item for item in errors)


def test_publication_prerequisites_reject_queue_payload_substitution(tmp_path: Path) -> None:
    slug = "wrong-queue-binding"
    run = _write_complete_publication_contract(tmp_path, slug)
    queue_path = tmp_path / f"materials/publication/drafts/{slug}/draft-queue.json"
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    target = next(job for job in queue["jobs"] if job["item_id"] == "xiaohongshu-opinion-1")
    target["payload"]["copy_path"] = f"pipeline/publish-assets/{slug}/moments-01.md"
    queue_path.write_text(json.dumps(queue), encoding="utf-8")

    errors = publication_delivery_prerequisites(tmp_path, run)["errors"]
    assert any("未绑定对应的固定发布稿" in item for item in errors)


def test_publication_prerequisites_reject_unapproved_publish_asset_paths(tmp_path: Path) -> None:
    slug = "unapproved-publish-asset"
    run = _write_complete_publication_contract(tmp_path, slug)
    extra_path = f"pipeline/publish-assets/{slug}/surprise-customer-file.md"
    extra = tmp_path / extra_path
    extra.write_text("not an approved delivery item\n", encoding="utf-8")
    sidecar_path = tmp_path / f"pipeline/publish-assets/{slug}-platform-deliverables.json"
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sidecar["archive"]["generatedPaths"].append(extra_path)
    sidecar_path.write_text(json.dumps(sidecar), encoding="utf-8")

    errors = publication_delivery_prerequisites(tmp_path, run)["errors"]
    assert any("非契约发布文件" in item for item in errors)


def test_matched_benchmark_reports_uses_only_current_run_source_declarations(tmp_path: Path) -> None:
    benchmark_dir = tmp_path / "materials" / "hit-library" / "benchmark"
    benchmark_dir.mkdir(parents=True)
    step_report = benchmark_dir / "step-report.md"
    history_report = benchmark_dir / "history-report.md"
    unrelated_report = benchmark_dir / "newest-unrelated.md"
    for report in (step_report, history_report, unrelated_report):
        report.write_text("# benchmark\n", encoding="utf-8")

    run = {
        "steps": {
            "blueprint": {
                "source": (
                    "benchmark:materials/hit-library/benchmark/step-report.md;"
                    "reference:materials/hit-library/benchmark/newest-unrelated.md;"
                    "benchmark:materials/hit-library/benchmark/not-a-report.txt"
                ),
            },
        },
        "history": [
            {
                "source": (
                    "benchmark:materials/hit-library/benchmark/history-report.md;"
                    "benchmark:/tmp/outside.md"
                ),
            },
        ],
    }

    assert matched_benchmark_reports(tmp_path, run) == [step_report, history_report]


def test_delivery_pack_includes_current_platform_publish_assets_in_directory_and_zip(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    slug = "five-platform-demo"
    publish_root = tmp_path / "pipeline" / "publish-assets"
    generated_root = publish_root / slug
    generated_root.mkdir(parents=True)
    expected_relative_paths = [
        *_required_publish_paths(slug),
        f"pipeline/publish-assets/{slug}-publish-assets.md",
    ]
    for relative in expected_relative_paths:
        target = tmp_path / relative
        target.write_text(f"# {target.stem}\n", encoding="utf-8")

    sidecar_relative = f"pipeline/publish-assets/{slug}-platform-deliverables.json"
    (tmp_path / sidecar_relative).write_text(json.dumps({
        "archive": {"generatedPaths": [*expected_relative_paths, sidecar_relative]},
    }), encoding="utf-8")

    queue_relative = f"materials/publication/drafts/{slug}/draft-queue.json"
    queue_path = tmp_path / queue_relative
    queue_path.parent.mkdir(parents=True)
    queue_path.write_text(json.dumps({
        "schema": DRAFT_QUEUE_SCHEMA,
        "run_id": slug,
        "run_slug": slug,
        "jobs": [
            {"platform": platform, "item_id": item_id, "delivery_kind": delivery_kind}
            for platform, item_id, delivery_kind in sorted(REQUIRED_DRAFT_QUEUE_JOBS)
        ],
    }), encoding="utf-8")

    run = {
        "run_id": slug,
        "slug": slug,
        "topic": "五平台交付",
        "target_platforms": ["wechat", "xiaohongshu", "shipinhao", "douyin", "moments"],
        "steps": {},
    }

    class RuntimeStub:
        def __init__(self, project: Path) -> None:
            self.project = project

        def init(self) -> None:
            return None

        def run_state(self, **_kwargs: object) -> dict[str, object]:
            return run

    class PipelineStub:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def status(self) -> dict[str, object]:
            return {"target_platforms": run["target_platforms"]}

    monkeypatch.setattr(delivery_pack_module, "ContentRuntime", RuntimeStub)
    monkeypatch.setattr(delivery_pack_module, "PipelineDirector", PipelineStub)
    monkeypatch.setattr(delivery_pack_module, "copy_visual_assets", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(delivery_pack_module, "matched_benchmark_reports", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(delivery_pack_module, "matched_quality_reports", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(delivery_pack_module, "matched_system_audit_reports", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(delivery_pack_module, "delivery_gate", lambda *_args, **_kwargs: {
        "status": "pass", "label": "可交付", "can_deliver": True,
        "needs_human_review": False, "recommended_actions": [], "message": "fixture",
    })

    result = build_delivery_pack(tmp_path, slug=slug)

    assert result["status"] == "ready_for_delivery"
    assert result["delivery_scope"] == FORMAL_DELIVERY_SCOPE
    assert result["formal_delivery"] is True
    artifact = next(item for item in result["artifacts"] if item["step"] == "publish-assets")
    delivery_dir = Path(result["delivery_dir"])
    expected_members = {
        str(Path("artifacts") / "publish-assets" / Path(path).relative_to("pipeline/publish-assets"))
        for path in expected_relative_paths
    }
    expected_members.add(f"artifacts/publish-assets/{slug}-platform-deliverables.json")
    expected_members.add("artifacts/publication-draft-queue/draft-queue.json")
    assert artifact["copied_to"]
    assert {str(Path(path).relative_to(delivery_dir)) for path in artifact["files"]} == {
        str(Path("artifacts") / "publish-assets" / Path(path).relative_to("pipeline/publish-assets"))
        for path in expected_relative_paths
    }
    with zipfile.ZipFile(result["zip_path"]) as archive:
        assert expected_members <= set(archive.namelist())
    queue_artifact = next(item for item in result["artifacts"] if item["step"] == "publication-draft-queue")
    assert queue_artifact["source"] == queue_relative
    assert queue_artifact["copied_to"]


def test_delivery_audit_blocks_missing_five_platform_assets_and_draft_queue(tmp_path: Path) -> None:
    for name in (
        "README.md",
        "客户交付说明.md",
        "客户成果报告.md",
        "修改意见回填.md",
        "隐私检查清单.md",
    ):
        (tmp_path / name).write_text("delivery fixture\n", encoding="utf-8")
    manifest = {
        "run_id": "missing-publication-artifacts",
        "slug": "missing-publication-artifacts",
        "artifacts": [],
        "delivery_gate": {},
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    issues = inspect_delivery_package_integrity(manifest, tmp_path, None)
    codes = {item["code"] for item in issues}

    assert "delivery-publish-assets-missing" in codes
    assert "delivery-draft-queue-missing" in codes


def test_delivery_audit_rejects_an_internal_review_zip(tmp_path: Path) -> None:
    for name in (
        "README.md",
        "客户交付说明.md",
        "客户成果报告.md",
        "修改意见回填.md",
        "隐私检查清单.md",
        INTERNAL_REVIEW_MARKER,
    ):
        (tmp_path / name).write_text("internal review only\n", encoding="utf-8")
    manifest = {
        "run_id": "internal-review",
        "slug": "internal-review",
        "manifest_scope": INTERNAL_REVIEW_SCOPE,
        "artifacts": [],
        "delivery_gate": {"status": "blocked", "can_deliver": False, "recommended_actions": []},
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    zip_path = tmp_path.parent / "internal-review.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(tmp_path / "manifest.json", "manifest.json")

    issues = inspect_delivery_package_integrity(manifest, tmp_path, str(zip_path))
    assert any(item["code"] == "delivery-internal-review-zip" for item in issues)


def test_delivery_audit_rejects_a_tampered_queue_payload_binding(tmp_path: Path) -> None:
    slug = "copied-queue-binding"
    _write_complete_publication_contract(tmp_path, slug)
    source_queue_path = tmp_path / f"materials/publication/drafts/{slug}/draft-queue.json"
    queue = json.loads(source_queue_path.read_text(encoding="utf-8"))
    target = next(job for job in queue["jobs"] if job["item_id"] == "douyin-video-execution-1")
    target["payload"]["execution_package_path"] = f"pipeline/publish-assets/{slug}/shipinhao-short-01.md"
    copied_queue = tmp_path / "artifacts/publication-draft-queue/draft-queue.json"
    copied_queue.parent.mkdir(parents=True)
    copied_queue.write_text(json.dumps(queue), encoding="utf-8")
    manifest = {
        "run_id": slug,
        "slug": slug,
        "artifacts": [{
            "step": "publication-draft-queue",
            "source": f"materials/publication/drafts/{slug}/draft-queue.json",
            "copied_to": "artifacts/publication-draft-queue/draft-queue.json",
        }],
    }

    _members, issues = inspect_publication_draft_queue_delivery_members(manifest, tmp_path)
    assert any(item["code"] == "delivery-draft-queue-invalid" for item in issues)


def test_delivery_audit_blocks_rejected_platform_publish_asset_paths(tmp_path: Path) -> None:
    for name in (
        "README.md",
        "客户交付说明.md",
        "客户成果报告.md",
        "修改意见回填.md",
        "隐私检查清单.md",
    ):
        (tmp_path / name).write_text("delivery fixture\n", encoding="utf-8")
    sidecar = tmp_path / "artifacts" / "publish-assets" / "demo-platform-deliverables.json"
    sidecar.parent.mkdir(parents=True)
    sidecar.write_text("{}", encoding="utf-8")
    manifest = {
        "artifacts": [{
            "step": "publish-assets",
            "source": "pipeline/publish-assets/demo-platform-deliverables.json",
            "copied_to": str(sidecar.relative_to(tmp_path)),
            "files": [],
            "rejected_count": 1,
            "missing_count": 0,
            "skipped_sensitive_count": 0,
            "errors": [],
        }],
        "delivery_gate": {},
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    issues = inspect_delivery_package_integrity(manifest, tmp_path, None)

    assert any(item["code"] == "delivery-publish-assets-rejected" for item in issues)


def test_platform_publish_assets_reject_foreign_and_symlinked_generated_paths(tmp_path: Path) -> None:
    slug = "publish-assets-safety"
    publish_root = tmp_path / "pipeline" / "publish-assets"
    generated_root = publish_root / slug
    generated_root.mkdir(parents=True)
    valid_source = generated_root / "wechat-share-01.md"
    valid_source.write_text("# valid share\n", encoding="utf-8")
    outside = tmp_path / "outside.md"
    outside.write_text("outside\n", encoding="utf-8")
    symlinked_source = generated_root / "xiaohongshu-video-short-01.md"
    symlinked_source.symlink_to(outside)
    foreign_source = publish_root / "other-run" / "wechat-share-01.md"
    foreign_source.parent.mkdir(parents=True)
    foreign_source.write_text("foreign\n", encoding="utf-8")
    sidecar = publish_root / f"{slug}-platform-deliverables.json"
    sidecar.write_text(json.dumps({
        "archive": {
            "generatedPaths": [
                str(valid_source.relative_to(tmp_path)),
                str(symlinked_source.relative_to(tmp_path)),
                str(foreign_source.relative_to(tmp_path)),
            ],
        },
    }), encoding="utf-8")

    result = delivery_pack_module.copy_platform_publish_assets(
        tmp_path,
        slug,
        tmp_path / "delivery" / "artifacts" / "publish-assets",
    )

    assert result["rejected_count"] == 2
    assert result["missing_count"] == 0
    assert result["files"] == [
        str(tmp_path / "delivery" / "artifacts" / "publish-assets" / slug / valid_source.name),
    ]
    assert not (tmp_path / "delivery" / "artifacts" / "publish-assets" / slug / symlinked_source.name).exists()
    assert not (tmp_path / "delivery" / "artifacts" / "publish-assets" / "other-run").exists()


def test_delivery_pack_keeps_invalid_sidecar_visible_to_the_audit(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    slug = "unsafe-sidecar"
    publish_root = tmp_path / "pipeline" / "publish-assets"
    publish_root.mkdir(parents=True)
    outside = tmp_path / "outside-platform-deliverables.json"
    outside.write_text(json.dumps({"archive": {"generatedPaths": []}}), encoding="utf-8")
    sidecar = publish_root / f"{slug}-platform-deliverables.json"
    sidecar.symlink_to(outside)
    run = {
        "run_id": slug,
        "slug": slug,
        "topic": "不安全清单",
        "target_platforms": ["wechat"],
        "steps": {},
    }

    class RuntimeStub:
        def __init__(self, project: Path) -> None:
            self.project = project

        def init(self) -> None:
            return None

        def run_state(self, **_kwargs: object) -> dict[str, object]:
            return run

    class PipelineStub:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def status(self) -> dict[str, object]:
            return {"target_platforms": run["target_platforms"]}

    monkeypatch.setattr(delivery_pack_module, "ContentRuntime", RuntimeStub)
    monkeypatch.setattr(delivery_pack_module, "PipelineDirector", PipelineStub)
    monkeypatch.setattr(delivery_pack_module, "copy_visual_assets", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(delivery_pack_module, "matched_benchmark_reports", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(delivery_pack_module, "matched_quality_reports", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(delivery_pack_module, "matched_system_audit_reports", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(delivery_pack_module, "delivery_gate", lambda *_args, **_kwargs: {
        "status": "not_audited", "label": "未审查", "can_deliver": False,
        "needs_human_review": True, "recommended_actions": [], "message": "fixture",
    })

    result = build_delivery_pack(tmp_path, slug=slug)

    assert result["status"] == "internal_review_only"
    assert result["delivery_scope"] == INTERNAL_REVIEW_SCOPE
    assert result["zip_path"] is None
    assert (Path(result["delivery_dir"]) / INTERNAL_REVIEW_MARKER).is_file()
    artifact = next(item for item in result["artifacts"] if item["step"] == "publish-assets")
    assert artifact["source"] == f"pipeline/publish-assets/{slug}-platform-deliverables.json"
    assert artifact["copied_to"] is None
    assert artifact["rejected_count"] == 1
    manifest = json.loads((Path(result["delivery_dir"]) / "manifest.json").read_text(encoding="utf-8"))
    issues = inspect_delivery_package_integrity(manifest, Path(result["delivery_dir"]), result["zip_path"])
    assert any(item["code"] == "delivery-publish-assets-rejected" for item in issues)


def test_delivery_audit_requires_every_sidecar_generated_path_in_directory_and_zip(tmp_path: Path) -> None:
    slug = "platform-members"
    for name in (
        "README.md",
        "客户交付说明.md",
        "客户成果报告.md",
        "修改意见回填.md",
        "隐私检查清单.md",
    ):
        (tmp_path / name).write_text("delivery fixture\n", encoding="utf-8")
    asset_root = tmp_path / "artifacts" / "publish-assets" / slug
    asset_root.mkdir(parents=True)
    delivered_share = asset_root / "wechat-share-01.md"
    delivered_share.write_text("# share\n", encoding="utf-8")
    sidecar_rel = f"artifacts/publish-assets/{slug}-platform-deliverables.json"
    sidecar = tmp_path / sidecar_rel
    sidecar.write_text(json.dumps({
        "archive": {
            "generatedPaths": [
                f"pipeline/publish-assets/{slug}/wechat-share-01.md",
                f"pipeline/publish-assets/{slug}/xiaohongshu-video-short-01.md",
                f"pipeline/publish-assets/{slug}-platform-deliverables.json",
            ],
        },
    }), encoding="utf-8")
    manifest = {
        "slug": slug,
        "artifacts": [{
            "step": "publish-assets",
            "source": f"pipeline/publish-assets/{slug}-platform-deliverables.json",
            "copied_to": sidecar_rel,
            "files": [f"artifacts/publish-assets/{slug}/wechat-share-01.md"],
            "rejected_count": 0,
            "missing_count": 0,
            "skipped_sensitive_count": 0,
            "errors": [],
        }],
        "delivery_gate": {},
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    directory_issues = inspect_delivery_package_integrity(manifest, tmp_path, None)
    assert any(item["code"] == "delivery-publish-assets-missing" for item in directory_issues)

    zip_path = tmp_path.parent / "platform-members.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in tmp_path.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(tmp_path))
    zip_issues = inspect_delivery_package_integrity(manifest, tmp_path, str(zip_path))
    assert any(item["code"] == "delivery-zip-missing-platform-publish-assets" for item in zip_issues)

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "migrate_final_publication_history.py"
FIXTURE = Path(__file__).parent / "fixtures" / "final-publication-history.fixture.json"


def load_module():
    spec = importlib.util.spec_from_file_location("migrate_final_publication_history", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_file(project: Path, relative: str, content: str | bytes) -> Path:
    target = project / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        target.write_bytes(content)
    else:
        target.write_text(content, encoding="utf-8")
    return target


def write_fixture(project: Path) -> dict[str, object]:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    final_path = "pipeline/final/legacy-published.md"
    asset_path = "pipeline/visual/legacy-topic/publish/r001/wechat/cover.png"
    publish_path = "pipeline/publish/legacy-topic-publish.md"
    performance_path = "pipeline/performance/legacy-topic-performance.md"
    visual_manifest_path = "pipeline/visual/legacy-topic/selected-assets.json"

    final_content = str(fixture["final_content"])
    asset_bytes = str(fixture["visual_asset"]).encode("utf-8")
    asset_hash = hashlib.sha256(asset_bytes).hexdigest()
    write_file(project, final_path, final_content)
    write_file(project, asset_path, asset_bytes)
    write_file(project, visual_manifest_path, json.dumps({
        "schema": "aifios.visual-asset-manifest.v1",
        "slug": fixture["slug"],
        "sourceContentHash": "a" * 64,
        "requiredRoles": ["wechat_cover"],
        "selections": {
            "wechat_cover": {
                "assetId": "wechat-cover",
                "semanticRole": "wechat_cover",
                "revisionId": "r001",
                "path": asset_path,
                "sha256": asset_hash,
                "platformBindings": ["wechat"]
            }
        }
    }, ensure_ascii=False))
    write_file(project, publish_path, "\n".join([
        "---",
        "step: publish",
        f"slug: {fixture['slug']}",
        "---",
        "",
        "# Publication record",
        f"- Final content path: {final_path}",
        "- Published platform: wechat",
        "- Published at: 2026-07-01T09:00:00Z",
        f"- Published URL: {fixture['publication_url']}",
        "",
    ]))
    write_file(project, performance_path, "\n".join([
        "---",
        "step: performance",
        f"slug: {fixture['slug']}",
        "---",
        "| metric | value | definition |",
        "| --- | ---: | --- |",
        "| reads | 128 | article reads |",
        "| shares | 9 | article shares |",
        "",
    ]))
    write_file(project, "materials/performance/wechat/legacy-topic.json", json.dumps(fixture["performance"], ensure_ascii=False))
    write_file(project, "materials/performance/raw/legacy-topic.json", '{"token":"must-not-be-copied"}')
    write_file(project, "materials/performance/review-inputs/legacy-topic.json", '{"draft":"must-not-be-copied"}')
    write_file(project, "pipeline/drafts/legacy-draft.md", "draft must not be copied")
    write_file(project, "pipeline/angles/legacy-angle.md", "angle must not be copied")
    write_file(project, "pipeline/breakdown/legacy-breakdown.md", "breakdown must not be copied")
    write_file(project, "pipeline/audit/legacy-audit.md", "internal report must not be copied")
    write_file(project, "sessions/session-state.json", '{"legacy_chat":"must-not-be-copied"}')
    write_file(project, "runs/legacy-run.json", json.dumps({
        "run_id": fixture["run_id"],
        "slug": fixture["slug"],
        "topic": fixture["topic"],
        "steps": {
            "write": {"latest": final_path},
            "publish": {"latest": publish_path},
            "performance": {"latest": performance_path}
        },
        "phase_artifacts": {
            "visual_assets": {"path": visual_manifest_path}
        }
    }, ensure_ascii=False))
    write_file(project, "pipeline/final/unpublished.md", "should not become a history record")
    write_file(project, "pipeline/publish/unpublished-publish.md", "\n".join([
        "---",
        "slug: unpublished",
        "---",
        "- Final content path: pipeline/final/unpublished.md",
        "- Published URL: https://example.com/unpublished",
    ]))
    return fixture


def history_files(project: Path) -> list[Path]:
    root = project / "materials/publication/history"
    return sorted(path for path in root.rglob("*") if path.is_file()) if root.exists() else []


def test_dry_run_lists_only_allowlisted_records_and_writes_nothing(tmp_path: Path) -> None:
    module = load_module()
    write_fixture(tmp_path)

    result = module.migrate_project(tmp_path, apply=False)

    assert history_files(tmp_path) == []
    planned = [entry for entry in result["entries"] if entry["import_status"] == "planned"]
    assert {entry["record_type"] for entry in planned} >= {
        "final_content", "adopted_visual_asset", "publication_links", "performance_metrics", "history_record"
    }
    assert all({"source", "destination", "sha256", "record_type", "import_status"} <= set(entry) for entry in planned)
    skipped = [entry["source"] for entry in result["entries"] if entry["import_status"] == "skipped_excluded"]
    assert "pipeline/drafts/legacy-draft.md" in skipped
    assert "pipeline/angles/legacy-angle.md" in skipped
    assert "pipeline/breakdown/legacy-breakdown.md" in skipped
    assert "sessions/session-state.json" in skipped
    assert any(entry["import_status"] == "skipped_unverified" for entry in result["entries"])
    assert not any("unpublished" in str(entry.get("destination") or "") for entry in planned)


def test_apply_creates_self_contained_history_without_legacy_internal_references(tmp_path: Path) -> None:
    module = load_module()
    fixture = write_fixture(tmp_path)

    result = module.migrate_project(tmp_path, apply=True)

    manifest_path = tmp_path / "materials/publication/migrations/final-publication-history-manifest.json"
    assert manifest_path.is_file()
    saved_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert saved_manifest["schema"] == module.SCHEMA
    assert any(entry["import_status"] == "imported" for entry in saved_manifest["entries"])

    record_path = tmp_path / "materials/publication/history/legacy-legacy-run/record.json"
    record = json.loads(record_path.read_text(encoding="utf-8"))
    assert record["schema"] == module.HISTORY_SCHEMA
    assert record["legacy_run_id"] == fixture["run_id"]
    assert record["slug"] == fixture["slug"]
    assert record["content"]
    assert record["visual_assets"]
    assert record["performance_paths"]

    links_path = tmp_path / record["publication_links_path"]
    links = json.loads(links_path.read_text(encoding="utf-8"))
    assert links["records"] == [{"platform": "wechat", "published_at": "2026-07-01T09:00:00Z", "url": fixture["publication_url"]}]

    final_copy = tmp_path / record["content"][0]["path"]
    assert final_copy.read_text(encoding="utf-8") == fixture["final_content"]
    visual_copy = tmp_path / record["visual_assets"][0]["path"]
    assert visual_copy.read_bytes() == str(fixture["visual_asset"]).encode("utf-8")

    performance_payloads = [json.loads((tmp_path / value).read_text(encoding="utf-8")) for value in record["performance_paths"]]
    assert any(payload["metrics"].get("reads") == 128 for payload in performance_payloads)
    assert all("comments" not in payload and "raw_token" not in payload for payload in performance_payloads)

    record_text = record_path.read_text(encoding="utf-8")
    for forbidden in ("pipeline/drafts", "pipeline/angles", "pipeline/breakdown", "pipeline/audit", "sessions/", "materials/performance/raw"):
        assert forbidden not in record_text
    assert not (tmp_path / "materials/publication/history/legacy-unpublished").exists()

    second = module.migrate_project(tmp_path, apply=True)
    statuses = {entry["import_status"] for entry in second["entries"] if entry["record_type"] != "excluded_legacy_artifact"}
    assert statuses <= {"already_imported", "skipped_unverified"}
    assert "already_imported" in statuses


def test_legacy_selected_revision_is_a_visual_adoption_fallback(tmp_path: Path) -> None:
    module = load_module()
    write_fixture(tmp_path)
    selected = tmp_path / "pipeline/visual/legacy-topic/selected-assets.json"
    selected.unlink()
    asset_path = "pipeline/visual/legacy-topic/publish/r001/wechat/cover.png"
    asset_bytes = (tmp_path / asset_path).read_bytes()
    write_file(tmp_path, "pipeline/visual/legacy-topic/selected-revision.json", json.dumps({
        "schema": "aifios.visual-selection.v1",
        "slug": "legacy-topic",
        "revision_id": "r001",
        "integrity": {
            "files": [{
                "role": "output",
                "id": "wechat-cover",
                "path": asset_path,
                "sha256": hashlib.sha256(asset_bytes).hexdigest()
            }]
        }
    }))

    module.migrate_project(tmp_path, apply=True)

    record = json.loads((tmp_path / "materials/publication/history/legacy-legacy-run/record.json").read_text(encoding="utf-8"))
    assert record["visual_assets"]
    assert record["visual_assets"][0]["role"] == "legacy_selected_revision"

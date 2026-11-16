#!/usr/bin/env python3
"""Fast regression checks for the active AIFIOS runtime.

The suite deliberately exercises the supported WeChat and Xiaohongshu flow only.
Feature-specific visual and collection behavior lives in its focused test modules.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
FIXTURES = Path(__file__).parent / "fixtures"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

from content_pipeline import (
    DEFAULT_SCHEDULED_STEPS,
    DRAFT_INFORMATION_APPROVAL,
    DRAFT_PREPARATION_STEPS,
    PipelineDirector,
    WEEKLY_LEARNING_STEPS,
)
import content_pipeline as content_pipeline_module
import content_runtime as content_runtime_module
from content_runtime import ContentRuntime, STEPS
from demo_data import DEMO_SAMPLES
from delivery_audit import run_delivery_audit
from package_quality import audit_package
from platform_adapt_quality import audit_platform_adapt
from publish_quality import audit_publish
from quality_check import run_quality_check
import session_manager as session_manager_module
import market_signal as market_signal_module
import intake_quality as intake_quality_module
from session_manager import SessionManager, detect_target_platforms
from visual_publish import load_provider_registry, validate_visual_provider_registry
from visual_test_fixtures import VALID_PACKAGE_BODY


def fixture_body(name: str) -> str:
    text = (FIXTURES / name).read_text(encoding="utf-8")
    if text.startswith("---\n"):
        return text.split("---\n", 2)[2].lstrip("\n")
    return text


def copy_fixture(project: Path, name: str) -> Path:
    target = project / name
    shutil.copyfile(FIXTURES / name, target)
    return target


def tikomni_live_fetcher(platform: str, query: str) -> dict:
    return {
        "status": "available",
        "platform": platform,
        "endpoint_id": f"{platform}.fixture.search",
        "query_applied": True,
        "raw_payload": {"data": {"items": [{
            "title": f"{platform} {query}",
            "desc": "公开可验证样本。",
            "url": f"https://example.test/{platform}/{query}",
            "like_count": 20,
        }]}},
    }


def persist_topic_snapshot(runtime: ContentRuntime, run_id: str, source_path: str, topic: str = "企业出海内容") -> dict:
    platforms = [p for p in runtime.run_state(run_id=run_id)["target_platforms"] if p in ("wechat", "xhs", "shipinhao")]
    result = market_signal_module.fetch_market_signals(
        "企业出海和自媒体需要低成本样板。",
        platforms,
        runtime.project,
        live_fetcher=tikomni_live_fetcher,
    )
    assert result["status"] == "ready"
    snapshot = market_signal_module.persist_market_snapshot(
        project=runtime.project,
        run_id=run_id,
        topic=topic,
        source_path=source_path,
        result=result,
    )

    return {**snapshot, "test_platforms": platforms}


def test_create_run_allocates_unique_ids_and_slugs_for_duplicate_topics(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()

    first = runtime.create_run(topic="同一个主题", slug="same-topic")
    second = runtime.create_run(topic="同一个主题", slug="same-topic")
    third = runtime.create_run(topic="同一个主题", slug="same-topic", run_id="custom-run")

    assert first["run_id"] == "same-topic"
    assert first["slug"] == "same-topic"
    assert second["run_id"] == "same-topic-02"
    assert second["slug"] == "same-topic-02"
    assert third["run_id"] == "custom-run"
    assert third["slug"] == "same-topic-03"
    assert len({first["run_id"], second["run_id"], third["run_id"]}) == 3
    assert len({first["slug"], second["slug"], third["slug"]}) == 3


def test_explicit_run_writes_are_concurrent_and_never_change_the_active_run(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    active = runtime.create_run(topic="当前任务 A", run_id="run-a", slug="slug-a")
    run_b = runtime.create_run(topic="并发任务 B", run_id="run-b", slug="slug-b")
    run_c = runtime.create_run(topic="并发任务 C", run_id="run-c", slug="slug-c")
    runtime.switch_run(active["run_id"])
    initial_state = runtime.state()

    with ThreadPoolExecutor(max_workers=2) as executor:
        future_b = executor.submit(
            runtime.write, "intake", run_b["slug"], "B 的独立素材。", "concurrency-test", run_b["run_id"]
        )
        future_c = executor.submit(
            runtime.write, "intake", run_c["slug"], "C 的独立素材。", "concurrency-test", run_c["run_id"]
        )
        written_b = future_b.result(timeout=5)
        written_c = future_c.result(timeout=5)

    final_state = runtime.state()
    assert final_state["active_run_id"] == active["run_id"]
    assert final_state["current_slug"] == initial_state["current_slug"]
    assert final_state["current_step"] == initial_state["current_step"]
    assert final_state["latest_files"] == initial_state["latest_files"]
    assert runtime.run_state(run_id=run_b["run_id"])["steps"]["intake"]["latest"] == Path(written_b["path"]).relative_to(tmp_path).as_posix()
    assert runtime.run_state(run_id=run_c["run_id"])["steps"]["intake"]["latest"] == Path(written_c["path"]).relative_to(tmp_path).as_posix()
    assert runtime.read("intake", latest=True, slug=run_b["slug"])["path"] == written_b["path"]
    assert runtime.read("intake", latest=True, slug=run_c["slug"])["path"] == written_c["path"]
    assert "B 的独立素材" in Path(written_b["path"]).read_text(encoding="utf-8")
    assert "C 的独立素材" in Path(written_c["path"]).read_text(encoding="utf-8")


def test_explicit_run_write_rejects_a_mismatched_slug_before_creating_an_artifact(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    target = runtime.create_run(topic="目标任务", run_id="target-run", slug="target-slug")

    with pytest.raises(ValueError, match="slug 必须与目标"):
        runtime.write("intake", "wrong-slug", "不应留下文件。", "test", target["run_id"])

    assert list((tmp_path / "pipeline" / "intake").glob("*.md")) == []
    assert runtime.run_state(run_id=target["run_id"])["steps"] == {}


def test_explicit_run_write_does_not_overwrite_a_user_switch_during_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    active = runtime.create_run(topic="当前任务 A", run_id="run-a", slug="slug-a")
    run_b = runtime.create_run(topic="写入任务 B", run_id="run-b", slug="slug-b")
    run_d = runtime.create_run(topic="用户切换任务 D", run_id="run-d", slug="slug-d")
    runtime.switch_run(active["run_id"])

    entered_commit = threading.Event()
    release_commit = threading.Event()
    original_update_run = runtime._update_run

    def delayed_update_run(*args, **kwargs):
        entered_commit.set()
        if not release_commit.wait(timeout=5):
            raise TimeoutError("test did not release the explicit run commit")
        return original_update_run(*args, **kwargs)

    monkeypatch.setattr(runtime, "_update_run", delayed_update_run)
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(
            runtime.write, "intake", run_b["slug"], "B 的独立素材。", "concurrency-test", run_b["run_id"]
        )
        assert entered_commit.wait(timeout=5)
        runtime.switch_run(run_d["run_id"])
        release_commit.set()
        written = pending.result(timeout=5)

    assert written["run_id"] == run_b["run_id"]
    assert runtime.run_state(run_id=run_b["run_id"])["steps"]["intake"]["latest"]
    assert runtime.state()["active_run_id"] == run_d["run_id"]


def test_topic_selection_updates_the_existing_run_without_renaming_it(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="素材分析任务", run_id="topic-selection-run", slug="neutral-material-run")
    intake = runtime.write("intake", created["slug"], fixture_body("intake_valid.md"), source="test", run_id=created["run_id"])
    snapshot = persist_topic_snapshot(runtime, created["run_id"], intake["path"])

    selected = runtime.set_topic(
        created["run_id"],
        "把一次客户复盘写成可执行判断",
        snapshot["manifest_path"],
        snapshot["snapshot_sha256"],
        "topic-2",
    )

    assert selected["run_id"] == created["run_id"]
    assert selected["slug"] == "neutral-material-run"
    assert selected["topic"] == "把一次客户复盘写成可执行判断"
    run = runtime.run_state(run_id=created["run_id"])
    assert run["slug"] == "neutral-material-run"
    assert run["topic"] == "把一次客户复盘写成可执行判断"
    assert run["topic_selection"]["market_snapshot_path"] == snapshot["manifest_path"]
    assert run["topic_selection"]["suggestion_id"] == "topic-2"

    with pytest.raises(ValueError, match="SHA-256"):
        runtime.set_topic(
            created["run_id"],
            "不应写入",
            snapshot["manifest_path"],
            "b" * 64,
        )


def test_replacing_intake_invalidates_topic_state_and_rejects_the_old_snapshot(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="旧素材主题", run_id="intake-replacement-run")
    first_intake = runtime.write("intake", created["slug"], "第一版素材。", source="test", run_id=created["run_id"])
    old_snapshot = persist_topic_snapshot(runtime, created["run_id"], first_intake["path"])
    runtime.set_topic(
        created["run_id"],
        "基于第一版素材的主题",
        old_snapshot["manifest_path"],
        old_snapshot["snapshot_sha256"],
    )
    old_blueprint = runtime.write(
        "blueprint",
        created["slug"],
        blueprint_with_snapshot("# 第一版蓝图", old_snapshot),
        source="test",
        run_id=created["run_id"],
    )
    runtime.approve_artifact("topic_template", old_blueprint["path"], run_id=created["run_id"])

    replacement = runtime.write(
        "intake",
        created["slug"],
        "第二版素材，结论已经降级。",
        source="test",
        run_id=created["run_id"],
    )
    run = runtime.run_state(run_id=created["run_id"])

    assert run["topic"] == ""
    assert "topic_selection" not in run
    assert set(run["steps"]) == {"intake"}
    assert run["steps"]["intake"]["latest"] == Path(replacement["path"]).relative_to(tmp_path).as_posix()
    assert run["approvals"]["topic_template"]["invalidation_reason"] == "intake_changed"
    assert not (tmp_path / "runs" / created["run_id"] / "market-research" / "frozen-snapshot.json").exists()
    assert market_signal_module.verify_market_snapshot(tmp_path, created["run_id"], old_snapshot["manifest_path"])["verified"] is True

    with pytest.raises(ValueError, match="最新 intake"):
        runtime.set_topic(
            created["run_id"],
            "不能复用旧快照",
            old_snapshot["manifest_path"],
            old_snapshot["snapshot_sha256"],
        )

    stale_blueprint = runtime.write(
        "blueprint",
        created["slug"],
        blueprint_with_snapshot("# 不应通过的旧快照蓝图", old_snapshot),
        source="test",
        run_id=created["run_id"],
    )
    with pytest.raises(ValueError, match="最新 intake"):
        runtime.approve_artifact("topic_template", stale_blueprint["path"], run_id=created["run_id"])

    fresh_snapshot = persist_topic_snapshot(runtime, created["run_id"], replacement["path"])
    selected = runtime.set_topic(
        created["run_id"],
        "基于第二版素材的主题",
        fresh_snapshot["manifest_path"],
        fresh_snapshot["snapshot_sha256"],
    )
    assert selected["market_snapshot_path"] == fresh_snapshot["manifest_path"]
    fresh_blueprint = runtime.write(
        "blueprint",
        created["slug"],
        blueprint_with_snapshot("# 第二版蓝图", fresh_snapshot),
        source="test",
        run_id=created["run_id"],
    )
    assert runtime.approve_artifact("topic_template", fresh_blueprint["path"], run_id=created["run_id"])["approved"] is True


def blueprint_with_snapshot(body: str, snapshot: dict) -> str:
    labels = {"wechat": "公众号", "xhs": "小红书", "shipinhao": "视频号"}
    # Fixtures now include the selected native sections required for approval.
    native = "\n".join(f"## {labels[p]}独立蓝图\n测试方案。\n" for p in snapshot.get("test_platforms", labels))
    return (
        f"{body.rstrip()}\n\n{native}\n"
        f"- 研究快照：{snapshot['manifest_path']}\n"
        f"- 快照 SHA-256：{snapshot['snapshot_sha256']}\n"
    )


def approve_frozen_topic_template(runtime: ContentRuntime, run_id: str, slug: str) -> dict:
    """Create the minimal H2 evidence required before a downstream write."""
    intake = runtime.write(
        "intake",
        slug,
        "企业出海和自媒体需要低成本样板。",
        source="test",
        run_id=run_id,
    )
    snapshot = persist_topic_snapshot(runtime, run_id, intake["path"])
    blueprint = runtime.write(
        "blueprint",
        slug,
        blueprint_with_snapshot("# 已确认选题与模板", snapshot),
        source="test",
        run_id=run_id,
    )
    runtime.approve_artifact("topic_template", blueprint["path"], run_id=run_id)
    return {"intake": intake, "snapshot": snapshot, "blueprint": blueprint}


def test_revision_write_rejects_stale_bytes_and_preserves_prior_approved_version(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="定向改稿", run_id="revision-a", slug="revision-topic")
    approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    first = runtime.write("package", run["slug"], VALID_PACKAGE_BODY, "test", run["run_id"])
    path = Path(first["path"])
    relative = path.relative_to(tmp_path).as_posix()
    original = path.read_bytes()
    runtime.approve_artifact("content_package", first["path"], run_id=run["run_id"], reviewed_plan_sha256=runtime.content_plan_status(run["run_id"])["blueprint_sha256"])
    with pytest.raises(ValueError, match="原稿内容已经变化"):
        runtime.write("package", run["slug"], "不能写入", "test", run["run_id"],
                      expected_path=relative, expected_sha256="0" * 64)
    assert len(list((tmp_path / "pipeline/package").glob("*.md"))) == 1

    replacement = runtime.write("package", run["slug"], VALID_PACKAGE_BODY + "\n改好的结尾。", "content-revision:test", run["run_id"],
                                expected_path=relative, expected_sha256=hashlib.sha256(original).hexdigest())
    assert path.read_bytes() == original
    assert replacement["path"] != first["path"]
    current = runtime.run_state(run_id=run["run_id"])
    assert current["approvals"]["content_package"]["invalidation_reason"] == "content_changed"
    assert not current["approvals"]["topic_template"].get("invalidated_at")
    with pytest.raises(ValueError, match="原稿已经变化"):
        runtime.write("package", run["slug"], "旧版本不能再次覆盖", "test", run["run_id"],
                      expected_path=relative, expected_sha256=hashlib.sha256(original).hexdigest())
    assert len(list((tmp_path / "pipeline/package").glob("*.md"))) == 2


def test_recovered_first_draft_does_not_replace_a_concurrent_first_draft(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="补齐首稿", run_id="recovery-first", slug="recovery-first")
    approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    first = runtime.write("package", run["slug"], VALID_PACKAGE_BODY, "recovery:test", run["run_id"],
                          expected_path="", expected_sha256="")
    assert Path(first["path"]).exists()
    with pytest.raises(ValueError, match="原稿已经变化"):
        runtime.write("package", run["slug"], VALID_PACKAGE_BODY, "recovery:stale", run["run_id"],
                      expected_path="", expected_sha256="")
    assert len(list((tmp_path / "pipeline/package").glob("*.md"))) == 1
    for path, checksum in [("", None), (None, ""), ("", "a" * 64)]:
        with pytest.raises(ValueError, match="必须同时提供"):
            runtime.write("package", run["slug"], VALID_PACKAGE_BODY, "recovery:invalid", run["run_id"],
                          expected_path=path, expected_sha256=checksum)


def test_plan_bound_local_revision_preserves_origin_and_requires_whole_draft_review(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="按新方案局部改稿", run_id="revision-plan", slug="revision-plan")
    setup = approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    old_plan_file = Path(setup["blueprint"]["path"])
    old_plan_raw = old_plan_file.read_text()
    old_binding = {"path": old_plan_file.relative_to(tmp_path).as_posix(), "sha256": hashlib.sha256(old_plan_file.read_bytes()).hexdigest()}
    original_body = f"<!-- echo-content-plan:{json.dumps(old_binding)} -->\n\n" + VALID_PACKAGE_BODY
    original = runtime.write("package", run["slug"], original_body, "test", run["run_id"])
    source_file = Path(original["path"])
    source_raw = source_file.read_bytes()
    new_plan = runtime.write("blueprint", run["slug"], runtime.read("blueprint", file=old_plan_file)["body"] + "\n新结尾要求。", "test", run["run_id"])
    runtime.approve_artifact("topic_template", new_plan["path"], run_id=run["run_id"])
    plan_file = Path(new_plan["path"])
    plan_path = plan_file.relative_to(tmp_path).as_posix()
    plan_sha = hashlib.sha256(plan_file.read_bytes()).hexdigest()
    expectations = {"expected_path": source_file.relative_to(tmp_path).as_posix(), "expected_sha256": hashlib.sha256(source_raw).hexdigest(),
                    "expected_blueprint_path": plan_path, "expected_blueprint_sha256": plan_sha}

    for overrides in ({"expected_blueprint_sha256": "0" * 64}, {"expected_blueprint_path": old_binding["path"]}):
        with pytest.raises(ValueError, match="写作方案.*更新"):
            runtime.write("package", run["slug"], original_body + "\n修改结尾。", "content-revision:test", run["run_id"], **{**expectations, **overrides})
    assert source_file.read_bytes() == source_raw
    assert len(list((tmp_path / "pipeline/package").glob("*.md"))) == 1

    changed = runtime.write("package", run["slug"], original_body + "\n修改结尾。", "content-revision:test", run["run_id"], **expectations)
    assert runtime.content_plan_status(run["run_id"])["status"] == "outdated"
    assert old_plan_file.read_text() == old_plan_raw
    assert json.dumps(old_binding) in Path(changed["path"]).read_text()
    with pytest.raises(ValueError, match="明确核对"):
        runtime.approve_artifact("content_package", changed["path"], run_id=run["run_id"])
    runtime.approve_artifact("content_package", changed["path"], run_id=run["run_id"], reviewed_plan_sha256=plan_sha)
    assert runtime.content_plan_status(run["run_id"])["status"] == "retained"


def test_revision_plan_change_while_waiting_for_write_lock_rejects_without_mutating_body(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="方案保存竞态", run_id="revision-plan-race", slug="revision-plan-race")
    setup = approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    plan_file = Path(setup["blueprint"]["path"])
    plan_body = runtime.read("blueprint", file=plan_file)["body"]
    original = runtime.write("package", run["slug"], VALID_PACKAGE_BODY, "test", run["run_id"])
    source_file = Path(original["path"])
    source_raw = source_file.read_bytes()
    expectations = {"expected_path": source_file.relative_to(tmp_path).as_posix(), "expected_sha256": hashlib.sha256(source_raw).hexdigest(),
                    "expected_blueprint_path": plan_file.relative_to(tmp_path).as_posix(), "expected_blueprint_sha256": hashlib.sha256(plan_file.read_bytes()).hexdigest()}
    plan_entered = threading.Event()
    revision_started = threading.Event()
    release_plan = threading.Event()
    original_write = runtime._write

    def controlled(*args, **kwargs):
        if args[0] == "blueprint":
            plan_entered.set()
            assert release_plan.wait(timeout=5)
        return original_write(*args, **kwargs)

    monkeypatch.setattr(runtime, "_write", controlled)

    def save_revision():
        revision_started.set()
        return runtime.write("package", run["slug"], VALID_PACKAGE_BODY + "\n选段修改。", "test", run["run_id"], **expectations)

    with ThreadPoolExecutor(max_workers=2) as executor:
        plan_future = executor.submit(runtime.write, "blueprint", run["slug"], plan_body + "\n另一份方案。", "test", run["run_id"])
        assert plan_entered.wait(timeout=5)
        revision_future = executor.submit(save_revision)
        assert revision_started.wait(timeout=5)
        assert not revision_future.done()
        release_plan.set()
        plan_future.result(timeout=5)
        with pytest.raises(ValueError, match="写作方案已经更新"):
            revision_future.result(timeout=5)
    assert source_file.read_bytes() == source_raw
    assert runtime.run_state(run_id=run["run_id"])["steps"]["package"]["latest"] == expectations["expected_path"]
    assert len(list((tmp_path / "pipeline/package").glob("*.md"))) == 1


@pytest.mark.parametrize("extra", [
    {"expected_blueprint_path": "pipeline/blueprint/plan.md"},
    {"expected_blueprint_sha256": "a" * 64},
    {"expected_blueprint_path": "../outside.md", "expected_blueprint_sha256": "a" * 64},
])
def test_revision_write_rejects_incomplete_or_invalid_plan_expectations(tmp_path: Path, extra: dict) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    with pytest.raises(ValueError, match="同时绑定正文与写作方案"):
        runtime.write("package", "invalid-plan", "must not save", run_id="invalid-plan", expected_path="", expected_sha256="", **extra)
    assert not list((tmp_path / "pipeline/package").glob("*.md"))


def test_two_revision_writers_on_the_same_base_can_commit_only_once(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="并发改稿", run_id="revision-race", slug="revision-race-topic")
    approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    first = runtime.write("package", run["slug"], VALID_PACKAGE_BODY, "test", run["run_id"])
    path = Path(first["path"])
    relative = path.relative_to(tmp_path).as_posix()
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    barrier = threading.Barrier(2)

    def compete(ending: str) -> str:
        barrier.wait(timeout=5)
        try:
            runtime.write("package", run["slug"], VALID_PACKAGE_BODY + ending, "test", run["run_id"],
                          expected_path=relative, expected_sha256=checksum)
            return "saved"
        except ValueError as error:
            assert "原稿已经变化" in str(error)
            return "stale"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(compete, ["\n第一个结尾。", "\n第二个结尾。"]))
    assert sorted(results) == ["saved", "stale"]
    assert len(list((tmp_path / "pipeline/package").glob("*.md"))) == 2


def test_explicit_and_legacy_writes_share_the_same_revision_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="旧调用兼容", run_id="different-id", slug="shared-slug")
    first_entered = threading.Event()
    second_entered = threading.Event()
    second_started = threading.Event()
    release = threading.Event()
    original_write = runtime._write

    def controlled(*args, **kwargs):
        if args[3] == "first":
            first_entered.set()
            assert release.wait(timeout=5)
        else:
            second_entered.set()
        return original_write(*args, **kwargs)

    def legacy():
        second_started.set()
        return runtime.write("intake", run["slug"], "第二份素材", "second")

    monkeypatch.setattr(runtime, "_write", controlled)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(runtime.write, "intake", run["slug"], "第一份素材", "first", run["run_id"])
        assert first_entered.wait(timeout=5)
        second = executor.submit(legacy)
        assert second_started.wait(timeout=5)
        try:
            assert not second_entered.wait(timeout=0.1)
        finally:
            release.set()
        first.result(timeout=5)
        second.result(timeout=5)
    assert second_entered.is_set()


def write_verified_visual_manifest(runtime: ContentRuntime, run_id: str) -> Path:
    """Create the smallest recipe/index/asset set accepted by visual approval."""
    run = runtime.run_state(run_id=run_id)
    slug = run["slug"]
    package_path = run["steps"]["package"]["latest"]
    package_bytes = (runtime.project / package_path).read_bytes()
    revision_id = "r001"
    asset_id = "wechat-cover"
    asset_path = f"pipeline/visual/{slug}/publish/{revision_id}/wechat/cover.png"
    output = runtime.project / asset_path
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"verified visual cover")
    asset_hash = hashlib.sha256(output.read_bytes()).hexdigest()
    recipe_path = runtime.project / "pipeline" / "visual" / slug / "recipes" / f"{revision_id}.visual-recipe.json"
    recipe_path.parent.mkdir(parents=True, exist_ok=True)
    recipe_path.write_text(json.dumps({
        "schema": "aifios.visual-recipe.v1",
        "slug": slug,
        "revision_id": revision_id,
        "source_package": package_path,
        "assets": [{"id": asset_id}],
    }), encoding="utf-8")
    index_path = runtime.project / "pipeline" / "visual" / slug / "revisions" / f"{revision_id}.index.json"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps({
        "schema": "aifios.visual-publish.v1",
        "slug": slug,
        "revision_id": revision_id,
        "outputs": [{
            "id": asset_id,
            "output": asset_path,
            "sha256": asset_hash,
            "revision_id": revision_id,
            "status": "generated",
        }],
    }), encoding="utf-8")
    manifest_path = runtime.project / "pipeline" / "visual" / slug / "selected-assets.json"
    manifest_path.write_text(json.dumps({
        "schema": "aifios.visual-asset-manifest.v1",
        "slug": slug,
        "sourceContentHash": hashlib.sha256(package_bytes).hexdigest(),
        "requiredRoles": ["wechat_cover"],
        "selections": {
            "wechat_cover": {
                "assetId": asset_id,
                "semanticRole": "wechat_cover",
                "revisionId": revision_id,
                "path": asset_path,
                "sha256": asset_hash,
                "platformBindings": ["wechat"],
            },
        },
    }), encoding="utf-8")
    return manifest_path


def complete_draft_queue(
    runtime: ContentRuntime,
    run_id: str,
    slug: str,
    package_path: str,
    visual_manifest_path: str | Path,
) -> dict:
    """Small but complete queue fixture for runtime approval contracts."""
    package_target = runtime._project_path(package_path, must_exist=True)
    package_relative = package_target.relative_to(runtime.project).as_posix()
    visual_target = Path(visual_manifest_path)
    if not visual_target.is_absolute():
        visual_target = runtime.project / visual_target
    visual_relative = visual_target.relative_to(runtime.project).as_posix()
    jobs = []
    contract = [
        ("wechat", "wechat-article", "draft_fill"),
        ("xiaohongshu", "xiaohongshu-opinion-1", "draft_fill"),
        ("xiaohongshu", "xiaohongshu-opinion-2", "draft_fill"),
        ("xiaohongshu", "xiaohongshu-opinion-3", "draft_fill"),
        ("moments", "moments-opinion-1", "draft_fill"),
        ("moments", "moments-opinion-2", "draft_fill"),
        ("moments", "moments-opinion-3", "draft_fill"),
        ("shipinhao", "shipinhao-video-execution-1", "execution_package"),
        ("shipinhao", "shipinhao-video-execution-2", "execution_package"),
        ("douyin", "douyin-video-execution-1", "execution_package"),
        ("douyin", "douyin-video-execution-2", "execution_package"),
    ]
    for index, (platform, item_id, delivery_kind) in enumerate(contract):
        adapter = "wechat_official_api" if platform == "wechat" else (
            "authorized_browser" if platform == "xiaohongshu" else (
                "mobile_bridge" if platform == "moments" else "download"
            )
        )
        jobs.append({
            "job_id": f"draft_{index:020x}",
            "platform": platform,
            "item_id": item_id,
            "item_label": item_id,
            "delivery_kind": delivery_kind,
            "payload": {"title": f"初版标题 {index}", "asset_paths": []},
            "payload_hash": "b" * 64,
            "content_hash": "c" * 64,
            "selected_asset_hashes": [],
            "status": "pending",
            "adapter": adapter,
            "attempt_count": 0,
            "retry_count": 0,
            "events": [],
        })
    return {
        "schema": "aifios.publication-draft-queue.v1",
        "queue_id": "queue-demo",
        "run_id": run_id,
        "run_slug": slug,
        "package_path": package_relative,
        "package_sha256": hashlib.sha256(package_target.read_bytes()).hexdigest(),
        "visual_manifest_path": visual_relative,
        "visual_manifest_sha256": hashlib.sha256(visual_target.read_bytes()).hexdigest(),
        "created_at": "2026-07-15T00:00:00",
        "updated_at": "2026-07-15T00:00:00",
        "jobs": jobs,
    }


def test_init_creates_active_runtime_directories(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    result = runtime.init()

    expected = [
        "pipeline/intake",
        "pipeline/validate",
        "pipeline/blueprint",
        "pipeline/angles",
        "pipeline/breakdown",
        "pipeline/dbs-fusion",
        "pipeline/final",
        "pipeline/package",
        "pipeline/xhs",
        "pipeline/douyin",
        "pipeline/platform-adapt/wechat",
        "pipeline/platform-adapt/xhs",
        "pipeline/platform-adapt/shipinhao",
        "pipeline/platform-adapt/douyin",
        "pipeline/platform-adapt/moments",
        "pipeline/visual",
        "pipeline/prelaunch",
        "pipeline/compliance",
        "pipeline/audit",
        "pipeline/publish",
        "pipeline/performance",
        "pipeline/review",
        "pipeline/archive",
        "pipeline/twin",
        "materials/hit-library/wechat",
        "materials/hit-library/xhs",
        "materials/hit-library/shipinhao",
        "materials/hit-library/douyin",
        "materials/hit-library/moments",
        "materials/research",
        "materials/publish-proof",
        "materials/performance/wechat-official-account",
        "materials/performance/wechat-channels",
        "materials/performance/xhs",
        "materials/performance/douyin",
        "materials/performance/moments",
        "brain/material-index.json",
        "sessions/latest.json",
    ]

    assert result["status"] == "initialized"
    assert all((tmp_path / path).exists() for path in expected)
    assert STEPS == [
        "intake", "validate", "blueprint", "angle", "breakdown", "dbs-fusion",
        "write", "package", "xhs", "douyin", "platform-adapt", "visual", "prelaunch",
        "compliance", "audit", "publish", "performance", "review", "archive", "twin",
    ]


def test_write_read_validate_and_material_index(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()

    written = runtime.write("intake", "customer-problem", fixture_body("intake_valid.md"), source="test")
    validation = runtime.validate("intake", written["path"])
    loaded = runtime.read("intake", latest=True, slug="customer-problem")
    summary = runtime.read("intake", latest=True, slug="customer-problem", summary=True)
    index = json.loads((tmp_path / "brain" / "material-index.json").read_text(encoding="utf-8"))

    assert validation["valid"] is True, validation
    assert validation["quality_status"] in {"pass", "review_required"}, validation
    assert loaded["frontmatter"]["slug"] == "customer-problem"
    assert "素材场景" in loaded["body"]
    assert summary["body_omitted"] is True
    assert index["items"]["customer-problem"]["latest_intake"] == Path(written["path"]).resolve().relative_to(tmp_path.resolve()).as_posix()


def test_validation_rejects_invalid_fixture(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()

    valid = runtime.validate("intake", str(copy_fixture(tmp_path, "intake_valid.md")))
    invalid = runtime.validate("intake", str(copy_fixture(tmp_path, "intake_invalid.md")))
    validate_report = runtime.validate("validate", str(copy_fixture(tmp_path, "validate_valid.md")))

    assert valid["valid"] is True, valid
    assert invalid["valid"] is False, invalid
    assert invalid["missing_patterns"] or invalid["quality_errors"]
    assert validate_report["valid"] is True, validate_report


def test_write_and_package_quality_findings_do_not_block_usable_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = ContentRuntime(tmp_path)
    initialized = runtime.init(demo=True)
    write_path = next(path for path in initialized["demo_files"] if "/pipeline/final/" in path)
    package_path = next(path for path in initialized["demo_files"] if "/pipeline/package/" in path)
    blocked_audit = {
        "status": "blocked",
        "blocking_issues": ["编辑质量需要完善。"],
        "review_issues": ["发布前可以复核。"],
        "checks": {},
    }
    monkeypatch.setattr(content_runtime_module, "audit_write", lambda _: blocked_audit)
    monkeypatch.setattr(content_runtime_module, "audit_package", lambda _: blocked_audit)

    write_validation = runtime.validate("write", write_path)
    package_validation = runtime.validate("package", package_path)

    assert write_validation["valid"] is True, write_validation
    assert package_validation["valid"] is True, package_validation
    assert write_validation["quality_status"] == "review_required"
    assert package_validation["quality_status"] == "review_required"
    assert write_validation["quality_errors"] == []
    assert package_validation["quality_errors"] == []
    assert "编辑质量需要完善。" in write_validation["quality_reviews"]
    assert "编辑质量需要完善。" in package_validation["quality_reviews"]


def test_write_format_contract_gaps_are_advisory_for_an_existing_article(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    initialized = runtime.init(demo=True)
    write_path = Path(next(path for path in initialized["demo_files"] if "/pipeline/final/" in path))
    body = write_path.read_text(encoding="utf-8")
    body = body.split("<!-- AIFIOS-WRITE-CHECK", 1)[0].rstrip() + "\n"
    write_path.write_text(body, encoding="utf-8")

    validation = runtime.validate("write", write_path)

    assert validation["valid"] is True, validation
    assert validation["missing_patterns"] == []
    assert any("格式字段缺失但已直接生效" in item for item in validation["quality_reviews"])


def test_douyin_script_step_writes_reads_and_validates(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    body = (
        "# 获客口播：别把第一条视频拍成自我介绍\n\n"
        "## 0. 上游约束\n- 核心判断：客户先判断你是否理解问题。\n\n"
        "## 1. 发布与定位\n- 发布标题：客户不是先看你是谁\n- 封面字：先讲客户卡点\n- 3 秒钩子：第一条视频别急着介绍自己。\n\n"
        "## 2. 30-45 秒候选脚本\n### 候选 1\n客户先看你有没有说中他的卡点。\n\n"
        "## 3. 推荐口播稿\n先说客户卡在哪里，再说你如何帮助他。\n\n"
        "## 4. 拍摄与字幕\n- 镜头：正面口播开场。\n- 字幕重点：客户卡点。\n\n"
        "## 5. 评论承接与风险边界\n- 评论承接：你现在最难讲清哪一个客户问题？\n- 风险边界：不承诺咨询结果。\n"
    )

    assert (tmp_path / "pipeline" / "douyin").is_dir()
    written = runtime.write("douyin", "lead-gen", body, source="test")
    read_back = runtime.read("douyin", latest=True, slug="lead-gen")
    validation = runtime.validate("douyin", written["path"])
    incomplete = runtime.write("douyin", "lead-gen", "# 不完整口播", source="test")
    invalid = runtime.validate("douyin", incomplete["path"])

    assert Path(written["path"]).parent.name == "douyin"
    assert "3 秒钩子" in read_back["body"]
    assert validation["valid"] is True, validation
    assert invalid["valid"] is False, invalid
    assert invalid["missing_patterns"]


def test_run_lifecycle_and_pipeline_start(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(
        topic="客户问题优先的内容表达",
        platforms="公众号,小红书",
        run_id="customer-problem-run",
        business_goal="获得内容诊断咨询",
        success_metric="有效咨询数",
        baseline="0",
        target="3",
        project_id="client_alpha",
    )
    runtime.write("intake", created["slug"], fixture_body("intake_valid.md"), source="test")
    state = runtime.run_state(run_id="customer-problem-run")
    # This lifecycle check deliberately exercises unavailable research, even on
    # a developer machine with a working TikOmni account.
    with patch.dict("os.environ", {"AIFIOS_MARKET_SIGNAL_PROVIDER": "off"}):
        next_action = PipelineDirector(tmp_path, slug=created["slug"]).next()
    archived = runtime.archive_run("customer-problem-run")
    resumed = runtime.resume_run("customer-problem-run")

    assert state["schema"] == "echo-founder.production-run.v2"
    assert state["target_platforms"] == ["wechat", "xhs"]
    assert state["selected_platforms"] == ["wechat", "xhs"]
    assert set(state["platform_lanes"]) == {"wechat", "xhs"}
    assert state["platform_lanes"]["wechat"]["visual"]["required"] is True
    assert state["shared_brief"]["status"] == "pending"
    assert state["project_id"] == "client_alpha"
    assert state["success_criteria"]["target"] == 3
    assert state["steps"]["intake"]["latest"]
    assert next_action["status"] == "blocked"
    assert next_action["recommended_step"] == "market-signal"
    assert next_action["market_signal"]["status"] == "blocked"
    assert archived["status"] == "archived"
    assert archived["project_id"] == "client_alpha"
    assert resumed["status"] == "resumed"


def test_pipeline_director_blocks_when_tikomni_evidence_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="TikOmni 选题阻断", run_id="tikomni-pipeline-gate-run")
    intake = runtime.write("intake", created["slug"], fixture_body("intake_valid.md"), source="test")

    def blocked_report(**kwargs: object) -> dict:
        assert kwargs["run_id"] == created["run_id"]
        assert kwargs["source_path"] == Path(intake["path"]).relative_to(tmp_path).as_posix()
        return {
            "status": "blocked",
            "markdown": f"""# 爆款抓取与对标报告 · TikOmni 选题阻断

## 0. 研究范围
- 上游素材：{intake['path']}
- runtime run：{created['run_id']}
- 实时信号状态：blocked
- 样本数量：0
- TikOmni 门禁：阻断
- 研究快照：未生成
- 快照 SHA-256：未生成
""",
        }

    monkeypatch.setattr(content_pipeline_module, "build_market_signal_report", blocked_report)

    result = PipelineDirector(tmp_path, slug=created["slug"]).next()

    assert result["status"] == "blocked"
    assert result["recommended_step"] == "market-signal"
    assert result["market_signal"]["status"] == "blocked"


def test_default_schedule_stops_at_draft_information_before_weekly_learning(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="默认生产结束点", run_id="draft-stop-run")

    assert created["target_platforms"] == ["wechat", "xhs", "shipinhao"]
    assert DEFAULT_SCHEDULED_STEPS == (
        "intake", "validate", "blueprint", "package",
        "visual", "prelaunch", "compliance", "audit",
    )
    assert DRAFT_PREPARATION_STEPS == ("visual", "prelaunch", "compliance", "audit")
    assert WEEKLY_LEARNING_STEPS == ("performance", "review", "archive", "twin")
    assert not set(DEFAULT_SCHEDULED_STEPS) & {"angle", "breakdown", "xhs", "platform-adapt"}
    assert not set(DEFAULT_SCHEDULED_STEPS) & set(WEEKLY_LEARNING_STEPS)

    runtime.write("intake", created["slug"], DEMO_SAMPLES["intake"], source="test", run_id=created["run_id"])
    runtime.write("validate", created["slug"], DEMO_SAMPLES["validate"], source="test", run_id=created["run_id"])
    run_state = runtime.run_state(run_id=created["run_id"])
    snapshot = persist_topic_snapshot(runtime, created["run_id"], run_state["steps"]["intake"]["latest"])
    blueprint = runtime.write(
        "blueprint",
        created["slug"],
        blueprint_with_snapshot(DEMO_SAMPLES["blueprint"], snapshot),
        source="test",
        run_id=created["run_id"],
    )
    runtime.approve_blueprint(blueprint["path"], run_id=created["run_id"])
    for step in DEFAULT_SCHEDULED_STEPS[3:]:
        runtime.write(step, created["slug"], DEMO_SAMPLES[step], source="test", run_id=created["run_id"])
    director = PipelineDirector(tmp_path, slug=created["slug"])

    # A completed normal schedule must wait for the phase-5 human review rather
    # than trying to fabricate post-publication learning work.
    terminal = director.next()

    assert terminal["status"] == "awaiting_approval"
    assert terminal["required_approval"] == DRAFT_INFORMATION_APPROVAL
    assert terminal["scheduled_steps"] == list(DEFAULT_SCHEDULED_STEPS)
    assert terminal["next_steps"] == []
    assert not set(terminal["scheduled_steps"]) & {"performance", "review", "archive", "twin"}


def test_new_run_supports_one_platform_and_skips_video_visuals(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()

    created = runtime.create_run(topic="只做视频号", platforms="视频号", run_id="video-only-run")
    state = runtime.run_state(run_id=created["run_id"])

    assert created["selected_platforms"] == ["shipinhao"]
    assert state["target_platforms"] == ["shipinhao"]
    assert set(state["platform_lanes"]) == {"shipinhao"}
    assert state["platform_lanes"]["shipinhao"]["visual"] == {
        "required": False,
        "status": "not_required",
        "artifact_path": "",
        "sha256": "",
    }


def test_run_visual_preferences_are_layout_only_and_keep_fixed_policy(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="视觉模式", platforms="公众号,小红书", run_id="visual-preference-run")

    assert created["visual_preferences"] == {
        "mode": "stable",
        "direction_count": 2,
        "provider_policy": "auto",
    }

    changed = runtime.set_visual_preferences(created["run_id"], mode="stable")
    state = runtime.run_state(run_id=created["run_id"])

    assert changed["changed"] is False
    assert state["visual_preferences"] == {
        "mode": "stable",
        "direction_count": 2,
        "provider_policy": "auto",
    }
    with pytest.raises(ValueError, match="固定生成两套"):
        runtime.set_visual_preferences(created["run_id"], direction_count=3)
    with pytest.raises(ValueError, match="仅支持 auto"):
        runtime.set_visual_preferences(created["run_id"], provider_policy="manual")
    with pytest.raises(ValueError, match="只支持平台排版"):
        runtime.set_visual_preferences(created["run_id"], mode="ai_enhanced")


def test_platform_selection_can_change_before_topic_approval_but_not_after_freeze(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="平台选择", run_id="platform-selection-run")

    selected = runtime.set_platforms(created["run_id"], "公众号,视频号", confirm=True)

    assert selected["selected_platforms"] == ["wechat", "shipinhao"]
    assert selected["platform_selection"]["status"] == "confirmed"
    assert set(selected["platform_lanes"]) == {"wechat", "shipinhao"}

    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])
    state = runtime.run_state(run_id=created["run_id"])
    assert state["platform_selection"]["status"] == "locked"

    with pytest.raises(ValueError, match="平台已.*锁定"):
        runtime.set_platforms(created["run_id"], "小红书", confirm=True)


def test_new_run_rejects_legacy_secondary_platforms_but_old_run_remains_readable(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()

    with pytest.raises(ValueError, match="仅支持公众号、小红书和视频号"):
        runtime.create_run(topic="不再固定五平台", platforms="公众号,朋友圈")

    legacy_path = tmp_path / "runs" / "legacy-five-platform.json"
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_path.write_text(json.dumps({
        "run_id": "legacy-five-platform",
        "slug": "legacy-five-platform",
        "target_platforms": ["wechat", "xhs", "shipinhao", "douyin", "moments"],
        "steps": {},
        "approvals": {},
        "phase_artifacts": {},
        "history": [],
    }, ensure_ascii=False), encoding="utf-8")

    legacy = runtime.run_state(run_id="legacy-five-platform")

    assert legacy["schema"] == "aifios.production-run.v1"
    assert legacy["selected_platforms"] == ["wechat", "xhs", "shipinhao", "douyin", "moments"]
    assert legacy["platform_selection"]["status"] == "legacy_locked"


def test_blueprint_approval_is_bound_to_current_run_path_and_digest(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    primary = runtime.create_run(topic="审批绑定", platforms="公众号", run_id="approval-run")
    other = runtime.create_run(topic="另一条内容", platforms="公众号", run_id="other-run")
    runtime.switch_run(primary["run_id"])

    intake = runtime.write("intake", primary["slug"], "企业出海和自媒体需要低成本样板。", source="test")
    snapshot = persist_topic_snapshot(runtime, primary["run_id"], intake["path"])
    first = runtime.write("blueprint", primary["slug"], blueprint_with_snapshot("# 第一版蓝图", snapshot), source="test")
    approved = runtime.approve_blueprint(first["path"], run_id=primary["run_id"])

    assert approved["approved"] is True
    assert runtime.blueprint_approval_status(first["path"], run_id=primary["run_id"])["approved"] is True
    assert runtime.blueprint_approval_status(first["path"], run_id=other["run_id"])["approved"] is False

    first_path = Path(first["path"])
    first_path.write_text(first_path.read_text(encoding="utf-8") + "\n人工补充了一条边界。\n", encoding="utf-8")
    assert runtime.blueprint_approval_status(first["path"], run_id=primary["run_id"])["approved"] is False
    runtime.approve_blueprint(first["path"], run_id=primary["run_id"])

    second = runtime.write("blueprint", primary["slug"], "# 已编辑的第二版蓝图", source="ui-edit:test")

    assert runtime.blueprint_approval_status(first["path"], run_id=primary["run_id"])["approved"] is False
    assert runtime.blueprint_approval_status(second["path"], run_id=primary["run_id"])["approved"] is False


def test_topic_template_approval_freezes_the_exact_tikomni_snapshot_and_requires_it_later(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="TikOmni 冻结", run_id="tikomni-freeze-run")
    intake = runtime.write("intake", created["slug"], "企业出海和自媒体需要低成本样板。", source="test")
    snapshot = persist_topic_snapshot(runtime, created["run_id"], intake["path"])
    blueprint = runtime.write(
        "blueprint",
        created["slug"],
        blueprint_with_snapshot("# 已选主题与模板", snapshot),
        source="test",
    )

    approved = runtime.approve_artifact("topic_template", blueprint["path"], run_id=created["run_id"])
    frozen = market_signal_module.verify_frozen_market_snapshot(tmp_path, created["run_id"])

    assert approved["approved"] is True
    assert approved["market_snapshot_path"] == snapshot["manifest_path"]
    assert approved["market_snapshot_sha256"] == snapshot["snapshot_sha256"]
    assert frozen["verified"] is True
    assert runtime.approval_status("topic_template", blueprint["path"], run_id=created["run_id"])["approved"] is True

    Path(intake["path"]).write_text("素材变了，必须重新实时研究。", encoding="utf-8")
    status = runtime.approval_status("topic_template", blueprint["path"], run_id=created["run_id"])
    assert status["approved"] is False
    assert "TikOmni" in status["reason"]


def test_runtime_write_requires_frozen_topic_evidence_for_a_managed_production_run(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="运行时门禁", run_id="runtime-gate-run")

    with pytest.raises(ValueError, match="思想母版蓝图|选题与模板"):
        runtime.write("package", created["slug"], VALID_PACKAGE_BODY, source="test", run_id=created["run_id"])

    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])
    written = runtime.write("package", created["slug"], VALID_PACKAGE_BODY, source="test", run_id=created["run_id"])

    assert written["run_id"] == created["run_id"]
    assert runtime.run_state(run_id=created["run_id"])["steps"]["package"]["latest"]


def test_runtime_cli_requires_an_explicit_run_id_for_downstream_writes(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="CLI 门禁", run_id="runtime-cli-gate-run")
    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])

    missing = content_runtime_module.main([
        "--project", str(tmp_path), "write",
        "--step", "package",
        "--slug", created["slug"],
        "--content", VALID_PACKAGE_BODY,
    ])
    assert missing == 1
    assert "--run-id" in capsys.readouterr().err

    accepted = content_runtime_module.main([
        "--project", str(tmp_path), "write",
        "--step", "package",
        "--slug", created["slug"],
        "--content", VALID_PACKAGE_BODY,
        "--run-id", created["run_id"],
    ])
    payload = json.loads(capsys.readouterr().out)

    assert accepted == 0
    assert payload["run_id"] == created["run_id"]


def test_content_package_approval_trusts_the_explicit_human_confirmation(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="内容包发布门", run_id="content-package-gate-run")
    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])

    invalid = runtime.write("package", created["slug"], "# 不完整内容包", source="test", run_id=created["run_id"])
    assert runtime.approve_artifact("content_package", invalid["path"], run_id=created["run_id"], reviewed_plan_sha256=runtime.content_plan_status(created["run_id"])["blueprint_sha256"])["approved"] is True

    candidate_body = VALID_PACKAGE_BODY + "\n值得注意的是，这是一句需要自动局部修订的普通表达。\n"
    candidate = runtime.write("package", created["slug"], candidate_body, source="test", run_id=created["run_id"])
    assert runtime.approve_artifact("content_package", candidate["path"], run_id=created["run_id"], reviewed_plan_sha256=runtime.content_plan_status(created["run_id"])["blueprint_sha256"])["approved"] is True
    successor = runtime.run_state(run_id=created["run_id"])["steps"]["package"]["latest"]
    assert successor == Path(candidate["path"]).relative_to(tmp_path).as_posix()
    assert "值得注意的是" in runtime.read("package", file=successor)["body"]


def test_content_package_approval_allows_an_explicit_human_review_resolution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="内容包人工复核", run_id="content-package-review-run")
    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])
    candidate = runtime.write("package", created["slug"], VALID_PACKAGE_BODY, source="test", run_id=created["run_id"])

    monkeypatch.setattr(content_runtime_module, "run_release_gate", lambda _: {
        "status": "review_required",
        "repaired": False,
        "blocking_issues": [],
        "review_issues": ["仍有明显模板化 AI 表达，需要人工确认语气。"],
    })

    assert runtime.approve_artifact("content_package", candidate["path"], run_id=created["run_id"], reviewed_plan_sha256=runtime.content_plan_status(created["run_id"])["blueprint_sha256"])["approved"] is True


def material_correction_fixture(runtime: ContentRuntime, run: dict, correction_id: str = "correction_" + "a" * 32) -> dict:
    directory = runtime.project / "sessions" / "material-analysis"
    directory.mkdir(parents=True, exist_ok=True)
    context = {"schema": "aifios.material-analysis.v1", "runId": run["run_id"],
               "inputFingerprint": "b" * 64, "analysisInputFingerprint": "b" * 64, "analysisStatus": "current"}
    path = directory / f"{run['run_id']}.json"
    path.write_text(json.dumps(context), encoding="utf-8")
    return {"schema": "echo.material-correction.v1", "run_id": run["run_id"], "id": correction_id,
            "input_fingerprint": "b" * 64, "base_file_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "expected_fingerprint": "c" * 64, "previous_id": "", "created_at": "2026-09-18T00:00:00Z",
            "analysis": {"summary": "作者修正的素材", "facts": [], "opinions": ["先确认范围"],
                         "cases": [], "authorRequirements": ["不要追加销售引导"], "risks": []}}


def test_material_correction_preserves_evidence_but_requires_explicit_new_review(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="作者修正", run_id="material-correction")
    setup = approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    plan = Path(setup["blueprint"]["path"])
    binding = {"path": plan.relative_to(tmp_path).as_posix(), "sha256": hashlib.sha256(plan.read_bytes()).hexdigest()}
    package = runtime.write("package", run["slug"], f"<!-- echo-content-plan:{json.dumps(binding)} -->\n\n" + VALID_PACKAGE_BODY, run_id=run["run_id"])
    original = Path(package["path"]).read_bytes()
    runtime.approve_artifact("content_package", package["path"], run["run_id"])
    frozen = runtime._frozen_market_snapshot_path(run["run_id"]).read_bytes()
    record = material_correction_fixture(runtime, run)
    assert runtime.apply_material_correction(record)["saved"]
    reopened = ContentRuntime(tmp_path)
    assert reopened._frozen_market_snapshot_path(run["run_id"]).read_bytes() == frozen
    assert Path(package["path"]).read_bytes() == original
    assert not reopened.approval_status("topic_template", plan, run["run_id"])["approved"]
    assert not reopened.approval_status("content_package", package["path"], run["run_id"])["approved"]
    with pytest.raises(ValueError, match="素材整理结果已修正"):
        reopened.approve_artifact("topic_template", plan, run["run_id"])
    assert reopened.approve_artifact("topic_template", plan, run["run_id"], reviewed_material_correction_id=record["id"])["approved"]
    assert reopened.content_plan_status(run["run_id"])["status"] == "outdated"
    assert "素材整理结果已经修正" in reopened.content_plan_status(run["run_id"])["reason"]
    with pytest.raises(ValueError, match="素材整理结果已修正"):
        reopened.approve_artifact("content_package", package["path"], run["run_id"], reviewed_plan_sha256=binding["sha256"])
    reopened.approve_artifact("content_package", package["path"], run["run_id"], reviewed_plan_sha256=binding["sha256"], reviewed_material_correction_id=record["id"])
    assert reopened.content_plan_status(run["run_id"])["status"] == "retained"
    # Even a no-text-change next correction is a new human decision.
    second = {**record, "id": "correction_" + "d" * 32, "previous_id": record["id"]}
    reopened.apply_material_correction(second)
    assert reopened.content_plan_status(run["run_id"])["status"] == "outdated"
    assert Path(package["path"]).read_bytes() == original
    reopened.approve_artifact("topic_template", plan, run["run_id"], reviewed_material_correction_id=second["id"])
    next_binding = {**binding, "material_correction_id": second["id"]}
    generated = reopened.write("package", run["slug"], f"<!-- echo-content-plan:{json.dumps(next_binding)} -->\n\n" + VALID_PACKAGE_BODY, run_id=run["run_id"])
    assert reopened.content_plan_status(run["run_id"])["status"] == "current"
    assert reopened.approve_artifact("content_package", generated["path"], run["run_id"], reviewed_material_correction_id=second["id"])["approved"]


def test_material_correction_cas_and_idempotence(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="素材修正版本", run_id="correction-cas")
    record = material_correction_fixture(runtime, run)
    with pytest.raises(ValueError, match="已经更新"):
        runtime.apply_material_correction({**record, "base_file_sha256": "0" * 64})
    assert "material_correction" not in runtime.run_state(run_id=run["run_id"])
    runtime.apply_material_correction(record)
    assert runtime.apply_material_correction(record)["replayed"]
    with pytest.raises(ValueError, match="另一组修改"):
        runtime.apply_material_correction({**record, "analysis": {**record["analysis"], "summary": "另一组修改"}})
    second = {**record, "id": "correction_" + "d" * 32, "previous_id": record["id"]}
    runtime.apply_material_correction(second)
    with pytest.raises(ValueError, match="替代"):
        runtime.apply_material_correction(record)
    assert len([h for h in runtime.run_state(run_id=run["run_id"])["history"] if h.get("event") == "material_corrected"]) == 2


def test_material_correction_tamper_invalidates_even_new_approval(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="修正记录核验", run_id="correction-tamper")
    setup = approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    record = material_correction_fixture(runtime, run)
    runtime.apply_material_correction(record)
    path = setup["blueprint"]["path"]
    runtime.approve_artifact("topic_template", path, run["run_id"], reviewed_material_correction_id=record["id"])
    pointer = runtime.run_state(run_id=run["run_id"])["material_correction"]
    (tmp_path / pointer["path"]).write_text("{}")
    assert not runtime.approval_status("topic_template", path, run["run_id"])["approved"]


def test_content_plan_binding_detects_same_path_changes_and_keeps_original_bytes(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="方案与正文", run_id="plan-binding")
    setup = approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    plan_file = Path(setup["blueprint"]["path"])
    binding = {"path": plan_file.relative_to(tmp_path).as_posix(), "sha256": hashlib.sha256(plan_file.read_bytes()).hexdigest()}
    body = f"<!-- echo-content-plan:{json.dumps(binding)} -->\n\n" + VALID_PACKAGE_BODY
    package = runtime.write("package", run["slug"], body, source="ui-agent:content-package", run_id=run["run_id"])
    package_file = Path(package["path"])
    original = package_file.read_bytes()
    assert runtime.content_plan_status(run["run_id"])["status"] == "current"
    runtime.approve_artifact("content_package", package_file, run_id=run["run_id"])
    plan_file.write_text(plan_file.read_text() + "\n结尾改成一个行动。\n")
    assert runtime.content_plan_status(run["run_id"])["status"] == "outdated"
    assert not runtime.approval_status("content_package", package_file, run_id=run["run_id"])["approved"]
    with pytest.raises(ValueError, match="重新核对"):
        runtime.approve_artifact("content_package", package_file, run_id=run["run_id"], reviewed_plan_sha256=binding["sha256"])
    with pytest.raises(ValueError, match="明确核对"):
        runtime.approve_artifact("content_package", package_file, run_id=run["run_id"])
    current = runtime.content_plan_status(run["run_id"])
    approved = runtime.approve_artifact("content_package", package_file, run_id=run["run_id"], reviewed_plan_sha256=current["blueprint_sha256"])
    assert approved["content_plan_decision"] == "keep_existing"
    assert ContentRuntime(tmp_path).content_plan_status(run["run_id"])["status"] == "retained"
    assert package_file.read_bytes() == original


def test_content_plan_legacy_revisions_do_not_claim_the_latest_plan(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="旧稿恢复", run_id="legacy-plan")
    setup = approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    original = runtime.write("package", run["slug"], VALID_PACKAGE_BODY, source="ui-agent:content-package", run_id=run["run_id"])
    assert runtime.content_plan_status(run["run_id"])["status"] == "unknown"
    plan = runtime.write("blueprint", run["slug"], runtime.read("blueprint", file=setup["blueprint"]["path"])["body"] + "\n新方案。", run_id=run["run_id"])
    runtime.approve_artifact("topic_template", plan["path"], run_id=run["run_id"])
    revision_id = "rev_" + "a" * 32
    directory = tmp_path / "runs" / run["run_id"] / "content-revisions"
    directory.mkdir(parents=True)
    (directory / f"{revision_id}.json").write_text(json.dumps({"runId": run["run_id"], "id": revision_id, "basePath": Path(original["path"]).relative_to(tmp_path).as_posix()}))
    runtime.write("package", run["slug"], VALID_PACKAGE_BODY, source=f"content-revision-undo:{revision_id}", run_id=run["run_id"])
    status = runtime.content_plan_status(run["run_id"])
    assert status["status"] == "outdated"
    assert status["source_blueprint_path"] == Path(setup["blueprint"]["path"]).relative_to(tmp_path).as_posix()


def test_topic_template_approval_rejects_a_blueprint_without_a_live_snapshot(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="缺快照", run_id="missing-snapshot-run")
    blueprint = runtime.write("blueprint", created["slug"], "# 没有研究快照", source="test")

    with pytest.raises(ValueError, match="TikOmni 研究快照"):
        runtime.approve_artifact("topic_template", blueprint["path"], run_id=created["run_id"])


def test_brand_layout_template_is_bound_to_topic_approval_and_invalidates_on_change(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(
        topic="品牌排版模板",
        run_id="brand-layout-run",
        visual_template="editorial",
    )
    intake = runtime.write("intake", created["slug"], "客户案例与产品判断。", source="test")
    snapshot = persist_topic_snapshot(runtime, created["run_id"], intake["path"])
    blueprint = runtime.write(
        "blueprint",
        created["slug"],
        blueprint_with_snapshot("# 模板绑定蓝图", snapshot),
        source="test",
    )

    approval = runtime.approve_artifact("topic_template", blueprint["path"], run_id=created["run_id"])
    changed = runtime.set_visual_template(created["run_id"], "ft")

    assert approval["visual_template"] == "editorial"
    assert changed["changed"] is True
    assert changed["visual_template"] == "ft"
    assert runtime.approval_status("topic_template", blueprint["path"], run_id=created["run_id"])["approved"] is False


def test_phase_approvals_bind_current_artifacts_and_invalidate_downstream(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="阶段审批", run_id="phase-approval-run")
    run_id = created["run_id"]
    topic = approve_frozen_topic_template(runtime, run_id, created["slug"])
    blueprint = topic["blueprint"]

    package = runtime.write("package", created["slug"], VALID_PACKAGE_BODY, source="test", run_id=run_id)
    package_approval = runtime.approve_artifact("content_package", package["path"], run_id=run_id, reviewed_plan_sha256=runtime.content_plan_status(run_id)["blueprint_sha256"])

    visual_path = write_verified_visual_manifest(runtime, run_id)
    runtime.register_phase_artifact("visual_assets", visual_path, run_id=run_id)
    runtime.approve_artifact("visual_assets", visual_path, run_id=run_id)

    draft_path = tmp_path / "materials" / "publication" / "drafts" / created["slug"] / "draft-queue.json"
    draft_path.parent.mkdir(parents=True, exist_ok=True)
    draft_path.write_text(
        json.dumps(complete_draft_queue(runtime, run_id, created["slug"], package["path"], visual_path), ensure_ascii=False),
        encoding="utf-8",
    )
    runtime.register_phase_artifact("draft_information", draft_path, run_id=run_id)
    runtime.approve_artifact("draft_information", draft_path, run_id=run_id)

    assert package_approval["version"] == 1
    assert runtime.approval_status("topic_template", blueprint["path"], run_id=run_id)["approved"] is True
    assert runtime.approval_status("content_package", package["path"], run_id=run_id)["approved"] is True
    assert runtime.approval_status("visual_assets", visual_path, run_id=run_id)["approved"] is True
    assert runtime.approval_status("draft_information", draft_path, run_id=run_id)["approved"] is True

    revised_package = runtime.write("package", created["slug"], "# 第二版内容包", source="test", run_id=run_id)
    changed_run = runtime.run_state(run_id=run_id)

    assert runtime.approval_status("topic_template", blueprint["path"], run_id=run_id)["approved"] is True
    assert runtime.approval_status("content_package", package["path"], run_id=run_id)["approved"] is False
    assert runtime.approval_status("content_package", revised_package["path"], run_id=run_id)["approved"] is False
    assert runtime.approval_status("visual_assets", visual_path, run_id=run_id)["approved"] is False
    assert runtime.approval_status("draft_information", draft_path, run_id=run_id)["approved"] is False
    assert "visual_assets" not in changed_run.get("phase_artifacts", {})
    assert "draft_information" not in changed_run.get("phase_artifacts", {})
    assert "publication_result" not in changed_run.get("phase_artifacts", {})
    with pytest.raises(ValueError, match="内容包不是当前 run 最新版本"):
        runtime.register_phase_artifact("draft_information", draft_path, run_id=run_id)


def test_publication_ledger_registers_as_a_phase_artifact_and_is_superseded_by_legacy_publish(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="发布台账", run_id="publication-ledger-run")
    run_id = created["run_id"]
    approve_frozen_topic_template(runtime, run_id, created["slug"])
    ledger_path = tmp_path / "materials" / "publication" / "ledger" / created["slug"] / "publication-ledger.json"
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    ledger_path.write_text(
        '{"schema":"aifios.publication-ledger.v1","records":[]}',
        encoding="utf-8",
    )

    registered = runtime.register_phase_artifact("publication_result", ledger_path, run_id=run_id)
    approved = runtime.approve_artifact("publication_result", ledger_path, run_id=run_id)

    assert registered["path"] == ledger_path.relative_to(tmp_path).as_posix()
    assert approved["approved"] is True
    assert runtime.approval_status("publication_result", ledger_path, run_id=run_id)["approved"] is True

    legacy_publish = runtime.write("publish", created["slug"], "# 旧发布记录", source="test", run_id=run_id)

    assert runtime.approval_status("publication_result", ledger_path, run_id=run_id)["approved"] is False
    assert runtime.approval_status("publication_result", legacy_publish["path"], run_id=run_id)["approved"] is False


def test_draft_queue_approval_ignores_operational_status_but_not_payload_or_asset_evidence(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="草稿队列审批", run_id="draft-queue-approval-run")
    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])
    package = runtime.write("package", created["slug"], VALID_PACKAGE_BODY, source="test", run_id=created["run_id"])
    runtime.approve_artifact("content_package", package["path"], run_id=created["run_id"], reviewed_plan_sha256=runtime.content_plan_status(created["run_id"])["blueprint_sha256"])
    visual_path = write_verified_visual_manifest(runtime, created["run_id"])
    runtime.register_phase_artifact("visual_assets", visual_path, run_id=created["run_id"])
    runtime.approve_artifact("visual_assets", visual_path, run_id=created["run_id"])
    queue_path = tmp_path / "materials" / "publication" / "drafts" / created["slug"] / "draft-queue.json"
    queue_path.parent.mkdir(parents=True, exist_ok=True)
    queue = complete_draft_queue(runtime, created["run_id"], created["slug"], package["path"], visual_path)
    queue["jobs"][0]["payload"] = {
        "title": "初版标题",
        "asset_paths": ["pipeline/visual/cover.png"],
    }
    queue["jobs"][0]["selected_asset_hashes"] = [{
        "path": "pipeline/visual/cover.png",
        "sha256": "d" * 64,
    }]
    queue_path.write_text(json.dumps(queue, ensure_ascii=False), encoding="utf-8")

    runtime.register_phase_artifact("draft_information", queue_path, run_id=created["run_id"])
    runtime.approve_artifact("draft_information", queue_path, run_id=created["run_id"])
    assert runtime.approval_status("draft_information", queue_path, run_id=created["run_id"])["approved"] is True

    queue["updated_at"] = "2026-07-15T01:00:00"
    queue["jobs"][0].update({
        "status": "draft_filled",
        "adapter": "authorized_browser",
        "attempt_count": 1,
        "authorization_state": "authorized",
        "events": [{"status": "draft_filled"}],
    })
    queue_path.write_text(json.dumps(queue, ensure_ascii=False), encoding="utf-8")
    assert runtime.approval_status("draft_information", queue_path, run_id=created["run_id"])["approved"] is True

    queue["jobs"][0]["payload"]["title"] = "修改后的平台标题"
    queue_path.write_text(json.dumps(queue, ensure_ascii=False), encoding="utf-8")
    assert runtime.approval_status("draft_information", queue_path, run_id=created["run_id"])["approved"] is False


def test_draft_queue_approval_rejects_empty_or_mismatched_fixed_delivery_contract(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="草稿队列完整性", run_id="draft-queue-contract-run")
    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])
    package = runtime.write("package", created["slug"], VALID_PACKAGE_BODY, source="test", run_id=created["run_id"])
    runtime.approve_artifact("content_package", package["path"], run_id=created["run_id"], reviewed_plan_sha256=runtime.content_plan_status(created["run_id"])["blueprint_sha256"])
    visual_path = write_verified_visual_manifest(runtime, created["run_id"])
    runtime.register_phase_artifact("visual_assets", visual_path, run_id=created["run_id"])
    runtime.approve_artifact("visual_assets", visual_path, run_id=created["run_id"])
    queue_path = tmp_path / "materials" / "publication" / "drafts" / created["slug"] / "draft-queue.json"
    queue_path.parent.mkdir(parents=True, exist_ok=True)

    queue_path.write_text(
        json.dumps({
            "schema": "aifios.publication-draft-queue.v1",
            "run_id": created["run_id"],
            "run_slug": created["slug"],
            "package_path": package["path"],
            "jobs": [],
        }),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="发布草稿"):
        runtime.register_phase_artifact("draft_information", queue_path, run_id=created["run_id"])

    queue = complete_draft_queue(runtime, created["run_id"], created["slug"], package["path"], visual_path)
    seven_item_queue = {
        **queue,
        "jobs": [
            job for job in queue["jobs"]
            if job["item_id"] not in {
                "xiaohongshu-opinion-2",
                "xiaohongshu-opinion-3",
                "moments-opinion-2",
                "moments-opinion-3",
            }
        ],
    }
    queue_path.write_text(json.dumps(seven_item_queue, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="固定 11 项"):
        runtime.register_phase_artifact("draft_information", queue_path, run_id=created["run_id"])

    queue_path.write_text(json.dumps(queue, ensure_ascii=False), encoding="utf-8")
    runtime.register_phase_artifact("draft_information", queue_path, run_id=created["run_id"])
    runtime.approve_artifact("draft_information", queue_path, run_id=created["run_id"])

    current_package_hash = queue["package_sha256"]
    queue["package_sha256"] = "0" * 64
    queue_path.write_text(json.dumps(queue, ensure_ascii=False), encoding="utf-8")
    assert runtime.approval_status("draft_information", queue_path, run_id=created["run_id"])["approved"] is False
    with pytest.raises(ValueError, match="内容包 SHA-256"):
        runtime.approve_artifact("draft_information", queue_path, run_id=created["run_id"])
    queue["package_sha256"] = current_package_hash

    queue["jobs"][0]["delivery_kind"] = "execution_package"
    queue_path.write_text(json.dumps(queue, ensure_ascii=False), encoding="utf-8")
    assert runtime.approval_status("draft_information", queue_path, run_id=created["run_id"])["approved"] is False
    with pytest.raises(ValueError, match="当前契约"):
        runtime.approve_artifact("draft_information", queue_path, run_id=created["run_id"])


def test_visual_approval_requires_every_declared_asset_role(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="视觉逐项采用", run_id="visual-approval-run")
    visual_path = tmp_path / "pipeline" / "visual" / created["slug"] / "selected-assets.json"
    visual_path.parent.mkdir(parents=True, exist_ok=True)
    visual_path.write_text(
        '{"schema":"aifios.visual-asset-manifest.v1","requiredRoles":["wechat_cover","xhs-01-p1"],"selections":{"wechat_cover":{"assetId":"wechat-cover"}}}',
        encoding="utf-8",
    )
    runtime.register_phase_artifact("visual_assets", visual_path, run_id=created["run_id"])

    with pytest.raises(ValueError, match="尚未逐项采用"):
        runtime.approve_artifact("visual_assets", visual_path, run_id=created["run_id"])


def test_visual_approval_rejects_a_tampered_selected_asset_binding(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="视觉完整性", run_id="visual-integrity-run")
    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])
    package = runtime.write("package", created["slug"], VALID_PACKAGE_BODY, source="test", run_id=created["run_id"])
    runtime.approve_artifact("content_package", package["path"], run_id=created["run_id"], reviewed_plan_sha256=runtime.content_plan_status(created["run_id"])["blueprint_sha256"])
    visual_path = write_verified_visual_manifest(runtime, created["run_id"])
    runtime.register_phase_artifact("visual_assets", visual_path, run_id=created["run_id"])

    manifest = json.loads(visual_path.read_text(encoding="utf-8"))
    manifest["selections"]["wechat_cover"]["sha256"] = "0" * 64
    visual_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="摘要"):
        runtime.approve_artifact("visual_assets", visual_path, run_id=created["run_id"])


def test_session_platforms_and_route_stay_with_supported_surfaces(tmp_path: Path) -> None:
    manager = SessionManager(tmp_path)
    targets = detect_target_platforms("公众号和小红书都需要")
    saved = manager.set_target_platforms(["wechat", "xhs", "unsupported"])
    route = manager.route("我想写公众号，主题是客户为什么不信任自我介绍")
    guide = manager.guide("我想做公众号和小红书爆款对标")

    assert targets == ["wechat", "xhs"]
    assert saved == ["wechat", "xhs"]
    assert route["target_platforms"] == ["wechat"]
    assert guide["target_platforms"] == ["wechat", "xhs"]
    assert "公众号、小红书" in guide["guide"]


def test_session_material_to_content_route_requires_topic_and_market_gate(tmp_path: Path) -> None:
    def live_fetcher(platform: str, query: str) -> dict:
        return {
            "status": "available",
            "platform": platform,
            "endpoint_id": f"{platform}.fixture",
            "query_applied": True,
            "raw_payload": {"data": {"items": [{
                "title": f"{platform} {query}",
                "desc": "公开可验证样本。",
                "url": f"https://example.test/{platform}/{query}",
                "like_count": 20,
            }]}},
        }

    def ready_gate(*_args, **_kwargs):
        return market_signal_module.build_theme_gate_response(
            "企业出海、自媒体、老板个人IP、AI和产品力流量。",
            project=tmp_path,
            live_fetcher=live_fetcher,
        )

    with patch.object(session_manager_module, "build_theme_gate_response", ready_gate):
        manager = SessionManager(tmp_path)
        intake_route = manager.route(
            "根据这段素材生成内容，最后直接出公众号、小红书、视频号、抖音和朋友圈："
            "客户看不懂我们服务的价值。"
        )
        confirmed_route = manager.route("我选 A，按这个主题继续生成")

    assert intake_route["skill"] == "content-intake"
    assert intake_route["theme_gate"] is True
    assert intake_route["choice_count"] == 6
    assert [option["choice"] for option in intake_route["theme_options"]] == list("ABCDEF")
    assert "回复 A-F" in intake_route["next_action"]
    assert not session_manager_module.has_confirmed_package_signal("我选 g，按这个主题继续生成")
    assert intake_route["target_platforms"] == ["wechat", "xhs", "shipinhao", "douyin", "moments"]
    assert confirmed_route["skill"] == "content-validate"
    assert "market-signal" in confirmed_route["next_action"]


def test_intake_theme_option_contract_requires_exactly_a_through_f() -> None:
    valid = "A. 主题一；B. 主题二；C. 主题三；D. 主题四；E. 主题五；F. 主题六"
    with_extra_choice = f"{valid}；G. 不应出现的第七条"

    assert intake_quality_module.option_marker_count(valid) == 6
    assert intake_quality_module.has_exact_theme_option_labels(valid)
    assert intake_quality_module.option_marker_count(with_extra_choice) == 7
    assert not intake_quality_module.has_exact_theme_option_labels(with_extra_choice)


def test_session_never_falls_back_to_a_topic_menu_when_tikomni_blocks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(session_manager_module, "build_theme_gate_response", lambda *_args, **_kwargs: {
        "body": "TikOmni 三平台实时研究未通过，当前不能进入选题确认。",
        "choice_count": 0,
        "options": [],
        "recommended": "",
        "market_signal_status": "blocked",
        "market_signal_note": "Token 缺失。",
        "queries": ["企业出海 自媒体"],
        "blocked": True,
        "blockers": [{"code": "tikomni_unavailable", "message": "Token 缺失。"}],
    })

    route = SessionManager(tmp_path).route("根据这段素材生成内容：企业出海和自媒体")

    assert route["theme_gate"] is True
    assert route["topic_selection_blocked"] is True
    assert route["choice_count"] == 0
    assert route["theme_options"] == []
    assert route["market_signal_status"] == "blocked"
    assert "回复 A-F" not in route["next_action"]


def test_session_blocks_on_market_gate_runtime_error_instead_of_using_legacy_options(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unavailable(*_args, **_kwargs):
        raise RuntimeError("TikOmni endpoint failed")

    monkeypatch.setattr(session_manager_module, "build_theme_gate_response", unavailable)

    route = SessionManager(tmp_path).route("根据这段素材生成内容：企业出海和自媒体")

    assert route["topic_selection_blocked"] is True
    assert route["choice_count"] == 0
    assert route["market_signal_status"] == "blocked"
    assert "TikOmni" in route["next_action"]


def test_quality_check_writes_report_for_owned_final_draft(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="内容质量测试", platforms="公众号", run_id="quality-run")
    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])
    body = (
        "# 客户不是先看你是谁\n\n"
        "一次客户访谈后，创始人拿着履历问我为什么第一篇文章没人停下来。"
        "问题不在他没有经历，而在客户还没看到自己的卡点。\n\n"
        "## 客户先判断问题\n\n"
        "先写客户是谁、卡在哪里和下一步能做什么，再介绍你如何帮助他。\n\n"
        "## 商业承接\n\n"
        "需要判断自己开头的业务负责人，可以先整理目标客户和当前开头。"
    )
    draft = runtime.write("write", created["slug"], body, source="test", run_id=created["run_id"])
    result = run_quality_check(tmp_path, "wechat", file=draft["path"], slug=created["slug"])

    assert result["run_id"] == "quality-run"
    assert Path(result["report_path"]).is_file()
    assert Path(result["json_report_path"]).is_file()
    assert result["platform"] == "wechat"


def test_delivery_audit_reports_an_incomplete_run_without_crashing(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="交付审计", platforms="小红书", run_id="delivery-run")
    audit = run_delivery_audit(tmp_path, run_id=created["run_id"], auto_pack=True)

    assert audit["status"] == "blocked"
    assert any(issue["code"] == "missing-step" for issue in audit["issues"])
    assert audit["run_id"] == "delivery-run"


def test_visual_provider_registry_remains_reviewed() -> None:
    registry = load_provider_registry()
    assert registry
    assert validate_visual_provider_registry(registry) == []


def test_package_contains_full_multi_platform_publish_copy(tmp_path: Path) -> None:
    del tmp_path
    result = audit_package(VALID_PACKAGE_BODY)

    assert result["status"] == "pass", result
    assert result["checks"]["has_wechat_article"] is True
    assert result["checks"]["has_xhs_copy"] is True
    assert result["checks"]["has_video_scripts"] is True
    assert result["checks"]["has_video_publish_forms"] is True


def test_demo_init_produces_a_valid_1_plus_2_plus_3_package(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    initialized = runtime.init(demo=True)
    package_paths = [Path(path) for path in initialized["demo_files"] if "/pipeline/package/" in path]

    assert len(package_paths) == 1
    validation = runtime.validate("package", package_paths[0])
    package = runtime.read("package", file=package_paths[0])
    quality = audit_package(package["body"])

    assert validation["valid"] is True, validation
    assert validation["quality_status"] == "pass", validation
    assert quality["status"] == "pass", quality
    assert quality["checks"]["has_video_scripts"] is True
    assert quality["checks"]["has_opinion_cards"] is True


def test_package_blocks_missing_video_publish_form(tmp_path: Path) -> None:
    del tmp_path
    body = VALID_PACKAGE_BODY.replace("#### 平台发布表单", "#### 视频发布信息缺失", 1)

    result = audit_package(body)

    assert result["status"] == "blocked", result
    assert any("平台发布表单" in error for error in result["errors"])


def test_platform_adapt_accepts_video_account_publish_fields(tmp_path: Path) -> None:
    del tmp_path
    body = """# 跨平台发布改编 · 客户问题优先

## 0. 原文信息
- 原文平台：小红书
- 原文路径：pipeline/xhs/customer-problem.md
- 核心选题：创始人第一篇内容为什么让客户划走
- 核心观点：客户先判断你是否理解他的处境，才会判断你是否专业。
- 目标人群：第一次做内容、但客户看不见价值的服务型创始人
- 不可改写的事实边界：不公开客户信息，不承诺成交或流量结果。
- 本次目标平台：视频号

## 3. 视频号发布稿
### 发布字段
- 标题：第一条内容别先写履历
- 发布文案：客户先找自己的问题，再判断你是否专业。你现在最难写的是哪一步？
- 话题：#内容表达 #客户问题
- 封面字：别先写履历
- 封面画面：正面近景，左侧保留封面字，背景是客户问题白板。
- 置顶评论：留下业务类型和目标客户，我帮你检查第一句话。

### 拍摄执行
- 3 秒钩子：客户划走你的第一篇内容，往往不是因为你不专业。
- 推荐时长：45-60 秒。
- 可复用口播来源：package 中的短视频 1。
- 镜头重点：正面口播、白板三步法、问题卡和正面收口。
- 字幕重点：客户、卡点、下一步三个词必须高亮。

### 需要补充的素材
- 现有素材足够，未新增事实；白板可由创作者在拍摄时重写。

## 6. 平台差异对照
| 平台 | 首屏入口 | 信息组织 | 视觉/拍摄重点 | 互动承接 |
|---|---|---|---|---|
| 小红书 | 场景和观点 | P1-P5 页卡 | 3:4 首图和卡片 | 收藏、评论 |
| 视频号 | 人和关系感 | 口播和证据卡 | 竖屏首帧和字幕 | 评论区追问 |
| 抖音 | 3 秒反差 | 高密度口播 | 竖屏节奏和 B-roll | 评论区互动 |

## 7. 下一步执行指令
- 使用 `content-package` 内对应短视频的逐句口播、镜头清单、字幕重点与 B-roll 完成拍摄。
- 发布前对最终文案运行 `content-prelaunch` 与 `content-compliance`。
"""

    result = audit_platform_adapt(body)

    assert result["status"] == "pass", result
    assert result["checks"]["target_platforms"] == ["shipinhao"]


def test_publish_quality_accepts_validated_package_as_final_content(tmp_path: Path) -> None:
    del tmp_path
    body = """# 发布记录 · 多平台内容

## 0. 最终版
- 最终版路径：pipeline/package/customer-problem-package.md
- 发布平台：视频号
- 发布日期：2026-07-14 10:30
- 发布链接：https://channels.weixin.qq.com/customer-problem
- 发布状态：已发布

## 1. 表现数据
| 指标 | 数值 |
|---|---|
| 播放 | 120 |
| 点赞 | 20 |

## 2. 发布备注
首发视频号，封面、口播、字幕和评论引导均按已审核版本发布。

## 3. 最终版正文快照
标题：第一条内容别先写履历
摘要：客户先判断你是否理解他的处境，才会判断你是否专业。
"""

    result = audit_publish(body)

    assert result["status"] == "pass", result
    assert result["checks"]["final_path_ok"] is True


def test_publish_quality_accepts_moments_proof_without_public_url(tmp_path: Path) -> None:
    del tmp_path
    body = """# 发布记录 · 朋友圈内容

## 0. 最终版
- 最终版路径：pipeline/package/customer-problem-package.md
- 发布平台：朋友圈
- 发布日期：2026-07-14 10:30
- 发布链接：朋友圈无公开链接
- 发布凭证：materials/publish-proof/customer-problem-moments.png
- 发布状态：已发布

## 1. 表现数据
| 指标 | 数值 |
|---|---|
| 可见互动 | 8 |
| 回复 | 3 |

## 2. 发布备注
朋友圈发布凭证已上传；互动数据仅记录发布负责人可见的手工统计口径。

## 3. 最终版正文快照
标题：客户不是先看你是谁
摘要：先把客户正在卡住的问题说清楚，再介绍你能做什么。
"""

    result = audit_publish(body)

    assert result["status"] == "pass", result
    assert result["checks"]["is_moments"] is True
    assert result["checks"]["publish_proof_path_ok"] is True


def test_quality_check_accepts_package_as_publishable_source(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="客户问题内容包", platforms="公众号,视频号", run_id="package-quality-run")
    approve_frozen_topic_template(runtime, created["run_id"], created["slug"])
    package = runtime.write("package", created["slug"], VALID_PACKAGE_BODY, source="test", run_id=created["run_id"])

    result = run_quality_check(tmp_path, "wechat", file=package["path"], slug=created["slug"])

    assert result["run_id"] == "package-quality-run"
    assert result["file"].endswith("-package.md")


def test_package_blocks_page_visuals_without_evidence_source_or_concept_boundary() -> None:
    body = VALID_PACKAGE_BODY.replace("概念图解（非事实证据）：客户卡点与判断路径", "做一张好看的图", 1)

    result = audit_package(body)

    assert result["status"] == "blocked", result
    assert any("证据来源" in error or "概念插图" in error for error in result["errors"])


def test_content_package_template_requires_a_visual_boundary_on_every_page() -> None:
    skill = (REPO_ROOT / "skills" / "content-package" / "SKILL.md").read_text(encoding="utf-8")
    rows = {line.split("|", 2)[1].strip(): line for line in skill.splitlines() if line.startswith("| P")}

    assert set(rows) == {f"P{index}" for index in range(1, 9)}
    for page_id, row in rows.items():
        assert "materials/..." in row, page_id
        assert "非事实证据" in row, page_id
    assert "### 发布正文" in skill
    assert "### 结尾标签" in skill


def run() -> int:
    cases = [
        test_init_creates_active_runtime_directories,
        test_write_read_validate_and_material_index,
        test_topic_selection_updates_the_existing_run_without_renaming_it,
        test_validation_rejects_invalid_fixture,
        test_douyin_script_step_writes_reads_and_validates,
        test_run_lifecycle_and_pipeline_start,
        test_default_schedule_stops_at_draft_information_before_weekly_learning,
        test_blueprint_approval_is_bound_to_current_run_path_and_digest,
        test_phase_approvals_bind_current_artifacts_and_invalidate_downstream,
        test_draft_queue_approval_rejects_empty_or_mismatched_fixed_delivery_contract,
        test_visual_approval_requires_every_declared_asset_role,
        test_session_platforms_and_route_stay_with_supported_surfaces,
        test_session_material_to_content_route_requires_topic_and_market_gate,
        test_quality_check_writes_report_for_owned_final_draft,
        test_delivery_audit_reports_an_incomplete_run_without_crashing,
        test_package_contains_full_multi_platform_publish_copy,
        test_package_blocks_missing_video_publish_form,
        test_platform_adapt_accepts_video_account_publish_fields,
        test_publish_quality_accepts_validated_package_as_final_content,
        test_publish_quality_accepts_moments_proof_without_public_url,
        test_quality_check_accepts_package_as_publishable_source,
    ]
    failures = 0
    for case in cases:
        with tempfile.TemporaryDirectory(prefix="aifios-runtime-test-") as directory:
            try:
                case(Path(directory))
            except Exception as exc:  # Keep direct gate output concise and actionable.
                print(f"FAIL {case.__name__}: {exc}")
                failures += 1
            else:
                print(f"PASS {case.__name__}")

    try:
        test_visual_provider_registry_remains_reviewed()
    except Exception as exc:
        print(f"FAIL test_visual_provider_registry_remains_reviewed: {exc}")
        failures += 1
    else:
        print("PASS test_visual_provider_registry_remains_reviewed")

    print(f"\n{'PASS' if failures == 0 else 'FAIL'}: {failures} failure(s)")
    return failures


if __name__ == "__main__":
    raise SystemExit(run())

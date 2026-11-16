#!/usr/bin/env python3
"""Focused regression coverage for the optional weekly learning loop."""
from __future__ import annotations

import json
import hashlib
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

import weekly_learning as weekly_learning_module  # noqa: E402
from weekly_learning import (  # noqa: E402
    WeeklyLearningError,
    acknowledge_reminder,
    apply_memory,
    collect_tikomni_public_performance,
    collect_weekly_review,
    complete_weekly_review,
    record_manual_metrics,
    weekly_status,
)


NOW = "2026-07-20T10:00:00+08:00"
VISUAL_PATH = "pipeline/visual/client-real/publish/r001/cover.png"
VISUAL_BYTES = b"verified-client-real-cover"
VISUAL_SHA256 = hashlib.sha256(VISUAL_BYTES).hexdigest()


def test_comment_redaction_covers_credentials_and_local_paths() -> None:
    value = weekly_learning_module.redact_comment(
        "API Key: sk-private-secret，文件 /home/alice/private.txt，手机号 13800138000"
    )

    assert "private" not in value
    assert "sk-" not in value
    assert "13800138000" not in value
    assert value.count("[已脱敏]") >= 3


@pytest.fixture(autouse=True)
def no_real_tikomni_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Focused weekly tests must not depend on a developer's local Token."""
    monkeypatch.setattr(
        weekly_learning_module,
        "collect_tikomni_public_performance",
        lambda _project, items: {
            str(item.get("published_url")): {
                "status": "unavailable",
                "source": "tikomni_live",
                "metrics": {},
                "comments": [],
                "source_path": "",
                "captured_at": NOW,
                "endpoint_id": "",
                "reason": "test fixture: live collection disabled",
            }
            for item in items
        },
    )


def write_json(project: Path, relative: str, value: object) -> None:
    target = project / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def publication_record(record_id: str, platform: str, url: str, published_at: str) -> dict:
    return {
        "record_id": record_id,
        "queue_id": "queue_client",
        "job_id": f"job_{record_id}",
        "platform": platform,
        "item_id": f"{platform}-item",
        "final_content_hash": "a" * 64,
        "payload_hash": "b" * 64,
        "selected_asset_hashes": [
            {
                "path": VISUAL_PATH,
                "sha256": VISUAL_SHA256,
                "role": "wechat_cover",
            }
        ],
        "published_url": url,
        "published_at": published_at,
        "human_confirmed": True,
        "recorded_at": published_at,
    }


def write_publication_bundle(project: Path, records: list[dict]) -> None:
    visual = project / VISUAL_PATH
    visual.parent.mkdir(parents=True, exist_ok=True)
    visual.write_bytes(VISUAL_BYTES)
    queue = {
        "schema": "aifios.publication-draft-queue.v1",
        "queue_id": "queue_client",
        "run_id": "client-real-run",
        "run_slug": "client-real",
        "package_path": "pipeline/package/client-real-package.md",
        "package_sha256": "e" * 64,
        "visual_manifest_path": "pipeline/visual/client-real/selected-assets.json",
        "visual_manifest_sha256": "f" * 64,
        "created_at": "2026-07-18T10:00:00+08:00",
        "updated_at": "2026-07-19T12:00:00+08:00",
        "jobs": [
            {
                "job_id": record["job_id"],
                "platform": record["platform"],
                "item_id": record["item_id"],
                "item_label": record["item_id"],
                "delivery_kind": "draft_fill",
                "adapter": "authorized_browser",
                "payload": {
                    "title": record["item_id"],
                    "asset_paths": [asset["path"] for asset in record["selected_asset_hashes"]],
                },
                "payload_hash": record["payload_hash"],
                "content_hash": record["final_content_hash"],
                "selected_asset_hashes": record["selected_asset_hashes"],
                "status": "published_confirmed",
                "authorization_state": "authorized",
                "attempt_count": 1,
                "retry_count": 0,
                "events": [{"at": record["published_at"], "status": "published_confirmed"}],
            }
            for record in records
        ],
    }
    queue_relative = "materials/publication/drafts/client-real/draft-queue.json"
    write_json(project, queue_relative, queue)
    queue_bytes = (project / queue_relative).read_bytes()
    write_json(project, "materials/publication/ledger/client-real/publication-ledger.json", {
        "schema": "aifios.publication-ledger.v1",
        "ledger_id": "ledger_client_real",
        "queue_id": "queue_client",
        "run_id": "client-real-run",
        "run_slug": "client-real",
        "queue_path": queue_relative,
        "queue_sha256": hashlib.sha256(queue_bytes).hexdigest(),
        "queue_contract_sha256": weekly_learning_module.draft_queue_contract_sha256(queue),
        "created_at": "2026-07-18T12:00:00+08:00",
        "updated_at": "2026-07-19T12:00:00+08:00",
        "records": records,
    })


def write_ledger(project: Path) -> None:
    write_publication_bundle(project, [
        publication_record("publication_wechat", "wechat", "https://mp.weixin.qq.com/s/client-real", "2026-07-18T12:00:00+08:00"),
        publication_record("publication_xhs", "xiaohongshu", "https://www.xiaohongshu.com/explore/client-real", "2026-07-19T12:00:00+08:00"),
    ])


def write_partial_performance(project: Path) -> None:
    write_json(project, "materials/performance/review-inputs/wechat.json", {
        "review_status": "review-ready",
        "evidence_status": "bound",
        "publish_url": "https://mp.weixin.qq.com/s/client-real",
        "captured_at": "2026-07-20T09:00:00+08:00",
        "performance": {
            "metrics": {"reads": 1200, "likes": 80},
        },
        "comment_samples": ["这篇把我卡住的地方说清楚了。"],
    })


def full_metrics(platform: str) -> dict[str, int]:
    values = {
        "wechat": {"reads": 1200, "likes": 80, "wows": 20, "shares": 12, "comments": 5, "leads": 2},
        "xiaohongshu": {"exposures": 5000, "likes": 200, "collects": 80, "comments": 18, "shares": 20, "leads": 3},
    }
    return values[platform]


def test_queue_contract_digest_matches_typescript_and_excludes_operational_fields() -> None:
    queue = {
        "schema": "aifios.publication-draft-queue.v1",
        "queue_id": "queue_demo",
        "run_id": "run_一",
        "run_slug": "demo",
        "updated_at": "ignored",
        "jobs": [{
            "job_id": "draft_123",
            "platform": "wechat",
            "item_id": "wechat-main",
            "adapter": "authorized_browser",
            "status": "pending",
            "attempt_count": 0,
            "payload": {
                "title": "中文标题",
                "asset_paths": ["pipeline/visual/demo/封面.png"],
                "metadata": {"z": "末", "a": "首"},
            },
            "payload_hash": "b" * 64,
            "content_hash": "a" * 64,
            "selected_asset_hashes": [{
                "path": "pipeline/visual/demo/封面.png",
                "sha256": "c" * 64,
                "role": "cover",
            }],
            "events": [{"status": "pending"}],
        }],
    }
    expected_from_typescript = "d58323de6e49d44004f42401cf6ebd0b44d6c98a46723a0b10ba7fbadac220d0"
    assert weekly_learning_module.draft_queue_contract_sha256(queue) == expected_from_typescript

    operational_update = json.loads(json.dumps(queue, ensure_ascii=False))
    operational_update["updated_at"] = "later"
    operational_update["jobs"][0].update({
        "adapter": "wechat_official_api",
        "authorization_state": "authorized",
        "attempt_count": 99,
        "retry_count": 3,
        "last_attempt_at": NOW,
        "last_error": {"code": "temporary", "message": "ignored"},
        "result_reference": "ignored",
        "external_reference": "ignored",
        "events": [{"status": "published_confirmed"}],
        "status": "published_confirmed",
    })
    assert weekly_learning_module.draft_queue_contract_sha256(operational_update) == expected_from_typescript

    operational_update["jobs"][0]["payload"]["title"] = "被替换的标题"
    assert weekly_learning_module.draft_queue_contract_sha256(operational_update) != expected_from_typescript


def test_weekly_review_waits_for_missing_metrics_then_generates_auditable_report(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    write_partial_performance(tmp_path)

    collected = collect_weekly_review(tmp_path, now=NOW, force=True)

    assert collected["status"] == "waiting_metrics"
    assert collected["reminder"]["should_notify"] is True
    record = collected["record"]
    assert len(record["items"]) == 2
    assert record["run_bindings"] == [{
        "run_id": "client-real-run",
        "run_slug": "client-real",
        "queue_id": "queue_client",
        "source_ledger_path": "materials/publication/ledger/client-real/publication-ledger.json",
    }]
    wechat = next(item for item in record["items"] if item["platform"] == "wechat")
    assert wechat["run_id"] == "client-real-run"
    assert wechat["run_slug"] == "client-real"
    assert wechat["queue_id"] == "queue_client"
    assert wechat["source_ledger_path"] == "materials/publication/ledger/client-real/publication-ledger.json"
    assert wechat["metrics"]["reads"]["source"] == "performance_evidence"
    assert wechat["adopted_visual_assets"] == [{
        "path": VISUAL_PATH,
        "sha256": VISUAL_SHA256,
        "role": "wechat_cover",
    }]
    assert "payload_hash" not in wechat
    assert "queue_path" not in wechat

    with pytest.raises(WeeklyLearningError, match="发布数据没填"):
        complete_weekly_review(tmp_path, record_path=collected["record_path"], now=NOW)

    updates = {
        item["source_record_id"]: {
            "metrics": full_metrics(item["platform"]),
            "comments": [
                "我想知道下一步怎么拆解。",
                "这个案例比泛泛建议更有用。",
                "希望看到具体执行模板。",
                "这里的边界说得很清楚。",
            ],
        }
        for item in record["items"]
    }
    saved = record_manual_metrics(tmp_path, record_path=collected["record_path"], updates=updates, now=NOW)
    assert saved["status"] == "ready"
    assert saved["missing_metrics"] == []

    completed = complete_weekly_review(tmp_path, record_path=collected["record_path"], now=NOW)
    assert completed["status"] == "completed"
    report = (tmp_path / completed["report_path"]).read_text(encoding="utf-8")
    assert "## 1. 表现记录" in report
    assert "https://mp.weixin.qq.com/s/client-real" in report
    assert "pipeline/visual/client-real/publish/r001/cover.png" not in report
    assert "client-real-run / client-real" in report

    with pytest.raises(WeeklyLearningError, match="勾选确认"):
        apply_memory(tmp_path, record_path=collected["record_path"], human_confirmed=False, now=NOW)

    applied = apply_memory(tmp_path, record_path=collected["record_path"], human_confirmed=True, now=NOW)
    assert applied["status"] == "memory_applied"
    assert set(applied["memory_paths"]) == {
        "brain/insights.md",
        "brain/style-evolution.md",
        "brain/case-library.md",
    }
    assert "已确认每周学习" in (tmp_path / "brain" / "insights.md").read_text(encoding="utf-8")


def test_weekly_reminder_is_local_and_only_acknowledged_once(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    collected = collect_weekly_review(tmp_path, now=NOW, force=True)

    acknowledged = acknowledge_reminder(tmp_path, record_path=collected["record_path"], now=NOW)
    assert acknowledged["status"] == "acknowledged"

    status = weekly_status(tmp_path, now=NOW, ensure=True)
    assert status["reminder"]["should_notify"] is False
    assert status["schedule"]["last_notified_week"] == "2026-W30"


def test_weekly_status_creates_the_due_record_without_live_tikomni_fetch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_ledger(tmp_path)

    def fail_if_called(_project: Path, _items: object) -> dict:
        raise AssertionError("status must not start optional live collection")

    monkeypatch.setattr(weekly_learning_module, "collect_tikomni_public_performance", fail_if_called)

    status = weekly_status(tmp_path, now=NOW, ensure=True)

    assert status["status"] == "waiting_metrics"
    assert len(status["record"]["items"]) == 2


def test_weekly_status_revalidates_an_existing_record_before_display(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    collect_weekly_review(tmp_path, now=NOW, force=True)
    ledger_path = tmp_path / "materials/publication/ledger/client-real/publication-ledger.json"
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["records"][0]["payload_hash"] = "9" * 64
    ledger_path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")

    with pytest.raises(WeeklyLearningError, match="内容或 payload 哈希不一致"):
        weekly_status(tmp_path, now=NOW, ensure=False)


def test_weekly_review_rejects_records_not_bound_to_their_ledger_queue(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    ledger_path = tmp_path / "materials/publication/ledger/client-real/publication-ledger.json"
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["records"][0]["queue_id"] = "queue_from_another_run"
    ledger_path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")

    with pytest.raises(WeeklyLearningError, match="无效、重复或未经人工确认"):
        collect_weekly_review(tmp_path, now=NOW, force=True)


def test_weekly_collection_blocks_tampered_queue_contract(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    queue_path = tmp_path / "materials/publication/drafts/client-real/draft-queue.json"
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    queue["jobs"][0]["payload"]["title"] = "tampered after publication"
    queue_path.write_text(json.dumps(queue, ensure_ascii=False, indent=2), encoding="utf-8")

    with pytest.raises(WeeklyLearningError, match="队列契约已变化"):
        collect_weekly_review(tmp_path, now=NOW, force=True)


def test_weekly_collection_rejects_symlinked_queue(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    queue_path = tmp_path / "materials/publication/drafts/client-real/draft-queue.json"
    moved = queue_path.with_name("moved-queue.json")
    queue_path.rename(moved)
    queue_path.symlink_to(moved.name)

    with pytest.raises(WeeklyLearningError, match="普通文件"):
        collect_weekly_review(tmp_path, now=NOW, force=True)


def test_manual_metrics_block_when_selected_asset_changes_after_collection(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    collected = collect_weekly_review(tmp_path, now=NOW, force=True)
    (tmp_path / VISUAL_PATH).write_bytes(b"tampered-cover")
    first = collected["record"]["items"][0]

    with pytest.raises(WeeklyLearningError, match="视觉文件已变化"):
        record_manual_metrics(
            tmp_path,
            record_path=collected["record_path"],
            updates={first["source_record_id"]: {"metrics": full_metrics(first["platform"])}},
            now=NOW,
        )


def test_memory_apply_blocks_when_ledger_hash_changes_after_review(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    collected = collect_weekly_review(tmp_path, now=NOW, force=True)
    updates = {
        item["source_record_id"]: {
            "metrics": full_metrics(item["platform"]),
            "comments": ["真实问题一", "真实问题二", "真实问题三", "真实问题四"],
        }
        for item in collected["record"]["items"]
    }
    record_manual_metrics(tmp_path, record_path=collected["record_path"], updates=updates, now=NOW)
    complete_weekly_review(tmp_path, record_path=collected["record_path"], now=NOW)
    ledger_path = tmp_path / "materials/publication/ledger/client-real/publication-ledger.json"
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["records"][0]["payload_hash"] = "9" * 64
    ledger_path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")

    with pytest.raises(WeeklyLearningError, match="内容或 payload 哈希不一致"):
        apply_memory(tmp_path, record_path=collected["record_path"], human_confirmed=True, now=NOW)


def test_manual_metrics_block_when_local_publication_proof_changes(tmp_path: Path) -> None:
    proof_path = "materials/publish-proof/moments-proof.png"
    proof_bytes = b"operator-confirmed-moments-proof"
    target = tmp_path / proof_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(proof_bytes)
    proof_record = publication_record("publication_moments", "moments", "", "2026-07-19T12:00:00+08:00")
    proof_record.pop("published_url")
    proof_record.update({"proof_path": proof_path, "proof_sha256": hashlib.sha256(proof_bytes).hexdigest()})
    write_publication_bundle(tmp_path, [proof_record])
    collected = collect_weekly_review(tmp_path, now=NOW, force=True)
    target.write_bytes(b"different-proof")
    item = collected["record"]["items"][0]

    with pytest.raises(WeeklyLearningError, match="发布凭证文件已变化"):
        record_manual_metrics(
            tmp_path,
            record_path=collected["record_path"],
            updates={item["source_record_id"]: {"metrics": {metric: 1 for metric in item["required_metrics"]}}},
            now=NOW,
        )


def test_completed_review_is_not_reopened_by_an_unrelated_future_collection(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    collected = collect_weekly_review(tmp_path, now=NOW, force=True)
    updates = {
        item["source_record_id"]: {"metrics": full_metrics(item["platform"]), "comments": [
            "真实问题一", "真实问题二", "真实问题三", "真实问题四",
        ]}
        for item in collected["record"]["items"]
    }
    record_manual_metrics(tmp_path, record_path=collected["record_path"], updates=updates, now=NOW)
    complete_weekly_review(tmp_path, record_path=collected["record_path"], now=NOW)

    next_week = collect_weekly_review(tmp_path, now="2026-07-27T10:00:00+08:00", force=True)
    assert next_week["status"] == "no_publications"
    assert next_week["record"]["items"] == []


def test_weekly_review_collects_public_metrics_from_ledger_urls_through_resolver(tmp_path: Path) -> None:
    write_ledger(tmp_path)

    class FakeBridge:
        def __init__(self) -> None:
            self.requests: list[tuple[str, str, str]] = []

        def credential_status(self) -> dict:
            return {"available": True}

        def resolve_endpoint_options(self, platform: str, capability: str) -> dict:
            return {
                "recommended": {"endpoint_id": f"{platform}.{capability}.fixture"},
                "alternatives": [],
            }

        def endpoint_input_schema(self, _endpoint_id: str) -> dict:
            return {"properties": {"url": {"type": "string"}, "raw": {"type": "boolean"}}, "required": ["url"]}

        def fetch(self, endpoint_id: str, params: dict, platform: str, kind: str, **_kwargs: object) -> dict:
            assert kind == "weekly-performance"
            self.requests.append((platform, endpoint_id, params["url"]))
            relative = f"materials/tikomni/raw/{len(self.requests)}.json"
            payload = {
                "url": params["url"],
                "title": "已确认发布内容",
                **({"read_count": 321, "like_count": 24} if platform == "wechat_mp" else {"play_count": 654, "liked_count": 31}),
            }
            write_json(tmp_path, relative, payload)
            return {"raw_path": relative}

        def payload_for_import(self, raw_path: Path) -> dict:
            return json.loads(raw_path.read_text(encoding="utf-8"))

    bridge = FakeBridge()
    collected = collect_weekly_review(
        tmp_path,
        now=NOW,
        force=True,
        public_performance_collector=lambda project, items: collect_tikomni_public_performance(project, items, bridge=bridge),
    )

    by_platform = {item["platform"]: item for item in collected["record"]["items"]}
    assert by_platform["wechat"]["metrics"]["reads"]["value"] == 321
    assert by_platform["wechat"]["metrics"]["reads"]["source"] == "tikomni_live"
    assert by_platform["xiaohongshu"]["metrics"]["plays"]["value"] == 654
    assert by_platform["wechat"]["public_collection"]["status"] == "available"
    assert {platform for platform, _, _ in bridge.requests} == {"wechat_mp", "xiaohongshu"}
    assert {url for _, _, url in bridge.requests} == {
        "https://mp.weixin.qq.com/s/client-real",
        "https://www.xiaohongshu.com/explore/client-real",
    }


def test_unavailable_tikomni_leaves_weekly_review_for_manual_completion(tmp_path: Path) -> None:
    write_ledger(tmp_path)
    published = [{
        "platform": "wechat",
        "published_url": "https://mp.weixin.qq.com/s/client-real",
    }]

    class UnavailableBridge:
        def credential_status(self) -> dict:
            return {"available": False}

    evidence = collect_tikomni_public_performance(tmp_path, published, bridge=UnavailableBridge())

    assert evidence["https://mp.weixin.qq.com/s/client-real"]["status"] == "unavailable"
    assert evidence["https://mp.weixin.qq.com/s/client-real"]["metrics"] == {}
    assert "手工补录" in evidence["https://mp.weixin.qq.com/s/client-real"]["reason"]


def test_weekly_public_collection_uses_only_one_resolver_endpoint_per_url(tmp_path: Path) -> None:
    published = [{
        "platform": "wechat",
        "published_url": "https://mp.weixin.qq.com/s/client-real",
    }]

    class OneAttemptBridge:
        def __init__(self) -> None:
            self.requests: list[str] = []

        def credential_status(self) -> dict:
            return {"available": True}

        def resolve_endpoint_options(self, _platform: str, _capability: str) -> dict:
            return {
                "recommended": {"endpoint_id": "wechat.primary"},
                "alternatives": [{"endpoint_id": "wechat.fallback"}],
            }

        def endpoint_input_schema(self, _endpoint_id: str) -> dict:
            return {"properties": {"url": {"type": "string"}}, "required": ["url"]}

        def fetch(self, endpoint_id: str, *_args: object, **_kwargs: object) -> dict:
            self.requests.append(endpoint_id)
            raise RuntimeError("fixture endpoint unavailable")

    bridge = OneAttemptBridge()
    evidence = collect_tikomni_public_performance(tmp_path, published, bridge=bridge)

    assert bridge.requests == ["wechat.primary"]
    assert evidence["https://mp.weixin.qq.com/s/client-real"]["status"] == "unavailable"


def test_weekly_review_keeps_a_proof_only_publication_for_manual_metrics(tmp_path: Path) -> None:
    proof_path = "materials/publish-proof/moments-proof.png"
    proof_bytes = b"operator-confirmed-moments-proof"
    target = tmp_path / proof_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(proof_bytes)
    proof_sha256 = hashlib.sha256(proof_bytes).hexdigest()
    proof_record = publication_record("publication_moments", "moments", "", "2026-07-19T12:00:00+08:00")
    proof_record.pop("published_url")
    proof_record.update({"proof_path": proof_path, "proof_sha256": proof_sha256})
    write_publication_bundle(tmp_path, [proof_record])

    collector_inputs: list[dict] = []

    def collector(_project: Path, items: object) -> dict:
        collector_inputs.extend(list(items))
        return {}

    collected = collect_weekly_review(
        tmp_path,
        now=NOW,
        force=True,
        public_performance_collector=collector,
    )
    item = collected["record"]["items"][0]

    assert collected["status"] == "waiting_metrics"
    assert item["published_url"] == ""
    assert item["proof_path"] == proof_path
    assert item["proof_sha256"] == proof_sha256
    assert collector_inputs and collector_inputs[0]["published_url"] == ""

    updates = {
        item["source_record_id"]: {
            "metrics": {metric: 1 for metric in item["required_metrics"]},
            "comments": ["朋友圈里的真实互动需要由操作者手工记录。"],
        },
    }
    saved = record_manual_metrics(tmp_path, record_path=collected["record_path"], updates=updates, now=NOW)
    assert saved["status"] == "ready"
    completed = complete_weekly_review(tmp_path, record_path=collected["record_path"], now=NOW)
    assert proof_path in (tmp_path / completed["report_path"]).read_text(encoding="utf-8")


def test_apply_memory_cli_requires_explicit_human_confirmation(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    write_ledger(tmp_path)
    collected = collect_weekly_review(tmp_path, now=NOW, force=True)
    updates = {
        item["source_record_id"]: {
            "metrics": full_metrics(item["platform"]),
            "comments": ["真实问题一", "真实问题二", "真实问题三", "真实问题四"],
        }
        for item in collected["record"]["items"]
    }
    record_manual_metrics(tmp_path, record_path=collected["record_path"], updates=updates, now=NOW)
    complete_weekly_review(tmp_path, record_path=collected["record_path"], now=NOW)

    blocked = weekly_learning_module.main([
        "--project", str(tmp_path), "--now", NOW,
        "apply-memory", "--record", collected["record_path"],
    ])
    assert blocked == 1
    assert "勾选确认" in capsys.readouterr().err

    accepted = weekly_learning_module.main([
        "--project", str(tmp_path), "--now", NOW,
        "apply-memory", "--record", collected["record_path"], "--human-confirmed",
    ])
    assert accepted == 0
    assert json.loads(capsys.readouterr().out)["status"] == "memory_applied"

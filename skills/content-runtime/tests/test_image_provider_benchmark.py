from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import paid_image_gateway  # noqa: E402
from image_provider_benchmark import BenchmarkError, reserve_operation, score_manifest  # noqa: E402


def _manifest(path: Path, *, estimate: float = 2.0) -> Path:
    payload = {
        "schema_version": "echo-founder.image-provider-benchmark.v1",
        "benchmark_id": "imgbench_test",
        "status": "scored",
        "budget_cny": {
            "hard_limit": 100,
            "round_1": 40,
            "round_2": 25,
            "round_3": 30,
            "retry_reserve": 5,
            "reserved": 0,
            "actual": 0,
        },
        "exchange_rate": None,
        "routes": [
            {
                "route_id": "primary",
                "provider": "openrouter",
                "model_id": "openai/test-image",
                "estimated_cost_cny": estimate,
            },
            {
                "route_id": "backup",
                "provider": "openrouter",
                "model_id": "google/test-image",
                "estimated_cost_cny": estimate,
            },
        ],
        "selection": {
            "top_three": ["primary", "backup", "third"],
            "primary": "primary",
            "backup": "backup",
            "ai_enhanced_default_eligible": True,
        },
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_paid_operation_is_reserved_once_before_dispatch(tmp_path: Path) -> None:
    manifest = _manifest(tmp_path / "benchmark.json")
    request_sha = hashlib.sha256(b"same request").hexdigest()

    first = reserve_operation(manifest, "primary", "round_3", request_sha, 2.0)
    second = reserve_operation(manifest, "primary", "round_3", request_sha, 2.0)

    assert first["operation_id"] == second["operation_id"]
    assert len(list(tmp_path.glob("imgbench_test-operations/*.json"))) == 1
    budget = json.loads(manifest.read_text(encoding="utf-8"))["budget_cny"]
    assert budget["reserved"] == 2.0


def test_paid_operation_enforces_phase_cap_before_network(tmp_path: Path) -> None:
    manifest = _manifest(tmp_path / "benchmark.json")
    for index in range(3):
        reserve_operation(
            manifest,
            "primary",
            "round_3",
            hashlib.sha256(f"request-{index}".encode()).hexdigest(),
            10.0,
        )

    with pytest.raises(BenchmarkError, match="round_3 阶段预算"):
        reserve_operation(
            manifest,
            "backup",
            "round_3",
            hashlib.sha256(b"over cap").hexdigest(),
            0.01,
        )


def test_direct_gateway_persists_paid_generation_evidence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = _manifest(tmp_path / "benchmark.json")
    prompt = tmp_path / "prompt.md"
    prompt.write_text("No text, no number, one editorial concept scene.", encoding="utf-8")
    output = tmp_path / "image.png"
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-secret")
    monkeypatch.setattr(
        paid_image_gateway,
        "_dispatch",
        lambda *_args: {
            "id": "provider-request",
            "data": [{"b64_json": "iVBORw0KGgoAAAANSUhEUg=="}],
        },
    )
    # The gateway validates file signatures, while final dimensions are
    # enforced after deterministic HTML composition.
    result = paid_image_gateway.generate(argparse.Namespace(
        manifest=manifest,
        route_id="primary",
        phase="round_3",
        prompt_file=prompt,
        output=output,
        aspect_ratio="16:9",
        estimated_cost_cny=2.0,
        operation_key="r001:wechat-cover",
    ))

    assert result["ok"] is True
    assert result["operation"]["status"] == "succeeded"
    assert result["operation"]["request_sha256"]
    assert result["operation"]["output_sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    persisted = next(tmp_path.glob("imgbench_test-operations/*.json"))
    assert json.loads(persisted.read_text(encoding="utf-8"))["status"] == "succeeded"
    assert "test-secret" not in persisted.read_text(encoding="utf-8")


def test_runtime_gateway_uses_user_task_ledger_without_consuming_benchmark_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = _manifest(tmp_path / "benchmark.json")
    prompt = tmp_path / "prompt.md"
    prompt.write_text("No text, one editorial concept scene.", encoding="utf-8")
    output = tmp_path / "runtime-image.png"
    ledger = tmp_path / "runtime-ledger"
    monkeypatch.setenv("AIFIOS_IMAGE_RUNTIME_LEDGER_DIR", str(ledger))
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-secret")
    monkeypatch.setattr(
        paid_image_gateway,
        "_dispatch",
        lambda *_args: {"id": "runtime-provider-request", "data": [{"b64_json": "iVBORw0KGgoAAAANSUhEUg=="}]},
    )

    result = paid_image_gateway.generate(argparse.Namespace(
        manifest=manifest,
        route_id="primary",
        phase="round_3",
        prompt_file=prompt,
        output=output,
        aspect_ratio="16:9",
        estimated_cost_cny=2.0,
        operation_key="r002:wechat-cover",
        ledger_scope="runtime",
        runtime_task_key="run-002",
        per_call_limit=5.0,
        per_task_limit=20.0,
    ))

    assert result["ok"] is True
    assert result["operation"]["scope"] == "runtime"
    assert json.loads(manifest.read_text(encoding="utf-8"))["budget_cny"]["reserved"] == 0
    persisted = next(ledger.glob("*/*.json"))
    assert json.loads(persisted.read_text(encoding="utf-8"))["status"] == "succeeded"
    assert "test-secret" not in persisted.read_text(encoding="utf-8")


def test_scoring_chooses_backup_from_a_different_paid_provider(tmp_path: Path) -> None:
    manifest = _manifest(tmp_path / "benchmark.json")
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["routes"] = [
        {**payload["routes"][0], "route_id": "or-primary", "provider": "openrouter"},
        {**payload["routes"][1], "route_id": "or-second", "provider": "openrouter"},
        {**payload["routes"][1], "route_id": "ark-backup", "provider": "ark"},
    ]
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    dimensions = {
        "aesthetics": 90,
        "platform_fit": 90,
        "consistency": 90,
        "prompt_adherence": 90,
        "semantic_match": 90,
        "latency": 90,
        "cost": 90,
    }
    evaluations = tmp_path / "evaluations.json"
    evaluations.write_text(json.dumps({"routes": [
        {"route_id": "or-primary", "dimensions": dimensions, "hard_failures": []},
        {"route_id": "or-second", "dimensions": {**dimensions, "aesthetics": 88}, "hard_failures": []},
        {"route_id": "ark-backup", "dimensions": {**dimensions, "aesthetics": 84}, "hard_failures": []},
    ]}), encoding="utf-8")

    scored = score_manifest(manifest, evaluations)
    assert scored["selection"]["primary"] == "or-primary"
    assert scored["selection"]["backup"] == "ark-backup"

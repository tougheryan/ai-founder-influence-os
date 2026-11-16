from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from image_account_policy import (  # noqa: E402
    ImageAccountPolicyError,
    accepted_route_candidates,
    default_policy,
    effective_credentials,
    load_runtime_route_catalog,
    load_policy,
    reserve_runtime_operation,
    runtime_status,
    runtime_route_candidates,
)


IMAGE_ENVS = [
    "OPENROUTER_API_KEY",
    "REPLICATE_API_TOKEN",
    "ARK_API_KEY",
    "DASHSCOPE_API_KEY",
    "ZAI_API_KEY",
    "MINIMAX_API_KEY",
]


@pytest.fixture(autouse=True)
def clean_image_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in [*IMAGE_ENVS, "AIFIOS_IMAGE_ACCOUNT_IDS", "AIFIOS_IMAGE_ACCOUNT_POLICY", "AIFIOS_DESKTOP_USER_DATA_DIR"]:
        monkeypatch.delenv(name, raising=False)


def _manifest() -> dict:
    return {
        "routes": [
            {"route_id": "or-best", "provider": "openrouter", "model_id": "openai/image", "score": 90, "rank": 1, "hard_failures": [], "estimated_cost_cny": 2},
            {"route_id": "or-second", "provider": "openrouter", "model_id": "google/image", "score": 88, "rank": 2, "hard_failures": [], "estimated_cost_cny": 2},
            {"route_id": "ark-best", "provider": "ark", "model_id": "seedream/image", "score": 84, "rank": 3, "hard_failures": [], "estimated_cost_cny": 1.5},
        ]
    }


def test_zero_one_two_and_three_account_readiness(monkeypatch: pytest.MonkeyPatch) -> None:
    assert runtime_status()["runtime_image_ready"] is False
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret")
    one_account = runtime_status()
    assert one_account["runtime_image_ready"] is True
    assert one_account["runtime_backup_ready"] is False
    monkeypatch.setenv("ARK_API_KEY", "secret")
    assert runtime_status()["runtime_backup_ready"] is True
    monkeypatch.setenv("DASHSCOPE_API_KEY", "secret")
    assert len(runtime_status()["active"]) == 3
    monkeypatch.setenv("ZAI_API_KEY", "internal-lab-only")
    assert len(runtime_status()["active"]) == 3


def test_policy_file_is_required_to_be_regular_and_schema_bound(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    policy_path = tmp_path / "policy.json"
    monkeypatch.setenv("AIFIOS_IMAGE_ACCOUNT_POLICY", str(policy_path))
    assert load_policy() == default_policy()
    policy_path.write_text(json.dumps({"schema_version": "legacy"}), encoding="utf-8")
    with pytest.raises(ImageAccountPolicyError, match="版本"):
        load_policy()


def test_route_selection_prefers_role_provider_and_cross_provider_backup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret")
    monkeypatch.setenv("ARK_API_KEY", "secret")
    policy = {
        **default_policy(),
        "primary_provider": "image_openrouter",
        "backup_provider": "image_ark",
        "first_paid_call_confirmed": True,
    }
    routes = accepted_route_candidates(_manifest(), policy)
    assert [item["route_id"] for item in routes[:2]] == ["or-best", "ark-best"]


def test_one_account_uses_best_route_and_known_failure_has_no_paid_backup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret")
    policy = {**default_policy(), "first_paid_call_confirmed": True}
    routes = accepted_route_candidates(_manifest(), policy)
    assert [item["route_id"] for item in routes] == ["or-best"]
    assert effective_credentials(policy) == ["image_openrouter"]


def test_first_paid_call_must_be_explicitly_confirmed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "secret")
    with pytest.raises(ImageAccountPolicyError, match="首次付费"):
        accepted_route_candidates(_manifest(), default_policy())


def test_bundled_ark_route_is_available_without_internal_benchmark(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARK_API_KEY", "secret")
    catalog = load_runtime_route_catalog()
    policy = {
        **default_policy(),
        "preset": "custom",
        "backup_provider": "image_ark",
        "first_paid_call_confirmed": True,
    }

    routes = runtime_route_candidates(catalog, policy)

    assert [item["route_id"] for item in routes] == ["runtime-ark-seedream-5"]
    assert routes[0]["model_id"] == "doubao-seedream-5-0-260128"


def test_bundled_runtime_route_still_requires_explicit_budget_confirmation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARK_API_KEY", "secret")
    with pytest.raises(ImageAccountPolicyError, match="首次付费"):
        runtime_route_candidates(load_runtime_route_catalog(), default_policy())


def test_runtime_ledger_is_idempotent_and_enforces_the_task_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ledger = tmp_path / "runtime-ledger"
    monkeypatch.setenv("AIFIOS_IMAGE_RUNTIME_LEDGER_DIR", str(ledger))
    request_sha = "a" * 64
    common = {
        "benchmark_id": "imgbench_test",
        "route_id": "primary",
        "operation_key": "r001:wechat-cover",
        "task_key": "run-001",
        "estimated_cost_cny": 2.0,
        "per_call_limit": 3.0,
        "per_task_limit": 3.0,
    }

    first = reserve_runtime_operation(request_sha256=request_sha, **common)
    repeated = reserve_runtime_operation(request_sha256=request_sha, **common)

    assert first["operation_id"] == repeated["operation_id"]
    records = list(ledger.glob("*/*.json"))
    assert len(records) == 1
    assert records[0].stat().st_mode & 0o777 == 0o600
    with pytest.raises(ImageAccountPolicyError, match="本任务付费预算"):
        reserve_runtime_operation(
            request_sha256="b" * 64,
            **{**common, "operation_key": "r001:xhs-p1"},
        )


def test_runtime_ledger_is_separate_from_internal_benchmark_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ledger = tmp_path / "runtime-ledger"
    monkeypatch.setenv("AIFIOS_IMAGE_RUNTIME_LEDGER_DIR", str(ledger))

    operation = reserve_runtime_operation(
        benchmark_id="imgbench_frozen",
        route_id="primary",
        request_sha256="c" * 64,
        operation_key="r002:xhs-p1",
        task_key="run-002",
        estimated_cost_cny=1.5,
        per_call_limit=5.0,
        per_task_limit=20.0,
    )

    assert operation["scope"] == "runtime"
    assert operation["benchmark_id"] == "imgbench_frozen"
    assert not list(tmp_path.glob("imgbench_frozen-operations/*.json"))

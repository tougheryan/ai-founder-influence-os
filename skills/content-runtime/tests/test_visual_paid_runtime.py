from __future__ import annotations

import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from image_account_policy import default_policy  # noqa: E402
from visual_publish import _paid_runtime_context  # noqa: E402


def test_paid_runtime_uses_bundled_ark_route_without_internal_benchmark(
    tmp_path: Path,
    monkeypatch,
) -> None:
    policy = {
        **default_policy(),
        "preset": "custom",
        "backup_provider": "image_ark",
        "first_paid_call_confirmed": True,
    }
    (tmp_path / "image-account-policy.json").write_text(
        json.dumps(policy, ensure_ascii=False),
        encoding="utf-8",
    )
    monkeypatch.setenv("AIFIOS_DESKTOP_USER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AIFIOS_IMAGE_ACCOUNT_IDS", "image_ark")
    monkeypatch.delenv("AIFIOS_IMAGE_BENCHMARK_MANIFEST", raising=False)
    monkeypatch.delenv("AIFIOS_IMAGE_RUNTIME_ROUTE_CATALOG", raising=False)

    context = _paid_runtime_context()

    assert context["route_source"] == "bundled_runtime_catalog"
    assert context["manifest"]["schema_version"] == "echo-founder.runtime-image-route-catalog.v1"
    assert [route["route_id"] for route in context["routes"]] == ["runtime-ark-seedream-5"]
    assert context["routes"][0]["model_id"] == "doubao-seedream-5-0-260128"

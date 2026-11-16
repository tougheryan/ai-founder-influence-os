from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from delivery_audit import superseded_dbs_fusion_target_paths


class RuntimeStub:
    def __init__(self, *, confirmed: bool = True) -> None:
        self.confirmed = confirmed

    def read(self, step: str, file: str) -> dict[str, object]:
        assert step == "blueprint"
        assert file == "pipeline/blueprint/current.md"
        return {
            "frontmatter": {
                "slug": "matrix",
                "created_at": "2026-07-13T14:04:03",
            },
            "body": "# Confirmed blueprint",
        }

    def validate(self, step: str, file: str) -> dict[str, object]:
        assert step == "blueprint"
        assert file == "pipeline/blueprint/current.md"
        return {
            "valid": True,
        }

    def blueprint_approval_status(self, file: str, run_id: str | None = None) -> dict[str, object]:
        assert file == "pipeline/blueprint/current.md"
        assert run_id == "matrix-run"
        return {"approved": self.confirmed}


def run_state() -> dict[str, object]:
    return {
        "run_id": "matrix-run",
        "slug": "matrix",
        "steps": {
            "blueprint": {
                "latest": "pipeline/blueprint/current.md",
                "updated_at": "2026-07-13T14:04:03",
            },
        },
        "history": [
            {
                "step": "breakdown",
                "path": "pipeline/breakdown/old.md",
                "created_at": "2026-07-13T11:11:48",
            },
            {
                "step": "blueprint",
                "path": "pipeline/blueprint/old.md",
                "created_at": "2026-07-13T11:13:16",
            },
            {
                "step": "blueprint",
                "path": "pipeline/blueprint/current.md",
                "created_at": "2026-07-13T14:04:03",
            },
        ],
    }


def fusion_body(downstream: str = "/content-blueprint and /content-write") -> str:
    return f"""## 4. 写回计划

| target | content | downstream | state |
|---|---|---|---|
| pipeline/breakdown/old.md | historical title ideas | {downstream} | review |
| pipeline/blueprint/old.md | historical title ideas | {downstream} | review |
"""


def test_confirmed_newer_blueprint_supersedes_only_historical_planning_targets() -> None:
    result = superseded_dbs_fusion_target_paths(
        RuntimeStub(),
        run_state(),
        "2026-07-13T13:49:46",
        fusion_body(),
    )

    assert result == {
        "pipeline/breakdown/old.md",
        "pipeline/blueprint/old.md",
    }


def test_unconfirmed_blueprint_does_not_supersede_historical_dbs_writebacks() -> None:
    result = superseded_dbs_fusion_target_paths(
        RuntimeStub(confirmed=False),
        run_state(),
        "2026-07-13T13:49:46",
        fusion_body(),
    )

    assert result == set()


def test_non_planning_downstream_is_not_silently_superseded() -> None:
    result = superseded_dbs_fusion_target_paths(
        RuntimeStub(),
        run_state(),
        "2026-07-13T13:49:46",
        fusion_body("/content-visual"),
    )

    assert result == set()

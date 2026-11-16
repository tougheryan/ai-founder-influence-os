#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from generated_language_quality import inspect_generated_language  # noqa: E402


def test_blocks_meta_paths_secrets_placeholders_and_raw_exceptions() -> None:
    text = "\n".join([
        "作为一个 AI，我来回答。",
        "文件在 /home/alice/private.md",
        "API Key: sk-private-secret",
        "正文 {{客户案例}}",
        "TypeError: failed\n    at run (app.py:1)",
    ])
    review = inspect_generated_language(text)

    assert review["status"] == "blocked"
    assert {item["code"] for item in review["blocking"]} == {
        "assistant_identity",
        "local_path",
        "secret_like_value",
        "template_placeholder",
        "raw_exception",
    }


def test_warns_without_rewriting_or_blocking_machine_fields() -> None:
    source = "schema: aifios.example.v1\n综上所述，需要持续优化并形成闭环。"
    review = inspect_generated_language(source, "综上所述，需要持续优化并形成闭环。")

    assert review["status"] == "review_required"
    assert review["blocking"] == []
    assert {item["code"] for item in review["warnings"]} == {
        "formulaic_conclusion",
        "abstract_phrase_density",
    }

"""Unit tests must not silently spend a configured customer's service balance."""
from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def offline_layout_service(monkeypatch, tmp_path):
    # Tests may replace this with an explicit local fake. A live CLI/API run is
    # opt-in because --mode api can consume an independently configured account.
    if os.environ.get("ECHO_LIVE_MD2WECHAT_TEST") != "1":
        monkeypatch.setenv("MD2WECHAT_BINARY", str(tmp_path / "no-external-md2wechat"))


@pytest.fixture
def fake_tikomni_skill(monkeypatch, tmp_path):
    """Presence fixture for mocked adapter tests; never an API implementation."""
    root = tmp_path / "synthetic-tikomni-connector"
    caller = root / "scripts" / "core" / "call_tikomni_api.py"
    caller.parent.mkdir(parents=True)
    caller.write_text("raise RuntimeError('synthetic test connector must never execute')\n", encoding="utf-8")
    monkeypatch.setenv("TIKOMNI_SOCIAL_MEDIA_CRAWL_DIR", str(root))
    return root

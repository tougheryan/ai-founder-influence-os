from __future__ import annotations

import sys
import urllib.error
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from wechat_official_api import (  # noqa: E402
    WechatOfficialApiError,
    WechatOfficialClient,
    WechatOfficialConfig,
    default_transport,
)


def test_wechat_access_token_is_memory_only_and_legacy_cache_is_removed(tmp_path: Path) -> None:
    legacy_cache = (
        tmp_path
        / "materials"
        / "performance"
        / "auth-cache"
        / "wechat-official-token.json"
    )
    legacy_cache.parent.mkdir(parents=True)
    legacy_cache.write_text('{"access_token":"legacy-secret","expires_at":4102444800}\n')
    calls: list[str] = []

    def transport(method: str, url: str, payload: dict | None, timeout: int) -> dict:
        calls.append(url)
        return {"access_token": "fresh-secret", "expires_in": 7200}

    client = WechatOfficialClient(
        tmp_path,
        WechatOfficialConfig(app_id="app-id", app_secret="app-secret"),
        transport=transport,
    )

    assert not legacy_cache.exists()
    assert client.access_token() == "fresh-secret"
    assert client.access_token() == "fresh-secret"
    assert len(calls) == 1
    assert not legacy_cache.exists()
    assert not list(tmp_path.rglob("*token*.json"))


def test_default_transport_never_exposes_secret_query_urls(monkeypatch) -> None:
    def fail(*_args, **_kwargs):
        raise urllib.error.URLError("https://api.weixin.qq.com/token?secret=must-not-leak")

    monkeypatch.setattr("urllib.request.urlopen", fail)
    try:
        default_transport("GET", "https://api.weixin.qq.com/token?secret=must-not-leak", None, 1)
    except WechatOfficialApiError as exc:
        assert "must-not-leak" not in str(exc)
        assert "https://" not in str(exc)
    else:
        raise AssertionError("transport failure must be reported")

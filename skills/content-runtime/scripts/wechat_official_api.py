#!/usr/bin/env python3
"""Official WeChat OA API client for authorized AIFIOS performance collection."""
from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional


WECHAT_API_BASE = "https://api.weixin.qq.com"


class WechatOfficialApiError(RuntimeError):
    def __init__(self, message: str, *, errcode: int | None = None, response: dict[str, Any] | None = None):
        super().__init__(message)
        self.errcode = errcode
        self.response = response or {}


Transport = Callable[[str, str, Optional[dict[str, Any]], int], dict[str, Any]]


def default_transport(method: str, url: str, payload: dict[str, Any] | None, timeout: int) -> dict[str, Any]:
    data = None
    headers = {"User-Agent": "AIFIOS-WeChat-Performance/1.0"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raise WechatOfficialApiError(f"WeChat transport returned HTTP {exc.code}.") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        # The token endpoint carries app_secret in its query string. Never
        # propagate urllib exception objects because they may retain the URL.
        raise WechatOfficialApiError("WeChat transport could not reach the authorized API.") from None
    return json.loads(body)


@dataclass(frozen=True)
class WechatOfficialConfig:
    app_id: str
    app_secret: str
    account_id: str = "self-account"


class WechatOfficialClient:
    def __init__(
        self,
        project: Path,
        config: WechatOfficialConfig,
        *,
        transport: Transport = default_transport,
        timeout: int = 15,
    ):
        self.project = Path(project).expanduser().resolve(strict=False)
        self.config = config
        self.transport = transport
        self.timeout = timeout
        self._cached_access_token = ""
        self._cached_expires_at = 0
        # Older builds persisted this bearer token inside the project. A bearer
        # token is a credential, so it must neither live in project data nor be
        # copied by backup/restore. Discard the short-lived legacy cache and use
        # process memory for the lifetime of this collector instead.
        self.legacy_cache_path = (
            self.project
            / "materials"
            / "performance"
            / "auth-cache"
            / "wechat-official-token.json"
        )
        self._discard_legacy_cache()

    @classmethod
    def from_env(
        cls,
        project: Path | str,
        *,
        transport: Transport = default_transport,
        timeout: int = 15,
    ) -> "WechatOfficialClient":
        app_id = os.environ.get("AIFIOS_WECHAT_OFFICIAL_APP_ID", "").strip()
        app_secret = os.environ.get("AIFIOS_WECHAT_OFFICIAL_APP_SECRET", "").strip()
        account_id = os.environ.get("AIFIOS_WECHAT_OFFICIAL_ACCOUNT_ID", "self-account").strip() or "self-account"
        if not app_id:
            raise WechatOfficialApiError("Missing AIFIOS_WECHAT_OFFICIAL_APP_ID")
        if not app_secret:
            raise WechatOfficialApiError("Missing AIFIOS_WECHAT_OFFICIAL_APP_SECRET")
        return cls(
            Path(project),
            WechatOfficialConfig(app_id=app_id, app_secret=app_secret, account_id=account_id),
            transport=transport,
            timeout=timeout,
        )

    def _read_cached_token(self) -> str:
        if self._cached_expires_at <= int(time.time()) + 120:
            return ""
        return self._cached_access_token

    def _write_cached_token(self, access_token: str, expires_in: int) -> None:
        self._cached_access_token = access_token
        self._cached_expires_at = int(time.time()) + max(int(expires_in) - 300, 60)

    def _discard_legacy_cache(self) -> None:
        try:
            self.legacy_cache_path.unlink(missing_ok=True)
            cache_dir = self.legacy_cache_path.parent
            if cache_dir.exists() and not any(cache_dir.iterdir()):
                cache_dir.rmdir()
        except OSError as exc:
            raise WechatOfficialApiError(
                "Cannot remove the legacy plaintext WeChat token cache; "
                "fix project permissions before collecting performance data."
            ) from exc

    def access_token(self) -> str:
        cached = self._read_cached_token()
        if cached:
            return cached
        query = urllib.parse.urlencode(
            {
                "grant_type": "client_credential",
                "appid": self.config.app_id,
                "secret": self.config.app_secret,
            }
        )
        response = self.transport("GET", f"{WECHAT_API_BASE}/cgi-bin/token?{query}", None, self.timeout)
        self._raise_for_wechat_error(response)
        token = str(response.get("access_token") or "")
        if not token:
            raise WechatOfficialApiError("WeChat token response did not include access_token", response=response)
        self._write_cached_token(token, int(response.get("expires_in", 7200)))
        return token

    def post_json(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        token = self.access_token()
        separator = "&" if "?" in endpoint else "?"
        url = f"{WECHAT_API_BASE}{endpoint}{separator}access_token={urllib.parse.quote(token)}"
        response = self.transport("POST", url, payload, self.timeout)
        self._raise_for_wechat_error(response)
        return response

    def batchget_freepublish(self, offset: int = 0, count: int = 20, no_content: int = 0) -> dict[str, Any]:
        return self.post_json("/cgi-bin/freepublish/batchget", {"offset": offset, "count": count, "no_content": no_content})

    def get_article(self, article_id: str) -> dict[str, Any]:
        return self.post_json("/cgi-bin/freepublish/getarticle", {"article_id": article_id})

    def get_article_summary(self, date: str) -> dict[str, Any]:
        return self.post_json("/datacube/getarticlesummary", {"begin_date": date, "end_date": date})

    def get_article_total(self, date: str) -> dict[str, Any]:
        return self.post_json("/datacube/getarticletotal", {"begin_date": date, "end_date": date})

    def list_comments(
        self,
        msg_data_id: str,
        *,
        index: int = 0,
        begin: int = 0,
        count: int = 50,
        comment_type: int = 0,
    ) -> dict[str, Any]:
        return self.post_json(
            "/cgi-bin/comment/list",
            {
                "msg_data_id": msg_data_id,
                "index": index,
                "begin": begin,
                "count": count,
                "type": comment_type,
            },
        )

    @staticmethod
    def _raise_for_wechat_error(response: dict[str, Any]) -> None:
        errcode = response.get("errcode")
        if errcode not in (None, 0, "0"):
            errmsg = str(response.get("errmsg") or "WeChat API error")
            raise WechatOfficialApiError(
                f"WeChat API error {errcode}: {errmsg}",
                errcode=int(errcode),
                response=response,
            )

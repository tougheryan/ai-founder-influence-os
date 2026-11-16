#!/usr/bin/env python3
"""Collect project-isolated, public TikOmni evidence for benchmark accounts.

The advisor never treats a hand-entered account description as fetched market
evidence. Every available profile/work record is fetched through TikOmni's
resolver, copied into the selected project archive, normalized without source
copy, and linked back to its public URL and capture time. Unsupported account
identifiers and unavailable API contracts stay explicit instead of falling
back to a guessed endpoint or an LLM-generated account profile.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import SplitResult, urlsplit

from tikomni_adapter import (
    TikomniApiBridge,
    clean_text,
    first_non_empty,
    infer_hook,
    infer_metrics,
    normalize_tikomni_platform,
    normalized_items,
)


PROJECT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
ACCOUNT_ID_RE = re.compile(r"^benchmark_[a-f0-9]{12,32}$")
PUBLIC_URL_RE = re.compile(r"^https?://", re.IGNORECASE)
XIAOHONGSHU_NOTE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
DIRECT_MEDIA_URL_RE = re.compile(
    r"\.(?:mp4|m4v|webm|mov|m3u8|mp3|m4a|aac|wav|ogg|oga|opus|flac)(?:[?#].*)?$",
    re.IGNORECASE,
)
MAX_ACCOUNTS = 5
MAX_WORKS_PER_ACCOUNT = 3
SUPPORTED_PLATFORMS = {"wechat_mp", "xiaohongshu", "wechat_channels"}
ADVISOR_ROOT = "materials/advisors/benchmark"
MAX_COVER_BYTES = 8 * 1024 * 1024
COVER_TIMEOUT_SECONDS = 8
COVER_READ_CHUNK_BYTES = 64 * 1024
IMAGE_CONTENT_TYPES = {
    "image/jpeg": ("image/jpeg", ".jpg"),
    "image/jpg": ("image/jpeg", ".jpg"),
    "image/png": ("image/png", ".png"),
    "image/apng": ("image/png", ".png"),
    "image/webp": ("image/webp", ".webp"),
    "image/gif": ("image/gif", ".gif"),
    "image/avif": ("image/avif", ".avif"),
}
ALLOWED_COVER_HOST_SUFFIXES = (
    "xiaohongshu.com",
    "xhscdn.com",
    "xhscdn.net",
    "rednotecdn.com",
    "douyin.com",
    "douyinvod.com",
    "byteimg.com",
    "bytegoofy.com",
    "qq.com",
    "qpic.cn",
    "weixin.qq.com",
    "wx.qq.com",
)


class BenchmarkAdvisorCollectionError(ValueError):
    """Expected local contract or public-evidence failure."""


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def safe_project_id(value: Any) -> str:
    project_id = str(value or "").strip().lower()
    if not PROJECT_ID_RE.fullmatch(project_id):
        raise BenchmarkAdvisorCollectionError("项目 ID 必须是 1-64 位小写字母、数字、连字符或下划线。")
    return project_id


def safe_relative_path(value: str) -> str:
    path = str(value or "").strip().replace("\\", "/")
    if not path or path.startswith("/") or "\x00" in path:
        raise BenchmarkAdvisorCollectionError("路径必须是项目内相对路径。")
    if any(part in {"", ".", ".."} for part in path.split("/")):
        raise BenchmarkAdvisorCollectionError("路径不允许越出项目目录。")
    return path


def project_path(root: Path, relative: str) -> Path:
    candidate = (root / safe_relative_path(relative)).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise BenchmarkAdvisorCollectionError("路径不在当前项目内。") from exc
    return candidate


def relative_to_project(root: Path, path: Path) -> str:
    return path.resolve(strict=False).relative_to(root).as_posix()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """Connect to a DNS-validated address while retaining the public Host header."""

    def __init__(self, hostname: str, port: int, address: str, timeout: float):
        super().__init__(hostname, port=port, timeout=timeout)
        self._pinned_address = address

    def connect(self) -> None:
        self.sock = self._create_connection((self._pinned_address, self.port), self.timeout, self.source_address)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """TLS variant of the pinned public-address connection."""

    def __init__(self, hostname: str, port: int, address: str, timeout: float):
        super().__init__(hostname, port=port, timeout=timeout, context=ssl.create_default_context())
        self._pinned_address = address

    def connect(self) -> None:
        self.sock = self._create_connection((self._pinned_address, self.port), self.timeout, self.source_address)
        if self._tunnel_host:
            self._tunnel()
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


def cover_url_parts(value: str) -> tuple[SplitResult, str, int]:
    try:
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower()
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise BenchmarkAdvisorCollectionError("公开封面地址格式无效。") from exc
    if parsed.scheme.lower() not in {"http", "https"}:
        raise BenchmarkAdvisorCollectionError("公开封面仅支持 HTTP 或 HTTPS。")
    if not hostname or parsed.username or parsed.password:
        raise BenchmarkAdvisorCollectionError("公开封面地址不能包含本机或账号信息。")
    if parsed.port is not None and parsed.port not in {80, 443}:
        raise BenchmarkAdvisorCollectionError("公开封面地址只能使用标准 Web 端口。")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise BenchmarkAdvisorCollectionError("公开封面地址不能使用 IP、本机或私有网络。")
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        raise BenchmarkAdvisorCollectionError("公开封面地址不能使用 IP、本机或私有网络。")
    if not any(hostname == suffix or hostname.endswith(f".{suffix}") for suffix in ALLOWED_COVER_HOST_SUFFIXES):
        raise BenchmarkAdvisorCollectionError("公开封面地址不属于已允许的平台图片域名。")
    return parsed, hostname, port


def is_global_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global


def resolve_global_address(hostname: str, port: int) -> str:
    try:
        candidates = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise BenchmarkAdvisorCollectionError("公开封面地址暂时无法解析。") from exc
    for _family, _socktype, _proto, _canonname, sockaddr in candidates:
        address = str(sockaddr[0])
        if is_global_address(address):
            return address
    raise BenchmarkAdvisorCollectionError("公开封面地址不能解析到本机或私有网络。")


def canonical_cover_content_type(value: str) -> tuple[str, str]:
    media_type = str(value or "").split(";", 1)[0].strip().lower()
    resolved = IMAGE_CONTENT_TYPES.get(media_type)
    if not resolved:
        raise BenchmarkAdvisorCollectionError("公开封面响应不是可归档的图片。")
    return resolved


def cover_bytes_match_content_type(payload: bytes, content_type: str) -> bool:
    if content_type == "image/jpeg":
        return payload.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return payload.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/webp":
        return len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP"
    if content_type == "image/gif":
        return payload.startswith((b"GIF87a", b"GIF89a"))
    if content_type == "image/avif":
        return len(payload) >= 16 and payload[4:8] == b"ftyp" and any(brand in payload[8:32] for brand in (b"avif", b"avis"))
    return False


def download_public_cover(url: str) -> tuple[bytes, str]:
    """Fetch one source-provided cover without redirects or local-network access."""
    parsed, hostname, port = cover_url_parts(url)
    address = resolve_global_address(hostname, port)
    connection: http.client.HTTPConnection
    if parsed.scheme.lower() == "https":
        connection = _PinnedHTTPSConnection(hostname, port, address, COVER_TIMEOUT_SECONDS)
    else:
        connection = _PinnedHTTPConnection(hostname, port, address, COVER_TIMEOUT_SECONDS)
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    host_header = hostname if (parsed.scheme.lower() == "https" and port == 443) or (parsed.scheme.lower() == "http" and port == 80) else f"{hostname}:{port}"
    try:
        connection.request("GET", target, headers={
            "Accept": "image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.1",
            "Accept-Encoding": "identity",
            "Host": host_header,
            "User-Agent": "AIFIOS benchmark cover archive/1.0",
        })
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise BenchmarkAdvisorCollectionError("公开封面地址发生跳转，未归档。")
        if response.status < 200 or response.status >= 300:
            raise BenchmarkAdvisorCollectionError(f"公开封面暂时无法读取（{response.status}）。")
        encoding = str(response.getheader("Content-Encoding") or "").strip().lower()
        if encoding not in {"", "identity"}:
            raise BenchmarkAdvisorCollectionError("公开封面使用了不支持的压缩编码。")
        content_type, _extension = canonical_cover_content_type(response.getheader("Content-Type") or "")
        length_header = response.getheader("Content-Length")
        if length_header:
            try:
                content_length = int(length_header)
            except ValueError as exc:
                raise BenchmarkAdvisorCollectionError("公开封面长度格式无效。") from exc
            if content_length < 0 or content_length > MAX_COVER_BYTES:
                raise BenchmarkAdvisorCollectionError("公开封面图片过大，未归档。")
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = response.read(COVER_READ_CHUNK_BYTES)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_COVER_BYTES:
                raise BenchmarkAdvisorCollectionError("公开封面图片过大，未归档。")
            chunks.append(chunk)
        payload = b"".join(chunks)
    except BenchmarkAdvisorCollectionError:
        raise
    except (OSError, socket.timeout, ssl.SSLError, http.client.HTTPException) as exc:
        raise BenchmarkAdvisorCollectionError("公开封面暂时无法下载。") from exc
    finally:
        connection.close()
    if not payload or not cover_bytes_match_content_type(payload, content_type):
        raise BenchmarkAdvisorCollectionError("公开封面图片内容校验失败，未归档。")
    return payload, content_type


def write_immutable_cover(project: Path, media_root: Path, payload: bytes, content_type: str) -> str:
    _canonical_type, extension = canonical_cover_content_type(content_type)
    digest = hashlib.sha256(payload).hexdigest()
    media_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = media_root / f"{digest}{extension}"
    if target.exists():
        if target.is_symlink() or not target.is_file() or sha256_file(target) != digest:
            raise BenchmarkAdvisorCollectionError("本地封面归档冲突，未使用该封面。")
        return relative_to_project(project, target)
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if target.is_symlink() or not target.is_file() or sha256_file(target) != digest:
            raise BenchmarkAdvisorCollectionError("本地封面归档冲突，未使用该封面。")
        return relative_to_project(project, target)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
    except Exception:
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return relative_to_project(project, target)


def archive_cover_image(project: Path, media_root: Path, source_url: str) -> dict[str, str]:
    """Return local cover provenance only when an actual image was archived."""
    if not source_url:
        return {"cover_path": "", "cover_content_type": ""}
    try:
        payload, content_type = download_public_cover(source_url)
        return {
            "cover_path": write_immutable_cover(project, media_root, payload, content_type),
            "cover_content_type": content_type,
        }
    except (BenchmarkAdvisorCollectionError, OSError):
        # The TikOmni work metadata remains usable. A failed local cache must
        # never invent a path or replace the source-provided public URL.
        return {"cover_path": "", "cover_content_type": ""}


def archive_work_covers(
    project: Path,
    scoped_root: Path,
    snapshot_id: str,
    account_id: str,
    works: list[dict[str, Any]],
) -> None:
    media_root = scoped_root / "media" / snapshot_id / account_id
    cover_urls = list(dict.fromkeys(str(work.get("cover_image") or "") for work in works if work.get("cover_image")))
    if not cover_urls:
        return
    # Covers are an optional local preview. Fetch the small, capped set in
    # parallel so a slow CDN does not serialize the account research task.
    with ThreadPoolExecutor(max_workers=min(MAX_WORKS_PER_ACCOUNT, len(cover_urls))) as executor:
        archived = list(executor.map(lambda url: archive_cover_image(project, media_root, url), cover_urls))
    provenance_by_url = dict(zip(cover_urls, archived))
    for work in works:
        work.update(provenance_by_url.get(str(work.get("cover_image") or ""), {"cover_path": "", "cover_content_type": ""}))


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def write_new_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    encoded = canonical_bytes(payload)
    try:
        with path.open("xb") as handle:
            handle.write(encoded)
    except FileExistsError as exc:
        raise BenchmarkAdvisorCollectionError("对标证据快照 ID 冲突，请重新刷新。") from exc


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BenchmarkAdvisorCollectionError("TikOmni 原始证据不可读取。") from exc
    if not isinstance(value, dict):
        raise BenchmarkAdvisorCollectionError("TikOmni 原始证据格式无效。")
    return value


def safe_url(value: Any, label: str) -> str:
    url = str(value or "").strip()
    if not PUBLIC_URL_RE.match(url):
        raise BenchmarkAdvisorCollectionError(f"{label}必须是公开 http 或 https 链接。")
    return url[:500]


def normalize_account(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise BenchmarkAdvisorCollectionError("对标账号格式无效。")
    account_id = str(raw.get("id") or "").strip()
    platform = str(raw.get("platform") or "").strip()
    public_url = safe_url(raw.get("publicUrl"), "公开账号链接")
    handle = str(raw.get("handle") or "").strip()
    label = clean_text(str(raw.get("label") or ""))[:80]
    if not ACCOUNT_ID_RE.fullmatch(account_id):
        raise BenchmarkAdvisorCollectionError("对标账号 ID 无效。")
    if platform not in SUPPORTED_PLATFORMS:
        raise BenchmarkAdvisorCollectionError("对标账号平台只支持公众号、小红书或视频号。")
    if not handle:
        raise BenchmarkAdvisorCollectionError("对标账号必须填写平台公开 ID。")
    return {
        "id": account_id,
        "platform": platform,
        "public_url": public_url,
        "handle": handle[:160],
        "label": label or account_id,
    }


def account_root(project_id: str) -> str:
    return f"{ADVISOR_ROOT}/{project_id}"


def account_values(account: dict[str, str]) -> dict[str, Any]:
    values: dict[str, Any] = {
        "share_link": account["public_url"],
        "share_text": account["public_url"],
        "user_id": account["handle"],
        "username": account["handle"],
        "ghid": account["handle"],
        "url": account["public_url"],
        "raw": False,
    }
    if account["platform"] == "wechat_mp":
        if not account["handle"].lower().startswith("gh_"):
            raise BenchmarkAdvisorCollectionError("公众号公开 ID 必须是 TikOmni 可验证的 ghid（以 gh_ 开头）。")
    if account["platform"] == "wechat_channels" and "@finder" not in account["handle"].lower():
        raise BenchmarkAdvisorCollectionError("视频号公开 ID 必须是 TikOmni 可验证的 finder username（以 @finder 结尾）。")
    return values


def endpoint_candidates(bridge: TikomniApiBridge, platform: str, capability: str) -> list[dict[str, Any]]:
    resolved = bridge.resolve_endpoint_options(platform, capability)
    recommended = resolved.get("recommended") if isinstance(resolved.get("recommended"), dict) else {}
    alternatives = resolved.get("alternatives") if isinstance(resolved.get("alternatives"), list) else []
    candidates = [recommended, *(item for item in alternatives if isinstance(item, dict))]
    return [item for item in candidates if isinstance(item.get("endpoint_id"), str) and item["endpoint_id"]]


def params_for_candidate(schema: dict[str, Any], values: dict[str, Any]) -> dict[str, Any] | None:
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    required = set(schema.get("required") or []) if isinstance(schema.get("required"), list) else set()
    params = {
        name: values[name]
        for name in properties
        if name in values and values[name] not in (None, "")
    }
    if not required.issubset(params):
        return None
    identity_keys = {"share_link", "share_text", "user_id", "username", "ghid", "url"}
    # Avoid an endpoint which accepts no account identity (for example a global
    # inspiration feed) even when the catalog lists it as "recommended".
    if not identity_keys.intersection(params):
        return None
    return params


def fetch_resolved_public_object(
    bridge: TikomniApiBridge,
    project: Path,
    scoped_root: Path,
    account: dict[str, str],
    *,
    capability: str,
    kind: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    values = account_values(account)
    failures: list[str] = []
    for candidate in endpoint_candidates(bridge, account["platform"], capability):
        endpoint_id = str(candidate["endpoint_id"])
        try:
            schema = bridge.endpoint_input_schema(endpoint_id)
            params = params_for_candidate(schema, values)
        except Exception as exc:
            failures.append(f"{endpoint_id}: {exc}")
            continue
        if params is None:
            continue
        try:
            fetched = bridge.fetch(endpoint_id, params, account["platform"], kind="benchmark-advisor")
            raw_relative = str(fetched.get("raw_path") or "")
            raw_source = project_path(project, raw_relative)
            if raw_source.is_symlink() or not raw_source.is_file():
                raise BenchmarkAdvisorCollectionError("TikOmni 未保存可审计的原始公开证据。")
            stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
            raw_target = scoped_root / "raw" / account["id"] / f"{stamp}-{kind}-{uuid.uuid4().hex[:8]}.json"
            raw_target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copyfile(raw_source, raw_target)
            raw_payload = read_json(raw_target)
            payload = raw_payload.get("data") if isinstance(raw_payload.get("data"), dict) else raw_payload
            return payload, {
                "kind": kind,
                "endpoint_id": endpoint_id,
                "path": relative_to_project(project, raw_target),
                "sha256": sha256_file(raw_target),
                "captured_at": now(),
            }
        except Exception as exc:
            failures.append(f"{endpoint_id}: {exc}")
    detail = "; ".join(failures[:3]) or "当前 TikOmni catalog 没有可用的账户标识参数。"
    raise BenchmarkAdvisorCollectionError(f"{capability} 无法取得可验证公开证据：{detail}")


def recursive_text(value: Any) -> str:
    if isinstance(value, dict):
        return " ".join(recursive_text(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(recursive_text(item) for item in value)
    return clean_text(str(value or ""))


def item_source_url(item: dict[str, Any], platform: str) -> str:
    for value in (item.get("source_url"), item.get("share_url"), item.get("url"), item.get("link"), item.get("doc_url")):
        hit = nested_public_url(value)
        if hit:
            return hit
    # TikOmni's RedNote account feed returns the public note ID but not always
    # its public page URL. This is the platform's canonical public form; only
    # use it when the response supplies a syntactically valid note ID.
    if platform == "xiaohongshu":
        note_id = first_non_empty(item.get("note_id"), item.get("noteId"), item.get("id"))
        if XIAOHONGSHU_NOTE_ID_RE.fullmatch(note_id):
            return f"https://www.xiaohongshu.com/explore/{note_id}"
    return ""


def item_published_at(item: dict[str, Any]) -> str:
    return first_non_empty(
        item.get("published_date"), item.get("publish_date"), item.get("created_at"), item.get("dateTime"), item.get("time_desc")
    )[:80]


def nested_public_url(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()[:500] if PUBLIC_URL_RE.match(value.strip()) else ""
    if isinstance(value, list):
        for item in value[:20]:
            hit = nested_public_url(item)
            if hit:
                return hit
    if isinstance(value, dict):
        for key in (
            "url_list", "url", "src", "origin_url", "cover_url", "play_url", "master_url", "video_url", "audio_url", "download_url",
        ):
            if key in value:
                hit = nested_public_url(value[key])
                if hit:
                    return hit
    return ""


def nested_value(value: Any, *path: str) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def first_public_url(*values: Any) -> str:
    for value in values:
        hit = nested_public_url(value)
        if hit:
            return hit
    return ""


def item_cover_image(item: dict[str, Any]) -> str:
    for key in ("cover_image", "cover_url", "cover", "thumbnail", "image"):
        hit = nested_public_url(item.get(key))
        if hit:
            return hit
    # RedNote's ``thumbnail`` can be a contact-sheet sprite. Prefer the
    # single-frame poster that the public response already provides.
    for info_key in ("video_info_v2", "video_info"):
        hit = first_public_url(
            nested_value(item, info_key, "image", "first_frame"),
            nested_value(item, info_key, "image", "thumbnail"),
            nested_value(item, info_key, "image", "thumbnail_dim"),
        )
        if hit:
            return hit
    images = item.get("images_list")
    if isinstance(images, list):
        for image in images[:20]:
            hit = first_public_url(
                nested_value(image, "url_size_large"),
                nested_value(image, "url"),
                nested_value(image, "original"),
            )
            if hit:
                return hit
    return ""


def direct_media_url(value: Any) -> str:
    """Return an already-public direct media URL, never a derived URL."""
    if isinstance(value, str):
        url = value.strip()
        if PUBLIC_URL_RE.match(url) and DIRECT_MEDIA_URL_RE.search(url):
            return url[:500]
        return ""
    if isinstance(value, list):
        for item in value[:20]:
            hit = direct_media_url(item)
            if hit:
                return hit
        return ""
    if isinstance(value, dict):
        for key in (
            "embed_url", "video_url", "videoUrl", "play_url", "playUrl", "master_url", "download_url", "audio_url", "audioUrl", "url", "backup_urls",
        ):
            if key in value:
                hit = direct_media_url(value[key])
                if hit:
                    return hit
    return ""


def item_embed_url(item: dict[str, Any]) -> str:
    for key in ("embed_url", "video_url", "videoUrl", "play_url", "playUrl", "master_url", "audio_url", "audioUrl"):
        hit = direct_media_url(item.get(key))
        if hit:
            return hit
    for info_key in ("video_info_v2", "video_info"):
        # Prefer H.264 where a public stream explicitly offers it, because it
        # has the broadest browser support. The URL still comes verbatim from
        # TikOmni's archived response.
        hit = direct_media_url(nested_value(item, info_key, "media", "video"))
        if hit:
            return hit
        stream = nested_value(item, info_key, "media", "stream")
        if isinstance(stream, dict):
            for codec in ("h264", "avc", "video", "h265", "hevc"):
                hit = direct_media_url(stream.get(codec))
                if hit:
                    return hit
        hit = direct_media_url(nested_value(item, info_key, "media", "audio"))
        if hit:
            return hit
    return ""


def item_primary_text(item: dict[str, Any]) -> tuple[str, str]:
    for key in ("primary_text", "caption_raw", "subtitle_raw", "asr_clean", "desc", "content", "text", "body"):
        value = item.get(key)
        if not isinstance(value, str):
            continue
        text = clean_text(value)[:4000]
        if text:
            return text, f"{key}（公开作品元数据）"
    return "", ""


def item_author(item: dict[str, Any]) -> str:
    value = item.get("author") or item.get("user") or item.get("creator")
    if isinstance(value, dict):
        return clean_text(first_non_empty(value.get("nickname"), value.get("name"), value.get("username"), value.get("title")))[:160]
    return clean_text(str(value or ""))[:160]


def opening_mechanisms(title: str, hook: str) -> list[str]:
    text = f"{title} {hook}"
    values: list[str] = []
    if re.search(r"不是|别|不要|误区|反常识", text):
        values.append("反差/反常识入口")
    if re.search(r"案例|故事|实战|经历|现场", text):
        values.append("场景或案例开场")
    if re.search(r"方法|步骤|清单|框架|怎么做", text):
        values.append("方法结构入口")
    if re.search(r"评论|留言|提问|怎么办", text):
        values.append("互动问题承接")
    return values or ["待人工核验的公开入口"]


def _matched_labels(text: str, rules: tuple[tuple[str, str], ...]) -> list[str]:
    return [label for label, pattern in rules if re.search(pattern, text, re.IGNORECASE)]


def _ordered_structure(text: str) -> list[str]:
    rules = (
        ("具体问题或场景", r"为什么|怎么|怎么办|问题|场景|当你|如果|有没有|到底"),
        ("冲突或认知修正", r"但是|然而|其实|不是|别|不要|误区|反而|没想到|才明白"),
        ("案例或事实证据", r"案例|经历|实战|现场|客户|学员|数据|研究|报告|我.{0,8}(?:遇到|经历|发现|做过)"),
        ("方法或步骤展开", r"方法|步骤|清单|框架|第一|第二|第三|首先|其次|最后|怎么做"),
        ("结论或行动收束", r"所以|因此|结论|建议|记住|可以|应该|收藏|评论|私信|关注|行动"),
    )
    positions: list[tuple[int, int, str]] = []
    for order, (label, pattern) in enumerate(rules):
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            positions.append((match.start(), order, label))
    return [label for _position, _order, label in sorted(positions)][:6]


def analyze_work_structure(
    *,
    title: str,
    hook: str,
    primary_text: str,
    content_format: str,
    cover_image: str,
    embed_url: str,
    published_at: str,
    metrics: dict[str, Any],
    primary_text_source: str = "",
) -> dict[str, Any]:
    """Derive bounded structure signals without copying source prose.

    These labels are deterministic observations over returned public fields.
    They deliberately remain generic and keep missing evidence explicit.
    """
    source_text = clean_text(f"{title} {hook} {primary_text}")
    topic_signals = _matched_labels(source_text, (
        ("教育与选择", r"教育|学校|大学|留学|择校|学习|孩子|课程"),
        ("职业与成长", r"职业|工作|求职|offer|成长|能力|职场|面试"),
        ("商业与创业", r"商业|创业|公司|产品|客户|获客|成交|利润"),
        ("财富与投资", r"财富|投资|股票|基金|保险|资产|理财|买房"),
        ("AI 与技术", r"\bAI\b|人工智能|模型|技术|自动化|软件|产品经理"),
        ("身份与迁移", r"香港|移民|身份|签证|优才|高才|海外|城市|搬家"),
        ("家庭与关系", r"家庭|父母|夫妻|婚姻|关系|妈妈|爸爸|亲子"),
        ("健康与生活", r"健康|运动|饮食|睡眠|生活方式|医疗"),
    ))
    promise_types = _matched_labels(source_text, (
        ("问题解答", r"为什么|怎么|怎么办|到底|如何|该不该|能不能|要不要|问题"),
        ("方法清单", r"方法|步骤|清单|框架|攻略|指南|个建议|件事"),
        ("案例复盘", r"案例|复盘|实战|经历|现场|我.{0,8}(?:做过|遇到|经历|发现)"),
        ("观点判断", r"我认为|我觉得|结论|本质|关键|真正|值得|意味着"),
        ("风险提醒", r"风险|避坑|不要|别|误区|警惕|小心|后悔"),
        ("对比选择", r"对比|区别|还是|相比|怎么选|该选|vs\.?"),
    ))
    proof_signals = _matched_labels(source_text, (
        ("数字或量化事实", r"\d+(?:\.\d+)?%|\d+(?:\.\d+)?万|\d+(?:\.\d+)?亿|\d+个|\d+次|\d+年|\d+天|\d+元"),
        ("个人经历", r"我|我们|亲历|亲身|经历|我才|我曾"),
        ("案例证据", r"案例|客户|学员|朋友|现场|实战"),
        ("权威或公开来源", r"研究|报告|官方|政策|大学|学校|专家|机构|课程"),
        ("评论或受众反馈", r"评论|留言|读者|粉丝|有人问|经常有人"),
    ))
    cta_types = _matched_labels(source_text, (
        ("评论互动", r"评论|留言|告诉我|你怎么看|你觉得|讨论"),
        ("私信咨询", r"私信|咨询|联系|领取|报名"),
        ("收藏转发", r"收藏|转发|分享|保存"),
        ("点击跳转", r"点击|链接|主页|橱窗|下单"),
        ("关注订阅", r"关注|订阅"),
    ))
    narrative_structure = _ordered_structure(source_text) if primary_text else []
    visual_signals: list[str] = []
    if cover_image:
        visual_signals.append("公开主图可核验")
    if re.search(r"video|视频", content_format, re.IGNORECASE):
        visual_signals.append("视频内容形态")
    elif re.search(r"image|图文|note", content_format, re.IGNORECASE):
        visual_signals.append("图文内容形态")
    elif re.search(r"article|文章|text", content_format, re.IGNORECASE):
        visual_signals.append("长文内容形态")
    if embed_url:
        visual_signals.append("公开媒体地址可核验")

    evidence_limits: list[str] = []
    if not primary_text:
        evidence_limits.append("未返回正文、字幕或 ASR，不能判断完整叙事推进。")
    if not cover_image:
        evidence_limits.append("未返回公开主图，不能判断首屏画面。")
    if not embed_url and re.search(r"video|视频", content_format, re.IGNORECASE):
        evidence_limits.append("未返回可播放媒体，不能进行镜头级核验。")
    if not published_at:
        evidence_limits.append("未返回可归一的发布时间。")
    if not metrics:
        evidence_limits.append("未返回公开互动指标。")

    basis = [name for name, present in (
        ("title", bool(title)),
        ("summary", bool(hook)),
        ("primary_text", bool(primary_text)),
        ("cover", bool(cover_image)),
        ("media", bool(embed_url)),
        ("metrics", bool(metrics)),
        ("published_at", bool(published_at)),
    ) if present]
    # A platform description can support bounded labels, but it is not the
    # complete work. Only transcript/caption/body-like fields qualify the
    # sequence as ready; direct function callers may omit provenance when
    # they already control the text input.
    source_is_complete = not primary_text_source or bool(re.search(
        r"caption|字幕|asr|transcript|正文|article|content|text",
        primary_text_source,
        re.IGNORECASE,
    ))
    return {
        "status": "ready" if primary_text and source_is_complete and len(narrative_structure) >= 2 else "limited",
        "topic_signals": topic_signals[:6],
        "promise_types": promise_types[:6],
        "narrative_structure": narrative_structure,
        "proof_signals": proof_signals[:6],
        "cta_types": cta_types[:6],
        "visual_signals": visual_signals[:6],
        "basis": basis,
        "evidence_limits": evidence_limits[:8],
    }


def normalize_works(account: dict[str, str], payload: dict[str, Any], captured_at: str) -> list[dict[str, Any]]:
    try:
        legacy_platform = normalize_tikomni_platform(account["platform"])
    except ValueError:
        return []
    rows: list[dict[str, Any]] = []
    # TikomniApiBridge returns the API ``data`` object. The legacy normalizer
    # accepts that object nested under ``data``, while a few catalog endpoints
    # already return the item collection at the top level.
    item_payload: dict[str, Any] = payload
    if any(isinstance(payload.get(key), list) for key in ("items", "works", "notes", "articles", "list")):
        item_payload = {"data": payload}
    for item in normalized_items(item_payload)[:MAX_WORKS_PER_ACCOUNT]:
        if not isinstance(item, dict):
            continue
        title = clean_text(first_non_empty(item.get("title"), item.get("desc"), item.get("caption_raw"), item.get("primary_text")))
        hook = infer_hook(item)
        url = item_source_url(item, account["platform"])
        primary_text, primary_text_source = item_primary_text(item)
        published_at = item_published_at(item)
        content_format = first_non_empty(item.get("work_modality"), item.get("content_type"), item.get("type"))[:80]
        metrics = infer_metrics(legacy_platform, item)
        cover_image = item_cover_image(item)
        embed_url = item_embed_url(item)
        rows.append({
            "source_url": url,
            "published_at": published_at,
            "captured_at": captured_at,
            "format": content_format,
            "metrics": metrics,
            "opening_mechanisms": opening_mechanisms(title, hook),
            "cta_present": bool(re.search(r"咨询|私信|领取|点击|报名|联系|评论", f"{title} {hook}")),
            "interaction_signal": "评论/互动可见" if re.search(r"评论|留言|提问", f"{title} {hook}") else "未从公开元数据确认",
            "title": title[:300],
            "author": item_author(item),
            "summary": clean_text(hook)[:500],
            "cover_image": cover_image,
            "cover_path": "",
            "cover_content_type": "",
            "embed_url": embed_url,
            "primary_text": primary_text,
            "primary_text_source": primary_text_source,
            "structure_analysis": analyze_work_structure(
                title=title,
                hook=hook,
                primary_text=primary_text,
                content_format=content_format,
                cover_image=cover_image,
                embed_url=embed_url,
                published_at=published_at,
                metrics=metrics,
                primary_text_source=primary_text_source,
            ),
        })
    return rows


def identity_is_verifiable(account: dict[str, str], payloads: list[dict[str, Any]], works: list[dict[str, Any]]) -> bool:
    handle = account["handle"].strip().lower()
    url = account["public_url"].strip().lower()
    for payload in payloads:
        haystack = recursive_text(payload).lower()
        if handle and handle in haystack:
            return True
        if url and url in haystack:
            return True
    # A public work URL is useful evidence only after a returned source URL
    # includes the configured public account URL or platform ID.
    return any(handle and handle in str(work.get("source_url") or "").lower() for work in works)


def profile_evidence(account: dict[str, str], payload: dict[str, Any] | None, captured_at: str, reason: str = "") -> dict[str, Any]:
    if payload is None:
        return {"status": "unavailable", "reason": reason or "没有可验证的公开主页响应。", "links": []}
    return {
        "status": "available",
        "captured_at": captured_at,
        "links": [{"url": account["public_url"], "captured_at": captured_at, "kind": "profile"}],
        "public_metric_fields": sorted({
            key for key in (payload.get("data") if isinstance(payload.get("data"), dict) else payload)
            if isinstance(key, str) and re.search(r"fans|follow|like|count|total|view", key, re.IGNORECASE)
        })[:20],
    }


def collect_account(
    bridge: TikomniApiBridge,
    project: Path,
    scoped_root: Path,
    account: dict[str, str],
    snapshot_id: str,
) -> dict[str, Any]:
    captured_at = now()
    raw_entries: list[dict[str, Any]] = []
    profile_payload: dict[str, Any] | None = None
    work_payload: dict[str, Any] | None = None
    errors: list[str] = []
    capabilities: list[tuple[str, str]] = []
    if account["platform"] in {"xiaohongshu", "wechat_channels"}:
        capabilities.append(("user_profile", "profile"))
    capabilities.append(("article_list" if account["platform"] == "wechat_mp" else "user_posts", "works"))

    for capability, kind in capabilities:
        try:
            payload, raw_entry = fetch_resolved_public_object(
                bridge,
                project,
                scoped_root,
                account,
                capability=capability,
                kind=kind,
            )
            raw_entries.append(raw_entry)
            if kind == "profile":
                profile_payload = payload
            else:
                work_payload = payload
        except BenchmarkAdvisorCollectionError as exc:
            errors.append(str(exc))

    works = normalize_works(account, work_payload or {}, captured_at) if work_payload else []
    identity_verified = identity_is_verifiable(account, [item for item in [profile_payload, work_payload] if item], works)
    if not identity_verified:
        reason = "TikOmni 响应没有可验证地匹配该公开账号 ID；不会把它当作该账号证据。"
        return {
            "account_id": account["id"],
            "platform": account["platform"],
            "status": "unavailable",
            "captured_at": captured_at,
            "reason": reason if not errors else f"{reason} {'；'.join(errors[:2])}",
            "profile": profile_evidence(account, None, captured_at, reason),
            "works": {"status": "unavailable", "items": [], "links": [], "reason": reason},
            "comments": {"status": "unavailable", "items": [], "links": [], "reason": "没有已验证作品标识，未请求评论。"},
            "raw_entries": raw_entries,
            "evidence_links": [],
        }

    archive_work_covers(project, scoped_root, snapshot_id, account["id"], works)
    work_links = [
        {"url": row["source_url"], "captured_at": captured_at, "kind": "work"}
        for row in works if row.get("source_url")
    ][:12]
    profile = profile_evidence(account, profile_payload, captured_at)
    if account["platform"] == "wechat_mp":
        profile = profile_evidence(account, None, captured_at, "当前 TikOmni 账户组合只返回可验证文章列表，不虚构主页资料。")
    status = "available" if works or profile.get("status") == "available" else "unavailable"
    return {
        "account_id": account["id"],
        "platform": account["platform"],
        "status": status,
        "captured_at": captured_at,
        "reason": "；".join(errors[:2]),
        "profile": profile,
        "works": {
            "status": "available" if works else "unavailable",
            "items": works,
            "links": work_links,
            "reason": "" if works else "TikOmni 未返回可验证的公开作品列表。",
        },
        # Comments are retained only when a future resolver result supplies a
        # verified work identifier. This release deliberately does not guess
        # comment endpoints from a handle or crawl a private/account-only page.
        "comments": {
            "status": "unavailable",
            "items": [],
            "links": [],
            "reason": "当前公开账户响应没有可安全复用的评论请求标识；未抓取评论。",
        },
        "raw_entries": raw_entries,
        "evidence_links": [*profile.get("links", []), *work_links],
    }


def collect_project_accounts(
    project: Path | str,
    project_id_value: str,
    accounts_value: Any,
    *,
    bridge: TikomniApiBridge | None = None,
) -> dict[str, Any]:
    root = Path(project).expanduser().resolve(strict=False)
    project_id = safe_project_id(project_id_value)
    if not isinstance(accounts_value, list) or not 1 <= len(accounts_value) <= MAX_ACCOUNTS:
        raise BenchmarkAdvisorCollectionError(f"请提供 1 至 {MAX_ACCOUNTS} 个公开对标账号。")
    accounts = [normalize_account(item) for item in accounts_value]
    if len({item["id"] for item in accounts}) != len(accounts):
        raise BenchmarkAdvisorCollectionError("对标账号 ID 不能重复。")
    scoped_relative = account_root(project_id)
    scoped_root = project_path(root, scoped_relative)
    client = bridge or TikomniApiBridge(root)
    health = client.credential_status()
    captured_at = now()
    if not health.get("available"):
        raise BenchmarkAdvisorCollectionError("TikOmni 对标账号研究不可用：Token 未配置、无效或不可读；不会生成研究报告或归档。")

    snapshot_id = f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S-%f')}-{uuid.uuid4().hex[:10]}"
    entries = [collect_account(client, root, scoped_root, account, snapshot_id) for account in accounts]
    unavailable = [item for item in entries if item.get("status") != "available"]
    if unavailable:
        details = "；".join(
            f"{item.get('account_id') or '未知账号'}：{item.get('reason') or 'TikOmni 未返回可验证公开证据'}"
            for item in unavailable
        )
        raise BenchmarkAdvisorCollectionError(
            f"TikOmni 对标账号研究未完成：{details}；不会生成研究报告或归档。"
        )

    normalized_relative = f"{scoped_relative}/normalized/{snapshot_id}.json"
    normalized_path = project_path(root, normalized_relative)
    payload = {
        "schema": "aifios.benchmark-advisor.evidence.v1",
        "project_id": project_id,
        "snapshot_id": snapshot_id,
        "captured_at": captured_at,
        "source": "TikOmni public API via social-media-crawl resolver",
        "accounts": entries,
    }
    write_new_json(normalized_path, payload)
    manifest_relative = f"{scoped_relative}/snapshots/{snapshot_id}.json"
    manifest_path = project_path(root, manifest_relative)
    manifest = {
        "schema": "aifios.benchmark-advisor.snapshot.v1",
        "project_id": project_id,
        "snapshot_id": snapshot_id,
        "captured_at": captured_at,
        "normalized_path": normalized_relative,
        "normalized_sha256": sha256_file(normalized_path),
        "account_statuses": [{
            "account_id": item["account_id"],
            "status": item["status"],
            "evidence_links": item.get("evidence_links", []),
        } for item in entries],
    }
    write_new_json(manifest_path, manifest)
    return {
        "project_id": project_id,
        "snapshot_path": manifest_relative,
        "normalized_path": normalized_relative,
        "captured_at": captured_at,
        "accounts": entries,
    }


def load_accounts_argument(value: str) -> Any:
    raw = str(value or "")
    if raw.startswith("@"):
        path = Path(raw[1:]).expanduser()
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise BenchmarkAdvisorCollectionError("无法读取对标账号输入文件。") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BenchmarkAdvisorCollectionError("对标账号输入必须是 JSON 数组。") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect AIFIOS benchmark advisor public evidence")
    parser.add_argument("--project", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--accounts", required=True, help="JSON array or @local-file")
    args = parser.parse_args(argv)
    try:
        result = collect_project_accounts(args.project, args.project_id, load_accounts_argument(args.accounts))
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

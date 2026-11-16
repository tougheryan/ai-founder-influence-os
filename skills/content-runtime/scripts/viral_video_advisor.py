#!/usr/bin/env python3
"""Collect factual public-video evidence for the benchmark growth advisor.

This collector deliberately stops at source facts.  It does not create a
"viral" explanation, an imitation plan, or a transcript that TikOmni did not
return.  A later advisor layer may reason from the normalized fact record, but
it must keep the source URL and missing fields visible.

Unlike the account collector, a Douyin share URL is routed to a small,
catalog-verified list of direct single-work endpoints.  The account resolver
maps Douyin market research to WeChat Channels by design, which would be the
wrong contract for an individual Douyin work.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from benchmark_advisor import download_public_cover, write_immutable_cover
from tikomni_adapter import TikomniApiBridge, clean_text, parse_number


PROJECT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
PUBLIC_SCHEMES = {"http", "https"}
ADVISOR_ROOT = "materials/advisors/benchmark"
MAX_SOURCE_URL_LENGTH = 2_000
MAX_TITLE_LENGTH = 500
MAX_AUTHOR_LENGTH = 200
MAX_PRIMARY_TEXT_LENGTH = 24_000
# A single-video lookup has one fallback endpoint. Keep each attempt bounded
# so an unavailable source returns a recoverable failure instead of pinning the
# workbench for a minute before the user can try another public link.
TIKOMNI_TIMEOUT_MS = 15_000
PUBLIC_MEDIA_TIMEOUT_SECONDS = 8
MAX_WECHAT_CHANNELS_PREVIEW_BYTES = 512 * 1024
WECHAT_CHANNELS_PREVIEW_API = "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info"
WECHAT_CHANNELS_PREVIEW_ORIGIN = "https://channels.weixin.qq.com"
WECHAT_CHANNELS_PREVIEW_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
WECHAT_CHANNELS_MEDIA_HOSTS = {"finder.video.qq.com", "wxapp.tc.qq.com", "wx.qlogo.cn"}
WECHAT_CHANNELS_SHARE_ID_RE = re.compile(r"^/sph/([A-Za-z0-9_-]{5,128})/?$")

# Every endpoint below is a published TikOmni catalog endpoint with a source
# URL parameter.  ``endpoint_input_schema`` validates that this remains true
# before a request is attempted, so catalog drift fails closed.
DIRECT_VIDEO_ENDPOINTS: dict[str, tuple[tuple[str, dict[str, Any]], ...]] = {
    "douyin": (
        ("douyin.user_profile.app_v3.fetch_one_video_by_share_url", {"share_url": "$source_url"}),
        ("douyin.video_detail.web.fetch_one_video_by_share_url", {"share_url": "$source_url"}),
    ),
    "xiaohongshu": (
        ("xiaohongshu.user_profile.app_v2.get_video_note_detail", {"share_text": "$source_url"}),
        ("xiaohongshu.note_detail.web.get_note_info_v7", {"share_text": "$source_url"}),
        ("xiaohongshu.note_detail.web.get_note_info_v4", {"share_text": "$source_url"}),
    ),
    "wechat_channels": (
        ("wechat_channels.video_detail.v2.fetch_video_detail", {"share_url": "$source_url", "raw": True}),
    ),
}

PLATFORM_HOSTS: dict[str, tuple[str, ...]] = {
    "douyin": ("douyin.com", "douyin.cn", "iesdouyin.com"),
    "xiaohongshu": ("xiaohongshu.com", "xhslink.com", "xhsurl.com"),
    "wechat_channels": ("weixin.qq.com", "channels.weixin.qq.com", "finder.video.qq.com"),
}


class ViralVideoAdvisorError(ValueError):
    """Expected input, storage, or TikOmni contract failure."""


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def safe_project_id(value: Any) -> str:
    project_id = str(value or "").strip().lower()
    if not PROJECT_ID_RE.fullmatch(project_id):
        raise ViralVideoAdvisorError("项目 ID 必须是 1-64 位小写字母、数字、连字符或下划线。")
    return project_id


def safe_relative_path(value: str) -> str:
    path = str(value or "").strip().replace("\\", "/")
    if not path or path.startswith("/") or "\x00" in path:
        raise ViralVideoAdvisorError("路径必须是项目内相对路径。")
    if any(part in {"", ".", ".."} for part in path.split("/")):
        raise ViralVideoAdvisorError("路径不允许越出项目目录。")
    return path


def project_path(root: Path, relative: str) -> Path:
    candidate = (root / safe_relative_path(relative)).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ViralVideoAdvisorError("路径不在当前项目内。") from exc
    return candidate


def relative_to_project(root: Path, path: Path) -> str:
    try:
        return path.resolve(strict=False).relative_to(root).as_posix()
    except ValueError as exc:
        raise ViralVideoAdvisorError("TikOmni 返回的路径不在当前项目内。") from exc


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def empty_cover_provenance() -> dict[str, str]:
    return {
        "cover_path": "",
        "cover_content_type": "",
        "cover_source": "",
        "cover_label": "",
        "cover_sha256": "",
    }


class _NoRedirect(HTTPRedirectHandler):
    """Do not let the fixed public-preview request cross to another origin."""

    def redirect_request(self, request: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def wechat_channels_share_id(source_url: str) -> str:
    """Return an ID only for the canonical public video-channel share URL."""
    try:
        parsed = urlsplit(source_url)
    except ValueError:
        return ""
    if (
        parsed.scheme.lower() != "https"
        or (parsed.hostname or "").lower() != "weixin.qq.com"
        or parsed.username
        or parsed.password
        or (parsed.port is not None and parsed.port != 443)
    ):
        return ""
    match = WECHAT_CHANNELS_SHARE_ID_RE.fullmatch(parsed.path)
    return match.group(1) if match else ""


def is_wechat_channels_media_url(value: Any) -> bool:
    try:
        parsed = urlsplit(str(value or "").strip())
    except ValueError:
        return False
    return bool(
        parsed.scheme.lower() == "https"
        and (parsed.hostname or "").lower() in WECHAT_CHANNELS_MEDIA_HOSTS
        and not parsed.username
        and not parsed.password
        and (parsed.port is None or parsed.port == 443)
    )


def fetch_wechat_channels_preview(source_url: str) -> dict[str, Any]:
    """Read the fixed public preview JSON without loading source video/audio."""
    share_id = wechat_channels_share_id(source_url)
    if not share_id:
        return {}
    query = urlencode({
        "_rid": f"aifios-{uuid.uuid4().hex[:16]}",
        "_pageUrl": "https://channels.weixin.qq.com/finder-preview/pages/sph",
    })
    request = Request(
        f"{WECHAT_CHANNELS_PREVIEW_API}?{query}",
        data=canonical_bytes({"baseReq": {"generalToken": ""}, "shortUri": share_id}),
        method="POST",
        headers={
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Origin": WECHAT_CHANNELS_PREVIEW_ORIGIN,
            "Referer": f"{WECHAT_CHANNELS_PREVIEW_ORIGIN}/finder-preview/pages/sph?id={share_id}",
            "User-Agent": WECHAT_CHANNELS_PREVIEW_USER_AGENT,
        },
    )
    try:
        with build_opener(_NoRedirect).open(request, timeout=PUBLIC_MEDIA_TIMEOUT_SECONDS) as response:
            status = int(response.getcode() or 0)
            if status < 200 or status >= 300:
                raise ViralVideoAdvisorError(f"视频号公开预览暂时不可用（{status}）。")
            if "application/json" not in str(response.headers.get("Content-Type") or "").lower():
                raise ViralVideoAdvisorError("视频号公开预览没有返回可验证的 JSON 数据。")
            payload = response.read(MAX_WECHAT_CHANNELS_PREVIEW_BYTES + 1)
    except HTTPError as exc:
        raise ViralVideoAdvisorError(f"视频号公开预览暂时不可用（{exc.code}）。") from exc
    except (URLError, OSError, TimeoutError) as exc:
        raise ViralVideoAdvisorError("视频号公开预览暂时不可用。") from exc
    if len(payload) > MAX_WECHAT_CHANNELS_PREVIEW_BYTES:
        raise ViralVideoAdvisorError("视频号公开预览响应过大。")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ViralVideoAdvisorError("视频号公开预览响应格式无效。") from exc
    if not isinstance(value, dict) or value.get("errCode") not in (0, None):
        raise ViralVideoAdvisorError("视频号公开预览没有返回可验证内容。")
    data = value.get("data")
    return data if isinstance(data, dict) else {}


def archive_wechat_channels_preview_cover(
    root: Path,
    media_root: Path,
    source_url: str,
    preview: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """Best-effort archive of the platform-authored cover for a video number."""
    if not wechat_channels_share_id(source_url):
        return empty_cover_provenance()
    try:
        preview_data = preview if isinstance(preview, Mapping) else fetch_wechat_channels_preview(source_url)
        feed_info = preview_data.get("feedInfo") if isinstance(preview_data.get("feedInfo"), Mapping) else {}
        cover_url = str(feed_info.get("coverUrl") or "").strip()
        if not is_wechat_channels_media_url(cover_url):
            return empty_cover_provenance()
        payload, content_type = download_public_cover(cover_url)
        return {
            "cover_path": write_immutable_cover(root, media_root, payload, content_type),
            "cover_content_type": content_type,
            "cover_source": "wechat_channels_public_preview",
            "cover_label": "视频号公开预览封面",
            "cover_sha256": hashlib.sha256(payload).hexdigest(),
            "cover_image": cover_url,
            "cover_type": "cover",
        }
    except (ViralVideoAdvisorError, OSError, ValueError):
        # An optional visual cache never blocks the factual TikOmni analysis.
        return empty_cover_provenance()


def is_redacted_public_value(value: Any) -> bool:
    text = clean_text(str(value or ""))
    return not text or "[已脱敏]" in text or "[已隐藏]" in text


def merge_wechat_channels_preview_identity(facts: dict[str, Any], preview: Mapping[str, Any]) -> None:
    """Use the official preview only to fill fields TikOmni left blank/redacted."""
    author_info = preview.get("authorInfo") if isinstance(preview.get("authorInfo"), Mapping) else {}
    preview_author = clean_text(str(author_info.get("nickname") or ""))[:MAX_AUTHOR_LENGTH]
    if preview_author and is_redacted_public_value(facts.get("author")):
        facts["author"] = preview_author


def write_new_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        with path.open("xb") as handle:
            handle.write(canonical_bytes(dict(payload)))
    except FileExistsError as exc:
        raise ViralVideoAdvisorError("单条视频证据快照 ID 冲突，请重新执行。") from exc


def read_json(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise ViralVideoAdvisorError("TikOmni 未保存可审计的原始公开证据。")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ViralVideoAdvisorError("TikOmni 原始公开证据不可读取。") from exc
    if not isinstance(payload, dict):
        raise ViralVideoAdvisorError("TikOmni 原始公开证据格式无效。")
    return payload


def clean_source_url(value: Any) -> str:
    source_url = str(value or "").strip()
    if not source_url or len(source_url) > MAX_SOURCE_URL_LENGTH:
        raise ViralVideoAdvisorError("视频公开链接为空或超出允许长度。")
    parsed = urlsplit(source_url)
    if parsed.scheme.lower() not in PUBLIC_SCHEMES or not parsed.netloc or parsed.username or parsed.password:
        raise ViralVideoAdvisorError("视频链接必须是公开的 http 或 https 链接。")
    if not parsed.hostname:
        raise ViralVideoAdvisorError("视频链接缺少可识别的公开域名。")
    return source_url


def host_matches(host: str, suffixes: Iterable[str]) -> bool:
    lowered = host.lower().rstrip(".")
    return any(lowered == suffix or lowered.endswith(f".{suffix}") for suffix in suffixes)


def detect_platform(source_url: str) -> str:
    parsed = urlsplit(source_url)
    host = str(parsed.hostname or "").lower()
    if host_matches(host, PLATFORM_HOSTS["douyin"]):
        return "douyin"
    if host_matches(host, PLATFORM_HOSTS["xiaohongshu"]):
        return "xiaohongshu"
    if host_matches(host, PLATFORM_HOSTS["wechat_channels"]):
        # ``mp.weixin.qq.com`` is intentionally not in the allow list.  A
        # regular WeChat article must not be misrepresented as a video channel
        # work merely because it uses the same parent domain.
        if host == "weixin.qq.com" and not parsed.path.startswith("/sph/"):
            raise ViralVideoAdvisorError("该微信链接不是可识别的视频号公开分享链接。")
        return "wechat_channels"
    raise ViralVideoAdvisorError("仅支持公开的抖音、小红书或视频号视频链接。")


def single_video_root(project_id: str) -> str:
    return f"{ADVISOR_ROOT}/{project_id}/single-video"


def safe_reason(value: Any, limit: int = 500) -> str:
    text = clean_text(str(value or ""))
    # Avoid accidentally echoing a credential should an upstream tool include
    # it in an exception.  The collector never needs the full remote response
    # to explain a failed attempt.
    text = re.sub(r"(?i)(api[_-]?key|token)\s*([=:])\s*[^\s,;]+", r"\1\2[已隐藏]", text)
    return text[:limit]


def substitute_params(template: Mapping[str, Any], source_url: str) -> dict[str, Any]:
    return {
        key: source_url if value == "$source_url" else value
        for key, value in template.items()
    }


def catalog_validated_params(
    bridge: TikomniApiBridge,
    endpoint_id: str,
    template: Mapping[str, Any],
    source_url: str,
) -> dict[str, Any]:
    """Return static endpoint params only when the current catalog accepts them."""
    schema = bridge.endpoint_input_schema(endpoint_id)
    if not isinstance(schema, dict):
        raise ViralVideoAdvisorError(f"TikOmni endpoint {endpoint_id} 缺少输入 schema。")
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        raise ViralVideoAdvisorError(f"TikOmni endpoint {endpoint_id} 的输入 schema 无效。")
    params = substitute_params(template, source_url)
    unknown = sorted(set(params).difference(properties))
    if unknown:
        raise ViralVideoAdvisorError(
            f"TikOmni endpoint {endpoint_id} 不再接受参数：{', '.join(unknown)}。"
        )
    required = schema.get("required") if isinstance(schema.get("required"), list) else []
    missing = [key for key in required if not params.get(str(key))]
    if missing:
        raise ViralVideoAdvisorError(
            f"TikOmni endpoint {endpoint_id} 缺少必填参数：{', '.join(str(key) for key in missing)}。"
        )
    return params


def iter_dicts(value: Any, *, max_depth: int = 10, depth: int = 0) -> Iterable[dict[str, Any]]:
    if depth > max_depth:
        return
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_dicts(child, max_depth=max_depth, depth=depth + 1)
    elif isinstance(value, list):
        for child in value[:100]:
            yield from iter_dicts(child, max_depth=max_depth, depth=depth + 1)


def node_score(item: Mapping[str, Any]) -> int:
    keys = {str(key).lower() for key in item}
    score = 0
    if keys.intersection({"aweme_id", "note_id", "object_id", "item_id", "id"}):
        score += 8
    if keys.intersection({"title", "desc", "caption_raw", "caption", "primary_text"}):
        score += 7
    if keys.intersection({"video", "video_url", "video_download_url", "play_addr", "play_url"}):
        score += 5
    if keys.intersection({"author", "nickname", "author_name", "user", "creator"}):
        score += 3
    if keys.intersection({"statistics", "stats", "metrics", "digg_count", "like_count", "play_count"}):
        score += 2
    return score


def choose_work_node(data: Any) -> dict[str, Any]:
    best: dict[str, Any] = data if isinstance(data, dict) else {}
    best_score = node_score(best)
    for item in iter_dicts(data):
        score = node_score(item)
        if score > best_score:
            best = item
            best_score = score
    return best


def preferred_video_sources(data: Any, work: Mapping[str, Any]) -> list[Any]:
    """Put a WeChat Channels work's media record ahead of account/live metadata.

    ``fetch_video_detail`` currently nests the actual work below
    ``data.data.objectDesc.media[0]``. The surrounding response may also hold
    a contact card with ``liveCover`` fields; those must never win over the
    selected work's cover or playback URL.
    """
    candidates: list[Any] = []
    roots: list[Mapping[str, Any]] = []
    if isinstance(data, Mapping):
        nested = data.get("data")
        if isinstance(nested, Mapping):
            roots.append(nested)
        roots.append(data)
    for root in roots:
        object_desc = root.get("objectDesc")
        if not isinstance(object_desc, Mapping):
            continue
        media = object_desc.get("media")
        if isinstance(media, list):
            candidates.extend(item for item in media[:1] if isinstance(item, Mapping))
        candidates.append(object_desc)
        candidates.append(root)
    candidates.extend((work, data))
    unique: list[Any] = []
    seen: set[int] = set()
    for candidate in candidates:
        marker = id(candidate)
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(candidate)
    return unique


def text_from_value(value: Any, *, limit: int) -> str:
    if isinstance(value, str):
        return clean_text(value)[:limit]
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)[:limit]
    if isinstance(value, list):
        parts = [text_from_value(item, limit=limit) for item in value[:100]]
        return clean_text(" ".join(part for part in parts if part))[:limit]
    if isinstance(value, dict):
        for key in ("text", "content", "caption", "sentence", "words", "title", "desc", "name", "nickname"):
            if key in value:
                hit = text_from_value(value[key], limit=limit)
                if hit:
                    return hit
    return ""


def values_for_keys(value: Any, keys: Iterable[str], *, max_depth: int = 8, depth: int = 0) -> Iterable[Any]:
    if depth > max_depth:
        return
    key_set = {key.lower() for key in keys}
    if isinstance(value, dict):
        # Prefer a field on the selected work object before walking into child
        # objects. This makes title/author selection deterministic.
        for key, item in value.items():
            if str(key).lower() in key_set:
                yield item
        for item in value.values():
            yield from values_for_keys(item, key_set, max_depth=max_depth, depth=depth + 1)
    elif isinstance(value, list):
        for item in value[:100]:
            yield from values_for_keys(item, key_set, max_depth=max_depth, depth=depth + 1)


def first_text(sources: Iterable[Any], keys: Iterable[str], *, limit: int) -> str:
    for source in sources:
        for value in values_for_keys(source, keys):
            text = text_from_value(value, limit=limit)
            if text and text.lower() not in {"n/a", "none", "null"}:
                return text
    return ""


def first_url_from_value(value: Any) -> str:
    if isinstance(value, str):
        candidate = value.strip()
        parsed = urlsplit(candidate)
        return candidate if parsed.scheme.lower() in PUBLIC_SCHEMES and parsed.netloc else ""
    if isinstance(value, list):
        for item in value[:100]:
            hit = first_url_from_value(item)
            if hit:
                return hit
    if isinstance(value, dict):
        for key in ("url_list", "url", "uri", "src", "origin_url", "download_url", "play_url"):
            if key in value:
                hit = first_url_from_value(value[key])
                if hit:
                    return hit
    return ""


def first_url(sources: Iterable[Any], keys: Iterable[str]) -> str:
    for source in sources:
        for value in values_for_keys(source, keys):
            hit = first_url_from_value(value)
            if hit:
                return hit
    return ""


def is_usable_tikomni_cover_url(value: str) -> bool:
    """Reject provider placeholders before storing their returned field value."""
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    if parsed.scheme.lower() not in PUBLIC_SCHEMES or not parsed.netloc or parsed.username or parsed.password:
        return False
    lowered = value.lower()
    return "[已脱敏]" not in lowered and "[已隐藏]" not in lowered


def first_cover_url(sources: Iterable[Any], keys: Iterable[str]) -> str:
    for source in sources:
        for value in values_for_keys(source, keys):
            hit = first_url_from_value(value)
            if hit and is_usable_tikomni_cover_url(hit):
                return hit
    return ""


def first_value(sources: Iterable[Any], keys: Iterable[str]) -> Any:
    for source in sources:
        for value in values_for_keys(source, keys):
            if value not in (None, ""):
                return value
    return None


def normalize_published_at(value: Any) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, str):
        text = clean_text(value)
        if not text or text.lower() in {"n/a", "none", "null"}:
            return ""
        if not re.fullmatch(r"\d{10,16}", text):
            return text[:80]
        value = int(text)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        timestamp = int(value)
        if timestamp > 1_000_000_000_000:
            timestamp //= 1_000
        if timestamp <= 0:
            return ""
        try:
            return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            return ""
    return ""


def normalize_duration_ms(value: Any, *, field_name: str) -> int | None:
    if value in (None, ""):
        return None
    try:
        parsed = parse_number(value)
    except (TypeError, ValueError):
        return None
    if parsed <= 0:
        return None
    # ``duration`` is usually seconds in the public APIs; an explicit
    # ``duration_ms`` remains milliseconds even for a short clip.
    if field_name.lower() != "duration_ms" and parsed < 10_000:
        parsed *= 1_000
    return parsed


def metric_value(item: Mapping[str, Any], aliases: Iterable[str]) -> int | None:
    alias_set = {alias.lower() for alias in aliases}
    sources: list[Mapping[str, Any]] = [item]
    for key in ("statistics", "stats", "metrics", "interaction", "interactions"):
        child = item.get(key)
        if isinstance(child, dict):
            sources.append(child)
    for source in sources:
        for key, value in source.items():
            if str(key).lower() not in alias_set or value in (None, ""):
                continue
            try:
                parsed = parse_number(value)
            except (TypeError, ValueError):
                continue
            return parsed if parsed >= 0 else None
    return None


def extract_metrics(sources: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    aliases = {
        "plays": ("play_count", "view_count", "playcount", "viewcount", "plays", "views"),
        "likes": ("digg_count", "like_count", "liked_count", "likecount", "likes"),
        "comments": ("comment_count", "comments_count", "commentcount", "comments"),
        "shares": ("share_count", "shared_count", "repost_count", "sharecount", "forward_count", "forwardcount", "shares"),
        "collects": ("collect_count", "collected_count", "bookmark_count", "collectcount", "fav_count", "favcount", "collects"),
    }
    metrics: dict[str, int] = {}
    for label, keys in aliases.items():
        for source in sources:
            value = metric_value(source, keys)
            if value is not None:
                metrics[label] = value
                break
    return metrics


def extract_primary_text(sources: Iterable[Any]) -> tuple[str, str]:
    routes = (
        ("native_subtitle", ("subtitle_raw", "subtitle_text", "subtitles", "subtitle", "caption_text")),
        ("platform_primary_text", ("primary_text", "content", "note_content")),
        ("asr", ("asr_clean", "asr_raw", "transcript", "transcript_text")),
        ("caption", ("caption_raw", "caption", "desc", "description")),
    )
    source_values = list(sources)
    for source_name, keys in routes:
        text = first_text(source_values, keys, limit=MAX_PRIMARY_TEXT_LENGTH)
        if text:
            return text, source_name
    return "", ""


def text_segments(value: str, *, limit: int = 5) -> list[str]:
    """Keep observable text units without pretending to reconstruct a transcript."""
    text = clean_text(value)
    if not text:
        return []
    # A trailing hashtag cluster is a distribution aid, not a narrative beat.
    text = re.sub(r"(?:\s*#[^\s#]+)+\s*$", "", text).strip()
    if not text:
        return []
    parts = re.split(r"(?<=[。！？!?；;])\s*|\n+", text)
    segments = [part.strip()[:260] for part in parts if part.strip()]
    return segments[:limit]


def build_analysis_fields(facts: Mapping[str, Any]) -> dict[str, Any]:
    """Provide an evidence-bounded handoff for the later analysis layer.

    These fields are intentionally deterministic. They make the requested
    analysis sections explicit without turning missing subtitles, frames, or
    spoken audio into invented observations.
    """
    primary_text = str(facts.get("primary_text") or "")
    title = str(facts.get("title") or "")
    segments = text_segments(primary_text)
    opening_hook = segments[0] if segments else ""
    topic = title or opening_hook
    structure: list[str] = []
    if segments:
        phase_labels = ("开头", "推进", "收束")
        for index, segment in enumerate(segments):
            phase = phase_labels[min(index, len(phase_labels) - 1)]
            structure.append(f"{phase}（公开文本）：{segment}")

    expression_methods: list[str] = []
    observed_text = primary_text or title
    if opening_hook and ("？" in opening_hook or "?" in opening_hook):
        expression_methods.append("问题式开场：首个公开文本片段包含问句。")
    if re.search(r"(?:不是.{0,48}而是|越.{0,48}越|一边.{0,48}一边)", observed_text):
        expression_methods.append("对比式表达：公开文本出现可验证的对照句式。")
    if re.search(r"(?:首先|其次|最后|第一|第二|第[一二三四五六七八九十]\b|\d+[、.])", observed_text):
        expression_methods.append("步骤化表达：公开文本出现顺序或编号线索。")
    if re.search(r"(?:但是|但|然而|却|反而)", observed_text):
        expression_methods.append("转折推进：公开文本出现转折连接词。")
    if "#" in observed_text:
        expression_methods.append("标签扩展：公开文本含平台标签。")

    reusable_methods: list[str] = []
    if opening_hook:
        reusable_methods.append("用自己的真实问题或判断做开场，再用自有事实承接；不复用原文句子。")
    if len(segments) >= 2:
        reusable_methods.append("把自己的内容组织为“开头—推进—收束”，每段只推进一个可验证判断。")
    if expression_methods:
        reusable_methods.append("仅借用已识别的表达机制，替换为自己的案例、证据和措辞。")

    production_notes: list[str] = []
    cover_source = str(facts.get("cover_source") or "")
    cover_label = str(facts.get("cover_label") or "")
    if facts.get("cover_path"):
        production_notes.append(f"主图：{cover_label or '公开视频封面'}已验证并归档到本机预览。")
    elif cover_source == "tikomni_cover" and facts.get("cover_image"):
        production_notes.append("主图：TikOmni 返回公开封面字段，页面会通过受控预览展示。")
    else:
        production_notes.append("主图：当前未返回可验证的封面或视频首帧。")
    if facts.get("video_url"):
        production_notes.append("TikOmni 返回了直接视频地址，可在原内容页人工复核播放。")
    if facts.get("duration_ms"):
        production_notes.append(f"公开时长：{max(1, round(int(facts['duration_ms']) / 1000))} 秒。")
    if facts.get("primary_text_source"):
        production_notes.append(f"可读文本字段：{facts['primary_text_source']}。")

    evidence_limits: list[str] = []
    if not primary_text:
        evidence_limits.append("未取得字幕、ASR 或可读正文，不能可靠还原逐句叙事与表达。")
    if not facts.get("video_url"):
        evidence_limits.append("TikOmni 未返回直接视频地址，需在原来源页面人工核验画面。")
    if not facts.get("duration_ms"):
        evidence_limits.append("TikOmni 未返回公开时长，不能判断节奏或镜头密度。")

    return {
        "status": "ready" if primary_text else "limited",
        "topic": topic,
        "opening_hook": opening_hook,
        "narrative_structure": structure,
        "expression_methods": expression_methods,
        "reusable_methods": reusable_methods,
        "production_notes": production_notes,
        "evidence_limits": evidence_limits,
    }


def missing_fields_for(facts: Mapping[str, Any]) -> list[str]:
    required = (
        "title",
        "author",
        "published_at",
        "metrics",
        "cover_image",
        "video_url",
        "primary_text",
        "duration_ms",
    )
    missing: list[str] = []
    for key in required:
        if not facts.get(key):
            missing.append(key)
    return missing


def has_content_facts(facts: Mapping[str, Any]) -> bool:
    # Author or interaction counts alone do not prove that TikOmni returned a
    # particular public work. At least one work-facing fact is required before
    # the response is persisted as a usable single-video record.
    return bool(facts.get("title") or facts.get("primary_text") or facts.get("cover_image") or facts.get("video_url"))


def normalize_facts(
    *,
    platform: str,
    source_url: str,
    raw_payload: Mapping[str, Any],
    captured_at: str,
) -> dict[str, Any]:
    data = raw_payload.get("data") if isinstance(raw_payload.get("data"), (dict, list)) else raw_payload
    work = choose_work_node(data)
    sources = preferred_video_sources(data, work)

    primary_text, primary_text_source = extract_primary_text(sources)
    title = first_text(sources, ("title", "share_title", "caption_raw", "caption", "desc", "description"), limit=MAX_TITLE_LENGTH)
    author = first_text(
        sources,
        ("author_name", "author", "nickname", "author_nickname", "user_nickname", "creator_name", "user_name"),
        limit=MAX_AUTHOR_LENGTH,
    )
    published_at = normalize_published_at(
        first_value(
            sources,
            (
                "published_at",
                "published_date",
                "publish_date",
                "created_at",
                "create_time",
                "createtime",
                "aweme_create_time",
                "datetime",
            ),
        )
    )
    duration_ms_value = first_value(sources, ("duration_ms", "durationms", "video_duration_ms", "videodurationms"))
    duration_value = duration_ms_value if duration_ms_value is not None else first_value(
        sources,
        ("duration", "video_duration", "videoduration", "video_play_len", "videoplaylen"),
    )
    duration_ms = normalize_duration_ms(duration_value, field_name="duration_ms" if duration_ms_value is not None else "duration")
    metrics = extract_metrics([source for source in sources if isinstance(source, Mapping)])
    cover_image = (
        first_cover_url(sources, ("fullcoverurl",))
        or first_cover_url(sources, ("coverurl", "thumburl"))
        or first_cover_url(sources, ("cover_image", "cover_url", "origin_cover", "dynamic_cover", "cover", "thumbnail", "image"))
    )
    video_url = first_url(
        sources,
        (
            "video_url",
            "videourl",
            "video_download_url",
            "videodownloadurl",
            "video_play_url",
            "videoplayurl",
            "play_url",
            "playurl",
            "play_addr",
            "playaddr",
            "download_addr",
            "downloadaddr",
            "download_url",
            "downloadurl",
            "url",
            "video",
        ),
    )
    facts = {
        "platform": platform,
        "source_url": source_url,
        "title": title,
        "author": author,
        "published_at": published_at,
        "metrics": metrics,
        "cover_image": cover_image,
        **empty_cover_provenance(),
        "video_url": video_url,
        "primary_text": primary_text,
        "primary_text_source": primary_text_source,
        "duration_ms": duration_ms,
        "captured_at": captured_at,
    }
    facts["missing_fields"] = missing_fields_for(facts)
    return facts


def fingerprint_for(facts: Mapping[str, Any]) -> str:
    source = {
        key: facts.get(key)
        for key in (
            "platform",
            "source_url",
            "title",
            "author",
            "published_at",
            "metrics",
            "cover_image",
            "video_url",
            "primary_text",
            "primary_text_source",
            "duration_ms",
            "missing_fields",
        )
    }
    return hashlib.sha256(canonical_bytes(source)).hexdigest()


def enrich_analysis_fields(
    facts: dict[str, Any],
    *,
    root: Path | None = None,
    media_root: Path | None = None,
) -> None:
    """Attach evidence-bounded metadata and one narrow video-channel cover fallback."""
    source_url = str(facts.get("source_url") or "")
    can_read_public_preview = bool(
        facts.get("platform") == "wechat_channels"
        and root is not None
        and media_root is not None
        and wechat_channels_share_id(source_url)
    )
    preview: Mapping[str, Any] = {}
    if can_read_public_preview and (not facts.get("cover_image") or is_redacted_public_value(facts.get("author"))):
        try:
            preview = fetch_wechat_channels_preview(source_url)
            merge_wechat_channels_preview_identity(facts, preview)
        except ViralVideoAdvisorError:
            preview = {}

    if facts.get("cover_image"):
        facts.update({
            "cover_type": "cover",
            "cover_path": "",
            "cover_content_type": "",
            "cover_source": "tikomni_cover",
            "cover_label": "TikOmni 返回封面字段（未下载）",
            "cover_sha256": "",
        })
    elif can_read_public_preview:
        preview_cover = archive_wechat_channels_preview_cover(root, media_root, source_url, preview)
        if preview_cover.get("cover_path"):
            facts.update(preview_cover)
        else:
            facts.update({"cover_type": "", **empty_cover_provenance()})
    else:
        facts.update({"cover_type": "", **empty_cover_provenance()})
    facts["missing_fields"] = missing_fields_for(facts)
    facts["analysis_fields"] = build_analysis_fields(facts)


def unavailable_result(
    *,
    project_id: str,
    platform: str,
    source_url: str,
    captured_at: str,
    attempts: list[dict[str, Any]],
    raw_paths: list[str],
    reason: str,
) -> dict[str, Any]:
    facts: dict[str, Any] = {
        "platform": platform,
        "source_url": source_url,
        "title": "",
        "author": "",
        "published_at": "",
        "metrics": {},
        "cover_image": "",
        **empty_cover_provenance(),
        "video_url": "",
        "primary_text": "",
        "primary_text_source": "",
        "duration_ms": None,
        "captured_at": captured_at,
    }
    facts["missing_fields"] = missing_fields_for(facts)
    facts["analysis_fields"] = build_analysis_fields(facts)
    return {
        "schema": "aifios.benchmark-advisor.single-video.v1",
        "status": "unavailable",
        "project_id": project_id,
        **facts,
        "raw_path": raw_paths[-1] if raw_paths else "",
        "raw_paths": raw_paths,
        "normalized_path": "",
        "attempts": attempts,
        "reason": reason,
        "fingerprint": fingerprint_for(facts),
    }


def collect_single_video(
    project: Path | str,
    project_id_value: str,
    source_url_value: str,
    *,
    bridge: TikomniApiBridge | None = None,
) -> dict[str, Any]:
    """Collect a project-isolated fact record for one public video URL.

    A recognized public URL with a failing provider returns ``status:
    unavailable`` rather than pretending that a video or a viral mechanism was
    found. Invalid URLs and missing credentials are hard input errors and do
    not create an archive.
    """
    root = Path(project).expanduser().resolve(strict=False)
    project_id = safe_project_id(project_id_value)
    source_url = clean_source_url(source_url_value)
    platform = detect_platform(source_url)
    client = bridge or TikomniApiBridge(root)
    health = client.credential_status()
    if not health.get("available"):
        raise ViralVideoAdvisorError("TikOmni 单条视频采集不可用：Token 未配置、无效或不可读。")

    scoped_relative = single_video_root(project_id)
    capture_id = f"{datetime.now().astimezone().strftime('%Y%m%d-%H%M%S-%f')}-{uuid.uuid4().hex[:10]}"
    raw_relative_root = f"{scoped_relative}/raw/{capture_id}"
    # TikomniApiBridge normally writes under materials/tikomni/raw. Rebinding
    # its local raw target before every request keeps every persisted response
    # within this project and this single-video archive.
    client.raw_dir = project_path(root, raw_relative_root)

    captured_at = now()
    attempts: list[dict[str, Any]] = []
    raw_paths: list[str] = []
    selected_facts: dict[str, Any] | None = None
    selected_raw_path = ""

    for endpoint_id, template in DIRECT_VIDEO_ENDPOINTS[platform]:
        try:
            params = catalog_validated_params(client, endpoint_id, template, source_url)
            fetched = client.fetch(
                endpoint_id,
                params,
                platform,
                kind="benchmark-single-video",
                timeout_ms=TIKOMNI_TIMEOUT_MS,
            )
            raw_relative = str(fetched.get("raw_path") or "")
            raw_path = project_path(root, raw_relative)
            expected_prefix = f"{raw_relative_root}/"
            if not raw_relative.startswith(expected_prefix):
                raise ViralVideoAdvisorError("TikOmni 原始证据未写入当前项目的单条视频归档。")
            raw_payload = read_json(raw_path)
            raw_paths.append(relative_to_project(root, raw_path))
            facts = normalize_facts(
                platform=platform,
                source_url=source_url,
                raw_payload=raw_payload,
                captured_at=captured_at,
            )
            attempts.append({
                "endpoint_id": endpoint_id,
                "status": "fetched",
                "raw_path": raw_paths[-1],
                "raw_sha256": sha256_file(raw_path),
            })
            if has_content_facts(facts):
                selected_facts = facts
                selected_raw_path = raw_paths[-1]
                break
            attempts[-1]["status"] = "incomplete"
            attempts[-1]["reason"] = "TikOmni 响应没有可验证的作品正文、封面或视频字段。"
        except Exception as exc:
            attempts.append({
                "endpoint_id": endpoint_id,
                "status": "failed",
                "reason": safe_reason(exc),
            })

    if selected_facts is None:
        reason = "TikOmni 未返回可验证的公开视频内容。"
        failures = [str(item.get("reason") or "") for item in attempts if item.get("reason")]
        if failures:
            reason = f"{reason} {'；'.join(failures[:2])}"
        result = unavailable_result(
            project_id=project_id,
            platform=platform,
            source_url=source_url,
            captured_at=captured_at,
            attempts=attempts,
            raw_paths=raw_paths,
            reason=reason,
        )
        # A successful but semantically empty provider response is still
        # auditable evidence. Keep that exact incomplete record alongside its
        # raw payload; a transport failure with no raw response leaves no
        # archive behind.
        if raw_paths:
            normalized_relative = f"{scoped_relative}/normalized/{capture_id}.json"
            normalized_path = project_path(root, normalized_relative)
            result["normalized_path"] = normalized_relative
            write_new_json(normalized_path, result)
        return result

    enrich_analysis_fields(
        selected_facts,
        root=root,
        media_root=project_path(root, f"{scoped_relative}/media/{capture_id}"),
    )
    selected_facts["fingerprint"] = fingerprint_for(selected_facts)
    result: dict[str, Any] = {
        "schema": "aifios.benchmark-advisor.single-video.v1",
        "status": "available" if not selected_facts["missing_fields"] else "incomplete",
        "project_id": project_id,
        **selected_facts,
        "raw_path": selected_raw_path,
        "raw_paths": raw_paths,
        "normalized_path": "",
        "attempts": attempts,
        "reason": "" if not selected_facts["missing_fields"] else f"TikOmni 公开作品字段不完整：{', '.join(selected_facts['missing_fields'])}。",
    }
    normalized_relative = f"{scoped_relative}/normalized/{capture_id}.json"
    normalized_path = project_path(root, normalized_relative)
    result["normalized_path"] = normalized_relative
    write_new_json(normalized_path, result)
    return result


def cli_error_payload(error: Exception) -> dict[str, Any]:
    return {
        "schema": "aifios.benchmark-advisor.single-video.v1",
        "status": "blocked",
        "error": safe_reason(error),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collect TikOmni public facts for one benchmark video")
    parser.add_argument("--project", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--source-url", required=True)
    args = parser.parse_args(argv)
    try:
        result = collect_single_video(args.project, args.project_id, args.source_url)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        # Emit machine-readable stdout for Node callers while retaining a non-
        # zero exit code for invalid input and absent credentials.
        print(json.dumps(cli_error_payload(exc), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

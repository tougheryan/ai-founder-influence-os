#!/usr/bin/env python3
"""Collect one public content link into a run-scoped TikOmni evidence record.

This is deliberately a short-lived input adapter.  It writes raw provider
responses and normalized facts only below the current content run's
``sessions/`` directory; it never adds a link to a long-lived library or DB.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit

from tikomni_adapter import TikomniApiBridge, clean_text, parse_env_file, parse_number
from viral_video_advisor import (
    DIRECT_VIDEO_ENDPOINTS,
    TIKOMNI_TIMEOUT_MS,
    canonical_bytes,
    catalog_validated_params,
    clean_source_url,
    first_text,
    first_url,
    first_value,
    has_content_facts,
    host_matches,
    iter_dicts,
    normalize_facts,
    normalize_published_at,
    project_path,
    read_json,
    relative_to_project,
    safe_project_id,
    safe_reason,
    sha256_file,
    values_for_keys,
    write_new_json,
)


SCHEMA = "aifios.content-link.v1"
SESSION_ROOT = "sessions/content-link-reads"
WECHAT_ARTICLE_ENDPOINT = "wechat_mp.article_detail.v2.fetch_article_detail"
WECHAT_ARTICLE_PARAMS = {"url": "$source_url", "raw": True}
RUN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")
PUBLIC_SCHEMES = {"http", "https"}


class ContentLinkCollectorError(ValueError):
    """Expected caller, URL, or TikOmni contract failure."""


class _JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ContentLinkCollectorError(f"参数无效：{message}")


def safe_run_id(value: Any) -> str:
    """Accept an opaque run id only when it is safe as one path component."""
    run_id = str(value or "").strip()
    if not RUN_ID_RE.fullmatch(run_id):
        raise ContentLinkCollectorError("run ID 必须是 1-128 位小写字母、数字、连字符或下划线。")
    return run_id


def detect_content_link(source_url: str) -> tuple[str, str]:
    """Return the TikOmni platform and normalized content kind for a URL."""
    parsed = urlsplit(source_url)
    host = str(parsed.hostname or "").lower().rstrip(".")
    path = parsed.path or "/"
    try:
        port = parsed.port
    except ValueError as exc:
        raise ContentLinkCollectorError("平台内容链接端口格式不正确。") from exc
    if port and port not in {80, 443}:
        raise ContentLinkCollectorError("平台内容链接只能使用标准 Web 端口。")
    if host == "mp.weixin.qq.com" and (path == "/s" or path.startswith("/s/")):
        return "wechat_mp", "article"
    if host == "weixin.qq.com" and (path == "/sph" or path.startswith("/sph/")):
        return "wechat_channels", "video"
    if host in {"channels.weixin.qq.com", "finder.video.qq.com"} and path != "/":
        return "wechat_channels", "video"
    if host_matches(host, ("douyin.com", "douyin.cn", "iesdouyin.com")) and path != "/":
        return "douyin", "video"
    if host_matches(host, ("xiaohongshu.com", "xhslink.com", "xhsurl.com")) and path != "/":
        return "xiaohongshu", "note"
    raise ContentLinkCollectorError(
        "该公开链接暂不受 TikOmni 单链接采集支持；请由调用方回退通用网页读取。"
    )


def session_relative_root(project_id: str, run_id: str) -> str:
    return f"{SESSION_ROOT}/{project_id}/{run_id}"


def capture_id() -> str:
    stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
    return f"{stamp}-{uuid.uuid4().hex[:10]}"


def _valid_public_url(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    candidate = value.strip()
    parsed = urlsplit(candidate)
    try:
        port = parsed.port
    except ValueError:
        return ""
    if (
        parsed.scheme.lower() in PUBLIC_SCHEMES
        and parsed.netloc
        and not parsed.username
        and not parsed.password
        and (not port or port in {80, 443})
    ):
        return candidate
    return ""


def first_public_url(sources: Iterable[Any], keys: Iterable[str]) -> str:
    for source in sources:
        for value in values_for_keys(source, keys):
            hit = _valid_public_url(value)
            if hit:
                return hit
    return ""


def article_node_score(item: Mapping[str, Any]) -> int:
    keys = {str(key).lower() for key in item}
    score = 0
    if keys.intersection({"title", "article_title", "headline"}):
        score += 8
    if keys.intersection({"content", "content_html", "article_content", "article_body", "body", "primary_text"}):
        score += 9
    if keys.intersection({"author", "author_name", "nickname", "account_name", "publisher"}):
        score += 3
    if keys.intersection({"url", "canonical_url", "share_url", "source_url"}):
        score += 2
    if keys.intersection({"publish_time", "published_at", "published_date", "create_time"}):
        score += 1
    if keys.intersection({"read_count", "read_num", "like_count", "comment_count", "share_count", "metrics"}):
        score += 1
    return score


def choose_article_node(data: Any) -> dict[str, Any]:
    best: dict[str, Any] = data if isinstance(data, dict) else {}
    best_score = article_node_score(best)
    for item in iter_dicts(data):
        score = article_node_score(item)
        if score > best_score:
            best = item
            best_score = score
    return best


def _body_text(value: Any, *, limit: int = 24_000) -> str:
    if isinstance(value, str):
        # Preserve paragraph boundaries before the shared safe text cleaner
        # removes markup.  The result remains compact plain text for context.
        prepared = re.sub(r"(?is)<\s*/?\s*(?:p|div|li|h[1-6]|br)\b[^>]*>", " ", value)
        return clean_text(prepared)[:limit]
    if isinstance(value, list):
        parts = [_body_text(item, limit=limit) for item in value[:100]]
        return clean_text(" ".join(part for part in parts if part))[:limit]
    if isinstance(value, dict):
        for key in ("content", "text", "body", "html", "article_content", "article_body"):
            if key in value:
                text = _body_text(value[key], limit=limit)
                if text:
                    return text
    return ""


def first_article_body(sources: Iterable[Any]) -> tuple[str, str]:
    routes = (
        ("article_body", ("article_content", "article_body", "content_html", "body_html")),
        ("platform_primary_text", ("primary_text", "content", "body", "html")),
        ("excerpt", ("summary", "excerpt", "description", "desc")),
    )
    source_values = list(sources)
    for source_name, keys in routes:
        for source in source_values:
            for value in values_for_keys(source, keys):
                text = _body_text(value)
                if text:
                    return text, source_name
    return "", ""


def _metric_value(sources: Iterable[Mapping[str, Any]], aliases: Iterable[str]) -> int | None:
    alias_set = {alias.lower() for alias in aliases}
    for source in sources:
        nested_sources: list[Mapping[str, Any]] = [source]
        for key in ("statistics", "stats", "metrics", "interaction", "interactions"):
            child = source.get(key)
            if isinstance(child, dict):
                nested_sources.append(child)
        for item in nested_sources:
            for key, value in item.items():
                if str(key).lower() not in alias_set or value in (None, "") or isinstance(value, bool):
                    continue
                try:
                    parsed = parse_number(value)
                except (TypeError, ValueError):
                    continue
                if parsed >= 0:
                    return parsed
    return None


def extract_article_metrics(sources: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    aliases = {
        "reads": ("read_count", "read_num", "read_num_int", "reads", "view_count", "view_num", "pv", "pageview"),
        "likes": ("like_count", "like_num", "old_like_num", "digg_count", "liked_count", "likes"),
        "comments": ("comment_count", "comments_count", "comment_num", "comments"),
        "shares": ("share_count", "share_num", "shared_count", "repost_count", "shares"),
        "collects": ("collect_count", "collected_count", "bookmark_count", "collects"),
    }
    source_values = list(sources)
    result: dict[str, int] = {}
    for label, keys in aliases.items():
        value = _metric_value(source_values, keys)
        if value is not None:
            result[label] = value
    return result


def normalize_wechat_article(source_url: str, raw_payload: Mapping[str, Any]) -> dict[str, Any]:
    data = raw_payload.get("data") if isinstance(raw_payload.get("data"), (dict, list)) else raw_payload
    article = choose_article_node(data)
    sources: list[Any] = [article]
    if data is not article:
        sources.append(data)

    primary_text, primary_text_source = first_article_body(sources)
    title = first_text(sources, ("title", "article_title", "headline", "share_title"), limit=500)
    author = first_text(
        sources,
        ("author_name", "author", "nickname", "account_name", "publisher", "source_name", "user_name"),
        limit=200,
    )
    published_at = normalize_published_at(
        first_value(
            sources,
            (
                "published_at",
                "published_date",
                "publish_time",
                "publish_date",
                "create_time",
                "created_at",
                "date_time",
            ),
        )
    )
    metrics = extract_article_metrics([source for source in sources if isinstance(source, Mapping)])
    cover_image = first_url(
        sources,
        ("cover_image", "cover_url", "cover", "thumb_url", "thumbnail", "image", "pic_url", "head_img"),
    )
    canonical_url = first_public_url(
        sources,
        ("canonical_url", "share_url", "source_url", "article_url", "detail_url", "link"),
    ) or source_url
    return {
        "canonical_url": canonical_url,
        "title": title,
        "author": author,
        "published_at": published_at,
        "primary_text": primary_text,
        "primary_text_source": primary_text_source,
        "metrics": metrics,
        "cover_image": cover_image,
    }


def missing_fields_for_link(facts: Mapping[str, Any]) -> list[str]:
    required = (
        "canonical_url",
        "title",
        "author",
        "published_at",
        "primary_text",
        "metrics",
        "cover_image",
    )
    return [key for key in required if not facts.get(key)]


def has_article_content(facts: Mapping[str, Any]) -> bool:
    return bool(facts.get("title") or facts.get("primary_text") or facts.get("cover_image"))


def fingerprint_for_link(payload: Mapping[str, Any]) -> str:
    stable = {
        key: payload.get(key)
        for key in (
            "project_id",
            "run_id",
            "platform",
            "content_kind",
            "source_url",
            "canonical_url",
            "title",
            "author",
            "published_at",
            "primary_text",
            "primary_text_source",
            "metrics",
            "cover_image",
            "missing_fields",
        )
    }
    return hashlib.sha256(canonical_bytes(stable)).hexdigest()


def empty_result(
    *,
    status: str,
    project_id: str,
    run_id: str,
    platform: str,
    content_kind: str,
    source_url: str,
    attempts: list[dict[str, Any]],
    raw_paths: list[str],
    reason: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema": SCHEMA,
        "status": status,
        "project_id": project_id,
        "run_id": run_id,
        "platform": platform,
        "content_kind": content_kind,
        "source_url": source_url,
        "canonical_url": source_url,
        "title": "",
        "author": "",
        "published_at": "",
        "primary_text": "",
        "primary_text_source": "",
        "metrics": {},
        "cover_image": "",
        "missing_fields": [],
        "raw_path": raw_paths[-1] if raw_paths else "",
        "raw_paths": raw_paths,
        "normalized_path": "",
        "attempts": attempts,
        "reason": reason,
    }
    result["missing_fields"] = missing_fields_for_link(result)
    result["fingerprint"] = fingerprint_for_link(result)
    return result


def result_from_facts(
    *,
    project_id: str,
    run_id: str,
    platform: str,
    content_kind: str,
    source_url: str,
    facts: Mapping[str, Any],
    raw_path: str,
    raw_paths: list[str],
    attempts: list[dict[str, Any]],
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "incomplete",
        "project_id": project_id,
        "run_id": run_id,
        "platform": platform,
        "content_kind": content_kind,
        "source_url": source_url,
        "canonical_url": str(facts.get("canonical_url") or source_url),
        "title": str(facts.get("title") or ""),
        "author": str(facts.get("author") or ""),
        "published_at": str(facts.get("published_at") or ""),
        "primary_text": str(facts.get("primary_text") or ""),
        "primary_text_source": str(facts.get("primary_text_source") or ""),
        "metrics": dict(facts.get("metrics") or {}),
        "cover_image": str(facts.get("cover_image") or ""),
        "missing_fields": [],
        "raw_path": raw_path,
        "raw_paths": raw_paths,
        "normalized_path": "",
        "attempts": attempts,
        "reason": "",
    }
    result["missing_fields"] = missing_fields_for_link(result)
    # This collector feeds a run-local material-reading workflow. A readable
    # primary text is the availability boundary; cover, dates, or public
    # metrics are useful metadata but must not discard a usable article.
    result["status"] = "available" if result["primary_text"] else "incomplete"
    if result["status"] == "incomplete":
        result["reason"] = f"TikOmni 公开内容字段不完整：{', '.join(result['missing_fields'])}。"
    result["fingerprint"] = fingerprint_for_link(result)
    return result


def _normalize_video_facts(source_url: str, raw_payload: Mapping[str, Any], platform: str) -> dict[str, Any]:
    facts = normalize_facts(
        platform=platform,
        source_url=source_url,
        raw_payload=raw_payload,
        captured_at="",
    )
    data = raw_payload.get("data") if isinstance(raw_payload.get("data"), (dict, list)) else raw_payload
    # Prefer an explicit work URL.  Falling back to the submitted public URL
    # does not invent a redirect or claim that TikOmni resolved one.
    facts["canonical_url"] = first_public_url(
        [data],
        ("canonical_url", "share_url", "source_url", "note_url", "aweme_url", "detail_url"),
    ) or source_url
    return facts


def _scoped_raw_dir(root: Path, scoped_root: str, current_capture_id: str) -> tuple[str, Path]:
    raw_relative_root = f"{scoped_root}/raw/{current_capture_id}"
    return raw_relative_root, project_path(root, raw_relative_root)


def _stored_raw_payload(
    root: Path,
    raw_relative_root: str,
    fetched: Mapping[str, Any],
) -> tuple[str, Path, dict[str, Any]]:
    raw_relative = str(fetched.get("raw_path") or "")
    raw_path = project_path(root, raw_relative)
    if not raw_relative.startswith(f"{raw_relative_root}/"):
        raise ContentLinkCollectorError("TikOmni 原始证据未写入当前 run 的临时归档。")
    raw_payload = read_json(raw_path)
    return relative_to_project(root, raw_path), raw_path, raw_payload


def _write_normalized(root: Path, scoped_root: str, current_capture_id: str, result: dict[str, Any]) -> None:
    normalized_relative = f"{scoped_root}/normalized/{current_capture_id}.json"
    result["normalized_path"] = normalized_relative
    write_new_json(project_path(root, normalized_relative), result)


def _unavailable_reason(attempts: Iterable[Mapping[str, Any]]) -> str:
    failures = [str(item.get("reason") or "") for item in attempts if item.get("reason")]
    if failures:
        return f"TikOmni 未返回可验证的公开内容。 {'；'.join(failures[:2])}"
    return "TikOmni 未返回可验证的公开内容。"


def default_credential_available() -> bool:
    """Check the same local credential locations before resolving the skill.

    ``TikomniApiBridge`` resolves the installed caller in its constructor.  A
    missing local install must not obscure the more actionable Token error for
    a caller that has not configured TikOmni yet.
    """
    if os.getenv("TIKOMNI_API_KEY") or os.getenv("TIKOMNI_API_TOKEN"):
        return True
    configured = os.getenv("AIFIOS_TIKOMNI_ENV_FILE", "").strip()
    env_file = Path(configured).expanduser() if configured else Path(__file__).resolve().parents[3] / ".env.local"
    try:
        values = parse_env_file(env_file.resolve(strict=False))
    except OSError:
        return False
    return bool(values.get("TIKOMNI_API_KEY") or values.get("TIKOMNI_API_TOKEN"))


def _collect_wechat_article(
    root: Path,
    project_id: str,
    run_id: str,
    source_url: str,
    client: TikomniApiBridge,
) -> dict[str, Any]:
    scoped_root = session_relative_root(project_id, run_id)
    current_capture_id = capture_id()
    raw_relative_root, raw_dir = _scoped_raw_dir(root, scoped_root, current_capture_id)
    previous_raw_dir = getattr(client, "raw_dir", None)
    client.raw_dir = raw_dir
    attempts: list[dict[str, Any]] = []
    raw_paths: list[str] = []
    result: dict[str, Any] | None = None
    try:
        try:
            params = catalog_validated_params(client, WECHAT_ARTICLE_ENDPOINT, WECHAT_ARTICLE_PARAMS, source_url)
            fetched = client.fetch(
                WECHAT_ARTICLE_ENDPOINT,
                params,
                "wechat_mp",
                kind="content-link-article",
                timeout_ms=TIKOMNI_TIMEOUT_MS,
            )
            raw_relative, raw_path, raw_payload = _stored_raw_payload(root, raw_relative_root, fetched)
            raw_paths.append(raw_relative)
            facts = normalize_wechat_article(source_url, raw_payload)
            attempts.append({
                "endpoint_id": WECHAT_ARTICLE_ENDPOINT,
                "status": "fetched" if has_article_content(facts) else "incomplete",
                "raw_path": raw_relative,
                "raw_sha256": sha256_file(raw_path),
            })
            if has_article_content(facts):
                result = result_from_facts(
                    project_id=project_id,
                    run_id=run_id,
                    platform="wechat_mp",
                    content_kind="article",
                    source_url=source_url,
                    facts=facts,
                    raw_path=raw_relative,
                    raw_paths=raw_paths,
                    attempts=attempts,
                )
            else:
                attempts[-1]["reason"] = "TikOmni 响应没有可验证的文章正文、标题或封面字段。"
        except Exception as exc:
            attempts.append({
                "endpoint_id": WECHAT_ARTICLE_ENDPOINT,
                "status": "failed",
                "reason": safe_reason(exc),
            })
    finally:
        if previous_raw_dir is not None:
            client.raw_dir = previous_raw_dir

    if result is None:
        result = empty_result(
            status="unavailable",
            project_id=project_id,
            run_id=run_id,
            platform="wechat_mp",
            content_kind="article",
            source_url=source_url,
            attempts=attempts,
            raw_paths=raw_paths,
            reason=_unavailable_reason(attempts),
        )
    if raw_paths:
        _write_normalized(root, scoped_root, current_capture_id, result)
    return result


def _collect_video_link(
    root: Path,
    project_id: str,
    run_id: str,
    source_url: str,
    platform: str,
    content_kind: str,
    client: TikomniApiBridge,
) -> dict[str, Any]:
    scoped_root = session_relative_root(project_id, run_id)
    current_capture_id = capture_id()
    raw_relative_root, raw_dir = _scoped_raw_dir(root, scoped_root, current_capture_id)
    previous_raw_dir = getattr(client, "raw_dir", None)
    client.raw_dir = raw_dir
    attempts: list[dict[str, Any]] = []
    raw_paths: list[str] = []
    result: dict[str, Any] | None = None
    try:
        for endpoint_id, template in DIRECT_VIDEO_ENDPOINTS[platform]:
            try:
                params = catalog_validated_params(client, endpoint_id, template, source_url)
                fetched = client.fetch(
                    endpoint_id,
                    params,
                    platform,
                    kind="content-link-video",
                    timeout_ms=TIKOMNI_TIMEOUT_MS,
                )
                raw_relative, raw_path, raw_payload = _stored_raw_payload(root, raw_relative_root, fetched)
                raw_paths.append(raw_relative)
                facts = _normalize_video_facts(source_url, raw_payload, platform)
                attempts.append({
                    "endpoint_id": endpoint_id,
                    "status": "fetched" if has_content_facts(facts) else "incomplete",
                    "raw_path": raw_relative,
                    "raw_sha256": sha256_file(raw_path),
                })
                if not has_content_facts(facts):
                    attempts[-1]["reason"] = "TikOmni 响应没有可验证的作品正文、封面或视频字段。"
                    continue
                result = result_from_facts(
                    project_id=project_id,
                    run_id=run_id,
                    platform=platform,
                    content_kind=content_kind,
                    source_url=source_url,
                    facts=facts,
                    raw_path=raw_relative,
                    raw_paths=raw_paths,
                    attempts=attempts,
                )
                break
            except Exception as exc:
                attempts.append({
                    "endpoint_id": endpoint_id,
                    "status": "failed",
                    "reason": safe_reason(exc),
                })
    finally:
        if previous_raw_dir is not None:
            client.raw_dir = previous_raw_dir

    if result is None:
        result = empty_result(
            status="unavailable",
            project_id=project_id,
            run_id=run_id,
            platform=platform,
            content_kind=content_kind,
            source_url=source_url,
            attempts=attempts,
            raw_paths=raw_paths,
            reason=_unavailable_reason(attempts),
        )
    if raw_paths:
        _write_normalized(root, scoped_root, current_capture_id, result)
    return result


def collect_content_link(
    project: Path | str,
    project_id_value: str,
    source_url_value: str,
    *,
    run_id: str,
    bridge: TikomniApiBridge | None = None,
) -> dict[str, Any]:
    """Collect one supported public link without retaining it beyond its run."""
    root = Path(project).expanduser().resolve(strict=False)
    project_id = safe_project_id(project_id_value)
    run_id = safe_run_id(run_id)
    source_url = clean_source_url(source_url_value)
    platform, content_kind = detect_content_link(source_url)
    if bridge is None and not default_credential_available():
        raise ContentLinkCollectorError(
            "TikOmni 单链接内容采集不可用：Token 未配置、无效或不可读。"
        )
    client = bridge or TikomniApiBridge(root)
    health = client.credential_status()
    if not health.get("available"):
        raise ContentLinkCollectorError(
            "TikOmni 单链接内容采集不可用：Token 未配置、无效或不可读。"
        )
    if platform == "wechat_mp":
        return _collect_wechat_article(root, project_id, run_id, source_url, client)
    return _collect_video_link(root, project_id, run_id, source_url, platform, content_kind, client)


def cli_error_payload(error: Exception) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "status": "blocked",
        "reason": safe_reason(error),
    }


def main(argv: list[str] | None = None) -> int:
    parser = _JsonArgumentParser(description="Collect one TikOmni public content link into a run-scoped session")
    parser.add_argument("--project", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--source-url", required=True)
    try:
        args = parser.parse_args(argv)
        result = collect_content_link(
            args.project,
            args.project_id,
            args.source_url,
            run_id=args.run_id,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        # Node callers receive structured stdout even when an argument, token,
        # catalog, or unsupported-link error makes the process fail.
        print(json.dumps(cli_error_payload(exc), ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

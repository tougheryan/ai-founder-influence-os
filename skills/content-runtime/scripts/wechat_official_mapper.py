#!/usr/bin/env python3
"""Map official WeChat OA API responses into AIFIOS performance payloads."""
from __future__ import annotations

import re
from typing import Any


SENSITIVE_RE = re.compile(
    r"(?:(?:\+?86[-\s]?)?1[3-9]\d{9}|微信(?:号)?[:：]?\s*[A-Za-z0-9_-]{5,}|"
    r"weixin[:：]?\s*[A-Za-z0-9_-]{5,}|wx[:：]?\s*[A-Za-z0-9_-]{5,})",
    re.IGNORECASE,
)


def _number(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(float(str(value or "0")))
    except ValueError:
        return 0


def _first_news_item(article_response: dict[str, Any]) -> dict[str, Any]:
    for key in ["news_item", "item", "articles"]:
        items = article_response.get(key)
        if isinstance(items, list) and items:
            return dict(items[0] or {})
    detail = article_response.get("article_detail")
    if isinstance(detail, dict):
        items = detail.get("item") or detail.get("news_item")
        if isinstance(items, list) and items:
            return dict(items[0] or {})
    return {}


def _total_detail(total_response: dict[str, Any], title: str, msg_data_id: str) -> dict[str, Any]:
    rows = total_response.get("list") if isinstance(total_response, dict) else []
    if not isinstance(rows, list):
        return {}
    matched = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        if msg_data_id and str(row.get("msgid") or row.get("msg_data_id") or "") == str(msg_data_id):
            matched = row
            break
        if title and str(row.get("title") or "").strip() == title:
            matched = row
            break
    if matched is None and rows:
        matched = rows[0]
    if not isinstance(matched, dict):
        return {}
    details = matched.get("details")
    if isinstance(details, list) and details:
        return dict(details[-1] or {})
    return dict(matched)


def _mask(value: str) -> str:
    return SENSITIVE_RE.sub("[已脱敏]", str(value or "").strip())


def _comments(comments_response: dict[str, Any]) -> list[dict[str, Any]]:
    rows = comments_response.get("comment") or comments_response.get("comments") or []
    if not isinstance(rows, list):
        return []
    normalized = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        content = _mask(row.get("content") or row.get("text") or "")
        if not content:
            continue
        normalized.append({
            "content": content,
            "likes": _number(row.get("like_num", row.get("likes", 0))),
            "type": "selected" if row.get("is_elected") else "sample",
        })
    return normalized


def normalize_wechat_official_payload(
    *,
    slug: str,
    article_id: str,
    msg_data_id: str,
    published_at: str,
    captured_at: str,
    article_response: dict[str, Any],
    total_response: dict[str, Any],
    summary_response: dict[str, Any],
    comments_response: dict[str, Any],
    raw_path: str,
) -> dict[str, Any]:
    news_item = _first_news_item(article_response)
    title = str(news_item.get("title") or article_response.get("title") or "").strip()
    publish_url = str(news_item.get("url") or article_response.get("url") or "").strip()
    detail = _total_detail(total_response, title, msg_data_id)
    comment_samples = _comments(comments_response)
    reads = _number(detail.get("int_page_read_count")) + _number(detail.get("ori_page_read_count"))
    readers = _number(detail.get("int_page_read_user")) + _number(detail.get("ori_page_read_user"))
    metrics = {
        "reads": reads,
        "readers": readers,
        "shares": _number(detail.get("share_count")),
        "collects": _number(detail.get("add_to_fav_count")),
        "comments": len(comment_samples),
    }
    metrics = {key: value for key, value in metrics.items() if value > 0 or key == "comments"}
    anomalies = []
    if not detail:
        anomalies.append("datacube_total_missing_or_unmatched")
    if not comment_samples:
        anomalies.append("comments_empty_or_unavailable")
    return {
        "platform": "wechat-official-account",
        "source": "wechat-official-api",
        "authorization_mode": "self-account",
        "slug": slug,
        "article_id": article_id,
        "msg_data_id": msg_data_id,
        "title": title,
        "publish_url": publish_url,
        "published_at": published_at,
        "captured_at": captured_at,
        "metrics": metrics,
        "metric_definitions": {
            "reads": "官方图文统计中阅读次数口径，int_page_read_count + ori_page_read_count",
            "readers": "官方图文统计中阅读人数口径，int_page_read_user + ori_page_read_user",
            "shares": "官方图文统计中分享转发次数 share_count",
            "collects": "官方图文统计中收藏次数 add_to_fav_count",
            "comments": "官方留言接口本次返回的有效留言样本数",
        },
        "unsupported_metrics": {
            "exposures": "官方图文统计接口未稳定提供完整曝光口径",
            "likes": "本阶段不从非官方页面推断点赞",
            "wows": "本阶段不从非官方页面推断在看",
        },
        "comment_samples": comment_samples,
        "anomalies": anomalies,
        "raw_path": raw_path,
        "raw_sources": {
            "article_response": bool(article_response),
            "total_response": bool(total_response),
            "summary_response": bool(summary_response),
            "comments_response": bool(comments_response),
        },
    }

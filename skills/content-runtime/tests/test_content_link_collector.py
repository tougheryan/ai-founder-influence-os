from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from content_link_collector import (
    ContentLinkCollectorError,
    collect_content_link,
    main,
)


class FakeTikOmniBridge:
    def __init__(
        self,
        project: Path,
        payloads: list[dict],
        *,
        available: bool = True,
        fail_all: bool = False,
    ) -> None:
        self.project = project
        self.payloads = list(payloads)
        self.available = available
        self.fail_all = fail_all
        self.raw_dir = project / "not-used"
        self.calls: list[tuple[str, dict[str, object], str, str]] = []

    def credential_status(self) -> dict[str, bool]:
        return {"available": self.available}

    def endpoint_input_schema(self, endpoint_id: str) -> dict:
        if endpoint_id == "wechat_mp.article_detail.v2.fetch_article_detail":
            return {
                "properties": {"url": {"type": "string"}, "raw": {"type": "boolean"}},
                "required": ["url"],
            }
        if endpoint_id.startswith("douyin."):
            return {"properties": {"share_url": {"type": "string"}}, "required": ["share_url"]}
        if endpoint_id.startswith("xiaohongshu."):
            return {"properties": {"share_text": {"type": "string"}}, "required": []}
        if endpoint_id.startswith("wechat_channels."):
            return {
                "properties": {"share_url": {"type": "string"}, "raw": {"type": "boolean"}},
                "required": [],
            }
        raise AssertionError(f"unexpected endpoint: {endpoint_id}")

    def fetch(
        self,
        endpoint_id: str,
        params: dict[str, object],
        platform: str,
        kind: str = "raw",
        timeout_ms: int | None = None,
    ) -> dict:
        self.calls.append((endpoint_id, params, platform, kind))
        if self.fail_all:
            raise RuntimeError("provider unavailable")
        payload = self.payloads.pop(0)
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = self.raw_dir / f"{len(self.calls)}.json"
        raw_path.write_text(json.dumps({"data": payload}, ensure_ascii=False), encoding="utf-8")
        return {"raw_path": raw_path.relative_to(self.project).as_posix()}


def test_collects_a_wechat_article_into_run_scoped_session_storage(tmp_path: Path) -> None:
    source_url = "https://mp.weixin.qq.com/s?fixture=article"
    bridge = FakeTikOmniBridge(tmp_path, [{
        "article_detail": {
            "canonical_url": "https://mp.weixin.qq.com/s?fixture=canonical",
            "title": "客户问题比自我介绍更重要",
            "author_name": "公开作者",
            "publish_time": "2026-07-21 09:30",
            "content_html": "<p>先说清客户卡在哪里。</p><p>再解释方案如何承接。</p>",
            "read_count": "1.2w",
            "like_count": 42,
            "comment_count": 7,
            "share_count": 13,
            "cover_url": "https://cdn.example.test/article-cover.jpg",
        },
    }])

    result = collect_content_link(
        tmp_path,
        "client_alpha",
        source_url,
        run_id="current-run-001",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert bridge.calls == [(
        "wechat_mp.article_detail.v2.fetch_article_detail",
        {"url": source_url, "raw": True},
        "wechat_mp",
        "content-link-article",
    )]
    assert result["schema"] == "aifios.content-link.v1"
    assert result["status"] == "available"
    assert result["project_id"] == "client_alpha"
    assert result["run_id"] == "current-run-001"
    assert result["platform"] == "wechat_mp"
    assert result["content_kind"] == "article"
    assert result["canonical_url"] == "https://mp.weixin.qq.com/s?fixture=canonical"
    assert result["title"] == "客户问题比自我介绍更重要"
    assert result["author"] == "公开作者"
    assert result["primary_text"] == "先说清客户卡在哪里。 再解释方案如何承接。"
    assert result["primary_text_source"] == "article_body"
    assert result["metrics"] == {"reads": 12000, "likes": 42, "comments": 7, "shares": 13}
    assert result["cover_image"] == "https://cdn.example.test/article-cover.jpg"
    assert result["missing_fields"] == []
    assert len(result["fingerprint"]) == 64
    assert result["raw_path"].startswith("sessions/content-link-reads/client_alpha/current-run-001/raw/")
    assert result["normalized_path"].startswith("sessions/content-link-reads/client_alpha/current-run-001/normalized/")
    assert str(tmp_path) not in result["raw_path"]
    assert (tmp_path / result["raw_path"]).is_file()
    normalized = tmp_path / result["normalized_path"]
    assert normalized.is_file()
    assert json.loads(normalized.read_text(encoding="utf-8"))["run_id"] == "current-run-001"
    assert not (tmp_path / "materials").exists()


def test_video_without_primary_text_is_incomplete_not_available(tmp_path: Path) -> None:
    source_url = "https://v.douyin.com/fixture-work/"
    bridge = FakeTikOmniBridge(tmp_path, [{
        "aweme_detail": {
            "aweme_id": "7490000000000000000",
            "title": "客户问题比自我介绍更重要",
            "author": {"nickname": "公开视频作者"},
            "create_time": 1_784_302_400,
            "statistics": {"play_count": 12345, "digg_count": 234, "comment_count": 18, "share_count": 31},
            "video": {
                "duration": 17,
                "cover": {"url_list": ["https://cdn.example.test/cover.jpg"]},
                "play_addr": {"url_list": ["https://cdn.example.test/video.mp4"]},
            },
        },
    }])

    result = collect_content_link(
        tmp_path,
        "client_alpha",
        source_url,
        run_id="current-run-002",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert result["platform"] == "douyin"
    assert result["content_kind"] == "video"
    assert result["status"] == "incomplete"
    assert result["primary_text"] == ""
    assert result["primary_text_source"] == ""
    assert "primary_text" in result["missing_fields"]
    assert result["attempts"][0]["status"] == "fetched"
    assert result["raw_path"].startswith("sessions/content-link-reads/client_alpha/current-run-002/raw/")
    assert (tmp_path / result["normalized_path"]).is_file()
    assert not (tmp_path / "materials").exists()


def test_article_with_readable_body_remains_available_when_optional_metadata_is_missing(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path, [{
        "article_detail": {
            "title": "只保留正文的公开文章",
            "content": "这段正文仍然可以作为本期素材理解的输入。",
        },
    }])

    result = collect_content_link(
        tmp_path,
        "client_alpha",
        "https://mp.weixin.qq.com/s?fixture=body-only",
        run_id="current-run-optional-metadata",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert result["status"] == "available"
    assert result["primary_text"] == "这段正文仍然可以作为本期素材理解的输入。"
    assert {"author", "published_at", "metrics", "cover_image"}.issubset(result["missing_fields"])


def test_xiaohongshu_is_normalized_as_note_in_the_same_session_scope(tmp_path: Path) -> None:
    source_url = "https://www.xiaohongshu.com/explore/fixture-note"
    bridge = FakeTikOmniBridge(tmp_path, [{
        "note": {
            "note_id": "fixture-note",
            "title": "一个可验证的内容判断",
            "desc": "先从客户卡点开始，而不是堆砌个人履历。",
            "user": {"nickname": "公开作者"},
            "create_time": 1_784_302_400,
            "liked_count": 120,
            "comments_count": 8,
            "images_list": [{"url": "https://cdn.example.test/note-cover.jpg"}],
        },
    }])

    result = collect_content_link(
        tmp_path,
        "client_alpha",
        source_url,
        run_id="current-run-003",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert result["platform"] == "xiaohongshu"
    assert result["content_kind"] == "note"
    assert result["primary_text"] == "先从客户卡点开始，而不是堆砌个人履历。"
    assert result["primary_text_source"] == "caption"
    assert result["raw_path"].startswith("sessions/content-link-reads/client_alpha/current-run-003/raw/")
    assert not (tmp_path / "materials").exists()


def test_missing_token_blocks_before_any_session_archive_is_created(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path, [], available=False)

    with pytest.raises(ContentLinkCollectorError, match="Token"):
        collect_content_link(
            tmp_path,
            "client_alpha",
            "https://mp.weixin.qq.com/s?fixture=article",
            run_id="current-run-004",
            bridge=bridge,  # type: ignore[arg-type]
        )

    assert not (tmp_path / "sessions").exists()


def test_unavailable_provider_response_is_an_honest_empty_result(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path, [], fail_all=True)

    result = collect_content_link(
        tmp_path,
        "client_alpha",
        "https://v.douyin.com/fixture-work/",
        run_id="current-run-005",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert result["status"] == "unavailable"
    assert result["title"] == ""
    assert result["primary_text"] == ""
    assert result["raw_path"] == ""
    assert result["normalized_path"] == ""
    assert len(result["attempts"]) == 2
    assert all(item["status"] == "failed" for item in result["attempts"])
    assert "provider unavailable" in result["reason"]
    assert not (tmp_path / "sessions").exists()


def test_unsupported_links_do_not_try_tikomni_or_create_session_files(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path, [])

    with pytest.raises(ContentLinkCollectorError, match="通用网页读取"):
        collect_content_link(
            tmp_path,
            "client_alpha",
            "https://example.com/articles/one",
            run_id="current-run-006",
            bridge=bridge,  # type: ignore[arg-type]
        )

    assert bridge.calls == []
    assert not (tmp_path / "sessions").exists()


def test_cli_returns_json_stdout_and_nonzero_for_invalid_or_missing_required_input(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main([
        "--project", "/tmp/project",
        "--project-id", "client_alpha",
        "--source-url", "https://example.com/articles/one",
    ])

    output = json.loads(capsys.readouterr().out)
    assert exit_code == 1
    assert output["schema"] == "aifios.content-link.v1"
    assert output["status"] == "blocked"
    assert "run-id" in output["reason"]

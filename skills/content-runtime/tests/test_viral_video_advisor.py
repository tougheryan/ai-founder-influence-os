from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import viral_video_advisor as viral_video_advisor_module
from viral_video_advisor import ViralVideoAdvisorError, collect_single_video


class FakeTikOmniBridge:
    def __init__(
        self,
        project: Path,
        *,
        available: bool = True,
        fail_first: bool = False,
        fail_all: bool = False,
        include_cover: bool = True,
        video_url: str = "https://cdn.example.test/video.mp4",
        caption: str = "先给一个具体问题，再说明为什么它值得处理。",
        payload: dict | None = None,
    ):
        self.project = project
        self.available = available
        self.fail_first = fail_first
        self.fail_all = fail_all
        self.include_cover = include_cover
        self.video_url = video_url
        self.caption = caption
        self.payload = payload
        self.raw_dir = project / "not-used"
        self.calls: list[tuple[str, dict[str, object], str]] = []
        self.resolve_endpoint_options_called = False

    def credential_status(self) -> dict[str, bool]:
        return {"available": self.available}

    def resolve_endpoint_options(self, *_: object) -> dict:
        self.resolve_endpoint_options_called = True
        raise AssertionError("single-video collector must not use the generic account resolver")

    def endpoint_input_schema(self, endpoint_id: str) -> dict:
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
        self.calls.append((endpoint_id, params, platform))
        if self.fail_all or (self.fail_first and len(self.calls) == 1):
            raise RuntimeError("first endpoint unavailable")
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = self.raw_dir / f"{len(self.calls)}.json"
        if self.payload is None:
            video = {
                "duration": 17,
                "play_addr": {"url_list": [self.video_url]},
            }
            if self.include_cover:
                video["cover"] = {"url_list": ["https://cdn.example.test/cover.jpg"]}
            payload = {
                "aweme_detail": {
                    "aweme_id": "7490000000000000000",
                    "desc": self.caption,
                    "author": {"nickname": "公开作者"},
                    "create_time": 1_784_302_400,
                    "statistics": {
                        "play_count": 12345,
                        "digg_count": 234,
                        "comment_count": 18,
                        "share_count": 31,
                    },
                    "video": video,
                },
            }
        else:
            payload = self.payload
        raw_path.write_text(json.dumps({"data": payload}, ensure_ascii=False), encoding="utf-8")
        return {"raw_path": raw_path.relative_to(self.project).as_posix()}


def test_collects_direct_douyin_work_facts_into_the_project_scoped_single_video_archive(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path)

    result = collect_single_video(
        tmp_path,
        "client_alpha",
        "https://v.douyin.com/fixture-work/",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert bridge.calls == [(
        "douyin.user_profile.app_v3.fetch_one_video_by_share_url",
        {"share_url": "https://v.douyin.com/fixture-work/"},
        "douyin",
    )]
    assert not bridge.resolve_endpoint_options_called
    assert result["status"] == "available"
    assert result["platform"] == "douyin"
    assert result["title"] == "先给一个具体问题，再说明为什么它值得处理。"
    assert result["author"] == "公开作者"
    assert result["duration_ms"] == 17_000
    assert result["metrics"] == {"plays": 12345, "likes": 234, "comments": 18, "shares": 31}
    assert result["cover_image"] == "https://cdn.example.test/cover.jpg"
    assert result["cover_source"] == "tikomni_cover"
    assert result["cover_label"] == "TikOmni 返回封面字段（未下载）"
    assert result["cover_path"] == ""
    assert result["video_url"] == "https://cdn.example.test/video.mp4"
    assert result["primary_text_source"] == "caption"
    assert result["missing_fields"] == []
    assert len(result["fingerprint"]) == 64
    assert result["raw_path"].startswith("materials/advisors/benchmark/client_alpha/single-video/raw/")
    assert result["normalized_path"].startswith("materials/advisors/benchmark/client_alpha/single-video/normalized/")
    assert (tmp_path / result["raw_path"]).is_file()
    assert (tmp_path / result["normalized_path"]).is_file()
    assert not (tmp_path / "materials" / "tikomni").exists()


def test_keeps_missing_cover_explicit_when_the_public_preview_has_no_cover(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(viral_video_advisor_module, "fetch_wechat_channels_preview", lambda _url: {})
    bridge = FakeTikOmniBridge(tmp_path, payload={
        "data": {
            "nickname": "视频号公开作者",
            "createtime": 1_784_302_400,
            "likeCount": 74,
            "commentCount": 10,
            "favCount": 106,
            "forwardCount": 173,
            "objectDesc": {
                "description": "先问一个具体问题？再补充自己的案例。但是不要复用原文。最后给出行动。",
                "media": [{
                    "fullCoverUrl": "https://wxapp.tc.qq.com/[已脱敏].jpg",
                    "url": "https://finder.video.qq.com/fixture-video.mp4",
                    "videoPlayLen": 17,
                }],
            },
        },
    })
    result = collect_single_video(
        tmp_path,
        "client_alpha",
        "https://weixin.qq.com/sph/fixture-video",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert result["status"] == "incomplete"
    assert result["cover_image"] == ""
    assert result["cover_source"] == ""
    assert result["cover_label"] == ""
    assert result["cover_content_type"] == ""
    assert result["cover_path"] == ""
    assert result["cover_sha256"] == ""
    assert "cover_image" in result["missing_fields"]
    assert not (tmp_path / "materials" / "advisors" / "benchmark" / "client_alpha" / "single-video" / "media").exists()

    analysis = result["analysis_fields"]
    assert analysis["status"] == "ready"
    assert analysis["topic"] == "先问一个具体问题？再补充自己的案例。但是不要复用原文。最后给出行动。"
    assert analysis["opening_hook"] == "先问一个具体问题？"
    assert len(analysis["narrative_structure"]) == 4
    assert any("问题式开场" in item for item in analysis["expression_methods"])
    assert any("转折推进" in item for item in analysis["expression_methods"])
    assert analysis["reusable_methods"]
    assert analysis["production_notes"][0] == "主图：当前未返回可验证的封面或视频首帧。"

    normalized = json.loads((tmp_path / result["normalized_path"]).read_text(encoding="utf-8"))
    assert normalized["cover_image"] == ""
    assert normalized["cover_path"] == ""
    assert normalized["cover_source"] == ""
    assert normalized["cover_label"] == ""
    assert normalized["analysis_fields"] == analysis


def test_archives_a_video_channel_public_preview_cover_when_tikomni_cover_is_redacted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preview_cover = "https://finder.video.qq.com/251/20304/stodownload?fixture=cover"
    payload = b"\xff\xd8\xfffixture-preview-cover"
    downloads: list[str] = []
    monkeypatch.setattr(
        viral_video_advisor_module,
        "fetch_wechat_channels_preview",
        lambda _url: {
            "authorInfo": {"nickname": "公开视频作者"},
            "feedInfo": {"coverUrl": preview_cover},
        },
    )

    def fake_download(url: str) -> tuple[bytes, str]:
        downloads.append(url)
        return payload, "image/jpeg"

    monkeypatch.setattr(viral_video_advisor_module, "download_public_cover", fake_download)
    bridge = FakeTikOmniBridge(tmp_path, payload={
        "data": {
            "nickname": "[已脱敏]",
            "objectDesc": {
                "description": "从一个具体问题进入，再给出自己的案例和行动。",
                "media": [{
                    "fullCoverUrl": "https://wxapp.tc.qq.com/[已脱敏].jpg",
                    "url": "https://finder.video.qq.com/fixture-video.mp4",
                    "videoPlayLen": 17,
                }],
            },
        },
    })

    result = collect_single_video(
        tmp_path,
        "client_alpha",
        "https://weixin.qq.com/sph/fixture-video",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert downloads == [preview_cover]
    assert result["cover_image"] == preview_cover
    assert result["author"] == "公开视频作者"
    assert result["cover_type"] == "cover"
    assert result["cover_source"] == "wechat_channels_public_preview"
    assert result["cover_label"] == "视频号公开预览封面"
    assert result["cover_content_type"] == "image/jpeg"
    assert len(result["cover_sha256"]) == 64
    assert result["cover_path"].startswith("materials/advisors/benchmark/client_alpha/single-video/media/")
    assert (tmp_path / result["cover_path"]).read_bytes() == payload
    assert "cover_image" not in result["missing_fields"]
    assert "主图：视频号公开预览封面已验证并归档到本机预览。" in result["analysis_fields"]["production_notes"]


def test_fills_a_redacted_author_from_the_public_preview_without_replacing_a_usable_tikomni_cover(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preview_calls: list[str] = []

    def fake_preview(url: str) -> dict[str, object]:
        preview_calls.append(url)
        return {"authorInfo": {"nickname": "公开作者"}, "feedInfo": {"coverUrl": "https://finder.video.qq.com/unused.jpg"}}

    monkeypatch.setattr(viral_video_advisor_module, "fetch_wechat_channels_preview", fake_preview)
    bridge = FakeTikOmniBridge(tmp_path, payload={
        "data": {
            "nickname": "[已脱敏]",
            "objectDesc": {
                "description": "公开描述。",
                "media": [{
                    "fullCoverUrl": "https://wxapp.tc.qq.com/usable-cover.jpg",
                    "url": "https://finder.video.qq.com/fixture-video.mp4",
                }],
            },
        },
    })

    result = collect_single_video(
        tmp_path,
        "client_alpha",
        "https://weixin.qq.com/sph/fixture-video",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert preview_calls == ["https://weixin.qq.com/sph/fixture-video"]
    assert result["author"] == "公开作者"
    assert result["cover_image"] == "https://wxapp.tc.qq.com/usable-cover.jpg"
    assert result["cover_source"] == "tikomni_cover"
    assert result["cover_path"] == ""


def test_does_not_request_the_public_preview_for_noncanonical_channel_urls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preview_calls: list[str] = []

    def unexpected_preview(url: str) -> dict[str, object]:
        preview_calls.append(url)
        raise AssertionError("only exact weixin.qq.com/sph/<id> links may request the preview")

    monkeypatch.setattr(viral_video_advisor_module, "fetch_wechat_channels_preview", unexpected_preview)
    bridge = FakeTikOmniBridge(tmp_path, payload={
        "data": {
            "objectDesc": {
                "description": "有公开文本，但没有可验证封面。",
                "media": [{"fullCoverUrl": "https://wxapp.tc.qq.com/[已脱敏].jpg"}],
            },
        },
    })

    result = collect_single_video(
        tmp_path,
        "client_alpha",
        "https://channels.weixin.qq.com/finder-preview/pages/sph?id=fixture-video",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert result["cover_path"] == ""
    assert preview_calls == []


def test_prefers_wechat_channel_media_fields_over_contact_live_cover_and_normalizes_camel_case(tmp_path: Path) -> None:
    full_cover = "https://wxapp.tc.qq.com/full-cover.jpg?fixture=full"
    bridge = FakeTikOmniBridge(tmp_path, payload={
        "data": {
            "nickname": "视频号公开作者",
            "createtime": 1_784_302_400,
            "likeCount": 74,
            "commentCount": 10,
            "favCount": 106,
            "forwardCount": 173,
            "contact": {
                "coverUrl": "https://wxapp.tc.qq.com/contact-live-cover.jpg?fixture=wrong",
                "liveCoverImgs": [{"url": "https://wxapp.tc.qq.com/contact-live-cover-2.jpg?fixture=wrong"}],
            },
            "objectDesc": {
                "description": "先抛出一个问题？再给出自身案例。但是不复制任何原文。最后收束为行动。",
                "media": [{
                    "fullCoverUrl": full_cover,
                    "coverUrl": "https://wxapp.tc.qq.com/cover.jpg?fixture=lower-priority",
                    "thumbUrl": "https://wxapp.tc.qq.com/thumb.jpg?fixture=lower-priority",
                    "url": "https://wxapp.tc.qq.com/direct-video.mp4?fixture=video",
                    "videoPlayLen": 175,
                }],
            },
        },
    })
    result = collect_single_video(
        tmp_path,
        "client_alpha",
        "https://weixin.qq.com/sph/fixture-video",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert result["author"] == "视频号公开作者"
    assert result["published_at"] == "2026-07-17T15:33:20Z"
    assert result["metrics"] == {"likes": 74, "comments": 10, "shares": 173, "collects": 106}
    assert result["cover_image"] == full_cover
    assert "contact-live-cover" not in result["cover_image"]
    assert result["video_url"] == "https://wxapp.tc.qq.com/direct-video.mp4?fixture=video"
    assert result["duration_ms"] == 175_000
    assert result["missing_fields"] == []
    assert result["cover_path"] == ""
    assert result["cover_content_type"] == ""
    assert result["cover_sha256"] == ""
    analysis = result["analysis_fields"]
    assert analysis["topic"] == "先抛出一个问题？再给出自身案例。但是不复制任何原文。最后收束为行动。"
    assert analysis["opening_hook"] == "先抛出一个问题？"
    assert analysis["narrative_structure"]
    assert analysis["expression_methods"]
    assert analysis["reusable_methods"]
    assert analysis["production_notes"]


def test_retries_the_catalogued_douyin_fallback_without_using_the_account_resolver(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path, fail_first=True)

    result = collect_single_video(
        tmp_path,
        "client_alpha",
        "https://www.douyin.com/video/7490000000000000000",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert [call[0] for call in bridge.calls] == [
        "douyin.user_profile.app_v3.fetch_one_video_by_share_url",
        "douyin.video_detail.web.fetch_one_video_by_share_url",
    ]
    assert not bridge.resolve_endpoint_options_called
    assert result["status"] == "available"
    assert result["attempts"][0]["status"] == "failed"
    assert result["attempts"][1]["status"] == "fetched"


def test_rejects_unknown_or_non_channel_wechat_urls_without_creating_an_archive(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path)

    with pytest.raises(ViralVideoAdvisorError, match="仅支持公开"):
        collect_single_video(tmp_path, "client_alpha", "https://example.com/video/1", bridge=bridge)  # type: ignore[arg-type]
    with pytest.raises(ViralVideoAdvisorError, match="不是可识别的视频号"):
        collect_single_video(tmp_path, "client_alpha", "https://weixin.qq.com/s/article", bridge=bridge)  # type: ignore[arg-type]

    assert not (tmp_path / "materials" / "advisors").exists()


def test_missing_tikomni_credential_blocks_before_writing_single_video_outputs(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path, available=False)

    with pytest.raises(ViralVideoAdvisorError, match="Token"):
        collect_single_video(
            tmp_path,
            "client_alpha",
            "https://www.xiaohongshu.com/explore/fixture-video",
            bridge=bridge,  # type: ignore[arg-type]
        )

    assert not (tmp_path / "materials" / "advisors").exists()


def test_returns_an_explicit_unavailable_result_when_all_factual_endpoints_fail(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path, fail_all=True)

    result = collect_single_video(
        tmp_path,
        "client_alpha",
        "https://v.douyin.com/fixture-work/",
        bridge=bridge,  # type: ignore[arg-type]
    )

    assert result["status"] == "unavailable"
    assert result["title"] == ""
    assert result["primary_text"] == ""
    assert result["raw_path"] == ""
    assert result["normalized_path"] == ""
    assert len(result["attempts"]) == 2
    assert all(item["status"] == "failed" for item in result["attempts"])
    assert not (tmp_path / "materials" / "advisors").exists()

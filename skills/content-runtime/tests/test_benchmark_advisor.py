from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import benchmark_advisor as benchmark_advisor_module
from benchmark_advisor import (
    BenchmarkAdvisorCollectionError,
    canonical_cover_content_type,
    collect_project_accounts,
    cover_url_parts,
    cover_bytes_match_content_type,
    analyze_work_structure,
    normalize_works,
)


class FakeTikOmniBridge:
    def __init__(self, project: Path, available: bool = True, cover_url: str = ""):
        self.project = project
        self.available = available
        self.cover_url = cover_url
        self.calls: list[tuple[str, dict]] = []

    def credential_status(self) -> dict:
        return {"available": self.available}

    def resolve_endpoint_options(self, platform: str, capability: str) -> dict:
        endpoint = f"{platform}.{capability}.fixture"
        return {
            "platform": platform,
            "capability": capability,
            "recommended": {"endpoint_id": endpoint},
            "alternatives": [],
        }

    def endpoint_input_schema(self, endpoint_id: str) -> dict:
        if endpoint_id.endswith("user_profile.fixture"):
            return {"properties": {"user_id": {"type": "string"}}, "required": ["user_id"]}
        if endpoint_id.endswith("user_posts.fixture"):
            return {"properties": {"user_id": {"type": "string"}}, "required": ["user_id"]}
        if endpoint_id.endswith("article_list.fixture"):
            return {"properties": {"ghid": {"type": "string"}}, "required": ["ghid"]}
        return {"properties": {}, "required": []}

    def fetch(self, endpoint_id: str, params: dict, platform: str, kind: str = "raw") -> dict:
        self.calls.append((endpoint_id, params))
        raw_dir = self.project / "materials" / "tikomni" / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = raw_dir / f"{len(self.calls)}.json"
        handle = params.get("user_id") or params.get("ghid") or "unknown"
        if endpoint_id.endswith("user_posts.fixture") or endpoint_id.endswith("article_list.fixture"):
            data = {
                "items": [{
                    "platform_author_id": handle,
                    "author": "公开账号",
                    "title": "不要只讲结论，先给具体问题",
                    "desc": "用客户场景和方法清单承接讨论。",
                    "url": f"https://example.test/{handle}/work-1",
                    "like_count": 30,
                    "comment_count": 6,
                    "created_at": "2026-07-15T09:00:00+08:00",
                }],
            }
            if self.cover_url:
                data["items"][0]["video_info_v2"] = {
                    "image": {"first_frame": self.cover_url},
                    "media": {"stream": {"h264": [{"master_url": "https://sns-v11.rednotecdn.com/public-video.mp4"}]}},
                }
        else:
            data = {"user_id": handle, "follower_count": 99}
        raw_path.write_text(json.dumps({"data": data}, ensure_ascii=False), encoding="utf-8")
        return {"raw_path": raw_path.relative_to(self.project).as_posix()}


def xhs_account() -> dict:
    return {
        "id": "benchmark_a1b2c3d4e5f6",
        "label": "公开增长观察",
        "handle": "xhs-user-001",
        "platform": "xiaohongshu",
        "publicUrl": "https://www.xiaohongshu.com/user/profile/xhs-user-001",
    }


def test_collects_each_account_through_resolver_and_persists_project_isolated_raw_and_normalized_evidence(tmp_path: Path) -> None:
    bridge = FakeTikOmniBridge(tmp_path)

    result = collect_project_accounts(tmp_path, "client_alpha", [xhs_account()], bridge=bridge)

    assert [endpoint for endpoint, _ in bridge.calls] == [
        "xiaohongshu.user_profile.fixture",
        "xiaohongshu.user_posts.fixture",
    ]
    assert result["project_id"] == "client_alpha"
    assert result["snapshot_path"].startswith("materials/advisors/benchmark/client_alpha/snapshots/")
    assert result["normalized_path"].startswith("materials/advisors/benchmark/client_alpha/normalized/")
    account = result["accounts"][0]
    assert account["status"] == "available"
    assert account["profile"]["status"] == "available"
    assert account["works"]["status"] == "available"
    assert account["works"]["items"][0]["source_url"] == "https://example.test/xhs-user-001/work-1"
    assert account["works"]["items"][0]["title"] == "不要只讲结论，先给具体问题"
    assert account["works"]["items"][0]["author"] == "公开账号"
    assert account["works"]["items"][0]["primary_text"].startswith("用客户场景")
    assert account["works"]["items"][0]["opening_mechanisms"]
    assert account["works"]["items"][0]["structure_analysis"]["status"] == "limited"
    assert "方法清单" in account["works"]["items"][0]["structure_analysis"]["promise_types"]
    assert account["comments"]["status"] == "unavailable"
    assert account["raw_entries"][0]["path"].startswith("materials/advisors/benchmark/client_alpha/raw/")
    assert (tmp_path / result["snapshot_path"]).is_file()
    normalized = json.loads((tmp_path / result["normalized_path"]).read_text(encoding="utf-8"))
    assert normalized["project_id"] == "client_alpha"
    assert normalized["accounts"][0]["evidence_links"][0]["url"].startswith("https://")


def test_unavailable_tikomni_blocks_without_archiving_an_unusable_research_report(tmp_path: Path) -> None:
    with pytest.raises(BenchmarkAdvisorCollectionError, match="TikOmni 对标账号研究不可用"):
        collect_project_accounts(tmp_path, "client_alpha", [xhs_account()], bridge=FakeTikOmniBridge(tmp_path, available=False))

    assert not (tmp_path / "materials" / "advisors" / "benchmark" / "client_alpha" / "normalized").exists()
    assert not (tmp_path / "materials" / "advisors" / "benchmark" / "client_alpha" / "snapshots").exists()


def test_rejects_unsafe_project_ids_and_unsupported_account_identifiers(tmp_path: Path) -> None:
    with pytest.raises(BenchmarkAdvisorCollectionError, match="项目 ID"):
        collect_project_accounts(tmp_path, "../client", [xhs_account()], bridge=FakeTikOmniBridge(tmp_path))

    invalid_mp = {
        **xhs_account(),
        "platform": "wechat_mp",
        "handle": "not-a-ghid",
        "publicUrl": "https://mp.weixin.qq.com/profile/not-a-ghid",
    }
    with pytest.raises(BenchmarkAdvisorCollectionError, match="ghid"):
        collect_project_accounts(tmp_path, "client_alpha", [invalid_mp], bridge=FakeTikOmniBridge(tmp_path))


def test_normalizes_public_xiaohongshu_note_media_without_deriving_private_or_missing_urls() -> None:
    note_id = "698989a4000000001d026f9d"
    works = normalize_works(xhs_account(), {
        "data": {
            "data": {
                "notes": [{
                    "id": note_id,
                    "type": "video",
                    "display_title": "香港教育博主",
                    "desc": "这条视频用一个具体问题讲清教育选择。",
                    "time_desc": "2026-02-09",
                    "images_list": [{
                        "url": "https://cdn.example.test/preview.webp",
                        "url_size_large": "https://cdn.example.test/large.webp",
                    }],
                    "video_info_v2": {
                        "image": {
                            "first_frame": "https://cdn.example.test/first-frame.webp",
                            "thumbnail": "https://cdn.example.test/contact-sheet.webp",
                        },
                        "media": {
                            "stream": {
                                "h264": [{"master_url": "http://cdn.example.test/public-video.mp4"}],
                                "h265": [{"master_url": "http://cdn.example.test/fallback-video.mp4"}],
                            },
                            "video": {
                                "subtitles": {
                                    "zh-CN": [{"url": "https://cdn.example.test/public-subtitle.srt"}],
                                },
                            },
                        },
                    },
                }, {
                    "id": "not/a-public-note-id",
                    "desc": "没有有效公开作品 ID 时不构造来源页。",
                }],
            },
        },
    }, "2026-08-03T23:12:41+08:00")

    assert works[0]["source_url"] == f"https://www.xiaohongshu.com/explore/{note_id}"
    assert works[0]["cover_image"] == "https://cdn.example.test/first-frame.webp"
    assert works[0]["embed_url"] == "http://cdn.example.test/public-video.mp4"
    assert works[0]["primary_text"] == "这条视频用一个具体问题讲清教育选择。"
    assert works[0]["primary_text_source"] == "desc（公开作品元数据）"
    assert works[0]["published_at"] == "2026-02-09"
    assert works[0]["structure_analysis"]["topic_signals"] == ["教育与选择"]
    assert "问题解答" in works[0]["structure_analysis"]["promise_types"]
    assert "公开主图可核验" in works[0]["structure_analysis"]["visual_signals"]
    assert works[1]["source_url"] == ""
    assert works[1]["cover_image"] == ""
    assert works[1]["embed_url"] == ""


def test_derives_bounded_structure_signals_without_persisting_source_sentences() -> None:
    analysis = analyze_work_structure(
        title="香港和海外 offer 到底怎么选？",
        hook="不要只看工资，我经历三次选择后整理了四个判断步骤。",
        primary_text="如果你正在选工作，先看成长空间。但是别忽略签证风险。我用三个客户案例说明，最后建议收藏清单。",
        content_format="video",
        cover_image="https://sns-i11.rednotecdn.com/cover.webp",
        embed_url="https://sns-v11.rednotecdn.com/video.mp4",
        published_at="2026-08-03T20:00:00+08:00",
        metrics={"likes": 30, "comments": 6},
    )

    assert analysis["status"] == "ready"
    assert "职业与成长" in analysis["topic_signals"]
    assert "对比选择" in analysis["promise_types"]
    assert analysis["narrative_structure"] == [
        "具体问题或场景",
        "冲突或认知修正",
        "案例或事实证据",
        "方法或步骤展开",
        "结论或行动收束",
    ]
    assert "案例证据" in analysis["proof_signals"]
    assert "收藏转发" in analysis["cta_types"]
    serialized = json.dumps(analysis, ensure_ascii=False)
    assert "签证风险" not in serialized
    assert analysis["evidence_limits"] == []


def test_limits_each_account_to_three_public_samples() -> None:
    items = [{
        "id": f"698989a4000000001d026f9{index:02d}",
        "type": "video",
        "title": f"公开样本 {index}",
        "platform_author_id": "xhs-user-001",
    } for index in range(5)]

    works = normalize_works(xhs_account(), {"data": {"items": items}}, "2026-08-03T23:12:41+08:00")

    assert [work["title"] for work in works] == ["公开样本 0", "公开样本 1", "公开样本 2"]


def test_archives_a_real_cover_under_the_immutable_project_media_snapshot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cover_url = "https://sns-i11.rednotecdn.com/first-frame.webp?sign=fixture"
    payload = b"RIFF\x00\x00\x00\x00WEBPfixture-image"
    downloaded: list[str] = []

    def fake_download(url: str) -> tuple[bytes, str]:
        downloaded.append(url)
        return payload, "image/webp"

    monkeypatch.setattr(benchmark_advisor_module, "download_public_cover", fake_download)
    result = collect_project_accounts(
        tmp_path,
        "client_alpha",
        [xhs_account()],
        bridge=FakeTikOmniBridge(tmp_path, cover_url=cover_url),
    )

    work = result["accounts"][0]["works"]["items"][0]
    assert downloaded == [cover_url]
    assert work["cover_image"] == cover_url
    assert work["embed_url"] == "https://sns-v11.rednotecdn.com/public-video.mp4"
    assert work["cover_content_type"] == "image/webp"
    assert work["cover_path"].startswith("materials/advisors/benchmark/client_alpha/media/")
    assert f"/{xhs_account()['id']}/" in work["cover_path"]
    assert (tmp_path / work["cover_path"]).read_bytes() == payload
    normalized = json.loads((tmp_path / result["normalized_path"]).read_text(encoding="utf-8"))
    assert normalized["accounts"][0]["works"]["items"][0]["cover_path"] == work["cover_path"]


def test_cover_archive_failure_keeps_the_original_url_but_never_invents_a_local_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cover_url = "https://sns-i11.rednotecdn.com/first-frame.webp?sign=unavailable"

    def failed_download(_url: str) -> tuple[bytes, str]:
        raise BenchmarkAdvisorCollectionError("公开封面暂时无法下载。")

    monkeypatch.setattr(benchmark_advisor_module, "download_public_cover", failed_download)
    result = collect_project_accounts(
        tmp_path,
        "client_alpha",
        [xhs_account()],
        bridge=FakeTikOmniBridge(tmp_path, cover_url=cover_url),
    )

    work = result["accounts"][0]["works"]["items"][0]
    assert work["cover_image"] == cover_url
    assert work["cover_path"] == ""
    assert work["cover_content_type"] == ""
    assert not (tmp_path / "materials" / "advisors" / "benchmark" / "client_alpha" / "media").exists()


def test_cover_content_validation_accepts_raster_signatures_only() -> None:
    content_type, extension = canonical_cover_content_type("image/webp; charset=binary")
    assert (content_type, extension) == ("image/webp", ".webp")
    assert cover_bytes_match_content_type(b"RIFF\x00\x00\x00\x00WEBPfixture", "image/webp")
    assert not cover_bytes_match_content_type(b"<html>not an image</html>", "image/webp")
    with pytest.raises(BenchmarkAdvisorCollectionError, match="不是可归档的图片"):
        canonical_cover_content_type("text/html")


def test_cover_archival_rejects_non_platform_host_before_any_download() -> None:
    with pytest.raises(BenchmarkAdvisorCollectionError, match="已允许的平台图片域名"):
        cover_url_parts("https://example.com/cover.webp")

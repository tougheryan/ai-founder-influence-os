from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
FIXTURES = Path(__file__).parent / "fixtures" / "tikomni"
sys.path.insert(0, str(SCRIPTS))

from hit_collector import HitLibrary
from content_runtime import ContentRuntime
from performance_collector import PerformanceCollector
import tikomni_adapter as tikomni_adapter_module
from tikomni_adapter import (
    TikomniAdapter,
    TikomniMarketResearchClient,
    map_hit_samples,
    map_performance_payload,
    normalize_market_platform,
    normalize_tikomni_platform,
)


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_normalize_tikomni_platforms_supports_active_platforms_only() -> None:
    assert normalize_tikomni_platform("xiaohongshu") == "xhs"
    assert normalize_tikomni_platform("rednote") == "xhs"
    assert normalize_tikomni_platform("wechat_mp") == "wechat"
    assert normalize_tikomni_platform("公众号") == "wechat"

    with pytest.raises(ValueError, match="未知 TikOmni 平台"):
        normalize_tikomni_platform("unsupported")


def test_market_research_platforms_are_separate_from_legacy_asset_storage_aliases() -> None:
    assert normalize_market_platform("wechat_mp") == "wechat_mp"
    assert normalize_market_platform("公众号") == "wechat_mp"
    assert normalize_market_platform("xiaohongshu") == "xiaohongshu"
    assert normalize_market_platform("小红书") == "xiaohongshu"
    assert normalize_market_platform("wechat_channels") == "wechat_channels"
    assert normalize_market_platform("视频号") == "wechat_channels"
    assert normalize_market_platform("douyin") == "wechat_channels"

    with pytest.raises(ValueError, match="未知 TikOmni 市场研究平台"):
        normalize_market_platform("moments")


def test_market_research_pins_three_platforms_to_catalog_keyword_search_endpoints(tmp_path: Path) -> None:
    client = TikomniMarketResearchClient(tmp_path)
    calls: list[tuple[str, dict, str]] = []

    class FakeBridge:
        def credential_status(self) -> dict:
            return {"available": True}

        def fetch(self, endpoint_id: str, params: dict, platform: str, **_: object) -> dict:
            calls.append((endpoint_id, params, platform))
            raw_path = tmp_path / "materials" / "tikomni" / "raw" / f"{platform}.json"
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_text(json.dumps({"data": {"items": []}}), encoding="utf-8")
            return {"raw_path": str(raw_path.relative_to(tmp_path))}

    client.bridge = FakeBridge()  # type: ignore[assignment]

    results = [client.fetch(platform, "AI 内容") for platform in (
        "wechat_mp", "xiaohongshu", "wechat_channels",
    )]

    assert all(result["status"] == "available" for result in results)
    assert [result["capability"] for result in results] == ["search", "search", "video_search"]
    assert [result["query_mode"] for result in results] == ["platform-search"] * 3
    assert calls == [
        (
            "wechat_search.search.v2.fetch_search",
            {"keyword": "AI 内容", "business_type": "article", "raw": False},
            "wechat_mp",
        ),
        (
            "xiaohongshu.search.app_v2.search_notes",
            {"keyword": "AI 内容", "page": 1},
            "xiaohongshu",
        ),
        (
            "wechat_search.video_search.v2.fetch_search_videos",
            {"keyword": "AI 内容", "raw": False},
            "wechat_channels",
        ),
    ]


def test_market_research_explains_tikomni_permission_denial(tmp_path: Path) -> None:
    client = TikomniMarketResearchClient(tmp_path)

    class FakeBridge:
        def credential_status(self) -> dict:
            return {"available": True}

        def fetch(self, *_: object, **__: object) -> dict:
            raise RuntimeError("TikOmni API call failed: 403")

    client.bridge = FakeBridge()  # type: ignore[assignment]

    result = client.fetch("wechat_mp", "AI 内容")

    assert result == {
        "status": "unavailable",
        "platform": "wechat_mp",
        "code": "tikomni_permission_denied",
        "reason": "TikOmni 拒绝访问（403）：当前 Token 没有该平台检索接口的权限。请在 TikOmni 控制台为 Token 开通微信公众号和视频号检索权限后重试。",
    }


@pytest.mark.parametrize(
    "transient_error",
    [
        "TikOmni API call failed: 502",
        "request timed out after 15 seconds",
        "connection reset by peer",
    ],
)
def test_market_research_retries_transient_platform_failures(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    transient_error: str,
) -> None:
    client = TikomniMarketResearchClient(tmp_path)
    calls = 0

    class FlakyBridge:
        def credential_status(self) -> dict:
            return {"available": True}

        def fetch(self, *_: object, **__: object) -> dict:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError(transient_error)
            raw_path = tmp_path / "materials" / "tikomni" / "raw" / "wechat.json"
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_text(json.dumps({"data": {"items": []}}), encoding="utf-8")
            return {"raw_path": str(raw_path.relative_to(tmp_path))}

    monkeypatch.setattr(tikomni_adapter_module.time, "sleep", lambda _: None)
    client.bridge = FlakyBridge()  # type: ignore[assignment]

    result = client.fetch("wechat_mp", "AI 内容")

    assert result["status"] == "available"
    assert calls == 2


def test_market_research_does_not_retry_permission_denial(tmp_path: Path) -> None:
    client = TikomniMarketResearchClient(tmp_path)
    calls = 0

    class ForbiddenBridge:
        def credential_status(self) -> dict:
            return {"available": True}

        def fetch(self, *_: object, **__: object) -> dict:
            nonlocal calls
            calls += 1
            raise RuntimeError("TikOmni API call failed: 403")

    client.bridge = ForbiddenBridge()  # type: ignore[assignment]

    result = client.fetch("wechat_mp", "AI 内容")

    assert result["code"] == "tikomni_permission_denied"
    assert calls == 1


def test_tikomni_bridge_enforces_the_platform_request_deadline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append(kwargs)
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"ok": True, "data": {"items": []}}),
        )

    monkeypatch.setattr(tikomni_adapter_module.subprocess, "run", fake_run)
    bridge = tikomni_adapter_module.TikomniApiBridge(tmp_path)

    bridge.fetch(
        "xiaohongshu.search.app_v2.search_notes",
        {"keyword": "内容获客", "page": 1},
        "xiaohongshu",
        timeout_ms=1_400,
    )

    assert calls[0]["timeout"] == pytest.approx(1.4)


@pytest.mark.skipif(
    os.getenv("AIFIOS_RUN_TIKOMNI_LIVE_SMOKE") != "1",
    reason="set AIFIOS_RUN_TIKOMNI_LIVE_SMOKE=1 to run the configured TikOmni live smoke",
)
def test_optional_live_three_platform_market_smoke(tmp_path: Path) -> None:
    """Never runs in CI; validates only an explicitly configured local token."""
    client = TikomniMarketResearchClient(tmp_path)
    if not client.health().get("available"):
        pytest.skip("no valid local TikOmni Token available")
    rows = [client.fetch(platform, "AI 企业转型") for platform in (
        "wechat_mp", "xiaohongshu", "wechat_channels",
    )]
    assert all(row.get("status") == "available" for row in rows)


def test_map_hit_samples_from_active_platform_fixtures() -> None:
    cases = [
        ("xhs-hit.json", "xhs", "collects"),
        ("wechat-hit.json", "wechat", "reads"),
    ]

    for fixture_name, platform, metric_key in cases:
        samples = map_hit_samples(load_fixture(fixture_name), platform=platform, keyword="AI 创业")
        assert len(samples) == 1
        sample = samples[0]
        assert sample.platform == platform
        assert sample.source_type == "tikomni"
        assert sample.keyword == "AI 创业"
        assert sample.title
        assert sample.url.startswith("https://")
        assert sample.metrics[metric_key] > 0
        assert sample.confidence_score >= 0.5


def test_map_wechat_api_envelope() -> None:
    payload = {
        "code": 0,
        "data": {
            "keyword": "AI创业",
            "items": [{
                "desc": "从中关村 <em class=\"highlight\">AI</em> 社区到深圳模力营。",
                "doc_url": "https://mp.weixin.qq.com/s?fixture=1",
                "source": {"title": "小唐学AI"},
                "title": "一个人+<em class=\"highlight\">AI</em>=一家公司？",
            }],
        },
    }

    samples = map_hit_samples(payload, platform="wechat")

    assert len(samples) == 1
    assert samples[0].platform == "wechat"
    assert samples[0].keyword == "AI创业"
    assert samples[0].title == "一个人+AI=一家公司？"
    assert samples[0].author == "小唐学AI"
    assert samples[0].content_type == "article"


def test_map_xhs_nested_api_envelope() -> None:
    payload = {
        "code": 200,
        "data": {
            "data": {
                "items": [{
                    "note": {
                        "id": "fixture-note",
                        "title": "AI 产品的商业化验证",
                        "desc": "从客户问题开始，而不是堆功能。",
                        "liked_count": 134,
                        "collected_count": 151,
                        "comments_count": 18,
                        "shared_count": 33,
                        "images_list": [{"url": "https://example.com/cover.png"}],
                        "user": {"nickname": "测试作者", "userid": "author-001"},
                    },
                }],
            },
        },
    }

    samples = map_hit_samples(payload, platform="xhs", keyword="AI 产品")

    assert len(samples) == 1
    assert samples[0].platform == "xhs"
    assert samples[0].title == "AI 产品的商业化验证"
    assert samples[0].author == "测试作者"
    assert samples[0].metrics["collects"] == 151


def test_tikomni_hit_import_queues_and_saves_active_samples(tmp_path: Path) -> None:
    project = tmp_path / "project"
    adapter = TikomniAdapter(project)
    queued = adapter.import_hits(
        file_path=FIXTURES / "xhs-hit.json",
        platform="xhs",
        keyword="AI 创业",
        topic="AI 创业",
        queue=True,
    )
    saved = adapter.import_hits(
        file_path=FIXTURES / "wechat-hit.json",
        platform="wechat",
        keyword="创始人 IP",
        topic="内容获客",
        queue=False,
    )

    assert queued["status"] == "queued"
    assert json.loads(Path(queued["path"]).read_text(encoding="utf-8"))["samples"][0]["platform"] == "xhs"
    assert saved["status"] == "imported"
    samples = HitLibrary(project).query(platform="wechat", keyword="创始人 IP", limit=10)
    assert len(samples) == 1
    assert samples[0].metrics["reads"] == 18000


def test_map_performance_payload_from_active_platform_fixtures() -> None:
    cases = [
        ("xhs-performance.json", "xhs", "xhs", "collects", 210),
        ("wechat-performance.json", "wechat", "wechat-official-account", "reads", 5200),
    ]

    for fixture_name, platform, normalized_dir, metric_key, metric_value in cases:
        mapped = map_performance_payload(
            load_fixture(fixture_name),
            platform=platform,
            slug=f"{platform}-fixture",
            authorization_mode="public-visible",
        )
        assert mapped["platform"] == platform
        assert mapped["normalized_directory"] == normalized_dir
        assert mapped["content"]["title"]
        assert mapped["content"]["url"].startswith("https://")
        assert mapped["metrics"][metric_key] == metric_value
        assert mapped["source"]["authorization_mode"] == "public-visible"


def test_map_performance_masks_sensitive_xhs_comment_data() -> None:
    mapped = map_performance_payload(
        load_fixture("xhs-performance.json"),
        platform="xhs",
        slug="xhs-own-001",
        authorization_mode="public-visible",
    )
    serialized = json.dumps(mapped["comments"], ensure_ascii=False)

    assert "wx12345" not in serialized
    assert "[已脱敏]" in serialized


def test_performance_payload_rejects_declared_platform_mismatch() -> None:
    with pytest.raises(ValueError, match="platform"):
        map_performance_payload(load_fixture("wechat-performance.json"), platform="xhs", slug="wrong-platform")


def test_performance_import_records_blocked_evidence_without_publish_record(tmp_path: Path) -> None:
    project = tmp_path / "project"
    adapter = TikomniAdapter(project)
    result = adapter.import_performance(
        file_path=FIXTURES / "xhs-performance.json",
        platform="xhs",
        slug="xhs-own-unbound",
        authorization_mode="public-visible",
    )
    review_input = json.loads((project / result["review_input_path"]).read_text(encoding="utf-8"))

    assert result["status"] == "blocked"
    assert result["evidence_status"] == "blocked"
    assert review_input["review_status"] == "blocked"
    assert ContentRuntime(project).state()["active_run_id"] is None


def test_unbound_performance_import_preserves_an_unrelated_active_production_run(tmp_path: Path) -> None:
    project = tmp_path / "project"
    runtime = ContentRuntime(project)
    runtime.init()
    active = runtime.create_run(topic="当前生产主题", slug="current-production", run_id="current-production-run")

    result = TikomniAdapter(project).import_performance(
        file_path=FIXTURES / "xhs-performance.json",
        platform="xhs",
        slug="historical-xhs-post",
        authorization_mode="public-visible",
    )

    state = runtime.state()
    active_run = runtime.run_state(run_id=active["run_id"])
    assert result["status"] == "blocked"
    assert state["active_run_id"] == active["run_id"]
    assert "performance" not in active_run["steps"]


def test_performance_report_writers_bind_matching_runs_or_mark_unbound_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    runtime = ContentRuntime(project)
    runtime.init()
    commands: list[list[str]] = []

    def fake_run(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"status": "written", "path": str(project / "pipeline/performance/report.md")}),
        )

    monkeypatch.setattr(tikomni_adapter_module.subprocess, "run", fake_run)

    adapter = TikomniAdapter(project)
    collector = PerformanceCollector(project)
    adapter.write_runtime_report("historical-post", "report", "test")
    collector.write_runtime_report("historical-post", "report", "test")

    assert "--unbound-report" in commands[0]
    assert "--run-id" not in commands[0]
    assert "--unbound-report" in commands[1]
    assert "--run-id" not in commands[1]

    active = runtime.create_run(topic="当前生产主题", slug="current-production", run_id="current-production-run")
    adapter.write_runtime_report(active["slug"], "report", "test")
    collector.write_runtime_report(active["slug"], "report", "test")

    assert commands[2][-2:] == ["--run-id", active["run_id"]]
    assert commands[3][-2:] == ["--run-id", active["run_id"]]


def test_unbound_performance_report_cannot_bypass_a_matching_active_production_run(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    active = runtime.create_run(topic="当前生产主题", slug="current-production", run_id="current-production-run")

    with pytest.raises(ValueError, match="必须提供 --run-id"):
        runtime.write(
            "performance",
            active["slug"],
            "## 0. 采集对象",
            source="test",
            unbound_report=True,
        )


def test_performance_import_masks_sensitive_content_and_source_path(tmp_path: Path) -> None:
    project = tmp_path / "project"
    source_file = tmp_path / "sensitive.json"
    source_file.write_text(
        json.dumps(
            {
                "object_type": "work",
                "platform": "xiaohongshu",
                "normalized": {
                    "platform": "xiaohongshu",
                    "platform_work_id": "xhs-sensitive-001",
                    "title": "联系 wx99999 获取方案",
                    "primary_text": "邮箱 me@example.com 可以发模板",
                    "source_url": "https://www.xiaohongshu.com/explore/xhs-sensitive-001",
                    "digg_count": 18,
                    "comment_count": 2,
                    "collect_count": 9,
                },
                "comments": [{"content": "我发邮件到 me@example.com 了", "like_count": 1}],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = TikomniAdapter(project).import_performance(
        file_path=source_file,
        platform="xhs",
        slug="xhs-sensitive-001",
        authorization_mode="public-visible",
    )
    review = json.dumps(json.loads((project / result["review_input_path"]).read_text(encoding="utf-8")), ensure_ascii=False)
    raw = json.loads((project / result["raw_path"]).read_text(encoding="utf-8"))

    assert "wx99999" not in review
    assert "me@example.com" not in review
    assert "[已脱敏]" in review
    assert raw["source_file"] == source_file.name
    assert str(source_file) not in json.dumps(raw, ensure_ascii=False)

import hashlib
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
import sys


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from content_radar import (  # noqa: E402
    asset_readiness,
    build_snapshot,
    direction_evidence_score,
    enrich_wechat_signals,
    normalize_industry,
    queries_for_industry,
)
from market_signal import MarketSignal  # noqa: E402


class FakeFetcher:
    def __init__(self, multiplier=1):
        self.multiplier = multiplier

    def fetch(self, platform, query):
        slug = hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]
        emerging = "早八妆正在升温，屏障修护也值得观察。" if query == "美妆 护肤 成分党" else ""
        return {
            "status": "available",
            "platform": platform,
            "endpoint_id": "xiaohongshu.search.app_v2.search_notes",
            "capability": "search",
            "query_applied": True,
            "raw_payload": {
                "data": {
                    "items": [
                        {
                            "note_id": f"note_{slug}",
                            "title": f"{query} 的公开样本",
                            "desc": f"先说明一个具体问题，再给出可保存的方法清单。{emerging}",
                            "nickname": f"美妆作者{slug[-6:]}",
                            "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                            "liked_count": 120 * self.multiplier,
                            "collected_count": 68,
                            "comment_count": 15,
                        }
                    ]
                }
            },
        }


class RejectedFetcher:
    def fetch(self, platform, query):
        return {
            "status": "unavailable",
            "platform": platform,
            "reason": "TikOmni API call failed: 401",
        }


class ChannelsFetcher:
    def fetch(self, platform, query):
        slug = hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]
        return {
            "status": "available",
            "platform": platform,
            "endpoint_id": "wechat_search.video_search.v2.fetch_search_videos",
            "capability": "video_search",
            "raw_payload": {"data": {"items": [{
                "title": f"{query} 的视频号公开样本",
                "desc": "前三秒提出冲突，再给出一个清晰判断。",
                "url": f"https://channels.weixin.qq.com/finder/{slug}",
                "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "play_count": 9200,
                "digg_count": 180,
                "comment_count": 32,
            }]}},
        }


class DeniedEnrichmentFetcher:
    def __init__(self):
        self.stats_calls = 0
        self.comment_calls = 0

    def fetch_wechat_article_stats(self, url):
        self.stats_calls += 1
        return {"status": "unavailable", "endpoint_id": "stats", "reason": "TikOmni API call failed: 403"}

    def fetch_wechat_article_comments(self, url):
        self.comment_calls += 1
        return {"status": "unavailable", "endpoint_id": "comments", "reason": "TikOmni API call failed: 403"}


class ContentRadarTests(unittest.TestCase):
    def test_beauty_industry_uses_curated_query_set(self):
        queries = queries_for_industry("美妆行业")
        self.assertEqual(len(queries), 6)
        self.assertIn("敏感肌 修护 避坑", [query for query, _ in queries])
        self.assertEqual(normalize_industry("  美妆行业  "), "美妆行业")

    def test_snapshot_is_evidence_backed_and_persisted(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            radar = build_snapshot(project, "美妆行业", "xiaohongshu", fetcher=FakeFetcher())

            self.assertEqual(radar["schema"], "aifios.content-radar.v5")
            self.assertTrue(radar["snapshotId"].startswith("snapshot-"))
            self.assertGreaterEqual(radar["metrics"]["sampleCount"], 7)
            self.assertGreaterEqual(radar["metrics"]["directionCount"], 7)
            self.assertEqual(len(radar["creatorWatchlist"]), 5)
            self.assertEqual(len(radar["specialReports"]), 4)
            self.assertGreaterEqual(radar["coverage"]["dynamicQueryCount"], 1)
            self.assertEqual(radar["provenance"]["objectType"], "search_snapshot")
            self.assertIn("echo-founder.tikomni-hit-score.v5", radar["methodology"]["formulaVersion"])
            self.assertIn(radar["quality"]["languageStatus"], {"pass", "review_required"})
            self.assertIsInstance(radar["quality"]["languageWarnings"], list)
            self.assertTrue(all("opportunityScore" in item for item in radar["opportunities"]))
            self.assertTrue(all(item["id"].startswith("radar-") for item in radar["opportunities"]))
            self.assertTrue(all("lifecycle" in item and "windows" in item for item in radar["opportunities"]))
            self.assertTrue(all("assetReadiness" in item and "scoreRange" in item for item in radar["opportunities"]))
            self.assertTrue(all("experiment" in item and "demandEvidence" in item for item in radar["opportunities"]))
            self.assertTrue(all("coverageScore" in item and "evidenceReasons" in item for item in radar["opportunities"]))
            self.assertTrue(all(item["scoreVersion"] == "echo-founder.tikomni-hit-score.v5" for item in radar["samples"]))
            self.assertTrue(all(item["sampleClass"] in {"verified_hit", "potential", "related", "insufficient"} for item in radar["samples"]))
            self.assertEqual(radar["profile"], {"mode": "broad", "label": "不限制账号类型与内容目标"})
            self.assertEqual(radar["baseline"]["snapshotCount"], 1)
            self.assertEqual(radar["calibration"]["status"], "insufficient")
            self.assertTrue((project / radar["snapshotPath"]).is_file())
            self.assertTrue((project / radar["historyPath"]).is_file())
            self.assertTrue(all(item["sourceUrl"].startswith("https://www.xiaohongshu.com/") for item in radar["samples"]))

    def test_video_channel_snapshot_uses_the_same_evidence_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            radar = build_snapshot(project, "美妆行业", "wechat_channels", fetcher=ChannelsFetcher())

            self.assertEqual(radar["platform"], "wechat_channels")
            self.assertEqual(radar["platformLabel"], "视频号")
            self.assertGreaterEqual(radar["metrics"]["sampleCount"], 6)
            self.assertTrue(all(item["scoreVersion"] == "echo-founder.tikomni-hit-score.v5" for item in radar["samples"]))

    def test_generated_copy_blocker_prevents_snapshot_write(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "本次结果没有保存"):
                build_snapshot(project, "/Users/alice/private", "xiaohongshu", fetcher=FakeFetcher())

            self.assertFalse((project / "materials" / "content-radar").exists())

    def test_second_scan_uses_previous_snapshot_as_trend_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            first = build_snapshot(project, "美妆行业", "xiaohongshu", fetcher=FakeFetcher())
            second = build_snapshot(project, "美妆行业", "xiaohongshu", fetcher=FakeFetcher(multiplier=2))

            self.assertEqual(first["baseline"]["status"], "establishing")
            self.assertEqual(second["baseline"]["status"], "compared")
            self.assertGreaterEqual(second["baseline"]["comparisonCount"], 6)
            self.assertEqual(second["baseline"]["snapshotCount"], 2)
            self.assertGreaterEqual(second["calibration"]["matchedSampleCount"], 6)
            self.assertEqual(second["calibration"]["status"], "tracking")
            self.assertEqual(
                {item["query"]: item["id"] for item in first["opportunities"]},
                {item["query"]: item["id"] for item in second["opportunities"]},
            )
            self.assertTrue(all(item["baselineStatus"] == "batch_only" for item in second["creatorWatchlist"]))
            self.assertTrue(any(item["trend"]["status"] != "baseline" for item in second["opportunities"]))

    def test_direction_coverage_uses_public_evidence_not_account_profile(self):
        items = [
            MarketSignal(
                provider="tikomni", platform="xiaohongshu", query="美妆", title=f"样本 {index}",
                hook="摘要", metrics={"likes": 100, "collects": 20}, mechanism="清单",
                audience_pain="用户问题", source_url=f"https://www.xiaohongshu.com/explore/{index}",
                captured_at="2026-08-24T00:00:00+00:00", account=f"作者 {index}",
                evidence_status="sufficient", sample_class="potential",
            )
            for index in range(3)
        ]

        score, reasons = direction_evidence_score(items)

        self.assertGreaterEqual(score, 70)
        self.assertIn("3 条公开样本", reasons[0])

    def test_asset_readiness_uses_only_bounded_local_evidence_categories(self):
        readiness = asset_readiness(
            "敏感肌 修护 避坑",
            "敏感肌修护",
            ["我复盘了一个敏感肌客户案例，包含产品成分实测数据和截图素材。"],
        )

        self.assertEqual(readiness["matchedAssetCount"], 1)
        self.assertGreaterEqual(readiness["score"], 68)
        self.assertIn("客户案例", readiness["evidenceTypes"])
        self.assertIn("只在本机", readiness["privacyNote"])

    def test_wechat_enrichment_stops_after_one_denied_probe_per_capability(self):
        fetcher = DeniedEnrichmentFetcher()
        signals = [
            MarketSignal(
                provider="tikomni", platform="wechat_mp", query="美妆", title=f"文章 {index}",
                hook="摘要", metrics={}, mechanism="痛点开头", audience_pain="用户问题",
                source_url=f"https://mp.weixin.qq.com/s/{index}", captured_at="2026-08-24T00:00:00+00:00",
            )
            for index in range(5)
        ]

        enrichment, trace = enrich_wechat_signals(fetcher, signals)

        self.assertEqual(fetcher.stats_calls, 1)
        self.assertEqual(fetcher.comment_calls, 1)
        self.assertEqual(len(trace), 2)
        self.assertEqual(enrichment[signals[0].source_url]["statsStatus"], "unavailable")

    def test_rejects_unsupported_platform(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "仅支持小红书、公众号和视频号"):
                build_snapshot(Path(directory), "美妆行业", "douyin", fetcher=FakeFetcher())

    def test_credential_rejection_has_actionable_message_and_writes_no_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "系统设置中更新"):
                build_snapshot(project, "美妆行业", "xiaohongshu", fetcher=RejectedFetcher())
            self.assertFalse((project / "ai-content-system/materials/content-radar").exists())


if __name__ == "__main__":
    unittest.main()

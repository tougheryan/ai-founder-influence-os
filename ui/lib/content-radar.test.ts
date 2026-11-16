import { describe, expect, it } from 'vitest';
import {
  compareContentRadarSnapshots,
  ContentRadarInputError,
  parseContentRadarIndustry,
  parseContentRadarOutput,
  parseContentRadarPlatform,
  runContentRadar,
} from './content-radar';
import type { ContentRadarOpportunity, ContentRadarSnapshot } from './content-radar';

function radar(): ContentRadarSnapshot {
  return {
    schema: 'aifios.content-radar.v5',
    status: 'ready',
    snapshotId: 'snapshot-fixture',
    industry: '美妆行业',
    platform: 'xiaohongshu',
    platformLabel: '小红书',
    capturedAt: '2026-08-24T08:00:00+00:00',
    source: 'TikOmni 公开内容检索',
    profile: { mode: 'broad', label: '不限制账号类型与内容目标' },
    coverage: { queryCount: 1, baseQueryCount: 1, dynamicQueryCount: 0, successfulQueryCount: 1, queries: ['美妆'], baseQueries: ['美妆'], dynamicQueries: [], warnings: [], enrichmentAttemptCount: 0, enrichedArticleCount: 0, commentArticleCount: 0 },
    provenance: { objectType: 'search_snapshot', platform: 'xiaohongshu', input: {}, normalized: {}, completeness: 'complete', missingFields: [], errorReason: null, requestId: null, extractTrace: [], enrichmentTrace: [] },
    quality: { evidenceCoverage: 100, timeCoverage: 100, metricCoverage: 100, confidence: '中' },
    baseline: { status: 'establishing', previousCapturedAt: null, comparisonCount: 0, snapshotCount: 1, firstCapturedAt: null, trackedDays: 0, note: '建立中' },
    calibration: { status: 'insufficient', matchedSampleCount: 0, evaluatedPredictions: 0, hitRate: null, falsePositiveRate: null, thresholds: { predictedScore: 80, observedGrowthPercent: 30 }, note: '待积累' },
    methodology: { scopeLabel: '本轮样本', rankScope: '样本内', freshnessLabel: '按时间', formulaVersion: 'echo-founder.tikomni-hit-score.v5 + radar-opportunity-v5', formulaFactors: [], scoreLegend: [], limitations: [] },
    metrics: { sampleCount: 1, totalEngagement: 12, creatorCount: 1, directionCount: 1, highPotentialCount: 0, verifiedHitCount: 0, potentialSampleCount: 0, insufficientSampleCount: 0, evidenceCoverage: 100 },
    discovery: { emergingKeywords: [] },
    deepReport: { id: 'deep', title: '深度报告', summary: '摘要', sections: [] },
    specialReports: [],
    creatorWatchlist: [],
    opportunities: [],
    samples: [],
    snapshotPath: 'materials/content-radar/xiaohongshu/latest.json',
    historyPath: 'materials/content-radar/xiaohongshu/history/fixture.json',
  };
}

function opportunity(query: string, score: number): ContentRadarOpportunity {
  return {
    id: `radar-${query}`,
    title: query,
    query,
    sourceType: '固定领域词',
    heat: score,
    opportunityScore: score,
    tier: score >= 78 ? '立即做' : '差异化切入',
    trend: { status: 'baseline', label: '基线建立中', delta: null },
    lifecycle: { status: 'new', label: '新出现', observationCount: 1 },
    windows: { '3d': null, '7d': null, '28d': null },
    sampleCount: 1,
    engagement: 10,
    freshnessScore: 90,
    coverageScore: 80,
    evidenceReasons: [],
    saturationScore: 40,
    evidenceScore: 100,
    scoreRange: { low: score - 8, high: score + 8 },
    risks: [],
    assetReadiness: { score: 60, status: 'partial', label: '可补齐', matchedAssetCount: 1, evidenceTypes: [], gaps: [], privacyNote: '本机' },
    demandEvidence: { source: 'sample_semantics', label: '样本语义推导（非评论事实）', signals: [] },
    experiment: { id: `experiment-${query}`, hypothesis: '假设', primaryMetric: '收藏率', metricDefinition: '定义', baseline: '基线', checkpoints: ['24h'], successRule: '规则', status: 'planned', dataBoundary: '授权数据' },
    mechanisms: [],
    leadSample: {} as ContentRadarOpportunity['leadSample'],
    topicTitle: query,
    contentSuggestion: '建议',
    whyNow: [],
    actionPlan: [],
  };
}

describe('content radar', () => {
  it('accepts only bounded industry terms and frozen platforms', () => {
    expect(parseContentRadarIndustry('  美妆 行业  ')).toBe('美妆 行业');
    expect(parseContentRadarPlatform('wechat_mp')).toBe('wechat_mp');
    expect(parseContentRadarPlatform('wechat_channels')).toBe('wechat_channels');
    expect(() => parseContentRadarPlatform('douyin')).toThrow(ContentRadarInputError);
    expect(() => parseContentRadarIndustry('美')).toThrow(ContentRadarInputError);
  });

  it('parses the radar process envelope', () => {
    expect(parseContentRadarOutput(JSON.stringify({ ok: true, radar: radar() })).industry).toBe('美妆行业');
    expect(() => parseContentRadarOutput('{bad-json')).toThrow('平台数据没有正常返回');
    expect(() => parseContentRadarOutput(JSON.stringify({ ok: false, error: '平台不可用' }))).toThrow('暂时没有返回可用结果');
    expect(() => parseContentRadarOutput(JSON.stringify({ ok: false, error: 'TikOmni token invalid' }))).toThrow('请到系统设置检查密钥');
  });

  it('passes only the industry and frozen platform to the local script', async () => {
    const calls: Array<{ binary: string; args: string[] }> = [];
    const result = await runContentRadar({ industry: '美妆行业', platform: 'xiaohongshu' }, async (binary, args) => {
      calls.push({ binary, args });
      return { stdout: JSON.stringify({ ok: true, radar: radar() }), stderr: '' };
    });

    expect(result.platform).toBe('xiaohongshu');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('美妆行业');
    expect(calls[0].args).toContain('xiaohongshu');
    expect(calls[0].args).not.toContain('--persona');
    expect(calls[0].args).not.toContain('--goal');
    expect(calls[0].args.some((value) => value.includes('endpoint'))).toBe(false);
  });

  it('compares only real platform snapshots and recommends the stronger channel', () => {
    const xhs = { ...radar(), opportunities: [opportunity('敏感肌 修护 避坑', 88)] };
    const wechat = { ...radar(), platform: 'wechat_mp' as const, platformLabel: '公众号', opportunities: [opportunity('敏感肌 修护 避坑', 70)] };

    const comparison = compareContentRadarSnapshots(xhs, wechat, null, '美妆行业');

    expect(comparison.availablePlatforms).toEqual(['xiaohongshu', 'wechat_mp']);
    expect(comparison.rows[0]).toMatchObject({ recommendation: '小红书数据更好，先做图文验证' });
  });

  it('uses natural cross-platform recommendations without changing platform keys', () => {
    const xhs = { ...radar(), opportunities: [opportunity('敏感肌 修护 避坑', 80)] };
    const wechat = { ...radar(), platform: 'wechat_mp' as const, platformLabel: '公众号', opportunities: [opportunity('敏感肌 修护 避坑', 78)] };

    const comparison = compareContentRadarSnapshots(xhs, wechat, null, '美妆行业');

    expect(comparison.rows[0].wechat_mp).not.toBeNull();
    expect(comparison.rows[0].recommendation).toBe('小红书、公众号都可以做，分别按各自平台的原生结构生成');
    expect(comparison.rows[0].recommendation).not.toMatch(/母稿|CTA|机制|沉淀|赋能/);
  });

  it('compares video-channel evidence without forcing it through an article lane', () => {
    const xhs = { ...radar(), opportunities: [opportunity('敏感肌 修护 避坑', 72)] };
    const channels = { ...radar(), platform: 'wechat_channels' as const, platformLabel: '视频号', opportunities: [opportunity('敏感肌 修护 避坑', 90)] };

    const comparison = compareContentRadarSnapshots(xhs, null, channels, '美妆行业');

    expect(comparison.availablePlatforms).toEqual(['xiaohongshu', 'wechat_channels']);
    expect(comparison.rows[0].wechat_channels?.score).toBe(90);
    expect(comparison.rows[0].recommendation).toBe('视频号数据更好，先做一条口播验证');
  });

  it('does not expose provider output, local paths, or tokens when the process fails', async () => {
    const failure = Object.assign(new Error('spawn failed'), {
      stderr: 'TikOmni token sk-secret failed at /Users/customer/private/project',
    });

    await expect(runContentRadar({ industry: '美妆行业', platform: 'xiaohongshu' }, async () => {
      throw failure;
    })).rejects.toThrow('平台数据连接失败。请到系统设置检查密钥后重试。');
  });
});

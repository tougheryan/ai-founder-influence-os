import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { contentRuntimeToolPath, PROJECT_DIR, runtimeJoin, safeResolve } from './project-root';
import { runtimePythonBinary } from './runtime-binary';

export const CONTENT_RADAR_PLATFORMS = ['xiaohongshu', 'wechat_mp', 'wechat_channels'] as const;
export type ContentRadarPlatform = (typeof CONTENT_RADAR_PLATFORMS)[number];

export type ContentRadarReport = {
  id: string;
  title: string;
  summary: string;
  sections: Array<{ title: string; bullets: string[] }>;
};

export type ContentRadarSample = {
  title: string;
  summary: string;
  author: string;
  sourceUrl: string;
  publishedAt: string;
  contentForm: string;
  mechanism: string;
  audiencePain: string;
  metrics: Record<string, number | null>;
  query: string;
  enrichment: {
    statsStatus: 'available' | 'empty' | 'unavailable' | 'not_attempted' | 'not_applicable';
    commentStatus: 'available' | 'empty' | 'unavailable' | 'not_attempted';
    commentSignals: string[];
    metricFields?: string[];
  };
  weightedEngagement: number;
  breakoutScore: number;
  sampleClass: 'verified_hit' | 'potential' | 'related' | 'insufficient';
  classificationReason: string;
  evidenceStatus: 'sufficient' | 'insufficient';
  confidence: number;
  metricCompleteness: number;
  ageDays: number | null;
  scoreComponents: {
    absolute_volume?: number;
    engagement_rate?: number;
    batch_percentile?: number;
    creator_lift?: number;
    performance?: number;
    relevance?: number;
    freshness?: number;
    evidence?: number;
    total?: number;
  };
  creatorBaseline: number | null;
  creatorLift: number | null;
  engagementRate: number | null;
  scoreVersion: 'echo-founder.tikomni-hit-score.v5';
  scoreBasis: {
    engagement: number;
    freshness: number;
    outlier: number;
    evidence: number;
    ageDays: number | null;
    creatorBaseline: number;
    creatorLift: number;
    baselineSource: 'creator_history' | 'current_creator' | 'current_batch';
    baselineSampleCount: number;
  };
};

export type ContentRadarCreator = {
  rank: number;
  name: string;
  engagement: number;
  postCount: number;
  averagePotential: number;
  creatorLift: number;
  historySampleCount: number;
  baselineStatus: 'historical' | 'batch_only';
  primaryMechanism: string;
  sourceUrl: string;
};

export type ContentRadarOpportunity = {
  id: string;
  title: string;
  query: string;
  sourceType: '固定领域词' | '样本新词扩展';
  heat: number;
  opportunityScore: number;
  tier: '立即做' | '差异化切入' | '继续观察' | '暂缓';
  trend: {
    status: 'rising' | 'stable' | 'falling' | 'baseline';
    label: string;
    delta: number | null;
  };
  lifecycle: {
    status: 'new' | 'accelerating' | 'rising' | 'stable' | 'saturating' | 'cooling';
    label: string;
    observationCount: number;
  };
  windows: { '3d': number | null; '7d': number | null; '28d': number | null };
  sampleCount: number;
  engagement: number;
  freshnessScore: number;
  coverageScore: number;
  evidenceReasons: string[];
  saturationScore: number;
  evidenceScore: number;
  scoreRange: { low: number; high: number };
  risks: string[];
  assetReadiness: {
    score: number;
    status: 'ready' | 'partial' | 'gap';
    label: string;
    matchedAssetCount: number;
    evidenceTypes: string[];
    gaps: string[];
    privacyNote: string;
  };
  demandEvidence: {
    source: 'public_comments' | 'sample_semantics';
    label: string;
    signals: string[];
  };
  experiment: {
    id: string;
    hypothesis: string;
    primaryMetric: string;
    metricDefinition: string;
    baseline: string;
    checkpoints: string[];
    successRule: string;
    status: 'planned';
    dataBoundary: string;
  };
  mechanisms: string[];
  leadSample: ContentRadarSample;
  topicTitle: string;
  contentSuggestion: string;
  whyNow: string[];
  actionPlan: string[];
};

export type ContentRadarSnapshot = {
  schema: 'aifios.content-radar.v5';
  status: 'ready';
  snapshotId: string;
  industry: string;
  platform: ContentRadarPlatform;
  platformLabel: string;
  capturedAt: string;
  source: string;
  profile: {
    mode: 'broad';
    label: string;
  };
  coverage: {
    queryCount: number;
    baseQueryCount: number;
    dynamicQueryCount: number;
    successfulQueryCount: number;
    queries: string[];
    baseQueries: string[];
    dynamicQueries: string[];
    warnings: string[];
    enrichmentAttemptCount: number;
    enrichedArticleCount: number;
    commentArticleCount: number;
  };
  provenance: {
    objectType: 'search_snapshot';
    platform: ContentRadarPlatform;
    input: Record<string, string>;
    normalized: Record<string, number>;
    completeness: 'complete' | 'partial' | 'incomplete';
    missingFields: string[];
    errorReason: string | null;
    requestId: string | null;
    extractTrace: Array<{
      query: string;
      status: 'available' | 'unavailable';
      endpointId: string | null;
      capability: string;
      requestId: string | null;
    }>;
    enrichmentTrace: Array<{
      sourceUrl: string;
      kind: 'stats' | 'comments';
      status: 'available' | 'unavailable';
      endpointId: string | null;
      requestId: string | null;
      reason: string | null;
    }>;
  };
  quality: {
    evidenceCoverage: number;
    timeCoverage: number;
    metricCoverage: number;
    confidence: '高' | '中' | '低';
    languageStatus?: 'pass' | 'review_required';
    languageWarnings?: string[];
  };
  baseline: {
    status: 'establishing' | 'compared';
    previousCapturedAt: string | null;
    comparisonCount: number;
    snapshotCount: number;
    firstCapturedAt: string | null;
    trackedDays: number;
    note: string;
  };
  calibration: {
    status: 'insufficient' | 'tracking' | 'calibrated';
    matchedSampleCount: number;
    evaluatedPredictions: number;
    hitRate: number | null;
    falsePositiveRate: number | null;
    thresholds: { predictedScore: number; observedGrowthPercent: number };
    note: string;
  };
  methodology: {
    scopeLabel: string;
    rankScope: string;
    freshnessLabel: string;
    formulaVersion: string;
    formulaFactors: string[];
    scoreLegend: string[];
    limitations: string[];
  };
  metrics: {
    sampleCount: number;
    totalEngagement: number;
    creatorCount: number;
    directionCount: number;
    highPotentialCount: number;
    verifiedHitCount: number;
    potentialSampleCount: number;
    insufficientSampleCount: number;
    evidenceCoverage: number;
  };
  discovery: { emergingKeywords: Array<{ query: string; label: string }> };
  deepReport: ContentRadarReport;
  specialReports: ContentRadarReport[];
  creatorWatchlist: ContentRadarCreator[];
  opportunities: ContentRadarOpportunity[];
  samples: ContentRadarSample[];
  snapshotPath: string;
  historyPath: string;
};

export type ContentRadarComparisonRow = {
  query: string;
  title: string;
  xiaohongshu: { score: number; tier: ContentRadarOpportunity['tier']; lifecycle: string } | null;
  wechat_mp: { score: number; tier: ContentRadarOpportunity['tier']; lifecycle: string } | null;
  wechat_channels: { score: number; tier: ContentRadarOpportunity['tier']; lifecycle: string } | null;
  recommendation: string;
};

export type ContentRadarComparison = {
  industry: string;
  generatedAt: string;
  availablePlatforms: ContentRadarPlatform[];
  missingPlatforms: ContentRadarPlatform[];
  rows: ContentRadarComparisonRow[];
};

export class ContentRadarInputError extends Error {}
export class ContentRadarRuntimeError extends Error {}

type RadarRunner = (binary: string, args: string[], options: {
  cwd: string;
  timeout: number;
  maxBuffer: number;
}) => Promise<{ stdout: string; stderr: string }>;

type ExecFailure = Error & { stdout?: string; stderr?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseChoice<T extends readonly string[]>(value: unknown, choices: T, message: string): T[number] {
  const selected = text(value);
  if ((choices as readonly string[]).includes(selected)) return selected as T[number];
  throw new ContentRadarInputError(message);
}

export function parseContentRadarPlatform(value: unknown): ContentRadarPlatform {
  return parseChoice(value, CONTENT_RADAR_PLATFORMS, '热门选题目前只支持小红书、公众号和视频号。');
}

export function parseContentRadarIndustry(value: unknown): string {
  const industry = text(value).replace(/\s+/g, ' ');
  if (industry.length < 2) throw new ContentRadarInputError('行业关键词至少需要 2 个字符。');
  if (industry.length > 30) throw new ContentRadarInputError('行业关键词不能超过 30 个字符。');
  return industry;
}

function assertSnapshot(value: unknown): ContentRadarSnapshot {
  if (!isRecord(value) || value.schema !== 'aifios.content-radar.v5' || value.status !== 'ready') {
    throw new ContentRadarRuntimeError('平台数据格式不正确。请重新查找选题。');
  }
  const platform = parseContentRadarPlatform(value.platform);
  if (!Array.isArray(value.samples) || !Array.isArray(value.opportunities) || !Array.isArray(value.creatorWatchlist)) {
    throw new ContentRadarRuntimeError('平台数据不完整。请重新查找选题。');
  }
  return { ...value, platform } as ContentRadarSnapshot;
}

export function parseContentRadarOutput(stdout: string): ContentRadarSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new ContentRadarRuntimeError('平台数据没有正常返回。请稍后重试。');
  }
  const envelope = isRecord(parsed) ? parsed : {};
  if (envelope.ok !== true) throw new ContentRadarRuntimeError(contentRadarFailureMessage(envelope.error));
  return assertSnapshot(envelope.radar);
}

function contentRadarFailureMessage(value: unknown): string {
  const message = text(value).toLowerCase();
  if (/token|api[ _-]?key|密钥|授权|登录|unauthori[sz]ed|forbidden/.test(message)) {
    return '平台数据连接失败。请到系统设置检查密钥后重试。';
  }
  return '平台数据暂时没有返回可用结果。请稍后重试。';
}

const defaultRunner: RadarRunner = (binary, args, options) => new Promise((resolve, reject) => {
  execFile(binary, args, options, (error, stdout, stderr) => {
    if (error) {
      const failure = error as ExecFailure;
      failure.stdout = String(stdout || '');
      failure.stderr = String(stderr || '');
      reject(failure);
      return;
    }
    resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
  });
});

function errorFromFailure(error: unknown): ContentRadarRuntimeError {
  const failure = error as ExecFailure;
  if (failure?.stdout) {
    try {
      const parsed = JSON.parse(failure.stdout.trim()) as unknown;
      if (isRecord(parsed) && text(parsed.error)) return new ContentRadarRuntimeError(contentRadarFailureMessage(parsed.error));
    } catch {
      // Fall through to the safe generic message below.
    }
  }
  return new ContentRadarRuntimeError(contentRadarFailureMessage(text(failure?.stderr) || (error instanceof Error ? error.message : '')));
}

export async function runContentRadar(
  input: { industry: unknown; platform: unknown },
  runner: RadarRunner = defaultRunner,
): Promise<ContentRadarSnapshot> {
  const industry = parseContentRadarIndustry(input.industry);
  const platform = parseContentRadarPlatform(input.platform);
  const script = contentRuntimeToolPath('content_radar.py');
  try {
    const result = await runner(runtimePythonBinary(), [
      script,
      '--project', PROJECT_DIR,
      '--industry', industry,
      '--platform', platform,
    ], {
      cwd: PROJECT_DIR,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseContentRadarOutput(result.stdout);
  } catch (error) {
    if (error instanceof ContentRadarInputError || error instanceof ContentRadarRuntimeError) throw error;
    throw errorFromFailure(error);
  }
}

function latestSnapshotPath(platform: ContentRadarPlatform): string {
  return runtimeJoin('materials', 'content-radar', platform, 'latest.json');
}

export async function readLatestContentRadar(platformValue: unknown): Promise<ContentRadarSnapshot | null> {
  const platform = parseContentRadarPlatform(platformValue);
  const relative = latestSnapshotPath(platform);
  const absolute = safeResolve(PROJECT_DIR, relative);
  if (!absolute) throw new ContentRadarRuntimeError('上次保存的平台数据无法读取。请重新查找选题。');
  try {
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new ContentRadarRuntimeError('上次保存的平台数据无法读取。请重新查找选题。');
    const parsed = JSON.parse(await readFile(absolute, 'utf-8')) as unknown;
    if (isRecord(parsed) && parsed.schema !== 'aifios.content-radar.v5') return null;
    return assertSnapshot(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ContentRadarRuntimeError) throw error;
    throw new ContentRadarRuntimeError('上次保存的平台数据无法读取。请重新查找选题。');
  }
}

export function compareContentRadarSnapshots(
  xiaohongshu: ContentRadarSnapshot | null,
  wechatMp: ContentRadarSnapshot | null,
  wechatChannels: ContentRadarSnapshot | null,
  industryValue?: unknown,
): ContentRadarComparison {
  const industry = industryValue ? parseContentRadarIndustry(industryValue) : (xiaohongshu?.industry || wechatMp?.industry || wechatChannels?.industry || '美妆行业');
  const validXhs = xiaohongshu?.industry === industry ? xiaohongshu : null;
  const validWechat = wechatMp?.industry === industry ? wechatMp : null;
  const validChannels = wechatChannels?.industry === industry ? wechatChannels : null;
  const byQuery = new Map<string, { title: string; xhs?: ContentRadarOpportunity; wechat?: ContentRadarOpportunity; channels?: ContentRadarOpportunity }>();
  for (const item of validXhs?.opportunities || []) {
    byQuery.set(item.query, { title: item.title, xhs: item });
  }
  for (const item of validWechat?.opportunities || []) {
    const current = byQuery.get(item.query) || { title: item.title };
    byQuery.set(item.query, { ...current, wechat: item });
  }
  for (const item of validChannels?.opportunities || []) {
    const current = byQuery.get(item.query) || { title: item.title };
    byQuery.set(item.query, { ...current, channels: item });
  }
  const rows = [...byQuery.entries()].map(([query, item]): ContentRadarComparisonRow => {
    const scores = [
      item.xhs ? { platform: '小红书', score: item.xhs.opportunityScore, action: '先做图文验证' } : null,
      item.wechat ? { platform: '公众号', score: item.wechat.opportunityScore, action: '先写一篇完整文章' } : null,
      item.channels ? { platform: '视频号', score: item.channels.opportunityScore, action: '先做一条口播验证' } : null,
    ].filter((entry): entry is { platform: string; score: number; action: string } => Boolean(entry))
      .sort((left, right) => right.score - left.score);
    let recommendation = '目前只有一个平台的数据，先在这个平台验证';
    if (scores.length >= 2) {
      recommendation = scores[0].score - scores[1].score < 8
        ? `${scores.map((entry) => entry.platform).join('、')}都可以做，分别按各自平台的原生结构生成`
        : `${scores[0].platform}数据更好，${scores[0].action}`;
    }
    return {
      query,
      title: item.title,
      xiaohongshu: item.xhs ? { score: item.xhs.opportunityScore, tier: item.xhs.tier, lifecycle: item.xhs.lifecycle.label } : null,
      wechat_mp: item.wechat ? { score: item.wechat.opportunityScore, tier: item.wechat.tier, lifecycle: item.wechat.lifecycle.label } : null,
      wechat_channels: item.channels ? { score: item.channels.opportunityScore, tier: item.channels.tier, lifecycle: item.channels.lifecycle.label } : null,
      recommendation,
    };
  }).sort((a, b) => Math.max(b.xiaohongshu?.score || 0, b.wechat_mp?.score || 0, b.wechat_channels?.score || 0) - Math.max(a.xiaohongshu?.score || 0, a.wechat_mp?.score || 0, a.wechat_channels?.score || 0));
  const availablePlatforms = [validXhs ? 'xiaohongshu' : null, validWechat ? 'wechat_mp' : null, validChannels ? 'wechat_channels' : null].filter(Boolean) as ContentRadarPlatform[];
  return {
    industry,
    generatedAt: new Date().toISOString(),
    availablePlatforms,
    missingPlatforms: CONTENT_RADAR_PLATFORMS.filter((platform) => !availablePlatforms.includes(platform)),
    rows,
  };
}

export async function readContentRadarComparison(industryValue: unknown): Promise<ContentRadarComparison> {
  const industry = parseContentRadarIndustry(industryValue);
  const [xiaohongshu, wechatMp, wechatChannels] = await Promise.all([
    readLatestContentRadar('xiaohongshu'),
    readLatestContentRadar('wechat_mp'),
    readLatestContentRadar('wechat_channels'),
  ]);
  return compareContentRadarSnapshots(xiaohongshu, wechatMp, wechatChannels, industry);
}

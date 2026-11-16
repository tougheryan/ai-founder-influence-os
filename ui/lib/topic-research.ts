import { createHash } from 'node:crypto';
import { assertTextInput, InputLimitError, MAX_SHORT_TEXT_BYTES } from './input-limits';
import { readOutputFile } from './output-files';
import { verifyRuntimeTikomniMarketSnapshot, type TikomniSnapshotVerification } from './runtime-writer';

export const REQUIRED_TOPIC_RESEARCH_PLATFORMS = [
  'wechat_mp',
  'xiaohongshu',
  'wechat_channels',
] as const;

export type TopicResearchPlatform = (typeof REQUIRED_TOPIC_RESEARCH_PLATFORMS)[number];

export type TopicResearchBinding = {
  runId: string;
  snapshotPath: string;
  snapshotSha256: string;
};

export type VerifiedTopicResearchBinding = TopicResearchBinding & {
  sourcePath: string;
};

export type TopicResearchSample = {
  id: string;
  title: string;
  account: string;
  publishedAt: string;
  contentForm: string;
  metrics: Record<'reads' | 'likes' | 'collects' | 'comments' | 'shares', number | null>;
  hook: string;
  mechanism: string;
  url: string;
  sampleClass: 'verified_hit' | 'potential' | 'related' | 'insufficient';
  hitScore: number;
  classificationReason: string;
  evidenceStatus: 'sufficient' | 'insufficient';
  confidence: number;
  metricCompleteness: number;
  ageDays: number | null;
  scoreComponents: Record<string, number>;
  creatorBaseline: number | null;
  creatorLift: number | null;
  engagementRate: number | null;
  scoreVersion: string;
};

export type TopicResearchPlatformGroup = {
  platform: TopicResearchPlatform;
  label: string;
  sampleCount: number;
  samples: TopicResearchSample[];
};

export type TopicResearchSamples = VerifiedTopicResearchBinding & {
  requiredPlatforms: readonly TopicResearchPlatform[];
  totalSampleCount: number;
  groups: TopicResearchPlatformGroup[];
};

export class TopicResearchAccessError extends Error {}

const PLATFORM_LABELS: Record<TopicResearchPlatform, string> = {
  wechat_mp: '公众号',
  xiaohongshu: '小红书',
  wechat_channels: '视频号',
};

const METRIC_KEYS = ['reads', 'likes', 'collects', 'comments', 'shares'] as const;

function compact(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function parseRunId(value: unknown): string {
  const runId = assertTextInput(value, 'run ID', MAX_SHORT_TEXT_BYTES).trim();
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) {
    throw new InputLimitError('run ID 格式不正确。');
  }
  return runId;
}

function parseSnapshotPath(value: unknown, runId: string): string {
  const snapshotPath = assertTextInput(value, 'TikOmni 研究快照路径', MAX_SHORT_TEXT_BYTES)
    .trim()
    .replace(/\\/g, '/');
  const prefix = `runs/${runId}/market-research/`;
  if (
    !snapshotPath.startsWith(prefix)
    || !snapshotPath.endsWith('/snapshot.json')
    || snapshotPath.includes('..')
  ) {
    throw new InputLimitError('TikOmni 研究快照必须属于当前 run。');
  }
  return snapshotPath;
}

function parseSnapshotSha256(value: unknown): string {
  const sha256 = assertTextInput(value, 'TikOmni 研究快照 SHA-256', MAX_SHORT_TEXT_BYTES).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new InputLimitError('TikOmni 研究快照 SHA-256 格式不正确。');
  }
  return sha256;
}

export function parseTopicResearchBinding(value: {
  runId: unknown;
  snapshotPath: unknown;
  snapshotSha256: unknown;
}): TopicResearchBinding {
  const runId = parseRunId(value.runId);
  return {
    runId,
    snapshotPath: parseSnapshotPath(value.snapshotPath, runId),
    snapshotSha256: parseSnapshotSha256(value.snapshotSha256),
  };
}

function verificationValue(verification: TikomniSnapshotVerification, key: keyof TikomniSnapshotVerification): string {
  const value = verification[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * One shared fail-closed guard for sample browsing, suggestion generation, and
 * topic selection. A stale, mismatched, or unverified snapshot can never be
 * treated as a usable research source.
 */
export async function assertVerifiedTopicResearchBinding(
  binding: TopicResearchBinding,
): Promise<VerifiedTopicResearchBinding> {
  const verification = await verifyRuntimeTikomniMarketSnapshot(binding.runId, binding.snapshotPath);
  if (!verification.verified) {
    throw new TopicResearchAccessError(
      `TikOmni 研究快照未通过校验：${verificationValue(verification, 'reason') || '未知错误'}`,
    );
  }
  const verifiedRunId = verificationValue(verification, 'run_id');
  const verifiedPath = verificationValue(verification, 'manifest_path');
  const verifiedSha256 = verificationValue(verification, 'snapshot_sha256').toLowerCase();
  const sourcePath = verificationValue(verification, 'source_path');
  if (
    verifiedRunId !== binding.runId
    || verifiedPath !== binding.snapshotPath
    || verifiedSha256 !== binding.snapshotSha256
    || !sourcePath.startsWith('pipeline/intake/')
    || sourcePath.includes('..')
    || sourcePath.includes('\\')
  ) {
    throw new TopicResearchAccessError('TikOmni 研究快照与当前任务或素材绑定不一致。');
  }
  return { ...binding, sourcePath };
}

function safeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function metric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000
    ? Math.floor(value)
    : null;
}

function scoreValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function contentForm(platform: TopicResearchPlatform, value: unknown): string {
  const form = compact(value, 16);
  if (['文章', '图文', '视频', '直播', '图文/视频', '内容'].includes(form)) return form;
  if (platform === 'wechat_mp') return '文章';
  if (platform === 'wechat_channels') return '视频';
  return '图文/视频';
}

function normalizedSample(
  platform: TopicResearchPlatform,
  value: unknown,
  index: number,
): TopicResearchSample | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const signal = value as Record<string, unknown>;
  const title = compact(signal.title, 160) || '未命名样本';
  const url = safeUrl(signal.source_url);
  const metricsValue = signal.metrics && typeof signal.metrics === 'object' && !Array.isArray(signal.metrics)
    ? signal.metrics as Record<string, unknown>
    : {};
  const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, metric(metricsValue[key])])) as TopicResearchSample['metrics'];
  const scoreComponentsValue = signal.score_components && typeof signal.score_components === 'object' && !Array.isArray(signal.score_components)
    ? signal.score_components as Record<string, unknown>
    : {};
  const scoreComponents = Object.fromEntries(Object.entries(scoreComponentsValue).flatMap(([key, value]) => {
    const parsed = scoreValue(value);
    return parsed === null ? [] : [[key, parsed]];
  }));
  const sampleClass = ['verified_hit', 'potential', 'related', 'insufficient'].includes(String(signal.sample_class))
    ? signal.sample_class as TopicResearchSample['sampleClass']
    : 'insufficient';
  const id = createHash('sha256')
    .update([platform, String(index), title, url].join('\u0000'))
    .digest('hex')
    .slice(0, 20);
  return {
    id: `sample_${id}`,
    title,
    account: compact(signal.account, 100) || '未标注账号',
    publishedAt: compact(signal.published_at, 64),
    contentForm: contentForm(platform, signal.content_form),
    metrics,
    hook: compact(signal.hook, 220) || '需打开原内容查看开场表达。',
    mechanism: compact(signal.mechanism, 100) || '待人工阅读确认',
    url,
    sampleClass,
    hitScore: metric(signal.hit_score) || 0,
    classificationReason: compact(signal.classification_reason, 160) || '缺少足够的公开表现指标，只能作为相关内容参考',
    evidenceStatus: signal.evidence_status === 'sufficient' ? 'sufficient' : 'insufficient',
    confidence: metric(signal.confidence) || 0,
    metricCompleteness: scoreValue(signal.metric_completeness) || 0,
    ageDays: scoreValue(signal.age_days),
    scoreComponents,
    creatorBaseline: scoreValue(signal.creator_baseline),
    creatorLift: scoreValue(signal.creator_lift),
    engagementRate: scoreValue(signal.engagement_rate),
    scoreVersion: compact(signal.score_version, 80) || 'echo-founder.tikomni-hit-score.v5',
  };
}

function parseNormalizedPayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    const payload = parsed as Record<string, unknown>;
    if (!Array.isArray(payload.signals)) throw new Error('signals missing');
    return payload;
  } catch {
    throw new TopicResearchAccessError('TikOmni 研究快照中的规范化样本不可读取。');
  }
}

/**
 * Reads only the checksum-bound normalized snapshot. Its return shape is
 * intentionally a small browser-safe view and never includes raw provider
 * responses, raw snapshot paths, query payloads, or provider metadata.
 */
export async function readVerifiedTopicResearchSamples(
  binding: TopicResearchBinding,
): Promise<TopicResearchSamples> {
  const verified = await assertVerifiedTopicResearchBinding(binding);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readOutputFile(verified.snapshotPath)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('manifest invalid');
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new TopicResearchAccessError('TikOmni 研究快照清单不可读取。');
  }

  const normalizedPath = typeof manifest.normalized_path === 'string'
    ? manifest.normalized_path.replace(/\\/g, '/')
    : '';
  const expectedPrefix = `runs/${verified.runId}/market-research/`;
  if (
    !normalizedPath.startsWith(expectedPrefix)
    || !normalizedPath.endsWith('/normalized-samples.json')
    || normalizedPath.includes('..')
  ) {
    throw new TopicResearchAccessError('TikOmni 研究快照缺少可安全读取的规范化样本。');
  }
  let normalized: Record<string, unknown>;
  try {
    normalized = parseNormalizedPayload(await readOutputFile(normalizedPath));
  } catch (error) {
    if (error instanceof TopicResearchAccessError) throw error;
    throw new TopicResearchAccessError('TikOmni 研究快照中的规范化样本不可读取。');
  }
  const signals = normalized.signals as unknown[];
  const manifestPlatforms = Array.isArray(manifest.required_platforms) ? manifest.required_platforms : null;
  const requiredPlatforms = manifestPlatforms
    ? REQUIRED_TOPIC_RESEARCH_PLATFORMS.filter((platform) => manifestPlatforms.includes(platform))
    : [...REQUIRED_TOPIC_RESEARCH_PLATFORMS];
  const groups = requiredPlatforms.map((platform) => {
    const samples = signals.flatMap((signal, index) => {
      if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return [];
      const row = signal as Record<string, unknown>;
      if (row.platform !== platform) return [];
      const sample = normalizedSample(platform, row, index);
      return sample ? [sample] : [];
    });
    const sampleCount = samples.length;
    return {
      platform,
      label: PLATFORM_LABELS[platform],
      sampleCount,
      samples,
    };
  });
  return {
    ...verified,
    requiredPlatforms,
    totalSampleCount: groups.reduce((count, group) => count + group.sampleCount, 0),
    groups,
  };
}

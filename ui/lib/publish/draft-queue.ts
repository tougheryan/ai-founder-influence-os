import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import type {
  PlatformDeliverables,
  PublishVisualAsset,
  SharePostDeliverable,
  VideoPublishScript,
  WechatPublishDeliverable,
} from '../publish-assets';
import { hasCompleteDraftQueue } from '../production-flow';
import { PROJECT_DIR, safeResolve } from '../project-root';
import { displayClientError } from '../client-error-copy';
import { userFacingErrorPayload } from '../user-facing-error';
import { withProjectWriteLock, type ProjectWriteLockOptions } from '../write-guard';

export const DRAFT_QUEUE_SCHEMA = 'aifios.publication-draft-queue.v1';
export const DRAFT_QUEUE_ROOT = 'materials/publication/drafts';

export const DRAFT_JOB_STATUSES = [
  'pending',
  'authorizing',
  'draft_filled',
  'retryable_failure',
  'manual_intervention_required',
  'published_confirmed',
  'unknown_completion',
] as const;

export type DraftJobStatus = (typeof DRAFT_JOB_STATUSES)[number];
export type PublicationPlatform = 'wechat' | 'xiaohongshu' | 'moments' | 'shipinhao' | 'douyin';
export type DraftDeliveryKind = 'draft_fill' | 'execution_package';
export type DraftAdapterKind = 'wechat_official_api' | 'authorized_browser' | 'mobile_bridge' | 'download';
export type LocalAuthorizationState =
  | 'not_checked'
  | 'authorized'
  | 'not_authorized'
  | 'requires_human_action';

export type SelectedAssetEvidence = {
  id?: string;
  path: string;
  sha256: string;
  role?: string;
};

export type DraftPayload = {
  title: string;
  summary?: string;
  copy_path?: string;
  html_path?: string;
  asset_paths: string[];
  image_order?: string;
  execution_package_path?: string;
  metadata?: Record<string, string>;
};

export type DraftJobEvent = {
  at: string;
  status: DraftJobStatus;
  adapter?: DraftAdapterKind;
  code?: string;
  displayMessage?: string;
  debugId?: string;
  /** Read compatibility only. New queue writes never populate this field. */
  message?: string;
};

export type DraftJob = {
  job_id: string;
  platform: PublicationPlatform;
  item_id: string;
  item_label: string;
  delivery_kind: DraftDeliveryKind;
  adapter: DraftAdapterKind;
  fallback_adapter?: 'authorized_browser';
  payload: DraftPayload;
  payload_hash: string;
  content_hash: string;
  selected_asset_hashes: SelectedAssetEvidence[];
  status: DraftJobStatus;
  authorization_state: LocalAuthorizationState;
  attempt_count: number;
  retry_count: number;
  last_attempt_at?: string;
  last_error?: {
    code: string;
    displayMessage?: string;
    debugId?: string;
    /** Read compatibility only. New queue writes never populate this field. */
    message?: string;
  };
  result_reference?: string;
  external_reference?: string;
  desktop_receipt_ids?: string[];
  events: DraftJobEvent[];
};

export type DraftQueue = {
  schema: typeof DRAFT_QUEUE_SCHEMA;
  queue_id: string;
  run_id: string;
  run_slug: string;
  package_path: string;
  package_sha256: string;
  visual_manifest_path?: string;
  visual_manifest_sha256?: string;
  created_at: string;
  updated_at: string;
  target_platforms?: Array<'wechat' | 'xiaohongshu' | 'shipinhao'>;
  jobs: DraftJob[];
};

export type DraftQueueInput = {
  runId: string;
  runSlug: string;
  packagePath: string;
  packageSha256: string;
  deliverables: PlatformDeliverables;
  visualManifestPath?: string;
  visualManifestSha256?: string;
  assetHashes?: Record<string, string>;
  /** SHA-256 of the exact local bytes handed to each platform adapter. */
  contentFileHashes: Record<string, string>;
  now?: string;
};

export type DraftAdapterResult = {
  status: Exclude<DraftJobStatus, 'pending' | 'authorizing' | 'published_confirmed'>;
  authorizationState?: LocalAuthorizationState;
  code?: string;
  message?: string;
  externalReference?: string;
};

export type DraftAdapter = {
  kind: DraftAdapterKind;
  available?: (job: DraftJob) => Promise<boolean> | boolean;
  fill: (job: DraftJob) => Promise<DraftAdapterResult> | DraftAdapterResult;
};

export type DraftQueueAdapters = {
  wechatOfficialApi?: DraftAdapter;
  wechatBrowser?: DraftAdapter;
  xiaohongshuBrowser?: DraftAdapter;
  momentsMobileBridge?: DraftAdapter;
  executionPackage?: DraftAdapter;
};

export type QueueRunResult = {
  queue: DraftQueue;
  attemptedJobIds: string[];
  skippedJobIds: string[];
};

export type QueueSave = (queue: DraftQueue) => Promise<void> | void;

const API_FALLBACK_CODES = new Set([
  'not_configured',
  'configuration_missing',
  'credential_unavailable',
  'api_unavailable',
  'network_unavailable',
  'network_timeout',
]);
const HUMAN_INTERVENTION_CODES = new Set([
  'captcha',
  'risk_control',
  'device_confirmation',
  'authorization_required',
  'browser_session_required',
  'mobile_bridge_required',
]);
const SENSITIVE_KEY = /(?:secret|token|cookie|password|api[_-]?key|private[_-]?key|credential)/i;
const MAX_EVENTS_PER_JOB = 40;
const DRAFT_APPROVAL_TRANSIENT_KEYS = new Set([
  'adapter',
  'authorization_state',
  'attempt_count',
  'retry_count',
  'last_attempt_at',
  'last_error',
  'result_reference',
  'external_reference',
  'events',
  'status',
  'updated_at',
]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function draftApprovalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(draftApprovalStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !DRAFT_APPROVAL_TRANSIENT_KEYS.has(key))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${draftApprovalStringify(item)}`)
    .join(',')}}`;
}

/** Matches the Python runtime's approval-relevant draft queue digest. */
export function draftQueueContractSha256(queue: DraftQueue): string {
  return sha256(draftApprovalStringify(queue));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableDraftCode(value: unknown, fallback: string): string {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9_]{2,79}$/.test(code) ? code : fallback;
}

function draftStatusDisplayMessage(status: DraftJobStatus, platform?: PublicationPlatform): string {
  if (status === 'pending') return '这份发布内容正在等待处理。';
  if (status === 'authorizing') return '正在准备平台草稿，请稍候。';
  if (status === 'draft_filled') return platform === 'shipinhao' || platform === 'douyin'
    ? '口播稿与拍摄说明已准备好，可下载后自行拍摄。'
    : '草稿已填入，请到平台后台检查。';
  if (status === 'published_confirmed') return '发布结果已经确认。';
  if (status === 'manual_intervention_required') {
    if (platform === 'xiaohongshu') return '还没有登录小红书。打开编辑器完成登录后再试。';
    if (platform === 'wechat') return '公众号草稿暂时无法填入。请检查账号授权后重试。';
    if (platform === 'moments') return '手机连接尚未就绪。请连接已配对的手机后重试。';
    return '这份草稿需要你继续处理。请按页面提示完成后重试。';
  }
  if (status === 'unknown_completion') return '无法确认平台端是否已经完成。请先到平台后台检查，不要直接重试。';
  return '这份草稿暂时没有处理完成。请稍后重试。';
}

function newDraftFailure(
  cause: unknown,
  status: DraftJobStatus,
  platform: PublicationPlatform,
  rawCode?: string,
): { code: string; displayMessage: string; debugId: string } {
  const code = stableDraftCode(rawCode, status);
  const fallback = draftStatusDisplayMessage(status, platform);
  const displayMessage = displayClientError({
    code,
    message: cause instanceof Error
      ? cause.message
      : cause && typeof cause === 'object' && typeof (cause as { message?: unknown }).message === 'string'
        ? (cause as { message: string }).message
        : '',
    platform,
  }, fallback);
  const payload = userFacingErrorPayload(cause, {
    error: displayMessage,
    code,
    context: `publication-draft:${code}`,
  });
  return {
    code: stableDraftCode(payload.code, code),
    displayMessage: payload.error,
    debugId: payload.debugId || `err_${sha256(`${code}:${Date.now()}`).slice(0, 16)}`,
  };
}

function legacyDraftFailure(
  value: unknown,
  status: DraftJobStatus,
  platform: PublicationPlatform,
): { code: string; displayMessage: string; debugId: string } {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const code = stableDraftCode(record.code, status);
  const rawMessage = typeof record.displayMessage === 'string'
    ? record.displayMessage
    : typeof record.message === 'string'
      ? record.message
      : '';
  const displayMessage = displayClientError({ code, message: rawMessage, platform }, draftStatusDisplayMessage(status, platform));
  const storedDebugId = typeof record.debugId === 'string' ? record.debugId : '';
  return {
    code,
    displayMessage,
    debugId: /^err_[a-z0-9_]{6,72}$/i.test(storedDebugId)
      ? storedDebugId
      : `err_legacy_${sha256(`${code}:${rawMessage}`).slice(0, 12)}`,
  };
}

function safeDraftEvent(event: DraftJobEvent, platform: PublicationPlatform): DraftJobEvent {
  const code = event.code ? stableDraftCode(event.code, event.status) : undefined;
  const isFailure = ['retryable_failure', 'manual_intervention_required', 'unknown_completion'].includes(event.status);
  if (isFailure) {
    const failure = legacyDraftFailure(event, event.status, platform);
    return {
      at: event.at,
      status: event.status,
      ...(event.adapter ? { adapter: event.adapter } : {}),
      code: failure.code,
      displayMessage: failure.displayMessage,
      debugId: failure.debugId,
    };
  }
  return {
    at: event.at,
    status: event.status,
    ...(event.adapter ? { adapter: event.adapter } : {}),
    ...(code ? { code } : {}),
    displayMessage: draftStatusDisplayMessage(event.status, platform),
  };
}

function sanitizeRunSlug(value: string): string {
  const result = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (!result) throw new Error('run slug 不合法');
  return result;
}

function safePath(value: string | undefined): string {
  const path = (value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) return '';
  return path;
}

function stringRecord(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => Boolean(value)) as Array<[string, string]>);
}

function assetsForPayload(
  assets: PublishVisualAsset[] | undefined,
  hashes: Record<string, string>,
): SelectedAssetEvidence[] {
  const seen = new Set<string>();
  const output: SelectedAssetEvidence[] = [];
  for (const asset of assets || []) {
    const path = safePath(asset.path);
    if (!path || asset.status !== 'ready' || seen.has(path)) continue;
    const assetHash = hashes[path];
    if (!/^[a-f0-9]{64}$/i.test(assetHash || '')) {
      throw new Error(`发布资产缺少有效文件哈希：${path}`);
    }
    seen.add(path);
    output.push({
      ...(asset.id ? { id: asset.id } : {}),
      path,
      sha256: assetHash,
      ...(asset.role ? { role: asset.role } : {}),
    });
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function createJob(input: {
  runId: string;
  platform: PublicationPlatform;
  itemId: string;
  label: string;
  deliveryKind: DraftDeliveryKind;
  adapter: DraftAdapterKind;
  fallbackAdapter?: 'authorized_browser';
  payload: DraftPayload;
  contentPath: string;
  contentFileHashes: Record<string, string>;
  assets?: PublishVisualAsset[];
  assetHashes: Record<string, string>;
  now: string;
}): DraftJob {
  const selectedAssets = assetsForPayload(input.assets, input.assetHashes);
  const payload: DraftPayload = {
    ...input.payload,
    asset_paths: selectedAssets.map((asset) => asset.path),
    ...(input.payload.metadata && Object.keys(input.payload.metadata).length
      ? { metadata: input.payload.metadata }
      : {}),
  };
  const contentPath = safePath(input.contentPath);
  const contentHash = input.contentFileHashes[contentPath];
  if (!contentPath || !/^[a-f0-9]{64}$/i.test(contentHash || '')) {
    throw new Error(`发布正文缺少有效文件哈希：${contentPath || 'unknown'}`);
  }
  const payloadHash = sha256(stableStringify({
    platform: input.platform,
    item_id: input.itemId,
    delivery_kind: input.deliveryKind,
    payload,
    content_hash: contentHash,
    selected_asset_hashes: selectedAssets,
  }));
  const jobId = `draft_${sha256(`${input.runId}:${input.platform}:${input.itemId}:${payloadHash}`).slice(0, 20)}`;
  return {
    job_id: jobId,
    platform: input.platform,
    item_id: input.itemId,
    item_label: input.label,
    delivery_kind: input.deliveryKind,
    adapter: input.adapter,
    ...(input.fallbackAdapter ? { fallback_adapter: input.fallbackAdapter } : {}),
    payload,
    payload_hash: payloadHash,
    content_hash: contentHash,
    selected_asset_hashes: selectedAssets,
    status: 'pending',
    authorization_state: 'not_checked',
    attempt_count: 0,
    retry_count: 0,
    events: [{
      at: input.now,
      status: 'pending',
      adapter: input.adapter,
      displayMessage: '这份发布内容正在等待处理。',
    }],
  };
}

function preferredWechatHtml(deliverable: WechatPublishDeliverable): string {
  return safePath(deliverable.htmlCandidates.find((candidate) => candidate.recommended)?.path)
    || safePath(deliverable.htmlCandidates[0]?.path);
}

function opinionPayload(post: SharePostDeliverable, platform: 'xiaohongshu' | 'moments'): DraftPayload {
  const form = post.publishForms[platform];
  return {
    title: form.title || post.title,
    copy_path: safePath(post.publishPaths[platform]),
    image_order: form.imageOrder,
    asset_paths: [],
    metadata: stringRecord({
      tags: form.tags.join(' '),
    }),
  };
}

function opinionAssets(
  post: SharePostDeliverable,
  platform: 'xiaohongshu' | 'moments',
): PublishVisualAsset[] {
  return post.platformVisualAssets?.[platform] || post.visualAssets;
}

function videoPayload(script: VideoPublishScript): DraftPayload {
  return {
    title: script.title,
    copy_path: safePath(script.primaryPath),
    execution_package_path: safePath(script.primaryPath),
    asset_paths: [],
    metadata: stringRecord({
      hook: script.hook,
      duration: script.duration,
      platform_note: script.platformNote,
      tags: script.tags.join(' '),
    }),
  };
}

/**
 * Build a deterministic, local-only queue from the approved platform delivery
 * manifest. The queue deliberately contains paths and hashes, never login
 * cookies, API keys, or raw authorization data.
 */
export function createDraftQueue(input: DraftQueueInput): DraftQueue {
  const now = input.now || new Date().toISOString();
  const runSlug = sanitizeRunSlug(input.runSlug);
  const packagePath = safePath(input.packagePath);
  if (!input.runId.trim() || !packagePath || !input.packageSha256) {
    throw new Error('创建发布队列需要当前 run、内容包路径和内容哈希。');
  }
  const assetHashes = input.assetHashes || {};
  const jobs: DraftJob[] = [];
  const { wechat, xiaohongshu, moments, shipinhao, douyin } = input.deliverables;

  if (wechat) {
    const hasWechatApiCover = wechat.coverOptions.some((asset) => (
      asset.status === 'ready' && /\.(?:png|jpe?g|webp|gif|avif)$/i.test(asset.path)
    ));
    jobs.push(createJob({
      runId: input.runId,
      platform: 'wechat',
      itemId: 'wechat-article',
      label: '公众号长文',
      deliveryKind: 'draft_fill',
      adapter: hasWechatApiCover ? 'wechat_official_api' : 'authorized_browser',
      ...(hasWechatApiCover ? { fallbackAdapter: 'authorized_browser' as const } : {}),
      payload: {
        title: wechat.recommendedTitle,
        summary: wechat.summary,
        copy_path: safePath(wechat.markdownPath),
        html_path: preferredWechatHtml(wechat),
        asset_paths: [],
        metadata: stringRecord({
          share_posts: wechat.shareCopyPaths.join(','),
        }),
      },
      contentPath: preferredWechatHtml(wechat) || safePath(wechat.markdownPath),
      contentFileHashes: input.contentFileHashes,
      assets: [...wechat.coverOptions, ...wechat.visualAssets],
      assetHashes,
      now,
    }));
  }

  for (const post of xiaohongshu?.posts || []) {
    jobs.push(createJob({
      runId: input.runId,
      platform: 'xiaohongshu',
      itemId: `xiaohongshu-opinion-${post.index}`,
      label: `小红书观点图文 ${post.index}`,
      deliveryKind: 'draft_fill',
      adapter: 'authorized_browser',
      payload: opinionPayload(post, 'xiaohongshu'),
      contentPath: safePath(post.publishPaths.xiaohongshu),
      contentFileHashes: input.contentFileHashes,
      assets: opinionAssets(post, 'xiaohongshu'),
      assetHashes,
      now,
    }));
  }

  for (const post of moments?.posts || []) {
    jobs.push(createJob({
      runId: input.runId,
      platform: 'moments',
      itemId: `moments-opinion-${post.index}`,
      label: `朋友圈观点图文 ${post.index}`,
      deliveryKind: 'draft_fill',
      adapter: 'mobile_bridge',
      payload: opinionPayload(post, 'moments'),
      contentPath: safePath(post.publishPaths.moments),
      contentFileHashes: input.contentFileHashes,
      assets: opinionAssets(post, 'moments'),
      assetHashes,
      now,
    }));
  }

  for (const script of shipinhao?.scripts || []) {
    jobs.push(createJob({
      runId: input.runId,
      platform: 'shipinhao',
      itemId: `shipinhao-video-execution-${script.index}`,
      label: `视频号口播稿与拍摄说明 ${script.index}`,
      deliveryKind: 'execution_package',
      adapter: 'download',
      payload: videoPayload(script),
      contentPath: safePath(script.primaryPath),
      contentFileHashes: input.contentFileHashes,
      assets: script.visualAssets,
      assetHashes,
      now,
    }));
  }

  for (const script of douyin?.scripts || []) {
    jobs.push(createJob({
      runId: input.runId,
      platform: 'douyin',
      itemId: `douyin-video-execution-${script.index}`,
      label: `抖音口播稿与拍摄说明 ${script.index}`,
      deliveryKind: 'execution_package',
      adapter: 'download',
      payload: videoPayload(script),
      contentPath: safePath(script.primaryPath),
      contentFileHashes: input.contentFileHashes,
      assets: script.visualAssets,
      assetHashes,
      now,
    }));
  }

  const legacyContract = Boolean(moments || douyin);
  const targetPlatforms = [
    wechat ? 'wechat' : '',
    xiaohongshu ? 'xiaohongshu' : '',
    shipinhao ? 'shipinhao' : '',
  ].filter(Boolean) as Array<'wechat' | 'xiaohongshu' | 'shipinhao'>;
  if (legacyContract) {
    if (!wechat || (xiaohongshu?.posts.length || 0) !== 3 || (moments?.posts.length || 0) !== 3
      || (shipinhao?.scripts.length || 0) !== 2 || (douyin?.scripts.length || 0) !== 2) {
      throw new Error('旧版发布任务必须完整保留原有 11 项交付，不能部分迁移。');
    }
  } else if (!targetPlatforms.length
    || (wechat ? 1 : 0) + (xiaohongshu?.posts.length || 0) + (shipinhao?.scripts.length || 0) !== jobs.length
    || (xiaohongshu && xiaohongshu.posts.length !== 1)
    || (shipinhao && shipinhao.scripts.length !== 1)) {
    throw new Error('新版发布任务必须只包含已选平台：公众号 1 篇、小红书 1 组图文、视频号 1 份口播执行稿。');
  }

  const queueId = `queue_${sha256(`${input.runId}:${packagePath}:${input.packageSha256}`).slice(0, 20)}`;
  const queue: DraftQueue = {
    schema: DRAFT_QUEUE_SCHEMA,
    queue_id: queueId,
    run_id: input.runId,
    run_slug: runSlug,
    package_path: packagePath,
    package_sha256: input.packageSha256,
    ...(input.visualManifestPath ? { visual_manifest_path: safePath(input.visualManifestPath) } : {}),
    ...(input.visualManifestSha256 ? { visual_manifest_sha256: input.visualManifestSha256 } : {}),
    created_at: now,
    updated_at: now,
    ...(!legacyContract ? { target_platforms: targetPlatforms } : {}),
    jobs,
  };
  assertQueueDoesNotContainSecrets(queue);
  return queue;
}

export function queuePathForRun(runSlug: string): string {
  return `${DRAFT_QUEUE_ROOT}/${sanitizeRunSlug(runSlug)}/draft-queue.json`;
}

export function isDraftQueuePath(value: string): boolean {
  return new RegExp(`^${DRAFT_QUEUE_ROOT}/[A-Za-z0-9_\\-\\u4e00-\\u9fff]+/draft-queue\\.json$`).test(value);
}

/**
 * Every mutation of a queue must use this one key. Atomic file replacement
 * protects readers from torn writes, while this lock protects read-modify-write
 * operations from overwriting each other.
 */
export function draftQueueWriteLockKey(relativePath: string): string {
  if (!isDraftQueuePath(relativePath)) throw new Error('发布队列路径不在允许的本地目录中。');
  return `publication-draft-queue:${relativePath}`;
}

export async function withDraftQueueWriteLock<T>(
  relativePath: string,
  task: () => Promise<T>,
  options?: ProjectWriteLockOptions,
): Promise<T> {
  return withProjectWriteLock(draftQueueWriteLockKey(relativePath), task, options);
}

function assertQueueDoesNotContainSecrets(value: unknown, path = 'queue'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertQueueDoesNotContainSecrets(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`发布队列不能保存敏感字段：${path}.${key}`);
    }
    assertQueueDoesNotContainSecrets(nested, `${path}.${key}`);
  }
}

function asDraftJobStatus(value: unknown): DraftJobStatus | null {
  return typeof value === 'string' && (DRAFT_JOB_STATUSES as readonly string[]).includes(value)
    ? value as DraftJobStatus
    : null;
}

function validateQueue(queue: unknown): DraftQueue {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) throw new Error('发布队列 JSON 格式无效。');
  const parsed = queue as Partial<DraftQueue>;
  if (parsed.schema !== DRAFT_QUEUE_SCHEMA || !parsed.run_id || !parsed.run_slug || !Array.isArray(parsed.jobs)) {
    throw new Error('发布队列缺少必要字段。');
  }
  if (!isDraftQueuePath(queuePathForRun(parsed.run_slug))) throw new Error('发布队列 run slug 无效。');
  const jobIds = new Set<string>();
  for (const job of parsed.jobs) {
    if (!job || typeof job !== 'object' || !/^draft_[a-f0-9]{20}$/.test(job.job_id) || !asDraftJobStatus(job.status)) {
      throw new Error('发布队列包含无效任务。');
    }
    if (jobIds.has(job.job_id)) throw new Error('发布队列任务 ID 重复。');
    jobIds.add(job.job_id);
    job.events = Array.isArray(job.events)
      ? job.events
        .filter((event): event is DraftJobEvent => Boolean(
          event
          && typeof event === 'object'
          && typeof event.at === 'string'
          && asDraftJobStatus(event.status),
        ))
        .slice(-MAX_EVENTS_PER_JOB)
        .map((event) => safeDraftEvent(event, job.platform))
      : [];
    if (job.last_error) {
      job.last_error = legacyDraftFailure(job.last_error, job.status, job.platform);
    }
  }
  assertQueueDoesNotContainSecrets(parsed);
  return parsed as DraftQueue;
}

function assertCompleteProductionQueue(queue: DraftQueue): DraftQueue {
  if (!hasCompleteDraftQueue(queue)) {
    throw new Error('发布任务必须完整包含本期已选平台，且任务标识与交付类型必须匹配。');
  }
  return queue;
}

async function assertSafeQueueTarget(relativePath: string): Promise<string> {
  if (!isDraftQueuePath(relativePath)) throw new Error('发布队列路径不在允许的本地目录中。');
  const target = safeResolve(PROJECT_DIR, relativePath);
  if (!target) throw new Error('发布队列路径不在当前项目内。');
  const projectRoot = safeResolve(PROJECT_DIR, '.');
  if (!projectRoot) throw new Error('项目路径不可用。');
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const relation = relative(projectRoot, parent);
  if (relation === '..' || relation.startsWith('../')) throw new Error('发布队列目录不在当前项目内。');
  const targetRelation = relative(projectRoot, target);
  let current = projectRoot;
  for (const segment of targetRelation.split(sep)) {
    if (!segment || segment === '.') continue;
    current = `${current}${sep}${segment}`;
    try {
      const component = await lstat(current);
      if (component.isSymbolicLink()) throw new Error('发布队列路径不能包含符号链接。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('发布队列不能写入符号链接。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

export async function writeDraftQueue(relativePath: string, input: DraftQueue): Promise<void> {
  const queue = validateQueue({ ...input, updated_at: new Date().toISOString() });
  const target = await assertSafeQueueTarget(relativePath);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(queue, null, 2)}\n`;
  await writeFile(temporary, serialized, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readDraftQueue(relativePath: string): Promise<DraftQueue> {
  const target = await assertSafeQueueTarget(relativePath);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('发布队列必须是项目内普通 JSON 文件。');
  return validateQueue(JSON.parse(await readFile(target, 'utf-8')));
}

/** Hashes project-local content/asset files without following symbolic links. */
export async function hashProjectFiles(paths: string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const input of paths) {
    const path = safePath(input);
    if (!path || hashes[path]) continue;
    const target = safeResolve(PROJECT_DIR, path);
    if (!target) throw new Error(`发布资产路径不在当前项目内：${path}`);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`发布资产必须是项目内普通文件：${path}`);
    hashes[path] = sha256(await readFile(target));
  }
  return hashes;
}

export function collectReadyAssetPaths(deliverables: PlatformDeliverables): string[] {
  const assets: PublishVisualAsset[] = [
    ...(deliverables.wechat?.coverOptions || []),
    ...(deliverables.wechat?.visualAssets || []),
    ...(deliverables.xiaohongshu?.visualAssets || []),
    ...(deliverables.moments?.visualAssets || []),
    ...(deliverables.shipinhao?.visualAssets || []),
    ...(deliverables.douyin?.visualAssets || []),
    ...(deliverables.xiaohongshu?.posts || []).flatMap((post) => post.visualAssets),
    ...(deliverables.moments?.posts || []).flatMap((post) => post.visualAssets),
  ];
  return Array.from(new Set(assets
    .filter((asset) => asset.status === 'ready')
    .map((asset) => safePath(asset.path))
    .filter(Boolean)));
}

/**
 * Files whose exact bytes are handed to a publication adapter. Hashing these
 * before queue creation binds the later desktop fill to the generated body,
 * rather than only to a renderer-supplied object or a logical copy excerpt.
 */
export function collectDraftContentPaths(deliverables: PlatformDeliverables): string[] {
  const paths = [
    deliverables.wechat
      ? preferredWechatHtml(deliverables.wechat) || safePath(deliverables.wechat.markdownPath)
      : '',
    ...(deliverables.xiaohongshu?.posts || []).map((post) => safePath(post.publishPaths.xiaohongshu)),
    ...(deliverables.moments?.posts || []).map((post) => safePath(post.publishPaths.moments)),
    ...(deliverables.shipinhao?.scripts || []).map((script) => safePath(script.primaryPath)),
    ...(deliverables.douyin?.scripts || []).map((script) => safePath(script.primaryPath)),
  ];
  return Array.from(new Set(paths.filter(Boolean)));
}

export function canAutomaticallyRetry(job: Pick<DraftJob, 'status'>): boolean {
  return job.status === 'pending' || job.status === 'retryable_failure';
}

/**
 * A main-process receipt can also complete an explicitly confirmed retry after
 * the user resolves a browser/mobile prerequisite. Unknown completion remains
 * terminal because another external attempt could duplicate a platform draft.
 */
export function canAcceptDesktopReceipt(job: Pick<DraftJob, 'status'>): boolean {
  return canAutomaticallyRetry(job) || job.status === 'manual_intervention_required';
}

function cloneQueue(queue: DraftQueue): DraftQueue {
  return JSON.parse(JSON.stringify(queue)) as DraftQueue;
}

function appendEvent(job: DraftJob, event: DraftJobEvent): void {
  job.events = [...(job.events || []), event].slice(-MAX_EVENTS_PER_JOB);
}

function normalizeAdapterResult(result: DraftAdapterResult, fallbackAdapter: DraftAdapterKind): DraftAdapterResult {
  const code = result.code?.trim().toLowerCase();
  if (code && HUMAN_INTERVENTION_CODES.has(code)) {
    return {
      ...result,
      status: 'manual_intervention_required',
      authorizationState: 'requires_human_action',
    };
  }
  const rawStatus = result.status as string;
  if (!(DRAFT_JOB_STATUSES as readonly string[]).includes(rawStatus) || rawStatus === 'published_confirmed') {
    return {
      status: 'unknown_completion',
      authorizationState: 'requires_human_action',
      code: 'invalid_adapter_result',
      message: `适配器 ${fallbackAdapter} 返回了不可确认的状态。`,
    };
  }
  return result;
}

async function adapterAvailable(adapter: DraftAdapter | undefined, job: DraftJob): Promise<boolean> {
  if (!adapter) return false;
  return adapter.available ? Boolean(await adapter.available(job)) : true;
}

async function invokeAdapter(adapter: DraftAdapter, job: DraftJob): Promise<DraftAdapterResult> {
  try {
    return normalizeAdapterResult(await adapter.fill(job), adapter.kind);
  } catch (error) {
    return {
      status: 'retryable_failure',
      code: 'adapter_unavailable',
      message: error instanceof Error ? error.message : '本地发布适配器不可用。',
    };
  }
}

function noAdapterResult(kind: DraftAdapterKind): DraftAdapterResult {
  const code = kind === 'mobile_bridge' ? 'mobile_bridge_required'
    : kind === 'authorized_browser' ? 'browser_session_required'
      : kind === 'wechat_official_api' ? 'credential_unavailable'
        : 'adapter_unavailable';
  return {
    status: kind === 'download' ? 'retryable_failure' : 'manual_intervention_required',
    authorizationState: kind === 'download' ? 'not_checked' : 'requires_human_action',
    code,
    message: '本机尚未连接可用的发布适配器。',
  };
}

async function executeWechatJob(job: DraftJob, adapters: DraftQueueAdapters): Promise<{ result: DraftAdapterResult; adapter: DraftAdapterKind }> {
  const api = adapters.wechatOfficialApi;
  if (api && await adapterAvailable(api, job)) {
    const result = await invokeAdapter(api, job);
    if (!API_FALLBACK_CODES.has(result.code?.toLowerCase() || '')) {
      return { result, adapter: 'wechat_official_api' };
    }
  }
  const browser = adapters.wechatBrowser;
  if (browser && await adapterAvailable(browser, job)) {
    return { result: await invokeAdapter(browser, job), adapter: 'authorized_browser' };
  }
  return { result: noAdapterResult('authorized_browser'), adapter: 'authorized_browser' };
}

async function executeDraftJob(job: DraftJob, adapters: DraftQueueAdapters): Promise<{ result: DraftAdapterResult; adapter: DraftAdapterKind }> {
  if (job.platform === 'wechat') return executeWechatJob(job, adapters);
  const adapter = job.platform === 'xiaohongshu'
    ? adapters.xiaohongshuBrowser
    : job.platform === 'moments'
      ? adapters.momentsMobileBridge
      : adapters.executionPackage;
  const expectedKind: DraftAdapterKind = job.platform === 'xiaohongshu'
    ? 'authorized_browser'
    : job.platform === 'moments'
      ? 'mobile_bridge'
      : 'download';
  if (!adapter || !(await adapterAvailable(adapter, job))) {
    return { result: noAdapterResult(expectedKind), adapter: expectedKind };
  }
  return { result: await invokeAdapter(adapter, job), adapter: expectedKind };
}

function applyResult(job: DraftJob, result: DraftAdapterResult, adapter: DraftAdapterKind, now: string): void {
  const status = result.status;
  job.status = status;
  job.adapter = adapter;
  job.authorization_state = result.authorizationState || (status === 'draft_filled' ? 'authorized' : job.authorization_state);
  if (result.externalReference) job.external_reference = result.externalReference;
  if (status === 'retryable_failure' || status === 'manual_intervention_required' || status === 'unknown_completion') {
    job.last_error = newDraftFailure(result, status, job.platform, result.code);
  } else {
    delete job.last_error;
  }
  appendEvent(job, {
    at: now,
    status,
    adapter,
    ...(job.last_error
      ? {
        code: job.last_error.code,
        displayMessage: job.last_error.displayMessage,
        debugId: job.last_error.debugId,
      }
      : {
        ...(result.code ? { code: stableDraftCode(result.code, status) } : {}),
        displayMessage: draftStatusDisplayMessage(status, job.platform),
      }),
  });
}

function adapterMatchesPlatform(platform: PublicationPlatform, adapter: DraftAdapterKind): boolean {
  if (platform === 'wechat') return adapter === 'wechat_official_api' || adapter === 'authorized_browser';
  if (platform === 'xiaohongshu') return adapter === 'authorized_browser';
  if (platform === 'moments') return adapter === 'mobile_bridge';
  return adapter === 'download';
}

/**
 * Applies a result produced and signed by the Electron main-process bridge.
 * The caller is responsible for verifying its signed receipt before this
 * mutation. This still validates the job/platform pairing and never permits a
 * bridge result to mark a public send as complete.
 */
export function applyDesktopDraftResult(
  input: DraftQueue,
  options: {
    jobId: string;
    payloadHash: string;
    receiptId: string;
    adapter: DraftAdapterKind;
    result: DraftAdapterResult;
    now?: string;
  },
): DraftQueue {
  const queue = cloneQueue(assertCompleteProductionQueue(validateQueue(input)));
  const job = queue.jobs.find((candidate) => candidate.job_id === options.jobId);
  if (!job) throw new Error('桌面发布回执不属于当前队列。');
  if (job.payload_hash !== options.payloadHash) throw new Error('桌面发布回执不属于当前内容版本。');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(options.receiptId)) throw new Error('桌面发布回执标识无效。');
  if ((job.desktop_receipt_ids || []).includes(options.receiptId)) throw new Error('桌面发布回执已被使用。');
  if (!canAcceptDesktopReceipt(job)) throw new Error('当前发布任务不允许再次写入桌面回执。');
  if (!adapterMatchesPlatform(job.platform, options.adapter)) throw new Error('桌面发布回执的适配器与平台不匹配。');

  const at = options.now || new Date().toISOString();
  const result = normalizeAdapterResult(options.result, options.adapter);
  job.status = 'authorizing';
  job.attempt_count += 1;
  if (job.attempt_count > 1) job.retry_count += 1;
  job.last_attempt_at = at;
  appendEvent(job, {
    at,
    status: 'authorizing',
    adapter: options.adapter,
    displayMessage: draftStatusDisplayMessage('authorizing', job.platform),
  });
  applyResult(job, result, options.adapter, at);
  job.desktop_receipt_ids = [...(job.desktop_receipt_ids || []), options.receiptId].slice(-40);
  queue.updated_at = at;
  return queue;
}

/**
 * Runs selected pending/retryable jobs in order. A failed item is persisted and
 * never aborts later items. Jobs interrupted while authorizing are deliberately
 * converted to unknown_completion on the next pass and are never auto-retried.
 */
export async function runDraftQueue(
  input: DraftQueue,
  adapters: DraftQueueAdapters,
  options: { jobIds?: string[]; persist?: QueueSave; now?: () => string } = {},
): Promise<QueueRunResult> {
  const queue = cloneQueue(assertCompleteProductionQueue(validateQueue(input)));
  const requested = options.jobIds ? new Set(options.jobIds) : null;
  const now = options.now || (() => new Date().toISOString());
  const attemptedJobIds: string[] = [];
  const skippedJobIds: string[] = [];

  for (const job of queue.jobs) {
    if (job.status === 'authorizing') {
      const at = now();
      job.status = 'unknown_completion';
      job.authorization_state = 'requires_human_action';
      job.last_error = newDraftFailure(
        new Error('授权或填入过程中被中断，无法确认平台端是否已完成。'),
        'unknown_completion',
        job.platform,
        'interrupted_authorization',
      );
      appendEvent(job, {
        at,
        status: 'unknown_completion',
        adapter: job.adapter,
        code: job.last_error.code,
        displayMessage: job.last_error.displayMessage,
        debugId: job.last_error.debugId,
      });
      queue.updated_at = at;
      await options.persist?.(queue);
    }
  }

  for (const job of queue.jobs) {
    if (requested && !requested.has(job.job_id)) {
      skippedJobIds.push(job.job_id);
      continue;
    }
    if (!canAutomaticallyRetry(job)) {
      skippedJobIds.push(job.job_id);
      continue;
    }
    const startingAt = now();
    job.status = 'authorizing';
    job.attempt_count += 1;
    if (job.attempt_count > 1) job.retry_count += 1;
    job.last_attempt_at = startingAt;
    appendEvent(job, {
      at: startingAt,
      status: 'authorizing',
      adapter: job.adapter,
      displayMessage: draftStatusDisplayMessage('authorizing', job.platform),
    });
    queue.updated_at = startingAt;
    await options.persist?.(queue);

    const { result, adapter } = await executeDraftJob(job, adapters);
    const completedAt = now();
    applyResult(job, result, adapter, completedAt);
    queue.updated_at = completedAt;
    attemptedJobIds.push(job.job_id);
    await options.persist?.(queue);
  }

  return { queue, attemptedJobIds, skippedJobIds };
}

export function resultRequiresManualIntervention(result: DraftAdapterResult): boolean {
  return result.status === 'manual_intervention_required' || result.status === 'unknown_completion';
}

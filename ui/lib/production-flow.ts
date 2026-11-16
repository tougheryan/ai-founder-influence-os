export const FIXED_PRODUCTION_PLATFORMS = [
  'wechat',
  'xiaohongshu',
  'shipinhao',
  'douyin',
  'moments',
] as const;

export type FixedProductionPlatform = (typeof FIXED_PRODUCTION_PLATFORMS)[number];

export const DRAFT_JOB_STATUSES = [
  'pending',
  'authorizing',
  'draft_filled',
  'retryable_failure',
  'manual_intervention_required',
  'published_confirmed',
  'unknown_completion',
] as const;

export type ProductionDraftJobStatus = (typeof DRAFT_JOB_STATUSES)[number];

export type ProductionDraftJob = {
  job_id: string;
  platform: FixedProductionPlatform;
  item_id: string;
  item_label: string;
  delivery_kind: 'draft_fill' | 'execution_package';
  adapter?: 'wechat_official_api' | 'authorized_browser' | 'mobile_bridge' | 'download';
  fallback_adapter?: 'authorized_browser';
  payload_hash?: string;
  content_hash?: string;
  status: ProductionDraftJobStatus;
  payload: {
    title?: string;
    summary?: string;
    copy_path?: string;
    html_path?: string;
    execution_package_path?: string;
    asset_paths?: string[];
    image_order?: string;
    metadata?: Record<string, string>;
  };
  selected_asset_hashes?: Array<{ id?: string; path: string; sha256: string; role?: string }>;
  last_error?: { message?: string };
};

export type ProductionDraftQueue = {
  run_id: string;
  run_slug: string;
  package_path: string;
  package_sha256?: string;
  target_platforms?: Array<'wechat' | 'xiaohongshu' | 'shipinhao'>;
  jobs: ProductionDraftJob[];
};

export type ProductionArtifactIntegrity = {
  path: string;
  sha256: string;
  exists: boolean;
  version?: number;
  registered_sha256?: string;
  hash_matches_registered?: boolean;
};

export type ProductionApprovalIntegrity = {
  approved: boolean;
  path?: string;
  sha256?: string;
  version?: number;
  approved_at?: string;
  invalidated_at?: string;
  invalidation_reason?: string;
  reason?: string;
};

export type ProductionFlowIntegrity = {
  recovered_content_task?: { taskId: string; packagePath: string; packageSha256: string } | null;
  run_id: string;
  slug: string;
  target_platforms?: Array<'wechat' | 'xiaohongshu' | 'shipinhao'>;
  current_phase: {
    id: 'material_boundary' | 'topic_template' | 'content_package' | 'visual_assets' | 'draft_information' | 'publication_result' | 'weekly_review';
    number: number;
  };
  artifacts: Record<string, ProductionArtifactIntegrity | null>;
  approvals: Record<string, ProductionApprovalIntegrity>;
  invalidations: Array<{
    scope: string;
    invalidated_at: string;
    reason: string;
  }>;
  draft_queue: {
    path: string;
    total: number;
    complete: boolean;
    lineage_current?: boolean;
    reason?: string;
    status_counts: Partial<Record<ProductionDraftJobStatus, number>>;
  };
  publication: {
    ledger_path: string;
    records: number;
    confirmed: number;
    complete: boolean;
  };
  weekly_review: {
    status: string;
    record_path?: string;
    missing_metrics: number;
    memory_applied: boolean;
  };
  resolved_paths: {
    package_path: string;
    deliverables_path: string;
    visual_manifest_path: string;
    draft_queue_path: string;
    publication_ledger_path: string;
  };
  recovery: {
    persistent_tasks: true;
    write_locking: true;
    idempotency_supported: true;
  };
};

/**
 * A queue loaded through the diagnostic path is actionable only when the
 * server's read-only integrity snapshot still binds it to the current run and
 * latest package. The publish APIs repeat the full hash checks before writes.
 */
export function publicationQueueMatchesIntegrity(
  queue: ProductionDraftQueue | null | undefined,
  integrity: ProductionFlowIntegrity | null | undefined,
  queuePath: string,
): boolean {
  return Boolean(
    queue
    && integrity
    && integrity.draft_queue.lineage_current === true
    && queue.run_id === integrity.run_id
    && queue.run_slug === integrity.slug
    && queue.package_path === integrity.resolved_paths.package_path
    && queuePath === integrity.resolved_paths.draft_queue_path,
  );
}

export const FINAL_DELIVERABLE_GROUPS = [
  'article',
  'social-cards',
  'video-scripts',
] as const;

export type FinalDeliverableGroupId = (typeof FINAL_DELIVERABLE_GROUPS)[number];

export type ProductionDeliverableGroup = {
  id: FinalDeliverableGroupId;
  label: string;
  countLabel: string;
  targetLabels: string[];
  jobs: ProductionDraftJob[];
};

/**
 * The content owner receives three reusable deliverables. Platform-specific
 * jobs remain transport operations only, so the review UI must not present
 * those operations as eleven different pieces of content.
 */
export function groupProductionDeliverables(
  queue: ProductionDraftQueue | null | undefined,
): ProductionDeliverableGroup[] {
  const jobs = queue?.jobs || [];
  const groups: ProductionDeliverableGroup[] = [
    {
      id: 'article',
      label: '公众号配图文章',
      countLabel: '1 篇',
      targetLabels: ['公众号'],
      jobs: jobs.filter((job) => job.platform === 'wechat'),
    },
    {
      id: 'social-cards',
      label: '图文卡片观点',
      countLabel: queue?.target_platforms
        ? `${jobs.filter((job) => job.platform === 'xiaohongshu').length} 组`
        : '3 组',
      targetLabels: queue?.target_platforms ? ['小红书'] : ['小红书', '朋友圈'],
      jobs: jobs.filter((job) => job.platform === 'xiaohongshu' || job.platform === 'moments'),
    },
    {
      id: 'video-scripts',
      label: '短视频口播稿',
      countLabel: queue?.target_platforms
        ? `${jobs.filter((job) => job.platform === 'shipinhao').length} 条`
        : '2 条',
      targetLabels: queue?.target_platforms ? ['视频号'] : ['视频号', '抖音', '小红书视频'],
      jobs: jobs.filter((job) => job.platform === 'shipinhao' || job.platform === 'douyin'),
    },
  ];
  return groups.filter((group) => group.jobs.length > 0);
}

/**
 * A production run is not a generic bag of draft jobs. The operator approves
 * one fixed 1 + 3 + 3 + 2 + 2 delivery contract, so a queue with the right
 * total but the wrong item substituted must not unlock publication.
 */
export const REQUIRED_DRAFT_JOB_CONTRACT = [
  { platform: 'wechat', itemId: 'wechat-article', deliveryKind: 'draft_fill' },
  { platform: 'xiaohongshu', itemId: 'xiaohongshu-opinion-1', deliveryKind: 'draft_fill' },
  { platform: 'xiaohongshu', itemId: 'xiaohongshu-opinion-2', deliveryKind: 'draft_fill' },
  { platform: 'xiaohongshu', itemId: 'xiaohongshu-opinion-3', deliveryKind: 'draft_fill' },
  { platform: 'moments', itemId: 'moments-opinion-1', deliveryKind: 'draft_fill' },
  { platform: 'moments', itemId: 'moments-opinion-2', deliveryKind: 'draft_fill' },
  { platform: 'moments', itemId: 'moments-opinion-3', deliveryKind: 'draft_fill' },
  { platform: 'shipinhao', itemId: 'shipinhao-video-execution-1', deliveryKind: 'execution_package' },
  { platform: 'shipinhao', itemId: 'shipinhao-video-execution-2', deliveryKind: 'execution_package' },
  { platform: 'douyin', itemId: 'douyin-video-execution-1', deliveryKind: 'execution_package' },
  { platform: 'douyin', itemId: 'douyin-video-execution-2', deliveryKind: 'execution_package' },
] as const;

function draftJobContractKey(input: {
  platform: string;
  itemId: string;
  deliveryKind: string;
}): string {
  return `${input.platform}:${input.itemId}:${input.deliveryKind}`;
}

export function selectedVisualManifestPath(slug: string): string {
  return `pipeline/visual/${slug}/selected-assets.json`;
}

export function hasCompleteDraftQueue(queue: ProductionDraftQueue | null | undefined): boolean {
  if (queue?.target_platforms) {
    const selected = queue.target_platforms;
    if (!selected.length || new Set(selected).size !== selected.length
      || selected.some((platform) => !['wechat', 'xiaohongshu', 'shipinhao'].includes(platform))) return false;
    const required = new Set<string>();
    if (selected.includes('wechat')) required.add(draftJobContractKey({ platform: 'wechat', itemId: 'wechat-article', deliveryKind: 'draft_fill' }));
    if (selected.includes('xiaohongshu')) required.add(draftJobContractKey({ platform: 'xiaohongshu', itemId: 'xiaohongshu-opinion-1', deliveryKind: 'draft_fill' }));
    if (selected.includes('shipinhao')) required.add(draftJobContractKey({ platform: 'shipinhao', itemId: 'shipinhao-video-execution-1', deliveryKind: 'execution_package' }));
    if (!Array.isArray(queue.jobs) || queue.jobs.length !== required.size) return false;
    const actual = new Set<string>();
    const jobIds = new Set<string>();
    for (const job of queue.jobs) {
      if (!job?.job_id || jobIds.has(job.job_id)) return false;
      const key = draftJobContractKey({ platform: job.platform, itemId: job.item_id, deliveryKind: job.delivery_kind });
      if (!required.has(key) || actual.has(key)) return false;
      jobIds.add(job.job_id);
      actual.add(key);
    }
    return actual.size === required.size;
  }
  if (!queue || !Array.isArray(queue.jobs) || queue.jobs.length !== REQUIRED_DRAFT_JOB_CONTRACT.length) return false;
  const required = new Set(REQUIRED_DRAFT_JOB_CONTRACT.map((job) => draftJobContractKey(job)));
  const actual = new Set<string>();
  const jobIds = new Set<string>();

  for (const job of queue.jobs) {
    if (!job
      || typeof job.job_id !== 'string'
      || !job.job_id.trim()
      || typeof job.platform !== 'string'
      || typeof job.item_id !== 'string'
      || typeof job.delivery_kind !== 'string'
      || jobIds.has(job.job_id)) {
      return false;
    }
    const key = draftJobContractKey({
      platform: job.platform,
      itemId: job.item_id,
      deliveryKind: job.delivery_kind,
    });
    if (!required.has(key) || actual.has(key)) return false;
    jobIds.add(job.job_id);
    actual.add(key);
  }

  return actual.size === required.size;
}

function imageEvidence(job: ProductionDraftJob): Array<{ id?: string; role?: string; path: string }> {
  const rows: Array<{ id?: string; role?: string; path: string }> = [
    ...(job.selected_asset_hashes || []).map((asset) => ({ id: asset.id, role: asset.role, path: asset.path })),
    ...(job.payload.asset_paths || []).map((path): { path: string } => ({ path })),
  ].filter((asset) => /\.(?:png|jpe?g|webp|gif|avif)$/i.test(asset.path));
  const selected = new Map<string, { id?: string; role?: string; path: string }>();
  for (const asset of rows) {
    const current = selected.get(asset.path);
    if (!current || (!current.id && asset.id) || (!current.role && asset.role)) selected.set(asset.path, asset);
  }
  return [...selected.values()];
}

function hasWechatHtml(job: ProductionDraftJob): boolean {
  const rows = [
    ...(job.selected_asset_hashes || []).map((asset) => ({ id: asset.id, path: asset.path })),
    ...(job.payload.asset_paths || []).map((path) => ({ id: '', path })),
    ...(typeof job.payload.html_path === 'string' ? [{ id: 'wechat-html', path: job.payload.html_path }] : []),
  ];
  return rows.some((asset) => (
    asset.id === 'wechat-html'
    || (/\.html?$/i.test(asset.path) && /wechat|公众号/i.test(asset.path))
  ));
}

/**
 * New platform-native runs require a WeChat HTML layout and an exact P1-P8
 * Xiaohongshu carousel. Historical queues keep their original image contract.
 */
export function hasCompleteFinalDeliverables(queue: ProductionDraftQueue | null | undefined): boolean {
  if (!queue || !hasCompleteDraftQueue(queue)) return false;
  if (queue.target_platforms) {
    if (queue.target_platforms.includes('wechat')) {
      const wechat = queue.jobs.find((job) => job.platform === 'wechat' && job.item_id === 'wechat-article');
      if (!wechat || !hasWechatHtml(wechat)) return false;
    }
    if (queue.target_platforms.includes('xiaohongshu')) {
      const xhs = queue.jobs.find((job) => job.platform === 'xiaohongshu' && job.item_id === 'xiaohongshu-opinion-1');
      if (!xhs || imageEvidence(xhs).length !== 8) return false;
    }
    return true;
  }
  const wechat = queue.jobs.find((job) => job.platform === 'wechat' && job.item_id === 'wechat-article');
  if (!wechat) return false;
  const articleAssets = imageEvidence(wechat);
  const hasCover = articleAssets.some((asset) => (
    /wechat[_-]?cover/i.test(asset.id || '')
    || /wechat[_-]?cover/i.test(asset.role || '')
    || /wechat-cover/i.test(asset.path)
  ));
  const hasInline = articleAssets.some((asset) => (
    /^inline-/i.test(asset.id || '')
    || /^inline-/i.test(asset.role || '')
    || /\/inline\//i.test(asset.path)
  ));
  if (!hasCover || !hasInline) return false;

  for (let index = 1; index <= 3; index += 1) {
    const xhs = queue.jobs.find((job) => job.platform === 'xiaohongshu' && job.item_id === `xiaohongshu-opinion-${index}`);
    const moments = queue.jobs.find((job) => job.platform === 'moments' && job.item_id === `moments-opinion-${index}`);
    if (!xhs || imageEvidence(xhs).length !== 5 || !moments || imageEvidence(moments).length !== 3) return false;
  }
  return true;
}

export function isPublicationQueueComplete(queue: ProductionDraftQueue | null | undefined): boolean {
  return Boolean(queue && hasCompleteDraftQueue(queue) && queue.jobs.every((job) => {
    if (job.delivery_kind === 'execution_package') {
      return job.adapter === 'download' && job.status === 'draft_filled';
    }
    return job.status === 'published_confirmed';
  }));
}

/** Execution packages are local downloads, never candidates for publication evidence. */
export function canRecordPublicationEvidence(
  job: Pick<ProductionDraftJob, 'delivery_kind' | 'status'>,
  unknownCompletionResolved = false,
): boolean {
  if (job.delivery_kind !== 'draft_fill') return false;
  if (job.status === 'published_confirmed' || job.status === 'pending' || job.status === 'authorizing') return false;
  if (job.status === 'unknown_completion') return unknownCompletionResolved;
  return job.status === 'draft_filled' || job.status === 'manual_intervention_required' || job.status === 'retryable_failure';
}

export function canPrepareLocalDraft(job: Pick<ProductionDraftJob, 'status'>): boolean {
  return job.status === 'pending' || job.status === 'retryable_failure';
}

export const MANUAL_DRAFT_RETRY_CONFIRMATION = '我已完成登录、验证码、设备确认或本机桥配对，并确认现在重试本项。系统仍不会点击公开发送。';

/** Manual bridge prerequisites may be retried only from a per-job user action. */
export function canExplicitlyRetryLocalDraft(job: Pick<ProductionDraftJob, 'status'>): boolean {
  return job.status === 'retryable_failure' || job.status === 'manual_intervention_required';
}

/** True when a confirmed queue still has work that can safely be filled locally. */
export function hasQueuedLocalDrafts(queue: ProductionDraftQueue | null | undefined): boolean {
  return Boolean(queue?.jobs.some((job) => canPrepareLocalDraft(job)));
}

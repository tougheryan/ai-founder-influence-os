import 'server-only';
import { recoveredContentTask } from './recovered-content-task';
import { verifyNativeXhsQueueCopy } from './publish-copy-integrity';

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import {
  APPROVAL_SCOPES,
  PRODUCTION_PHASES,
  type ProductionPhase,
  type RunApprovalScope,
} from './production-state';
import {
  hasCompleteDraftQueue,
  isPublicationQueueComplete,
  type ProductionArtifactIntegrity,
  type ProductionDraftJobStatus,
  type ProductionFlowIntegrity,
} from './production-flow';
import { PROJECT_DIR, safeResolve } from './project-root';
import { activeRuntimeRun, runtimeRunById, type RuntimeRun } from './runtime-run-resolver';
import { getRuntimeProductionApproval, type ProductionApprovalStatus } from './runtime-writer';
import {
  draftQueueContractSha256,
  queuePathForRun,
  readDraftQueue,
  type DraftQueue,
} from './publish/draft-queue';
import {
  ledgerPathForRun,
  readPublicationLedger,
  type PublicationLedger,
  type PublicationRecord,
} from './publish/publication-ledger';
import { getWeeklyReviewStatus, type WeeklyReviewSummary } from './weekly-review';

type IntegrityRuntimeRun = RuntimeRun & {
  approvals?: Record<string, ProductionApprovalStatus>;
  phase_artifacts?: Record<string, {
    path?: string;
    sha256?: string;
    version?: number;
  }>;
};

const PHASE_NUMBER = Object.fromEntries(PRODUCTION_PHASES.map((phase, index) => [phase, index + 1])) as Record<ProductionPhase, number>;

const PHASE_SCOPE: Partial<Record<ProductionPhase, RunApprovalScope>> = {
  topic_template: 'topic_template',
  content_package: 'content_package',
  visual_assets: 'visual_assets',
  draft_information: 'draft_information',
  publication_result: 'publication_result',
};

const PHASE_STEP: Partial<Record<ProductionPhase, string>> = {
  material_boundary: 'intake',
  topic_template: 'blueprint',
  content_package: 'package',
  publication_result: 'publish',
  weekly_review: 'review',
};

function nativeTargetPlatforms(run: IntegrityRuntimeRun): Array<'wechat' | 'xiaohongshu' | 'shipinhao'> {
  const requested = run.target_platforms?.length ? run.target_platforms : run.selected_platforms;
  const normalized = (requested || []).map((platform) => (
    platform === 'xhs' ? 'xiaohongshu' : platform === 'wechat_channels' ? 'shipinhao' : platform
  ));
  return ['wechat', 'xiaohongshu', 'shipinhao'].filter((platform) => normalized.includes(platform)) as Array<'wechat' | 'xiaohongshu' | 'shipinhao'>;
}

function artifactPath(run: IntegrityRuntimeRun, phase: ProductionPhase): string {
  const scope = PHASE_SCOPE[phase];
  if (scope) {
    const registered = run.phase_artifacts?.[scope]?.path;
    if (registered) return registered;
  }
  const step = PHASE_STEP[phase];
  return step ? run.steps?.[step]?.latest || '' : '';
}

async function verifiedProjectRegularFile(path: string): Promise<string | null> {
  if (!path || path.includes('\\')) return null;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  const target = safeResolve(PROJECT_DIR, path);
  if (!target) return null;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      const component = safeResolve(PROJECT_DIR, segments.slice(0, index + 1).join('/'));
      if (!component) return null;
      const info = await lstat(component);
      if (info.isSymbolicLink()) return null;
      if (index === segments.length - 1 ? !info.isFile() : !info.isDirectory()) return null;
    }
    return target;
  } catch {
    return null;
  }
}

export async function inspectProductionArtifact(
  path: string,
  phase: ProductionPhase,
  registered?: { sha256?: string; version?: number },
): Promise<ProductionArtifactIntegrity | null> {
  if (!path) return null;
  const target = await verifiedProjectRegularFile(path);
  const registration = registered?.sha256
    ? { registered_sha256: registered.sha256, hash_matches_registered: false }
    : {};
  if (!target) return { path, sha256: '', exists: false, ...registration, ...(registered?.version ? { version: registered.version } : {}) };
  try {
    const bytes = await readFile(target);
    const sha256 = phase === 'draft_information'
      ? draftApprovalSha256(bytes)
      : createHash('sha256').update(bytes).digest('hex');
    return {
      path,
      sha256,
      exists: true,
      ...(registered?.version ? { version: registered.version } : {}),
      ...(registered?.sha256 ? {
        registered_sha256: registered.sha256,
        hash_matches_registered: sha256 === registered.sha256,
      } : {}),
    };
  } catch {
    return { path, sha256: '', exists: false, ...registration, ...(registered?.version ? { version: registered.version } : {}) };
  }
}

export function draftApprovalSha256(bytes: Buffer): string {
  try {
    const payload = JSON.parse(bytes.toString('utf-8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || (payload as Record<string, unknown>).schema !== 'aifios.publication-draft-queue.v1') {
      return createHash('sha256').update(bytes).digest('hex');
    }
    return draftQueueContractSha256(payload as DraftQueue);
  } catch {
    return createHash('sha256').update(bytes).digest('hex');
  }
}

async function approvalIntegrity(
  run: IntegrityRuntimeRun,
  scope: RunApprovalScope,
  path: string,
): Promise<ProductionFlowIntegrity['approvals'][string]> {
  if (!path || !run.run_id) {
    return { approved: false, reason: '当前阶段尚无可确认产物。' };
  }
  try {
    const status = await getRuntimeProductionApproval(scope, path, run.run_id);
    return {
      approved: status.approved === true,
      ...(status.path ? { path: status.path } : {}),
      ...(status.sha256 ? { sha256: status.sha256 } : {}),
      ...(typeof status.version === 'number' ? { version: status.version } : {}),
      ...(status.approved_at ? { approved_at: status.approved_at } : {}),
      ...(status.invalidated_at ? { invalidated_at: status.invalidated_at } : {}),
      ...(status.invalidation_reason ? { invalidation_reason: status.invalidation_reason } : {}),
      ...(status.reason ? { reason: status.reason } : {}),
    };
  } catch (error) {
    return {
      approved: false,
      reason: error instanceof Error ? error.message : '阶段确认状态不可用。',
    };
  }
}

async function existingProjectFile(path: string): Promise<boolean> {
  return Boolean(await verifiedProjectRegularFile(path));
}

async function currentProjectFileSha256(path: string): Promise<string> {
  const target = await verifiedProjectRegularFile(path);
  if (!target) return '';
  try {
    return createHash('sha256').update(await readFile(target)).digest('hex');
  } catch {
    return '';
  }
}

export async function inspectDraftQueueIntegrity(path: string, run: IntegrityRuntimeRun): Promise<{
  queue: DraftQueue | null;
  summary: ProductionFlowIntegrity['draft_queue'];
}> {
  const empty = { path, total: 0, complete: false, lineage_current: false, status_counts: {} };
  if (!(await existingProjectFile(path))) return { queue: null, summary: empty };
  try {
    const queue = await readDraftQueue(path);
    if (queue.run_id !== run.run_id || queue.run_slug !== run.slug || path !== queuePathForRun(run.slug || '')) {
      return { queue: null, summary: { ...empty, reason: 'queue_run_mismatch' } };
    }
    const statusCounts: Partial<Record<ProductionDraftJobStatus, number>> = {};
    for (const job of queue.jobs) statusCounts[job.status] = (statusCounts[job.status] || 0) + 1;
    const packagePath = run.steps?.package?.latest || '';
    const visualPath = run.phase_artifacts?.visual_assets?.path || '';
    const visualRequired = !queue.target_platforms
      || queue.target_platforms.some((platform) => platform === 'wechat' || platform === 'xiaohongshu');
    const lineageCurrent = Boolean(
      packagePath
      && queue.package_path === packagePath
      && queue.package_sha256 === await currentProjectFileSha256(packagePath)
      && (visualRequired
        ? Boolean(
          visualPath
          && visualPath === `pipeline/visual/${run.slug}/selected-assets.json`
          && queue.visual_manifest_path === visualPath
          && queue.visual_manifest_sha256 === await currentProjectFileSha256(visualPath)
        )
        : !queue.visual_manifest_path),
    );
    if (lineageCurrent) {
      try { await verifyNativeXhsQueueCopy(queue); }
      catch { return { queue, summary: { ...empty, total: queue.jobs.length, status_counts: statusCounts, reason: 'draft_copy_mismatch' } }; }
    }
    return {
      queue: lineageCurrent ? queue : null,
      summary: {
        path,
        total: queue.jobs.length,
        complete: lineageCurrent && hasCompleteDraftQueue(queue),
        lineage_current: lineageCurrent,
        ...(!lineageCurrent ? { reason: 'upstream_artifact_changed' } : {}),
        status_counts: statusCounts,
      },
    };
  } catch {
    return { queue: null, summary: empty };
  }
}

async function publicationIntegrity(
  path: string,
  runId: string,
  runSlug: string,
  queue: DraftQueue | null,
): Promise<{
  ledger: PublicationLedger | null;
  summary: ProductionFlowIntegrity['publication'];
}> {
  let ledger: PublicationLedger | null = null;
  if (await existingProjectFile(path)) {
    try {
      const candidate = await readPublicationLedger(path);
      if (candidate.run_id === runId
        && candidate.run_slug === runSlug
        && candidate.queue_path === queuePathForRun(runSlug)) ledger = candidate;
    } catch {
      ledger = null;
    }
  }
  const boundRecords = boundPublicationRecords(ledger, queue);
  const evidenceChecks = await Promise.all(boundRecords.map(publicationEvidenceIsCurrent));
  const confirmed = evidenceChecks.filter(Boolean).length;
  const requiredPublicationCount = queue?.jobs.filter((job) => job.delivery_kind === 'draft_fill').length || 0;
  return {
    ledger,
    summary: {
      ledger_path: path,
      records: ledger?.records.length || 0,
      confirmed,
      complete: Boolean(
        queue
        && ledger
        && isPublicationQueueComplete(queue)
        && requiredPublicationCount > 0
        && ledger.records.length === requiredPublicationCount
        && boundRecords.length === requiredPublicationCount
        && confirmed === requiredPublicationCount,
      ),
    },
  };
}

function selectedAssetEvidenceMatches(
  left: DraftQueue['jobs'][number]['selected_asset_hashes'],
  right: PublicationLedger['records'][number]['selected_asset_hashes'],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((asset, index) => {
    const published = right[index];
    return Boolean(
      published
      && asset.path === published.path
      && asset.sha256 === published.sha256
      && asset.id === published.id
      && asset.role === published.role,
    );
  });
}

async function publicationEvidenceIsCurrent(record: PublicationRecord): Promise<boolean> {
  if (record.published_url) return true;
  if (!record.proof_path || !record.proof_sha256) return false;
  const target = await verifiedProjectRegularFile(record.proof_path);
  if (!target) return false;
  try {
    return createHash('sha256').update(await readFile(target)).digest('hex') === record.proof_sha256;
  } catch {
    return false;
  }
}

function boundPublicationRecords(
  ledger: PublicationLedger | null,
  queue: DraftQueue | null,
): PublicationRecord[] {
  if (!ledger || !queue
    || ledger.run_id !== queue.run_id
    || ledger.run_slug !== queue.run_slug
    || ledger.queue_id !== queue.queue_id) return [];
  const seenJobs = new Set<string>();
  return ledger.records.filter((record) => {
    if (record.queue_id !== queue.queue_id || seenJobs.has(record.job_id)) return false;
    const job = queue.jobs.find((candidate) => candidate.job_id === record.job_id);
    if (!job
      || job.delivery_kind !== 'draft_fill'
      || record.platform !== job.platform
      || record.item_id !== job.item_id
      || record.final_content_hash !== job.content_hash
      || record.payload_hash !== job.payload_hash
      || !selectedAssetEvidenceMatches(job.selected_asset_hashes, record.selected_asset_hashes)) return false;
    seenJobs.add(record.job_id);
    return true;
  });
}

/** Count only human publication records bound to this exact queue payload. */
export function countBoundPublicationRecords(
  ledger: PublicationLedger | null,
  queue: DraftQueue | null,
): number {
  return boundPublicationRecords(ledger, queue).length;
}

export function scopeWeeklyReviewIntegrity(
  summary: WeeklyReviewSummary | null,
  ledger: PublicationLedger | null,
  queue?: DraftQueue | null,
): ProductionFlowIntegrity['weekly_review'] {
  const publicationIds = new Set((ledger?.records || []).map((record) => record.record_id));
  if (!ledger || publicationIds.size === 0) return { status: 'not_due', missing_metrics: 0, memory_applied: false };
  if (queue !== undefined && (!queue
    || ledger.run_id !== queue.run_id
    || ledger.run_slug !== queue.run_slug
    || ledger.queue_id !== queue.queue_id
    || ledger.queue_path !== queuePathForRun(queue.run_slug)
    || countBoundPublicationRecords(ledger, queue) !== ledger.records.length)) {
    return { status: 'not_due', missing_metrics: 0, memory_applied: false };
  }
  const expectedLedgerPath = ledgerPathForRun(ledger.run_slug);
  const bindings = summary?.record?.run_bindings || [];
  const bindingMatches = bindings.some((binding) => (
    binding.run_id === ledger.run_id
    && binding.run_slug === ledger.run_slug
    && binding.queue_id === ledger.queue_id
    && binding.source_ledger_path === expectedLedgerPath
  ));
  if (!bindingMatches) {
    return { status: 'waiting_collection', missing_metrics: publicationIds.size, memory_applied: false };
  }
  const scopedItems = (summary?.record?.items || []).filter((item) => (
    publicationIds.has(item.source_record_id)
    && item.run_id === ledger.run_id
    && item.run_slug === ledger.run_slug
    && item.queue_id === ledger.queue_id
    && item.source_ledger_path === expectedLedgerPath
  ));
  if (!summary || scopedItems.length === 0) {
    return { status: 'waiting_collection', missing_metrics: publicationIds.size, memory_applied: false };
  }
  const representedIds = new Set(scopedItems.map((item) => item.source_record_id));
  const missingMetrics = scopedItems.reduce((total, item) => (
    total + item.required_metrics.filter((metric) => item.metrics[metric] === undefined).length
  ), publicationIds.size - representedIds.size);
  const scopedComplete = representedIds.size === publicationIds.size && missingMetrics === 0;
  const scopedStatus = !scopedComplete
    ? 'waiting_metrics'
    : summary.status === 'memory_applied'
      ? 'memory_applied'
      : summary.status === 'completed'
        ? 'completed'
        : 'ready';
  return {
    status: scopedStatus,
    ...(summary.record_path ? { record_path: summary.record_path } : {}),
    missing_metrics: missingMetrics,
    memory_applied: scopedStatus === 'memory_applied',
  };
}

function currentPhase(
  artifacts: ProductionFlowIntegrity['artifacts'],
  approvals: ProductionFlowIntegrity['approvals'],
  publication: ProductionFlowIntegrity['publication'],
): ProductionPhase {
  if (!artifacts.material_boundary?.exists) return 'material_boundary';
  for (const phase of ['topic_template', 'content_package', 'visual_assets', 'draft_information'] as const) {
    if (!artifacts[phase]?.exists || approvals[phase]?.approved !== true) return phase;
  }
  if (!publication.complete || approvals.publication_result?.approved !== true) return 'publication_result';
  return 'weekly_review';
}

export async function resolveProductionIntegrityRun(runId?: string): Promise<IntegrityRuntimeRun | null> {
  if (runId) return runtimeRunById(runId) as Promise<IntegrityRuntimeRun | null>;
  return activeRuntimeRun() as Promise<IntegrityRuntimeRun | null>;
}

/**
 * Builds one read-only, run-scoped truth snapshot for both production UIs.
 * It never trusts browser paths and never falls back to another run.
 */
export async function buildProductionFlowIntegrity(
  run: IntegrityRuntimeRun,
): Promise<ProductionFlowIntegrity | null> {
  if (!run.run_id || !run.slug) return null;
  const runId = run.run_id;
  const slug = run.slug;
  const artifactEntries = await Promise.all(PRODUCTION_PHASES.map(async (phase) => {
    const scope = PHASE_SCOPE[phase];
    const path = artifactPath(run, phase);
    const phaseRegistration = scope ? run.phase_artifacts?.[scope] : undefined;
    const approval = scope ? run.approvals?.[scope] : undefined;
    const registered = phaseRegistration || (approval?.path === path
      ? { sha256: approval.sha256, version: approval.version }
      : undefined);
    return [phase, await inspectProductionArtifact(path, phase, registered)] as const;
  }));
  const artifacts = Object.fromEntries(artifactEntries) as ProductionFlowIntegrity['artifacts'];
  const approvalEntries = await Promise.all(APPROVAL_SCOPES.map(async (scope) => (
    [scope, await approvalIntegrity(run, scope, artifacts[scope]?.path || artifactPath(run, scope))] as const
  )));
  const approvals = Object.fromEntries(approvalEntries) as ProductionFlowIntegrity['approvals'];
  const draftQueuePath = artifacts.draft_information?.path || queuePathForRun(slug);
  const ledgerPath = artifacts.publication_result?.path || ledgerPathForRun(slug);
  const { queue, summary: draftQueue } = await inspectDraftQueueIntegrity(draftQueuePath, run);
  const [publicationResult, weekly] = await Promise.all([
    publicationIntegrity(ledgerPath, runId, slug, queue),
    getWeeklyReviewStatus(false).catch(() => null),
  ]);
  const publication = publicationResult.summary;
  const phase = currentPhase(artifacts, approvals, publication);
  const invalidations = APPROVAL_SCOPES.flatMap((scope) => {
    const status = approvals[scope];
    const persisted = run.approvals?.[scope];
    const invalidatedAt = status.invalidated_at || persisted?.invalidated_at;
    const reason = status.invalidation_reason || persisted?.invalidation_reason;
    return invalidatedAt
      ? [{ scope, invalidated_at: invalidatedAt, reason: reason || 'artifact_changed' }]
      : [];
  });

  return {
    run_id: runId,
    slug,
    recovered_content_task: await recoveredContentTask(runId, run.steps?.package?.latest || '', approvals.content_package),
    target_platforms: nativeTargetPlatforms(run),
    current_phase: { id: phase, number: PHASE_NUMBER[phase] },
    artifacts,
    approvals,
    invalidations,
    draft_queue: draftQueue,
    publication,
    weekly_review: scopeWeeklyReviewIntegrity(weekly, publicationResult.ledger, queue),
    resolved_paths: {
      package_path: artifacts.content_package?.path || run.steps?.package?.latest || '',
      deliverables_path: `pipeline/publish-assets/${slug}-platform-deliverables.json`,
      visual_manifest_path: artifacts.visual_assets?.path || (run.selected_platforms?.some((platform) => platform === 'wechat' || platform === 'xhs') ? `pipeline/visual/${slug}/selected-assets.json` : ''),
      draft_queue_path: draftQueuePath,
      publication_ledger_path: ledgerPath,
    },
    recovery: {
      persistent_tasks: true,
      write_locking: true,
      idempotency_supported: true,
    },
  };
}

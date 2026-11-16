import { createHash } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import {
  draftQueueContractSha256,
  type DraftJob,
  type DraftQueue,
  type PublicationPlatform,
  type SelectedAssetEvidence,
} from './draft-queue';
import { PROJECT_DIR, safeResolve } from '../project-root';

export const PUBLICATION_LEDGER_SCHEMA = 'aifios.publication-ledger.v1';
export const PUBLICATION_LEDGER_ROOT = 'materials/publication/ledger';

export type PublicationRecord = {
  record_id: string;
  queue_id: string;
  job_id: string;
  platform: PublicationPlatform;
  item_id: string;
  final_content_hash: string;
  payload_hash: string;
  selected_asset_hashes: SelectedAssetEvidence[];
  // A public URL is ideal, but Moments and some restricted platform posts do
  // not expose one. In that case a local, hash-bound proof is the evidence.
  published_url?: string;
  proof_path?: string;
  proof_sha256?: string;
  published_at: string;
  human_confirmed: true;
  recorded_at: string;
  external_item_id?: string;
  notes?: string;
};

export type PublicationLedger = {
  schema: typeof PUBLICATION_LEDGER_SCHEMA;
  ledger_id: string;
  queue_id: string;
  run_id: string;
  run_slug: string;
  queue_path: string;
  queue_sha256: string;
  /** Approval-relevant queue digest; operational adapter progress is excluded. */
  queue_contract_sha256?: string;
  created_at: string;
  updated_at: string;
  records: PublicationRecord[];
};

export type PublicationResultInput = {
  jobId: string;
  humanConfirmed: boolean;
  publicationUrl?: string;
  proofPath?: string;
  proofSha256?: string;
  publishedAt?: string;
  externalItemId?: string;
  notes?: string;
  unknownCompletionResolved?: boolean;
  now?: string;
};

export type PublicationResultMutation = {
  queue: DraftQueue;
  ledger: PublicationLedger;
  record: PublicationRecord;
  idempotent: boolean;
};

const SENSITIVE_KEY = /(?:secret|token|cookie|password|api[_-]?key|private[_-]?key|credential)/i;
const PROOF_PATH_RE = /^materials\/(?:publish-proof|publish-evidence)\/[A-Za-z0-9._\-\u4e00-\u9fff]+\.(?:png|jpe?g|webp|pdf)$/i;
const LEDGER_ARCHIVE_PATH_RE = /^materials\/publication\/ledger\/[A-Za-z0-9_\-\u4e00-\u9fff]+\/archive\/ledger-[a-f0-9]{64}\.json$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
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

function assertNoSensitiveFields(value: unknown, path = 'ledger'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`发布台账不能保存敏感字段：${path}.${key}`);
    assertNoSensitiveFields(item, `${path}.${key}`);
  }
}

export function ledgerPathForRun(runSlug: string): string {
  return `${PUBLICATION_LEDGER_ROOT}/${sanitizeRunSlug(runSlug)}/publication-ledger.json`;
}

export function isPublicationLedgerPath(value: string): boolean {
  return new RegExp(`^${PUBLICATION_LEDGER_ROOT}/[A-Za-z0-9_\\-\\u4e00-\\u9fff]+/publication-ledger\\.json$`).test(value);
}

function validateUrl(value: string | undefined): string | undefined {
  const url = value?.trim() || '';
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    return parsed.toString();
  } catch {
    throw new Error('发布链接必须是有效的 http/https URL。');
  }
}

function validateProof(path: string | undefined, sha256: string | undefined): { path?: string; sha256?: string } {
  const normalizedPath = path?.trim() || '';
  const normalizedSha256 = sha256?.trim().toLowerCase() || '';
  if (!normalizedPath) {
    if (normalizedSha256) throw new Error('发布凭证哈希缺少对应的本地凭证路径。');
    return {};
  }
  if (!PROOF_PATH_RE.test(normalizedPath)) {
    throw new Error('发布凭证必须位于 materials/publish-proof 或 materials/publish-evidence，并使用 png、jpg、webp 或 pdf 文件。');
  }
  if (!/^[a-f0-9]{64}$/.test(normalizedSha256)) {
    throw new Error('发布凭证缺少有效的文件哈希。');
  }
  return { path: normalizedPath, sha256: normalizedSha256 };
}

function validateEvidence(
  publicationUrl: string | undefined,
  proofPath: string | undefined,
  proofSha256: string | undefined,
): { publicationUrl?: string; proofPath?: string; proofSha256?: string; identity: string } {
  const url = validateUrl(publicationUrl);
  const proof = validateProof(proofPath, proofSha256);
  if (!url && !proof.path) throw new Error('发布结果必须填写有效发布链接或可验证的本地发布凭证。');
  return {
    ...(url ? { publicationUrl: url } : {}),
    ...(proof.path ? { proofPath: proof.path, proofSha256: proof.sha256 } : {}),
    identity: url || `${proof.path}:${proof.sha256}`,
  };
}

function asPublishedAt(value: string | undefined, now: string): string {
  const candidate = (value || now).trim();
  if (Number.isNaN(new Date(candidate).getTime())) throw new Error('发布时间格式无效。');
  return candidate;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateLedger(value: unknown): PublicationLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('发布台账 JSON 格式无效。');
  const ledger = value as Partial<PublicationLedger>;
  if (ledger.schema !== PUBLICATION_LEDGER_SCHEMA || !ledger.ledger_id || !ledger.queue_id || !ledger.run_id || !ledger.run_slug || !Array.isArray(ledger.records)) {
    throw new Error('发布台账缺少必要字段。');
  }
  if (ledger.queue_contract_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(ledger.queue_contract_sha256)) {
    throw new Error('发布台账的队列契约哈希无效。');
  }
  const ids = new Set<string>();
  for (const record of ledger.records) {
    if (!record || typeof record !== 'object' || !record.record_id || !record.job_id || record.human_confirmed !== true) {
      throw new Error('发布台账包含无效记录。');
    }
    if (ids.has(record.record_id)) throw new Error('发布台账记录 ID 重复。');
    if (record.platform === 'shipinhao' || record.platform === 'douyin') {
      throw new Error('视频执行包只作为本机下载交付，不得写入发布台账。');
    }
    ids.add(record.record_id);
    validateEvidence(record.published_url, record.proof_path, record.proof_sha256);
  }
  assertNoSensitiveFields(ledger);
  return ledger as PublicationLedger;
}

export function createPublicationLedger(input: {
  queue: DraftQueue;
  queuePath: string;
  queueSha256: string;
  now?: string;
}): PublicationLedger {
  const now = input.now || new Date().toISOString();
  const ledger: PublicationLedger = {
    schema: PUBLICATION_LEDGER_SCHEMA,
    ledger_id: `ledger_${sha256(`${input.queue.queue_id}:${input.queue.run_id}`).slice(0, 20)}`,
    queue_id: input.queue.queue_id,
    run_id: input.queue.run_id,
    run_slug: sanitizeRunSlug(input.queue.run_slug),
    queue_path: input.queuePath,
    queue_sha256: input.queueSha256,
    queue_contract_sha256: draftQueueContractSha256(input.queue),
    created_at: now,
    updated_at: now,
    records: [],
  };
  assertNoSensitiveFields(ledger);
  return ledger;
}

export function canRecordPublicationResult(job: DraftJob, unknownCompletionResolved = false): boolean {
  if (job.delivery_kind !== 'draft_fill') return false;
  if (job.status === 'published_confirmed' || job.status === 'pending' || job.status === 'authorizing') return false;
  if (job.status === 'unknown_completion') return unknownCompletionResolved;
  return job.status === 'draft_filled' || job.status === 'manual_intervention_required' || job.status === 'retryable_failure';
}

/**
 * Adds human-proven publication evidence and binds it to the exact draft
 * payload/content/asset hashes. A public URL or a local hash-bound proof is
 * mandatory, so an unchecked draft can never be mistaken for an actual send.
 */
export function recordPublicationResult(
  queueInput: DraftQueue,
  ledgerInput: PublicationLedger,
  input: PublicationResultInput,
): PublicationResultMutation {
  if (input.humanConfirmed !== true) throw new Error('必须由操作者勾选确认已在平台内发送。');
  const now = input.now || new Date().toISOString();
  const queue = clone(queueInput);
  const ledger = clone(ledgerInput);
  if (ledger.run_id !== queue.run_id || ledger.run_slug !== queue.run_slug || ledger.queue_id && ledger.queue_id !== queue.queue_id) {
    throw new Error('发布台账不属于当前草稿队列。');
  }
  const job = queue.jobs.find((item) => item.job_id === input.jobId);
  if (!job) throw new Error('发布任务不存在于当前草稿队列。');
  if (job.delivery_kind !== 'draft_fill') {
    throw new Error('视频执行包在本机下载可用后即完成，不得确认发送或写入发布台账。');
  }
  const evidence = validateEvidence(input.publicationUrl, input.proofPath, input.proofSha256);
  const existing = ledger.records.find((record) => record.job_id === job.job_id);
  if (existing) {
    if (
      existing.published_url !== evidence.publicationUrl
      || existing.proof_path !== evidence.proofPath
      || existing.proof_sha256 !== evidence.proofSha256
    ) {
      throw new Error('该发布任务已有不同的已确认发布凭证。');
    }
    if (job.status !== 'published_confirmed') {
      job.status = 'published_confirmed';
      job.result_reference = `publication-ledger:${existing.record_id}`;
      job.authorization_state = 'authorized';
      job.last_error = undefined;
      job.events = [...job.events, {
        at: now,
        status: 'published_confirmed' as const,
        adapter: job.adapter,
        message: '已根据既有发布台账恢复任务状态。',
      }].slice(-40);
      queue.updated_at = now;
    }
    return { queue, ledger, record: existing, idempotent: true };
  }
  if (!canRecordPublicationResult(job, input.unknownCompletionResolved === true)) {
    throw new Error('该任务尚未准备完成，或处于未知完成状态；请先在平台内人工核实。');
  }

  const publishedAt = asPublishedAt(input.publishedAt, now);
  const record: PublicationRecord = {
    record_id: `publication_${sha256(`${ledger.ledger_id}:${job.job_id}:${evidence.identity}`).slice(0, 20)}`,
    queue_id: queue.queue_id,
    job_id: job.job_id,
    platform: job.platform,
    item_id: job.item_id,
    final_content_hash: job.content_hash,
    payload_hash: job.payload_hash,
    selected_asset_hashes: clone(job.selected_asset_hashes),
    ...(evidence.publicationUrl ? { published_url: evidence.publicationUrl } : {}),
    ...(evidence.proofPath ? { proof_path: evidence.proofPath, proof_sha256: evidence.proofSha256 } : {}),
    published_at: publishedAt,
    human_confirmed: true,
    recorded_at: now,
    ...(input.externalItemId?.trim() ? { external_item_id: input.externalItemId.trim() } : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
  };
  assertNoSensitiveFields(record);
  ledger.records.push(record);
  ledger.updated_at = now;
  job.status = 'published_confirmed';
  job.result_reference = `publication-ledger:${record.record_id}`;
  job.authorization_state = 'authorized';
  job.last_error = undefined;
  job.events = [...job.events, {
    at: now,
    status: 'published_confirmed' as const,
    adapter: job.adapter,
    message: '操作者已勾选确认并保存发布链接或可验证凭证。',
  }].slice(-40);
  queue.updated_at = now;
  return { queue, ledger, record, idempotent: false };
}

async function assertSafeLedgerFileTarget(
  relativePath: string,
  allowed: (path: string) => boolean,
): Promise<string> {
  if (!allowed(relativePath)) throw new Error('发布台账路径不在允许的本地目录中。');
  const target = safeResolve(PROJECT_DIR, relativePath);
  if (!target) throw new Error('发布台账路径不在当前项目内。');
  const projectRoot = safeResolve(PROJECT_DIR, '.');
  if (!projectRoot) throw new Error('项目路径不可用。');
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const relation = relative(projectRoot, parent);
  if (relation === '..' || relation.startsWith('../')) throw new Error('发布台账目录不在当前项目内。');
  const targetRelation = relative(projectRoot, target);
  let current = projectRoot;
  for (const segment of targetRelation.split(sep)) {
    if (!segment || segment === '.') continue;
    current = `${current}${sep}${segment}`;
    try {
      const component = await lstat(current);
      if (component.isSymbolicLink()) throw new Error('发布台账路径不能包含符号链接。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('发布台账不能写入符号链接。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

function assertSafeLedgerTarget(relativePath: string): Promise<string> {
  return assertSafeLedgerFileTarget(relativePath, isPublicationLedgerPath);
}

function assertSafeLedgerArchiveTarget(relativePath: string): Promise<string> {
  return assertSafeLedgerFileTarget(relativePath, (path) => LEDGER_ARCHIVE_PATH_RE.test(path));
}

export async function writePublicationLedger(relativePath: string, input: PublicationLedger): Promise<void> {
  const ledger = validateLedger({ ...input, updated_at: new Date().toISOString() });
  const target = await assertSafeLedgerTarget(relativePath);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readPublicationLedger(relativePath: string): Promise<PublicationLedger> {
  const target = await assertSafeLedgerTarget(relativePath);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('发布台账必须是项目内普通 JSON 文件。');
  return validateLedger(JSON.parse(await readFile(target, 'utf-8')));
}

/**
 * Preserves an obsolete ledger as content-addressed immutable evidence before
 * the canonical path is rebound to a new queue. Existing archives are never
 * overwritten; an exact duplicate is reused safely after a retry or crash.
 */
export async function archivePublicationLedger(
  relativePath: string,
  input: PublicationLedger,
): Promise<string> {
  const ledger = validateLedger(input);
  if (relativePath !== ledgerPathForRun(ledger.run_slug)) {
    throw new Error('待归档台账路径与 run 不一致。');
  }
  const canonical = stableStringify(ledger);
  const bytes = Buffer.from(`${JSON.stringify(JSON.parse(canonical), null, 2)}\n`, 'utf-8');
  const digest = sha256(canonical);
  const archivePath = `${PUBLICATION_LEDGER_ROOT}/${sanitizeRunSlug(ledger.run_slug)}/archive/ledger-${digest}.json`;
  const target = await assertSafeLedgerArchiveTarget(archivePath);
  const verifyExisting = async (): Promise<boolean> => {
    try {
      const info = await lstat(target);
      return info.isFile() && !info.isSymbolicLink() && (await readFile(target)).equals(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  if (await verifyExisting()) return archivePath;

  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await verifyExisting())) throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return archivePath;
}

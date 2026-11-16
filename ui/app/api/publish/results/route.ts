import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { PROJECT_DIR, redactLocalPaths, safeResolve } from '@/lib/project-root';
import {
  assertJsonInputSize,
  assertOptionalTextInput,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
  MAX_TEXT_ARTIFACT_BYTES,
} from '@/lib/input-limits';
import { getRuntimeProductionApproval, registerRuntimePhaseArtifact } from '@/lib/runtime-writer';
import { WriteLockError } from '@/lib/write-guard';
import {
  draftQueueContractSha256,
  isDraftQueuePath,
  readDraftQueue,
  sha256,
  withDraftQueueWriteLock,
  writeDraftQueue,
  type DraftQueue,
} from '@/lib/publish/draft-queue';
import {
  archivePublicationLedger,
  createPublicationLedger,
  isPublicationLedgerPath,
  ledgerPathForRun,
  readPublicationLedger,
  recordPublicationResult,
  writePublicationLedger,
  type PublicationResultMutation,
  type PublicationLedger,
} from '@/lib/publish/publication-ledger';
import {
  expectedUserFacingErrorResponse,
  KnownUserFacingError,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type ResultRequest = {
  queuePath?: unknown;
  jobId?: unknown;
  humanConfirmed?: unknown;
  publicationUrl?: unknown;
  proofPath?: unknown;
  publishedAt?: unknown;
  externalItemId?: unknown;
  notes?: unknown;
  unknownCompletionResolved?: unknown;
};

const QUEUE_PATH_RE = /^materials\/publication\/drafts\/[A-Za-z0-9_\-\u4e00-\u9fff]+\/draft-queue\.json$/;
const PUBLICATION_PROOF_PATH_RE = /^materials\/(?:publish-proof|publish-evidence)\/[A-Za-z0-9._\-\u4e00-\u9fff]+\.(?:png|jpe?g|webp|pdf)$/i;
const MAX_PUBLICATION_PROOF_BYTES = 50 * 1024 * 1024;

function assertQueuePath(value: unknown): string {
  const path = assertTextInput(value, '发布队列路径', MAX_SHORT_TEXT_BYTES).trim();
  if (!QUEUE_PATH_RE.test(path) || !isDraftQueuePath(path)) {
    throw new InputLimitError('发布队列路径不在允许的本地目录中。');
  }
  return path;
}

function assertJobId(value: unknown): string {
  const id = assertTextInput(value, '发布任务 ID', MAX_SHORT_TEXT_BYTES).trim();
  if (!/^draft_[a-f0-9]{20}$/.test(id)) throw new InputLimitError('发布任务 ID 无效。');
  return id;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new InputLimitError(`${label}必须明确勾选。`);
  return value;
}

function assertOptionalPublicationUrl(value: unknown): string | undefined {
  const url = assertOptionalTextInput(value, '发布链接', MAX_SHORT_TEXT_BYTES)?.trim() || '';
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new InputLimitError('发布链接必须是有效的 http/https URL。');
  }
  return url;
}

async function assertOptionalPublicationProof(value: unknown): Promise<{ path: string; sha256: string } | undefined> {
  const path = assertOptionalTextInput(value, '发布凭证', MAX_SHORT_TEXT_BYTES)?.trim() || '';
  if (!path) return undefined;
  if (!PUBLICATION_PROOF_PATH_RE.test(path)) {
    throw new InputLimitError('发布凭证必须位于 materials/publish-proof 或 materials/publish-evidence，并使用 png、jpg、webp 或 pdf 文件。');
  }
  const absolutePath = safeResolve(PROJECT_DIR, path);
  if (!absolutePath) throw new InputLimitError('发布凭证路径不在当前项目目录内。');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_PUBLICATION_PROOF_BYTES) {
      throw new InputLimitError('发布凭证必须是项目内非空的普通文件。');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new InputLimitError('发布凭证在读取过程中发生变化，请重新选择后再确认。');
    }
    return { path, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof InputLimitError) throw error;
    throw new InputLimitError('发布凭证文件不存在或无法读取。');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertOptionalPublishedAt(value: unknown): string | undefined {
  const publishedAt = assertOptionalTextInput(value, '发布时间', MAX_SHORT_TEXT_BYTES)?.trim();
  if (publishedAt && Number.isNaN(new Date(publishedAt).getTime())) {
    throw new InputLimitError('发布时间格式无效。');
  }
  return publishedAt;
}

async function readQueueBytes(relativePath: string): Promise<Buffer> {
  const target = safeResolve(PROJECT_DIR, relativePath);
  if (!target) throw new InputLimitError('发布队列路径不在当前项目内。');
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new InputLimitError('发布队列必须是项目内普通 JSON 文件。');
    return await readFile(target);
  } catch (error) {
    if (error instanceof InputLimitError) throw error;
    throw new InputLimitError('发布队列不存在或无法读取。');
  }
}

function selectedAssetsMatch(
  left: DraftQueue['jobs'][number]['selected_asset_hashes'],
  right: PublicationLedger['records'][number]['selected_asset_hashes'],
): boolean {
  return left.length === right.length && left.every((asset, index) => {
    const saved = right[index];
    return Boolean(saved
      && asset.id === saved.id
      && asset.path === saved.path
      && asset.sha256 === saved.sha256
      && asset.role === saved.role);
  });
}

function ledgerRecordsMatchQueue(ledger: PublicationLedger, queue: DraftQueue): boolean {
  const seenJobs = new Set<string>();
  return ledger.records.every((record) => {
    if (record.queue_id !== queue.queue_id || seenJobs.has(record.job_id)) return false;
    const job = queue.jobs.find((candidate) => candidate.job_id === record.job_id);
    if (!job
      || record.platform !== job.platform
      || record.item_id !== job.item_id
      || record.final_content_hash !== job.content_hash
      || record.payload_hash !== job.payload_hash
      || !selectedAssetsMatch(job.selected_asset_hashes, record.selected_asset_hashes)) return false;
    seenJobs.add(record.job_id);
    return true;
  });
}

function ledgerMatchesQueue(ledger: PublicationLedger, queue: DraftQueue, queuePath: string): boolean {
  if (ledger.run_id !== queue.run_id
    || ledger.run_slug !== queue.run_slug
    || ledger.queue_id !== queue.queue_id
    || ledger.queue_path !== queuePath
    || !ledgerRecordsMatchQueue(ledger, queue)) return false;
  if (ledger.queue_contract_sha256) {
    return ledger.queue_contract_sha256 === draftQueueContractSha256(queue);
  }
  // Legacy ledgers predate the stable queue contract digest. Existing records
  // still bind them to exact jobs; an empty legacy ledger is safely rotated.
  return ledger.records.length > 0;
}

async function loadLedgerOrCreate(queuePath: string, queue: DraftQueue) {
  const queueBytes = await readQueueBytes(queuePath);
  const ledgerPath = ledgerPathForRun(queue.run_slug);
  if (!isPublicationLedgerPath(ledgerPath)) throw new InputLimitError('发布台账路径无效。');
  try {
    const existing = await readPublicationLedger(ledgerPath);
    if (ledgerMatchesQueue(existing, queue, queuePath)) {
      return { queue, ledgerPath, ledger: existing };
    }
    if (existing.records.length > 0) {
      const archivedLedgerPath = await archivePublicationLedger(ledgerPath, existing);
      throw new KnownUserFacingError({
        error: '发布记录来自旧任务。请新建本期任务后再保存；原记录已保留。',
        code: 'publication_lineage_changed',
        action: { label: '新建本期任务', href: '/production' },
      }, {
        status: 409,
        detail: new Error(
          `Existing publication evidence count=${existing.records.length}; archived=${archivedLedgerPath}`,
        ),
      });
    }
    const archivedLedgerPath = await archivePublicationLedger(ledgerPath, existing);
    const ledger = createPublicationLedger({ queue, queuePath, queueSha256: sha256(queueBytes) });
    await writePublicationLedger(ledgerPath, ledger);
    return {
      queue,
      ledgerPath,
      ledger,
      archivedLedgerPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      queue,
      ledgerPath,
      ledger: createPublicationLedger({ queue, queuePath, queueSha256: sha256(queueBytes) }),
    };
  }
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const queuePath = assertQueuePath(req.nextUrl.searchParams.get('queuePath'));
    const queue = await readDraftQueue(queuePath);
    const ledgerPath = ledgerPathForRun(queue.run_slug);
    let ledger = null;
    try {
      ledger = await readPublicationLedger(ledgerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return NextResponse.json(redactLocalPaths({ queuePath, ledgerPath, ledger }));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取发布记录，请重试。',
      code: 'publication_results_read_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as ResultRequest;
    assertJsonInputSize(body, '发布结果参数', MAX_AGENT_PAYLOAD_BYTES);
    const queuePath = assertQueuePath(body.queuePath);
    const jobId = assertJobId(body.jobId);
    const humanConfirmed = assertBoolean(body.humanConfirmed, '已发送确认');
    if (!humanConfirmed) throw new InputLimitError('必须由操作者勾选确认已在平台内发送。');
    const publicationUrl = assertOptionalPublicationUrl(body.publicationUrl);
    const proof = await assertOptionalPublicationProof(body.proofPath);
    if (!publicationUrl && !proof) {
      throw new InputLimitError('发布结果必须填写有效发布链接或可验证的本地发布凭证。');
    }
    const publishedAt = assertOptionalPublishedAt(body.publishedAt);
    const externalItemId = assertOptionalTextInput(body.externalItemId, '平台内容 ID', MAX_SHORT_TEXT_BYTES);
    const notes = assertOptionalTextInput(body.notes, '发布备注', MAX_TEXT_ARTIFACT_BYTES);
    const unknownCompletionResolved = body.unknownCompletionResolved === undefined
      ? false
      : assertBoolean(body.unknownCompletionResolved, '未知状态人工核实');

    const result = await withDraftQueueWriteLock(queuePath, async () => {
      const queue = await readDraftQueue(queuePath);
      const draftApproval = await getRuntimeProductionApproval('draft_information', queuePath, queue.run_id);
      if (!draftApproval.approved) {
        return { error: '请先确认平台草稿信息，再保存发布结果。', code: 'draft_approval_required', status: 409 };
      }
      const requestedJob = queue.jobs.find((job) => job.job_id === jobId);
      if (requestedJob?.delivery_kind === 'execution_package') {
        return { error: '视频素材包下载后即可使用，不需要确认发送。', code: 'execution_package_not_publishable', status: 409 };
      }
      const { ledger, ledgerPath, archivedLedgerPath } = await loadLedgerOrCreate(queuePath, queue);
      let mutation: PublicationResultMutation;
      try {
        mutation = recordPublicationResult(queue, ledger, {
          jobId,
          humanConfirmed,
          ...(publicationUrl ? { publicationUrl } : {}),
          ...(proof ? { proofPath: proof.path, proofSha256: proof.sha256 } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          ...(externalItemId ? { externalItemId } : {}),
          ...(notes ? { notes } : {}),
          unknownCompletionResolved,
        });
      } catch (error) {
        throw new KnownUserFacingError({
          error: '发布记录已发生变化，请刷新后重试。',
          code: 'publication_result_conflict',
        }, { status: 409, detail: error });
      }
      // Write the evidence first. If the process stops before queue status is
      // updated, the next attempt finds the same immutable record and heals
      // the queue instead of producing a duplicate publication record.
      await writePublicationLedger(ledgerPath, mutation.ledger);
      await writeDraftQueue(queuePath, mutation.queue);
      const registration = await registerRuntimePhaseArtifact('publication_result', ledgerPath, mutation.queue.run_id);
      return {
        ...mutation,
        queuePath,
        ledgerPath,
        ...(archivedLedgerPath ? { archivedLedgerPath } : {}),
        approval: draftApproval,
        registration,
        status: 200,
      };
    });
    if ('error' in result) {
      return expectedUserFacingErrorResponse({
        error: typeof result.error === 'string' ? result.error : '发布结果暂时无法保存，请刷新后重试。',
        code: typeof result.code === 'string' ? result.code : 'publication_result_not_ready',
        status: result.status,
      });
    }
    return NextResponse.json(redactLocalPaths({ ok: true, ...result }));
  } catch (error) {
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法保存发布结果，请重试。',
      code: 'publication_result_save_failed',
      status,
    });
  }
}

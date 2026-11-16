import { lstat, readFile } from 'node:fs/promises';
import { NextRequest, NextResponse } from 'next/server';
import { verifyNativeXhsQueueCopy } from '@/lib/publish-copy-integrity';
import { XHS_COPY_MISMATCH } from '@/electron/native-xhs-copy.cjs';
import { ensureProjectInitialized } from '@/lib/project-init';
import { PROJECT_DIR, redactLocalPaths, safeResolve } from '@/lib/project-root';
import {
  assertJsonInputSize,
  assertOptionalTextInput,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { runsForPipelinePath, runtimeRunById, type RuntimeRun } from '@/lib/runtime-run-resolver';
import { readPublicationRestrictions } from '@/electron/publication-authority.cjs';
import { INTERNAL_ONLY_MESSAGE } from '@/electron/material-disclosure.cjs';
import {
  getRuntimeProductionApproval,
  registerRuntimePhaseArtifact,
} from '@/lib/runtime-writer';
import { WriteLockError } from '@/lib/write-guard';
import {
  collectDraftContentPaths,
  collectReadyAssetPaths,
  createDraftQueue,
  withDraftQueueWriteLock,
  applyDesktopDraftResult,
  hashProjectFiles,
  isDraftQueuePath,
  queuePathForRun,
  readDraftQueue,
  runDraftQueue,
  sha256,
  writeDraftQueue,
  type DraftAdapter,
  type DraftQueueAdapters,
} from '@/lib/publish/draft-queue';
import { verifyDesktopPublicationReceipt } from '@/lib/publish/desktop-receipt';
import type { PlatformDeliverables } from '@/lib/publish-assets';
import { hasCompleteDraftQueue } from '@/lib/production-flow';
import {
  expectedUserFacingErrorResponse,
  KnownUserFacingError,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type DraftAction = 'prepare' | 'execute' | 'retry' | 'desktop_result';

type DraftRequest = {
  action?: unknown;
  runId?: unknown;
  packagePath?: unknown;
  deliverablesPath?: unknown;
  visualManifestPath?: unknown;
  queuePath?: unknown;
  jobIds?: unknown;
  desktopReceipt?: unknown;
};

const PACKAGE_PATH_RE = /^pipeline\/package\/[^\\/\s]+\.md$/;
const DELIVERABLES_PATH_RE = /^pipeline\/publish-assets\/[A-Za-z0-9_\-\u4e00-\u9fff]+-platform-deliverables\.json$/;
const VISUAL_MANIFEST_PATH_RE = /^pipeline\/visual\/[A-Za-z0-9_\-\u4e00-\u9fff]+(?:\/[^\\/]+)*\/[^\\/]+\.(?:json|md)$/;

function selectedVisualManifestPath(slug: string): string {
  return `pipeline/visual/${slug}/selected-assets.json`;
}

function parseAction(value: unknown): DraftAction {
  const action = assertOptionalTextInput(value, '发布队列操作', MAX_SHORT_TEXT_BYTES)?.trim() || 'prepare';
  if (action === 'prepare' || action === 'execute' || action === 'retry' || action === 'desktop_result') return action;
  throw new InputLimitError('发布队列操作不受支持。');
}

function assertPath(value: unknown, label: string, pattern: RegExp): string {
  const path = assertTextInput(value, label, MAX_SHORT_TEXT_BYTES).trim();
  if (!pattern.test(path) || path.includes('..') || path.includes('\\')) {
    throw new InputLimitError(`${label}不在允许的本地目录中。`);
  }
  return path;
}

function parseJobIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new InputLimitError('发布任务列表必须是数组。');
  const ids = value.map((item) => assertTextInput(item, '发布任务 ID', MAX_SHORT_TEXT_BYTES).trim());
  if (ids.length === 0 || ids.length > 20 || ids.some((id) => !/^draft_[a-f0-9]{20}$/.test(id))) {
    throw new InputLimitError('发布任务列表无效。');
  }
  return Array.from(new Set(ids));
}

async function readSafeProjectFile(relativePath: string, label: string): Promise<Buffer> {
  const target = safeResolve(PROJECT_DIR, relativePath);
  if (!target) throw new InputLimitError(`${label}不在当前项目内。`);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new InputLimitError(`${label}必须是项目内普通文件。`);
    return await readFile(target);
  } catch (error) {
    if (error instanceof InputLimitError) throw error;
    throw new InputLimitError(`${label}不存在或无法读取。`);
  }
}

function asPlatformDeliverables(value: unknown, packagePath: string): PlatformDeliverables {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputLimitError('平台发布成稿文件格式无效。');
  }
  const deliverables = value as PlatformDeliverables;
  if (!deliverables.archive || deliverables.archive.packagePath !== packagePath) {
    throw new InputLimitError('平台发布成稿不属于当前内容包。');
  }
  return deliverables;
}

type CurrentPackageRun = RuntimeRun & { run_id: string; slug: string };

async function currentPackageRun(packagePath: string, requestedRunId?: string): Promise<CurrentPackageRun> {
  const candidates = await runsForPipelinePath(packagePath, 'package');
  const run = candidates.find((candidate) => (
    Boolean(candidate.run_id && candidate.slug)
    && candidate.steps?.package?.latest === packagePath
  ));
  if (!run?.run_id || !run.slug) throw new InputLimitError('内容包不是当前 run 的最新版本。');
  if (requestedRunId && requestedRunId !== run.run_id) throw new InputLimitError('内容包不属于请求的 run。');
  return run as CurrentPackageRun;
}

function unavailableAdapter(kind: DraftAdapter['kind']): DraftAdapter {
  return {
    kind,
    available: () => false,
    fill: async () => ({ status: 'retryable_failure', code: 'adapter_unavailable', message: '本机发布连接尚未就绪。' }),
  };
}

function downloadableExecutionAdapter(): DraftAdapter {
  return {
    kind: 'download',
    fill: async (job) => ({
      status: 'draft_filled',
      externalReference: job.payload.execution_package_path || job.payload.copy_path,
      message: '视频执行包已保留在本机，等待人工拍摄与发布。',
    }),
  };
}

function mockReadyAdapter(kind: DraftAdapter['kind']): DraftAdapter {
  return {
    kind,
    fill: async (job) => ({
      status: 'draft_filled',
      externalReference: `mock:${job.platform}:${job.item_id}`,
      message: '桌面适配器模拟草稿已填入。',
    }),
  };
}

function mockPublicationAdaptersEnabled(): boolean {
  const packagedDesktop = process.env.AIFIOS_DESKTOP === '1'
    && process.env.AIFIOS_NEXT_STANDALONE === '1';
  return process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS === '1'
    && process.env.NODE_ENV !== 'production'
    && !packagedDesktop;
}

/**
 * Real accounts are intentionally not executed by the Next process. Electron
 * owns encrypted credentials and supplies the platform bridge. The server
 * defaults to a paused, non-sending state; desktop smoke tests can opt into
 * mock adapters through an explicit local-only environment variable.
 */
function localAdapters(): DraftQueueAdapters {
  if (mockPublicationAdaptersEnabled()) {
    return {
      wechatOfficialApi: mockReadyAdapter('wechat_official_api'),
      wechatBrowser: mockReadyAdapter('authorized_browser'),
      xiaohongshuBrowser: mockReadyAdapter('authorized_browser'),
      momentsMobileBridge: mockReadyAdapter('mobile_bridge'),
      executionPackage: downloadableExecutionAdapter(),
    };
  }
  return {
    wechatOfficialApi: unavailableAdapter('wechat_official_api'),
    wechatBrowser: unavailableAdapter('authorized_browser'),
    xiaohongshuBrowser: unavailableAdapter('authorized_browser'),
    momentsMobileBridge: unavailableAdapter('mobile_bridge'),
    executionPackage: downloadableExecutionAdapter(),
  };
}

async function prepareQueue(body: DraftRequest) {
  const packagePath = assertPath(body.packagePath, '内容包路径', PACKAGE_PATH_RE);
  const deliverablesPath = assertPath(body.deliverablesPath, '平台发布成稿路径', DELIVERABLES_PATH_RE);
  const requestedRunId = assertOptionalTextInput(body.runId, 'run ID', MAX_SHORT_TEXT_BYTES)?.trim();
  const requestedVisualManifestPath = body.visualManifestPath === undefined || body.visualManifestPath === null
    ? undefined
    : assertPath(body.visualManifestPath, '视觉清单路径', VISUAL_MANIFEST_PATH_RE);
  const [packageBytes, deliverablesBytes, run] = await Promise.all([
    readSafeProjectFile(packagePath, '内容包'),
    readSafeProjectFile(deliverablesPath, '平台发布成稿'),
    currentPackageRun(packagePath, requestedRunId),
  ]);
  const packageApproval = await getRuntimeProductionApproval('content_package', packagePath, run.run_id);
  if (!packageApproval.approved) {
    return { error: '请先确认最终内容，再创建平台草稿。', code: 'content_package_approval_required', status: 409 };
  }
  const selectedPlatforms = run.selected_platforms || run.target_platforms || ['wechat', 'xhs', 'shipinhao'];
  const visualRequired = selectedPlatforms.some((platform) => platform === 'wechat' || platform === 'xhs' || platform === 'xiaohongshu');
  const visualManifestPath = visualRequired ? selectedVisualManifestPath(run.slug) : '';
  if (requestedVisualManifestPath && requestedVisualManifestPath !== visualManifestPath) {
    throw new InputLimitError('平台草稿只能使用当前任务按平台确认的 selected-assets.json 视觉清单。');
  }
  let visualManifestBytes: Buffer | undefined;
  if (visualRequired) {
    try {
      visualManifestBytes = await readSafeProjectFile(visualManifestPath, '按平台采用的视觉清单');
    } catch {
      return { error: '请先为本期图文平台选择图片，再创建平台草稿。', code: 'visual_selection_required', status: 409 };
    }
    const visualApproval = await getRuntimeProductionApproval('visual_assets', visualManifestPath, run.run_id);
    if (!visualApproval.approved) {
      return { error: '请先确认本期图文平台使用的图片，再创建平台草稿。', code: 'visual_approval_required', status: 409 };
    }
  }
  const deliverables = asPlatformDeliverables(JSON.parse(deliverablesBytes.toString('utf-8')), packagePath);
  const readyAssetPaths = collectReadyAssetPaths(deliverables);
  const [assetHashes, contentFileHashes] = await Promise.all([
    hashProjectFiles(readyAssetPaths),
    hashProjectFiles(collectDraftContentPaths(deliverables)),
  ]);
  const queue = createDraftQueue({
    runId: run.run_id,
    runSlug: run.slug,
    packagePath,
    packageSha256: sha256(packageBytes),
    deliverables,
    visualManifestPath: visualManifestPath || undefined,
    visualManifestSha256: visualManifestBytes ? sha256(visualManifestBytes) : undefined,
    assetHashes,
    contentFileHashes,
  });
  const queuePath = queuePathForRun(run.slug);
  const saved = await withDraftQueueWriteLock(queuePath, async () => {
    await writeDraftQueue(queuePath, queue);
    return readDraftQueue(queuePath);
  });
  const registration = await registerRuntimePhaseArtifact('draft_information', queuePath, run.run_id);
  return { queue: saved, queuePath, run, registration, status: 200 };
}

async function executeQueue(body: DraftRequest, retryOnly: boolean) {
  const queuePath = assertPath(body.queuePath, '发布队列路径', /^materials\/publication\/drafts\/[A-Za-z0-9_\-\u4e00-\u9fff]+\/draft-queue\.json$/);
  if (!isDraftQueuePath(queuePath)) throw new InputLimitError('发布队列路径不受支持。');
  const requestedRunId = assertOptionalTextInput(body.runId, 'run ID', MAX_SHORT_TEXT_BYTES)?.trim();
  const selectedJobIds = parseJobIds(body.jobIds);
  return withDraftQueueWriteLock(queuePath, async () => {
    let queue;
    try {
      queue = await readDraftQueue(queuePath);
    } catch {
      return { error: '平台草稿数据已损坏，请重新生成。', code: 'draft_queue_invalid', status: 409 };
    }
    if (requestedRunId && requestedRunId !== queue.run_id) throw new InputLimitError('发布队列不属于请求的 run。');
    if (!hasCompleteDraftQueue(queue)) {
      return { error: '平台草稿不完整或不属于当前任务，请重新生成。', code: 'draft_queue_incomplete', status: 409 };
    }
    const externalJobs = queue.jobs.filter((job) => job.delivery_kind === 'draft_fill'
      && (!selectedJobIds || selectedJobIds.includes(job.job_id)));
    if (externalJobs.length) {
      try {
        const run = await runtimeRunById(queue.run_id);
        if (!run || run.run_id !== queue.run_id) throw new Error('Missing material owner');
        const disclosure = await readPublicationRestrictions(PROJECT_DIR, run, undefined);
        if (disclosure.restrictions.length) {
          return { error: INTERNAL_ONLY_MESSAGE, code: 'material_internal_only', status: 409 };
        }
      } catch (error) {
        throw new KnownUserFacingError({ error: '无法核对本期公开限制，请回到素材页重新整理后确认。', code: 'material_disclosure_unavailable' }, { status: 409, detail: error });
      }
    }
    const approval = await getRuntimeProductionApproval('draft_information', queuePath, queue.run_id);
    if (!approval.approved) {
      return { error: '请先确认平台草稿信息，再填入平台后台。', code: 'draft_approval_required', status: 409 };
    }
    try { await verifyNativeXhsQueueCopy(queue); }
    catch { return { error: XHS_COPY_MISMATCH, code: 'native_copy_mismatch', status: 409 }; }
    const jobIds = retryOnly
      ? (selectedJobIds || queue.jobs.filter((job) => job.status === 'retryable_failure').map((job) => job.job_id))
      : selectedJobIds;
    const result = await runDraftQueue(queue, localAdapters(), {
      ...(jobIds ? { jobIds } : {}),
      persist: async (next) => writeDraftQueue(queuePath, next),
    });
    return { queuePath, approval, ...result, status: 200 };
  });
}

async function applyDesktopResult(body: DraftRequest) {
  const queuePath = assertPath(body.queuePath, '发布队列路径', /^materials\/publication\/drafts\/[A-Za-z0-9_\-\u4e00-\u9fff]+\/draft-queue\.json$/);
  if (!isDraftQueuePath(queuePath)) throw new InputLimitError('发布队列路径不受支持。');
  const requestedRunId = assertOptionalTextInput(body.runId, 'run ID', MAX_SHORT_TEXT_BYTES)?.trim();
  let receipt;
  try {
    receipt = verifyDesktopPublicationReceipt(
      body.desktopReceipt,
      process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET,
    );
  } catch (error) {
    throw new InputLimitError(error instanceof Error ? error.message : '桌面发布回执无效。');
  }
  if (receipt.queue_path !== queuePath) throw new InputLimitError('桌面发布回执不属于当前发布队列。');

  return withDraftQueueWriteLock(queuePath, async () => {
    let queue;
    try {
      queue = await readDraftQueue(queuePath);
    } catch {
      return { error: '平台草稿数据已损坏，请重新生成。', code: 'draft_queue_invalid', status: 409 };
    }
    if (requestedRunId && requestedRunId !== queue.run_id) throw new InputLimitError('发布队列不属于请求的 run。');
    if (receipt.run_id !== queue.run_id) throw new InputLimitError('桌面发布回执不属于当前 run。');
    if (!hasCompleteDraftQueue(queue)) {
      return { error: '平台草稿不完整或不属于当前任务，请重新生成。', code: 'draft_queue_incomplete', status: 409 };
    }
    const approval = await getRuntimeProductionApproval('draft_information', queuePath, queue.run_id);
    if (!approval.approved) {
      return { error: '请先确认平台草稿信息，再保存桌面填入结果。', code: 'draft_approval_required', status: 409 };
    }
    let next;
    try {
      next = applyDesktopDraftResult(queue, {
        jobId: receipt.job_id,
        payloadHash: receipt.payload_hash,
        receiptId: receipt.receipt_id,
        adapter: receipt.adapter,
        result: receipt.result,
      });
    } catch (error) {
      throw new KnownUserFacingError({
        error: '草稿状态已发生变化，请刷新后重试。',
        code: 'desktop_draft_result_conflict',
      }, { status: 409, detail: error });
    }
    await writeDraftQueue(queuePath, next);
    return {
      queuePath,
      approval,
      queue: next,
      attemptedJobIds: [receipt.job_id],
      skippedJobIds: next.jobs.filter((job) => job.job_id !== receipt.job_id).map((job) => job.job_id),
      desktopReceiptId: receipt.receipt_id,
      status: 200,
    };
  });
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const queuePath = assertPath(req.nextUrl.searchParams.get('queuePath'), '发布队列路径', /^materials\/publication\/drafts\/[A-Za-z0-9_\-\u4e00-\u9fff]+\/draft-queue\.json$/);
    const queue = await readDraftQueue(queuePath);
    if (req.nextUrl.searchParams.get('review') === '1') {
      const xhs = queue.jobs.find((job) => job.platform === 'xiaohongshu');
      if (!queue.target_platforms?.includes('xiaohongshu') || !xhs
        || queue.package_sha256 !== req.nextUrl.searchParams.get('source')
        || xhs.content_hash !== req.nextUrl.searchParams.get('copy')
        || xhs.payload_hash !== req.nextUrl.searchParams.get('payload')) {
        return NextResponse.json({ error: XHS_COPY_MISMATCH }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
      }
      try { await verifyNativeXhsQueueCopy(queue); }
      catch { return NextResponse.json({ error: XHS_COPY_MISMATCH }, { status: 409, headers: { 'Cache-Control': 'no-store' } }); }
    }
    return NextResponse.json(redactLocalPaths({ queue, queuePath }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取平台草稿，请重试。',
      code: 'draft_queue_read_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as DraftRequest;
    assertJsonInputSize(body, '发布队列请求', MAX_AGENT_PAYLOAD_BYTES);
    const action = parseAction(body.action);
    const result = action === 'prepare'
      ? await prepareQueue(body)
      : action === 'desktop_result'
        ? await applyDesktopResult(body)
        : await executeQueue(body, action === 'retry');
    if ('error' in result) {
      return expectedUserFacingErrorResponse({
        error: typeof result.error === 'string' ? result.error : '平台草稿尚未准备好，请刷新后重试。',
        code: typeof result.code === 'string' ? result.code : 'draft_queue_not_ready',
        status: result.status,
      });
    }
    return NextResponse.json(redactLocalPaths({ ok: true, action, ...result }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法更新平台草稿，请重试。',
      code: 'draft_queue_update_failed',
      status,
    });
  }
}

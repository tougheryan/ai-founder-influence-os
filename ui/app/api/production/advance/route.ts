import { NextRequest, NextResponse } from 'next/server';
import { verifyNativeXhsQueueCopy } from '@/lib/publish-copy-integrity';
import { XHS_COPY_MISMATCH } from '@/electron/native-xhs-copy.cjs';
import { POST as approveArtifact } from '@/app/api/production/approval/route';
import { BrandTemplateResolutionError, resolveConfiguredBrandTemplate } from '@/lib/brand-template-config';
import { ensureProjectInitialized } from '@/lib/project-init';
import {
  assertJsonInputSize,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import {
  hashProjectFiles,
  isDraftQueuePath,
  queuePathForRun,
  readDraftQueue,
  type DraftQueue,
} from '@/lib/publish/draft-queue';
import { hasCompleteDraftQueue, isPublicationQueueComplete } from '@/lib/production-flow';
import {
  hasCompletedProductionReview,
  isProductionReviewStage,
  requiredProductionReviewAssertions,
  type ProductionReviewAssertions,
} from '@/lib/production-review';
import { redactLocalPaths } from '@/lib/project-root';
import { KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';
import type { RunApprovalScope } from '@/lib/production-state';
import { runtimeRunById } from '@/lib/runtime-run-resolver';
import { getRuntimeProductionApproval } from '@/lib/runtime-writer';
import {
  readIdempotentResult,
  rememberIdempotentResult,
  withProjectWriteLock,
  WriteLockError,
  writeFingerprint,
} from '@/lib/write-guard';

const ADVANCE_STAGES = [
  'topic-template',
  'content-package',
  'visual-assets',
  'draft-information',
  'publication-result',
] as const;

type AdvanceStage = (typeof ADVANCE_STAGES)[number];

const APPROVAL_SCOPE: Record<AdvanceStage, RunApprovalScope> = {
  'topic-template': 'topic_template',
  'content-package': 'content_package',
  'visual-assets': 'visual_assets',
  'draft-information': 'draft_information',
  'publication-result': 'publication_result',
};

type AdvanceRequest = {
  stage?: unknown;
  runId?: unknown;
  artifactPath?: unknown;
  templateId?: unknown;
  queuePath?: unknown;
  reviewAssertions?: unknown;
  reviewedPlanSha256?: unknown;
  reviewedMaterialCorrectionId?: unknown;
  requestId?: unknown;
};

type AdvanceResult = { payload: Record<string, unknown>; status: number };
type AdvanceIdempotencyRecord = {
  request_fingerprint: string;
  result: AdvanceResult;
};

class AdvancePreconditionError extends Error {}
class AdvanceIdempotencyConflictError extends Error {}

function parseStage(value: unknown): AdvanceStage {
  const stage = assertTextInput(value, '生产阶段', MAX_SHORT_TEXT_BYTES).trim();
  if (!(ADVANCE_STAGES as readonly string[]).includes(stage)) {
    throw new InputLimitError('该生产阶段不支持负责人确认。');
  }
  return stage as AdvanceStage;
}

function parseRunId(value: unknown): string {
  const runId = assertTextInput(value, 'run ID', MAX_SHORT_TEXT_BYTES).trim();
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) {
    throw new InputLimitError('run ID 格式不正确。');
  }
  return runId;
}

function parseRequestId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const requestId = assertTextInput(value, '请求幂等 ID', MAX_SHORT_TEXT_BYTES).trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) {
    throw new InputLimitError('请求幂等 ID 格式不正确。');
  }
  return requestId;
}

function parseQueuePath(value: unknown): string {
  const queuePath = assertTextInput(value, '发布队列路径', MAX_SHORT_TEXT_BYTES).trim();
  if (!isDraftQueuePath(queuePath)) {
    throw new InputLimitError('发布队列路径不在允许的本地目录中。');
  }
  return queuePath;
}

function assertReviewAssertions(stage: AdvanceStage, value: unknown, selectedPlatforms?: readonly string[], researchMode?: string): ProductionReviewAssertions {
  if (!isProductionReviewStage(stage)) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdvancePreconditionError('请逐项完成本阶段的人工确认清单。');
  }
  const raw = value as Record<string, unknown>;
  const assertions: ProductionReviewAssertions = {};
  for (const assertion of requiredProductionReviewAssertions(stage, selectedPlatforms, researchMode)) {
    if (raw[assertion] !== true) {
      throw new AdvancePreconditionError('请逐项完成本阶段的人工确认清单。');
    }
    assertions[assertion] = true;
  }
  if (!hasCompletedProductionReview(stage, assertions, selectedPlatforms, researchMode)) {
    throw new AdvancePreconditionError('请逐项完成本阶段的人工确认清单。');
  }
  return assertions;
}

function internalRequest(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({}));
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

async function assertQueuePrecondition(stage: AdvanceStage, queuePath: string, runId: string): Promise<void> {
  const queue = await readDraftQueue(queuePath);
  if (queue.run_id !== runId) {
    throw new InputLimitError('发布队列不属于当前 run。');
  }
  await assertCurrentQueueLineage(queue, queuePath, runId);
  try { await verifyNativeXhsQueueCopy(queue); }
  catch { throw new AdvancePreconditionError(XHS_COPY_MISMATCH); }
  if (stage === 'draft-information' && !hasCompleteDraftQueue(queue)) {
    throw new AdvancePreconditionError('发布草稿必须完整覆盖本期已选平台，才能确认。');
  }
  if (stage === 'publication-result' && !isPublicationQueueComplete(queue)) {
    throw new AdvancePreconditionError('7 项平台草稿需由操作者确认并保存发布链接或可验证凭证，4 项视频执行包需在本机准备为可下载状态，才能确认发布结果。');
  }
}

async function assertCurrentQueueLineage(queue: DraftQueue, queuePath: string, runId: string): Promise<void> {
  const run = await runtimeRunById(runId);
  if (!run?.run_id || !run.slug || run.run_id !== runId) {
    throw new AdvancePreconditionError('当前 run 不存在或已失效，不能确认发布队列。');
  }
  if (queue.run_slug !== run.slug || queuePath !== queuePathForRun(run.slug)) {
    throw new InputLimitError('发布队列的 run slug 或保存路径不属于当前 run。');
  }

  const latestPackagePath = run.steps?.package?.latest?.trim() || '';
  const registeredPackagePath = run.phase_artifacts?.content_package?.path?.trim() || '';
  if (!latestPackagePath
    || (registeredPackagePath && registeredPackagePath !== latestPackagePath)
    || queue.package_path !== latestPackagePath) {
    throw new AdvancePreconditionError('发布队列引用的内容包已不是当前 run 最新版本，请重新整理草稿。');
  }
  const selectedPlatforms = queue.target_platforms || run.selected_platforms || run.target_platforms || [];
  const visualRequired = !queue.target_platforms
    || selectedPlatforms.some((platform) => platform === 'wechat' || platform === 'xhs' || platform === 'xiaohongshu');
  const currentVisualPath = run.phase_artifacts?.visual_assets?.path?.trim() || '';
  if (visualRequired && (!currentVisualPath
    || queue.visual_manifest_path !== currentVisualPath
    || currentVisualPath !== `pipeline/visual/${run.slug}/selected-assets.json`)) {
    throw new AdvancePreconditionError('发布队列引用的视觉采用清单已不是当前 run 最新版本，请重新整理草稿。');
  }
  if (!visualRequired && queue.visual_manifest_path) {
    throw new AdvancePreconditionError('视频号单平台队列不应绑定视觉采用清单。');
  }

  let hashes: Record<string, string>;
  try {
    hashes = await hashProjectFiles([latestPackagePath, ...(visualRequired ? [currentVisualPath] : [])]);
  } catch {
    throw new AdvancePreconditionError('发布队列的上游内容包或视觉清单不存在，请重新整理草稿。');
  }
  if (queue.package_sha256 !== hashes[latestPackagePath]
    || (visualRequired && queue.visual_manifest_sha256 !== hashes[currentVisualPath])) {
    throw new AdvancePreconditionError('发布队列的上游内容或视觉哈希已变化，请重新整理草稿。');
  }

  const [contentApproval, visualApproval] = await Promise.all([
    getRuntimeProductionApproval('content_package', latestPackagePath, runId),
    visualRequired ? getRuntimeProductionApproval('visual_assets', currentVisualPath, runId) : Promise.resolve({ approved: true }),
  ]);
  if (!contentApproval.approved || !visualApproval.approved) {
    throw new AdvancePreconditionError('内容包或视觉采用确认已失效，请完成上游重做后重新整理草稿。');
  }
}

/**
 * The single-entry production workbench uses this route for every human gate.
 * It keeps the UI from treating a browser-state flag as an approval: template
 * persistence, queue completeness, and the runtime-bound artifact hash are all
 * verified before the next production stage can unlock.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as AdvanceRequest;
    assertJsonInputSize(body, '生产阶段确认参数', MAX_AGENT_PAYLOAD_BYTES);
    const stage = parseStage(body.stage);
    const runId = parseRunId(body.runId);
    const requestId = parseRequestId(body.requestId);
    const artifactPath = assertTextInput(body.artifactPath, '阶段产物路径', MAX_SHORT_TEXT_BYTES).trim();
    const idempotencyKey = requestId
      ? writeFingerprint('production-advance-request-id', { requestId })
      : '';
    const requestFingerprint = requestId
      ? writeFingerprint('production-advance-payload', {
        stage,
        runId,
        artifactPath,
        templateId: body.templateId ?? null,
        queuePath: body.queuePath ?? null,
        reviewAssertions: body.reviewAssertions ?? null,
        reviewedPlanSha256: body.reviewedPlanSha256 ?? null,
        reviewedMaterialCorrectionId: body.reviewedMaterialCorrectionId ?? null,
      })
      : '';
    const lockKey = requestId
      ? `production-advance-idempotency:${requestId}`
      : `production-advance:${runId}:${stage}`;
    const result = await withProjectWriteLock(lockKey, async (): Promise<AdvanceResult> => {
      if (idempotencyKey) {
        const cached = await readIdempotentResult<AdvanceIdempotencyRecord>(
          idempotencyKey,
          undefined,
          Number.POSITIVE_INFINITY,
        );
        if (cached) {
          if (cached.request_fingerprint !== requestFingerprint) {
            throw new AdvanceIdempotencyConflictError('同一请求幂等 ID 已绑定不同的确认参数，请刷新后重试。');
          }
          if (stage === 'draft-information' || stage === 'publication-result') {
            const queuePath = parseQueuePath(body.queuePath);
            await assertQueuePrecondition(stage, queuePath, runId);
          }
          const currentApproval = await getRuntimeProductionApproval(APPROVAL_SCOPE[stage], artifactPath, runId);
          if (!currentApproval.approved) {
            throw new AdvanceIdempotencyConflictError('该幂等请求对应的负责人确认已失效，请刷新当前阶段后重新确认。');
          }
          return {
            ...cached.result,
            payload: { ...cached.result.payload, idempotent_replay: true },
          };
        }
      }
      const reviewRun = await runtimeRunById(runId);
      assertReviewAssertions(stage, body.reviewAssertions, reviewRun?.selected_platforms || reviewRun?.target_platforms, reviewRun?.research_mode);

      if (stage === 'topic-template') {
        const templateId = assertTextInput(body.templateId, '品牌排版模板', MAX_SHORT_TEXT_BYTES).trim();
        const template = await resolveConfiguredBrandTemplate(templateId);
        const run = await runtimeRunById(runId);
        if (!run || run.visual_template !== template.layoutStyle) {
          throw new AdvancePreconditionError('品牌排版模板尚未绑定当前内容任务，请重新确认后再继续。');
        }
      }

      if (stage === 'draft-information' || stage === 'publication-result') {
        const queuePath = parseQueuePath(body.queuePath);
        await assertQueuePrecondition(stage, queuePath, runId);
        if (stage === 'draft-information' && artifactPath !== queuePath) {
          throw new InputLimitError('发布草稿确认必须绑定当前发布队列。');
        }
      }

      const approvalResponse = await approveArtifact(internalRequest(
        'http://localhost/api/production/approval',
        { scope: APPROVAL_SCOPE[stage], path: artifactPath, runId, reviewedMaterialCorrectionId: body.reviewedMaterialCorrectionId, ...(stage === 'content-package' && body.reviewedPlanSha256 ? { reviewedPlanSha256: body.reviewedPlanSha256 } : {}) },
      ));
      const approvalPayload = await responsePayload(approvalResponse);
      const operation: AdvanceResult = {
        payload: {
          ...approvalPayload,
          stage,
          advanced: approvalResponse.ok && approvalPayload.approved === true,
          idempotent_replay: false,
        },
        status: approvalResponse.status,
      };
      if (idempotencyKey && approvalResponse.ok) {
        await rememberIdempotentResult<AdvanceIdempotencyRecord>(idempotencyKey, {
          request_fingerprint: requestFingerprint,
          result: operation,
        });
      }
      return operation;
    });
    return NextResponse.json(redactLocalPaths(result.payload), { status: result.status });
  } catch (error) {
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof AdvancePreconditionError
        ? 409
        : error instanceof AdvanceIdempotencyConflictError
          ? 409
        : error instanceof WriteLockError
          ? 409
        : error instanceof BrandTemplateResolutionError
          ? 400
        : 500;
    const cause = error instanceof AdvancePreconditionError
      ? new KnownUserFacingError({
        error: error.message === XHS_COPY_MISMATCH ? XHS_COPY_MISMATCH : '当前内容已变化，或尚未满足确认条件。请刷新后重试。',
        code: 'production_precondition_failed',
      }, { status: 409, detail: error })
      : error instanceof AdvanceIdempotencyConflictError
        ? new KnownUserFacingError({
          error: '当前确认已发生变化，请刷新后重试。',
          code: 'content_changed',
        }, { status: 409, detail: error })
      : error instanceof BrandTemplateResolutionError
        ? new KnownUserFacingError({
          error: '这个排版模板已停用或不存在，请重新选择。',
          code: 'brand_template_unavailable',
        }, { status: 400, detail: error })
        : error;
    return userFacingErrorResponse(cause, {
      error: '暂时无法完成当前确认，请重试。',
      code: 'production_advance_failed',
      status,
    });
  }
}

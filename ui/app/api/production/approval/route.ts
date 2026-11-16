import { getMaterialAnalysisContext, assertMaterialAnalysisCurrent } from '@/lib/material-analysis';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { runsForPipelinePath, type RuntimeRun } from '@/lib/runtime-run-resolver';
import {
  approveRuntimeProductionArtifact,
  getRuntimeContentPlanStatus,
  getRuntimeProductionApproval,
} from '@/lib/runtime-writer';
import { readOutputFile } from '@/lib/output-files';
import { runContentReleaseGate } from '@/lib/content-release-gate';
import { hasCompleteDraftQueue } from '@/lib/production-flow';
import {
  assertJsonInputSize,
  assertOptionalTextInput,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { isApprovalScope, type RunApprovalScope } from '@/lib/production-state';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

type ApprovalRequest = {
  scope?: unknown;
  path?: unknown;
  runId?: unknown;
  reviewedPlanSha256?: unknown;
  reviewedMaterialCorrectionId?: unknown;
};

const SCOPE_PATH_PATTERNS: Record<RunApprovalScope, RegExp> = {
  topic_template: /^pipeline\/blueprint\/[^\\/\s]+\.md$/,
  content_package: /^pipeline\/package\/[^\\/\s]+\.md$/,
  visual_assets: /^pipeline\/visual\/[A-Za-z0-9_\-\u4e00-\u9fff]+\/(?:[^\\/]+\/)*(?:[^\\/]+\.(?:json|md))$/,
  draft_information: /^(?:materials\/publication\/drafts|pipeline\/drafts)\/[A-Za-z0-9_\-\u4e00-\u9fff]+(?:\/[^\\/]+)*\/[^\\/]+\.json$/,
  publication_result: /^(?:pipeline\/publish\/[^\\/\s]+\.md|materials\/publication\/ledger\/[A-Za-z0-9_\-\u4e00-\u9fff]+(?:\/[^\\/]+)*\/[^\\/]+\.json)$/,
};

const SCOPE_STEP: Partial<Record<RunApprovalScope, string>> = {
  topic_template: 'blueprint',
  content_package: 'package',
  publication_result: 'publish',
};

function parseScope(value: unknown): RunApprovalScope {
  const scope = assertTextInput(value, '审批阶段', MAX_SHORT_TEXT_BYTES).trim();
  if (!isApprovalScope(scope)) {
    throw new InputLimitError('审批阶段不受支持。');
  }
  return scope;
}

function assertScopePath(scope: RunApprovalScope, value: unknown): string {
  const path = assertTextInput(value, '阶段产物路径', MAX_SHORT_TEXT_BYTES).trim();
  if (!SCOPE_PATH_PATTERNS[scope].test(path)) {
    throw new InputLimitError('阶段产物路径不属于当前审批阶段。');
  }
  return path;
}

function runOwnsCurrentArtifact(run: RuntimeRun, scope: RunApprovalScope, path: string): boolean {
  const phaseArtifacts = run.phase_artifacts as Record<string, { path?: string }> | undefined;
  if (phaseArtifacts?.[scope]?.path === path) return true;
  const step = SCOPE_STEP[scope];
  if (!step) return false;
  return run.steps?.[step]?.latest === path;
}

async function currentArtifactRun(scope: RunApprovalScope, path: string): Promise<RuntimeRun | null> {
  // Publication results can be either a legacy publish Markdown artifact or
  // the local JSON ledger. Query all runtime ownership records so the latter
  // is not incorrectly rejected for lacking a `publish` Markdown step.
  const candidates = await runsForPipelinePath(path);
  return candidates.find((run) => Boolean(run.run_id) && runOwnsCurrentArtifact(run, scope, path)) || null;
}

function queryInput(req: NextRequest): ApprovalRequest {
  return {
    scope: req.nextUrl.searchParams.get('scope'),
    path: req.nextUrl.searchParams.get('path'),
    runId: req.nextUrl.searchParams.get('runId'),
  };
}

async function resolveRequest(input: ApprovalRequest) {
  const scope = parseScope(input.scope);
  const path = assertScopePath(scope, input.path);
  const requestedRunId = assertOptionalTextInput(input.runId, 'run ID', MAX_SHORT_TEXT_BYTES)?.trim();
  const run = await currentArtifactRun(scope, path);
  if (!run?.run_id) {
    throw new InputLimitError('阶段产物必须属于当前 runtime run 的最新版本。');
  }
  if (requestedRunId && requestedRunId !== run.run_id) {
    throw new InputLimitError('阶段产物不属于请求的 run。');
  }
  return { scope, path, runId: run.run_id, run };
}

async function assertCompleteContentPackage(target: Awaited<ReturnType<typeof resolveRequest>>): Promise<void> {
  let body = '';
  try {
    body = await readOutputFile(target.path);
  } catch {
    throw new InputLimitError('第 3 步的原生内容无法读取，请重新生成后再确认。');
  }
  const gate = await runContentReleaseGate(body);
  const manifest = gate.package_manifest;
  if (gate.status === 'blocked' || manifest?.valid === false) {
    throw new InputLimitError('第 3 步没有完整生成已选平台的原生内容，不能确认。请重新生成。');
  }
}

async function assertCompleteDraftInformation(target: Awaited<ReturnType<typeof resolveRequest>>): Promise<void> {
  let queue: unknown;
  try {
    queue = JSON.parse(await readOutputFile(target.path));
  } catch {
    throw new InputLimitError('发布草稿队列不是可读取的 JSON 文件，不能确认。');
  }
  if (!hasCompleteDraftQueue(queue as Parameters<typeof hasCompleteDraftQueue>[0])) {
    throw new InputLimitError('发布草稿必须精确覆盖本期已选平台，且每个平台的任务标识与交付类型必须匹配。');
  }
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const target = await resolveRequest(queryInput(req));
    if (target.scope === 'content_package') await assertCompleteContentPackage(target);
    if (target.scope === 'draft_information') await assertCompleteDraftInformation(target);
    return NextResponse.json(redactLocalPaths(
      await getRuntimeProductionApproval(target.scope, target.path, target.runId),
    ));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取确认状态，请重试。',
      code: 'production_approval_read_failed',
      status: error instanceof InputLimitError ? 400 : 500,
      extra: { approved: false },
      legacyMessageField: 'reason',
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as ApprovalRequest;
    assertJsonInputSize(body, '阶段确认参数', MAX_AGENT_PAYLOAD_BYTES);
    const target = await resolveRequest(body);
    if (target.scope === 'content_package') await assertCompleteContentPackage(target);
    if (target.scope === 'draft_information') await assertCompleteDraftInformation(target);
    const reviewedMaterial = body.reviewedMaterialCorrectionId;
    if (reviewedMaterial !== undefined && (typeof reviewedMaterial !== 'string' || (reviewedMaterial !== '' && !/^correction_[a-f0-9]{32}$/.test(reviewedMaterial)))) throw new InputLimitError('核对的素材修正版本不正确。');
    if (target.scope === 'topic_template' || target.scope === 'content_package') {
      const context = target.run.material_correction ? await getMaterialAnalysisContext(target.runId) : null;
      if (context) assertMaterialAnalysisCurrent(context);
      if ((reviewedMaterial || '') !== (context?.correctionId || '')) return NextResponse.json({ error: '素材整理结果已修正，请重新读取并核对后确认。', code: 'material_correction_review_required' }, { status: 409 });
    }
    const reviewedPlan = body.reviewedPlanSha256;
    if (reviewedPlan !== undefined && (typeof reviewedPlan !== 'string' || !/^[a-f0-9]{64}$/.test(reviewedPlan))) throw new InputLimitError('核对的方案版本不正确。');
    if (target.scope === 'content_package') {
      const plan = await getRuntimeContentPlanStatus(target.runId);
      if (plan.status === 'unavailable' || (reviewedPlan && reviewedPlan !== plan.blueprint_sha256)
        || (!['current', 'retained'].includes(plan.status) && reviewedPlan !== plan.blueprint_sha256)) {
        return NextResponse.json({ error: plan.status === 'unavailable' ? plan.reason : '请先对照当前方案核对正文；可以重新生成，或明确选择保留这稿。', code: 'content_plan_review_required' }, { status: 409 });
      }
    }
    return NextResponse.json(redactLocalPaths(
      await approveRuntimeProductionArtifact(target.scope, target.path, target.runId, reviewedPlan as string | undefined, reviewedMaterial as string | undefined),
    ));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法保存确认结果，请重试。',
      code: 'production_approval_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

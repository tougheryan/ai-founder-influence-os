import { NextRequest, NextResponse } from 'next/server';
import { POST as collectMarketSignal } from '@/app/api/research/market-signal/route';
import { POST as preparePublishAssets } from '@/app/api/publish-assets/route';
import {
  assertJsonInputSize,
  assertOptionalTextInput,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { buildProductionFlowIntegrity, resolveProductionIntegrityRun } from '@/lib/production-integrity';
import { KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';

type ProductionFlowAction = 'market_research' | 'prepare_drafts';

class ProductionFlowPreconditionError extends Error {}

function parseAction(value: unknown): ProductionFlowAction {
  const action = assertTextInput(value, '生产流程操作', MAX_SHORT_TEXT_BYTES).trim();
  if (action === 'market_research' || action === 'prepare_drafts') return action;
  throw new InputLimitError('生产流程操作不受支持。');
}

function parseOptionalRunId(value: unknown): string | undefined {
  const runId = assertOptionalTextInput(value, 'run ID', MAX_SHORT_TEXT_BYTES)?.trim();
  if (runId && !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) {
    throw new InputLimitError('run ID 格式不正确。');
  }
  return runId || undefined;
}

function delegatedRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Returns the current run's complete, read-only production truth. Callers may
 * inspect an explicit run, but the server resolves every path and approval;
 * no client-provided artifact path is accepted by this endpoint.
 */
export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const runId = parseOptionalRunId(req.nextUrl.searchParams.get('runId'));
    const run = await resolveProductionIntegrityRun(runId);
    if (!run) {
      return NextResponse.json({ ok: true, integrity: null, reason: runId ? 'run_not_found' : 'no_active_run' });
    }
    const integrity = await buildProductionFlowIntegrity(run);
    if (!integrity) {
      return NextResponse.json({ ok: true, integrity: null, reason: 'run_incomplete' });
    }
    return NextResponse.json(redactLocalPaths({ ok: true, integrity }));
  } catch (error) {
    const cause = error instanceof ProductionFlowPreconditionError
      ? new KnownUserFacingError({
        error: '当前任务还没有完整内容，请先完成内容生成。',
        code: 'content_package_required',
      }, { status: 409, detail: error })
      : error;
    return userFacingErrorResponse(cause, {
      error: '暂时无法读取任务进度，请重试。',
      code: 'production_flow_read_failed',
      status: error instanceof InputLimitError ? 400 : 500,
      extra: { ok: false },
    });
  }
}

/**
 * The workbench's non-LLM transitions live behind one narrow local endpoint.
 * It deliberately delegates to the domain routes so TikOmni, visual approval,
 * release-gate, queue, and runtime contracts stay exactly the same everywhere.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '生产流程参数', MAX_AGENT_PAYLOAD_BYTES);
    const action = parseAction(body.action);

    if (action === 'market_research') {
      // Never pass a client-controlled platform list through this facade. The
      // market route enforces its fixed TikOmni three-platform contract.
      return collectMarketSignal(delegatedRequest('http://localhost/api/research/market-signal', {
        sourcePath: body.sourcePath,
        slug: body.slug,
        topic: body.topic,
        runId: body.runId,
      }));
    }

    const runId = parseOptionalRunId(body.runId);
    const run = await resolveProductionIntegrityRun(runId);
    const packagePath = run?.steps?.package?.latest?.trim() || '';
    if (!run?.run_id || !packagePath) {
      throw new ProductionFlowPreconditionError('当前生产任务尚无完整内容包，不能整理发布草稿。');
    }
    const requestedPackagePath = assertOptionalTextInput(
      body.packagePath,
      '全平台内容包路径',
      MAX_SHORT_TEXT_BYTES,
    )?.trim();
    if (requestedPackagePath && requestedPackagePath !== packagePath) {
      throw new InputLimitError('内容包不属于当前生产任务，不能跨 run 整理草稿。');
    }
    return preparePublishAssets(delegatedRequest('http://localhost/api/publish-assets', { packagePath }));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法继续当前任务，请重试。',
      code: 'production_flow_action_failed',
      status: error instanceof InputLimitError
        ? 400
        : error instanceof ProductionFlowPreconditionError
          ? 409
          : 500,
    });
  }
}

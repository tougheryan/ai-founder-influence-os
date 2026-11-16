import { NextRequest, NextResponse } from 'next/server';
import {
  assertProductionTaskIds,
  createOrReadProductionTask,
  getProductionTask,
  isProductionTaskKind,
  latestProductionTaskForRun,
  productionTaskResponse,
  ProductionTaskInputError,
  recoverInterruptedProductionTask,
  refreshKnownLocalProductionTaskFailure,
  scheduleProductionTask,
  type ProductionTask,
} from '@/lib/production-tasks';
import { redactLocalPaths } from '@/lib/project-root';
import { assertJsonInputSize, InputLimitError, MAX_AGENT_PAYLOAD_BYTES } from '@/lib/input-limits';
import { WriteLockError } from '@/lib/write-guard';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

function errorResponse(error: unknown) {
  const status = error instanceof ProductionTaskInputError || error instanceof InputLimitError
    ? 400
    : error instanceof WriteLockError
      ? 409
      : 500;
  return userFacingErrorResponse(error, {
    error: '暂时无法处理生成任务，请重试。',
    code: 'production_task_failed',
    status,
    extra: { ok: false },
  });
}

async function resumeAndSchedule(task: ProductionTask): Promise<ProductionTask> {
  const refreshed = await refreshKnownLocalProductionTaskFailure(task);
  const recovered = refreshed.status === 'running'
    ? await recoverInterruptedProductionTask(refreshed.runId, refreshed.taskId)
    : { task: refreshed, recovered: false };
  if (recovered.task.status === 'queued') {
    scheduleProductionTask(recovered.task.runId, recovered.task.taskId);
  }
  return recovered.task;
}

/**
 * Creates a persistent local production task and returns immediately. Work is
 * intentionally detached from this HTTP response so a browser refresh cannot
 * cancel a TikOmni/LLM/visual generation operation.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '生产任务参数', MAX_AGENT_PAYLOAD_BYTES);
    if (!isProductionTaskKind(body.kind)) throw new ProductionTaskInputError('任务类型不受支持。');
    const ids = assertProductionTaskIds(body.runId, body.taskId);
    const { task, created } = await createOrReadProductionTask({
      runId: ids.runId,
      kind: body.kind,
      ...(ids.taskId ? { taskId: ids.taskId } : {}),
      request: body.input,
    });
    // A duplicate submit observes the same payload-bound task. If the prior
    // process died while it was running, atomically queue it from the first
    // unfinished step before the single-instance scheduler takes ownership.
    const resumableTask = await resumeAndSchedule(task);
    return NextResponse.json(redactLocalPaths({
      ok: true,
      accepted: true,
      created,
      task: productionTaskResponse(resumableTask),
      pollUrl: `/api/production/tasks?runId=${encodeURIComponent(resumableTask.runId)}&taskId=${encodeURIComponent(resumableTask.taskId)}`,
    }), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    const query = req.nextUrl.searchParams;
    const requestedTaskId = query.get('taskId') || undefined;
    const ids = assertProductionTaskIds(query.get('runId'), requestedTaskId);
    const stored = ids.taskId
      ? await getProductionTask(ids.runId, ids.taskId)
      : await latestProductionTaskForRun(ids.runId);
    if (!stored) {
      if (!requestedTaskId) {
        return NextResponse.json({ ok: true, task: null });
      }
      return expectedUserFacingErrorResponse({
        error: '这个任务不存在，可能已被清理。',
        code: 'production_task_not_found',
        status: 404,
        extra: { ok: false },
      });
    }
    const task = await resumeAndSchedule(stored);
    return NextResponse.json(redactLocalPaths({ ok: true, task: productionTaskResponse(task) }));
  } catch (error) {
    return errorResponse(error);
  }
}

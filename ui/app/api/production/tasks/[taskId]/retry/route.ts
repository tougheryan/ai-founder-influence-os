import { NextRequest, NextResponse } from 'next/server';
import {
  assertProductionTaskIds,
  productionTaskResponse,
  ProductionTaskInputError,
  retryProductionTask,
  scheduleProductionTask,
  type ProductionTaskRetryMode,
} from '@/lib/production-tasks';
import { redactLocalPaths } from '@/lib/project-root';
import { assertJsonInputSize, InputLimitError, MAX_AGENT_PAYLOAD_BYTES } from '@/lib/input-limits';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '生产任务重试参数', MAX_AGENT_PAYLOAD_BYTES);
    const { taskId } = await context.params;
    const ids = assertProductionTaskIds(body.runId, taskId);
    if (!ids.taskId) throw new ProductionTaskInputError('任务编号不能为空。');
    const mode = typeof body.mode === 'string' ? body.mode : 'default';
    if (!['default', 'recover', 'redispatch'].includes(mode)) {
      throw new ProductionTaskInputError('任务重试模式不受支持。');
    }
    const task = await retryProductionTask(ids.runId, ids.taskId, mode as ProductionTaskRetryMode);
    scheduleProductionTask(task.runId, task.taskId);
    return NextResponse.json(redactLocalPaths({
      ok: true,
      accepted: true,
      task: productionTaskResponse(task),
      pollUrl: `/api/production/tasks?runId=${encodeURIComponent(task.runId)}&taskId=${encodeURIComponent(task.taskId)}`,
    }), { status: 202 });
  } catch (error) {
    const status = error instanceof ProductionTaskInputError || error instanceof InputLimitError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法重试生成任务，请稍后再试。',
      code: 'production_task_retry_failed',
      status,
      extra: { ok: false },
    });
  }
}

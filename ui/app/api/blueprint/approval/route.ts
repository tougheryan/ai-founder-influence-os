import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { runsForPipelinePath } from '@/lib/runtime-run-resolver';
import {
  approveRuntimeBlueprint,
  getRuntimeBlueprintApproval,
  validateRuntimeOutput,
} from '@/lib/runtime-writer';
import {
  assertJsonInputSize,
  assertOptionalTextInput,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';

function assertBlueprintPath(value: string): string {
  if (!/^pipeline\/blueprint\/[^\\/\s]+\.md$/.test(value)) {
    throw new InputLimitError('思想母版蓝图路径必须位于 pipeline/blueprint/');
  }
  return value;
}

async function currentBlueprintRun(blueprintPath: string) {
  const runs = await runsForPipelinePath(blueprintPath, 'blueprint');
  return runs.find((run) => run.steps?.blueprint?.latest === blueprintPath) || null;
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const blueprintPath = assertBlueprintPath(
      assertTextInput(req.nextUrl.searchParams.get('blueprintPath') || '', '思想母版蓝图路径', MAX_SHORT_TEXT_BYTES),
    );
    const requestedRunId = assertOptionalTextInput(req.nextUrl.searchParams.get('runId'), 'run ID', MAX_SHORT_TEXT_BYTES)?.trim();
    const run = await currentBlueprintRun(blueprintPath);
    if (!run?.run_id) {
      return expectedUserFacingErrorResponse({
        error: '这份文章大纲不是当前版本，请刷新后重新选择。',
        code: 'blueprint_not_current',
        status: 404,
        extra: { approved: false },
        legacyMessageField: 'reason',
      });
    }
    if (requestedRunId && requestedRunId !== run.run_id) {
      return expectedUserFacingErrorResponse({
        error: '这份文章大纲不属于当前任务，请刷新后重新选择。',
        code: 'blueprint_task_mismatch',
        status: 400,
        extra: { approved: false },
        legacyMessageField: 'reason',
      });
    }
    return NextResponse.json(redactLocalPaths(await getRuntimeBlueprintApproval(blueprintPath, run.run_id)));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取文章大纲的确认状态，请重试。',
      code: 'blueprint_approval_read_failed',
      status: error instanceof InputLimitError ? 400 : 500,
      extra: { approved: false },
      legacyMessageField: 'reason',
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as { blueprintPath?: unknown; runId?: unknown };
    assertJsonInputSize(body, '蓝图确认参数', MAX_AGENT_PAYLOAD_BYTES);
    const blueprintPath = assertBlueprintPath(assertTextInput(body.blueprintPath, '思想母版蓝图路径', MAX_SHORT_TEXT_BYTES));
    const requestedRunId = assertOptionalTextInput(body.runId, 'run ID', MAX_SHORT_TEXT_BYTES)?.trim();
    const run = await currentBlueprintRun(blueprintPath);
    if (!run?.run_id) {
      return expectedUserFacingErrorResponse({
        error: '这份文章大纲不是当前版本，请刷新后重新选择。',
        code: 'blueprint_not_current',
        status: 400,
      });
    }
    if (requestedRunId && requestedRunId !== run.run_id) {
      return expectedUserFacingErrorResponse({
        error: '这份文章大纲不属于当前任务，请刷新后重新选择。',
        code: 'blueprint_task_mismatch',
        status: 400,
      });
    }
    const validation = await validateRuntimeOutput('blueprint', blueprintPath);
    if (!validation.valid) {
      return expectedUserFacingErrorResponse({
        error: '文章大纲检查未通过，请修改后再确认。',
        code: 'blueprint_validation_failed',
        status: 400,
        extra: { validation: { valid: false } },
      });
    }
    return NextResponse.json(redactLocalPaths(await approveRuntimeBlueprint(blueprintPath, run.run_id)));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法确认文章大纲，请重试。',
      code: 'blueprint_approval_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

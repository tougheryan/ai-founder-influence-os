import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import {
  acknowledgeBenchmarkAdvisorNotification,
  acknowledgeBenchmarkAdvisorDesktopReminder,
  adoptBenchmarkVideoAngle,
  adoptBenchmarkAdvisorAction,
  analyzeBenchmarkVideo,
  BenchmarkAdvisorInputError,
  getBenchmarkAdvisorDesktopReminder,
  getBenchmarkAdvisorState,
  listBenchmarkAdvisorProjectIds,
  refreshBenchmarkAdvisorIfDue,
  refreshBenchmarkAdvisorResearch,
  saveBenchmarkAccounts,
  sendBenchmarkAdvisorMessage,
} from '@/lib/benchmark-advisor';
import {
  assertJsonInputSize,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type AdvisorAction = 'save_accounts' | 'refresh' | 'refresh_if_due' | 'chat' | 'adopt' | 'analyze_video' | 'adopt_video_angle' | 'acknowledge_notification' | 'acknowledge_desktop_notification';

type AdvisorRequest = {
  action?: unknown;
  projectId?: unknown;
  customerAuthorizationConfirmed?: unknown;
  accounts?: unknown;
  question?: unknown;
  context?: unknown;
  runId?: unknown;
  actionId?: unknown;
  sourceUrl?: unknown;
  analysisId?: unknown;
  angleId?: unknown;
};

function parseAction(value: unknown): AdvisorAction {
  const action = assertTextInput(value, '对标顾问操作', MAX_SHORT_TEXT_BYTES).trim();
  if (
    action === 'save_accounts'
    || action === 'refresh'
    || action === 'refresh_if_due'
    || action === 'chat'
    || action === 'adopt'
    || action === 'analyze_video'
    || action === 'adopt_video_angle'
    || action === 'acknowledge_notification'
    || action === 'acknowledge_desktop_notification'
  ) {
    return action;
  }
  throw new InputLimitError('对标顾问操作不受支持。');
}

function parseProjectId(value: unknown): string {
  return assertTextInput(value, '项目 ID', MAX_SHORT_TEXT_BYTES).trim();
}

function createVideoLockKey(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl).digest('hex').slice(0, 20);
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    if (req.nextUrl.searchParams.get('listProjects') === '1') {
      return NextResponse.json(redactLocalPaths({ projectIds: await listBenchmarkAdvisorProjectIds() }));
    }
    const projectId = parseProjectId(req.nextUrl.searchParams.get('projectId'));
    if (req.nextUrl.searchParams.get('desktopReminder') === '1') {
      return NextResponse.json(redactLocalPaths({ reminder: await getBenchmarkAdvisorDesktopReminder(projectId) }));
    }
    return NextResponse.json(redactLocalPaths(await getBenchmarkAdvisorState(projectId)));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取对标研究，请重试。',
      code: 'benchmark_research_read_failed',
      status: error instanceof InputLimitError || error instanceof BenchmarkAdvisorInputError ? 400 : 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as AdvisorRequest;
    assertJsonInputSize(body, '对标顾问请求', MAX_AGENT_PAYLOAD_BYTES);
    const action = parseAction(body.action);
    const projectId = parseProjectId(body.projectId);

    if (action === 'save_accounts') {
      const result = await withProjectWriteLock(`benchmark-advisor:${projectId}:accounts`, () => (
        saveBenchmarkAccounts(projectId, body.accounts, body.customerAuthorizationConfirmed)
      ));
      return NextResponse.json(redactLocalPaths({ ok: true, operation: action, ...result }));
    }
    if (action === 'refresh') {
      const result = await withProjectWriteLock(`benchmark-advisor:${projectId}:refresh`, () => refreshBenchmarkAdvisorResearch(projectId));
      return NextResponse.json(redactLocalPaths({ ok: true, operation: action, ...result }));
    }
    if (action === 'refresh_if_due') {
      const result = await withProjectWriteLock(`benchmark-advisor:${projectId}:scheduled-refresh`, () => refreshBenchmarkAdvisorIfDue(projectId));
      return NextResponse.json(redactLocalPaths({ ok: true, operation: action, ...result }));
    }
    if (action === 'chat') {
      const result = await withProjectWriteLock(`benchmark-advisor:${projectId}:chat`, () => sendBenchmarkAdvisorMessage(projectId, body.question, body.context));
      return NextResponse.json(redactLocalPaths({ ok: true, operation: action, ...result }));
    }
    if (action === 'analyze_video') {
      const sourceUrl = assertTextInput(body.sourceUrl, '视频链接', MAX_SHORT_TEXT_BYTES).trim();
      const result = await withProjectWriteLock(
        `benchmark-advisor:${projectId}:single-video:${createVideoLockKey(sourceUrl)}`,
        () => analyzeBenchmarkVideo(projectId, sourceUrl),
      );
      return NextResponse.json(redactLocalPaths({ ok: true, operation: action, ...result }));
    }
    if (action === 'adopt') {
      const result = await withProjectWriteLock(
        `benchmark-advisor:${projectId}:adopt:${typeof body.runId === 'string' ? body.runId : 'unknown'}`,
        () => adoptBenchmarkAdvisorAction(projectId, body.runId, body.actionId),
      );
      return NextResponse.json(redactLocalPaths({ ok: true, operation: action, ...result }));
    }
    if (action === 'adopt_video_angle') {
      const result = await withProjectWriteLock(
        `benchmark-advisor:${projectId}:adopt-video:${typeof body.runId === 'string' ? body.runId : 'unknown'}`,
        () => adoptBenchmarkVideoAngle(projectId, body.runId, body.analysisId, body.angleId),
      );
      return NextResponse.json(redactLocalPaths({ ok: true, operation: action, ...result }));
    }
    if (action === 'acknowledge_desktop_notification') {
      const result = await withProjectWriteLock(`benchmark-advisor:${projectId}:desktop-notification`, () => acknowledgeBenchmarkAdvisorDesktopReminder(projectId));
      return NextResponse.json(redactLocalPaths({ ok: true, operation: action, reminder: result }));
    }
    const result = await withProjectWriteLock(`benchmark-advisor:${projectId}:notification`, () => acknowledgeBenchmarkAdvisorNotification(projectId));
    return NextResponse.json(redactLocalPaths({ ok: true, operation: action, ...result }));
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof BenchmarkAdvisorInputError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法处理对标研究请求，请重试。',
      code: 'benchmark_research_update_failed',
      status,
    });
  }
}

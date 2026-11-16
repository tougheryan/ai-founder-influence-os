import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { assertJsonInputSize, InputLimitError, MAX_AGENT_PAYLOAD_BYTES } from '@/lib/input-limits';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';

const execFileAsync = promisify(execFile);
const SCHEDULER_SCRIPT = contentRuntimeToolPath('tikomni_scheduler.py');

type WeeklyMarketRequest = { force?: unknown };

function errorStdout(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stdout' in error)) return '';
  return typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '';
}

async function runWeeklyCollection(force: boolean): Promise<Record<string, unknown>> {
  const args = [
    SCHEDULER_SCRIPT,
    '--project',
    PROJECT_DIR,
    'collect-if-due',
    ...(force ? ['--force'] : []),
  ];
  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), args, {
      cwd: PROJECT_DIR,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 90_000,
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    const stdout = errorStdout(error);
    if (stdout.trim()) {
      try {
        return JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        // Preserve a non-JSON process failure below.
      }
    }
    throw error;
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as WeeklyMarketRequest;
    assertJsonInputSize(body, 'TikOmni 周度市场采集请求', MAX_AGENT_PAYLOAD_BYTES);
    if (body.force !== undefined && body.force !== true && body.force !== false) {
      throw new InputLimitError('force 必须是布尔值。');
    }
    const result = await withProjectWriteLock(
      'tikomni-weekly-market:collect-if-due',
      () => runWeeklyCollection(body.force === true),
    );
    // A scheduled collection is optional learning input. Its outage must be
    // observable, but it never turns into a stale fallback and never blocks a
    // new content run; the per-topic route remains the strict hard gate.
    return NextResponse.json(redactLocalPaths({
      ok: result.status === 'ready' || result.status === 'already_collected',
      nonBlocking: true,
      ...result,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '平台样本暂时无法更新，可以稍后重试。',
      code: 'weekly_research_update_failed',
      status,
      extra: { nonBlocking: true },
    });
  }
}

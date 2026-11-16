import { NextRequest, NextResponse } from 'next/server';
import {
  CreativeLibraryError,
  collectAllPublishedScripts,
  collectPublishedScript,
  getPublishedScript,
  listPublishedScriptCandidates,
  listPublishedScripts,
} from '@/lib/creative-library';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type PublishedScriptsRequest = {
  action?: unknown;
  sourceRecordId?: unknown;
};

function parseInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new InputLimitError('分页参数无效。');
  return parsed;
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const id = req.nextUrl.searchParams.get('id');
    if (id) return NextResponse.json(redactLocalPaths({ item: await getPublishedScript(id) }));
    if (req.nextUrl.searchParams.get('view') === 'candidates') {
      return NextResponse.json(redactLocalPaths({ items: await listPublishedScriptCandidates() }));
    }
    const offset = parseInteger(req.nextUrl.searchParams.get('offset'), 0, 0, 100_000);
    const limit = parseInteger(req.nextUrl.searchParams.get('limit'), 50, 1, 100);
    return NextResponse.json(redactLocalPaths(await listPublishedScripts({ offset, limit })));
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof CreativeLibraryError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法读取发布作品，请重试。',
      code: 'published_scripts_read_failed',
      status,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as PublishedScriptsRequest;
    assertJsonInputSize(body, '已发布脚本收录请求', MAX_AGENT_PAYLOAD_BYTES);
    const action = assertTextInput(body.action, '已发布脚本操作', MAX_SHORT_TEXT_BYTES).trim();
    if (action !== 'collect' && action !== 'collect-all') throw new InputLimitError('已发布脚本操作不受支持。');
    const result = action === 'collect-all'
      ? await withProjectWriteLock('creative-library:published-scripts', collectAllPublishedScripts)
      : await withProjectWriteLock(
        'creative-library:published-scripts',
        () => collectPublishedScript(assertTextInput(body.sourceRecordId, '发布记录 ID', MAX_SHORT_TEXT_BYTES).trim()),
      );
    return NextResponse.json(redactLocalPaths({ ok: true, action, ...result }));
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof CreativeLibraryError
      ? 400
      : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法收录发布作品，请重试。',
      code: 'published_scripts_collect_failed',
      status,
    });
  }
}

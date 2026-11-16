import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { assertTextInput, InputLimitError, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';
import { loadVisualWorkbenchState } from '@/lib/visual-workbench';

const SLUG_RE = /^[a-z0-9\u4e00-\u9fff-]{1,50}$/i;

function parseSlug(value: string | null): string {
  const slug = assertTextInput(value, '视觉任务 Slug', MAX_SHORT_TEXT_BYTES).trim();
  if (!SLUG_RE.test(slug)) throw new InputLimitError('视觉任务 Slug 格式不正确。');
  return slug;
}

/**
 * Narrow read endpoint for the production workbench. It keeps the visual
 * review UI independent from the delivery dashboard and returns only
 * server-verified visual state for the requested local run.
 */
export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const slug = parseSlug(req.nextUrl.searchParams.get('slug'));
    const state = await loadVisualWorkbenchState(slug);
    if (!state) {
      // A missing candidate set is the expected state before phase 4. Use a
      // successful empty response so routine run refreshes stay quiet.
      return new NextResponse(null, { status: 204 });
    }
    return NextResponse.json(redactLocalPaths(state));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取配图方案，请重试。',
      code: 'visual_workbench_read_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

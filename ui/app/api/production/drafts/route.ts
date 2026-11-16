import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { listProductionDrafts, readProductionDraft, saveProductionDraft, ProductionDraftError } from '@/lib/production-drafts';
import { assertJsonInputSize, InputLimitError, MAX_TEXT_ARTIFACT_BYTES } from '@/lib/input-limits';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';
import { WriteLockError } from '@/lib/write-guard';

export const runtime = 'nodejs';
function failure(error: unknown) {
  if (error instanceof ProductionDraftError || error instanceof InputLimitError) return expectedUserFacingErrorResponse({ error: error.message, code: 'production_draft_input', status: error instanceof ProductionDraftError ? error.status : 400 });
  return userFacingErrorResponse(error, { error: '草稿暂时无法保存或读取，请保留当前页面后重试。', code: 'production_draft_failed', status: error instanceof WriteLockError ? 409 : error instanceof SyntaxError ? 400 : 500 });
}
export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json(await listProductionDrafts(), { headers: { 'Cache-Control': 'no-store' } });
    const draft = await readProductionDraft(id);
    if (!draft) return expectedUserFacingErrorResponse({ error: '找不到这份草稿，当前内容保持不变。', code: 'production_draft_not_found', status: 404 });
    return NextResponse.json({ draft }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json();
    assertJsonInputSize(body, '草稿', MAX_TEXT_ARTIFACT_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProductionDraftError('请提交草稿。');
    return NextResponse.json({ draft: await saveProductionDraft(body) });
  } catch (error) { return failure(error); }
}

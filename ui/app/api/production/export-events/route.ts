import { NextRequest, NextResponse } from 'next/server';
import { acknowledgeOutputDownloadEvent, listOutputDownloadEvents, OutputDownloadEventError } from '@/lib/output-download-events';
import { assertJsonInputSize, InputLimitError } from '@/lib/input-limits';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';
import { WriteLockError } from '@/lib/write-guard';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
function failure(error: unknown) {
  if (error instanceof OutputDownloadEventError || error instanceof InputLimitError || error instanceof SyntaxError) return expectedUserFacingErrorResponse({
    error: error instanceof SyntaxError ? '下载记录请求不正确。' : error.message,
    code: 'output_download_event_input', status: error instanceof OutputDownloadEventError ? error.status : 400,
  });
  return userFacingErrorResponse(error, { error: '下载记录暂时无法确认；已经发起的文件下载不受影响。', code: 'output_download_event_failed', status: error instanceof WriteLockError ? 409 : 500 });
}
export async function GET(request: NextRequest) {
  try { return NextResponse.json(await listOutputDownloadEvents(request.nextUrl.searchParams.get('runId') || ''), { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    assertJsonInputSize(body, '下载记录请求', 2048);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.runId !== 'string' || typeof body.receiptId !== 'string') throw new OutputDownloadEventError('请提交本篇下载准备记录。');
    return NextResponse.json({ ok: true, event: await acknowledgeOutputDownloadEvent(body.runId, body.receiptId) }, { headers });
  } catch (error) { return failure(error); }
}

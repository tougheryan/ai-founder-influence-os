import { NextRequest, NextResponse } from 'next/server';
import { readServiceCalls, readServiceCallsWithLimit, saveModelCallLimit, ServiceCallInputError } from '@/lib/service-call-records';
import { expectedUserFacingErrorResponse, KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';
export async function GET(req: NextRequest) {
  try {
    const read = req.nextUrl.searchParams.get('includeLimit') === '1' ? readServiceCallsWithLimit : readServiceCalls;
    return NextResponse.json(await read(req.nextUrl.searchParams.get('runId') || ''), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ServiceCallInputError) return expectedUserFacingErrorResponse({ error: error.message, code: 'service_calls_input', status: 400 });
    return userFacingErrorResponse(error, { error: '本期调用记录暂时无法完整读取，费用仍未知。请重新读取记录。', code: 'service_calls_read_failed', status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (raw.length > 2000) throw new ServiceCallInputError('调用限制请求过长。');
    let body;
    try { body = JSON.parse(raw); } catch { throw new ServiceCallInputError('调用限制格式不正确。'); }
    if (!body || body.action !== 'set-limit' || typeof body.runId !== 'string') throw new ServiceCallInputError('请指定这份草稿的调用限制。');
    const limit = await saveModelCallLimit(body.runId, body.maxCalls, body.expectedRevision);
    return NextResponse.json({ runId: body.runId, limit }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ServiceCallInputError) return expectedUserFacingErrorResponse({ error: error.message, code: 'service_calls_input', status: 400 });
    return userFacingErrorResponse(error, { error: '调用限制未能保存，原限制保留。请重新读取后重试。', code: 'model_call_limit_save_failed', status: error instanceof KnownUserFacingError ? error.status : 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { LayoutCallInputError, readLayoutCalls } from '@/lib/layout-call-records';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    return NextResponse.json(await readLayoutCalls(request.nextUrl.searchParams.get('runId')), { headers });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof LayoutCallInputError ? error.message : '排版请求记录暂时无法核对。请稍后重新读取；无法据此判断调用次数或费用。',
    }, { status: error instanceof LayoutCallInputError ? 400 : 500, headers });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { getRuntimeContentPlanStatus } from '@/lib/runtime-writer';
import { InputLimitError } from '@/lib/input-limits';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';
export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const runId = req.nextUrl.searchParams.get('runId') || '';
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) throw new InputLimitError('内容编号不正确。');
    return NextResponse.json(await getRuntimeContentPlanStatus(runId));
  } catch (error) {
    return userFacingErrorResponse(error, { error: '正文与方案暂时无法核对，请重试。', code: 'content_plan_unavailable', status: error instanceof InputLimitError ? 400 : 500 });
  }
}

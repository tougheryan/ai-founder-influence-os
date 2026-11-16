import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { readCurrentResearchStatus, ResearchStatusInputError } from '@/lib/research-status';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    return NextResponse.json(await readCurrentResearchStatus(req.nextUrl.searchParams.get('runId') || ''), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ResearchStatusInputError) return expectedUserFacingErrorResponse({ error: error.message, code: 'research_status_input', status: 400 });
    return userFacingErrorResponse(error, { error: '暂时无法读取本期研究状态，请重新读取。', code: 'research_status_read_failed', status: 500 });
  }
}

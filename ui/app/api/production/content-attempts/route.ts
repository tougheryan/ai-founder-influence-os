import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { ContentAttemptError, getContentAttempt, listContentAttempts, type ContentAttempt } from '@/lib/content-attempts';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';
import { getRunDisclosure } from '@/lib/output-disclosure';
import { OutputDownloadError, prepareOutputDownload } from '@/lib/output-export';

export const runtime = 'nodejs';
const present = (record: ContentAttempt) => Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'ownerPid'));

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const runId = req.nextUrl.searchParams.get('runId') || '';
    const id = req.nextUrl.searchParams.get('id');
    if (id) {
      const record = await getContentAttempt(runId, id);
      if (!record) return NextResponse.json({ error: '找不到这次生成记录。' }, { status: 404 });
      if (req.nextUrl.searchParams.get('download') === '1') {
        const content = req.nextUrl.searchParams.get('working') === '1' ? record.workingDraft?.body ?? record.body : record.body;
        const output = prepareOutputDownload(Buffer.from(content), `unfinished-${record.id}.md`, 'text/plain; charset=utf-8', await getRunDisclosure(runId));
        return new Response(new Uint8Array(output.body), { headers: {
          'Content-Type': output.contentType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(output.fileName)}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        } });
      }
      return NextResponse.json({ attempt: present(record) });
    }
    return NextResponse.json({ attempts: (await listContentAttempts(runId)).map(present) });
  } catch (error) {
    if (error instanceof OutputDownloadError) return expectedUserFacingErrorResponse({ error: error.message, code: 'content_attempt_download_limit', status: 413 });
    if (error instanceof ContentAttemptError) return expectedUserFacingErrorResponse({ error: error.message, code: 'content_attempt_input', status: 400 });
    return userFacingErrorResponse(error, { error: '暂时无法读取保留的生成结果，请稍后重试。', code: 'content_attempt_read_failed', status: 500 });
  }
}

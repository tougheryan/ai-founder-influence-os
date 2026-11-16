import { NextRequest, NextResponse } from 'next/server';
import { prepareXhsBundle, XhsBundleError } from '@/lib/xhs-bundle';
import { OutputDownloadError } from '@/lib/output-export';
import { prepareOutputDownloadEvent } from '@/lib/output-download-events';

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const output = await prepareXhsBundle({ slug: query.get('slug') || '', post: query.get('post') || '', selection: query.get('selection') || '' });
    let receipt: Awaited<ReturnType<typeof prepareOutputDownloadEvent>> = null;
    let recording = 'unattributed';
    try {
      receipt = await prepareOutputDownloadEvent({ path: output.path, source: output.source, output: output.body, fileName: output.fileName, disclosure: output.disclosure });
      if (receipt) recording = 'prepared';
    } catch { recording = 'unavailable'; }
    await output.assertUnchanged();
    return new Response(new Uint8Array(output.body), { headers: {
      'Content-Type': output.contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(output.fileName)}`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Echo-Download-Bytes': String(output.body.length), 'X-Echo-Download-Record': recording,
      ...(receipt ? { 'X-Echo-Download-Receipt': receipt.id, 'X-Echo-Download-Run-Id': encodeURIComponent(receipt.runId) } : {}),
    } });
  } catch (error) {
    const known = error instanceof XhsBundleError || error instanceof OutputDownloadError;
    return NextResponse.json({ error: known ? error.message : '整套文件暂时无法下载，请重试。', code: 'visual_bundle_download_failed' },
      { status: known ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
  }
}

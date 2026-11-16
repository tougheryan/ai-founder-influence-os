import { describe, expect, it, vi } from 'vitest';
import { acknowledgeOutputDownload, fetchOutputDownload, startOutputDownload } from './output-download';

const href = '/api/output/pipeline/visual/mock/p1.png?download=1';
function response(bytes: BodyInit, disposition = `attachment; filename*=UTF-8''${encodeURIComponent('模拟图文（仅供内部预览）.zip')}`, extraHeaders: HeadersInit = {}) {
  return new Response(bytes, { headers: { 'content-type': 'application/zip', 'content-disposition': disposition, ...extraHeaders } });
}

describe('download responses without API navigation', () => {
  it('retains binary bytes and the server UTF-8 filename, with a fresh cancellable request', async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 65]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes, undefined, { 'content-length': '6' }));
    const controller = new AbortController();
    const download = await fetchOutputDownload(href, controller.signal, fetcher);
    expect(download.fileName).toBe('模拟图文（仅供内部预览）.zip');
    expect(new Uint8Array(await download.blob.arrayBuffer())).toEqual(bytes);
    expect(download.blob.type).toBe('application/zip');
    expect(fetcher).toHaveBeenCalledWith(href, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
  });

  it.each([
    ['attachment; filename="mock; draft.txt"', 'mock; draft.txt'],
    ["attachment; filename=fallback.txt; filename*=UTF-8'zh'%E6%A8%A1%E6%8B%9F.txt", '模拟.txt'],
    ["attachment; filename=fallback.txt; filename*=UTF-8''%ZZ", 'fallback.txt'],
    ['attachment; filename="../../mock.txt"', 'mock.txt'],
  ])('reads a safe attachment name from %s', async (header, expected) => {
    const download = await fetchOutputDownload(href, undefined, vi.fn<typeof fetch>().mockResolvedValue(response('模拟正文', header)));
    expect(download.fileName).toBe(expected);
    expect(await download.blob.text()).toBe('模拟正文');
  });

  it('retains the decoded Blob when Content-Length describes a compressed transfer', async () => {
    const text = '模拟完整正文。'.repeat(20);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text, 'attachment; filename="mock.txt"', {
      'content-length': '30', 'content-encoding': 'gzip',
    }));
    expect(await (await fetchOutputDownload(href, undefined, fetcher)).blob.text()).toBe(text);
  });

  it.each([
    [400, '无法打开这个文件。'],
    [413, '单个导出文件超过 256MB，请拆分后重试。'],
    [413, '公开限制说明过长，请整理后重试。'],
  ])('keeps the useful JSON %s error instead of treating it as a downloaded file', async (status, error) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error }, { status }));
    await expect(fetchOutputDownload(href, undefined, fetcher)).rejects.toThrow(error);
  });

  it.each([
    new Response('gateway failed', { status: 502 }),
    Response.json({ error: 'Error at /Users/mock/private-data' }, { status: 500 }),
    Response.json({ error: 'API Key=sk-test-secret-data' }, { status: 400 }),
  ])('does not expose raw server failures or private details', async (failure) => {
    await expect(fetchOutputDownload(href, undefined, vi.fn<typeof fetch>().mockResolvedValue(failure)))
      .rejects.toThrow('暂时无法下载文件。请重试。');
  });

  it.each([
    new Response('<html>模拟登录页面</html>'),
    Response.json({ error: '模拟错误状态遗漏' }),
    response('text', 'inline; filename="mock.txt"'),
    response('text', "attachment; filename*=UTF-8''%ZZ"),
    response('text', `attachment; filename="${'x'.repeat(260)}.txt"`),
    response('text', 'attachment; filename=".."'),
    response('text', 'attachment; filename="mock.txt"', { 'content-length': '200' }),
    new Response(null, { status: 204, headers: { 'content-disposition': 'attachment; filename="mock.txt"' } }),
    new Response('part', { status: 206, headers: { 'content-disposition': 'attachment; filename="mock.txt"' } }),
  ])('rejects an invalid or incomplete success response', async (invalid) => {
    await expect(fetchOutputDownload(href, undefined, vi.fn<typeof fetch>().mockResolvedValue(invalid)))
      .rejects.toThrow('没有收到完整的下载文件。请重试。');
  });

  it('lets a failed network request reject so the link can show an error and retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(response('retry'));
    await expect(fetchOutputDownload(href, undefined, fetcher)).rejects.toThrow('Failed to fetch');
    expect(await (await fetchOutputDownload(href, undefined, fetcher)).blob.text()).toBe('retry');
  });

  it('does not save a completed response after its initiating view has been left', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      return response('late result');
    });
    await expect(fetchOutputDownload(href, controller.signal, fetcher)).rejects.toMatchObject({ name: 'AbortError' });
  });
});


const receiptId = '11111111-1111-4111-8111-111111111111';
const receiptHeaders = { 'x-echo-download-record': 'prepared', 'x-echo-download-receipt': receiptId, 'x-echo-download-run-id': encodeURIComponent('稿件一') };
const ackResponse = () => Response.json({ ok: true, event: { id: receiptId, runId: '稿件一', downloadStartedAt: '2026-09-20T12:00:00Z' } });
describe('acknowledgement follows a complete browser download click', () => {
  it('waits for complete bytes, clicks once, then posts the exact receipt without treating preparation as completion', async () => {
    const actions: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') { actions.push('ack'); return ackResponse(); }
      actions.push('fetch'); return response('正文', undefined, { ...receiptHeaders, 'x-echo-download-bytes': String(new TextEncoder().encode('正文').length) });
    });
    const startDownload = vi.fn((blob: Blob) => { expect(blob.size).toBe(6); actions.push('click'); });
    const result = await startOutputDownload(href, { fetcher, startDownload });
    expect(actions).toEqual(['fetch', 'click', 'ack']);
    expect(startDownload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ receiptId, runId: '稿件一' });
    expect(result.recorded).toBe(true);
    expect(result.message).toContain('发起浏览器下载');
    expect(result.message).not.toContain('已保存到');
  });
  it('does not click or acknowledge a failed or incomplete response', async () => {
    for (const invalid of [Response.json({ error: '不可用' }, { status: 500 }), response('正文', undefined, { ...receiptHeaders, 'x-echo-download-bytes': '900' })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(invalid);
      const startDownload = vi.fn();
      await expect(startOutputDownload(href, { fetcher, startDownload })).rejects.toThrow();
      expect(startDownload).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('does not acknowledge when the browser click fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('正文', undefined, receiptHeaders));
    await expect(startOutputDownload(href, { fetcher, startDownload: () => { throw new Error('browser click failed'); } })).rejects.toThrow('browser click failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not start or acknowledge an aborted source request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return response('正文', undefined, receiptHeaders); });
    const startDownload = vi.fn();
    await expect(startOutputDownload(href, { signal: controller.signal, fetcher, startDownload })).rejects.toMatchObject({ name: 'AbortError' });
    expect(startDownload).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['unavailable', 'unattributed', 'prepared', 'unsupported'])('retains a valid file with %s recording metadata and never invents an acknowledgement', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('正文', undefined, status === 'unsupported' ? {} : { 'x-echo-download-record': status }));
    const startDownload = vi.fn();
    const result = await startOutputDownload(href, { fetcher, startDownload });
    expect(startDownload).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.recorded).toBe(false); expect(result.message).toContain('已发起浏览器下载');
  });
  it.each(['failure', 'network', 'malformed', 'wrong-run', 'aborted'])('keeps the download started when acknowledgement is %s, without automatically repeating either request', async (mode) => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      if (options?.method !== 'POST') return response('正文', undefined, receiptHeaders);
      if (mode === 'network') throw new Error('connection lost after save');
      if (mode === 'aborted') controller.abort();
      if (mode === 'failure') return Response.json({ error: 'failed' }, { status: 500 });
      if (mode === 'malformed') return new Response('invalid JSON');
      if (mode === 'wrong-run') return Response.json({ ok: true, event: { id: receiptId, runId: 'other', downloadStartedAt: '2026-09-20T12:00:00Z' } });
      return ackResponse();
    });
    const startDownload = vi.fn();
    const result = await startOutputDownload(href, { signal: controller.signal, fetcher, startDownload });
    expect(startDownload).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.recorded).toBe(false); expect(result.message).toContain('无需重新下载');
  });
  it('does not submit receipt data after navigation has aborted recording', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    expect(await acknowledgeOutputDownload({ id: receiptId, runId: '稿件一' }, controller.signal, fetcher)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});


it('releases a stalled acknowledgement after five seconds without another download request', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => options?.method === 'POST'
      ? new Promise<Response>(() => {}) : response('正文', undefined, receiptHeaders));
    const startDownload = vi.fn();
    const task = startOutputDownload(href, { fetcher, startDownload });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await task).toMatchObject({ recorded: false, message: expect.stringContaining('无需重新下载') });
    expect(startDownload).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), record: vi.fn(), check: vi.fn() }));
vi.mock('@/lib/xhs-bundle', () => ({ prepareXhsBundle: mocks.prepare, XhsBundleError: class extends Error { status = 409; } }));
vi.mock('@/lib/output-download-events', () => ({ prepareOutputDownloadEvent: mocks.record }));
import { GET } from './route';
import { XhsBundleError } from '@/lib/xhs-bundle';
const request = () => new NextRequest(`http://localhost/api/visual/download?slug=demo&post=1&selection=${'a'.repeat(64)}`);
beforeEach(() => {
  vi.clearAllMocks(); mocks.check.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue({ body: Buffer.from('zip bytes'), source: Buffer.from('selection bytes'), path: 'pipeline/visual/demo/selected-assets.json',
    fileName: '虚构图文.zip', contentType: 'application/zip', disclosure: { status: 'internal_only' }, assertUnchanged: mocks.check });
  mocks.record.mockResolvedValue({ id: 'receipt', runId: 'run-demo' });
});
describe('single bundle download response', () => {
  it('provides one archive and a receipt for the browser acknowledgement', async () => {
    const result = await GET(request()); expect(result.status).toBe(200);
    expect(await result.text()).toBe('zip bytes'); expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(result.headers.get('x-echo-download-receipt')).toBe('receipt');
    expect(result.headers.get('x-echo-download-bytes')).toBe('9');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it('creates no receipt for incomplete files', async () => {
    mocks.prepare.mockRejectedValueOnce(new XhsBundleError('缺少图片，请重新生成。'));
    const result = await GET(request()); expect(result.status).toBe(409); expect(mocks.record).not.toHaveBeenCalled();
    expect(await result.json()).toMatchObject({ error: '缺少图片，请重新生成。' });
  });
  it('keeps a complete download usable if recording is unavailable', async () => {
    mocks.record.mockRejectedValueOnce(new Error('disk failure'));
    const result = await GET(request()); expect(result.status).toBe(200); expect(result.headers.get('x-echo-download-record')).toBe('unavailable');
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it('does not send archive bytes or a receipt after files change during recording', async () => {
    mocks.check.mockRejectedValueOnce(new XhsBundleError('原稿发生变化，请刷新。'));
    const result = await GET(request()); expect(result.status).toBe(409); expect(result.headers.has('x-echo-download-receipt')).toBe(false);
    expect(result.headers.has('content-disposition')).toBe(false);
  });
});

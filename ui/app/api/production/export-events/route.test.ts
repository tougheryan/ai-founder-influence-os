import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ reads: [] as string[], acks: [] as unknown[][], failure: false }));
vi.mock('@/lib/output-download-events', () => ({
  OutputDownloadEventError: class OutputDownloadEventError extends Error { status = 400; },
  listOutputDownloadEvents: async (id: string) => { mocks.reads.push(id); return { items: [], unreadable: 0 }; },
  acknowledgeOutputDownloadEvent: async (...args: unknown[]) => { mocks.acks.push(args); if (mocks.failure) throw new Error('private failure'); return { id: args[1], runId: args[0], downloadStartedAt: '2026-09-20T12:00:00Z' }; },
}));
import { GET, POST } from './route';
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/production/export-events', { method: 'POST', body: JSON.stringify(body) }));
beforeEach(() => { mocks.reads = []; mocks.acks = []; mocks.failure = false; });
describe('export receipt API', () => {
  it('lists explicit run history without acknowledging or caching it', async () => {
    const result = await GET(new NextRequest('http://localhost/api/production/export-events?runId=run-a'));
    expect(await result.json()).toEqual({ items: [], unreadable: 0 });
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(mocks.reads).toEqual(['run-a']); expect(mocks.acks).toEqual([]);
  });
  it('passes only the explicit receipt and run identity to acknowledgement', async () => {
    const result = await post({ runId: 'run-a', receiptId: 'receipt', downloadStartedAt: 'forged', path: 'other', status: 'published' });
    expect(result.status).toBe(200);
    expect(mocks.acks).toEqual([['run-a', 'receipt']]);
    expect((await result.json()).event.downloadStartedAt).toBe('2026-09-20T12:00:00Z');
  });
  it.each([null, [], {}, { receiptId: 'id' }, { runId: 'a', receiptId: 1 }, { runId: 'a', receiptId: 'x'.repeat(3000) }])('rejects malformed or oversized request %j without acknowledgement', async (body) => {
    expect((await post(body)).status).toBe(400); expect(mocks.acks).toEqual([]);
  });
  it('reports a recording failure without asking the user to download again', async () => {
    mocks.failure = true;
    const response = await post({ runId: 'a', receiptId: 'receipt' });
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error).toContain('已经发起的文件下载不受影响');
    expect(payload.error).not.toContain('private failure');
  });
});

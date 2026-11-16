import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ initialize: vi.fn(), list: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: fixture.initialize }));
vi.mock('@/lib/production-outcomes', () => ({
  listProductionOutcomes: fixture.list,
  readProductionOutcome: fixture.read,
  saveProductionOutcome: fixture.save,
  ProductionOutcomeError: class ProductionOutcomeError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
  },
}));

import { ProductionOutcomeError } from '@/lib/production-outcomes';
import { WriteLockError } from '@/lib/write-guard';
import { MAX_AGENT_PAYLOAD_BYTES } from '@/lib/input-limits';
import { GET, POST } from './route';

const get = (query = '') => GET(new NextRequest(`http://localhost/api/production/outcomes${query}`));
const post = (value: unknown) => POST(new NextRequest('http://localhost/api/production/outcomes', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
}));

beforeEach(() => {
  fixture.initialize.mockReset().mockResolvedValue(undefined);
  fixture.list.mockReset().mockResolvedValue({ items: [], offset: 0, total: 0, limit: 20, unreadable: 0 });
  fixture.read.mockReset().mockResolvedValue({ runId: 'run-b', currentCompletion: null });
  fixture.save.mockReset().mockResolvedValue({ version: 1, minutesSpent: 12, completions: [] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('GET /api/production/outcomes', () => {
  it('requests an explicit page with no-store caching', async () => {
    const response = await get('?offset=20');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fixture.initialize).toHaveBeenCalledOnce();
    expect(fixture.list).toHaveBeenCalledWith(20, { query: '', filter: 'all' });
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('passes search and status to the project-wide list before pagination', async () => {
    expect((await get('?offset=20&query=客户报价&filter=ready')).status).toBe(200);
    expect(fixture.list).toHaveBeenCalledWith(20, { query: '客户报价', filter: 'ready' });
  });

  it.each(['?filter=unknown', `?query=${'字'.repeat(201)}`])('rejects unsupported filters or oversized queries: %s', async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(fixture.list).not.toHaveBeenCalled();
  });

  it('reads only the requested run without falling back to the active run or list', async () => {
    const response = await get('?runId=run-b');
    expect(await response.json()).toEqual({ item: { runId: 'run-b', currentCompletion: null } });
    expect(fixture.read).toHaveBeenCalledWith('run-b');
    expect(fixture.list).not.toHaveBeenCalled();
  });

  it.each(['-1', '1.5', 'NaN', 'hello'])('rejects invalid offset %s before domain reads', async (offset) => {
    const response = await get(`?offset=${offset}`);
    expect(response.status).toBe(400);
    expect(fixture.list).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled();
  });

  it('preserves a domain snapshot conflict as 409 with readable feedback', async () => {
    fixture.read.mockRejectedValue(new ProductionOutcomeError('草稿正在更新，请刷新制作记录。', 409));
    const response = await get('?runId=run-a');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: '草稿正在更新，请刷新制作记录。' });
  });

  it('returns a safe failure when a backend read fails instead of a successful empty list', async () => {
    fixture.list.mockRejectedValue(new Error('internal path /Users/private/data/outcome.json api_key=secret-value'));
    const response = await get();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/secret-value|\/Users\/private|stack/);
    expect(body).not.toHaveProperty('items');
  });
});

describe('POST /api/production/outcomes', () => {
  it('passes the explicit action, version and snapshot to the domain without manufacturing confirmation', async () => {
    const input = { runId: 'run-b', action: 'save-note', snapshot: 'a'.repeat(64), expectedVersion: 0, minutesSpent: 12, reusedPreviousWork: null, note: '' };
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(fixture.save).toHaveBeenCalledWith(input);
    expect(await response.json()).toEqual({ note: { version: 1, minutesSpent: 12, completions: [] } });
  });

  it.each([null, [], 'text', 4, true])('rejects a non-object request %s before persistence', async (input) => {
    expect((await post(input)).status).toBe(400);
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and oversized input before persistence', async () => {
    const invalid = new NextRequest('http://localhost/api/production/outcomes', { method: 'POST', body: '{unfinished' });
    expect((await POST(invalid)).status).toBe(400);
    expect((await post({ note: 'x'.repeat(MAX_AGENT_PAYLOAD_BYTES + 1) })).status).toBe(400);
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it.each([
    [new ProductionOutcomeError('请重新读取制作记录后保存。'), 400],
    [new ProductionOutcomeError('记录已在其他页面修改，请重新读取后核对。', 409), 409],
    [new WriteLockError('同一任务正在执行，请稍后再试'), 409],
  ])('preserves validation and write conflict status', async (error, status) => {
    fixture.save.mockRejectedValue(error);
    const response = await post({ action: 'complete' });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });

  it('does not report a successful save or leak details after an unexpected write failure', async () => {
    fixture.save.mockRejectedValue(new Error('private disk failure api_key=secret-value /Users/private/outcome.json'));
    const response = await post({ action: 'complete' });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).not.toHaveProperty('note');
    expect(JSON.stringify(body)).not.toMatch(/secret-value|\/Users\/private|stack/);
  });
});

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputDisclosure } from '@/lib/output-disclosure';

const mocks = vi.hoisted(() => ({
  disclosure: { status: 'internal_only', restrictions: ['仅供内部使用'] } as OutputDisclosure,
  runIds: [] as string[],
}));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => undefined }));
vi.mock('@/lib/content-attempts', () => ({
  ContentAttemptError: class ContentAttemptError extends Error {},
  getContentAttempt: async (runId: string, id: string) => ({ runId, id, body: '保留的完整正文', ownerPid: 777, status: 'failed' }),
  listContentAttempts: async () => [],
}));
vi.mock('@/lib/output-disclosure', () => ({
  getRunDisclosure: async (runId: string) => { mocks.runIds.push(runId); return mocks.disclosure; },
}));
import { GET } from './route';

describe('unfinished article downloads', () => {
  beforeEach(() => { mocks.runIds = []; mocks.disclosure = { status: 'internal_only', restrictions: ['仅供内部使用'] }; });

  it('attaches the requested run limits to downloads but leaves recovery data unchanged', async () => {
    const query = 'http://localhost/api/production/content-attempts?runId=run-one&id=attempt-one';
    const saved = await GET(new NextRequest(query));
    expect((await saved.json()).attempt).toEqual({ runId: 'run-one', id: 'attempt-one', body: '保留的完整正文', status: 'failed' });
    expect(mocks.runIds).toEqual([]);
    const exported = await GET(new NextRequest(`${query}&download=1`));
    const body = await exported.text();
    expect(body).toContain('仅供内部预览');
    expect(body.endsWith('保留的完整正文')).toBe(true);
    expect(mocks.runIds).toEqual(['run-one']);
    expect(exported.headers.get('cache-control')).toBe('no-store');
  });

  it('rereads changed limits instead of remembering the previous download', async () => {
    const query = 'http://localhost/api/production/content-attempts?runId=run-two&id=attempt-two&download=1';
    await GET(new NextRequest(query));
    mocks.disclosure = { status: 'restricted_details', restrictions: ['隐藏客户姓名'] };
    const next = await GET(new NextRequest(query));
    const text = await next.text();
    expect(text).toContain('局部公开限制');
    expect(text).toContain('隐藏客户姓名');
    expect(text).not.toContain('本期材料设有整期公开限制');
    expect(mocks.runIds).toEqual(['run-two', 'run-two']);
  });
});

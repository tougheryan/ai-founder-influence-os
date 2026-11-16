import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectAllCalls: 0,
  collectIds: [] as string[],
  lockKeys: [] as string[],
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(key: string, task: () => Promise<T>) => {
    mocks.lockKeys.push(key);
    return task();
  },
}));
vi.mock('@/lib/creative-library', () => ({
  CreativeLibraryError: class CreativeLibraryError extends Error {},
  collectAllPublishedScripts: async () => {
    mocks.collectAllCalls += 1;
    return { created: 2, existing: 3, items: [{ id: 'script_1234567890abcdef1234' }] };
  },
  collectPublishedScript: async (id: string) => {
    mocks.collectIds.push(id);
    return { item: { id: 'script_1234567890abcdef1234' }, idempotent: false };
  },
  getPublishedScript: async () => ({ id: 'script_1234567890abcdef1234' }),
  listPublishedScriptCandidates: async () => [],
  listPublishedScripts: async () => ({ items: [], total: 0, offset: 0, limit: 50 }),
}));

import { POST } from './route';

describe('published script collection API', () => {
  beforeEach(() => {
    mocks.collectAllCalls = 0;
    mocks.collectIds = [];
    mocks.lockKeys = [];
  });

  it('collects all confirmed publication candidates without requiring a client source id', async () => {
    const response = await POST(new NextRequest('http://localhost/api/creative-library/published-scripts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'collect-all' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      action: 'collect-all',
      created: 2,
      existing: 3,
      items: [{ id: 'script_1234567890abcdef1234' }],
    });
    expect(mocks.collectAllCalls).toBe(1);
    expect(mocks.collectIds).toEqual([]);
    expect(mocks.lockKeys).toEqual(['creative-library:published-scripts']);
  });

  it('keeps the single-record collection operation for individual buttons', async () => {
    const sourceRecordId = 'publication_1234567890abcdef1234';
    const response = await POST(new NextRequest('http://localhost/api/creative-library/published-scripts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'collect', sourceRecordId }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.collectIds).toEqual([sourceRecordId]);
    expect(mocks.collectAllCalls).toBe(0);
  });
});

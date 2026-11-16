import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dashboardCalls: 0,
  listInput: null as unknown,
  ingested: null as unknown,
  production: null as unknown,
  confirmation: null as unknown,
  reclassified: null as unknown,
  undone: null as unknown,
  migrated: 0,
  lockKeys: [] as string[],
  reused: [] as unknown[],
}));

vi.mock('@/lib/production-drafts', () => ({ saveProductionDraft: async (input: { id: string }) => ({ id: input.id }) }));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/input-limits', () => ({
  MAX_AGENT_PAYLOAD_BYTES: 2 * 1024 * 1024,
  InputLimitError: class InputLimitError extends Error {},
  assertJsonInputSize: () => {},
}));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(key: string, callback: () => Promise<T>) => {
    mocks.lockKeys.push(key);
    return callback();
  },
}));
vi.mock('@/lib/material-library', () => ({
  MaterialLibraryConflictError: class MaterialLibraryConflictError extends Error {},
  RAW_MATERIAL_CATEGORIES: ['insight', 'case', 'fact', 'reference', 'brand'],
  MaterialLibraryError: class MaterialLibraryError extends Error {},
  getRawMaterialDashboard: async () => {
    mocks.dashboardCalls += 1;
    return { rawMaterials: { total: 2 } };
  },
  listRawMaterials: async (input: unknown) => {
    mocks.listInput = input;
    return { items: [] };
  },
  getRawMaterialRecord: async (id: string) => id === 'known' ? { id } : null,
  rawMaterialDraftInput: async (...args: unknown[]) => { mocks.reused = args; return { id: 'draft_test' }; },
  ingestRawMaterials: async (input: unknown) => {
    mocks.ingested = input;
    return { created: 1, existing: 0, autoArchived: 0, records: [] };
  },
  ingestProductionMaterials: async (input: unknown) => {
    mocks.production = input;
    return { created: 5, existing: 0, autoArchived: 4, records: [] };
  },
  confirmRawMaterialArchive: async (input: unknown) => {
    mocks.confirmation = input;
    return [{ id: 'one' }];
  },
  reclassifyRawMaterial: async (input: unknown) => {
    mocks.reclassified = input;
    return { id: 'one', category: 'fact' };
  },
  undoAutoArchivedRawMaterial: async (id: unknown) => {
    mocks.undone = id;
    return { id, status: 'pending_confirmation' };
  },
  migrateLegacyRawMaterials: async () => {
    mocks.migrated += 1;
    return { created: 2, existing: 0, skipped: 0, records: [] };
  },
}));

import { GET, POST } from './route';

describe('material library API', () => {
  beforeEach(() => {
    mocks.dashboardCalls = 0;
    mocks.listInput = null;
    mocks.ingested = null;
    mocks.production = null;
    mocks.confirmation = null;
    mocks.reclassified = null;
    mocks.undone = null;
    mocks.migrated = 0;
    mocks.lockKeys = [];
    mocks.reused = [];
  });

  it('exposes a concise dashboard and filtered raw-material list contract', async () => {
    const dashboard = await GET(new NextRequest('http://localhost/api/material-library'));
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toEqual({ rawMaterials: { total: 2 } });
    expect(mocks.dashboardCalls).toBe(1);

    const list = await GET(new NextRequest('http://localhost/api/material-library?view=materials&status=pending_confirmation&category=case&sort=priority&limit=20'));
    expect(list.status).toBe(200);
    expect(mocks.listInput).toEqual({ status: 'pending_confirmation', category: 'case', sort: 'priority', limit: 20 });
  });

  it('passes the explicit reuse decision to the version-checked material writer', async () => {
    const response = await POST(new NextRequest('http://localhost/api/material-library', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reuse', id: 'known', expectedVersion: 'version', requestId: 'request', mode: 'new_topic', topic: '新的题目' }) }));
    expect(response.status).toBe(200);
    expect(mocks.reused).toEqual(['known', 'version', 'request', { mode: 'new_topic', topic: '新的题目' }]);
    expect(await response.json()).toMatchObject({ nextUrl: '/production?openDraft=draft_test' });
    expect(mocks.lockKeys).toEqual(['material-library']);
  });

  it('supports manual ingestion and run-scoped one-click deposits under one write lock', async () => {
    const ingest = await POST(new NextRequest('http://localhost/api/material-library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'ingest', items: [{ title: '素材', text: '内容' }] }),
    }));
    expect(ingest.status).toBe(200);
    expect(mocks.ingested).toEqual({ items: [{ title: '素材', text: '内容' }] });

    const production = await POST(new NextRequest('http://localhost/api/material-library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'ingest-production', runId: 'run-a', artifacts: [{ title: '补充素材' }] }),
    }));
    expect(production.status).toBe(200);
    expect(await production.json()).toMatchObject({ ok: true, created: 5, autoArchived: 4 });
    expect(mocks.production).toEqual({ runId: 'run-a', artifacts: [{ title: '补充素材' }] });
    expect(mocks.lockKeys).toEqual(['material-library', 'material-library']);
  });

  it('routes batch confirmation, reclassification, undo, and safe legacy migration', async () => {
    await POST(new NextRequest('http://localhost/api/material-library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'confirm', ids: ['one', 'two'], categoryById: { one: 'case' } }),
    }));
    expect(mocks.confirmation).toEqual({ ids: ['one', 'two'], categoryById: { one: 'case' } });

    await POST(new NextRequest('http://localhost/api/material-library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reclassify', id: 'one', category: 'fact' }),
    }));
    expect(mocks.reclassified).toEqual({ id: 'one', category: 'fact' });

    await POST(new NextRequest('http://localhost/api/material-library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'undo-auto-archive', id: 'one' }),
    }));
    expect(mocks.undone).toBe('one');

    const migrated = await POST(new NextRequest('http://localhost/api/material-library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'migrate-legacy' }),
    }));
    expect(migrated.status).toBe(200);
    expect(await migrated.json()).toMatchObject({ ok: true, created: 2 });
    expect(mocks.migrated).toBe(1);
  });
});

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ version: 2, saves: vi.fn(), append: vi.fn(), review: vi.fn(), locks: [] as string[] }));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/write-guard', () => ({ WriteLockError: class extends Error {}, withProjectWriteLock: async <T>(key: string, task: () => Promise<T>) => { mocks.locks.push(key); return task(); } }));
vi.mock('@/lib/creative-library', () => {
  class CreativeLibraryError extends Error {}
  class CreativeLibraryConflictError extends CreativeLibraryError {}
  return { CreativeLibraryError, CreativeLibraryConflictError,
    assertCreativeVersion: (expected: unknown, actual: number) => { if (expected !== actual) throw new CreativeLibraryConflictError('写作设置已更新'); },
    readCreativeProfile: async () => ({ version: mocks.version }), saveCreativeProfile: mocks.saves,
  };
});
vi.mock('@/lib/draft-preference-reuse', () => ({ readDraftPreferenceReview: mocks.review, saveDraftPreferences: mocks.append }));
import { GET, POST } from './route';
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/creative-library/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
beforeEach(() => { vi.clearAllMocks(); mocks.locks = []; mocks.version = 2; mocks.saves.mockResolvedValue({ version: 3 }); mocks.append.mockResolvedValue({ version: 3 }); });
describe('profile save and optional draft preferences API', () => {
  it('requires the exact displayed settings version for direct saves', async () => {
    expect((await post({ action: 'update', profile: { writingStyle: 'old' } })).status).toBe(409);
    expect((await post({ action: 'update', profile: { writingStyle: 'old' }, expectedVersion: 1 })).status).toBe(409);
    expect(mocks.saves).not.toHaveBeenCalled();
    expect((await post({ action: 'update', profile: { writingStyle: 'new' }, expectedVersion: 2 })).status).toBe(200);
    expect(mocks.saves).toHaveBeenCalledWith({ action: 'update', profile: { writingStyle: 'new' }, expectedVersion: 2 });
  });
  it('loads only the explicitly named draft and marks the candidate response no-store', async () => {
    mocks.review.mockResolvedValue({ candidates: [] });
    const response = await GET(new NextRequest('http://localhost/api/creative-library/profile?runId=run-b&inputFingerprint=abc'));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.review).toHaveBeenCalledWith('run-b', 'abc'); expect(mocks.append).not.toHaveBeenCalled();
  });
  it('serializes preference promotion with both material edits and all settings mutations', async () => {
    const body = { action: 'append-preferences', runId: 'run-b', inputFingerprint: 'a'.repeat(64), analysisFingerprint: 'b'.repeat(64), expectedVersion: 2, choices: [{ id: 'writingStyle-0', value: '平实' }] };
    expect((await post(body)).status).toBe(200);
    expect(mocks.locks).toEqual(['material-analysis:run-b', 'creative-library:settings']);
    expect(mocks.append).toHaveBeenCalledWith({ runId: body.runId, inputFingerprint: body.inputFingerprint, analysisFingerprint: body.analysisFingerprint, expectedVersion: 2, choices: body.choices });
    expect(mocks.saves).not.toHaveBeenCalled();
  });
  it('keeps the existing profile read independent of any active draft', async () => {
    expect(await (await GET(new NextRequest('http://localhost/api/creative-library/profile'))).json()).toEqual({ profile: { version: 2 } });
    expect(mocks.review).not.toHaveBeenCalled();
  });
});

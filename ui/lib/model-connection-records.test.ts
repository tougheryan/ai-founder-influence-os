import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: `/tmp/echo-model-check-${process.pid}`, config: { provider: 'openai', model: 'test-model', baseUrl: 'https://test.invalid/v1', apiKey: 'test-only-secret' }, completion: vi.fn(), issues: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', async (original) => ({ ...await original<typeof import('./project-root')>(), PROJECT_DIR: fixture.root }));
vi.mock('./project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('./server-config', () => ({ resolveServerLLMConfig: async () => fixture.config }));
vi.mock('./llm-client', () => ({ getModel: (value: typeof fixture.config) => value.model, getApiKey: (value: typeof fixture.config) => value.apiKey, getProviderPreset: () => ({ baseUrl: 'https://test.invalid/v1' }), validateLLMConfig: () => fixture.issues, createLLMTextCompletion: fixture.completion }));
import { beginModelConnectionRecord, finishModelConnectionRecord, readModelConnectionRecord } from './model-connection-records';
import { GET, POST } from '@/app/api/config/test/route';
const post = () => POST(new NextRequest('http://localhost/api/config/test', { method: 'POST', body: JSON.stringify({}) }));
beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true }); await mkdir(fixture.root, { recursive: true });
  fixture.config = { provider: 'openai', model: 'test-model', baseUrl: 'https://test.invalid/v1', apiKey: 'test-only-secret' };
  fixture.completion.mockReset().mockResolvedValue('OK'); fixture.issues = [];
});
afterAll(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe('model connection test receipts', () => {
  it('persists a timed result, exposes no credential or fingerprint, and never tests again on read', async () => {
    expect((await post()).status).toBe(200);
    const payload = await (await GET()).json();
    expect(payload).toMatchObject({ matchesCurrentSettings: true, record: { status: 'success', model: 'test-model' } });
    expect(payload.record.completedAt).toBeTruthy();
    expect(payload.record.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(payload)).not.toMatch(/test-only-secret|fingerprint|ownerPid|https:/);
    const file = (await readdir(join(fixture.root, 'sessions/model-connection-tests')))[0];
    expect(await readFile(join(fixture.root, 'sessions/model-connection-tests', file), 'utf8')).not.toContain('test-only-secret');
    expect(fixture.completion).toHaveBeenCalledOnce();
    expect(fixture.completion.mock.calls[0][2].maxRetries).toBe(0);
  });
  it.each(['apiKey', 'model', 'baseUrl'] as const)('does not reuse a previous success after %s changes', async (key) => {
    await post(); fixture.config[key] += '-changed';
    expect(await readModelConnectionRecord(fixture.config)).toMatchObject({ matchesCurrentSettings: false, record: { status: 'success' } });
    expect(fixture.completion).toHaveBeenCalledOnce();
  });
  it('records an empty or failed response as a failed test, not a fabricated OK', async () => {
    fixture.completion.mockResolvedValueOnce('');
    expect((await post()).status).toBe(400);
    expect((await readModelConnectionRecord(fixture.config)).record?.status).toBe('failed');
    fixture.completion.mockRejectedValueOnce(new Error('upstream test-only-secret'));
    const payload = await (await post()).json();
    expect(payload.record.status).toBe('failed');
    expect(JSON.stringify(payload.record)).not.toContain('test-only-secret');
  });
  it('does not call the provider for missing settings', async () => {
    fixture.issues = ['Missing API Key'];
    expect((await post()).status).toBe(400);
    expect((await readModelConnectionRecord(fixture.config)).record).toBeNull();
    expect(fixture.completion).not.toHaveBeenCalled();
  });
  it('shows an interrupted test separately and does not silently retry it', async () => {
    const record = await beginModelConnectionRecord(fixture.config);
    record.ownerPid = 2147483647;
    const path = join(fixture.root, 'sessions/model-connection-tests', `${record.id}.json`);
    await writeFile(path, JSON.stringify(record));
    expect((await readModelConnectionRecord(fixture.config)).record).toMatchObject({ status: 'interrupted', completedAt: null });
    expect(fixture.completion).not.toHaveBeenCalled();
    await finishModelConnectionRecord(record, false);
  });
  it('rejects linked receipts without reading their contents', async () => {
    const record = await beginModelConnectionRecord(fixture.config); await finishModelConnectionRecord(record, true);
    const path = join(fixture.root, 'sessions/model-connection-tests', `${record.id}.json`);
    await rm(path); await writeFile(join(fixture.root, 'external.json'), JSON.stringify(record));
    await symlink(join(fixture.root, 'external.json'), path);
    await expect(readModelConnectionRecord(fixture.config)).rejects.toThrow('regular file');
  });
});

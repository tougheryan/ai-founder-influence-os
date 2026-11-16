import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: `/tmp/echo-research-status-${process.pid}`, run: null as Record<string, unknown> | null, verify: vi.fn(), verifyCollected: vi.fn(), verifyAuthor: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', async (original) => ({ ...await original<typeof import('./project-root')>(), PROJECT_DIR: fixture.root }));
vi.mock('./runtime-run-resolver', () => ({ activeRuntimeRun: async () => fixture.run, runtimeRunById: async (id: string) => fixture.run?.run_id === id ? fixture.run : null }));
vi.mock('./runtime-writer', () => ({ verifyRuntimeAuthorSource: fixture.verifyAuthor, verifyFrozenRuntimeTikomniMarketSnapshot: fixture.verify, verifyRuntimeTikomniMarketSnapshot: fixture.verifyCollected }));
import { readCurrentResearchStatus } from './research-status';

const manifestPath = 'runs/run-a/market-research/sample/snapshot.json';
const pointerPath = 'runs/run-a/market-research/frozen-snapshot.json';
const digest = 'a'.repeat(64);
async function json(path: string, value: unknown) { await mkdir(join(fixture.root, path, '..'), { recursive: true }); await writeFile(join(fixture.root, path), JSON.stringify(value)); }
beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
  fixture.verifyAuthor.mockReset().mockResolvedValue({ verified: true });
  fixture.run = { run_id: 'run-a', slug: 'topic', topic: '这期客户问题', selected_platforms: ['wechat'], steps: { intake: { latest: 'pipeline/intake/current.md' } } };
  fixture.verify.mockReset().mockResolvedValue({ verified: true, run_id: 'run-a', manifest_path: manifestPath, snapshot_sha256: digest, source_path: 'pipeline/intake/current.md' });
  fixture.verifyCollected.mockReset().mockResolvedValue({ verified: true, run_id: 'run-a', manifest_path: manifestPath, snapshot_sha256: digest, source_path: 'pipeline/intake/current.md' });
  await json(pointerPath, { run_id: 'run-a', manifest_path: manifestPath, snapshot_sha256: digest });
  await json(manifestPath, { run_id: 'run-a', sha256: digest, created_at: '2026-09-15T15:00:00+08:00', required_platforms: ['wechat_mp'], platform_checks: { wechat_mp: { status: 'available', sample_count: 10 } } });
});
afterAll(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe('independent per-run research status', () => {
  it('shows verified completed collection before topic confirmation, without claiming selected evidence', async () => {
    await rm(join(fixture.root, pointerPath));
    await json('runs/run-a/tasks/task_collected.json', { runId: 'run-a', steps: [{ id: 'market-research', status: 'completed', startedAt: '2026-09-16T10:00:00+08:00', result: { snapshotPath: manifestPath, snapshotSha256: digest } }] });
    expect(await readCurrentResearchStatus('run-a')).toMatchObject({ state: 'collected', platforms: [{ sampleCount: 10 }], reason: expect.stringContaining('等你核对') });
    expect(fixture.verify).not.toHaveBeenCalled();
    expect(fixture.verifyCollected).toHaveBeenCalledWith('run-a', manifestPath);
    fixture.verifyCollected.mockResolvedValueOnce({ verified: false });
    expect((await readCurrentResearchStatus('run-a')).state).toBe('unavailable');
  });
  it('does not use an uncompleted, foreign, or unverified candidate as saved research', async () => {
    await rm(join(fixture.root, pointerPath));
    const task = { runId: 'run-a', steps: [{ id: 'market-research', status: 'running', startedAt: '2026-09-16T10:00:00+08:00', result: { snapshotPath: manifestPath, snapshotSha256: digest } }] };
    await json('runs/run-a/tasks/task_candidate.json', task);
    expect((await readCurrentResearchStatus('run-a')).state).toBe('not_collected');
    task.steps[0].status = 'completed'; task.steps[0].result.snapshotPath = 'runs/run-b/market-research/sample/snapshot.json';
    await json('runs/run-a/tasks/task_candidate.json', task);
    expect((await readCurrentResearchStatus('run-a')).state).toBe('unavailable');
    expect(fixture.verifyCollected).not.toHaveBeenCalled();
  });
  it('keeps verified topic evidence distinct from a failed weekly collection and a later failed topic retry', async () => {
    await json('sessions/tikomni-weekly-market-state.json', { last_status: 'blocked' });
    await json('runs/run-a/tasks/task_one.json', { runId: 'run-a', steps: [{ id: 'market-research', status: 'failed', startedAt: '2026-09-16T10:00:00+08:00', completedAt: '2026-09-16T10:01:00+08:00' }] });
    const status = await readCurrentResearchStatus('run-a');
    expect(status).toMatchObject({ state: 'current', collectedAt: '2026-09-15T15:00:00+08:00', platforms: [{ id: 'wechat_mp', sampleCount: 10, status: 'available' }], lastAttempt: { status: 'failed', startedAt: '2026-09-16T10:00:00+08:00' } });
    expect(status.platforms).toHaveLength(1);
    expect(fixture.verify).toHaveBeenCalledOnce();
    expect(fixture.verify).toHaveBeenCalledWith('run-a');
  });
  it('shows old-intake evidence as stale without offering it as current samples', async () => {
    fixture.verify.mockResolvedValueOnce({ verified: true, run_id: 'run-a', manifest_path: manifestPath, snapshot_sha256: digest, source_path: 'pipeline/intake/old.md' });
    expect(await readCurrentResearchStatus('run-a')).toMatchObject({ state: 'stale', platforms: [{ sampleCount: null }] });
  });
  it.each([null, undefined, '', '10', -1])('does not convert an unknown sample count %s into zero', async (value) => {
    const manifest = JSON.parse(await readFile(join(fixture.root, manifestPath), 'utf8'));
    manifest.platform_checks.wechat_mp.sample_count = value;
    await json(manifestPath, manifest);
    expect((await readCurrentResearchStatus('run-a')).platforms[0].sampleCount).toBeNull();
  });
  it('distinguishes no task, no collection and unreadable evidence', async () => {
    await expect(readCurrentResearchStatus('')).rejects.toThrow('请先打开');
    expect((await readCurrentResearchStatus('run-b')).state).toBe('no_run');
    await rm(join(fixture.root, manifestPath));
    expect((await readCurrentResearchStatus('run-a')).state).toBe('unavailable');
    await rm(join(fixture.root, pointerPath));
    expect((await readCurrentResearchStatus('run-a')).state).toBe('not_collected');
    fixture.run = null;
    expect((await readCurrentResearchStatus('run-a')).state).toBe('no_run');
  });
  it('rejects foreign, tampered and linked research records', async () => {
    await expect(readCurrentResearchStatus('../run-a')).rejects.toThrow('草稿');
    fixture.verify.mockResolvedValueOnce({ verified: false });
    expect((await readCurrentResearchStatus('run-a')).state).toBe('unavailable');
    await json(pointerPath, { run_id: 'run-b', manifest_path: manifestPath, snapshot_sha256: digest });
    expect((await readCurrentResearchStatus('run-a')).state).toBe('unavailable');
    await rm(join(fixture.root, pointerPath));
    await symlink(join(fixture.root, manifestPath), join(fixture.root, pointerPath));
    expect((await readCurrentResearchStatus('run-a')).state).toBe('unavailable');
  });
});

it('reports author material without reusing stored market evidence or claims of collection', async () => {
  fixture.run!.research_mode = 'author_material';
  const status = await readCurrentResearchStatus('run-a');
  expect(status).toMatchObject({ state: 'author_material', platforms: [], collectedAt: null, lastAttempt: null });
  expect(status.reason).toContain('未进行平台研究');
  expect(fixture.verify).not.toHaveBeenCalled(); expect(fixture.verifyCollected).not.toHaveBeenCalled();
  fixture.verifyAuthor.mockRejectedValueOnce(new Error('material changed'));
  expect(await readCurrentResearchStatus('run-a')).toMatchObject({ state: 'stale', platforms: [] });
});

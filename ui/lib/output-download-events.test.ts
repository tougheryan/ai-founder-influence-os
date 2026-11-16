import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: `/tmp/echo-output-events-${process.pid}` }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', async (original) => ({ ...await original<typeof import('./project-root')>(), PROJECT_DIR: fixture.root, projectPath: (...parts: string[]) => join(fixture.root, ...parts) }));
import { getOutputDisclosure } from './output-disclosure';
import { acknowledgeOutputDownloadEvent, listOutputDownloadEvents, prepareOutputDownloadEvent } from './output-download-events';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function put(path: string, value: unknown) { const target = join(fixture.root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value)); }
async function createRun(runId = 'run-a', path = `pipeline/package/${runId}.md`) {
  await put(`runs/${runId}.json`, { run_id: runId, slug: runId, steps: { package: { latest: path } } });
  await put(path, '原始正文');
  await put(`sessions/material-analysis/${runId}.json`, { schema: 'aifios.material-analysis.v1', runId, analysisStatus: 'current', inputFingerprint: sha('input'), analysisInputFingerprint: sha('input'), input: { rawMaterial: 'local synthetic input' }, analysis: { risks: ['仅供内部测试'] } });
  return path;
}
async function prepare(path = 'pipeline/package/run-a.md', source = '原始正文', output = '用途说明\n原始正文') {
  return prepareOutputDownloadEvent({ path, source: Buffer.from(source), output: Buffer.from(output), fileName: '正文（内部预览）.md', disclosure: await getOutputDisclosure(path) });
}
beforeEach(async () => { await rm(fixture.root, { recursive: true, force: true }); await mkdir(fixture.root, { recursive: true }); await createRun(); });
afterAll(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe('run-bound download receipts', () => {
  it('listing and file existence do not create prepared or started events', async () => {
    expect(await listOutputDownloadEvents('run-a')).toEqual({ items: [], unreadable: 0 });
    await getOutputDisclosure('pipeline/package/run-a.md');
    expect(await listOutputDownloadEvents('run-a')).toEqual({ items: [], unreadable: 0 });
    expect(await readdir(join(fixture.root, 'runs'))).toEqual(['run-a.json']);
  });
  it('records byte hashes and size only after preparation, with no source text or false completion', async () => {
    const event = await prepare();
    expect(event).toMatchObject({ runId: 'run-a', path: 'pipeline/package/run-a.md', sourceSha256: sha('原始正文'), outputSha256: sha('用途说明\n原始正文'), outputBytes: Buffer.byteLength('用途说明\n原始正文') });
    expect(event).not.toHaveProperty('downloadStartedAt');
    const onDisk = await readFile(join(fixture.root, `runs/run-a/output-download-events/${event!.id}.json`), 'utf8');
    expect(onDisk).not.toContain('原始正文');
    expect(onDisk).not.toContain('rawMaterial');
    expect((await listOutputDownloadEvents('run-a')).items).toEqual([event]);
  });
  it('acknowledges a server receipt once, including concurrent repeats without changing its original time', async () => {
    const prepared = (await prepare())!;
    const acknowledgements = await Promise.all([acknowledgeOutputDownloadEvent('run-a', prepared.id), acknowledgeOutputDownloadEvent('run-a', prepared.id)]);
    expect(acknowledgements[0].downloadStartedAt).toBeTruthy();
    expect(acknowledgements[1]).toEqual(acknowledgements[0]);
    expect((await listOutputDownloadEvents('run-a')).items).toEqual([acknowledgements[0]]);
  });
  it('rejects unknown receipts, cross-run acknowledgement and forged identifiers', async () => {
    const prepared = (await prepare())!;
    await createRun('run-b');
    await expect(acknowledgeOutputDownloadEvent('run-b', prepared.id)).rejects.toThrow();
    await expect(acknowledgeOutputDownloadEvent('run-a', randomUUID())).rejects.toThrow();
    await expect(acknowledgeOutputDownloadEvent('../run-a', prepared.id)).rejects.toThrow();
    await expect(acknowledgeOutputDownloadEvent('run-a', '../receipt')).rejects.toThrow();
    expect((await listOutputDownloadEvents('run-a')).items[0].downloadStartedAt).toBeUndefined();
    expect((await listOutputDownloadEvents('run-b')).items).toEqual([]);
  });
  it('retains historical byte identities when a source path is edited before or after acknowledgement', async () => {
    const first = (await prepare())!;
    await put(first.path, '新的正文');
    const second = (await prepare(first.path, '新的正文', '用途说明\n新的正文'))!;
    expect(second.id).not.toBe(first.id);
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    const acknowledged = await acknowledgeOutputDownloadEvent('run-a', first.id);
    expect(acknowledged.sourceSha256).toBe(first.sourceSha256);
    expect((await listOutputDownloadEvents('run-a')).items).toHaveLength(2);
  });
  it('does not trust unverified disclosures that carry a run ID or known active runs', async () => {
    const disclosure = await getOutputDisclosure('pipeline/package/run-a.md');
    await put('sessions/latest.json', { active_run_id: 'run-a' });
    expect(await prepareOutputDownloadEvent({ path: 'pipeline/package/run-a.md', source: Buffer.from('原始正文'), output: Buffer.from('原始正文'), fileName: '稿件.md', disclosure: { ...disclosure, status: 'unverified' } })).toBeNull();
    await put('pipeline/package/unowned.md', '原始正文');
    expect(await prepare('pipeline/package/unowned.md')).toBeNull();
    expect((await listOutputDownloadEvents('run-a')).items).toEqual([]);
  });
  it('rechecks ownership and source bytes instead of trusting an earlier successful disclosure', async () => {
    const path = 'pipeline/package/run-a.md';
    const disclosure = await getOutputDisclosure(path);
    await put('runs/run-b.json', { run_id: 'run-b', slug: 'run-b', steps: { package: { latest: path } } });
    expect(await prepareOutputDownloadEvent({ path, source: Buffer.from('原始正文'), output: Buffer.from('原始正文'), fileName: '稿件.md', disclosure })).toBeNull();
    await rm(join(fixture.root, 'runs/run-b.json'));
    await put(path, '已经变化的正文');
    expect(await prepareOutputDownloadEvent({ path, source: Buffer.from('原始正文'), output: Buffer.from('原始正文'), fileName: '稿件.md', disclosure })).toBeNull();
  });
  it('rejects event directory symlinks and preserves malformed or cross-run records as unreadable', async () => {
    const event = (await prepare())!;
    const path = `runs/run-a/output-download-events/${event.id}.json`;
    await put(path, { ...event, runId: 'run-b' });
    expect(await listOutputDownloadEvents('run-a')).toEqual({ items: [], unreadable: 1 });
    await expect(acknowledgeOutputDownloadEvent('run-a', event.id)).rejects.toThrow();
    await rm(join(fixture.root, 'runs/run-a/output-download-events'), { recursive: true });
    await mkdir(join(fixture.root, 'outside'), { recursive: true });
    await symlink(join(fixture.root, 'outside'), join(fixture.root, 'runs/run-a/output-download-events'));
    await expect(prepare()).rejects.toThrow();
    expect(await readdir(join(fixture.root, 'outside'))).toEqual([]);
    expect(await listOutputDownloadEvents('run-a')).toEqual({ items: [], unreadable: 1 });
  });
  it('rejects unsafe file names and oversized or damaged receipt records without writing', async () => {
    const disclosure = await getOutputDisclosure('pipeline/package/run-a.md');
    await expect(prepareOutputDownloadEvent({ path: 'pipeline/package/run-a.md', source: Buffer.from('原始正文'), output: Buffer.from('body'), fileName: '../body.md', disclosure })).rejects.toThrow();
    const id = randomUUID();
    await put(`runs/run-a/output-download-events/${id}.json`, 'x'.repeat(20 * 1024));
    expect(await listOutputDownloadEvents('run-a')).toEqual({ items: [], unreadable: 1 });
    await expect(acknowledgeOutputDownloadEvent('run-a', id)).rejects.toThrow();
  });
});

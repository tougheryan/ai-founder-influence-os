import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ root: `/tmp/echo-recovered-task-${process.pid}` }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', async original => ({ ...await original<typeof import('./project-root')>(), PROJECT_DIR: mock.root }));
import { recoveredContentTask } from './recovered-content-task';

const runId = 'recovery-test';
const attemptId = `attempt_${'a'.repeat(32)}`;
const revisionId = `rev_${'b'.repeat(32)}`;
const packagePath = 'pipeline/package/recovered.md';
const revisionPath = `runs/${runId}/content-revisions/${revisionId}.json`;
const attemptPath = `runs/${runId}/content-attempts/${attemptId}.json`;
const taskPath = `runs/${runId}/tasks/task_original.json`;
const body = `---\nsource: content-revision:${revisionId}\n---\n当前已恢复的正文。`;
const sha256 = createHash('sha256').update(body).digest('hex');
const approval = { approved: true, path: packagePath, sha256 };
const expected = { taskId: 'task_original', packagePath, packageSha256: sha256 };
const plan = { path: 'pipeline/blueprint/plan.md', sha256: 'c'.repeat(64) };
async function put(path: string, value: unknown) {
  await mkdir(dirname(`${mock.root}/${path}`), { recursive: true });
  await writeFile(`${mock.root}/${path}`, typeof value === 'string' ? value : JSON.stringify(value));
}
async function patch(path: string, changes: object) {
  await put(path, { ...JSON.parse(await readFile(`${mock.root}/${path}`, 'utf8')), ...changes });
}
beforeEach(async () => {
  await rm(mock.root, { recursive: true, force: true });
  await put(packagePath, body);
  await put(revisionPath, { schema: 'echo.content-revision.v1', id: revisionId, runId, recoveryId: attemptId, status: 'adopted', basePath: attemptPath, adoptedPath: packagePath, adoptedSha256: sha256 });
  await put(attemptPath, { schema: 'echo.content-attempt.v1', id: attemptId, runId, status: 'saved', savedPath: packagePath, createdAt: '2026-10-11T08:33:28Z', plan });
  await put(taskPath, { schema: 'aifios.production-task.v1', taskId: 'task_original', runId, kind: 'content-package', status: 'blocked', error: { code: 'content_release_blocked' }, result: { contentPackage: { attemptId } }, steps: [{ id: 'content-package', operationId: 'op_original', startedAt: '2026-10-11T08:33:27Z', completedAt: '2026-10-11T08:34:27Z' }], operationJournal: { operations: [{ operation_id: 'op_original', expected: { source_paths: [plan] } }] } });
});
afterAll(() => rm(mock.root, { recursive: true, force: true }));

describe('current recovered content task projection', () => {
  it('recognizes the confirmed recovery receipt without changing any task or attempt', async () => {
    const before = await Promise.all([taskPath, attemptPath, revisionPath].map(p => readFile(`${mock.root}/${p}`, 'utf8')));
    expect(await recoveredContentTask(runId, packagePath, approval)).toEqual(expected);
    expect(await Promise.all([taskPath, attemptPath, revisionPath].map(p => readFile(`${mock.root}/${p}`, 'utf8')))).toEqual(before);
  });
  it.each([
    ['unconfirmed', { ...approval, approved: false }],
    ['different version', { ...approval, sha256: 'd'.repeat(64) }],
    ['different path', { ...approval, path: 'pipeline/package/older.md' }],
  ])('keeps the task unresolved for %s approval', async (_, value) => {
    expect(await recoveredContentTask(runId, packagePath, value)).toBeNull();
  });
  it.each([
    ['unfinished revision', revisionPath, { status: 'saved_draft' }],
    ['other run', revisionPath, { runId: 'other' }],
    ['changed revision', revisionPath, { adoptedSha256: 'd'.repeat(64) }],
    ['unsaved attempt', attemptPath, { status: 'failed' }],
    ['different task receipt', taskPath, { result: { contentPackage: { attemptId: `attempt_${'e'.repeat(32)}` } } }],
    ['active task', taskPath, { status: 'running' }],
  ])('rejects %s', async (_, path, changes) => {
    await patch(path, changes);
    expect(await recoveredContentTask(runId, packagePath, approval)).toBeNull();
  });
  it('recognizes a uniquely bounded legacy failure with the exact plan', async () => {
    await patch(taskPath, { result: { contentPackage: {} } });
    expect(await recoveredContentTask(runId, packagePath, approval)).toEqual(expected);
    await patch(attemptPath, { plan: { ...plan, sha256: 'f'.repeat(64) } });
    expect(await recoveredContentTask(runId, packagePath, approval)).toBeNull();
  });
  it('does not infer a legacy binding across competing tasks or attempts', async () => {
    await patch(taskPath, { result: { contentPackage: {} } });
    const task = JSON.parse(await readFile(`${mock.root}/${taskPath}`, 'utf8'));
    const otherTaskPath = `runs/${runId}/tasks/task_other.json`;
    await put(otherTaskPath, { ...task, taskId: 'task_other' });
    expect(await recoveredContentTask(runId, packagePath, approval)).toBeNull();
    await rm(`${mock.root}/${otherTaskPath}`);
    await put(`runs/${runId}/content-attempts/attempt_${'f'.repeat(32)}.json`, { id: `attempt_${'f'.repeat(32)}`, runId, createdAt: '2026-10-11T08:33:29Z' });
    expect(await recoveredContentTask(runId, packagePath, approval)).toBeNull();
  });
  it('does not follow a replaced revision symlink', async () => {
    const content = await readFile(`${mock.root}/${revisionPath}`, 'utf8');
    await put('outside.json', content);
    await rm(`${mock.root}/${revisionPath}`);
    await symlink(`${mock.root}/outside.json`, `${mock.root}/${revisionPath}`);
    expect(await recoveredContentTask(runId, packagePath, approval)).toBeNull();
  });
});

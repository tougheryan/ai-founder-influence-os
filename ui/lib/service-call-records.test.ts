import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: `/tmp/echo-service-calls-${process.pid}` }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', async (original) => ({ ...await original<typeof import('./project-root')>(), PROJECT_DIR: fixture.root, projectPath: (...parts: string[]) => [fixture.root, ...parts].join('/') }));
import { recordRunModelCall, readServiceCalls, readServiceCallsWithLimit, saveModelCallLimit } from './service-call-records';
import { emptyLLMUsage } from './llm-usage';
import { GET, POST } from '@/app/api/production/service-calls/route';
import { createLLMTextCompletion, createLLMTextStream } from './llm-client';
const request = { provider: 'openai', model: 'test-model', transport: 'completion' as const };
const dir = () => join(fixture.root, 'runs/run-a/service-calls');
const get = (runId: string) => GET(new NextRequest(`http://localhost/api/production/service-calls?${new URLSearchParams({ runId })}`));
beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
  await mkdir(join(fixture.root, 'runs'), { recursive: true });
  for (const runId of ['run-a', 'run-b']) await writeFile(join(fixture.root, `runs/${runId}.json`), JSON.stringify({ run_id: runId, slug: runId }));
});
afterAll(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe('model request caps before dispatch', () => {
  const post = (body: unknown) => POST(new NextRequest('http://localhost/api/production/service-calls', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

  it('distinguishes an unconfigured cap from zero, persists it, and rejects stale window writes', async () => {
    expect((await readServiceCallsWithLimit('run-a')).limit).toEqual({ maxCalls: null, revision: 0, recordedCalls: 0, remaining: null });
    expect(await readdir(join(fixture.root, 'runs'))).not.toContain('run-a');
    const saved = await post({ action: 'set-limit', runId: 'run-a', maxCalls: 0, expectedRevision: 0 });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('Cache-Control')).toBe('no-store');
    const getLimit = await GET(new NextRequest('http://localhost/api/production/service-calls?runId=run-a&includeLimit=1'));
    expect(await getLimit.json()).toMatchObject({ records: [], limit: { maxCalls: 0, remaining: 0, revision: 1 } });
    const conflict = await post({ action: 'set-limit', runId: 'run-a', maxCalls: null, expectedRevision: 0 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'model_call_limit_conflict' });
    expect((await readServiceCallsWithLimit('run-a')).limit?.maxCalls).toBe(0);
    expect((await readServiceCallsWithLimit('run-b')).limit?.maxCalls).toBeNull();
    await saveModelCallLimit('run-a', null, 1);
    expect((await readServiceCallsWithLimit('run-a')).limit).toMatchObject({ maxCalls: null, remaining: null, revision: 2 });
  });

  it.each([-1, 1.5, 10001, '2', undefined, {}, true])('rejects an invalid cap without replacing the existing pause: %s', async (maxCalls) => {
    await saveModelCallLimit('run-a', 0, 0);
    expect((await post({ action: 'set-limit', runId: 'run-a', maxCalls, expectedRevision: 1 })).status).toBe(400);
    expect((await readServiceCallsWithLimit('run-a')).limit?.maxCalls).toBe(0);
  });

  it('counts failures and unfinished calls, never resets history, and isolates runs', async () => {
    const failed = await recordRunModelCall('run-a', 'content-package')(request);
    await failed.finish('failed', emptyLLMUsage());
    await recordRunModelCall('run-a', 'content-package')(request);
    expect(await saveModelCallLimit('run-a', 1, 0)).toMatchObject({ recordedCalls: 2, remaining: 0 });
    await expect(recordRunModelCall('run-a', 'content-revision')(request)).rejects.toThrow('调用上限');
    const raised = await saveModelCallLimit('run-a', 3, 1);
    expect(raised).toMatchObject({ recordedCalls: 2, remaining: 1 });
    await recordRunModelCall('run-a', 'content-revision')(request);
    await expect(recordRunModelCall('run-a', 'content-package')(request)).rejects.toThrow('调用上限');
    await recordRunModelCall('run-b', 'content-package')(request);
    expect((await readServiceCalls('run-a')).records).toHaveLength(3);
    expect((await readServiceCalls('run-b')).records).toHaveLength(1);
  });

  it('counts an abandoned request after its owner exits instead of refunding an unknown attempt', async () => {
    await recordRunModelCall('run-a', 'content-package')(request);
    const pathname = join(dir(), (await readdir(dir()))[0]);
    const stored = JSON.parse(await readFile(pathname, 'utf8'));
    await writeFile(pathname, JSON.stringify({ ...stored, ownerPid: 2147483647 }));
    await saveModelCallLimit('run-a', 1, 0);
    expect((await readServiceCallsWithLimit('run-a')).records[0].status).toBe('interrupted');
    await expect(recordRunModelCall('run-a', 'content-package')(request)).rejects.toThrow('调用上限');
  });

  it('blocks both SDK completion and stream before an HTTP request, including a malformed saved limit', async () => {
    let requests = 0;
    const server = createServer((_req, res) => { requests += 1; res.writeHead(500); res.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const config = { ...request, apiKey: 'local-test-only', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
      const options = { recordRequest: recordRunModelCall('run-a', 'content-package') };
      await saveModelCallLimit('run-a', 0, 0);
      await expect(createLLMTextCompletion(config, [{ role: 'user', content: 'fixture' }], options)).rejects.toThrow('调用上限');
      await expect((async () => {
        for await (const chunk of await createLLMTextStream(config, [{ role: 'user', content: 'fixture' }], options)) void chunk;
      })()).rejects.toThrow('调用上限');
      await writeFile(join(fixture.root, 'runs/run-a/service-call-limit.json'), '{incomplete');
      await expect(createLLMTextCompletion(config, [{ role: 'user', content: 'fixture' }], options)).rejects.toThrow('调用限制无法核对');
      expect(requests).toBe(0);
      expect((await readServiceCalls('run-a')).records).toHaveLength(0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it('reserves the last allowed call atomically while concurrent completions attempt real SDK dispatch', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'local-response', choices: [{ message: { role: 'assistant', content: '本地响应' }, finish_reason: 'stop', index: 0 }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await saveModelCallLimit('run-a', 1, 0);
      const config = { ...request, apiKey: 'local-test-only', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => createLLMTextCompletion(config, [{ role: 'user', content: 'fixture' }], { recordRequest: recordRunModelCall('run-a', 'content-package') })));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.message)).toEqual(Array(3).fill(expect.stringContaining('调用上限')));
      expect(requests).toBe(1);
      expect((await readServiceCallsWithLimit('run-a')).limit).toMatchObject({ recordedCalls: 1, remaining: 0 });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it('refuses linked or foreign limit files and rejects unsupported operations and run bindings', async () => {
    await saveModelCallLimit('run-a', 0, 0);
    const pathname = join(fixture.root, 'runs/run-a/service-call-limit.json');
    const external = join(fixture.root, 'external-limit.json');
    await rename(pathname, external); await symlink(external, pathname);
    await expect(recordRunModelCall('run-a', 'content-package')(request)).rejects.toThrow('调用限制无法核对');
    await rm(pathname); await rename(external, pathname);
    const stored = JSON.parse(await readFile(pathname, 'utf8'));
    await writeFile(pathname, JSON.stringify({ ...stored, runId: 'run-b' }));
    await expect(saveModelCallLimit('run-a', null, 1)).rejects.toThrow('调用限制无法核对');
    for (const body of [{ action: 'delete', runId: 'run-a' }, { action: 'set-limit', runId: '../run-a', maxCalls: 0, expectedRevision: 0 }, { action: 'set-limit', runId: 'missing', maxCalls: 0, expectedRevision: 0 }]) {
      expect((await post(body)).status).toBe(400);
    }
  });
});

describe('durable, scoped model call history', () => {
  it('persists usage through the real SDK and local HTTP stream, with exactly one outbound request', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        { id: 'fixture', choices: [{ index: 0, delta: { content: '本地测试响应' }, finish_reason: 'stop' }] },
        { id: 'fixture', choices: [], usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 } },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const stream = await createLLMTextStream({ ...request, apiKey: 'local-test-only', baseUrl: `http://127.0.0.1:${port}/v1` }, [{ role: 'user', content: 'private fixture material' }], { recordRequest: recordRunModelCall('run-a', 'content-package') });
      const output = []; for await (const chunk of stream) output.push(chunk);
      expect(output).toEqual(['本地测试响应']); expect(requests).toBe(1);
      const payload = await (await get('run-a')).json();
      expect(payload.records).toHaveLength(1);
      expect(payload.records[0]).toMatchObject({ status: 'completed', usage: { inputTokens: 23, outputTokens: 7, totalTokens: 30 } });
      const stored = await readFile(join(dir(), (await readdir(dir()))[0]), 'utf8');
      expect(stored).not.toMatch(/local-test-only|private fixture material|本地测试响应|127\.0\.0\.1/);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it('disables actual SDK retries on a rate-limited HTTP response', async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1; res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'simulated rate limit' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await expect(createLLMTextCompletion({ ...request, apiKey: 'local-test-only', baseUrl: `http://127.0.0.1:${port}/v1` }, [{ role: 'user', content: 'fixture' }], { recordRequest: recordRunModelCall('run-a', 'content-revision') })).rejects.toThrow('429');
      expect(requests).toBe(1);
      expect((await readServiceCalls('run-a')).records[0]).toMatchObject({ status: 'failed', usage: emptyLLMUsage() });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it('reading an unused run does not create records or a directory, nor borrow another run', async () => {
    const call = await recordRunModelCall('run-a', 'content-package')(request);
    await call.finish('completed', emptyLLMUsage());
    expect(await readServiceCalls('run-b')).toEqual({ runId: 'run-b', records: [] });
    expect((await get('run-b')).headers.get('Cache-Control')).toBe('no-store');
    expect(await readdir(join(fixture.root, 'runs'))).not.toContain('run-b');
    expect((await get('')).status).toBe(400);
    expect((await get('../run-a')).status).toBe(400);
    expect((await get('missing')).status).toBe(400);
  });
  it('saves a request before completion and exposes only recorded fields, never process or arbitrary data', async () => {
    const call = await recordRunModelCall('run-a', 'content-package')(request);
    expect((await readServiceCalls('run-a')).records[0]).toMatchObject({ status: 'started', usage: emptyLLMUsage(), completedAt: null });
    await call.finish('completed', { ...emptyLLMUsage(), inputTokens: 11, outputTokens: 0 });
    const name = (await readdir(dir()))[0]; const path = join(dir(), name);
    const stored = JSON.parse(await readFile(path, 'utf8')); stored.untrustedExtra = 'private-text';
    await writeFile(path, JSON.stringify(stored));
    const before = await readFile(path, 'utf8');
    const payload = await (await get('run-a')).json();
    expect(payload.records[0]).toMatchObject({ status: 'completed', usage: { inputTokens: 11, outputTokens: 0, totalTokens: null } });
    expect(JSON.stringify(payload)).not.toMatch(/ownerPid|private-text|schema/);
    await get('run-a'); expect(await readFile(path, 'utf8')).toBe(before);
    await call.finish('failed', emptyLLMUsage());
    expect((await readServiceCalls('run-a')).records[0].status).toBe('completed');
  });
  it('keeps separate records for repeated operations and preserves failures and unknown usage', async () => {
    const first = await recordRunModelCall('run-a', 'content-package')(request); await first.finish('failed', emptyLLMUsage());
    const firstId = (await readServiceCalls('run-a')).records[0].id;
    const unrelated = await recordRunModelCall('run-a', 'content-blueprint')(request); await unrelated.finish('completed', emptyLLMUsage());
    const repeat = await recordRunModelCall('run-a', 'content-package')(request); await repeat.finish('completed', emptyLLMUsage());
    const records = (await readServiceCalls('run-a')).records;
    expect(records).toHaveLength(3);
    expect(records.find((item) => item.previousCallId === firstId)).toMatchObject({ operation: 'content-package', status: 'completed' });
    expect(records.find((item) => item.id === firstId)).toMatchObject({ status: 'failed', usage: emptyLLMUsage() });
  });
  it('reports an abandoned owner as unconfirmed and never rewrites or retries on read', async () => {
    await recordRunModelCall('run-a', 'content-package')(request);
    const path = join(dir(), (await readdir(dir()))[0]);
    const stored = JSON.parse(await readFile(path, 'utf8')); stored.ownerPid = 2147483647;
    await writeFile(path, JSON.stringify(stored)); const before = await readFile(path, 'utf8');
    expect((await readServiceCalls('run-a')).records[0]).toMatchObject({ status: 'interrupted', completedAt: null });
    expect(await readFile(path, 'utf8')).toBe(before);
  });
  it('does not leave a live-looking request when completion persistence fails', async () => {
    const call = await recordRunModelCall('run-a', 'content-package')(request);
    const held = `${dir()}-held`; await rename(dir(), held); await symlink(held, dir());
    await expect(call.finish('completed', emptyLLMUsage())).rejects.toThrow('regular directory');
    await rm(dir()); await rename(held, dir());
    expect((await readServiceCalls('run-a')).records[0].status).toBe('interrupted');
  });
  it('refuses linked records and directories', async () => {
    const call = await recordRunModelCall('run-a', 'content-package')(request); await call.finish('completed', emptyLLMUsage());
    const path = join(dir(), (await readdir(dir()))[0]); const external = join(fixture.root, 'outside.json');
    await rename(path, external); await symlink(external, path);
    await expect(readServiceCalls('run-a')).rejects.toThrow('Invalid call record file');
    await rm(path); await rename(external, path);
    const held = `${dir()}-held`; await rename(dir(), held); await symlink(held, dir());
    await expect(recordRunModelCall('run-a', 'content-package')(request)).rejects.toThrow('regular directory');
  });
  it('refuses a foreign run binding or malformed usage instead of showing an empty or free history', async () => {
    const call = await recordRunModelCall('run-a', 'content-package')(request); await call.finish('completed', emptyLLMUsage());
    const path = join(dir(), (await readdir(dir()))[0]); const record = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...record, runId: 'run-b' }));
    await expect(readServiceCalls('run-a')).rejects.toThrow('Invalid call record');
    await writeFile(path, JSON.stringify({ ...record, usage: { ...record.usage, inputTokens: '10' } }));
    await expect(readServiceCalls('run-a')).rejects.toThrow('Invalid call record');
  });
});

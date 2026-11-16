import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ root: `/tmp/echo-layout-records-${process.pid}` }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', async (original) => ({ ...await original<typeof import('./project-root')>(), PROJECT_DIR: fixture.root, projectPath: (...parts: string[]) => [fixture.root, ...parts].join('/') }));
import { readLayoutCalls, startThemePreviewCall } from './layout-call-records';
import { readMd2WechatThemePreview } from './md2wechat-themes';
import { readServiceCallsWithLimit, saveModelCallLimit } from './service-call-records';
import { GET } from '@/app/api/layout-calls/route';
const dir = () => join(fixture.root, 'sessions/layout-service-calls');
const get = (query = '') => GET(new NextRequest(`http://localhost/api/layout-calls${query}`));
const exec = promisify(execFile);
beforeEach(async () => {
  vi.unstubAllEnvs();
  await rm(fixture.root, { recursive: true, force: true });
  await mkdir(join(fixture.root, 'runs'), { recursive: true });
  for (const runId of ['run-a', 'run-b']) await writeFile(join(fixture.root, `runs/${runId}.json`), JSON.stringify({ run_id: runId, slug: `content-${runId}` }));
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(fixture.root, { recursive: true, force: true }); });

async function fakeCLI() {
  const binary = join(fixture.root, 'renderer.cjs');
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('fs');const path=require('path');const args=process.argv.slice(2);
if(args[0]==='themes'){process.stdout.write(JSON.stringify({data:{themes:[{name:'minimal-blue',type:'api',selectable:true}]}}));process.exit(0);}
const root=path.dirname(__filename);fs.appendFileSync(path.join(root,'dispatches'),args[0]+'\\n');
if(fs.existsSync(path.join(root,'fail'))){process.stderr.write('private-article secret-key raw-provider-error');process.exit(1);}
fs.writeFileSync(args[args.indexOf('--output')+1],'<section>Offline fixture only</section>');
`, { mode: 0o700 });
  vi.stubEnv('MD2WECHAT_BINARY', binary);
  return binary;
}

describe('layout dispatch history', () => {
  it('records real local CLI preview success and failure without body, errors or invented fee', async () => {
    await fakeCLI();
    const preview = await readMd2WechatThemePreview('minimal-blue');
    expect(preview.html).toContain('Offline fixture only');
    await writeFile(join(fixture.root, 'fail'), '');
    await expect(readMd2WechatThemePreview('minimal-blue')).rejects.toThrow('暂时无法');
    const history = await readLayoutCalls();
    expect(history.records.map((record) => record.status).sort()).toEqual(['completed', 'failed']);
    expect(new Set(history.records.map((record) => record.id)).size).toBe(2);
    expect(history.records.every((record) => record.runSlug === null && record.completedAt)).toBe(true);
    expect((await readLayoutCalls('run-a')).records).toEqual([]);
    const response = await get();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const serialized = JSON.stringify(await response.json());
    for (const secret of ['private-article', 'secret-key', 'raw-provider-error', 'ownerPid', 'amount', fixture.root]) expect(serialized).not.toContain(secret);
    expect(await readFile(join(fixture.root, 'dispatches'), 'utf8')).toBe('preview\npreview\n');
  });

  it('reads Python article attempts in the correct run without changing the model cap', async () => {
    const binary = await fakeCLI();
    await saveModelCallLimit('run-a', 0, 0);
    const script = `import sys\nfrom pathlib import Path\nsys.path.insert(0, sys.argv[1])\nfrom visual_publish import _render_md2wechat_html\np=Path(sys.argv[2])\n_render_md2wechat_html(p/'article.html','private-article','secret-body','minimal-blue',project=p,task={'slug':'content-run-a','revision_id':'r002','parent_revision_id':'r001'})`;
    await exec('python3', ['-c', script, resolve('../skills/content-runtime/scripts'), fixture.root], { env: { ...process.env, MD2WECHAT_BINARY: binary } });
    const history = await readLayoutCalls('run-a');
    expect(history.records).toHaveLength(1);
    expect(history.records[0]).toMatchObject({ operation: 'article-restyle', runSlug: 'content-run-a', revisionId: 'r002', status: 'completed' });
    expect((await readLayoutCalls('run-b')).records).toEqual([]);
    expect((await readServiceCallsWithLimit('run-a')).limit).toMatchObject({ maxCalls: 0, recordedCalls: 0, remaining: 0 });
    expect(await readFile(join(dir(), `${history.records[0].id}.json`), 'utf8')).not.toContain('secret-body');
  });

  it('blocks dispatch if the new record cannot be saved', async () => {
    await fakeCLI();
    await mkdir(join(fixture.root, 'sessions'));
    await writeFile(dir(), 'not a directory');
    await expect(readMd2WechatThemePreview('minimal-blue')).rejects.toThrow('本次未请求排版服务');
    await expect(readFile(join(fixture.root, 'dispatches'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never treats unknown run, corrupt data, or a symbolic link as an empty history', async () => {
    expect((await get('?runId=missing')).status).toBe(400);
    expect((await get('?runId=')).status).toBe(400);
    expect((await get('?runId=../run-a')).status).toBe(400);
    await startThemePreviewCall('minimal-blue');
    const filename = join(dir(), (await readdir(dir()))[0]);
    await writeFile(filename, '{broken');
    const damaged = await get();
    expect(damaged.status).toBe(500);
    expect(await damaged.json()).not.toHaveProperty('records');
    await rm(filename);
    const outside = join(fixture.root, 'outside.json');
    await writeFile(outside, '{}');
    await symlink(outside, filename);
    expect((await get()).status).toBe(500);
  });

  it('preserves an unfinished record if result persistence fails, without claiming zero cost', async () => {
    const call = await startThemePreviewCall('minimal-blue');
    const filename = join(dir(), (await readdir(dir()))[0]);
    const stored = JSON.parse(await readFile(filename, 'utf8'));
    // Keep the start record, but make only the final replacement impossible.
    await rm(filename);
    await mkdir(filename);
    await expect(call.finish('completed')).rejects.toThrow('结束记录未能保存');
    await rm(filename, { recursive: true });
    await writeFile(filename, JSON.stringify(stored));
    expect((await readLayoutCalls()).records[0].status).toBe('interrupted');
  });

  it('marks an exited owner as unconfirmed and strips unknown stored fields', async () => {
    await startThemePreviewCall('minimal-blue');
    const filename = join(dir(), (await readdir(dir()))[0]);
    const stored = JSON.parse(await readFile(filename, 'utf8'));
    await writeFile(filename, JSON.stringify({ ...stored, ownerPid: 2147483647, secret: 'must not leak' }));
    const record = (await readLayoutCalls()).records[0];
    expect(record.status).toBe('interrupted');
    expect(record.completedAt).toBeNull();
    expect(record).not.toHaveProperty('secret');
  });
});

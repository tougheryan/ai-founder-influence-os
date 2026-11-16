import { createHash } from 'crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: '',
  registered: [] as Array<{ scope: string; path: string; runId?: string }>,
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({
  get PROJECT_DIR() { return mocks.projectDir; },
  redactLocalPaths: <T>(value: T) => value,
  runtimeJoin: (...parts: string[]) => path.join(...parts),
  safeResolve: (base: string, target: string) => {
    const resolved = path.resolve(base, target);
    return resolved === path.resolve(base) || resolved.startsWith(`${path.resolve(base)}${path.sep}`) ? resolved : null;
  },
}));
vi.mock('@/lib/runtime-run-resolver', () => ({
  runsForPipelinePath: async (sourcePath: string) => [{
    run_id: 'visual-run',
    slug: 'demo',
    steps: { package: { latest: sourcePath } },
  }],
}));
vi.mock('@/lib/runtime-writer', () => ({
  registerRuntimePhaseArtifact: async (scope: string, file: string, runId?: string) => {
    mocks.registered.push({ scope, path: file, runId });
    return { registered: true };
  },
}));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
}));

import { POST } from './route';

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(
  revisionId: string,
  assets: Array<{ id: string; platform: string }>,
  options: { revisionQuality?: 'pass' | 'review_required'; outputQuality?: 'pass' | 'review_required' } = {},
) {
  const recipeDir = path.join(mocks.projectDir, 'pipeline/visual/demo/recipes');
  const indexDir = path.join(mocks.projectDir, 'pipeline/visual/demo/revisions');
  const outputDir = path.join(mocks.projectDir, `pipeline/visual/demo/publish/${revisionId}`);
  await Promise.all([mkdir(recipeDir, { recursive: true }), mkdir(indexDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  const outputs = await Promise.all(assets.map(async (asset) => {
    const relative = `pipeline/visual/demo/publish/${revisionId}/${asset.id}.png`;
    const absolute = path.join(mocks.projectDir, relative);
    const content = `${revisionId}:${asset.id}`;
    await writeFile(absolute, content);
    return {
      id: asset.id,
      output: relative,
      sha256: digest(content),
      revision_id: revisionId,
      status: 'generated',
      quality: options.outputQuality || 'pass',
    };
  }));
  await writeFile(path.join(recipeDir, `${revisionId}.visual-recipe.json`), JSON.stringify({
    revision_id: revisionId,
    slug: 'demo',
    source_package: 'pipeline/package/demo-package.md',
    assets,
  }));
  await writeFile(path.join(indexDir, `${revisionId}.index.json`), JSON.stringify({
    schema: 'aifios.visual-publish.v1',
    revision_id: revisionId,
    slug: 'demo',
    status: 'generated',
    legacy: false,
    aesthetic_status: 'pass',
    quality_summary: { status: options.revisionQuality || 'pass', errors: [] },
    outputs,
  }));
}

function request(revisionId: string, assetId: string | string[]) {
  return new NextRequest('http://localhost/api/visual/adopt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Array.isArray(assetId)
      ? { slug: 'demo', revisionId, assetIds: assetId }
      : { slug: 'demo', revisionId, assetId }),
  });
}

describe('POST /api/visual/adopt', () => {
  beforeEach(async () => {
    mocks.projectDir = await mkdtemp(path.join(tmpdir(), 'aifios-visual-adopt-'));
    mocks.registered = [];
    await mkdir(path.join(mocks.projectDir, 'pipeline/package'), { recursive: true });
    await writeFile(path.join(mocks.projectDir, 'pipeline/package/demo-package.md'), '# 内容包');
    await fixture('r001', [
      { id: 'wechat-cover', platform: 'wechat' },
      { id: 'wechat-share', platform: 'wechat' },
      { id: 'inline-argument-1', platform: 'wechat' },
      { id: 'xhs-01-p1', platform: 'xhs' },
      { id: 'video-01-cover', platform: 'video' },
    ]);
    await fixture('r002', [{ id: 'xhs-01-p1', platform: 'xhs' }]);
    await writeFile(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'), JSON.stringify({ revision_id: 'r001' }));
  });

  afterEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('re-registers unchanged selected artwork and rejects a stale window, changed source or altered image', async () => {
    await fixture('r003', [{ id: 'xhs-01-p1', platform: 'xhs' }]);
    await writeFile(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'), JSON.stringify({ revision_id: 'r003' }));
    expect((await POST(request('r003', ['xhs-01-p1']))).status).toBe(200);
    const selectedPath = path.join(mocks.projectDir, 'pipeline/visual/demo/selected-assets.json');
    const before = await readFile(selectedPath, 'utf8');
    const selection = JSON.parse(before);
    const recheck = () => new NextRequest('http://localhost/api/visual/adopt', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'demo', revisionId: 'r003', assetIds: ['xhs-01-p1'], reconfirmSelection: {
        selectionSha256: digest(before), sourceContentHash: selection.sourceContentHash,
      } }) });
    mocks.registered = [];
    expect((await POST(recheck())).status).toBe(200);
    expect(mocks.registered).toHaveLength(1);
    // Make the competing selection distinct even with a same-millisecond clock.
    await writeFile(selectedPath, `${await readFile(selectedPath, 'utf8')}\n`);
    expect((await POST(recheck())).status).toBe(409);
    await writeFile(selectedPath, before);
    await writeFile(path.join(mocks.projectDir, 'pipeline/package/demo-package.md'), '# Changed');
    expect((await POST(recheck())).status).toBe(409);
    await writeFile(path.join(mocks.projectDir, 'pipeline/package/demo-package.md'), '# 内容包');
    await writeFile(path.join(mocks.projectDir, 'pipeline/visual/demo/publish/r003/xhs-01-p1.png'), 'changed image');
    expect((await POST(recheck())).status).toBe(409);
    expect(await readFile(selectedPath, 'utf8')).toBe(before);
    expect(mocks.registered).toHaveLength(1);
  });

  it('adopts assets one by one and preserves accepted assets when a card is regenerated', async () => {
    expect((await POST(request('r001', 'wechat-cover'))).status).toBe(200);
    expect((await POST(request('r001', 'inline-argument-1'))).status).toBe(200);
    const response = await POST(request('r002', 'xhs-01-p1'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.manifest.selections.wechat_cover.revisionId).toBe('r001');
    expect(payload.manifest.selections.wechat_share).toBeUndefined();
    expect(payload.manifest.selections['inline-argument-1'].revisionId).toBe('r001');
    expect(payload.manifest.selections['xhs-01-p1'].revisionId).toBe('r002');
    expect(payload.ready).toEqual({ valid: false, missingRoles: ['wechat_share'] });

    const shareResponse = await POST(request('r001', 'wechat-share'));
    const sharePayload = await shareResponse.json();
    expect(shareResponse.status).toBe(200);
    expect(sharePayload.manifest.selections.wechat_share.revisionId).toBe('r001');
    expect(sharePayload.ready).toEqual({ valid: true, missingRoles: [] });
    expect(mocks.registered.at(-1)).toEqual({
      scope: 'visual_assets',
      path: 'pipeline/visual/demo/selected-assets.json',
      runId: 'visual-run',
    });
    const saved = JSON.parse(await readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-assets.json'), 'utf-8'));
    expect(saved.selections['xhs-01-p1'].revisionId).toBe('r002');
  });

  it('rejects a candidate that is not in a verified recipe revision', async () => {
    const response = await POST(request('r002', 'wechat-cover'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('adopts a suite in one request and binds XHS pages only to Xiaohongshu by default', async () => {
    const response = await POST(request('r001', ['wechat-cover', 'wechat-share', 'inline-argument-1', 'xhs-01-p1']));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ready).toEqual({ valid: true, missingRoles: [] });
    expect(payload.manifest.selections['xhs-01-p1'].platformBindings).toEqual(['xiaohongshu']);
  });

  it('rejects a revision or asset that has not passed its audited quality gate', async () => {
    const revisionPath = path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r002.index.json');
    const revision = JSON.parse(await readFile(revisionPath, 'utf-8'));
    revision.quality_summary.status = 'review_required';
    await writeFile(revisionPath, JSON.stringify(revision));

    const revisionResponse = await POST(request('r002', 'xhs-01-p1'));
    expect(revisionResponse.status).toBe(400);
    expect(await revisionResponse.json()).toMatchObject({ code: 'invalid_request' });

    revision.quality_summary.status = 'pass';
    revision.outputs[0].quality = 'review_required';
    await writeFile(revisionPath, JSON.stringify(revision));

    const assetResponse = await POST(request('r002', 'xhs-01-p1'));
    expect(assetResponse.status).toBe(400);
    expect(await assetResponse.json()).toMatchObject({ code: 'invalid_request' });
  });
});

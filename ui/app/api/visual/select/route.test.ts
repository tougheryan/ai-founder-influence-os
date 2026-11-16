import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-visual-select-${process.pid}`,
  state: null as Record<string, unknown> | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => {
    await mkdir(mocks.projectDir, { recursive: true });
  },
}));
vi.mock('@/lib/project-root', async () => {
  const pathModule = await import('node:path');
  return {
    PROJECT_DIR: mocks.projectDir,
    redactLocalPaths: <T>(value: T) => value,
    runtimeJoin: (...parts: string[]) => pathModule.join(...parts),
    safeResolve: (base: string, relative: string) => {
      const resolved = pathModule.resolve(base, relative);
      return resolved === pathModule.resolve(base) || resolved.startsWith(`${pathModule.resolve(base)}${pathModule.sep}`)
        ? resolved
        : null;
    },
    skillPath: (...parts: string[]) => pathModule.resolve(process.cwd(), '..', 'skills', ...parts),
  };
});
vi.mock('@/lib/visual-workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/visual-workbench')>();
  return {
    ...actual,
    loadVisualWorkbenchState: async () => mocks.state,
  };
});
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
}));

import { POST } from './route';

const recipePath = 'pipeline/visual/demo/recipes/r001.visual-recipe.json';
const indexPath = 'pipeline/visual/demo/revisions/r001.index.json';
const outputPath = 'pipeline/visual/demo/publish/r001/wechat/article.html';
const externalOutputPath = `/tmp/aifios-visual-select-external-${process.pid}.html`;
const externalSelectionPath = `/tmp/aifios-visual-select-selection-${process.pid}.json`;

type MutableIndex = {
  schema?: string;
  revision_index_path?: string;
  platform_delivery_manifest?: string;
  outputs: Array<Record<string, unknown>>;
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeJson(relative: string, value: unknown) {
  const absolute = path.join(mocks.projectDir, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(value), 'utf-8');
}

async function seedRevision() {
  const outputBytes = Buffer.from('<h1>测试文章</h1><p>保留句号。</p>', 'utf-8');
  const packagePath = 'pipeline/package/demo-package.md';
  await mkdir(path.dirname(path.join(mocks.projectDir, packagePath)), { recursive: true });
  await writeFile(path.join(mocks.projectDir, packagePath), '# 平台原生成稿\n\n## 0. 共享事实底稿\n- 本期平台：公众号\n\n## 1. 公众号原生长文\n- 发布标题：测试文章\n- 摘要：测试\n\n### 正文\n保留句号。\n\n### 评论区承接\n- 置顶评论：你怎么看？\n');
  const absoluteOutput = path.join(mocks.projectDir, outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, outputBytes);
  const fidelity = JSON.parse(execFileSync('python3', ['-c',
    'import sys,json; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from visual_publish import _check_wechat_output; print(json.dumps(_check_wechat_output(Path(sys.argv[2]), {"source_package":sys.argv[3]}, {"output":sys.argv[4]})))',
    path.resolve(process.cwd(), '../skills/content-runtime/scripts'), mocks.projectDir, packagePath, outputPath,
  ], { encoding: 'utf-8' }));
  await writeJson(recipePath, {
    schema: 'aifios.visual-recipe.v1',
    slug: 'demo',
    revision_id: 'r001',
    source_package: 'pipeline/package/demo-package.md',
    content_archetype: 'analysis',
    evidence_mode: 'hybrid',
    platforms: {
      wechat: { system: 'swiss' },
      xhs: { system: 'swiss', page_recipes: ['cover', 'context', 'evidence', 'insight', 'cta'] },
    },
    assets: [{
      id: 'wechat-html',
      platform: 'wechat',
      role: 'article',
      layout_recipe: 'wechat-article',
      renderer: 'local',
      status: 'planned',
    }],
    quality_policy: { min_density: 0.62, require_evidence_ratio: 0.4 },
  });
  await writeJson(indexPath, {
    schema: 'aifios.visual-publish.v1',
    slug: 'demo',
    revision_id: 'r001',
    recipe_path: recipePath,
    revision_index_path: indexPath,
    source_package: packagePath,
    status: 'generated',
    legacy: false,
    quality_summary: { status: 'pass', errors: [] },
    outputs: [{
      id: 'wechat-html',
      kind: 'wechat_html',
      format: 'HTML',
      wechat_fidelity: fidelity,
      revision_id: 'r001',
      renderer: 'local',
      recipe_path: recipePath,
      output: outputPath,
      status: 'generated',
      quality: 'pass',
      size: outputBytes.byteLength,
      sha256: sha256(outputBytes),
    }],
  });
  mocks.state = {
    slug: 'demo',
    selectedRevisionId: 'r001',
    revisions: [{ revisionId: 'r001', recipePath, indexPath, status: 'ready' }],
    assets: [],
    comparison: [],
  };
}

function request(payload: Record<string, unknown>) {
  return new Request('http://localhost/api/visual/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('POST /api/visual/select', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    await seedRevision();
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    await rm(externalOutputPath, { force: true });
    await rm(externalSelectionPath, { force: true });
  });

  it('adopts a fully revalidated local revision', async () => {
    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'selected', slug: 'demo', revisionId: 'r001' });
    const selected = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    ));
    const [recipeBytes, indexBytes, outputBytes] = await Promise.all([
      readFile(path.join(mocks.projectDir, recipePath)),
      readFile(path.join(mocks.projectDir, indexPath)),
      readFile(path.join(mocks.projectDir, outputPath)),
    ]);
    expect(selected).toEqual({
      schema: 'aifios.visual-selection.v1',
      slug: 'demo',
      revision_id: 'r001',
      integrity: {
        algorithm: 'sha256',
        files: [
          { role: 'recipe', path: recipePath, size: recipeBytes.length, sha256: sha256(recipeBytes) },
          { role: 'index', path: indexPath, size: indexBytes.length, sha256: sha256(indexBytes) },
          {
            role: 'output',
            id: 'wechat-html',
            path: outputPath,
            size: outputBytes.length,
            sha256: sha256(outputBytes),
          },
        ],
      },
    });
  });

  it('binds the platform visual delivery manifest to the selected revision', async () => {
    const deliveryPath = 'pipeline/visual/demo/publish/r001/platform-delivery.json';
    const delivery = {
      schema: 'aifios.platform-visual-delivery.v1',
      slug: 'demo',
      revision_id: 'r001',
      wechat: {},
      xiaohongshu: { posts: [] },
      video: { items: [] },
    };
    await writeJson(deliveryPath, delivery);
    const index = JSON.parse(await readFile(path.join(mocks.projectDir, indexPath), 'utf-8')) as MutableIndex;
    index.platform_delivery_manifest = deliveryPath;
    await writeJson(indexPath, index);

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(200);
    const selected = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    ));
    const deliveryBytes = await readFile(path.join(mocks.projectDir, deliveryPath));
    expect(selected.integrity.files).toContainEqual({
      role: 'platform_delivery',
      path: deliveryPath,
      size: deliveryBytes.length,
      sha256: sha256(deliveryBytes),
    });
  });

  it('rejects a symlinked output without writing a selection pointer', async () => {
    await writeFile(externalOutputPath, '<html>outside project</html>', 'utf-8');
    const absoluteOutput = path.join(mocks.projectDir, outputPath);
    await rm(absoluteOutput);
    await symlink(externalOutputPath, absoluteOutput);

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_revision_not_ready' });
    await expect(readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked selection pointer without overwriting its target', async () => {
    const sentinel = '{"outside":"must-not-change"}';
    await writeFile(externalSelectionPath, sentinel, 'utf-8');
    await symlink(
      externalSelectionPath,
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
    );

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_selection_integrity_failed' });
    expect(await readFile(externalSelectionPath, 'utf-8')).toBe(sentinel);
  });

  it('rejects a selection pointer path with a symlinked directory component', async () => {
    const visualRoot = path.join(mocks.projectDir, 'pipeline/visual');
    await rename(path.join(visualRoot, 'demo'), path.join(visualRoot, 'redirected-demo'));
    await symlink('redirected-demo', path.join(visualRoot, 'demo'));

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_revision_not_ready' });
    await expect(readFile(
      path.join(visualRoot, 'redirected-demo/selected-revision.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a schema-invalid recipe without writing a selection pointer', async () => {
    const recipe = JSON.parse(await readFile(path.join(mocks.projectDir, recipePath), 'utf-8'));
    delete recipe.source_package;
    await writeJson(recipePath, recipe);

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_selection_integrity_failed' });
    await expect(readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['schema', (index: MutableIndex) => { index.schema = 'aifios.visual-publish.v0'; }],
    ['revision index path', (index: MutableIndex) => { index.revision_index_path = 'pipeline/visual/demo/revisions/r999.index.json'; }],
    ['output status', (index: MutableIndex) => { index.outputs[0].status = 'blocked'; }],
    ['output revision', (index: MutableIndex) => { index.outputs[0].revision_id = 'r999'; }],
  ])('rejects an index with an invalid %s', async (_label, mutate) => {
    const index = JSON.parse(await readFile(path.join(mocks.projectDir, indexPath), 'utf-8'));
    mutate(index);
    await writeJson(indexPath, index);

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    await expect(readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['missing', (index: MutableIndex) => { delete index.outputs[0].id; }],
    ['empty', (index: MutableIndex) => { index.outputs[0].id = ''; }],
    ['unknown', (index: MutableIndex) => { index.outputs[0].id = 'orphan-output'; }],
    ['duplicate', (index: MutableIndex) => { index.outputs.push({ ...index.outputs[0] }); }],
  ])('rejects a %s output id', async (_label, mutate) => {
    const index = JSON.parse(await readFile(path.join(mocks.projectDir, indexPath), 'utf-8'));
    mutate(index);
    await writeJson(indexPath, index);

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    await expect(readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an index that does not cover every recipe asset id', async () => {
    const recipe = JSON.parse(await readFile(path.join(mocks.projectDir, recipePath), 'utf-8'));
    recipe.assets.push({ ...recipe.assets[0], id: 'wechat-cover', role: 'cover' });
    await writeJson(recipePath, recipe);

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_revision_not_ready' });
    await expect(readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects same-size output tampering before the first adoption', async () => {
    const absoluteOutput = path.join(mocks.projectDir, outputPath);
    const original = await readFile(absoluteOutput);
    const tampered = Buffer.from(original.toString('utf-8').replace('保留', '删改'), 'utf-8');
    expect(tampered.byteLength).toBe(original.byteLength);
    await writeFile(absoluteOutput, tampered);

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_revision_not_ready' });
    await expect(readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed article text even when output hashes and the cached pass are updated', async () => {
    const target = path.join(mocks.projectDir, outputPath);
    const changed = Buffer.from((await readFile(target, 'utf-8')).replace('句号。', '句号'));
    await writeFile(target, changed);
    const index = JSON.parse(await readFile(path.join(mocks.projectDir, indexPath), 'utf-8'));
    index.outputs[0].sha256 = sha256(changed);
    index.outputs[0].size = changed.length;
    await writeJson(indexPath, index);
    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_revision_not_ready' });
    await expect(readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates artifacts instead of trusting a ready workbench row', async () => {
    const index = JSON.parse(await readFile(path.join(mocks.projectDir, indexPath), 'utf-8'));
    index.outputs[0].renderer = 'fake';
    await writeJson(indexPath, index);

    const response = await POST(request({ slug: 'demo', revisionId: 'r001' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_revision_not_ready' });
    await expect(readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'),
      'utf-8',
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

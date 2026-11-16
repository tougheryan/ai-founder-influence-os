import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-visual-revise-${process.pid}`,
  execCalls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  consumerFailure: '' as string,
  consumerFailureAfterCommit: false,
  consumerFailureBeforeRequestCommit: false,
  malformedConsumerResult: false,
  fakeConsumerOutputs: false,
  concurrentPublishReplacement: false,
  consumerOutputPath: '' as string,
  state: null as Record<string, unknown> | null,
  idempotency: new Map<string, unknown>(),
  themeCatalog: vi.fn(),
  dropWechatLayout: false,
}));

vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(() => undefined, {
    [custom]: async (file: string, args: string[], options: Record<string, unknown>) => {
      mocks.execCalls.push({ file, args, options });
      if (mocks.consumerFailure) throw new Error(mocks.consumerFailure);
      const slug = args[args.indexOf('--slug') + 1];
      const requestId = args[args.indexOf('--request-id') + 1];
      const requestPath = path.join(mocks.projectDir, 'pipeline', 'visual', slug, 'revisions', `${requestId}.json`);
      if (mocks.malformedConsumerResult) {
        return { stdout: JSON.stringify({ status: 'rendered', revision_id: 'r002', index_path: '../escape.json' }), stderr: '' };
      }
      const record = JSON.parse(await readFile(requestPath, 'utf-8'));
      const reviewRequired = false;
      const baseRevisionId = String(record.base_revision_id);
      const recipeDirectory = path.join(mocks.projectDir, `pipeline/visual/${slug}/recipes`);
      let recipeNames: string[] = [];
      try { recipeNames = await readdir(recipeDirectory); } catch { /* created below */ }
      const highest = recipeNames.reduce((value, name) => Math.max(value, Number(name.match(/^r(\d+)\.visual-recipe\.json$/)?.[1] || 0)), 0);
      const revisionId = `r${String(highest + 1).padStart(3, '0')}`;
      const recipePath = `pipeline/visual/${slug}/recipes/${revisionId}.visual-recipe.json`;
      const indexPath = `pipeline/visual/${slug}/revisions/${revisionId}.index.json`;
      const baseRecipe = JSON.parse(await readFile(
        path.join(mocks.projectDir, `pipeline/visual/${slug}/recipes/${baseRevisionId}.visual-recipe.json`),
        'utf-8',
      ));
      await mkdir(path.join(mocks.projectDir, `pipeline/visual/${slug}/recipes`), { recursive: true });
      await writeFile(path.join(mocks.projectDir, recipePath), JSON.stringify({
        ...baseRecipe, revision_id: revisionId, parent_revision_id: baseRevisionId, slug,
        ...(record.wechat_layout && !mocks.dropWechatLayout ? { platforms: { ...baseRecipe.platforms, wechat: {
          ...baseRecipe.platforms.wechat, wechat_layout: record.wechat_layout,
        } } } : {}),
      }), 'utf-8');
      const outputs = [];
      for (const [position, asset] of (baseRecipe.assets as Array<{ id: string }>).entries()) {
        const outputPath = position === 0 && mocks.consumerOutputPath
          ? mocks.consumerOutputPath
          : position === 0
            ? `pipeline/visual/${slug}/publish/${revisionId}/wechat/article.html`
            : `pipeline/visual/${slug}/publish/${revisionId}/assets/${asset.id}.bin`;
        const bytes = Buffer.from(`rendered-${asset.id}`);
        await mkdir(path.dirname(path.join(mocks.projectDir, outputPath)), { recursive: true });
        await writeFile(path.join(mocks.projectDir, outputPath), bytes);
        outputs.push({
          id: asset.id,
          renderer: mocks.fakeConsumerOutputs ? 'fake' : 'local',
          recipe_path: recipePath,
          revision_id: revisionId,
          status: 'generated',
          output: outputPath,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          ...(reviewRequired && asset.id === 'inline-01' ? {
            ai_generated: true,
            ocr_status: 'review_required',
          } : {}),
        });
      }
      const index = {
        schema: 'aifios.visual-publish.v1', slug, revision_id: revisionId, recipe_path: recipePath,
        revision_index_path: indexPath, renderer: 'local', status: 'generated', legacy: false,
        quality_summary: reviewRequired
          ? { status: 'review_required', errors: [], review_issues: ['AI raster OCR review required'] }
          : { status: 'pass', errors: [] },
        ...(reviewRequired ? { aesthetic_status: 'review_required' } : {}),
        outputs, errors: [],
      };
      await writeFile(path.join(mocks.projectDir, indexPath), JSON.stringify(index), 'utf-8');
      if (mocks.concurrentPublishReplacement) {
        const publishIndex = path.join(mocks.projectDir, `pipeline/visual/${slug}/publish/index.json`);
        await writeFile(publishIndex, JSON.stringify({ slug, revision_id: 'r999', status: 'generated' }), 'utf-8');
      }
      if (mocks.consumerFailureBeforeRequestCommit) {
        await writeFile(
          path.join(mocks.projectDir, `pipeline/visual/${slug}/revisions/.${revisionId}.${requestId}.visual-recipe.pending.json`),
          JSON.stringify({ revision_id: revisionId }),
          'utf-8',
        );
        throw new Error('consumer timed out before request commit');
      }
      const terminalStatus = reviewRequired ? 'review_required' : 'rendered';
      await writeFile(requestPath, JSON.stringify({ ...record, status: terminalStatus, revision_id: revisionId, index_path: indexPath }), 'utf-8');
      if (mocks.consumerFailureAfterCommit) throw new Error('stdout transport failed after commit');
      return { stdout: JSON.stringify({ status: terminalStatus, revision_id: revisionId, index_path: indexPath, request_path: path.relative(mocks.projectDir, requestPath) }), stderr: '' };
    },
  });
  return { execFile };
});

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(mocks.projectDir, { recursive: true });
  },
}));

vi.mock('@/lib/project-root', async () => {
  const pathModule = await import('node:path');
  return {
    PROJECT_DIR: mocks.projectDir,
    redactLocalPaths: <T>(value: T) => value,
    runtimeJoin: (...parts: string[]) => pathModule.join(...parts),
    contentRuntimeToolPath: (name: string) => pathModule.join('/runtime/scripts', name),
    skillPath: (...parts: string[]) => pathModule.join(process.cwd(), '..', 'skills', ...parts),
    safeResolve: (base: string, relative: string) => {
      const resolved = pathModule.resolve(base, relative);
      return resolved === base || resolved.startsWith(`${pathModule.resolve(base)}${pathModule.sep}`) ? resolved : null;
    },
  };
});

vi.mock('@/lib/server-config', () => ({ resolveServerLLMConfig: async () => ({}) }));
vi.mock('@/lib/md2wechat-themes', () => ({ readMd2WechatThemeCatalog: mocks.themeCatalog }));
vi.mock('@/lib/llm-client', () => ({
  getApiKey: () => '',
  createLLMTextCompletion: async () => '{"operations":[]}',
}));
vi.mock('@/lib/visual-workbench', () => ({
  loadVisualWorkbenchState: async () => mocks.state,
}));

vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  readIdempotentResult: async (key: string) => mocks.idempotency.get(key) || null,
  rememberIdempotentResult: async (key: string, value: unknown) => { mocks.idempotency.set(key, value); },
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
  writeFingerprint: (kind: string, value: unknown) => `${kind}:${JSON.stringify(value)}`,
}));

import { POST } from './route';


function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}


async function writeDigestBoundSelection(slug: string, revisionId: string): Promise<void> {
  const recipePath = `pipeline/visual/${slug}/recipes/${revisionId}.visual-recipe.json`;
  const indexPath = `pipeline/visual/${slug}/revisions/${revisionId}.index.json`;
  const [recipeBytes, indexBytes] = await Promise.all([
    readFile(path.join(mocks.projectDir, recipePath)),
    readFile(path.join(mocks.projectDir, indexPath)),
  ]);
  const index = JSON.parse(indexBytes.toString('utf-8')) as {
    outputs: Array<{ id: string; output: string }>;
    platform_delivery_manifest?: string;
  };
  const outputFiles = await Promise.all(index.outputs.map(async (output) => {
    const bytes = await readFile(path.join(mocks.projectDir, output.output));
    return {
      role: 'output', id: output.id, path: output.output, size: bytes.length, sha256: sha256(bytes),
    };
  }));
  const platformDeliveryFile = index.platform_delivery_manifest
    ? await readFile(path.join(mocks.projectDir, index.platform_delivery_manifest))
    : null;
  await writeFile(
    path.join(mocks.projectDir, `pipeline/visual/${slug}/selected-revision.json`),
    JSON.stringify({
      schema: 'aifios.visual-selection.v1',
      slug,
      revision_id: revisionId,
      integrity: {
        algorithm: 'sha256',
        files: [
          { role: 'recipe', path: recipePath, size: recipeBytes.length, sha256: sha256(recipeBytes) },
          { role: 'index', path: indexPath, size: indexBytes.length, sha256: sha256(indexBytes) },
          ...outputFiles,
          ...(platformDeliveryFile && index.platform_delivery_manifest ? [{
            role: 'platform_delivery',
            path: index.platform_delivery_manifest,
            size: platformDeliveryFile.length,
            sha256: sha256(platformDeliveryFile),
          }] : []),
        ],
      },
    }),
    'utf-8',
  );
}


async function seedSelectedRecipe() {
  await mkdir(path.join(mocks.projectDir, 'pipeline/package'), { recursive: true });
  await writeFile(path.join(mocks.projectDir, 'pipeline/package/demo-package.md'), '# 原标题\n\n已确认的原稿。\n', 'utf-8');
  const recipePath = 'pipeline/visual/demo/recipes/r001.visual-recipe.json';
  const absolute = path.join(mocks.projectDir, recipePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const recipe = {
    schema: 'aifios.visual-recipe.v2',
    revision_id: 'r001',
    slug: 'demo',
    source_package: 'pipeline/package/demo-package.md',
    source_assets: ['materials/screenshots/first.png', 'materials/screenshots/second.png'],
    content_archetype: 'product_demo',
    evidence_mode: 'screenshot_first',
    visual_preferences: { mode: 'stable', direction_count: 2, provider_policy: 'auto' },
    art_directions: [
      { id: 'direction-a', label: '方向 A' },
      { id: 'direction-b', label: '方向 B' },
    ],
    selected_direction: 'direction-a',
    generation_policy: { text_renderer: 'html-playwright', provider_policy: 'auto', fallback_mode: 'stable' },
    platforms: {
      wechat: {
        system: 'swiss',
        layout_selection: {
          selected: 'wechat-native',
          candidates: ['wechat-native', 'minimal-green', 'ink-minimal'],
        },
      },
      xhs: { system: 'swiss', page_recipes: ['S01', 'S08', 'S06', 'S10', 'S12'] },
    },
    assets: [
      { id: 'wechat-html', platform: 'wechat', role: 'article', layout_recipe: 'html', layout_style: 'wechat-native', renderer: 'md2wechat', status: 'planned' },
      { id: 'xhs-01-p1', platform: 'xhs', role: 'cover', layout_recipe: 'S01', renderer: 'xhs-card', status: 'planned', copy: { headline: '短标题' } },
      { id: 'xhs-01-p2', platform: 'xhs', role: 'evidence', layout_recipe: 'S08', renderer: 'xhs-card', status: 'planned', source: 'materials/screenshots/first.png' },
      { id: 'xhs-01-p5', platform: 'xhs', role: 'cta', layout_recipe: 'S12', renderer: 'xhs-card', status: 'planned' },
    ],
    quality_policy: { min_density: 0.62, require_evidence_ratio: 0.4 },
  };
  await writeFile(absolute, JSON.stringify(recipe), 'utf-8');
  const indexPath = 'pipeline/visual/demo/revisions/r001.index.json';
  await mkdir(path.dirname(path.join(mocks.projectDir, indexPath)), { recursive: true });
  const outputSpecs = [
    ['wechat-html', 'wechat/article.html'],
    ['xhs-01-p1', 'xhs/p1.png'],
    ['xhs-01-p2', 'xhs/p2.png'],
    ['xhs-01-p5', 'xhs/p5.png'],
  ] as const;
  const outputs = [];
  for (const [id, relative] of outputSpecs) {
    const outputPath = `pipeline/visual/demo/publish/r001/${relative}`;
    const outputBytes = Buffer.from(`selected-${id}`);
    await mkdir(path.dirname(path.join(mocks.projectDir, outputPath)), { recursive: true });
    await writeFile(path.join(mocks.projectDir, outputPath), outputBytes);
    outputs.push({
      id,
      renderer: 'local',
      recipe_path: recipePath,
      revision_id: 'r001',
      status: 'generated',
      output: outputPath,
      size: outputBytes.length,
      sha256: sha256(outputBytes),
    });
  }
  const index = {
    schema: 'aifios.visual-publish.v1',
    slug: 'demo',
    revision_id: 'r001',
    recipe_path: recipePath,
    revision_index_path: indexPath,
    renderer: 'local',
    status: 'generated',
    legacy: false,
    quality_summary: { status: 'pass', errors: [] },
    outputs,
    errors: [],
  };
  await writeFile(path.join(mocks.projectDir, indexPath), JSON.stringify(index), 'utf-8');
  await writeFile(path.join(mocks.projectDir, 'pipeline/visual/demo/publish/index.json'), JSON.stringify(index), 'utf-8');
  await writeDigestBoundSelection('demo', 'r001');
  mocks.state = {
    slug: 'demo',
    selectedRevisionId: 'r001',
    revisions: [{ revisionId: 'r001', recipePath, indexPath, status: 'ready' }],
    assets: [],
  };
}


function request(payload: Record<string, unknown>) {
  return new Request('http://localhost/api/visual/revise', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}


async function requestFiles() {
  const directory = path.join(mocks.projectDir, 'pipeline', 'visual', 'demo', 'revisions');
  try {
    return (await readdir(directory)).filter((name) => name.includes('-request'));
  } catch {
    return [];
  }
}


describe('POST /api/visual/revise', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    process.env.AIFIOS_HOME = path.resolve(process.cwd(), '..');
    mocks.execCalls = [];
    mocks.consumerFailure = '';
    mocks.consumerFailureAfterCommit = false;
    mocks.consumerFailureBeforeRequestCommit = false;
    mocks.malformedConsumerResult = false;
    mocks.fakeConsumerOutputs = false;
    mocks.concurrentPublishReplacement = false;
    mocks.consumerOutputPath = '';
    mocks.dropWechatLayout = false;
    mocks.idempotency.clear();
    mocks.themeCatalog.mockReset();
    mocks.themeCatalog.mockResolvedValue({
      source: 'md2wechat', rendererAvailable: true,
      templates: [{ id: 'elegant-blue', source: 'md2wechat', themeType: 'api', enabled: true, selectable: true }],
    });
    await seedSelectedRecipe();
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('records the request before consuming it and returns a rendered revision', async () => {
    const response = await POST(request({
      slug: 'demo',
      request: '第二张改成真实截图',
      targetAssetIds: ['xhs-01-p2'],
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('rendered');
    expect(body.revisionId).toBe('r002');
    expect(body.indexPath).toBe('pipeline/visual/demo/revisions/r002.index.json');
    expect(body.requestPath).toBe('pipeline/visual/demo/revisions/r001-request.json');
    const record = JSON.parse(await readFile(path.join(mocks.projectDir, body.requestPath), 'utf-8'));
    const schema = JSON.parse(await readFile(
      path.join(process.env.AIFIOS_HOME!, 'skills', 'content-runtime', 'schemas', 'visual-revision-request.schema.json'),
      'utf-8',
    ));
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    expect(record).toMatchObject({
      base_revision_id: 'r001',
      operations: ['replace_evidence'],
      target_asset_ids: ['xhs-01-p2'],
      status: 'rendered',
      revision_id: 'r002',
      index_path: 'pipeline/visual/demo/revisions/r002.index.json',
    });
    expect(mocks.execCalls).toHaveLength(1);
    expect(mocks.execCalls[0]).toMatchObject({
      file: 'python3',
      args: [
        '/runtime/scripts/visual_revision.py',
        '--project', mocks.projectDir,
        'consume', '--slug', 'demo', '--request-id', 'r001-request',
      ],
      options: { cwd: mocks.projectDir },
    });
  });

  it('allows revision requests after adopting a revision with a platform delivery manifest', async () => {
    const indexPath = path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001.index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf-8')) as Record<string, unknown>;
    const manifestPath = 'pipeline/visual/demo/publish/r001/platform-delivery.json';
    await mkdir(path.dirname(path.join(mocks.projectDir, manifestPath)), { recursive: true });
    await writeFile(path.join(mocks.projectDir, manifestPath), JSON.stringify({
      schema: 'aifios.platform-visual-delivery.v1',
      slug: 'demo',
      revision_id: 'r001',
    }), 'utf-8');
    index.platform_delivery_manifest = manifestPath;
    await writeFile(indexPath, JSON.stringify(index), 'utf-8');
    await writeDigestBoundSelection('demo', 'r001');

    const response = await POST(request({
      slug: 'demo',
      request: '第二张改成真实截图',
      targetAssetIds: ['xhs-01-p2'],
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('rendered');
  });

  it('revises an explicit stable v2 workbench version without the legacy selection pointer', async () => {
    const indexPath = path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001.index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf-8')) as Record<string, unknown>;
    const manifestPath = 'pipeline/visual/demo/publish/r001/platform-delivery.json';
    await mkdir(path.dirname(path.join(mocks.projectDir, manifestPath)), { recursive: true });
    await writeFile(path.join(mocks.projectDir, manifestPath), JSON.stringify({
      schema: 'echo-founder.platform-visual-delivery.v2',
      slug: 'demo',
      revision_id: 'r001',
    }), 'utf-8');
    index.platform_delivery_manifest = manifestPath;
    await writeFile(indexPath, JSON.stringify(index), 'utf-8');
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'));

    const response = await POST(request({
      slug: 'demo',
      baseRevisionId: 'r001',
      request: '第二张改成真实截图',
      targetAssetIds: ['xhs-01-p2'],
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('rendered');
    expect(mocks.execCalls).toHaveLength(1);
  });

  it('accepts a stable WeChat HTML layout change for the explicit workbench version', async () => {
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'));

    const response = await POST(request({
      slug: 'demo',
      baseRevisionId: 'r001',
      request: '公众号排版换个样式',
      targetAssetIds: ['wechat-html'],
    }));

    expect(response.status).toBe(200);
    const record = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'),
      'utf-8',
    ));
    expect(record.operations).toEqual(['change_layout']);
    expect(mocks.execCalls).toHaveLength(1);
  });

  it('rejects client-controlled paths, patches and operations without writing', async () => {
    for (const forbidden of [
      { recipePath: '../escape.json' },
      { patch: [{ op: 'replace' }] },
      { operations: ['replace_evidence'] },
    ]) {
      const response = await POST(request({ slug: 'demo', request: '换图', ...forbidden }));
      expect(response.status).toBe(400);
    }
    expect(await requestFiles()).toEqual([]);
  });

  it('binds a real explicit md2wechat theme even when it was absent from old candidates', async () => {
    const response = await POST(request({ slug: 'demo', baseRevisionId: 'r001',
      request: '公众号排版改为 elegant-blue', targetAssetIds: ['wechat-html'],
    }));
    expect(response.status).toBe(200);
    const record = JSON.parse(await readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'), 'utf-8'));
    expect(record.operations).toEqual(['change_layout']);
    expect(record.wechat_layout).toEqual({ theme: 'elegant-blue',
      source_package_sha256: sha256(await readFile(path.join(mocks.projectDir, 'pipeline/package/demo-package.md'))),
    });
    expect(mocks.themeCatalog).toHaveBeenCalledOnce();
  });

  it('persists source-bound refinement and separates idempotency by layout parameters', async () => {
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'));
    const sourceHash = sha256(await readFile(path.join(mocks.projectDir, 'pipeline/package/demo-package.md')));
    const makeRequest = (titleLines: string[]) => request({ slug: 'demo', baseRevisionId: 'r001',
      request: '公众号排版使用 elegant-blue，保留标题与间距', targetAssetIds: ['wechat-html'],
      wechatLayout: { theme: 'elegant-blue', source_package_sha256: sourceHash,
        refinement: { profile: 'title-spacing-v1', title_lines: titleLines, heading_blocks: [] },
      },
    });
    const first = await POST(makeRequest(['原', '标题']));
    expect(first.status).toBe(200);
    const firstResult = await first.json();
    const repeat = await POST(makeRequest(['原', '标题']));
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).revisionId).toBe(firstResult.revisionId);
    expect(mocks.execCalls).toHaveLength(1);
    const changed = await POST(makeRequest(['原标', '题']));
    expect(changed.status).toBe(200);
    expect((await changed.json()).revisionId).not.toBe(firstResult.revisionId);
    expect(mocks.execCalls).toHaveLength(2);
    const record = JSON.parse(await readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'), 'utf-8'));
    expect(record.wechat_layout.refinement.title_lines).toEqual(['原', '标题']);
  });

  it.each(['not-a-real-theme', 'unknown', 'elegant-blue 和 minimal-green'])('rejects an unavailable or ambiguous named theme: %s', async (theme) => {
    const response = await POST(request({ slug: 'demo', baseRevisionId: 'r001',
      request: `公众号排版主题改为 ${theme}`, targetAssetIds: ['wechat-html'],
    }));
    expect(response.status).toBe(422);
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toHaveLength(0);
  });

  it.each(['ai', 'disabled', 'fallback'])('rejects an unusable md2wechat catalog choice: %s', async (mode) => {
    mocks.themeCatalog.mockResolvedValue({ source: mode === 'fallback' ? 'echo-basic-fallback' : 'md2wechat',
      rendererAvailable: mode !== 'fallback', templates: [{ id: 'elegant-blue', source: 'md2wechat',
        themeType: mode === 'ai' ? 'ai' : 'api', enabled: mode !== 'disabled', selectable: true }],
    });
    const response = await POST(request({ slug: 'demo', baseRevisionId: 'r001',
      request: '公众号排版改为 elegant-blue', targetAssetIds: ['wechat-html'],
    }));
    expect(response.status).toBe(422);
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toHaveLength(0);
  });

  it('rejects stale source binding and conflicting theme without a render', async () => {
    const payload = { slug: 'demo', baseRevisionId: 'r001', targetAssetIds: ['wechat-html'],
      wechatLayout: { theme: 'elegant-blue', source_package_sha256: '0'.repeat(64) },
    };
    const stale = await POST(request({ ...payload, request: '调整公众号排版' }));
    expect(stale.status).toBe(409);
    const conflicting = await POST(request({ ...payload, request: '调整公众号排版为 minimal-green' }));
    expect(conflicting.status).toBe(422);
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toHaveLength(0);
  });

  it('does not accept a consumer result that lost the requested layout binding', async () => {
    mocks.dropWechatLayout = true;
    const response = await POST(request({ slug: 'demo', baseRevisionId: 'r001',
      request: '公众号排版改为 elegant-blue', targetAssetIds: ['wechat-html'],
    }));
    expect(response.status).toBe(500);
    expect((await response.json()).status).toBe('blocked');
    const record = JSON.parse(await readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'), 'utf-8'));
    expect(record.status).toBe('blocked');
    const current = JSON.parse(await readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/publish/index.json'), 'utf-8'));
    expect(current.revision_id).toBe('r001');
  });

  it('rejects hidden CSS and trust claims inside the otherwise permitted layout object', async () => {
    for (const extra of [{ css: 'body{display:none}' }, { output_is_raw_api_result: true }, { html_path: '../outside.html' }]) {
      const response = await POST(request({ slug: 'demo', baseRevisionId: 'r001', request: '调整公众号排版',
        targetAssetIds: ['wechat-html'], wechatLayout: { theme: 'elegant-blue', source_package_sha256: 'a'.repeat(64), ...extra },
      }));
      expect(response.status).toBe(400);
    }
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toHaveLength(0);
  });

  it('keeps unknown assets and unknown intent in review without writing', async () => {
    const unknownAsset = await POST(request({
      slug: 'demo',
      request: '换成真实截图',
      targetAssetIds: ['xhs-99-p9'],
    }));
    expect(unknownAsset.status).toBe(400);
    expect((await unknownAsset.json()).status).toBe('review_required');

    const unknownIntent = await POST(request({ slug: 'demo', request: '感觉再调整一下' }));
    expect(unknownIntent.status).toBe(422);
    expect((await unknownIntent.json()).status).toBe('review_required');
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toEqual([]);
  });

  it('requires an explicit selected-revision pointer instead of a workbench fallback', async () => {
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'));

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(409);
    expect((await response.json()).status).toBe('review_required');
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toEqual([]);
  });

  it.each(['missing-integrity', 'tampered-digest']) (
    'rejects an unverified selected pointer before writing a queued request: %s',
    async (pointerFailure) => {
      const selectionPath = path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json');
      const selection = JSON.parse(await readFile(selectionPath, 'utf-8'));
      if (pointerFailure === 'missing-integrity') delete selection.integrity;
      else selection.integrity.files[0].sha256 = '0'.repeat(64);
      await writeFile(selectionPath, JSON.stringify(selection), 'utf-8');

      const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

      expect(response.status).toBe(409);
      expect((await response.json()).status).toBe('review_required');
      expect(await requestFiles()).toEqual([]);
      expect(mocks.execCalls).toEqual([]);
      expect(await readdir(path.join(mocks.projectDir, 'pipeline/visual/demo/recipes'))).toEqual([
        'r001.visual-recipe.json',
      ]);
    },
  );

  it('marks the persisted request blocked when the consumer process fails', async () => {
    mocks.consumerFailure = 'local renderer process exited unexpectedly';

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.status).toBe('blocked');
    expect(body).toMatchObject({
      error: '图片修改失败，请调整要求后重试。',
      code: 'visual_revision_execution_failed',
      reason: '图片修改失败，请调整要求后重试。',
    });
    expect(body.debugId).toMatch(/^err_[a-z0-9]+$/i);
    expect(JSON.stringify(body)).not.toContain('local renderer process exited unexpectedly');
    const record = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'),
      'utf-8',
    ));
    expect(record.status).toBe('blocked');
    expect(record.diagnostic_reason).toBe('图片修改失败，请调整要求后重试。');
    expect(mocks.execCalls).toHaveLength(1);
  });

  it('does not consume a selected revision whose quality summary is not pass', async () => {
    const indexPath = path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001.index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf-8'));
    await writeFile(indexPath, JSON.stringify({
      ...index,
      quality_summary: { status: 'blocked', errors: ['density below threshold'] },
    }), 'utf-8');

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(409);
    expect((await response.json()).status).toBe('review_required');
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toEqual([]);
  });

  it('marks the request blocked when consumer output fails server-side verification', async () => {
    mocks.malformedConsumerResult = true;

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(500);
    const record = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'),
      'utf-8',
    ));
    expect(record.status).toBe('blocked');
    expect(record.diagnostic_reason).toBe('图片修改失败，请调整要求后重试。');
    expect(await readdir(path.join(mocks.projectDir, 'pipeline/visual/demo/recipes'))).toEqual(['r001.visual-recipe.json']);
    expect(await readdir(path.join(mocks.projectDir, 'pipeline/visual/demo/revisions'))).not.toContain('r002.index.json');
  });

  it('explains a theme that did not apply without claiming the original was replaced', async () => {
    mocks.consumerFailure = '所选排版样式未应用，已保留原成品。请检查排版服务后重试。';
    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error).toContain('原成品已保留');
    expect(payload.error).toContain('是否扣费以服务方记录为准');
    expect(await readdir(path.join(mocks.projectDir, 'pipeline/visual/demo/recipes'))).toEqual(['r001.visual-recipe.json']);
  });

  it('rejects a fake-rendered index even when it claims quality pass', async () => {
    const currentPublishIndex = path.join(mocks.projectDir, 'pipeline/visual/demo/publish/index.json');
    const originalPublishIndex = await readFile(currentPublishIndex);
    mocks.fakeConsumerOutputs = true;

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(500);
    const record = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'),
      'utf-8',
    ));
    expect(record.status).toBe('blocked');
    expect(record.diagnostic_reason).toBe('图片修改失败，请调整要求后重试。');
    expect(await readFile(currentPublishIndex)).toEqual(originalPublishIndex);
    expect(await readdir(path.join(mocks.projectDir, 'pipeline/visual/demo/recipes'))).toEqual(['r001.visual-recipe.json']);
    expect(await readdir(path.join(mocks.projectDir, 'pipeline/visual/demo/revisions'))).not.toContain('r002.index.json');
    await expect(readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/publish/r002/wechat/article.html'))).rejects.toThrow();
  });

  it('scopes idempotency to the explicitly selected base revision', async () => {
    const payload = { slug: 'demo', request: '换成杂志风' };
    const first = await POST(request(payload));
    expect((await first.json()).revisionId).toBe('r002');
    await writeDigestBoundSelection('demo', 'r002');

    const second = await POST(request(payload));

    expect(second.status).toBe(200);
    expect((await second.json()).revisionId).toBe('r003');
    expect(mocks.execCalls).toHaveLength(2);
  });

  it('keeps palette requests in review until the renderer supports a real palette change', async () => {
    const response = await POST(request({ slug: 'demo', request: '换成红色风格' }));

    expect(response.status).toBe(422);
    expect((await response.json()).status).toBe('review_required');
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toEqual([]);
  });

  it('recovers a committed rendered request when subprocess stdout transport fails', async () => {
    mocks.consumerFailureAfterCommit = true;

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('rendered');
    const record = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'),
      'utf-8',
    ));
    expect(record.status).toBe('rendered');
  });

  it('removes an unrecorded candidate when the consumer times out before request commit', async () => {
    const publishIndex = path.join(mocks.projectDir, 'pipeline/visual/demo/publish/index.json');
    const originalPublishIndex = await readFile(publishIndex);
    mocks.consumerFailureBeforeRequestCommit = true;

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(500);
    expect(await readFile(publishIndex)).toEqual(originalPublishIndex);
    expect(await readdir(path.join(mocks.projectDir, 'pipeline/visual/demo/recipes'))).toEqual(['r001.visual-recipe.json']);
    expect(await readdir(path.join(mocks.projectDir, 'pipeline/visual/demo/revisions'))).not.toContain('r002.index.json');
    await expect(readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/publish/r002/wechat/article.html'))).rejects.toThrow();
  });

  it('revalidates a cached rendered response before returning it', async () => {
    const payload = { slug: 'demo', request: '换成杂志风' };
    const first = await POST(request(payload));
    expect((await first.json()).revisionId).toBe('r002');
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo/publish/r002/wechat/article.html'));

    const second = await POST(request(payload));

    expect(second.status).toBe(200);
    expect((await second.json()).revisionId).toBe('r003');
    expect(mocks.execCalls).toHaveLength(2);
  });

  it('rejects selected indexes whose output recipe provenance is stale', async () => {
    const indexPath = path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001.index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf-8'));
    index.outputs[0].recipe_path = 'pipeline/visual/demo/recipes/r999.visual-recipe.json';
    await writeFile(indexPath, JSON.stringify(index), 'utf-8');

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(409);
    expect(mocks.execCalls).toEqual([]);
  });

  it('rejects a numeric base_revision_id in the shared request schema', async () => {
    const schema = JSON.parse(await readFile(
      path.join(process.env.AIFIOS_HOME!, 'skills', 'content-runtime', 'schemas', 'visual-revision-request.schema.json'),
      'utf-8',
    ));
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    expect(validate({
      schema: 'aifios.visual-revision-request.v1',
      base_revision_id: 1,
      request: '换成杂志风',
      operations: ['change_system'],
      constraints: ['保留原文事实'],
      status: 'queued',
    })).toBe(false);
  });

  it('does not overwrite a concurrent publish index replacement during cleanup', async () => {
    mocks.fakeConsumerOutputs = true;
    mocks.concurrentPublishReplacement = true;

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(500);
    const publishIndex = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/publish/index.json'),
      'utf-8',
    ));
    expect(publishIndex.revision_id).toBe('r999');
  });

  it.each([
    'pipeline/visual/demo/publish/r001/wechat/article.html',
    'pipeline/visual/demo/publish/r002/../r001/wechat/article.html',
    'pipeline/visual/demo/publish/r002/./wechat/article.html',
    'pipeline/visual/demo/publish/r002//wechat/article.html',
    'pipeline\\visual\\demo\\publish\\r002\\wechat\\article.html',
  ])('rejects rendered output outside the candidate revision root: %s', async (outputPath) => {
    mocks.consumerOutputPath = outputPath;

    const response = await POST(request({ slug: 'demo', request: '换成杂志风' }));

    expect(response.status).toBe(500);
    const record = JSON.parse(await readFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001-request.json'),
      'utf-8',
    ));
    expect(record.status).toBe('blocked');
    expect(record.diagnostic_reason).toBe('图片修改失败，请调整要求后重试。');
  });

  it('keeps screenshot evidence requests in review when only a data-file alternative exists', async () => {
    const recipePath = path.join(mocks.projectDir, 'pipeline/visual/demo/recipes/r001.visual-recipe.json');
    const recipe = JSON.parse(await readFile(recipePath, 'utf-8'));
    recipe.source_assets = [
      'materials/screenshots/first.png',
      'materials/data/metrics.csv',
    ];
    await writeFile(recipePath, JSON.stringify(recipe), 'utf-8');
    await writeDigestBoundSelection('demo', 'r001');

    const response = await POST(request({
      slug: 'demo',
      request: '第二张改成真实截图',
      targetAssetIds: ['xhs-01-p2'],
    }));

    expect(response.status).toBe(422);
    expect((await response.json()).status).toBe('review_required');
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toEqual([]);
  });

  it.each([
    ['materials/data/metrics.xlsx', '第二张替换成数据图'],
    ['materials/screenshots/mock.svg', '第二张改成真实截图'],
    ['materials/recordings/demo.mp4', '第二张改成真实截图'],
  ])('keeps renderer-unsupported evidence in review before writing: %s', async (source, revisionText) => {
    const recipePath = path.join(mocks.projectDir, 'pipeline/visual/demo/recipes/r001.visual-recipe.json');
    const recipe = JSON.parse(await readFile(recipePath, 'utf-8'));
    recipe.source_assets = ['materials/screenshots/first.png', source];
    await writeFile(recipePath, JSON.stringify(recipe), 'utf-8');
    await writeDigestBoundSelection('demo', 'r001');

    const response = await POST(request({
      slug: 'demo',
      request: revisionText,
      targetAssetIds: ['xhs-01-p2'],
    }));

    expect(response.status).toBe(422);
    expect((await response.json()).status).toBe('review_required');
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toEqual([]);
  });

  it('returns review_required for non-consumable operations and inapplicable explicit targets', async () => {
    for (const payload of [
      { slug: 'demo', request: '精简文案', targetAssetIds: ['xhs-01-p1'] },
      { slug: 'demo', request: '替换成真实截图', targetAssetIds: ['xhs-01-p1'] },
    ]) {
      const response = await POST(request(payload));
      expect(response.status).toBe(422);
      expect((await response.json()).status).toBe('review_required');
    }
    expect(mocks.execCalls).toEqual([]);
  });

  it('rejects the removed AI illustration revision path without invoking the consumer', async () => {
    const recipePath = path.join(mocks.projectDir, 'pipeline/visual/demo/recipes/r001.visual-recipe.json');
    const recipe = JSON.parse(await readFile(recipePath, 'utf-8'));
    recipe.content_archetype = 'concept';
    recipe.evidence_mode = 'illustration_allowed';
    recipe.assets.push({
      id: 'inline-01',
      platform: 'wechat',
      role: 'illustration',
      layout_recipe: 'inline-16x9',
      renderer: 'ian-xiaohei-illustrations',
      status: 'planned',
    });
    await writeFile(recipePath, JSON.stringify(recipe), 'utf-8');
    const indexPath = path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r001.index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf-8'));
    const outputPath = 'pipeline/visual/demo/publish/r001/inline/inline-01.png';
    const bytes = Buffer.from('selected-inline-01');
    await mkdir(path.dirname(path.join(mocks.projectDir, outputPath)), { recursive: true });
    await writeFile(path.join(mocks.projectDir, outputPath), bytes);
    index.outputs.push({
      id: 'inline-01',
      renderer: 'local',
      recipe_path: 'pipeline/visual/demo/recipes/r001.visual-recipe.json',
      revision_id: 'r001',
      status: 'generated',
      output: outputPath,
      size: bytes.length,
      sha256: sha256(bytes),
    });
    await writeFile(indexPath, JSON.stringify(index), 'utf-8');
    await writeFile(
      path.join(mocks.projectDir, 'pipeline/visual/demo/publish/index.json'),
      JSON.stringify(index),
      'utf-8',
    );
    await writeDigestBoundSelection('demo', 'r001');

    const response = await POST(request({
      slug: 'demo',
      request: '重新生成插画',
      targetAssetIds: ['inline-01'],
    }));

    expect(response.status).toBe(422);
    const responseBody = await response.json();
    expect(responseBody.status).toBe('review_required');
    expect(responseBody.code).toBe('visual_ai_revision_removed');
    expect(await requestFiles()).toEqual([]);
    expect(mocks.execCalls).toEqual([]);
  });
});

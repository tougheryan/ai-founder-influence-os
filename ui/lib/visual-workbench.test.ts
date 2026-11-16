import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ projectDir: `/tmp/aifios-visual-workbench-${process.pid}`, verifyWechat: vi.fn(async () => true) }));

vi.mock('server-only', () => ({}));
vi.mock('./wechat-layout-fidelity', () => ({ verifyWechatLayout: mocks.verifyWechat }));
vi.mock('./project-root', async () => {
  const pathModule = await import('node:path');
  return {
    PROJECT_DIR: mocks.projectDir,
    runtimeJoin: (...parts: string[]) => pathModule.join(...parts),
    safeResolve: (base: string, relative: string) => {
      const resolved = pathModule.resolve(base, relative);
      return resolved.startsWith(`${pathModule.resolve(base)}${pathModule.sep}`) ? resolved : null;
    },
  };
});

import { loadVisualWorkbenchState, validateVisualRevisionArtifacts } from './visual-workbench';


async function writeJson(relative: string, value: unknown) {
  const absolute = path.join(mocks.projectDir, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(value), 'utf-8');
}


function outputs(revisionId: string) {
  const recipePath = `pipeline/visual/demo/recipes/${revisionId}.visual-recipe.json`;
  const output = (id: string, relative: string, extra: Record<string, unknown>) => {
    const bytes = Buffer.from(`rendered ${id}`);
    return {
      id,
      kind: 'xhs_card',
      renderer: 'local',
      recipe_path: recipePath,
      revision_id: revisionId,
      output: `pipeline/visual/demo/publish/${revisionId}/${relative}`,
      status: 'generated',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...extra,
    };
  };
  return [
    output('xhs-01-p1', 'xhs/post-01/01-cover.png', { quality: 'pass' }),
    output('xhs-01-p2', 'xhs/post-01/02-page.png', {
      quality: revisionId === 'r002' ? 'review_required' : 'pass',
      reason: revisionId === 'r002' ? '截图来源等待人工确认' : undefined,
    }),
    output('xhs-01-p5', 'xhs/post-01/05-cta.png', { quality: 'pass' }),
  ];
}


type IndexFixture = {
  revision_id?: string;
  recipe_path?: string;
  platform_delivery_manifest?: string;
  outputs: Array<{
    renderer?: string;
    recipe_path?: string;
    output?: string;
  }>;
};


async function writeOutputs(revisionId: string) {
  await Promise.all(outputs(revisionId).map(async (output) => {
    const absolute = path.join(mocks.projectDir, output.output);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `rendered ${output.id}`, 'utf-8');
  }));
}


async function writeSelection(revisionId: string) {
  const recipePath = `pipeline/visual/demo/recipes/${revisionId}.visual-recipe.json`;
  const indexPath = `pipeline/visual/demo/revisions/${revisionId}.index.json`;
  const [recipeBytes, indexBytes] = await Promise.all([
    readFile(path.join(mocks.projectDir, recipePath)),
    readFile(path.join(mocks.projectDir, indexPath)),
  ]);
  const index = JSON.parse(indexBytes.toString('utf-8')) as {
    outputs: ReturnType<typeof outputs>;
    platform_delivery_manifest?: string;
  };
  const outputFiles = await Promise.all(index.outputs.map(async (output) => {
    const bytes = await readFile(path.join(mocks.projectDir, output.output));
    return {
      role: 'output',
      id: output.id,
      path: output.output,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }));
  const platformDeliveryFile = index.platform_delivery_manifest
    ? await readFile(path.join(mocks.projectDir, index.platform_delivery_manifest))
    : null;
  await writeJson('pipeline/visual/demo/selected-revision.json', {
    schema: 'aifios.visual-selection.v1',
    slug: 'demo',
    revision_id: revisionId,
    integrity: {
      algorithm: 'sha256',
      files: [
        { role: 'recipe', path: recipePath, size: recipeBytes.length, sha256: createHash('sha256').update(recipeBytes).digest('hex') },
        { role: 'index', path: indexPath, size: indexBytes.length, sha256: createHash('sha256').update(indexBytes).digest('hex') },
        ...outputFiles,
        ...(platformDeliveryFile && index.platform_delivery_manifest ? [{
          role: 'platform_delivery',
          path: index.platform_delivery_manifest,
          size: platformDeliveryFile.length,
          sha256: createHash('sha256').update(platformDeliveryFile).digest('hex'),
        }] : []),
      ],
    },
  });
}


async function updateIndex(revisionId: string, mutate: (index: IndexFixture) => void) {
  const relative = `pipeline/visual/demo/revisions/${revisionId}.index.json`;
  const absolute = path.join(mocks.projectDir, relative);
  const index = JSON.parse(await readFile(absolute, 'utf-8')) as IndexFixture;
  mutate(index);
  await writeJson(relative, index);
}


describe('loadVisualWorkbenchState', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    const assets = [
      { id: 'xhs-01-p1', platform: 'xhs', role: 'cover' },
      { id: 'xhs-01-p2', platform: 'xhs', role: 'evidence' },
      { id: 'xhs-01-p5', platform: 'xhs', role: 'cta' },
    ];
    await writeJson('pipeline/visual/demo/recipes/r001.visual-recipe.json', { revision_id: 'r001', slug: 'demo', assets });
    await writeJson('pipeline/visual/demo/recipes/r002.visual-recipe.json', { revision_id: 'r002', parent_revision_id: 'r001', slug: 'demo', assets });
    await writeJson('pipeline/visual/demo/revisions/r001.index.json', { schema: 'aifios.visual-publish.v1', slug: 'demo', revision_id: 'r001', recipe_path: 'pipeline/visual/demo/recipes/r001.visual-recipe.json', revision_index_path: 'pipeline/visual/demo/revisions/r001.index.json', status: 'generated', legacy: false, quality_summary: { status: 'pass', errors: [] }, outputs: outputs('r001'), errors: [] });
    await writeJson('pipeline/visual/demo/revisions/r002.index.json', { schema: 'aifios.visual-publish.v1', slug: 'demo', revision_id: 'r002', recipe_path: 'pipeline/visual/demo/recipes/r002.visual-recipe.json', revision_index_path: 'pipeline/visual/demo/revisions/r002.index.json', status: 'generated', legacy: false, quality_summary: { status: 'pass', errors: [] }, outputs: outputs('r002'), errors: [] });
    await Promise.all([writeOutputs('r001'), writeOutputs('r002')]);
    await writeSelection('r002');
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('returns selected assets plus cover, evidence and CTA comparison against the parent', async () => {
    const state = await loadVisualWorkbenchState('demo');

    expect(state?.selectedRevisionId).toBe('r002');
    expect(state?.hasExplicitSelection).toBe(true);
    expect(state?.revisions.map((revision) => revision.status)).toEqual(['ready', 'ready']);
    expect(state?.comparison.map((item) => item.role)).toEqual(['cover', 'evidence', 'cta']);
    for (const item of state?.comparison || []) {
      expect(item.leftLabel).toBe('previous');
      expect(item.leftRevisionId).toBe('r001');
      expect(item.left?.revisionId).toBe('r001');
      expect(item.rightLabel).toBe('current');
      expect(item.rightRevisionId).toBe('r002');
      expect(item.right?.revisionId).toBe('r002');
    }
    const evidence = state?.assets.find((asset) => asset.role === 'evidence');
    expect(evidence?.quality).toBe('review_required');
    expect(evidence?.reason).toBe('截图来源等待人工确认');
  });

  it('returns actual WeChat fallback metadata and bounded choices only with verified output bytes', async () => {
    const recipePath = 'pipeline/visual/demo/recipes/r001.visual-recipe.json';
    const outputPath = 'pipeline/visual/demo/publish/r001/wechat/article.html';
    const bytes = Buffer.from('<html>offline test article</html>');
    await mkdir(path.dirname(path.join(mocks.projectDir, outputPath)), { recursive: true });
    await writeFile(path.join(mocks.projectDir, outputPath), bytes);
    await writeJson(recipePath, {
      revision_id: 'r001', slug: 'demo', assets: [{ id: 'wechat-html', platform: 'wechat', role: 'article' }],
      platforms: { wechat: { layout_selection: { selected: 'apple', candidates: ['apple', 'bytedance', 'bytedance', '../private', 12] } } },
    });
    await writeJson('pipeline/visual/demo/revisions/r001.index.json', {
      schema: 'aifios.visual-publish.v1', slug: 'demo', revision_id: 'r001', recipe_path: recipePath,
      revision_index_path: 'pipeline/visual/demo/revisions/r001.index.json', status: 'generated', legacy: false,
      quality_summary: { status: 'pass', errors: [] },
      outputs: [{ id: 'wechat-html', renderer: 'local', revision_id: 'r001', recipe_path: recipePath,
        status: 'generated', output: outputPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        layout_style: 'apple', renderer_theme: 'echo-basic', layout_fallback_reason: 'private renderer diagnostic',
      }],
    });
    const state = await loadVisualWorkbenchState('demo');
    expect(state?.assetCandidates?.find((item) => item.id === 'wechat-html')?.wechatLayout).toEqual({
      requestedTheme: 'apple', renderedTheme: 'echo-basic', usedFallback: true, candidates: ['apple', 'bytedance'],
    });
    expect(JSON.stringify(state)).not.toContain('private renderer diagnostic');
    // Even a persisted pass and intact bytes cannot override a fresh rejection.
    mocks.verifyWechat.mockResolvedValueOnce(false);
    const rejected = await validateVisualRevisionArtifacts('demo', 'r001');
    expect(rejected.valid).toBe(false);
    expect(rejected.reason).toContain('公众号全文');
    await writeFile(path.join(mocks.projectDir, outputPath), 'tampered');
    const changed = await loadVisualWorkbenchState('demo');
    expect(changed?.assetCandidates?.some((item) => item.id === 'wechat-html')).toBe(false);
  });

  it('exposes two direction previews before any full visual revision is rendered', async () => {
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo'), { recursive: true, force: true });
    await writeJson('pipeline/visual/demo/recipes/r001.visual-recipe.json', {
      schema: 'aifios.visual-recipe.v2',
      revision_id: 'r001',
      slug: 'demo',
      visual_preferences: { mode: 'ai_enhanced', direction_count: 2, provider_policy: 'auto' },
      selected_direction: 'direction-a',
      art_directions: [
        { id: 'direction-a', label: '品牌叙事', style_tokens: ['editorial'], palette: { accent: '#E85D4C' }, composition: 'editorial grid' },
        { id: 'direction-b', label: '概念场景', style_tokens: ['conceptual'], palette: { accent: '#568C13' }, composition: 'concept composition' },
      ],
      assets: [],
    });

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.assets).toEqual([]);
    expect(state?.artDirections).toHaveLength(2);
    expect(state?.artDirections?.every((direction) => direction.selected === false)).toBe(true);
    expect(state?.artDirections?.map((direction) => direction.palette)).toEqual([['#E85D4C'], ['#568C13']]);
    expect(state?.effectiveVisualMode).toBe('ai_enhanced');
  });

  it('identifies a local md2wechat refinement only when its recipe and output provenance agree', async () => {
    const recipePath = 'pipeline/visual/demo/recipes/r001.visual-recipe.json';
    const indexPath = 'pipeline/visual/demo/revisions/r001.index.json';
    const outputPath = 'pipeline/visual/demo/publish/r001/wechat/article.html';
    const bytes = Buffer.from('<html>refined article</html>');
    const refinement = { profile: 'title-spacing-v1', title_lines: ['标题', '断行'], heading_blocks: [] };
    await mkdir(path.dirname(path.join(mocks.projectDir, outputPath)), { recursive: true });
    await writeFile(path.join(mocks.projectDir, outputPath), bytes);
    await writeJson(recipePath, { revision_id: 'r001', slug: 'demo',
      assets: [{ id: 'wechat-html', platform: 'wechat', role: 'article' }],
      platforms: { wechat: { layout_selection: { selected: 'elegant-blue', candidates: ['elegant-blue'] },
        wechat_layout: { theme: 'elegant-blue', source_package_sha256: 'a'.repeat(64), refinement },
      } },
    });
    const output = { id: 'wechat-html', renderer: 'local', revision_id: 'r001', recipe_path: recipePath,
      status: 'generated', output: outputPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      layout_style: 'elegant-blue', renderer_theme: 'elegant-blue', base_renderer: 'md2wechat-cli', base_theme: 'elegant-blue',
      local_refinements: refinement, raw_html_sha256: 'b'.repeat(64), output_is_raw_api_result: false,
    };
    const index = { schema: 'aifios.visual-publish.v1', slug: 'demo', revision_id: 'r001', recipe_path: recipePath,
      revision_index_path: indexPath, status: 'generated', legacy: false, quality_summary: { status: 'pass', errors: [] },
    };
    await writeJson(indexPath, { ...index, outputs: [output] });
    const state = await loadVisualWorkbenchState('demo');
    expect(state?.assetCandidates?.find((item) => item.id === 'wechat-html')?.wechatLayout).toEqual({
      requestedTheme: 'elegant-blue', renderedTheme: 'elegant-blue', usedFallback: false, candidates: ['elegant-blue'],
      locallyRefined: true, refinementProfile: 'title-spacing-v1',
    });
    for (const invalid of [
      { output_is_raw_api_result: true }, { raw_html_sha256: '' }, { base_theme: 'other' },
      { local_refinements: { ...refinement, title_lines: ['different'] } },
    ]) {
      await writeJson(indexPath, { ...index, outputs: [{ ...output, ...invalid }] });
      const unconfirmed = await loadVisualWorkbenchState('demo');
      expect(unconfirmed?.assetCandidates?.find((item) => item.id === 'wechat-html')?.wechatLayout?.locallyRefined).toBeUndefined();
    }
  });

  it('returns the adopted asset manifest with content hash, paths, file hashes, and platform bindings', async () => {
    const rendered = outputs('r002');
    await writeJson('pipeline/visual/demo/selected-assets.json', {
      schema: 'aifios.visual-asset-manifest.v1',
      slug: 'demo',
      sourceContentHash: 'a'.repeat(64),
      requiredRoles: ['cover', 'evidence', 'cta', 'video-01-cover'],
      selections: {
        cover: {
          assetId: 'xhs-01-p1', revisionId: 'r002', sha256: rendered[0].sha256,
          platformBindings: ['xiaohongshu', 'moments'],
        },
        evidence: {
          assetId: 'xhs-01-p2', revisionId: 'r002', sha256: rendered[1].sha256,
          platformBindings: ['xiaohongshu'],
        },
        cta: {
          assetId: 'xhs-01-p5', revisionId: 'r002', sha256: rendered[2].sha256,
          platformBindings: ['xiaohongshu', 'moments'],
        },
      },
    });

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.hasExplicitAssetSelection).toBe(true);
    expect(state?.hasCompleteAssetSelection).toBe(true);
    expect(state?.adoptedAssetManifest).toEqual(expect.objectContaining({
      sourceContentHash: 'a'.repeat(64),
      requiredRoles: ['cover', 'evidence', 'cta'],
      assets: expect.arrayContaining([
        expect.objectContaining({ semanticRole: 'cover', path: rendered[0].output, sha256: rendered[0].sha256 }),
        expect.objectContaining({ semanticRole: 'evidence', platformBindings: ['xiaohongshu'] }),
      ]),
    }));
  });

  it('keeps a partial per-asset adoption visible but incomplete', async () => {
    const rendered = outputs('r002');
    await writeJson('pipeline/visual/demo/selected-assets.json', {
      schema: 'aifios.visual-asset-manifest.v1',
      slug: 'demo',
      sourceContentHash: 'a'.repeat(64),
      requiredRoles: ['cover', 'evidence', 'cta'],
      selections: {
        cover: {
          assetId: 'xhs-01-p1', revisionId: 'r002', sha256: rendered[0].sha256,
          platformBindings: ['xiaohongshu'],
        },
      },
    });

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.hasExplicitAssetSelection).toBe(true);
    expect(state?.hasCompleteAssetSelection).toBe(false);
  });

  it('compares an explicitly selected current revision with its newer ready candidate', async () => {
    await writeSelection('r001');

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.selectedRevisionId).toBe('r001');
    expect(state?.comparison.map((item) => ({
      role: item.role,
      leftLabel: item.leftLabel,
      leftRevisionId: item.leftRevisionId,
      rightLabel: item.rightLabel,
      rightRevisionId: item.rightRevisionId,
    }))).toEqual([
      { role: 'cover', leftLabel: 'current', leftRevisionId: 'r001', rightLabel: 'candidate', rightRevisionId: 'r002' },
      { role: 'evidence', leftLabel: 'current', leftRevisionId: 'r001', rightLabel: 'candidate', rightRevisionId: 'r002' },
      { role: 'cta', leftLabel: 'current', leftRevisionId: 'r001', rightLabel: 'candidate', rightRevisionId: 'r002' },
    ]);
  });

  it('blocks a recipe-less historical index even when its legacy marker is absent', async () => {
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo'), { recursive: true, force: true });
    await writeJson('pipeline/visual/demo/publish/index.json', {
      slug: 'demo',
      revision_id: 'r001',
      status: 'generated',
      outputs: [{ id: 'wechat-html', output: 'pipeline/visual/demo/publish/wechat/article.html' }],
    });

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.selectedRevisionId).toBe('legacy');
    expect(state?.hasExplicitSelection).toBe(false);
    expect(state?.revisions).toHaveLength(1);
    expect(state?.revisions[0].revisionId).toBe('legacy');
    expect(state?.revisions[0].status).toBe('blocked');
    expect(state?.revisions[0].reason).toMatch(/legacy/i);
    expect(state?.assets).toEqual([]);
    expect(state?.comparison).toEqual([]);
  });

  it('keeps the first ready revision adoptable until an explicit selection exists', async () => {
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'));

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.selectedRevisionId).toBe('r002');
    expect(state?.hasExplicitSelection).toBe(false);
    expect(state?.revisions.find((revision) => revision.revisionId === 'r002')?.status).toBe('ready');
  });

  it('does not trust a selected pointer whose digest manifest is tampered', async () => {
    const selectionPath = 'pipeline/visual/demo/selected-revision.json';
    const selection = JSON.parse(await readFile(path.join(mocks.projectDir, selectionPath), 'utf-8'));
    selection.integrity.files[0].sha256 = '0'.repeat(64);
    await writeJson(selectionPath, selection);

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.hasExplicitSelection).toBe(false);
    expect(state?.selectedRevisionId).toBe('r001');
  });

  it('keeps a selected revision explicit when its platform delivery manifest is integrity-bound', async () => {
    const manifestPath = 'pipeline/visual/demo/publish/r002/platform-delivery.json';
    await writeJson(manifestPath, {
      schema: 'aifios.platform-visual-delivery.v1',
      slug: 'demo',
      revision_id: 'r002',
      wechat: {},
      xiaohongshu: { posts: [] },
      video: { items: [] },
    });
    await updateIndex('r002', (index) => {
      index.platform_delivery_manifest = manifestPath;
    });
    await writeSelection('r002');

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.selectedRevisionId).toBe('r002');
    expect(state?.hasExplicitSelection).toBe(true);
  });

  it('does not trust a selected pointer when its platform delivery manifest changes', async () => {
    const manifestPath = 'pipeline/visual/demo/publish/r002/platform-delivery.json';
    await writeJson(manifestPath, {
      schema: 'aifios.platform-visual-delivery.v1',
      slug: 'demo',
      revision_id: 'r002',
      wechat: {},
      xiaohongshu: { posts: [] },
      video: { items: [] },
    });
    await updateIndex('r002', (index) => {
      index.platform_delivery_manifest = manifestPath;
    });
    await writeSelection('r002');
    await writeJson(manifestPath, {
      schema: 'aifios.platform-visual-delivery.v1',
      slug: 'demo',
      revision_id: 'r002',
      wechat: { changed: true },
      xiaohongshu: { posts: [] },
      video: { items: [] },
    });

    const state = await loadVisualWorkbenchState('demo');

    expect(state?.hasExplicitSelection).toBe(false);
    expect(state?.selectedRevisionId).toBe('r001');
  });

  it.each([
    ['is outside the target revision', 'pipeline/visual/demo/publish/r001/platform-delivery.json', {
      schema: 'aifios.platform-visual-delivery.v1', slug: 'demo', revision_id: 'r002',
    }],
    ['belongs to a different revision', 'pipeline/visual/demo/publish/r002/platform-delivery.json', {
      schema: 'aifios.platform-visual-delivery.v1', slug: 'demo', revision_id: 'r001',
    }],
  ])('blocks a generated revision when its platform delivery manifest %s', async (_label, manifestPath, manifest) => {
    await writeJson(manifestPath, manifest);
    await updateIndex('r002', (index) => {
      index.platform_delivery_manifest = manifestPath;
    });

    const state = await loadVisualWorkbenchState('demo');
    const revision = state?.revisions.find((item) => item.revisionId === 'r002');

    expect(revision?.status).toBe('blocked');
    expect(revision?.reason).toContain('平台视觉交付清单');
  });

  it('exposes a structurally valid concept AI raster for review without making it adoptable', async () => {
    const recipePath = 'pipeline/visual/demo/recipes/r003.visual-recipe.json';
    const outputPath = 'pipeline/visual/demo/publish/r003/inline/inline-01.png';
    await writeJson(recipePath, {
      revision_id: 'r003',
      parent_revision_id: 'r002',
      slug: 'demo',
      content_archetype: 'concept',
      evidence_mode: 'illustration_allowed',
      assets: [{
        id: 'inline-01',
        platform: 'wechat',
        role: 'illustration',
        renderer: 'ian-xiaohei-illustrations',
      }],
    });
    await writeJson('pipeline/visual/demo/revisions/r003.index.json', {
      schema: 'aifios.visual-publish.v1',
      slug: 'demo',
      revision_id: 'r003',
      recipe_path: recipePath,
      revision_index_path: 'pipeline/visual/demo/revisions/r003.index.json',
      status: 'generated',
      legacy: false,
      aesthetic_status: 'review_required',
      quality_summary: { status: 'review_required', errors: [] },
      outputs: [{
        id: 'inline-01',
        kind: 'inline_image',
        renderer: 'local',
        recipe_path: recipePath,
        revision_id: 'r003',
        output: outputPath,
        status: 'generated',
        quality: 'review_required',
        ai_generated: true,
        ocr_status: 'review_required',
        size: Buffer.byteLength('reviewable image'),
        sha256: createHash('sha256').update('reviewable image').digest('hex'),
      }],
    });
    await mkdir(path.dirname(path.join(mocks.projectDir, outputPath)), { recursive: true });
    await writeFile(path.join(mocks.projectDir, outputPath), 'reviewable image');

    const state = await loadVisualWorkbenchState('demo');
    const revision = state?.revisions.find((item) => item.revisionId === 'r003');

    expect(revision?.status).toBe('review_required');
    expect(state?.reviewAssets).toEqual([
      expect.objectContaining({
        revisionId: 'r003',
        id: 'inline-01',
        role: 'illustration',
        quality: 'review_required',
      }),
    ]);

    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'));
    const fallbackState = await loadVisualWorkbenchState('demo');
    expect(fallbackState?.selectedRevisionId).toBe('r003');
    expect(fallbackState?.reviewAssets).toEqual([
      expect.objectContaining({ revisionId: 'r003', id: 'inline-01' }),
    ]);
  });

  it('keeps verified quality-failed images visible while forbidding adoption and ignoring output pass labels', async () => {
    await updateIndex('r001', (index) => Object.assign(index, {
      quality_summary: { status: 'blocked', errors: ['xhs-01-p2 density 11% is below 68%'] },
    }));
    const state = await loadVisualWorkbenchState('demo');
    expect(state?.revisions.find((item) => item.revisionId === 'r001')).toMatchObject({
      status: 'blocked', issues: ['xhs-01-p2 density 11% is below 68%'],
    });
    const previews = state?.assetCandidates?.filter((item) => item.revisionId === 'r001');
    expect(previews).toHaveLength(3);
    expect(previews?.every((item) => item.quality === 'blocked')).toBe(true);
    expect((await validateVisualRevisionArtifacts('demo', 'r001')).valid).toBe(false);
    await writeFile(path.join(mocks.projectDir, outputs('r001')[0].output), 'changed image');
    const corrupt = await loadVisualWorkbenchState('demo');
    expect(corrupt?.assetCandidates?.filter((item) => item.revisionId === 'r001')).toEqual([]);
    expect(corrupt?.revisions.find((item) => item.revisionId === 'r001')?.issues).toBeUndefined();
  });

  it('restores the latest verified failed candidate without adopting it or accepting corrupt images', async () => {
    await rm(path.join(mocks.projectDir, 'pipeline/visual/demo/selected-revision.json'));
    for (const revisionId of ['r001', 'r002']) {
      await updateIndex(revisionId, (index) => Object.assign(index, {
        quality_summary: { status: 'blocked', errors: ['xhs-01-p2 density 11% is below 68%'] },
      }));
    }
    const latestIndex = JSON.parse(await readFile(path.join(mocks.projectDir, 'pipeline/visual/demo/revisions/r002.index.json'), 'utf-8'));
    await writeJson('pipeline/visual/demo/publish/index.json', latestIndex);
    const restored = await loadVisualWorkbenchState('demo');
    expect(restored?.selectedRevisionId).toBe('r002');
    expect(restored?.hasExplicitSelection).toBe(false);
    expect(restored?.hasCompleteAssetSelection).toBe(false);
    expect(restored?.assets).toHaveLength(3);
    expect(restored?.assets.every((item) => item.revisionId === 'r002' && item.quality === 'blocked')).toBe(true);
    expect((await validateVisualRevisionArtifacts('demo', 'r002')).valid).toBe(false);
    await writeFile(path.join(mocks.projectDir, outputs('r002')[0].output), 'changed image');
    const corrupt = await loadVisualWorkbenchState('demo');
    expect(corrupt?.selectedRevisionId).toBe('r001');
    expect(corrupt?.assetCandidates?.some((item) => item.revisionId === 'r002')).toBe(false);
  });

  it('blocks a generated revision when the persisted quality summary is missing', async () => {
    const assets = [{ id: 'xhs-01-p1', platform: 'xhs', role: 'cover' }];
    await writeJson('pipeline/visual/demo/recipes/r003.visual-recipe.json', {
      revision_id: 'r003',
      parent_revision_id: 'r002',
      slug: 'demo',
      assets,
    });
    await writeJson('pipeline/visual/demo/revisions/r003.index.json', {
      schema: 'aifios.visual-publish.v1',
      slug: 'demo',
      revision_id: 'r003',
      recipe_path: 'pipeline/visual/demo/recipes/r003.visual-recipe.json',
      revision_index_path: 'pipeline/visual/demo/revisions/r003.index.json',
      status: 'generated',
      legacy: false,
      aesthetic_status: 'pass',
      outputs: outputs('r003'),
    });

    const state = await loadVisualWorkbenchState('demo');
    const revision = state?.revisions.find((item) => item.revisionId === 'r003');

    expect(revision?.status).toBe('blocked');
    expect(revision?.reason).toContain('quality_summary.status=pass');
  });

  it.each([
    ['top-level recipe provenance is stale', (index: IndexFixture) => {
      index.recipe_path = 'pipeline/visual/demo/recipes/r001.visual-recipe.json';
    }],
    ['an output recipe provenance is stale', (index: IndexFixture) => {
      index.outputs[0].recipe_path = 'pipeline/visual/demo/recipes/r001.visual-recipe.json';
    }],
    ['an output did not use the local renderer', (index: IndexFixture) => {
      index.outputs[0].renderer = 'fake';
    }],
    ['an output path belongs to another revision', (index: IndexFixture) => {
      index.outputs[0].output = 'pipeline/visual/demo/publish/r001/xhs/post-01/01-cover.png';
    }],
  ])('blocks a generated revision when %s', async (_label, corrupt) => {
    await updateIndex('r002', corrupt);

    const state = await loadVisualWorkbenchState('demo');
    const revision = state?.revisions.find((item) => item.revisionId === 'r002');

    expect(revision?.status).toBe('blocked');
    expect(revision?.reason).toBeTruthy();
  });

  it('blocks a generated revision when an output file is missing or empty', async () => {
    const emptyOutput = outputs('r002')[0].output;
    await writeFile(path.join(mocks.projectDir, emptyOutput), '');

    const state = await loadVisualWorkbenchState('demo');
    const revision = state?.revisions.find((item) => item.revisionId === 'r002');

    expect(revision?.status).toBe('blocked');
    expect(revision?.reason).toMatch(/missing|empty|不存在|空/);
  });

  it('blocks a generated revision when non-empty output bytes no longer match the indexed digest', async () => {
    const outputPath = outputs('r002')[0].output;
    await writeFile(path.join(mocks.projectDir, outputPath), 'tampered but non-empty');

    const state = await loadVisualWorkbenchState('demo');
    const revision = state?.revisions.find((item) => item.revisionId === 'r002');

    expect(revision?.status).toBe('blocked');
    expect(revision?.reason).toContain('摘要');
  });

  it('blocks a canonical index whose revision id disagrees with its filename', async () => {
    await updateIndex('r002', (index) => {
      index.revision_id = 'r999';
    });

    const state = await loadVisualWorkbenchState('demo');
    const revision = state?.revisions.find((item) => item.revisionId === 'r002');

    expect(revision?.status).toBe('blocked');
    expect(revision?.reason).toBeTruthy();
  });
});

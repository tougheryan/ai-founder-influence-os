import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-production-operations-${process.pid}`,
  runtimeRun: null as Record<string, unknown> | null,
  validation: { valid: true, result: { valid: true } } as Record<string, unknown>,
  verification: { verified: false } as Record<string, unknown>,
  recoveredReport: null as Record<string, unknown> | null,
  visualState: null as Record<string, unknown> | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('./project-root', () => ({
  PROJECT_DIR: mocks.projectDir,
  safeResolve: (base: string, path: string) => `${base}/${path}`,
}));
vi.mock('./runtime-run-resolver', () => ({
  runtimeRunById: async () => mocks.runtimeRun,
}));
vi.mock('./runtime-writer', () => ({
  validateRuntimeOutput: async () => mocks.validation,
  verifyRuntimeTikomniMarketSnapshot: async () => mocks.verification,
  recoverRuntimeTikomniMarketReport: async () => mocks.recoveredReport,
}));
vi.mock('./visual-workbench', () => ({
  loadVisualWorkbenchState: async () => mocks.visualState,
}));

import {
  dispatchProductionTaskOperation,
  prepareProductionTaskOperation,
  reconcileProductionTaskOperation,
} from './production-task-operations';

async function save(path: string, body: string): Promise<void> {
  const segments = path.split('/');
  segments.pop();
  await mkdir(`${mocks.projectDir}/${segments.join('/')}`, { recursive: true });
  await writeFile(`${mocks.projectDir}/${path}`, body);
}

describe('paid production operation reconciliation', () => {
  it('binds author blueprint recovery to both intake and immutable author evidence', async () => {
    const intakePath = 'pipeline/intake/own.md';
    const evidencePath = 'runs/run-a/author-evidence/source.json';
    await save(intakePath, '# own material'); await save(evidencePath, '{"topic":"own"}');
    const task = { taskId: 'task_author_recovery', runId: 'run-a', kind: 'author-blueprint', request: { topic: 'own' }, result: { materialResearch: { intakePath }, topicBlueprint: { authorSource: { author_evidence_path: evidencePath } } } };
    const run = { run_id: 'run-a', slug: 'own', steps: {} as Record<string, { latest: string }> };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'content-blueprint', run);
    expect(operation?.operation_class).toBe('llm');
    dispatchProductionTaskOperation(operation!, new Date().toISOString());
    const path = 'pipeline/blueprint/own.md'; await save(path, '# own plan'); run.steps.blueprint = { latest: path };
    expect(await reconcileProductionTaskOperation(task, operation!)).toMatchObject({ completed: true, section: 'topicBlueprint', sectionPatch: { blueprintPath: path } });
    await save(evidencePath, '{"topic":"changed"}');
    expect(await reconcileProductionTaskOperation(task, operation!)).toMatchObject({ completed: false });
  });
  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    await mkdir(mocks.projectDir, { recursive: true });
    mocks.runtimeRun = null;
    mocks.validation = { valid: true, result: { valid: true } };
    mocks.verification = { verified: false };
    mocks.recoveredReport = null;
    mocks.visualState = null;
  });

  it('reconciles a new validated LLM artifact against the same source hash', async () => {
    const blueprintPath = 'pipeline/blueprint/demo.md';
    await save(blueprintPath, '# blueprint');
    const task = {
      taskId: 'task_llm_001',
      runId: 'run-a',
      kind: 'content-package',
      request: { slug: 'demo', topic: '主题', blueprintPath },
      result: { contentPackage: {} },
    };
    const run = {
      run_id: 'run-a',
      slug: 'demo',
      steps: { blueprint: { latest: blueprintPath } } as Record<string, { latest: string }>,
    };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'wechat-writer', run);
    dispatchProductionTaskOperation(operation!, new Date().toISOString());
    const articlePath = 'pipeline/write/demo.md';
    await save(articlePath, '# article');
    run.steps.write = { latest: articlePath };

    const reconciliation = await reconcileProductionTaskOperation(task, operation!);

    expect(reconciliation).toMatchObject({
      completed: true,
      section: 'contentPackage',
      sectionPatch: { articlePath },
      observed: { artifacts: [expect.objectContaining({ path: articlePath })] },
    });
  });

  it('fails closed when an LLM dispatch has no provably new output', async () => {
    const blueprintPath = 'pipeline/blueprint/demo.md';
    await save(blueprintPath, '# blueprint');
    const task = {
      taskId: 'task_llm_unknown',
      runId: 'run-a',
      kind: 'content-package',
      request: { slug: 'demo', topic: '主题', blueprintPath },
      result: { contentPackage: {} },
    };
    const run = { run_id: 'run-a', slug: 'demo', steps: { blueprint: { latest: blueprintPath } } };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'wechat-writer', run);
    dispatchProductionTaskOperation(operation!, new Date().toISOString());

    const reconciliation = await reconcileProductionTaskOperation(task, operation!);

    expect(reconciliation.completed).toBe(false);
    expect(reconciliation.reason).toContain('无法证明');
  });

  it('does not treat touching an identical pre-existing LLM artifact as proof', async () => {
    const blueprintPath = 'pipeline/blueprint/demo.md';
    const articlePath = 'pipeline/write/demo.md';
    await save(blueprintPath, '# blueprint');
    await save(articlePath, '# unchanged article');
    const task = {
      taskId: 'task_llm_same_output',
      runId: 'run-a',
      kind: 'content-package',
      request: { slug: 'demo', topic: '主题', blueprintPath },
      result: { contentPackage: {} },
    };
    const run = {
      run_id: 'run-a',
      slug: 'demo',
      steps: { blueprint: { latest: blueprintPath }, write: { latest: articlePath } },
    };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'wechat-writer', run);
    dispatchProductionTaskOperation(operation!, new Date().toISOString());
    await save(articlePath, '# unchanged article');

    const reconciliation = await reconcileProductionTaskOperation(task, operation!);

    expect(reconciliation.completed).toBe(false);
  });

  it('reconciles TikOmni only with a new run-bound three-platform snapshot', async () => {
    const intakePath = 'pipeline/intake/demo.md';
    await save(intakePath, '# intake');
    const task = {
      taskId: 'task_tikomni_001',
      runId: 'run-a',
      kind: 'material-research',
      request: { slug: 'demo' },
      result: { materialResearch: { intakePath } },
    };
    const run = { run_id: 'run-a', slug: 'demo', steps: { intake: { latest: intakePath } } };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'market-research', run);
    dispatchProductionTaskOperation(operation!, new Date().toISOString());

    const snapshotPath = 'runs/run-a/market-research/snapshot-001/snapshot.json';
    const snapshotSha256 = 'a'.repeat(64);
    await save(snapshotPath, JSON.stringify({
      created_at: new Date(Date.now() + 10).toISOString(),
      required_platforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
      queries: ['AI 创业'],
      platform_checks: { wechat_mp: { status: 'ready' } },
      signals: [{ platform: 'wechat_mp' }],
    }));
    await save(
      'materials/research/demo-market-signal.md',
      `# report\n\n- 研究快照：${snapshotPath}\n- 快照 SHA-256：${snapshotSha256}\n`,
    );
    mocks.verification = {
      verified: true,
      manifest_path: snapshotPath,
      snapshot_sha256: snapshotSha256,
      source_path: intakePath,
    };

    const reconciliation = await reconcileProductionTaskOperation(task, operation!);

    expect(reconciliation).toMatchObject({
      completed: true,
      section: 'materialResearch',
      sectionPatch: {
        reportPath: 'materials/research/demo-market-signal.md',
        snapshotPath,
        snapshotSha256,
        requiredPlatforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
      },
    });
  });

  it('rebuilds a missing TikOmni report from a verified snapshot without redispatch', async () => {
    const intakePath = 'pipeline/intake/demo.md';
    await save(intakePath, '# intake');
    const task = {
      taskId: 'task_tikomni_recover',
      runId: 'run-a',
      kind: 'material-research',
      request: { slug: 'demo' },
      result: { materialResearch: { intakePath } },
    };
    const run = { run_id: 'run-a', slug: 'demo', steps: { intake: { latest: intakePath } } };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'market-research', run);
    dispatchProductionTaskOperation(operation!, new Date().toISOString());

    const snapshotPath = 'runs/run-a/market-research/snapshot-recovered/snapshot.json';
    const snapshotSha256 = 'b'.repeat(64);
    const platformChecks = Object.fromEntries(
      ['wechat_mp', 'xiaohongshu', 'wechat_channels'].map((platform) => [platform, { status: 'available', sample_count: 3 }]),
    );
    await save(snapshotPath, JSON.stringify({
      created_at: new Date(Date.now() + 10).toISOString(),
      required_platforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
      queries: ['AI 创业'],
      platform_checks: platformChecks,
    }));
    mocks.verification = {
      verified: true,
      manifest_path: snapshotPath,
      snapshot_sha256: snapshotSha256,
      source_path: intakePath,
    };
    mocks.recoveredReport = {
      status: 'ready',
      sample_count: 9,
      snapshot_path: snapshotPath,
      snapshot_sha256: snapshotSha256,
      markdown: `# recovered\n\n- 研究快照：${snapshotPath}\n- 快照 SHA-256：${snapshotSha256}\n`,
    };

    const reconciliation = await reconcileProductionTaskOperation(task, operation!);

    expect(reconciliation).toMatchObject({
      completed: true,
      sectionPatch: {
        reportPath: 'materials/research/demo-market-signal.md',
        snapshotPath,
        snapshotSha256,
        sampleCount: 9,
      },
    });
  });

  it('reconciles visual generation only with cover, evidence and CTA assets', async () => {
    const packagePath = 'pipeline/package/demo.md';
    await save(packagePath, '# package');
    const task = {
      taskId: 'task_visual_001',
      runId: 'run-a',
      kind: 'visual-candidates',
      request: { slug: 'demo', packagePath, visualPreferences: { mode: 'ai_enhanced' } },
      result: { visualCandidates: {} },
    };
    const run = { run_id: 'run-a', slug: 'demo', steps: { package: { latest: packagePath } } };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'visual-candidates', run);
    dispatchProductionTaskOperation(operation!, new Date().toISOString());

    const recipePath = 'pipeline/visual/demo/recipes/r001.visual-recipe.json';
    const indexPath = 'pipeline/visual/demo/revisions/r001.index.json';
    const assets = [
      { id: 'xhs-p1', role: 'cover', path: 'pipeline/visual/demo/publish/r001/cover.png' },
      { id: 'xhs-p2', role: 'evidence', path: 'pipeline/visual/demo/publish/r001/evidence.png' },
      { id: 'xhs-p5', role: 'cta', path: 'pipeline/visual/demo/publish/r001/cta.png' },
    ];
    await save(recipePath, JSON.stringify({ slug: 'demo', source_package: packagePath }));
    await save(indexPath, JSON.stringify({ slug: 'demo', revision_id: 'r001' }));
    await Promise.all(assets.map((asset) => save(asset.path, asset.id)));
    mocks.visualState = {
      slug: 'demo',
      selectedRevisionId: 'r001',
      hasExplicitSelection: false,
      revisions: [{ revisionId: 'r001', recipePath, indexPath, status: 'ready' }],
      assets: assets.map((asset) => ({ ...asset, revisionId: 'r001', platform: 'xhs', status: 'generated', quality: 'pass' })),
      assetCandidates: assets.map((asset) => ({ ...asset, revisionId: 'r001', platform: 'xhs', status: 'generated', quality: 'pass' })),
      reviewAssets: [],
      comparison: [],
    };

    const reconciliation = await reconcileProductionTaskOperation(task, operation!);

    expect(reconciliation).toMatchObject({
      completed: true,
      section: 'visualCandidates',
      sectionPatch: { slug: 'demo' },
      observed: {
        revision_id: 'r001',
        artifacts: expect.arrayContaining([
          expect.objectContaining({ path: recipePath }),
          expect.objectContaining({ path: indexPath }),
          expect.objectContaining({ path: assets[0].path }),
          expect.objectContaining({ path: assets[1].path }),
          expect.objectContaining({ path: assets[2].path }),
        ]),
      },
    });
  });

  it('does not create a paid-operation journal for local stable layout', async () => {
    const packagePath = 'pipeline/package/stable.md';
    await save(packagePath, '# stable package');
    const task = {
      taskId: 'task_visual_stable',
      runId: 'run-a',
      kind: 'visual-candidates',
      request: { slug: 'demo', packagePath, visualPreferences: { mode: 'stable' } },
      result: { visualCandidates: {} },
    };
    const run = { run_id: 'run-a', slug: 'demo', steps: { package: { latest: packagePath } } };

    const operation = await prepareProductionTaskOperation(task, 'visual-candidates', run);

    expect(operation).toBeNull();
    expect(task).not.toHaveProperty('operationJournal');
  });
});

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-production-tasks-${process.pid}`,
  runtimeRun: null as Record<string, unknown> | null,
  verification: { verified: false } as Record<string, unknown>,
  recoveredReport: null as Record<string, unknown> | null,
  artifactBodies: new Map<string, string>(),
  modelKey: 'test-model-key',
  authorContext: {} as Record<string, unknown>,
  authorBinding: {} as Record<string, unknown>,
  selectAuthor: vi.fn(),
  invoke: vi.fn(async () => Response.json({ ok: true })),
  research: vi.fn(),
  publishVisual: vi.fn<(request: Request) => Promise<Response>>(async () => Response.json({ ok: true })),
  intakeResponse: { body: { ok: true }, status: 200 } as { body: Record<string, unknown>; status: number },
  marketSignalResponse: { body: { ok: true }, status: 200 } as {
    body: Record<string, unknown>;
    status: number;
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server-config', () => ({ resolveServerLLMConfig: async () => ({
  provider: 'deepseek', model: 'test-model', apiKey: mocks.modelKey,
}) }));
vi.mock('@/lib/llm-client', () => ({
  getApiKey: (config: { apiKey: string }) => config.apiKey,
  validateLLMConfig: () => [],
}));
vi.mock('@/app/api/agent/invoke/route', () => ({ POST: mocks.invoke }));
vi.mock('@/app/api/production/material-analysis/route', () => ({
  POST: async () => Response.json({
    ok: true,
    context: {
      inputFingerprint: 'a'.repeat(64),
      analysisStatus: 'current',
      selection: { materialTypeId: 'case', structureId: 'problem-solution' },
    },
  }),
}));
vi.mock('@/app/api/production/intake/route', () => ({ POST: async () => Response.json(mocks.intakeResponse.body, { status: mocks.intakeResponse.status }) }));
vi.mock('@/app/api/research/market-signal/route', () => ({
  POST: async () => { mocks.research(); return Response.json(mocks.marketSignalResponse.body, { status: mocks.marketSignalResponse.status }); },
}));
vi.mock('@/app/api/research/topic-selection/route', () => ({ POST: async () => Response.json({ ok: true }) }));
vi.mock('@/app/api/run/template/route', () => ({ POST: async () => Response.json({ ok: true }) }));
vi.mock('@/app/api/research/topic-suggestions/route', () => ({ POST: async () => Response.json({ ok: true }) }));
vi.mock('@/app/api/visual/publish/route', () => ({ POST: mocks.publishVisual }));
vi.mock('@/app/api/publish-assets/route', () => ({ POST: async () => Response.json({ ok: true }) }));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/output-files', () => ({
  readOutputFile: async (path: string) => {
    const body = mocks.artifactBodies.get(path);
    if (body === undefined) throw new Error('missing fixture');
    return body;
  },
  writeOutputFile: async (path: string, body: string) => {
    const fs = await import('node:fs/promises');
    const absolute = `${mocks.projectDir}/${path}`;
    await fs.mkdir(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(absolute, body);
    return path;
  },
}));
vi.mock('@/lib/content-release-gate', () => ({
  runContentReleaseGate: async (body: string) => ({
    status: body.includes('incomplete') ? 'blocked' : 'pass',
    repaired: false,
    blocking_issues: body.includes('incomplete') ? ['缺少平台内容'] : [],
    review_issues: [],
    units: [],
    package_manifest: { valid: !body.includes('incomplete') },
    repairedBody: body,
  }),
}));
vi.mock('@/lib/project-root', () => ({
  PROJECT_DIR: mocks.projectDir,
  safeResolve: (base: string, path: string) => `${base}/${path}`,
  redactLocalPaths: <T>(value: T) => value,
}));
vi.mock('@/lib/write-guard', () => ({
  withProjectWriteLock: async (_key: string, task: () => Promise<unknown>) => task(),
  writeFingerprint: (scope: string, payload: unknown) => `${scope}:${JSON.stringify(payload)}`,
}));
vi.mock('@/lib/production-task-authority', () => {
  class ProductionTaskAuthorityError extends Error {}
  return {
    ProductionTaskAuthorityError,
    assertProductionTaskRunAuthority: async () => mocks.runtimeRun || {},
  };
});
vi.mock('@/lib/runtime-run-resolver', () => ({
  runtimeRunById: async () => mocks.runtimeRun,
}));
vi.mock('@/lib/runtime-writer', () => ({
  getRuntimeAuthorSourceContext: async () => mocks.authorContext,
  selectRuntimeAuthorSource: mocks.selectAuthor,
  verifyRuntimeAuthorSource: async () => mocks.authorBinding,
  validateRuntimeOutput: async () => ({ valid: true, result: { valid: true } }),
  verifyRuntimeTikomniMarketSnapshot: async () => mocks.verification,
  recoverRuntimeTikomniMarketReport: async () => mocks.recoveredReport,
}));
vi.mock('@/lib/visual-workbench', () => ({ loadVisualWorkbenchState: async () => null }));

import {
  createOrReadProductionTask,
  getProductionTask,
  productionTaskPath,
  productionTaskResponse,
  recoverInterruptedProductionTask,
  refreshKnownLocalProductionTaskFailure,
  retryProductionTask,
  scheduleProductionTask,
} from './production-tasks';
import {
  dispatchProductionTaskOperation,
  markProductionTaskOperationIndeterminate,
  prepareProductionTaskOperation,
} from './production-task-operations';
import { authorAnalysisFingerprint } from './author-material-review';

describe('durable production task recovery', () => {
  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    mocks.selectAuthor.mockReset(); mocks.invoke.mockReset().mockImplementation(async () => Response.json({ ok: true })); mocks.research.mockClear();
    mocks.modelKey = 'test-model-key';
    mocks.intakeResponse = { body: { ok: true }, status: 200 };
    await rm(mocks.projectDir, { recursive: true, force: true });
    await mkdir(mocks.projectDir, { recursive: true });
    mocks.runtimeRun = null;
    mocks.verification = { verified: false };
    mocks.recoveredReport = null;
    mocks.artifactBodies = new Map();
    mocks.marketSignalResponse = { body: { ok: true }, status: 200 };
  });

  it('saves author material without research or model configuration and retries only the blocked step', async () => {
    const intakePath = 'pipeline/intake/own.md';
    const analysis = { summary: '先记录客户提出的具体改动' };
    mocks.modelKey = '';
    mocks.intakeResponse = { body: { path: intakePath }, status: 200 };
    mocks.authorContext = { intake_path: intakePath, intake_sha256: 'b'.repeat(64), material_sha256: 'c'.repeat(64), source_revision: 'd'.repeat(64), material: { input_fingerprint: 'a'.repeat(64), correction_id: '', analysis } };
    mocks.authorBinding = { run_id: 'author-a', slug: 'own', topic: '客户临时改需求', author_evidence_path: 'runs/author-a/author-evidence/author_a.json', author_evidence_sha256: 'e'.repeat(64) };
    mocks.selectAuthor.mockImplementation(async (request) => {
      const onDisk = await readFile(`${mocks.projectDir}/${productionTaskPath('author-a', 'task_author_test')}`, 'utf8');
      expect(JSON.parse(onDisk).result.materialResearch.authorSourceRequest.id).toBe(request.id);
      return mocks.authorBinding;
    });
    const { task } = await createOrReadProductionTask({ runId: 'author-a', taskId: 'task_author_test', kind: 'author-blueprint', request: { slug: 'own', topic: '客户临时改需求', inputFingerprint: 'a'.repeat(64), reviewedAnalysisSha256: await authorAnalysisFingerprint(analysis), selectedTypeId: 'case', selectedStructureId: 'problem-solution', platforms: ['wechat'] } });
    scheduleProductionTask(task.runId, task.taskId);
    await vi.waitFor(async () => expect((await getProductionTask(task.runId, task.taskId))?.status).toBe('blocked'));
    const saved = (await getProductionTask(task.runId, task.taskId))!;
    expect(saved.currentStep).toBe('content-blueprint');
    expect(saved.error?.code).toBe('model_setup_required');
    expect(saved.steps.slice(0, 4).every((step) => step.status === 'completed')).toBe(true);
    expect(saved.operationJournal?.operations).toHaveLength(0);
    const retried = await retryProductionTask(task.runId, task.taskId);
    scheduleProductionTask(retried.runId, retried.taskId);
    await vi.waitFor(async () => expect((await getProductionTask(task.runId, task.taskId))?.status).toBe('blocked'));
    expect(mocks.selectAuthor).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.research).not.toHaveBeenCalled();
    mocks.modelKey = 'test-model-key';
    mocks.runtimeRun = { run_id: 'author-a', slug: 'own', steps: { intake: { latest: intakePath } } };
    const evidencePath = String(mocks.authorBinding.author_evidence_path);
    for (const [path, body] of [[intakePath, '# own intake'], [evidencePath, '{"topic":"客户临时改需求"}']]) {
      await mkdir(`${mocks.projectDir}/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
      await writeFile(`${mocks.projectDir}/${path}`, body);
    }
    mocks.invoke.mockImplementationOnce(async (...args: unknown[]) => {
      const request = args[0] as Request;
      expect(await request.json()).toMatchObject({ skill: 'content-blueprint', params: { intakeReportPath: intakePath, topic: '客户临时改需求', platforms: ['wechat'] } });
      const path = 'pipeline/blueprint/own.md';
      await mkdir(`${mocks.projectDir}/pipeline/blueprint`, { recursive: true });
      await writeFile(`${mocks.projectDir}/${path}`, '# author plan');
      (mocks.runtimeRun!.steps as Record<string, unknown>).blueprint = { latest: path };
      return new Response(`data: ${JSON.stringify({ type: 'saved', path })}\n\ndata: [DONE]\n`);
    });
    await retryProductionTask(task.runId, task.taskId);
    scheduleProductionTask(task.runId, task.taskId);
    await vi.waitFor(async () => expect((await getProductionTask(task.runId, task.taskId))?.status).toBe('completed'));
    const completed = (await getProductionTask(task.runId, task.taskId))!;
    expect(completed.operationJournal?.operations).toHaveLength(1);
    expect(completed.operationJournal?.operations[0].state).toBe('task_committed');
    expect(mocks.selectAuthor).toHaveBeenCalledOnce(); expect(mocks.invoke).toHaveBeenCalledOnce(); expect(mocks.research).not.toHaveBeenCalled();
  });

  it('rejects changed understanding of the same input before selecting author evidence', async () => {
    mocks.intakeResponse = { body: { path: 'pipeline/intake/own.md' }, status: 200 };
    mocks.authorContext = { intake_path: 'pipeline/intake/own.md', material: { input_fingerprint: 'a'.repeat(64), correction_id: '', analysis: { summary: 'new understanding' } } };
    const { task } = await createOrReadProductionTask({ runId: 'author-stale', kind: 'author-blueprint', request: { topic: '自己的题目', inputFingerprint: 'a'.repeat(64), reviewedAnalysisSha256: await authorAnalysisFingerprint({ summary: 'old understanding' }), selectedTypeId: 'case', selectedStructureId: 'problem-solution' } });
    scheduleProductionTask(task.runId, task.taskId);
    await vi.waitFor(async () => expect((await getProductionTask(task.runId, task.taskId))?.status).toBe('blocked'));
    expect((await getProductionTask(task.runId, task.taskId))?.error?.code).toBe('author_source_changed');
    expect(mocks.selectAuthor).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.research).not.toHaveBeenCalled();
  });

  it('keeps the intake-specific action and code through persisted tasks and browser projection', async () => {
    mocks.intakeResponse = { status: 500, body: { code: 'material_report_invalid', error: 'secret=sk-super-secret /Users/alice/private.json' } };
    const { task } = await createOrReadProductionTask({
      runId: 'intake-failure', kind: 'material-research',
      request: { selectedTypeId: 'case', selectedStructureId: 'problem-solution' },
    });
    scheduleProductionTask(task.runId, task.taskId);
    await vi.waitFor(async () => expect((await getProductionTask(task.runId, task.taskId))?.status).toBe('failed'));
    const saved = (await getProductionTask(task.runId, task.taskId))!;
    expect(saved.currentStep).toBe('material-intake');
    expect(saved.error?.code).toBe('material_report_invalid');
    expect(saved.error?.displayMessage).toContain('联系支持');
    expect(saved.steps.find((step) => step.id === 'market-research')?.status).toBe('pending');
    const projected = productionTaskResponse(saved);
    expect(projected.error?.displayMessage).toContain('原素材和上次结果已保留');
    expect(projected.error?.displayMessage).toContain('没有调用模型或平台数据服务');
    expect(JSON.stringify(projected)).not.toMatch(/sk-super-secret|\/Users\/alice/);
  });

  it('keeps the user-facing task step labels direct while preserving internal step IDs', async () => {
    const definitions = [
      ['material-research', ['material-analysis', 'material-intake', 'market-research', 'topic-suggestions'], ['确认素材理解', '整理素材要点', '查看已选平台的同类内容', '生成主题建议']],
      ['topic-blueprint', ['topic-selection', 'template-binding', 'content-validate', 'content-blueprint'], ['保存选题', '保存排版样式', '检查选题依据', '生成各平台内容蓝图']],
      ['content-package', ['content-package'], ['分别生成已选平台的原生内容']],
      ['visual-candidates', ['visual-candidates'], ['生成平台完整发布件']],
      ['draft-queue', ['draft-queue'], ['整理发布内容']],
    ] as const;

    for (const [kind, ids, labels] of definitions) {
      const { task } = await createOrReadProductionTask({
        runId: `copy-${kind}`,
        taskId: `task_copy_${kind.replaceAll('-', '_')}`,
        kind,
        request: {},
      });
      expect(task.steps.map((step) => step.id)).toEqual(ids);
      expect(task.steps.map((step) => step.label)).toEqual(labels);
    }
  });

  it('rejects a new writing task before persisting any task when setup is missing', async () => {
    mocks.modelKey = '';
    for (const kind of ['topic-blueprint', 'content-package'] as const) {
      await expect(createOrReadProductionTask({ runId: 'missing-model', taskId: `task_missing_${kind}`, kind, request: {} }))
        .rejects.toMatchObject({ status: 422, definition: { code: 'model_setup_required' } });
      expect(await getProductionTask('missing-model', `task_missing_${kind}`)).toBeNull();
    }
    expect((await createOrReadProductionTask({ runId: 'local-material', kind: 'material-research', request: {} })).created).toBe(true);
  });

  it('still reads duplicate saved tasks without a model key', async () => {
    const input = { runId: 'saved-model', taskId: 'task_saved_model', kind: 'topic-blueprint' as const, request: {} };
    const first = await createOrReadProductionTask(input);
    mocks.modelKey = '';
    expect(await createOrReadProductionTask(input)).toEqual({ task: first.task, created: false });
  });

  it('rejects retries before changing an existing blocked task when setup is still missing', async () => {
    const { task } = await createOrReadProductionTask({ runId: 'retry-setup', taskId: 'task_retry_setup', kind: 'content-package', request: {} });
    task.status = 'blocked';
    task.steps[0].status = 'blocked';
    task.error = { code: 'model_setup_required', displayMessage: '缺少模型连接' };
    const path = `${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`;
    await writeFile(path, JSON.stringify(task));
    const before = await readFile(path, 'utf8');
    mocks.modelKey = '';
    await expect(retryProductionTask(task.runId, task.taskId)).rejects.toMatchObject({ definition: { code: 'model_setup_required' } });
    expect(await readFile(path, 'utf8')).toBe(before);
    mocks.modelKey = 'test-model-key';
    expect((await retryProductionTask(task.runId, task.taskId)).status).toBe('queued');
  });

  it('also blocks a model key removed after task creation before dispatch', async () => {
    const { task } = await createOrReadProductionTask({
      runId: 'missing-model', kind: 'topic-blueprint',
      request: { slug: 'missing-model', topic: '可发布文章', template: 'wechat-native' },
    });
    mocks.modelKey = '';
    scheduleProductionTask(task.runId, task.taskId);
    await vi.waitFor(async () => {
      const result = await getProductionTask(task.runId, task.taskId);
      expect(result?.status).toBe('blocked');
      expect(result?.error?.code).toBe('model_setup_required');
      expect(result?.steps.find((step) => step.id === 'content-validate')?.operationId).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('operation_outcome_unknown');
      expect(JSON.stringify(result)).not.toContain('test-model-key');
    });
  });

  it('atomically resumes a local-only step persisted as running', async () => {
    const { task } = await createOrReadProductionTask({
      runId: 'run-a',
      taskId: 'task_material_001',
      kind: 'material-research',
      request: {
        slug: 'slug-a',
        selectedTypeId: 'case',
        selectedStructureId: 'problem-solution',
      },
    });
    const path = `${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`;
    const interrupted = JSON.parse(await readFile(path, 'utf8'));
    interrupted.status = 'running';
    interrupted.currentStep = 'material-intake';
    interrupted.steps[0].status = 'completed';
    interrupted.steps[1].status = 'running';
    interrupted.steps[1].startedAt = '2026-08-24T00:00:00.000Z';
    await writeFile(path, JSON.stringify(interrupted, null, 2));

    const recovered = await recoverInterruptedProductionTask(task.runId, task.taskId);
    const persisted = await getProductionTask(task.runId, task.taskId);

    expect(recovered.recovered).toBe(true);
    expect(recovered.task.status).toBe('queued');
    expect(recovered.task.currentStep).toBeNull();
    expect(recovered.task.resumableFrom).toBe('material-intake');
    expect(recovered.task.steps[1]).toMatchObject({ status: 'pending' });
    expect(recovered.task.steps[1].startedAt).toBeUndefined();
    expect(persisted).toEqual(recovered.task);
  });

  it('blocks an interrupted legacy paid step that has no dispatch journal', async () => {
    const { task } = await createOrReadProductionTask({
      runId: 'run-a',
      taskId: 'task_content_legacy',
      kind: 'content-package',
      request: { slug: 'slug-a', topic: '主题', blueprintPath: 'pipeline/blueprint/slug-a.md' },
    });
    const path = `${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`;
    const interrupted = JSON.parse(await readFile(path, 'utf8'));
    interrupted.status = 'running';
    interrupted.currentStep = 'wechat-writer';
    interrupted.steps[0].status = 'running';
    await writeFile(path, JSON.stringify(interrupted, null, 2));

    const recovered = await recoverInterruptedProductionTask(task.runId, task.taskId);

    expect(recovered.task.status).toBe('blocked');
    expect(recovered.task.steps[0].status).toBe('blocked');
    expect(recovered.task.error?.code).toBe('operation_outcome_unknown');
    expect(recovered.task.error).toMatchObject({
      code: 'operation_outcome_unknown',
      displayMessage: expect.any(String),
      debugId: expect.stringMatching(/^err_/),
    });
    expect(recovered.task.error).not.toHaveProperty('message');
    expect(recovered.task.error).not.toHaveProperty('details');
  });

  it('queues a prepared paid operation because no provider dispatch was persisted', async () => {
    const { task } = await createOrReadProductionTask({
      runId: 'run-a',
      taskId: 'task_content_prepared',
      kind: 'content-package',
      request: { slug: 'slug-a', topic: '主题', blueprintPath: 'pipeline/blueprint/slug-a.md' },
    });
    const path = `${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`;
    const interrupted = JSON.parse(await readFile(path, 'utf8'));
    interrupted.status = 'running';
    interrupted.currentStep = 'wechat-writer';
    interrupted.steps[0].status = 'running';
    interrupted.steps[0].operationId = 'op_prepared';
    interrupted.operationJournal = {
      schema: 'aifios.production-operation-journal.v1',
      operations: [{
        operation_id: 'op_prepared',
        step_id: 'wechat-writer',
        attempt: 1,
        operation_class: 'llm',
        request_fingerprint: 'a'.repeat(64),
        state: 'prepared',
        prepared_at: '2026-08-24T00:00:00.000Z',
        expected: { run_id: 'run-a', run_slug: 'slug-a', source_paths: [] },
        baseline: {},
      }],
    };
    await writeFile(path, JSON.stringify(interrupted, null, 2));

    const recovered = await recoverInterruptedProductionTask(task.runId, task.taskId);

    expect(recovered.task.status).toBe('queued');
    expect(recovered.task.steps[0]).toMatchObject({ status: 'pending' });
    expect(recovered.task.steps[0].operationId).toBeUndefined();
    expect(recovered.task.operationJournal?.operations[0]).toMatchObject({
      state: 'abandoned',
      manual_retry_at: expect.any(String),
    });
  });

  it('reconciles a dispatched LLM artifact and advances without redispatching it', async () => {
    const blueprintPath = 'pipeline/blueprint/slug-a.md';
    await mkdir(`${mocks.projectDir}/pipeline/blueprint`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${blueprintPath}`, '# blueprint');
    const { task } = await createOrReadProductionTask({
      runId: 'run-a',
      taskId: 'task_content_reconcile',
      kind: 'content-package',
      request: { slug: 'slug-a', topic: '主题', blueprintPath },
    });
    const run = {
      run_id: 'run-a',
      slug: 'slug-a',
      topic: '主题',
      steps: { blueprint: { latest: blueprintPath } },
    };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'content-package', run);
    expect(operation).not.toBeNull();
    task.status = 'running';
    task.currentStep = 'content-package';
    task.steps[0].status = 'running';
    task.steps[0].operationId = operation?.operation_id;
    dispatchProductionTaskOperation(operation!, new Date().toISOString());

    const packagePath = 'pipeline/package/slug-a.md';
    await mkdir(`${mocks.projectDir}/pipeline/package`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${packagePath}`, '# native package');
    (run.steps as Record<string, { latest: string }>).package = { latest: packagePath };
    await mkdir(`${mocks.projectDir}/runs/run-a/tasks`, { recursive: true });
    await writeFile(
      `${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`,
      JSON.stringify(task, null, 2),
    );

    const recovered = await recoverInterruptedProductionTask(task.runId, task.taskId);

    expect(recovered.task.steps[0]).toMatchObject({
      status: 'completed',
      result: { packagePath },
    });
    expect(recovered.task.status).toBe('completed');
    expect(recovered.task.resumableFrom).toBeNull();
    expect(recovered.task.operationJournal?.operations[0]).toMatchObject({
      state: 'task_committed',
      observed: { artifacts: [expect.objectContaining({ path: packagePath })] },
    });
  });

  it('preserves the exact partial-attempt receipt when generation is blocked', async () => {
    const blueprintPath = 'pipeline/blueprint/partial.md';
    await mkdir(`${mocks.projectDir}/pipeline/blueprint`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${blueprintPath}`, '# blueprint');
    mocks.runtimeRun = { run_id: 'partial-run', slug: 'partial', steps: { blueprint: { latest: blueprintPath } } };
    const attemptId = `attempt_${'a'.repeat(32)}`;
    mocks.invoke.mockImplementationOnce(async () => new Response([
      { type: 'partial', attemptId },
      { type: 'error', code: 'content_release_blocked', content: '内容尚未完整。' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
    const { task } = await createOrReadProductionTask({ runId: 'partial-run', kind: 'content-package', request: { slug: 'partial', blueprintPath } });
    scheduleProductionTask(task.runId, task.taskId);
    await vi.waitFor(async () => expect((await getProductionTask(task.runId, task.taskId))?.status).toBe('blocked'));
    expect((await getProductionTask(task.runId, task.taskId))?.result.contentPackage).toMatchObject({ attemptId });
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it('uses an indeterminate TikOmni snapshot on retry instead of creating another operation', async () => {
    const intakePath = 'pipeline/intake/slug-a.md';
    await mkdir(`${mocks.projectDir}/pipeline/intake`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${intakePath}`, '# intake');
    const { task } = await createOrReadProductionTask({
      runId: 'run-a',
      taskId: 'task_market_recover',
      kind: 'material-research',
      request: { slug: 'slug-a', selectedTypeId: 'case', selectedStructureId: 'problem-solution' },
    });
    task.result = { materialResearch: { intakePath } };
    const run = { run_id: 'run-a', slug: 'slug-a', steps: { intake: { latest: intakePath } } };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'market-research', run);
    dispatchProductionTaskOperation(operation!, new Date().toISOString());
    markProductionTaskOperationIndeterminate(operation!, '报告未落盘');
    const step = task.steps.find((item) => item.id === 'market-research')!;
    step.status = 'blocked';
    step.operationId = operation!.operation_id;
    step.error = '结果未知';
    task.status = 'blocked';
    task.currentStep = step.id;
    task.resumableFrom = step.id;
    task.error = { message: '结果未知', code: 'operation_outcome_unknown', stepId: step.id };

    const snapshotPath = 'runs/run-a/market-research/snapshot-recovered/snapshot.json';
    const snapshotSha256 = 'c'.repeat(64);
    await mkdir(`${mocks.projectDir}/runs/run-a/market-research/snapshot-recovered`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${snapshotPath}`, JSON.stringify({
      created_at: new Date(Date.now() + 10).toISOString(),
      required_platforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
      queries: ['AI 创业'],
      platform_checks: Object.fromEntries(
        ['wechat_mp', 'xiaohongshu', 'wechat_channels'].map((platform) => [platform, { status: 'available', sample_count: 3 }]),
      ),
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
    await mkdir(`${mocks.projectDir}/runs/run-a/tasks`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`, JSON.stringify(task, null, 2));

    const retried = await retryProductionTask(task.runId, task.taskId);

    expect(retried.steps.find((item) => item.id === 'market-research')).toMatchObject({ status: 'completed' });
    expect(retried.resumableFrom).toBe('topic-suggestions');
    expect(retried.operationJournal?.operations).toHaveLength(1);
    expect(retried.operationJournal?.operations[0]).toMatchObject({ state: 'task_committed' });
  });

  it('recovers an indeterminate LLM artifact without dispatching another model request', async () => {
    const intakePath = 'pipeline/intake/slug-a.md';
    const reportPath = 'materials/research/slug-a-market-signal.md';
    const snapshotPath = 'runs/run-a/market-research/snapshot/snapshot.json';
    for (const [path, content] of [
      [intakePath, '# intake'],
      [reportPath, '# market report'],
      [snapshotPath, '{}'],
    ] as const) {
      await mkdir(`${mocks.projectDir}/${path.slice(0, path.lastIndexOf('/'))}`, { recursive: true });
      await writeFile(`${mocks.projectDir}/${path}`, content);
    }
    const { task } = await createOrReadProductionTask({
      runId: 'run-a',
      taskId: 'task_validate_recover',
      kind: 'topic-blueprint',
      request: {
        intakePath,
        reportPath,
        snapshotPath,
        topic: '把内容获客拆成动作',
        templateId: 'ft',
      },
    });
    task.result = { topicBlueprint: { topic: '把内容获客拆成动作', runSlug: 'slug-a' } };
    const run = {
      run_id: 'run-a',
      slug: 'slug-a',
      steps: {} as Record<string, { latest: string }>,
    };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'content-validate', run);
    dispatchProductionTaskOperation(operation!, new Date(Date.now() - 1_000).toISOString());
    const validatePath = 'pipeline/validate/slug-a-validate.md';
    await mkdir(`${mocks.projectDir}/pipeline/validate`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${validatePath}`, '# valid report');
    run.steps.validate = { latest: validatePath };
    markProductionTaskOperationIndeterminate(operation!, '任务提交状态丢失');
    const step = task.steps.find((item) => item.id === 'content-validate')!;
    step.status = 'blocked';
    step.operationId = operation!.operation_id;
    task.status = 'blocked';
    task.currentStep = step.id;
    task.resumableFrom = step.id;
    task.error = { message: '结果未知', code: 'operation_outcome_unknown', stepId: step.id };
    await mkdir(`${mocks.projectDir}/runs/run-a/tasks`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`, JSON.stringify(task, null, 2));

    const retried = await retryProductionTask(task.runId, task.taskId, 'recover');

    expect(retried.steps.find((item) => item.id === 'content-validate')).toMatchObject({
      status: 'completed',
      result: { validatePath },
    });
    expect(retried.resumableFrom).toBe('content-blueprint');
    expect(retried.operationJournal?.operations).toHaveLength(1);
    expect(retried.operationJournal?.operations[0]).toMatchObject({ state: 'task_committed' });
  });

  it('allows an explicit redispatch when an indeterminate TikOmni attempt has no snapshot', async () => {
    const intakePath = 'pipeline/intake/slug-a.md';
    await mkdir(`${mocks.projectDir}/pipeline/intake`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${intakePath}`, '# intake');
    const { task } = await createOrReadProductionTask({
      runId: 'run-a',
      taskId: 'task_market_redispatch',
      kind: 'material-research',
      request: { slug: 'slug-a', selectedTypeId: 'case', selectedStructureId: 'problem-solution' },
    });
    task.result = { materialResearch: { intakePath } };
    const run = { run_id: 'run-a', slug: 'slug-a', steps: { intake: { latest: intakePath } } };
    mocks.runtimeRun = run;
    const operation = await prepareProductionTaskOperation(task, 'market-research', run);
    dispatchProductionTaskOperation(operation!, new Date().toISOString());
    markProductionTaskOperationIndeterminate(operation!, '没有完整快照');
    const step = task.steps.find((item) => item.id === 'market-research')!;
    step.status = 'blocked';
    step.operationId = operation!.operation_id;
    step.error = '结果未知';
    task.status = 'blocked';
    task.currentStep = step.id;
    task.resumableFrom = step.id;
    task.error = { message: '结果未知', code: 'operation_outcome_unknown', stepId: step.id };
    await mkdir(`${mocks.projectDir}/runs/run-a/tasks`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`, JSON.stringify(task, null, 2));

    const retried = await retryProductionTask(task.runId, task.taskId, 'redispatch');

    expect(retried).toMatchObject({
      status: 'queued',
      currentStep: null,
      resumableFrom: 'market-research',
      error: undefined,
    });
    expect(retried.steps.find((item) => item.id === 'market-research')).toMatchObject({ status: 'pending' });
    expect(retried.steps.find((item) => item.id === 'market-research')?.operationId).toBeUndefined();
    expect(retried.operationJournal?.operations).toHaveLength(1);
    expect(retried.operationJournal?.operations[0]).toMatchObject({
      state: 'abandoned',
      manual_retry_at: expect.any(String),
    });
  });

  it('keeps an authoritative TikOmni platform blocker retryable instead of marking the outcome unknown', async () => {
    const intakePath = 'pipeline/intake/slug-a.md';
    await mkdir(`${mocks.projectDir}/pipeline/intake`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${intakePath}`, '# intake');
    const { task } = await createOrReadProductionTask({
      runId: 'run-a',
      taskId: 'task_market_known_blocker',
      kind: 'material-research',
      request: { slug: 'slug-a', selectedTypeId: 'case', selectedStructureId: 'problem-solution' },
    });
    task.steps[0].status = 'completed';
    task.steps[1].status = 'completed';
    task.result = { materialResearch: { intakePath } };
    mocks.runtimeRun = { run_id: 'run-a', slug: 'slug-a', steps: { intake: { latest: intakePath } } };
    mocks.marketSignalResponse = {
      status: 424,
      body: {
        blocked: true,
        operationOutcome: 'known_blocked',
        message: 'TypeError: token=sk-super-secret at /Users/alice/private/task.ts:9',
        blockers: [{ code: 'platform_unavailable', platform: 'xiaohongshu', message: '/Users/alice/private/report.json' }],
      },
    };
    await mkdir(`${mocks.projectDir}/runs/run-a/tasks`, { recursive: true });
    await writeFile(`${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`, JSON.stringify(task, null, 2));

    scheduleProductionTask(task.runId, task.taskId);
    let persisted = await getProductionTask(task.runId, task.taskId);
    for (let attempt = 0; attempt < 50 && persisted?.status !== 'blocked'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      persisted = await getProductionTask(task.runId, task.taskId);
    }

    expect(persisted).toMatchObject({
      status: 'blocked',
      currentStep: 'market-research',
      error: {
        code: 'tikomni_blocked',
        displayMessage: expect.any(String),
        debugId: expect.stringMatching(/^err_/),
      },
    });
    expect(persisted?.error).not.toHaveProperty('message');
    expect(persisted?.error).not.toHaveProperty('details');
    expect(JSON.stringify(persisted?.error)).not.toMatch(/sk-super-secret|\/Users\/alice|TypeError|task\.ts/i);
    expect(persisted?.operationJournal?.operations[0]).toMatchObject({
      state: 'abandoned',
      outcome_reason: expect.not.stringMatching(/sk-super-secret|\/Users\/alice|TypeError|task\.ts/i),
    });
  });

  it('retains the regeneration flag in the durable task and forwards it after reload', async () => {
    const packagePath = 'pipeline/package/complete.md';
    mocks.modelKey = '';
    mocks.artifactBodies.set(packagePath, '# complete package');
    const { task } = await createOrReadProductionTask({
      runId: 'run-visual-again', taskId: 'task_visual_again', kind: 'visual-candidates',
      request: { slug: 'demo', packagePath, regenerate: true },
    });
    const restored = await getProductionTask(task.runId, task.taskId);
    expect(restored?.request.regenerate).toBe(true);
    scheduleProductionTask(task.runId, task.taskId);
    await vi.waitFor(async () => expect((await getProductionTask(task.runId, task.taskId))?.status).toBe('completed'));
    const request = mocks.publishVisual.mock.calls.at(-1)?.[0];
    expect(request).toBeDefined();
    expect(await request!.json()).toMatchObject({ regenerate: true, slug: 'demo', packagePath, previewOnly: false });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('reclassifies a legacy stable-layout unknown outcome as an incomplete content package without a fee warning', async () => {
    const packagePath = 'pipeline/package/incomplete.md';
    mocks.artifactBodies.set(packagePath, '# incomplete package');
    const { task } = await createOrReadProductionTask({
      runId: 'run-stable-visual',
      taskId: 'task_stable_visual_unknown',
      kind: 'visual-candidates',
      request: { slug: 'demo', packagePath, visualPreferences: { mode: 'stable' } },
    });
    const path = `${mocks.projectDir}/${productionTaskPath(task.runId, task.taskId)}`;
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    persisted.status = 'blocked';
    persisted.currentStep = 'visual-candidates';
    persisted.resumableFrom = 'visual-candidates';
    persisted.error = {
      code: 'operation_outcome_unknown',
      displayMessage: '外部操作结果未知。',
      debugId: 'err_legacy_visual',
      stepId: 'visual-candidates',
    };
    persisted.steps[0].status = 'blocked';
    persisted.steps[0].error = persisted.error;
    await writeFile(path, JSON.stringify(persisted, null, 2));

    const refreshed = await refreshKnownLocalProductionTaskFailure(persisted);
    const projected = productionTaskResponse(refreshed);

    expect(refreshed).toMatchObject({
      status: 'blocked',
      error: { code: 'content_package_incomplete' },
      steps: [{ status: 'blocked', error: { code: 'content_package_incomplete' } }],
    });
    expect(projected.retryMayCharge).toBe(false);
    expect(projected.error?.displayMessage).toContain('第 3 步');
  });

  it('projects legacy task errors without raw messages, request bodies, or operation journals', async () => {
    const { task } = await createOrReadProductionTask({
      runId: 'run-legacy-projection',
      taskId: 'task_legacy_projection',
      kind: 'content-package',
      request: { slug: 'demo', topic: '主题', blueprintPath: 'pipeline/blueprint/demo.md' },
    });
    task.status = 'failed';
    task.request = { rawMaterial: '不可发送的原始输入', blueprintPath: '/Users/alice/private/blueprint.md' };
    task.error = {
      code: 'provider_failed',
      message: 'TypeError: token=sk-super-secret at /Users/alice/private/provider.ts:19',
      details: { stack: 'at provider (/Users/alice/private/provider.ts:19)', hash: 'a'.repeat(64) },
      stepId: 'wechat-writer',
    };
    task.steps[0].status = 'failed';
    task.steps[0].error = 'SyntaxError: JSON payload at /Users/alice/private/result.json token=sk-another-secret';
    task.operationJournal = {
      schema: 'aifios.production-operation-journal.v1',
      operations: [],
    };

    const projected = productionTaskResponse(task);
    const serialized = JSON.stringify(projected);

    expect(projected.request).toEqual({});
    expect(projected.operationJournal).toBeUndefined();
    expect(projected.error).toMatchObject({
      code: 'provider_failed',
      displayMessage: expect.any(String),
      debugId: expect.stringMatching(/^err_/),
    });
    expect(projected.steps[0].error).toMatchObject({
      code: 'production_task_failed',
      displayMessage: expect.any(String),
      debugId: expect.stringMatching(/^err_/),
    });
    expect(serialized).not.toMatch(/sk-super-secret|sk-another-secret|\/Users\/alice|TypeError|SyntaxError|rawMaterial|operationJournal|provider\.ts|result\.json/i);
  });

  it('rejects reuse of one task ID with a different persisted input payload', async () => {
    const base = {
      runId: 'run-a',
      taskId: 'task_content_001',
      kind: 'content-package' as const,
    };
    await createOrReadProductionTask({
      ...base,
      request: { slug: 'slug-a', topic: '主题', blueprintPath: 'pipeline/blueprint/slug-a.md' },
    });

    await expect(createOrReadProductionTask({
      ...base,
      request: { slug: 'slug-a', topic: '主题', blueprintPath: 'pipeline/blueprint/slug-b.md' },
    })).rejects.toThrow('同一任务编号已绑定不同');
  });
});

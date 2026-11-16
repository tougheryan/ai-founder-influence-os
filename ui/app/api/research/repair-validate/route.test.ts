import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gateError: null as Error | null,
  gateCalls: [] as Array<{ marketContent: string; intakePath: string; runId: string; label: string }>,
  buildCalls: 0,
  languageError: null as Error | null,
  writeCalls: [] as Array<{ step: string; slug: string; content: string; source: string; runId?: string }>,
  targetRunId: 'topic-run',
  sourceRuns: [{
    run_id: 'topic-run',
    slug: 'topic',
    steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
  }],
  files: {
    'pipeline/intake/topic-intake.md': '# 素材理解报告',
    'materials/research/low-evidence-plan.md': '# 低证据通行方案',
    'materials/research/topic-market-signal.md': '# 爆款抓取与对标报告',
  } as Record<string, string>,
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/output-files', () => ({
  readOutputFile: async (path: string) => {
    if (!(path in mocks.files)) throw new Error(`missing fixture: ${path}`);
    return mocks.files[path];
  },
}));
vi.mock('@/lib/public-research', () => ({
  assertGeneratedResearchLanguage: () => {
    if (mocks.languageError) throw mocks.languageError;
    return [];
  },
  buildRepairedValidateMarkdown: () => {
    mocks.buildCalls += 1;
    return {
      markdown: '# 选题立项报告\n\n## 0. 素材来源',
      title: '低证据立项修复',
      route: 'reframe',
      platform: 'all',
    };
  },
}));
vi.mock('@/lib/runtime-run-resolver', () => ({
  runsForPipelinePath: async () => mocks.sourceRuns,
  resolveRuntimeWriteTarget: async () => ({ slug: 'topic', runId: mocks.targetRunId }),
}));
vi.mock('@/lib/runtime-writer', () => ({
  validateRuntimeOutput: async () => ({ valid: true, result: { valid: true } }),
  writeRuntimeOutput: async (step: string, slug: string, content: string, source: string, runId?: string) => {
    mocks.writeCalls.push({ step, slug, content, source, runId });
    return 'pipeline/validate/topic-validate.md';
  },
}));
vi.mock('@/lib/tikomni-market-gate', () => ({
  assertMarketSnapshotBoundToIntake: async (
    marketContent: string,
    intakePath: string,
    runId: string,
    label: string,
  ) => {
    mocks.gateCalls.push({ marketContent, intakePath, runId, label });
    if (mocks.gateError) throw mocks.gateError;
    return {
      snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshotSha256: 'a'.repeat(64),
    };
  },
}));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));

import { POST } from './route';

function request() {
  return new Request('http://localhost/api/research/repair-validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourcePath: 'pipeline/intake/topic-intake.md',
      passagePlanPath: 'materials/research/low-evidence-plan.md',
      marketSignalPath: 'materials/research/topic-market-signal.md',
      slug: 'topic',
    }),
  });
}

describe('POST /api/research/repair-validate', () => {
  beforeEach(() => {
    mocks.gateError = null;
    mocks.gateCalls = [];
    mocks.buildCalls = 0;
    mocks.languageError = null;
    mocks.writeCalls = [];
    mocks.targetRunId = 'topic-run';
    mocks.sourceRuns = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];
  });

  it('blocks before build or write when the current intake is not bound to a valid TikOmni snapshot', async () => {
    mocks.gateError = new Error('TikOmni 研究快照未通过校验：source_material_sha256_mismatch');

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: '平台数据不完整或已经变化，请重新获取后再继续。',
      code: 'platform_data_refresh_required',
    });
    expect(mocks.buildCalls).toBe(0);
    expect(mocks.writeCalls).toEqual([]);
  });

  it('writes the repaired validation report only into the same verified intake run', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.gateCalls).toEqual([{
      marketContent: '# 爆款抓取与对标报告',
      intakePath: 'pipeline/intake/topic-intake.md',
      runId: 'topic-run',
      label: '爆款抓取与对标报告',
    }]);
    expect(mocks.writeCalls).toEqual([{
      step: 'validate',
      slug: 'topic',
      content: '# 选题立项报告\n\n## 0. 素材来源',
      source: 'ui-repair:materials/research/low-evidence-plan.md',
      runId: 'topic-run',
    }]);
  });

  it('does not write when the generated report fails the pre-write language gate', async () => {
    mocks.languageError = new Error('作为 AI，我建议使用 {{待补充}}。');

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.buildCalls).toBe(1);
    expect(mocks.writeCalls).toEqual([]);
  });

  it('does not fall back to another active run when the resolved target differs', async () => {
    mocks.targetRunId = 'other-run';

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: '当前任务已经变化，请刷新后重试。',
      code: 'task_changed',
    });
    expect(mocks.writeCalls).toEqual([]);
  });
});

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyWritingBrief } from '@/lib/writing-brief';

const mocks = vi.hoisted(() => ({
  approval: { approved: false, reason: '尚未进行负责人确认' } as {
    approved: boolean;
    reason?: string;
    run_id?: string;
    path?: string;
    sha256?: string;
    method?: string;
  },
  llmCalled: false,
  llmOptions: {} as Record<string, unknown>,
  failStream: false,
  attempts: [] as Array<Record<string, unknown>>,
  checkpoints: [] as string[],
  llmResponse: ['# 母稿'] as string[],
  llmSystemMessage: '',
  llmUserMessage: '',
  libraryContext: '',
  advisorContext: '',
  creativeContext: '',
  materialContext: null as Record<string, unknown> | null,
  materialContextCalls: [] as string[],
  materialAnalysisCurrent: true,
  invalidateMaterialDuringGeneration: false,
  changeMaterialDirectionDuringGeneration: false,
  changeMaterialAnalysisDuringGeneration: false,
  changeMaterialAnalysisAtRelease: false,
  lockKeys: [] as string[],
  writeTargetRequests: [] as Array<Record<string, unknown>>,
  writes: [] as string[],
  files: {} as Record<string, string>,
  runs: [{
    run_id: 'topic-run',
    slug: 'topic',
    steps: { blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' } },
  }] as Array<{ run_id: string; slug: string; status?: string; research_mode?: string; steps: Record<string, { latest: string }> }>,
  marketVerification: {
    verified: true,
    run_id: 'topic-run',
    manifest_path: 'runs/topic-run/market-research/fixture/snapshot.json',
    snapshot_sha256: 'a'.repeat(64),
    source_path: 'pipeline/intake/topic-intake.md',
  } as Record<string, unknown>,
  marketVerificationCalls: [] as Array<{ runId: string; snapshotPath: string }>,
  marketContextCalls: [] as Array<{ binding: unknown; runId: string }>,
  authorCalls: 0,
  changeAuthorDuringGeneration: false,
  authorInvalid: false,
  rejectedSkill: '',
  targetRunId: 'topic-run',
  releaseGate: {
    status: 'pass' as 'pass' | 'review_required' | 'blocked',
    repaired: false,
    blocking_issues: [] as string[],
    review_issues: [] as string[],
    units: [] as Array<{ id: string; status: string; blocking_issues?: string[]; review_issues?: string[] }> ,
    repairedBody: '# 最终内容',
  },
}));

vi.mock('server-only', () => ({}));

vi.mock('@/lib/content-attempts', () => ({
  beginContentAttempt: async (runId: string, plan: unknown) => {
    const record = { id: 'attempt_test', runId, plan, baseline: { path: '', sha256: '' }, status: 'generating', body: '' };
    mocks.attempts.push(record); return record;
  },
  checkpointContentAttempt: async (record: Record<string, unknown>, body: string) => { record.body = body; mocks.checkpoints.push(body); },
  finishContentAttempt: async (record: Record<string, unknown>, body: string, result: Record<string, unknown>) => {
    Object.assign(record, result, { body, status: result.savedPath ? 'saved' : 'failed' });
  },
}));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/write-guard', () => ({
  withProjectWriteLock: async <T>(key: string, callback: () => Promise<T>) => { mocks.lockKeys.push(key); return callback(); },
}));
vi.mock('@/lib/project-root', async () => {
  const path = await import('node:path');
  const projectDir = `/tmp/aifios-agent-invoke-${process.pid}`;
  return {
    PROJECT_DIR: projectDir,
    INSTALL_ROOT: projectDir,
    contentRuntimeToolPath: (name: string) => path.join(projectDir, name),
    redactLocalPaths: <T>(value: T) => value,
    runtimeJoin: (...parts: string[]) => path.join(...parts),
    toProjectRelativePath: (value: string) => value,
    safeResolve: (base: string, relativePath: string) => {
      const resolved = path.resolve(base, relativePath);
      return resolved === path.resolve(base) || resolved.startsWith(`${path.resolve(base)}${path.sep}`)
        ? resolved
        : null;
    },
  };
});
vi.mock('@/lib/server-config', () => ({ resolveServerLLMConfig: async (value: unknown) => value }));
vi.mock('@/lib/llm-client', () => ({
  validateLLMConfig: () => [],
  createLLMTextStream: async (_config: unknown, messages: Array<{ content: string }>, options: Record<string, unknown>) => {
    mocks.llmCalled = true;
    mocks.llmOptions = options;
    mocks.llmSystemMessage = messages.at(0)?.content || '';
    mocks.llmUserMessage = messages.at(-1)?.content || '';
    if (mocks.invalidateMaterialDuringGeneration) {
      mocks.materialAnalysisCurrent = false;
    }
    if (mocks.changeMaterialDirectionDuringGeneration && mocks.materialContext) {
      mocks.materialContext = {
        ...mocks.materialContext,
        selection: {
          materialTypeId: 'business-growth',
          structureId: 'growth-mistake-mechanism-list',
        },
      };
    }
    if (mocks.changeMaterialAnalysisDuringGeneration && mocks.materialContext) {
      mocks.materialContext = { ...mocks.materialContext, analysis: { ...(mocks.materialContext.analysis as object), authorRequirements: ['改为作者的新要求'] } };
    }
    return (async function* () { for (const chunk of mocks.llmResponse) yield chunk; if (mocks.failStream) throw new Error('connection closed during generation'); })();
  },
  explainLLMError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
vi.mock('@/lib/pipeline-registry', () => ({
  getRuntimeStepBySkill: (skill: string) => ({
    'content-package': 'package',
    'content-blueprint': 'blueprint',
    'content-validate': 'validate',
  }[skill] || 'write'),
}));
vi.mock('@/lib/runtime-run-resolver', () => ({
  runsForPipelinePath: async () => mocks.runs,
  listRuntimeRuns: async () => mocks.runs,
  resolveRuntimeWriteTarget: async (input: Record<string, unknown>) => {
    mocks.writeTargetRequests.push(input);
    return { slug: 'topic', runId: mocks.targetRunId };
  },
}));
vi.mock('@/lib/runtime-writer', () => ({
  validateRuntimeOutput: async () => ({ valid: true, result: { valid: true } }),
  getRuntimeBlueprintApproval: async () => mocks.approval,
  verifyRuntimeAuthorSource: async (runId: string) => {
    mocks.authorCalls += 1;
    if (mocks.authorInvalid) throw new Error('author evidence invalid');
    return { verified: true, research_mode: 'author_material', run_id: runId,
      author_evidence_path: `runs/${runId}/author-evidence/author_${'a'.repeat(32)}.json`,
      author_evidence_sha256: mocks.changeAuthorDuringGeneration && mocks.authorCalls > 1 ? 'b'.repeat(64) : 'a'.repeat(64),
      material_sha256: 'c'.repeat(64), source_path: 'pipeline/intake/topic-intake.md',
      source_sha256: 'd'.repeat(64), material_correction_id: '', topic: '客户临时改需求', target_platforms: ['公众号'] };
  },
  verifyRuntimeTikomniMarketSnapshot: async (runId: string, snapshotPath: string) => {
    mocks.marketVerificationCalls.push({ runId, snapshotPath });
    return mocks.marketVerification;
  },
  writeRuntimeOutput: async (_step: string, _slug: string, content: string) => {
    mocks.writes.push(content);
    return 'pipeline/final/topic-write.md';
  },
}));
vi.mock('@/lib/output-files', () => ({
  readOutputFile: async (path: string) => {
    if (!(path in mocks.files)) throw new Error(`missing fixture: ${path}`);
    return mocks.files[path];
  },
}));
vi.mock('@/lib/content-release-gate', () => ({
  runContentReleaseGate: async () => {
    if (mocks.changeMaterialAnalysisAtRelease && mocks.materialContext) mocks.materialContext = {
      ...mocks.materialContext, analysis: { ...(mocks.materialContext.analysis as object), authorRequirements: ['在保存前检查期间更新'] },
    };
    return mocks.releaseGate;
  },
}));
vi.mock('@/lib/market-research-context', () => ({
  verifiedMarketResearchContext: async (binding: unknown, runId: string) => {
    mocks.marketContextCalls.push({ binding, runId });
    return '## 公众号：10 条\n分级：指标不足 10 条。\n来源：https://mp.weixin.qq.com/s/test\n指标不足不等于没有资料。';
  },
}));
vi.mock('@/lib/skill-files', () => {
  class SkillNotActiveError extends Error {}
  return {
    SkillNotActiveError,
    assertActiveSkill: async (skill: string) => {
      if (skill === mocks.rejectedSkill) {
        throw new SkillNotActiveError(`Skill 未在当前安装清单中启用：${skill}`);
      }
    },
  };
});
vi.mock('@/lib/skill-loader', () => ({
  loadSkill: async () => ({ systemPrompt: 'unused' }),
  buildUserMessage: (skill: string, params: Record<string, unknown>) => (
    skill === 'content-intake'
      ? `--- 原始素材 ---\n${typeof params.rawMaterial === 'string' ? params.rawMaterial : ''}`
      : 'unused'
  ),
}));
vi.mock('@/lib/creative-library', () => ({
  creativeLibraryContext: async () => mocks.libraryContext,
}));
vi.mock('@/lib/benchmark-advisor', () => ({
  benchmarkAdvisorContextForRun: async () => mocks.advisorContext,
}));
vi.mock('@/lib/creative-enhancements', () => ({
  creativeEnhancementContextForRun: async () => mocks.creativeContext,
}));
vi.mock('@/lib/material-analysis', () => ({
  MaterialReadinessError: class MaterialReadinessError extends Error {},
  getMaterialWritingRequirements: (context: { analysis: { authorRequirements?: string[] } }) => context.analysis.authorRequirements || [],
  getMaterialAnalysisContext: async (runId: string) => {
    mocks.materialContextCalls.push(runId);
    return mocks.materialContext;
  },
  assertMaterialReadyForResearch: async () => ({ ready: true, readableSourceCount: 1, blockedFileCount: 0, sources: [] }),
  assertMaterialAnalysisCurrent: () => {
    if (!mocks.materialAnalysisCurrent) {
      throw new Error('素材输入已经变更，请重新分析后再进入 TikOmni 研究。');
    }
  },
  toMaterialAnalysisPromptContext: (context: Record<string, unknown> | null) => {
    if (!context) return '';
    return '# 本期临时素材入口上下文\n- 已选表达方向：客户问题 -> 解决方案 -> 案例与 CTA\n- 链接提炼：客户案例\n' + JSON.stringify(context.analysis || {});
  },
}));

import { POST } from './route';

describe('POST /api/agent/invoke', () => {
  beforeEach(() => {
    mocks.approval = { approved: false, reason: '尚未进行负责人确认' };
    mocks.llmCalled = false; mocks.failStream = false; mocks.attempts = []; mocks.checkpoints = [];
    mocks.llmResponse = ['# 母稿'];
    mocks.llmSystemMessage = '';
    mocks.llmUserMessage = '';
    mocks.libraryContext = '';
    mocks.advisorContext = '';
    mocks.creativeContext = '';
    mocks.materialContext = null;
    mocks.materialContextCalls = [];
    mocks.materialAnalysisCurrent = true;
    mocks.invalidateMaterialDuringGeneration = false;
    mocks.changeMaterialDirectionDuringGeneration = false;
    mocks.changeMaterialAnalysisDuringGeneration = false;
    mocks.changeMaterialAnalysisAtRelease = false;
    mocks.lockKeys = [];
    mocks.writeTargetRequests = [];
    mocks.writes = [];
    mocks.files = {};
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' } },
    }];
    mocks.marketVerification = {
      verified: true,
      run_id: 'topic-run',
      manifest_path: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshot_sha256: 'a'.repeat(64),
      source_path: 'pipeline/intake/topic-intake.md',
    };
    mocks.marketVerificationCalls = [];
    mocks.marketContextCalls = [];
    mocks.authorCalls = 0; mocks.changeAuthorDuringGeneration = false; mocks.authorInvalid = false;
    mocks.rejectedSkill = '';
    mocks.targetRunId = 'topic-run';
    mocks.releaseGate = {
      status: 'pass',
      repaired: false,
      blocking_issues: [],
      review_issues: [],
      units: [],
      repairedBody: '# 最终内容',
    };
  });

  it('returns the compatible error envelope when no generation type is selected', async () => {
    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: {}, config: {} }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: '请选择要生成的内容。',
      code: 'generation_type_required',
    });
  });

  it('rejects a historical or unknown skill before it can fall back to the write runtime', async () => {
    mocks.rejectedSkill = 'content-angle';

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-angle',
        params: { source: 'legacy input' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: '这个功能当前不可用。',
      code: 'feature_not_available',
    });
    expect(mocks.llmCalled).toBe(false);
    expect(mocks.writes).toEqual([]);
  });

  it('allows wechat-writer to generate from the current blueprint without a separate approval', async () => {
    mocks.approval = { approved: false, reason: '尚未进行负责人确认' };
    mocks.llmCalled = false;
    mocks.writes = [];

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'wechat-writer',
        params: { blueprintPath: 'pipeline/blueprint/topic-blueprint.md', slug: 'topic' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmCalled).toBe(true);
  });

  it('allows wechat-writer to include adopted creative context', async () => {
    mocks.approval = {
      approved: true,
      run_id: 'topic-run',
      path: 'pipeline/blueprint/topic-blueprint.md',
      sha256: 'a'.repeat(64),
      method: 'human_blueprint_review',
    };
    mocks.llmCalled = false;
    mocks.writes = [];
    mocks.advisorContext = '# 已由负责人采用的对标增长机制\n- P0：用自己的事实写问题';
    mocks.creativeContext = '# 已确认使用的专项检查结论\n- 先确认读者的具体行动卡点。';

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'wechat-writer',
        params: { blueprintPath: 'pipeline/blueprint/topic-blueprint.md', slug: 'topic' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmCalled).toBe(true);
    expect(mocks.llmUserMessage).toContain('已由负责人采用的对标增长机制');
    expect(mocks.llmUserMessage).toContain('已确认使用的专项检查结论');
  });

  it('uses the customer creative library as identity truth and never falls back to a bundled author', async () => {
    mocks.libraryContext = [
      '# 已确认的创作名片',
      '- 创作者：林溪',
      '- 身份定位：独立产品顾问',
      '- 目标受众：小型软件团队负责人',
    ].join('\n');

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'wechat-writer',
        params: { blueprintPath: 'pipeline/blueprint/topic-blueprint.md', slug: 'topic' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmSystemMessage).toContain('创作者：林溪');
    expect(mocks.llmSystemMessage).toContain('当前客户创作身份与已确认创作规则高于');
    expect(mocks.llmSystemMessage).not.toContain('创作者定位（you.md）');
    expect(mocks.llmSystemMessage).toContain('必须服从当前客户的创作名片');
    expect(mocks.llmSystemMessage).not.toContain('直接给判断和下一步');
    expect(mocks.llmSystemMessage).toContain('JSON 字段、固定报告标题');
  });

  it('uses creator and platform voice for publishable drafts instead of the interface coworker voice', async () => {
    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'wechat-writer',
        params: { blueprintPath: 'pipeline/blueprint/topic-blueprint.md', slug: 'topic' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmSystemMessage).toContain('必须服从当前客户的创作名片');
    expect(mocks.llmSystemMessage).toContain('不要套用产品界面的“内容团队同事”口吻');
    expect(mocks.llmSystemMessage).not.toContain('直接给判断和下一步');
  });

  it('does not save output that still contains assistant meta-language', async () => {
    mocks.llmResponse = ['作为一个 AI，我建议先做这一步。希望以上内容对你有所帮助。'];

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'wechat-writer',
        params: { blueprintPath: 'pipeline/blueprint/topic-blueprint.md', slug: 'topic' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('已停止保存');
    expect(mocks.writes).toEqual([]);
  });

  it('forbids invented identity and attribution when the customer profile is not configured', async () => {
    mocks.libraryContext = '';

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'wechat-writer',
        params: { blueprintPath: 'pipeline/blueprint/topic-blueprint.md', slug: 'topic' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmSystemMessage).toContain('创作名片尚未配置');
    expect(mocks.llmSystemMessage).toContain('禁止代入任何预置作者');
    expect(mocks.llmSystemMessage).toContain('待用户确认');
    expect(mocks.llmSystemMessage).not.toContain('创作者定位（you.md）');
  });

  it('does not save or advance a structurally blocked content package', async () => {
    mocks.approval = { approved: true };
    mocks.releaseGate = {
      status: 'blocked',
      repaired: false,
      blocking_issues: ['短视频 1 缺少 B-roll。'],
      review_issues: [],
      units: [{ id: 'video-1', status: 'blocked' }],
      repairedBody: '# 可继续完善的内容包',
    };
    mocks.llmCalled = false;
    mocks.writes = [];
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' }, intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];

    mocks.files['pipeline/blueprint/topic-blueprint.md'] = '# 蓝图\n- 研究快照：runs/topic-run/market-research/fixture/snapshot.json\n- 快照 SHA-256：' + 'a'.repeat(64);

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-package',
        runtimeStep: 'package',
        params: { slug: 'topic', blueprintPath: 'pipeline/blueprint/topic-blueprint.md', platforms: ['wechat', 'xhs', 'shipinhao'] },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.llmUserMessage).toContain('公众号：10 条');
    expect(mocks.llmUserMessage).toContain('指标不足 10 条');
    expect(body).not.toContain('"type":"saved"');
    expect(body).toContain('"code":"content_release_blocked"');
    expect(body).toContain('完整生成');
    expect(mocks.attempts[0]).toMatchObject({ status: 'failed', body: mocks.llmResponse.join(''), issues: ['短视频 1 缺少 B-roll。'] });
    expect(mocks.checkpoints.length).toBeGreaterThan(0);
    expect(body).toContain('\"type\":\"partial\"');
    expect(body).not.toContain('B-roll');
    expect(mocks.llmCalled).toBe(true);
    expect(mocks.writes).toEqual([]);
  });

  it('retains streamed words when the provider disconnects before completing a package', async () => {
    mocks.approval = { approved: true };
    mocks.failStream = true;
    mocks.llmResponse = ['# 已收到的文章\n', '正文还没写完'];
    mocks.runs = [{ run_id: 'topic-run', slug: 'topic', steps: { blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' }, intake: { latest: 'pipeline/intake/topic-intake.md' } } }];
    mocks.files['pipeline/blueprint/topic-blueprint.md'] = '# 蓝图\n- 研究快照：runs/topic-run/market-research/fixture/snapshot.json\n- 快照 SHA-256：' + 'a'.repeat(64);
    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST', body: JSON.stringify({ skill: 'content-package', runtimeStep: 'package', params: { slug: 'topic', blueprintPath: 'pipeline/blueprint/topic-blueprint.md', platforms: ['wechat'] }, config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' } }),
    }));
    const events = await response.text();
    expect(events).toContain('"type":"partial"');
    expect(mocks.attempts[0]).toMatchObject({ status: 'failed', body: '# 已收到的文章\n正文还没写完' });
    expect(mocks.llmOptions.maxRetries).toBe(0);
    expect(mocks.llmOptions.recordRequest).toBeTypeOf('function');
    expect(mocks.writes).toEqual([]);
  });

  it.each(['none', 'stream', 'validation'])('passes current material corrections to the article writer and rejects changes during generation (%s)', async (changeAt) => {
    const changed = changeAt !== 'none';
    mocks.approval = { approved: true };
    mocks.materialContext = {
      runId: 'topic-run', inputFingerprint: 'a'.repeat(64), analysisInputFingerprint: 'a'.repeat(64), analysisStatus: 'current',
      analysis: { authorRequirements: ['只写指定的一句结尾'], facts: ['三人团队'] }, selection: null,
    };
    mocks.changeMaterialAnalysisDuringGeneration = changeAt === 'stream';
    mocks.changeMaterialAnalysisAtRelease = changeAt === 'validation';
    mocks.runs = [{ run_id: 'topic-run', slug: 'topic', steps: { blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' }, intake: { latest: 'pipeline/intake/topic-intake.md' } } }];
    mocks.files['pipeline/blueprint/topic-blueprint.md'] = '# 蓝图\n- 研究快照：runs/topic-run/market-research/fixture/snapshot.json\n- 快照 SHA-256：' + 'a'.repeat(64);
    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST', body: JSON.stringify({ skill: 'content-package', params: { slug: 'topic', blueprintPath: 'pipeline/blueprint/topic-blueprint.md', platforms: ['wechat'] }, config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' } }),
    }));
    const events = await response.text();
    expect(mocks.llmUserMessage).toContain('只写指定的一句结尾');
    expect(new Set(mocks.materialContextCalls)).toEqual(new Set(['topic-run']));
    expect(mocks.materialContextCalls.length).toBeGreaterThanOrEqual(2);
    if (changeAt !== 'stream') expect(mocks.lockKeys).toContain('material-analysis:topic-run');
    if (changed) {
      expect(events).toContain('material_analysis_changed');
      expect(events).not.toContain('"type":"saved"');
      expect(mocks.writes).toEqual([]);
      expect(mocks.attempts[0]).toMatchObject({ status: 'failed', body: mocks.llmResponse.join('') });
    } else {
      expect(events).toContain('"type":"saved"');
      expect(mocks.writes).toHaveLength(1);
    }
  });

  it('requires recorded author approval even when the blueprint claims it is confirmed', async () => {
    mocks.files['pipeline/blueprint/topic-blueprint.md'] = '# 平台内容蓝图\n\n## 6. 人工确认清单\n确认状态：confirmed\n作者已经确认，无需再次确认。';
    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST', body: JSON.stringify({ skill: 'content-package', params: { blueprintPath: 'pipeline/blueprint/topic-blueprint.md' }, config: {} }),
    }));
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('writing_brief_review_required');
    expect(mocks.llmCalled).toBe(false);
  });

  it('saves review-required content and returns only a safe warning summary', async () => {
    mocks.approval = { approved: true };
    mocks.releaseGate = {
      status: 'review_required',
      repaired: true,
      blocking_issues: [],
      review_issues: ['朋友圈 CTA 的语气需要人工确认。'],
      units: [{ id: 'moments-1', status: 'review_required', review_issues: ['CTA 需要人工确认。'] }],
      repairedBody: '# 已修复的全部内容',
    };
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' }, intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];

    mocks.files['pipeline/blueprint/topic-blueprint.md'] = '# 蓝图\n- 研究快照：runs/topic-run/market-research/fixture/snapshot.json\n- 快照 SHA-256：' + 'a'.repeat(64);
    mocks.files['pipeline/blueprint/topic-blueprint.md'] = applyWritingBrief(mocks.files['pipeline/blueprint/topic-blueprint.md'], { audience: '小团队负责人', point: '记录客户问题', structure: '记录、筛选、展开', ending: '先记下今天被问到的那个问题。' });

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-package',
        runtimeStep: 'package',
        params: { slug: 'topic', blueprintPath: 'pipeline/blueprint/topic-blueprint.md', platforms: ['wechat', 'xhs', 'shipinhao'] },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.llmUserMessage).toContain('公众号：10 条');
    expect(mocks.llmUserMessage).toContain('指标不足 10 条');
    expect(mocks.llmUserMessage).toContain('最后怎样收尾：先记下今天被问到的那个问题。');
    expect(body).toContain('"type":"saved"');
    expect(body).toContain('"type":"release_gate"');
    expect(body).toContain('全部内容已经保存，但有几处需要你在发布前确认。');
    expect(body).toContain('"reviewIssueCount":1');
    expect(body).not.toContain('CTA');
    expect(mocks.writes).toHaveLength(1);
    expect(mocks.writes[0]).toMatch(/^<!-- echo-content-plan:/);
    expect(mocks.writes[0]).toContain('pipeline/blueprint/topic-blueprint.md');
    expect(mocks.writes[0]).toMatch(/\n\n# 已修复的全部内容$/);
  });

  it('injects only the current run\'s temporary material context into content intake', async () => {
    mocks.runs = [{
      run_id: 'material-run',
      slug: 'material',
      status: 'active',
      steps: {},
    }];
    mocks.targetRunId = 'material-run';
    mocks.materialContext = {
      input: {
        rawMaterial: '本期的原始文字素材。',
        files: [{ path: 'materials/intake/reference.txt' }],
        links: [],
      },
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'customer-solution-case-cta',
      },
    };
    mocks.files = {
      'materials/intake/reference.txt': '客户案例的原始补充材料。',
    };

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-intake',
        params: {
          runId: 'material-run',
          slug: 'material',
          rawMaterial: '本期的原始文字素材。',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(new Set(mocks.materialContextCalls)).toEqual(new Set(['material-run']));
    expect(mocks.materialContextCalls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.writeTargetRequests).toContainEqual(expect.objectContaining({ preferredRunId: 'material-run' }));
    expect(mocks.llmUserMessage).toContain('# 本期临时素材入口上下文');
    expect(mocks.llmUserMessage).toContain('客户案例的原始补充材料');
    expect(mocks.writes).toContain('# 母稿');
  });

  it('uses the system recommendation when no manual direction was selected', async () => {
    mocks.runs = [{
      run_id: 'material-run',
      slug: 'material',
      status: 'active',
      steps: {},
    }];
    mocks.materialContext = {
      input: {
        rawMaterial: '尚未确认行文方向的本期素材。',
        files: [],
        links: [],
      },
      inputFingerprint: 'e'.repeat(64),
      analysisInputFingerprint: 'e'.repeat(64),
      analysisStatus: 'current',
      analysis: {
        recommendedTypeId: 'business-growth',
        recommendedStructureId: 'customer-solution-case-cta',
      },
      selection: null,
    };
    mocks.targetRunId = 'material-run';

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-intake',
        params: { runId: 'material-run', rawMaterial: '尚未确认行文方向的本期素材。' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmCalled).toBe(true);
    expect(mocks.writes).toEqual(['# 母稿']);
  });

  it('rejects content intake before model invocation when its selected structure does not belong to its main type', async () => {
    mocks.runs = [{
      run_id: 'material-run',
      slug: 'material',
      status: 'active',
      steps: {},
    }];
    mocks.materialContext = {
      input: {
        rawMaterial: '主类型与结构被篡改的素材快照。',
        files: [],
        links: [],
      },
      inputFingerprint: 'f'.repeat(64),
      analysisInputFingerprint: 'f'.repeat(64),
      analysisStatus: 'current',
      selection: {
        materialTypeId: 'personal-growth',
        structureId: 'customer-solution-case-cta',
      },
    };

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-intake',
        params: { runId: 'material-run', rawMaterial: '主类型与结构被篡改的素材快照。' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'material_direction_required' });
    expect(mocks.llmCalled).toBe(false);
    expect(mocks.writes).toEqual([]);
  });

  it('rejects a legacy content-intake invocation that is not bound to a material run', async () => {
    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-intake',
        params: { rawMaterial: '绕过素材入口的旧请求。' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'content_reference_unavailable' });
    expect(mocks.llmCalled).toBe(false);
    expect(mocks.writes).toEqual([]);
  });

  it('rejects content intake before model invocation when its material analysis is stale', async () => {
    mocks.runs = [{
      run_id: 'material-run',
      slug: 'material',
      status: 'active',
      steps: {},
    }];
    mocks.materialContext = {
      input: {
        rawMaterial: '已经被替换的旧素材。',
        files: [],
        links: [],
      },
      inputFingerprint: 'a'.repeat(64),
      analysisInputFingerprint: 'b'.repeat(64),
      analysisStatus: 'stale',
    };
    mocks.materialAnalysisCurrent = false;

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-intake',
        params: { runId: 'material-run', rawMaterial: '已经被替换的旧素材。' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'material_analysis_stale' });
    expect(mocks.llmCalled).toBe(false);
    expect(mocks.writes).toEqual([]);
  });

  it('uses the run-scoped source snapshot and caps pasted text plus automatic file bodies', async () => {
    mocks.runs = [{
      run_id: 'material-run',
      slug: 'material',
      status: 'active',
      steps: {},
    }];
    const files = Array.from({ length: 20 }, (_, index) => ({
      name: `访谈补充-${index + 1}.txt`,
      path: `materials/intake/registered-${index + 1}.txt`,
    }));
    mocks.materialContext = {
      input: {
        rawMaterial: `CANONICAL_RAW_START\n${'真实访谈素材 '.repeat(30_000)}\nCANONICAL_RAW_END`,
        files,
        links: [],
      },
      inputFingerprint: 'c'.repeat(64),
      analysisInputFingerprint: 'c'.repeat(64),
      analysisStatus: 'current',
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'growth-mistake-mechanism-list',
      },
    };
    mocks.files = Object.fromEntries(files.map((file, index) => [
      file.path,
      `REGISTERED_FILE_${index + 1}_START\n${'文件正文 '.repeat(2_000)}\nREGISTERED_FILE_${index + 1}_END`,
    ]));
    mocks.files['materials/intake/untracked.txt'] = 'UNTRACKED_FILE_SHOULD_NOT_REACH_MODEL';

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-intake',
        params: {
          runId: 'material-run',
          // This request value is deliberately different. Stage 1 must use
          // the analyzed run snapshot, not an arbitrary request field.
          rawMaterial: 'materials/intake/untracked.txt',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmUserMessage).toContain('CANONICAL_RAW_START');
    expect(mocks.llmUserMessage).toContain('CANONICAL_RAW_END');
    expect(mocks.llmUserMessage).toContain('原始文字素材已按上下文预算截取');
    expect(mocks.llmUserMessage).toContain('原始文字与下列文件正文合计最多注入 48,000 字符');
    expect(mocks.llmUserMessage).toContain('REGISTERED_FILE_1_START');
    expect(mocks.llmUserMessage).not.toContain('UNTRACKED_FILE_SHOULD_NOT_REACH_MODEL');
    expect(mocks.llmUserMessage.length).toBeLessThan(60_000);
  });

  it('refuses to save a content intake report when its material snapshot changes during generation', async () => {
    mocks.runs = [{
      run_id: 'material-run',
      slug: 'material',
      status: 'active',
      steps: {},
    }];
    mocks.materialContext = {
      input: {
        rawMaterial: '本期客户诊断的原始素材。',
        files: [],
        links: [],
      },
      inputFingerprint: 'd'.repeat(64),
      analysisInputFingerprint: 'd'.repeat(64),
      analysisStatus: 'current',
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'customer-solution-case-cta',
      },
    };
    mocks.invalidateMaterialDuringGeneration = true;

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-intake',
        params: { runId: 'material-run', rawMaterial: '本期客户诊断的原始素材。' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"code":"material_analysis_stale"');
    expect(mocks.llmCalled).toBe(true);
    expect(mocks.writes).toEqual([]);
  });

  it('refuses to save content intake when its system material judgment changes during generation', async () => {
    mocks.runs = [{
      run_id: 'material-run',
      slug: 'material',
      status: 'active',
      steps: {},
    }];
    mocks.targetRunId = 'material-run';
    mocks.materialContext = {
      input: {
        rawMaterial: '本期客户诊断的原始素材。',
        files: [],
        links: [],
      },
      inputFingerprint: 'g'.repeat(64),
      analysisInputFingerprint: 'g'.repeat(64),
      analysisStatus: 'current',
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'customer-solution-case-cta',
      },
    };
    mocks.changeMaterialDirectionDuringGeneration = true;

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-intake',
        params: { runId: 'material-run', rawMaterial: '本期客户诊断的原始素材。' },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"code":"material_analysis_stale"');
    expect(mocks.llmCalled).toBe(true);
    expect(mocks.writes).toEqual([]);
  });

  it('blocks content validation before invoking the model when its TikOmni candidate snapshot fails', async () => {
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];
    mocks.files = {
      'materials/research/topic-market-signal.md': [
        '# 爆款抓取与对标报告',
        '- 上游素材：pipeline/intake/topic-intake.md',
        '- 样本数量：3',
        '- 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
        `- 快照 SHA-256：${'a'.repeat(64)}`,
      ].join('\n'),
    };
    mocks.marketVerification = { verified: false, reason: 'source_material_sha256_mismatch' };

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-validate',
        params: {
          source: 'pipeline/intake/topic-intake.md',
          marketSignalPath: 'materials/research/topic-market-signal.md',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'platform_data_refresh_required' });
    expect(mocks.llmCalled).toBe(false);
    expect(mocks.writes).toEqual([]);
    expect(mocks.marketVerificationCalls).toEqual([{
      runId: 'topic-run',
      snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
    }]);
  });

  it('binds a validate report to the verified TikOmni sample count instead of trusting model output', async () => {
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];
    mocks.files = {
      'materials/research/topic-market-signal.md': [
        '# 爆款抓取与对标报告',
        '- 上游素材：pipeline/intake/topic-intake.md',
        '- 样本数量：10',
        '- 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
        `- 快照 SHA-256：${'a'.repeat(64)}`,
      ].join('\n'),
    };
    mocks.llmResponse = [[
      '# 选题立项报告 · 测试',
      '',
      '## 0. 素材来源',
      '- 公开样本对标报告：materials/research/topic-market-signal.md',
      '- 公开样本状态：已完成',
      '- 可验证样本数：0',
      '',
      '## 1. 立项决策',
      '- 决策：不通过',
    ].join('\n')];

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-validate',
        params: {
          source: 'pipeline/intake/topic-intake.md',
          marketSignalPath: 'materials/research/topic-market-signal.md',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmUserMessage).toContain('- 可验证样本数：10');
    expect(mocks.writes[0]).toContain('- 公开样本状态：已完成');
    expect(mocks.writes[0]).toContain('- 可验证样本数：10');
    expect(mocks.writes[0]).not.toContain('- 可验证样本数：0');
    expect(mocks.writes[0]).toContain('- 决策：通过');
    expect(mocks.writes[0]).not.toContain('- 决策：不通过');
  });

  it('blocks zero-sample creator mode before invoking the model', async () => {
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];
    mocks.files = {
      'materials/research/topic-market-signal.md': [
        '# 爆款抓取与对标报告',
        '- 上游素材：pipeline/intake/topic-intake.md',
        '- 实时信号状态：creator_mode',
        '- 样本数量：0',
        '- 创作模式：是',
        '- 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
        `- 快照 SHA-256：${'a'.repeat(64)}`,
      ].join('\n'),
    };
    mocks.llmResponse = [[
      '# 选题立项报告 · 创作模式测试',
      '',
      '## 0. 素材来源',
      '- 公开样本对标报告：materials/research/topic-market-signal.md',
      '- 公开样本状态：已完成',
      '- 可验证样本数：99',
      '',
      '## 1. 立项决策',
      '- 决策：不通过',
    ].join('\n')];

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-validate',
        params: {
          source: 'pipeline/intake/topic-intake.md',
          marketSignalPath: 'materials/research/topic-market-signal.md',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'platform_data_refresh_required' });
    expect(mocks.llmCalled).toBe(false);
    expect(mocks.writes).toEqual([]);
  });

  it('adds a direct blueprint instruction when a low-evidence validation omits it', async () => {
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];
    mocks.files = {
      'materials/research/topic-market-signal.md': [
        '# 爆款抓取与对标报告',
        '- 上游素材：pipeline/intake/topic-intake.md',
        '- 样本数量：3',
        '- 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
        `- 快照 SHA-256：${'a'.repeat(64)}`,
      ].join('\n'),
    };
    mocks.llmResponse = [[
      '# 选题立项报告 · 测试',
      '',
      '## 0. 素材来源',
      '- 公开样本对标报告：materials/research/topic-market-signal.md',
      '- 公开样本状态：已完成',
      '- 可验证样本数：0',
      '',
      '## 1. 立项决策',
      '- 决策：不通过',
      '',
      '## 7. 下一步',
      '- 保留当前报告，等待操作者后续判断。',
    ].join('\n')];

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-validate',
        params: {
          source: 'pipeline/intake/topic-intake.md',
          marketSignalPath: 'materials/research/topic-market-signal.md',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.writes[0]).toContain('- 决策：通过');
    expect(mocks.writes[0]).toContain('进入 `/content-blueprint` 生成思想母版蓝图');
  });

  it('injects the verified snapshot into a blueprint and refuses to save a blueprint that omits it', async () => {
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: {
        intake: { latest: 'pipeline/intake/topic-intake.md' },
        validate: { latest: 'pipeline/validate/topic-validate.md' },
      },
    }];
    mocks.files = {
      'pipeline/validate/topic-validate.md': '# 选题立项报告\n\n## 1. 立项决策\n- 决策：通过',
      'pipeline/intake/topic-intake.md': '# 素材理解报告',
      'materials/research/topic-market-signal.md': [
        '# 爆款抓取与对标报告',
        '## 0. 研究范围',
        '- 平台：公众号',
        '- 上游素材：pipeline/intake/topic-intake.md',
        '- 样本数量：3',
        '- 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
        `- 快照 SHA-256：${'a'.repeat(64)}`,
        '## 1. 同类内容与爆款分级',
        '| 平台 | 标题 | 分级 |',
        '| 公众号 | 客户提问怎样展开 | 指标不足 |',
      ].join('\n'),
    };
    mocks.llmResponse = ['# 思想母版蓝图\n\n## 0. 上游约束\n- 已读取立项报告'];

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-blueprint',
        params: {
          validateReportPath: 'pipeline/validate/topic-validate.md',
          intakeReportPath: 'pipeline/intake/topic-intake.md',
          marketSignalPath: 'materials/research/topic-market-signal.md',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    const body = await response.text();
    expect(response.status).toBe(200);
    expect(mocks.llmUserMessage).toContain('- TikOmni 研究快照：runs/topic-run/market-research/fixture/snapshot.json');
    expect(mocks.llmUserMessage).toContain(`- TikOmni 快照 SHA-256：${'a'.repeat(64)}`);
    expect(body).toContain('"code":"outline_data_missing"');
    expect(body).not.toContain('SHA-256，不能保存');
    expect(mocks.writes).toEqual([]);
    expect(mocks.llmUserMessage).toContain('| 公众号 | 客户提问怎样展开 | 指标不足 |');
    expect(mocks.llmUserMessage).toContain('公众号：10 条');
    expect(mocks.llmUserMessage).toContain('https://mp.weixin.qq.com/s/test');
    expect(mocks.marketContextCalls).toEqual([{ binding: { snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json', snapshotSha256: 'a'.repeat(64) }, runId: 'topic-run' }]);
  });

  it('creates a blueprint from a conditional validate decision', async () => {
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: {
        intake: { latest: 'pipeline/intake/topic-intake.md' },
        validate: { latest: 'pipeline/validate/topic-validate.md' },
      },
    }];
    mocks.files = {
      'pipeline/validate/topic-validate.md': '# 选题立项报告\n\n## 1. 立项决策\n- 决策：有条件通过',
      'pipeline/intake/topic-intake.md': '# 素材理解报告',
      'materials/research/topic-market-signal.md': [
        '# 爆款抓取与对标报告',
        '- 上游素材：pipeline/intake/topic-intake.md',
        '- 样本数量：3',
        '- 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
        `- 快照 SHA-256：${'a'.repeat(64)}`,
      ].join('\n'),
    };
    mocks.llmResponse = [[
      '# 思想母版蓝图',
      '',
      '## 0. 上游约束',
      '- TikOmni 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
      `- TikOmni 快照 SHA-256：${'a'.repeat(64)}`,
    ].join('\n')];

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-blueprint',
        params: {
          validateReportPath: 'pipeline/validate/topic-validate.md',
          intakeReportPath: 'pipeline/intake/topic-intake.md',
          marketSignalPath: 'materials/research/topic-market-signal.md',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.llmCalled).toBe(true);
    expect(mocks.writes).toHaveLength(1);
  });

  it('does not save a validated topic into a different runtime run after its TikOmni evidence was checked', async () => {
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];
    mocks.files = {
      'materials/research/topic-market-signal.md': [
        '# 爆款抓取与对标报告',
        '- 上游素材：pipeline/intake/topic-intake.md',
        '- 样本数量：3',
        '- 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
        `- 快照 SHA-256：${'a'.repeat(64)}`,
      ].join('\n'),
    };
    mocks.targetRunId = 'other-run';
    mocks.llmResponse = ['# 选题立项报告 · 测试\n\n## 0. 素材来源'];

    const response = await POST(new NextRequest('http://localhost/api/agent/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        skill: 'content-validate',
        params: {
          source: 'pipeline/intake/topic-intake.md',
          marketSignalPath: 'materials/research/topic-market-signal.md',
        },
        config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"code":"task_changed"');
    expect(mocks.writes).toEqual([]);
  });
  function authorRequest(skill: 'content-blueprint' | 'content-package', params: Record<string, unknown> = {}) {
    return new NextRequest('http://localhost/api/agent/invoke', { method: 'POST', body: JSON.stringify({
      skill, params: { topic: '客户临时改需求', platforms: ['wechat'],
        ...(skill === 'content-blueprint' ? { intakeReportPath: 'pipeline/intake/topic-intake.md' }
          : { blueprintPath: 'pipeline/blueprint/topic-blueprint.md' }), ...params },
      config: { apiKey: 'test-key', baseUrl: 'https://example.invalid', model: 'test-model' },
    }) });
  }
  function prepareAuthorFixture() {
    mocks.runs = [{ run_id: 'topic-run', slug: 'topic', research_mode: 'author_material', steps: {
      intake: { latest: 'pipeline/intake/topic-intake.md' }, blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' },
    } }];
    mocks.files = { 'pipeline/intake/topic-intake.md': '# 作者提供的方法素材',
      'pipeline/blueprint/topic-blueprint.md': '# 作者方案' };
    mocks.llmResponse = ['# 平台内容蓝图\n\n## 0. 上游约束\n本期依据作者素材。'];
  }

  it('creates an explicitly selected author blueprint without invented research or a validate report', async () => {
    prepareAuthorFixture();
    mocks.advisorContext = 'OLD BENCHMARK SHOULD NOT ENTER';
    mocks.creativeContext = 'OLD ENHANCEMENT SHOULD NOT ENTER';
    const response = await POST(authorRequest('content-blueprint'));
    const stream = await response.text();
    expect(stream).not.toContain('"type":"error"');
    expect(mocks.writes).toHaveLength(1);
    expect(mocks.writes[0]).toContain('- 写作依据：作者素材（未进行平台研究）');
    expect(mocks.writes[0]).toContain(`- 作者素材 SHA-256：${'a'.repeat(64)}`);
    expect(mocks.llmSystemMessage).toContain('本期未进行平台研究');
    expect(mocks.llmUserMessage).not.toContain('OLD BENCHMARK');
    expect(mocks.llmUserMessage).not.toContain('OLD ENHANCEMENT');
    expect(mocks.marketVerificationCalls).toEqual([]);
    expect(mocks.marketContextCalls).toEqual([]);
  });

  it('does not interpret a browser researchMode flag as authority to bypass research', async () => {
    prepareAuthorFixture();
    delete mocks.runs[0].research_mode;
    const response = await POST(authorRequest('content-blueprint', { researchMode: 'author_material' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.llmCalled).toBe(false);
    expect(mocks.writes).toEqual([]);
  });

  it('blocks stale author material before spending a model request', async () => {
    prepareAuthorFixture(); mocks.authorInvalid = true;
    const response = await POST(authorRequest('content-blueprint'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.llmCalled).toBe(false);
  });

  it('rejects an old market report passed into the author-material path', async () => {
    prepareAuthorFixture();
    const response = await POST(authorRequest('content-blueprint', { marketSignalPath: 'materials/research/old-market-signal.md' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.llmCalled).toBe(false);
  });

  it('retains human approval before author-source content generation', async () => {
    prepareAuthorFixture();
    const response = await POST(authorRequest('content-package'));
    expect(response.status).toBe(409);
    expect(mocks.llmCalled).toBe(false);
  });

  it('uses an approved author source in content generation without claiming market evidence', async () => {
    prepareAuthorFixture(); mocks.approval = { approved: true };
    const response = await POST(authorRequest('content-package'));
    const stream = await response.text();
    expect(stream).not.toContain('"type":"error"');
    expect(mocks.writes).toHaveLength(1);
    expect(mocks.llmUserMessage).toContain('本期未进行平台研究');
    expect(mocks.marketVerificationCalls).toEqual([]);
    expect(mocks.marketContextCalls).toEqual([]);
  });

  it('rejects a source change during author blueprint generation before persisting', async () => {
    prepareAuthorFixture(); mocks.changeAuthorDuringGeneration = true;
    const response = await POST(authorRequest('content-blueprint'));
    expect(await response.text()).toContain('writing_source_changed');
    expect(mocks.llmCalled).toBe(true);
    expect(mocks.writes).toEqual([]);
  });

});

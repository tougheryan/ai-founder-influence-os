import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saved: [] as Array<{ runId: string; update: Record<string, unknown> }>,
  resolvedLinks: [] as unknown[],
  clearedRunId: '',
  sourceBackedCalls: [] as unknown[],
  readinessCalls: [] as unknown[],
  tikomniCalls: [] as Array<Record<string, unknown>>,
  tikomniError: '',
  readinessError: '',
  clearedEvidence: [] as Array<{ projectId: string; runId: string }>,
  ReadinessError: class MaterialReadinessError extends Error {},
  ConflictError: class MaterialAnalysisConflictError extends Error {},
  StaleError: class MaterialAnalysisStaleError extends Error {},
  context: {
    schema: 'aifios.material-analysis.v1',
    runId: 'run-a',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    inputFingerprint: 'a'.repeat(64),
    analysisInputFingerprint: 'a'.repeat(64),
    analysisStatus: 'current',
    analysis_source: 'heuristic',
    input: { rawMaterial: '素材', files: [], links: [] },
    analysis: {
      summary: '已整理文字素材。',
      facts: [],
      cases: [],
      risks: [],
      recommendedTypeId: 'personal-experience',
      recommendedStructureId: 'experience-turn-method',
    },
    selection: null,
  },
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({
  redactLocalPaths: <T>(value: T) => value,
  INSTALL_ROOT: '/tmp/aifios-install',
  PROJECT_DIR: '/tmp/aifios-project',
  contentRuntimeToolPath: (scriptName: string) => `/tmp/aifios-install/skills/content-runtime/scripts/${scriptName}`,
}));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
}));
vi.mock('@/lib/material-analysis', () => ({
  MaterialAnalysisInputError: class MaterialAnalysisInputError extends Error {},
  MaterialReadinessError: mocks.ReadinessError,
  MaterialAnalysisConflictError: mocks.ConflictError,
  MaterialAnalysisStaleError: mocks.StaleError,
  assertMaterialAnalysisCurrent: (context: { analysisStatus?: string; inputFingerprint?: string; analysisInputFingerprint?: string }) => {
    if (context.analysisStatus !== 'current' || context.inputFingerprint !== context.analysisInputFingerprint) {
      throw new mocks.StaleError('素材输入已经变更');
    }
  },
  getMaterialAnalysisContext: async () => mocks.context,
  getMaterialWritingRequirements: () => ['原有写作要求'],
  clearMaterialAnalysisContext: async (runId: string) => { mocks.clearedRunId = runId; },
  resolveInspirationLinks: async (links: unknown, _genericFetcher?: unknown, platformFetcher?: (url: URL) => Promise<{ title: string; excerpt: string; reader?: 'tikomni' | 'web' } | null>) => {
    mocks.resolvedLinks.push(links);
    const items = Array.isArray(links) ? links : [];
    return Promise.all(items.map(async (item) => {
      const url = typeof item === 'string' ? item : String((item as { url?: unknown })?.url || '');
      try {
        const platformPage = platformFetcher ? await platformFetcher(new URL(url)) : null;
        if (platformPage) return { url, status: 'parsed' as const, ...platformPage };
      } catch (error) {
        return { url, status: 'failed' as const, error: error instanceof Error ? error.message : 'TikOmni 读取失败' };
      }
      return { url, status: 'parsed' as const, title: '参考标题', excerpt: '参考提炼' };
    }));
  },
  createSourceBackedMaterialAnalysis: async (input: unknown) => {
    mocks.sourceBackedCalls.push(input);
    return mocks.context.analysis;
  },
  assertMaterialReadyForResearch: async (input: unknown) => {
    mocks.readinessCalls.push(input);
    if (mocks.readinessError) throw new mocks.ReadinessError(mocks.readinessError);
    return { ready: true, readableSourceCount: 1, blockedFileCount: 0, sources: [] };
  },
  saveMaterialAnalysisContext: async (runId: string, update: Record<string, unknown>) => {
    mocks.saved.push({ runId, update });
    return mocks.context;
  },
}));

vi.mock('@/lib/tikomni-content-link', () => ({
  isTikOmniPlatformContentUrl: (url: string) => url.startsWith('https://mp.weixin.qq.com/s'),
  readTikOmniPlatformContent: async (input: Record<string, unknown>) => {
    mocks.tikomniCalls.push(input);
    if (mocks.tikomniError) throw new Error(mocks.tikomniError);
    return {
      title: 'TikOmni 公众号文章',
      excerpt: 'TikOmni 摘录',
      detail: 'TikOmni 已读取的文章正文，包含本期可用事实。',
      platform: 'wechat_mp',
      contentKind: 'article',
    };
  },
}));

vi.mock('@/lib/tikomni-content-link-evidence', () => ({
  clearTikOmniContentLinkEvidence: async (scope: { projectId: string; runId: string }) => {
    mocks.clearedEvidence.push(scope);
    return { ...scope, relativePath: `sessions/content-link-reads/${scope.projectId}/${scope.runId}`, removed: true };
  },
}));

import { DELETE, GET, POST } from './route';

describe('/api/production/material-analysis', () => {
  it('returns a revision and rejects a stale analysis-only edit before any write or link retrieval', async () => {
    const read = await GET(new NextRequest('http://localhost/api/production/material-analysis?runId=run-a'));
    const version = (await read.json()).analysisFingerprint;
    expect(version).toMatch(/^[a-f0-9]{64}$/);
    const oldSummary = mocks.context.analysis.summary;
    mocks.context.analysis.summary = '另一窗口已改过';
    try {
      const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
        method: 'POST', body: JSON.stringify({ runId: 'run-a', expectedInputFingerprint: mocks.context.inputFingerprint, expectedAnalysisFingerprint: version, analysis: { ...mocks.context.analysis, summary: '旧窗口覆盖' } }),
      }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'MATERIAL_ANALYSIS_CONFLICT' });
      expect(mocks.saved).toEqual([]);
      expect(mocks.resolvedLinks).toEqual([]);
    } finally { mocks.context.analysis.summary = oldSummary; }
  });
  it.each([false, true])('requires the displayed revision even when the replacement also supplies raw input (%s)', async (includeInput) => {
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST', body: JSON.stringify({ runId: 'run-a', analysis: mocks.context.analysis, ...(includeInput ? { rawMaterial: '素材', links: ['https://example.com/paid-reference'] } : {}) }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MATERIAL_ANALYSIS_VERSION_REQUIRED' });
    expect(mocks.saved).toEqual([]);
    expect(mocks.resolvedLinks).toEqual([]);
  });
  beforeEach(() => {
    mocks.saved = [];
    mocks.resolvedLinks = [];
    mocks.clearedRunId = '';
    mocks.sourceBackedCalls = [];
    mocks.readinessCalls = [];
    mocks.tikomniCalls = [];
    mocks.tikomniError = '';
    mocks.readinessError = '';
    mocks.clearedEvidence = [];
    mocks.context.analysisStatus = 'current';
    mocks.context.inputFingerprint = 'a'.repeat(64);
    mocks.context.analysisInputFingerprint = 'a'.repeat(64);
  });

  it('persists material input with a resolved nonblocking reference and selected direction', async () => {
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        materialText: '本期原始素材',
        uploadedFiles: [{ name: '访谈.txt', path: 'materials/intake/interview.txt', size: 32 }],
        links: ['https://example.com/article'],
        selectedTypeId: 'interview-event',
        selectedStructureId: 'quote-collision-stance',
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.resolvedLinks).toEqual([['https://example.com/article']]);
    expect(mocks.saved[0]).toEqual({
      runId: 'run-a',
      update: {
        rawMaterial: '本期原始素材',
        files: [{ name: '访谈.txt', path: 'materials/intake/interview.txt', size: 32 }],
        links: [{ url: 'https://example.com/article', status: 'parsed', title: '参考标题', excerpt: '参考提炼' }],
        selection: {
          materialTypeId: 'interview-event',
          structureId: 'quote-collision-stance',
        },
      },
    });
    expect((await response.json()).context.analysis_source).toBe('heuristic');
    expect(mocks.sourceBackedCalls).toEqual([mocks.context.input]);
    expect(mocks.readinessCalls).toEqual([mocks.context.input]);
  });

  it('requires the correction transaction instead of replacing an existing analysis directly', async () => {
    const current = await GET(new NextRequest('http://localhost/api/production/material-analysis?runId=run-a'));
    const version = (await current.json()).analysisFingerprint;
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        analysis: {
          summary: '模型提炼',
          facts: [],
          cases: [],
          risks: [],
          recommendedTypeId: 'personal-experience',
          recommendedStructureId: 'experience-turn-method',
        },
        analysis_source: 'content_intake',
        expectedAnalysisFingerprint: version,
      }),
    }));

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('MATERIAL_CORRECTION_REQUIRED');
    expect(mocks.saved).toEqual([]);
    expect(mocks.resolvedLinks).toEqual([]);
  });

  it('uses TikOmni first for a supported platform article and persists its reader provenance', async () => {
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        projectId: 'client_alpha',
        rawMaterial: '',
        files: [],
        links: ['https://mp.weixin.qq.com/s?__biz=fixture&mid=1'],
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.tikomniCalls).toEqual([{
      projectId: 'client_alpha',
      runId: 'run-a',
      url: 'https://mp.weixin.qq.com/s?__biz=fixture&mid=1',
    }]);
    expect(mocks.saved[0]?.update).toMatchObject({
      links: [{
        url: 'https://mp.weixin.qq.com/s?__biz=fixture&mid=1',
        status: 'parsed',
        title: 'TikOmni 公众号文章',
        excerpt: 'TikOmni 已读取的文章正文，包含本期可用事实。',
        reader: 'tikomni',
      }],
    });
    expect(mocks.saved[1]).toEqual({
      runId: 'run-a',
      update: {
        analysis: mocks.context.analysis,
        analysisSource: 'heuristic',
        selection: {
          materialTypeId: 'personal-experience',
          structureId: 'experience-turn-method',
        },
      },
    });
  });

  it('requires the project binding before it can read a TikOmni platform link', async () => {
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        rawMaterial: '',
        files: [],
        links: ['https://mp.weixin.qq.com/s?__biz=fixture&mid=1'],
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.tikomniCalls).toEqual([]);
  });

  it('persists a nonblocking TikOmni platform failure instead of falling back to a generic page shell', async () => {
    mocks.tikomniError = 'TikOmni 已抓到该内容，但没有可用正文、字幕或逐字稿。请补充可读文本后继续。';
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        projectId: 'client_alpha',
        rawMaterial: '仍有一段操作者自己的文字素材。',
        files: [],
        links: ['https://mp.weixin.qq.com/s?__biz=fixture&mid=1'],
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.saved[0]?.update).toMatchObject({
      links: [{
        url: 'https://mp.weixin.qq.com/s?__biz=fixture&mid=1',
        status: 'failed',
        error: expect.stringContaining('没有可用正文'),
      }],
    });
  });

  it('clears the supplied run-scoped material context and TikOmni evidence on an explicit reset', async () => {
    const read = await GET(new NextRequest('http://localhost/api/production/material-analysis?runId=run-a'));
    expect(read.status).toBe(200);
    expect((await read.json()).context.runId).toBe('run-a');

    const removed = await DELETE(new NextRequest('http://localhost/api/production/material-analysis?runId=run-a&projectId=client_alpha', {
      method: 'DELETE',
    }));
    expect(removed.status).toBe(200);
    expect(mocks.clearedRunId).toBe('run-a');
    expect(mocks.clearedEvidence).toEqual([{ projectId: 'client_alpha', runId: 'run-a' }]);
  });

  it('does not return an old server context when the browser input fingerprint has changed', async () => {
    const read = await GET(new NextRequest(`http://localhost/api/production/material-analysis?runId=run-a&inputFingerprint=${'b'.repeat(64)}`));

    expect(read.status).toBe(409);
    const payload = await read.json();
    expect(payload).toMatchObject({ code: 'MATERIAL_INPUT_MISMATCH', serverInputFingerprint: 'a'.repeat(64) });
    expect(payload.context).toBeUndefined();
  });

  it('atomically marks the server analysis stale when the operator edits the full input snapshot', async () => {
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        mode: 'invalidate',
        expectedInputFingerprint: 'a'.repeat(64),
        rawMaterial: '更新后的素材',
        files: [],
        links: ['https://example.com/new-reference'],
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.resolvedLinks).toEqual([]);
    expect(mocks.sourceBackedCalls).toEqual([]);
    expect(mocks.saved[0]).toEqual({
      runId: 'run-a',
      update: {
        rawMaterial: '更新后的素材',
        files: [],
        links: ['https://example.com/new-reference'],
        invalidateAnalysis: true,
      },
    });
  });

  it('rejects a structure selection when its local input fingerprint no longer matches the server', async () => {
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        expectedInputFingerprint: 'b'.repeat(64),
        selectedTypeId: 'personal-experience',
        selectedStructureId: 'experience-turn-method',
      }),
    }));

    expect(response.status).toBe(409);
    expect(mocks.saved).toEqual([]);
    expect(await response.json()).toMatchObject({ code: 'MATERIAL_INPUT_CONFLICT', error: expect.stringContaining('其他窗口更新') });
  });

  it('keeps TikOmni locked when the stored analysis is already stale', async () => {
    mocks.context.analysisStatus = 'stale';
    mocks.context.analysisInputFingerprint = 'b'.repeat(64);
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        selectedTypeId: 'personal-experience',
        selectedStructureId: 'experience-turn-method',
      }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MATERIAL_ANALYSIS_STALE', error: expect.stringContaining('素材输入已经变更') });
  });

  it('stops the direction handoff when a retained attachment still needs readable text', async () => {
    mocks.readinessError = '仍有附件未完成 OCR、转写或解析。';
    const response = await POST(new NextRequest('http://localhost/api/production/material-analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        selectedTypeId: 'personal-experience',
        selectedStructureId: 'experience-turn-method',
      }),
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'material_not_ready' });
    expect(mocks.readinessCalls).toEqual([mocks.context.input]);
  });
});

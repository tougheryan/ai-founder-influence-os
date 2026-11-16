import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  args: [] as string[],
  execCalls: [] as string[][],
  writes: [] as Array<{ path: string; content: string }>,
  hostedConnection: {
    gatewayUrl: '',
    saved: {},
    researchPublicKey: '',
    researchKeyId: '',
  } as {
    gatewayUrl: string;
    saved: { connectionMode?: 'direct' | 'hosted'; gatewaySession?: string };
    researchPublicKey: string;
    researchKeyId: string;
  },
  hostedResearchCalls: [] as Array<Record<string, unknown>>,
  hostedEnvelope: {
    keyId: 'market-test',
    payload: {
      schema: 'aifios.hosted-market-research.v1',
      responses: [],
    },
    signature: 'test',
  },
  report: {
    status: 'ready',
    signal_status: 'ready',
    markdown: '# Live report',
    queries: ['企业出海 自媒体'],
    sample_count: 3,
    realtime_count: 3,
    local_count: 0,
    platform_checks: {
      wechat_mp: { status: 'available', sample_count: 1 },
      xiaohongshu: { status: 'available', sample_count: 1 },
      wechat_channels: { status: 'available', sample_count: 1 },
    },
    snapshot_path: 'runs/topic-run/market-research/fixture/snapshot.json',
    snapshot_sha256: 'a'.repeat(64),
  } as Record<string, unknown>,
  runs: [{
    run_id: 'topic-run',
    steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
  }] as Array<Record<string, unknown>>,
  runLookupCalls: 0,
  invalidateRunAtLookup: 0,
  materialContext: {
    inputFingerprint: 'a'.repeat(64),
    analysisInputFingerprint: 'a'.repeat(64),
    analysisStatus: 'current',
    input: { rawMaterial: '本期已分析的素材。', files: [], links: [] },
    selection: {
      materialTypeId: 'business-growth',
      structureId: 'customer-solution-case-cta',
    },
  } as Record<string, unknown> | null,
  materialAnalysisCurrent: true,
  readinessError: '',
  changeMaterialDuringResearch: false,
  intakeValidation: { valid: true, result: { valid: true } } as {
    valid: boolean;
    result: Record<string, unknown>;
  },
  execError: null as Error | null,
}));

vi.mock('child_process', () => ({
  execFile: Object.assign(
    (...args: unknown[]) => {
      mocks.args = (args[1] as string[]) || [];
      mocks.execCalls.push(mocks.args);
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, JSON.stringify(mocks.report), '');
    },
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => {
        mocks.args = (args[1] as string[]) || [];
        mocks.execCalls.push(mocks.args);
        if (mocks.execError) {
          const error = mocks.execError;
          mocks.execError = null;
          return Promise.reject(error);
        }
        if (mocks.args.includes('--derive-query-context')) {
          return Promise.resolve({ stdout: JSON.stringify({ queries: ['企业出海 自媒体'] }), stderr: '' });
        }
        const options = args[2] as { env?: Record<string, string> } | undefined;
        if (options?.env?.AIFIOS_MARKET_SIGNAL_PROVIDER === 'none') {
          return Promise.resolve({ stdout: JSON.stringify({
            ...mocks.report,
            status: 'ready',
            signal_status: 'creator_mode',
            creator_mode: true,
            markdown: '# Creator mode report',
            sample_count: 0,
            realtime_count: 0,
            snapshot_path: 'runs/topic-run/market-research/creator/snapshot.json',
            snapshot_sha256: 'b'.repeat(64),
          }), stderr: '' });
        }
        if (mocks.changeMaterialDuringResearch && mocks.materialContext) {
          mocks.materialContext = {
            ...mocks.materialContext,
            selection: {
              materialTypeId: 'business-growth',
              structureId: 'growth-mistake-mechanism-list',
            },
          };
        }
        return Promise.resolve({ stdout: JSON.stringify(mocks.report), stderr: '' });
      },
    },
  ),
}));

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => {},
}));

vi.mock('@/lib/hosted-gateway', () => ({
  hostedGatewayConnection: async () => mocks.hostedConnection,
}));

vi.mock('@/lib/hosted-market-research', () => ({
  HostedMarketResearchError: class HostedMarketResearchError extends Error {
    status: number;
    constructor(message: string, status = 502) {
      super(message);
      this.status = status;
    }
  },
  requestHostedMarketResearch: async (input: Record<string, unknown>) => {
    mocks.hostedResearchCalls.push(input);
    return mocks.hostedEnvelope;
  },
}));

vi.mock('@/lib/output-files', () => ({
  writeOutputFile: async (path: string, content: string) => {
    mocks.writes.push({ path, content });
  },
}));

vi.mock('@/lib/project-root', () => ({
  PROJECT_DIR: '/tmp/aifios-market-signal-route',
  contentRuntimeToolPath: (name: string) => `/tmp/${name}`,
  redactLocalPaths: <T>(value: T) => value,
}));

vi.mock('@/lib/runtime-run-resolver', () => ({
  runsForPipelinePath: async () => {
    mocks.runLookupCalls += 1;
    return mocks.invalidateRunAtLookup === mocks.runLookupCalls ? [] : mocks.runs;
  },
}));

vi.mock('@/lib/runtime-writer', () => ({
  validateRuntimeOutput: async () => mocks.intakeValidation,
}));

vi.mock('@/lib/material-analysis', () => ({
  getMaterialAnalysisContext: async () => mocks.materialContext,
  assertMaterialAnalysisCurrent: () => {
    if (!mocks.materialAnalysisCurrent) {
      throw new Error('素材输入已经变更，请重新分析后再进入 TikOmni 研究。');
    }
  },
  assertMaterialReadyForResearch: async () => {
    if (mocks.readinessError) throw new Error(mocks.readinessError);
    return { ready: true, readableSourceCount: 1, blockedFileCount: 0, sources: [] };
  },
}));

vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
}));

import { POST } from './route';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/research/market-signal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/research/market-signal', () => {
  beforeEach(() => {
    mocks.args = [];
    mocks.execCalls = [];
    mocks.writes = [];
    mocks.hostedConnection = { gatewayUrl: '', saved: {}, researchPublicKey: '', researchKeyId: '' };
    mocks.hostedResearchCalls = [];
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];
    mocks.runLookupCalls = 0;
    mocks.invalidateRunAtLookup = 0;
    mocks.materialContext = {
      inputFingerprint: 'a'.repeat(64),
      analysisInputFingerprint: 'a'.repeat(64),
      analysisStatus: 'current',
      input: { rawMaterial: '本期已分析的素材。', files: [], links: [] },
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'customer-solution-case-cta',
      },
    };
    mocks.materialAnalysisCurrent = true;
    mocks.readinessError = '';
    mocks.changeMaterialDuringResearch = false;
    mocks.intakeValidation = { valid: true, result: { valid: true } };
    mocks.execError = null;
    mocks.report = {
      status: 'ready',
      signal_status: 'ready',
      markdown: '# Live report',
      queries: ['企业出海 自媒体'],
      sample_count: 3,
      realtime_count: 3,
      local_count: 0,
      platform_checks: {
        wechat_mp: { status: 'available', sample_count: 1 },
        xiaohongshu: { status: 'available', sample_count: 1 },
        wechat_channels: { status: 'available', sample_count: 1 },
      },
      snapshot_path: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshot_sha256: 'a'.repeat(64),
    };
  });

  it('uses the run platform contract and returns the snapshot', async () => {
    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      topic: '企业出海内容',
      runId: 'topic-run',
      platforms: ['wechat'],
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.args).toContain('wechat_mp,xiaohongshu,wechat_channels');
    expect(mocks.args).toContain('--run-id');
    expect(mocks.args).toContain('topic-run');
    expect(payload.requiredPlatforms).toEqual(['wechat_mp', 'xiaohongshu', 'wechat_channels']);
    expect(payload.snapshotSha256).toBe('a'.repeat(64));
    expect(payload.languageWarnings).toEqual([]);
    expect(mocks.writes).toEqual([{
      path: 'materials/research/topic-market-signal.md',
      content: '# Live report',
    }]);
  });

  it('researches only the platform lanes selected on the current run', async () => {
    mocks.runs[0] = {
      ...mocks.runs[0],
      selected_platforms: ['xhs'],
      target_platforms: ['xhs'],
    };
    mocks.report = {
      ...mocks.report,
      sample_count: 1,
      realtime_count: 1,
      ready_platforms: ['xiaohongshu'],
      platform_checks: { xiaohongshu: { status: 'available', sample_count: 1 } },
    };

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      topic: '企业出海内容',
      runId: 'topic-run',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.args).toContain('xiaohongshu');
    expect(mocks.args).not.toContain('wechat_mp,xiaohongshu,wechat_channels');
    expect(payload.requiredPlatforms).toEqual(['xiaohongshu']);
    expect(payload.readyPlatforms).toEqual(['xiaohongshu']);
    expect(Object.keys(payload.platformChecks)).toEqual(['xiaohongshu']);
  });

  it('blocks unsafe generated prose before writing the market report', async () => {
    mocks.report.markdown = '# 爆款抓取与对标报告\n\n作为 AI，我读取 /Users/example/private.md 后填写 {{待补充}}。';

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      topic: '企业出海内容',
      runId: 'topic-run',
    }));
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload).toMatchObject({
      code: 'market_research_language_blocked',
      action: { label: '重新获取平台数据', href: '/production?stage=2' },
    });
    expect(JSON.stringify(payload)).not.toContain('/Users/example');
    expect(mocks.writes).toEqual([]);
  });

  it('rejects a client slug that points a run A research request at run B output', async () => {
    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'other-run',
      topic: '企业出海内容',
      runId: 'topic-run',
    }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({ code: 'invalid_request', operationOutcome: 'known_blocked' });
    expect(mocks.execCalls).toEqual([]);
    expect(mocks.writes).toEqual([]);
  });

  it('rechecks run ownership after research and refuses to write when the intake binding changed', async () => {
    // Initial authority, lock entry, then the post-provider pre-write check.
    mocks.invalidateRunAtLookup = 3;
    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      topic: '企业出海内容',
      runId: 'topic-run',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.writes).toEqual([]);
  });

  it('uses the signed hosted research path without reading a local TikOmni credential', async () => {
    mocks.hostedConnection = {
      gatewayUrl: 'https://gateway.example.com',
      saved: { connectionMode: 'hosted', gatewaySession: 'friend-session' },
      researchPublicKey: 'public-key',
      researchKeyId: 'market-test',
    };

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      topic: '企业出海内容',
      runId: 'topic-run',
    }));

    expect(response.status).toBe(200);
    expect(mocks.hostedResearchCalls).toEqual([{
      gatewayUrl: 'https://gateway.example.com',
      sessionToken: 'friend-session',
      researchPublicKey: 'public-key',
      researchKeyId: 'market-test',
      queries: ['企业出海 自媒体'],
      platforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
    }]);
    expect(mocks.execCalls).toHaveLength(2);
    expect(mocks.execCalls[0]).toContain('--derive-query-context');
    expect(mocks.execCalls[1]).toContain('--hosted-envelope');
    expect(mocks.execCalls.flat()).not.toContain('TIKOMNI_API_KEY');
    expect(mocks.writes).toEqual([{
      path: 'materials/research/topic-market-signal.md',
      content: '# Live report',
    }]);
  });

  it('blocks topic research when any required platform is unavailable', async () => {
    mocks.report = {
      status: 'blocked',
      signal_status: 'blocked',
      markdown: '# Do not save',
      queries: ['企业出海 自媒体'],
      blockers: [{ code: 'platform_unavailable', platform: 'wechat_channels', message: 'endpoint down' }],
    };

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));
    const payload = await response.json();

    expect(response.status).toBe(424);
    expect(payload).toMatchObject({
      ok: false,
      blocked: true,
      signalStatus: 'blocked',
      operationOutcome: 'known_blocked',
      blockers: [{ code: 'platform_unavailable', platform: 'wechat_channels' }],
    });
    expect(payload.error).toContain('视频号');
    expect(payload.error).not.toContain('公众号、小红书和视频号都更新成功');
    expect(mocks.writes).toEqual([]);
  });

  it('asks for a usable research direction when no query can be derived', async () => {
    mocks.report = {
      status: 'blocked', signal_status: 'blocked', queries: [],
      blockers: [{ code: 'query_missing', message: 'raw internal query diagnostic' }],
    };
    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md', slug: 'topic', runId: 'topic-run',
    }));
    const payload = await response.json();
    expect(response.status).toBe(424);
    expect(payload.code).toBe('research_query_missing');
    expect(payload.error).toContain('补充本期讨论的行业或具体问题');
    expect(payload.error).not.toContain('稍后重试');
    expect(payload.error).not.toContain('raw internal');
    expect(mocks.writes).toEqual([]);
  });

  it('keeps ready lanes available when one selected platform returned zero evidence', async () => {
    mocks.report = {
      ...mocks.report,
      platform_checks: {
        wechat_mp: { status: 'available', sample_count: 1 },
        xiaohongshu: { status: 'available', sample_count: 1 },
        wechat_channels: { status: 'available', sample_count: 0 },
      },
      sample_count: 2,
    };

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.partial).toBe(true);
    expect(payload.readyPlatforms).toEqual(['wechat_mp', 'xiaohongshu']);
    expect(payload.platformChecks.wechat_channels).toMatchObject({ status: 'available', sample_count: 0 });
    expect(mocks.writes).toEqual([{
      path: 'materials/research/topic-market-signal.md',
      content: '# Live report',
    }]);
  });

  it('blocks topic research when the research process fails', async () => {
    mocks.execError = Object.assign(new Error('Command failed: python3 market_signal_report.py'), {
      code: 1,
    });

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));
    const payload = await response.json();

    expect(response.status).toBe(424);
    expect(payload).toMatchObject({
      ok: false,
      blocked: true,
      signalStatus: 'blocked',
      operationOutcome: 'unknown',
    });
    expect(mocks.writes).toEqual([]);
  });

  it('rejects a market query that is not bound to the current intake run', async () => {
    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'other-run',
    }));

    expect(response.status).toBe(400);
    expect(mocks.args).toEqual([]);
  });

  it('rejects an archived run before it can call TikOmni', async () => {
    mocks.runs = [{
      run_id: 'topic-run',
      slug: 'topic',
      status: 'archived',
      steps: { intake: { latest: 'pipeline/intake/topic-intake.md' } },
    }];

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toEqual([]);
    expect(mocks.writes).toEqual([]);
  });

  it('rejects an intake artifact that did not pass runtime validation before calling TikOmni', async () => {
    mocks.intakeValidation = {
      valid: false,
      result: { valid: false, missing_patterns: ['## 0. 素材场景'] },
    };

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toEqual([]);
    expect(mocks.writes).toEqual([]);
  });

  it('rejects a direct TikOmni request without a current material analysis', async () => {
    mocks.materialContext = null;

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toEqual([]);
    expect(mocks.writes).toEqual([]);
  });

  it('rejects a direct TikOmni request until a material direction is selected and compatible', async () => {
    mocks.materialContext = {
      inputFingerprint: 'a'.repeat(64),
      analysisInputFingerprint: 'a'.repeat(64),
      analysisStatus: 'current',
      input: { rawMaterial: '本期已分析的素材。', files: [], links: [] },
      selection: null,
    };

    const missingSelection = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));

    expect(missingSelection.status).toBe(400);
    expect(await missingSelection.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toEqual([]);

    mocks.materialContext = {
      ...mocks.materialContext,
      selection: {
        materialTypeId: 'personal-growth',
        structureId: 'customer-solution-case-cta',
      },
    };

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toEqual([]);
    expect(mocks.writes).toEqual([]);
  });

  it('rejects a direct TikOmni request when material analysis is stale or an attachment is unreadable', async () => {
    mocks.materialAnalysisCurrent = false;

    const stale = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));

    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toEqual([]);

    mocks.materialAnalysisCurrent = true;
    mocks.readinessError = '仍有附件未完成 OCR、转写或解析。';
    const unreadable = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));

    expect(unreadable.status).toBe(400);
    expect(await unreadable.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toEqual([]);
    expect(mocks.writes).toEqual([]);
  });

  it('does not persist a TikOmni snapshot when the material direction changes during research', async () => {
    mocks.changeMaterialDuringResearch = true;

    const response = await POST(request({
      sourcePath: 'pipeline/intake/topic-intake.md',
      slug: 'topic',
      runId: 'topic-run',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toContain('wechat_mp,xiaohongshu,wechat_channels');
    expect(mocks.writes).toEqual([]);
  });
});

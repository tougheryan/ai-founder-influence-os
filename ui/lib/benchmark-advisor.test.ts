import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ projectDir: `/tmp/aifios-benchmark-advisor-${process.pid}` }));

vi.mock('./project-root', async () => {
  const pathModule = await import('node:path');
  return {
    INSTALL_ROOT: mocks.projectDir,
    PROJECT_DIR: mocks.projectDir,
    contentRuntimeToolPath: (name: string) => `/tmp/${name}`,
    runtimeJoin: (...parts: string[]) => pathModule.join(...parts),
    safeResolve: (base: string, relative: string) => {
      const normalizedBase = pathModule.resolve(base);
      const resolved = pathModule.resolve(normalizedBase, relative);
      return resolved === normalizedBase || resolved.startsWith(`${normalizedBase}${pathModule.sep}`) ? resolved : null;
    },
  };
});

import {
  adoptBenchmarkVideoAngle,
  adoptBenchmarkAdvisorAction,
  analyzeBenchmarkVideo,
  acknowledgeBenchmarkAdvisorDesktopReminder,
  benchmarkAdvisorContextForRun,
  BenchmarkAdvisorInputError,
  getBenchmarkAdvisorDesktopReminder,
  getBenchmarkAdvisorState,
  refreshBenchmarkAdvisorIfDue,
  refreshBenchmarkAdvisorResearch,
  saveBenchmarkAccounts,
  sendBenchmarkAdvisorMessage,
  type BenchmarkEvidenceCollector,
  type ViralVideoBreakdownGenerator,
  type ViralVideoEvidenceCollector,
} from './benchmark-advisor';

const PROJECT_A = 'client_alpha';
const PROJECT_B = 'client_beta';

async function writeJson(relative: string, value: unknown) {
  const absolute = path.join(mocks.projectDir, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(value, null, 2), 'utf-8');
}

function accounts() {
  return [
    {
      id: 'benchmark_a1b2c3d4e5f6',
      label: '增长观察 A',
      handle: 'xhs-user-a',
      platform: 'xiaohongshu',
      publicUrl: 'https://example.test/growth-a',
      focus: '创始人内容与问题入口',
      observation: '这是操作者的公开观察备注，不是采集证据。',
    },
    {
      id: 'benchmark_b1c2d3e4f5a6',
      label: '增长观察 B',
      handle: 'gh_growth_b',
      platform: 'wechat_mp',
      publicUrl: 'https://example.test/growth-b',
      focus: '商业问题与互动',
      observation: '',
    },
  ];
}

const collector: BenchmarkEvidenceCollector = async (projectId, configured) => ({
  projectId,
  snapshotPath: `materials/advisors/benchmark/${projectId}/snapshots/evidence.json`,
  normalizedPath: `materials/advisors/benchmark/${projectId}/normalized/evidence.json`,
  capturedAt: '2026-07-15T08:00:00.000Z',
  accounts: configured.map((account, index) => ({
    accountId: account.id,
    platform: account.platform,
    status: 'available' as const,
    capturedAt: '2026-07-15T08:00:00.000Z',
    reason: '',
    profile: {
      status: 'available' as const,
      links: [{ url: account.publicUrl, capturedAt: '2026-07-15T08:00:00.000Z', kind: 'profile' as const }],
      publicMetricFields: ['follower_count'],
      reason: '',
    },
    works: {
      status: 'available' as const,
      links: [{ url: `${account.publicUrl}/work-${index + 1}`, capturedAt: '2026-07-15T08:00:00.000Z', kind: 'work' as const }],
      reason: '',
      items: [{
        sourceUrl: `${account.publicUrl}/work-${index + 1}`,
        publishedAt: '2026-07-14T08:00:00.000Z',
        capturedAt: '2026-07-15T08:00:00.000Z',
        format: index ? 'article' : 'image_note',
        metrics: { likes: 30, comments: 6, shares: 2 },
        openingMechanisms: ['具体问题入口', '方法结构入口'],
        ctaPresent: index === 0,
        interactionSignal: '评论/互动可见',
        title: `参考内容 ${index + 1}`,
        author: `公开账号 ${index + 1}`,
        summary: '以具体问题进入，再给出方法结构。',
        coverImage: '',
        embedUrl: '',
        primaryText: '先给一个具体问题，再用自己的案例说明方法。',
        primaryTextSource: 'fixture',
        structureAnalysis: {
          status: 'ready' as const,
          topicSignals: ['商业与创业'],
          promiseTypes: ['问题解答', '方法清单'],
          narrativeStructure: ['具体问题或场景', '案例或事实证据', '方法或步骤展开'],
          proofSignals: ['案例证据'],
          ctaTypes: index === 0 ? ['评论互动'] : [],
          visualSignals: [index ? '长文内容形态' : '图文内容形态'],
          basis: ['title', 'primary_text', 'metrics'],
          evidenceLimits: [],
        },
      }, {
        sourceUrl: `${account.publicUrl}/work-${index + 1}-b`,
        publishedAt: '2026-07-08T08:00:00.000Z',
        capturedAt: '2026-07-15T08:00:00.000Z',
        format: index ? 'article' : 'image_note',
        metrics: { likes: 24, comments: 4, shares: 1 },
        openingMechanisms: ['具体问题入口', '方法结构入口'],
        ctaPresent: index === 0,
        interactionSignal: '评论/互动可见',
        title: `参考内容 ${index + 1}B`,
        author: `公开账号 ${index + 1}`,
        summary: '从读者问题进入，用案例给出方法。',
        coverImage: '',
        embedUrl: '',
        primaryText: '先说明读者问题，再用自己的案例给出方法步骤。',
        primaryTextSource: 'fixture',
        structureAnalysis: {
          status: 'ready' as const,
          topicSignals: ['商业与创业'],
          promiseTypes: ['问题解答', '方法清单'],
          narrativeStructure: ['具体问题或场景', '案例或事实证据', '方法或步骤展开'],
          proofSignals: ['案例证据'],
          ctaTypes: index === 0 ? ['评论互动'] : [],
          visualSignals: [index ? '长文内容形态' : '图文内容形态'],
          basis: ['title', 'primary_text', 'metrics'],
          evidenceLimits: [],
        },
      }],
    },
    comments: { status: 'unavailable' as const, links: [], reason: '无安全评论请求标识' },
    rawEntries: [{
      kind: 'works',
      endpointId: `${account.platform}.fixture`,
      path: `materials/advisors/benchmark/${projectId}/raw/${account.id}/fixture.json`,
      sha256: 'a'.repeat(64),
      capturedAt: '2026-07-15T08:00:00.000Z',
    }],
    evidenceLinks: [
      { url: account.publicUrl, capturedAt: '2026-07-15T08:00:00.000Z', kind: 'profile' as const },
      { url: `${account.publicUrl}/work-${index + 1}`, capturedAt: '2026-07-15T08:00:00.000Z', kind: 'work' as const },
      { url: `${account.publicUrl}/work-${index + 1}-b`, capturedAt: '2026-07-15T08:00:00.000Z', kind: 'work' as const },
    ],
  })),
});

const videoCollector: ViralVideoEvidenceCollector = async (projectId, sourceUrl) => ({
  projectId,
  platform: 'douyin',
  sourceUrl,
  canonicalUrl: sourceUrl,
  capturedAt: '2026-07-15T08:00:00.000Z',
  fingerprint: 'v'.repeat(64),
  title: '先讲一个具体问题，再说明为什么值得处理',
  author: '公开作者',
  publishedAt: '2026-07-14T08:00:00.000Z',
  metrics: { plays: 12345, likes: 234, comments: 18, shares: 31 },
  coverImage: 'https://example.test/cover.jpg',
  coverType: 'cover',
  firstFrameImage: '',
  coverPath: '',
  coverContentType: '',
  coverSource: 'tikomni_cover',
  coverLabel: 'TikOmni 返回封面',
  videoUrl: 'https://example.test/video.mp4',
  primaryText: '先给一个具体问题，再说明为什么它值得处理，最后给出一条自己的验证路径。',
  primaryTextSource: 'caption',
  durationMs: 17000,
  missingFields: [],
  analysisFields: {
    status: 'ready',
    topic: '用具体问题建立内容入口',
    openingHook: '先给一个具体问题。',
    narrativeStructure: ['具体场景', '判断反转', '自有证据', '行动收束'],
    expressionMethods: ['短句给判断，再用事实解释。'],
    reusableMethods: ['用自己的场景替换入口。'],
    productionNotes: ['公开时长 17 秒。'],
    evidenceLimits: [],
  },
  rawPath: `materials/advisors/benchmark/${projectId}/single-video/raw/video.json`,
  normalizedPath: `materials/advisors/benchmark/${projectId}/single-video/normalized/video.json`,
});

const videoGenerator: ViralVideoBreakdownGenerator = async () => ({
  status: 'ready',
  topic: '用具体问题建立内容入口',
  hook: '先让目标读者认出自己的场景。',
  audience: '对内容开场缺乏判断的创作者。',
  whyItWorks: ['问题足够具体，能降低理解成本。'],
  structure: ['具体场景', '判断反转', '自有证据', '行动收束'],
  expressionMethods: ['短句给判断，再用事实解释。'],
  reusablePractices: ['用自己的场景替换入口，再用自有事实完成论证。'],
  productionNotes: ['公开时长 17 秒。'],
  guardrails: ['只借鉴做法，不复制原内容。'],
  angles: [
    { id: 'angle_1', title: '从客户问题开始', rationale: '用自有场景启动。', adoptionText: '用自己客户的问题开头。', proposedExperiment: '测试两个开头。', guardrail: '不复用原文。' },
    { id: 'angle_2', title: '拆成三步判断', rationale: '降低理解成本。', adoptionText: '用自己的案例给三步。', proposedExperiment: '测试保存率。', guardrail: '不复用原文。' },
    { id: 'angle_3', title: '压缩成观点卡', rationale: '便于分享。', adoptionText: '用自有事实做一页卡。', proposedExperiment: '测试转发。', guardrail: '不复用原文。' },
  ],
});

describe('benchmark advisor project-isolated archive', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('requires project id, customer authorization, one-to-five accounts, and keeps configuration inside that project', async () => {
    await expect(saveBenchmarkAccounts(PROJECT_A, [], true)).rejects.toBeInstanceOf(BenchmarkAdvisorInputError);
    await expect(saveBenchmarkAccounts(PROJECT_A, accounts(), false)).rejects.toThrow('查看这些公开账号');
    const state = await saveBenchmarkAccounts(PROJECT_A, accounts(), true);

    expect(state.projectId).toBe(PROJECT_A);
    expect(state.authorizationConfirmed).toBe(true);
    expect(state.archivePaths.accounts).toBe(`materials/advisors/benchmark/${PROJECT_A}/accounts.json`);
    const stored = JSON.parse(await readFile(path.join(mocks.projectDir, state.archivePaths.accounts), 'utf-8'));
    expect(stored.projectId).toBe(PROJECT_A);
    expect(stored.accounts.map((item: { label: string }) => item.label)).toEqual(['增长观察 A', '增长观察 B']);
    expect((await getBenchmarkAdvisorState(PROJECT_B)).accounts).toEqual([]);
    await expect(saveBenchmarkAccounts(PROJECT_A, [...accounts(), ...accounts(), accounts()[0], accounts()[1]], true)).rejects.toBeInstanceOf(BenchmarkAdvisorInputError);
  });

  it('builds a 13-dimension comparison and only promotes cross-work repetition to account patterns', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);

    const state = await refreshBenchmarkAdvisorResearch(PROJECT_A, collector);
    const report = state.latestReport;

    expect(report?.accounts).toHaveLength(2);
    expect(report?.comparison).toHaveLength(13);
    expect(report?.comparison.map((row) => row.dimension)).toContain('证据方法');
    expect(report?.comparison.map((row) => row.dimension)).toContain('不可迁移条件');
    expect(report?.accounts[0].patterns).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'promise', label: '方法清单', sampleCount: 2, confidence: 'repeated' }),
    ]));
    expect(report?.comparison.find((row) => row.dimension === '可迁移机制')?.cells[0].value).toContain('2 条重复');
    expect(report?.comparison[0].cells[0].evidenceLinks[0]).toMatchObject({ url: 'https://example.test/growth-a' });
    expect(report?.evidence).toMatchObject({
      status: 'available',
      snapshotPath: `materials/advisors/benchmark/${PROJECT_A}/snapshots/evidence.json`,
      accountEvidenceCount: 2,
    });
    expect(report?.actions[0].proposedExperiment).toContain('未来 4 周');
    expect(report?.actions[0].evidenceLinks).not.toEqual([]);
    expect(state.weekly.unreadChangeSummary).toBe(true);
  });

  it('does not promote sequence, proof, or CTA patterns from limited platform descriptions', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);
    const limitedCollector: BenchmarkEvidenceCollector = async (projectId, configured) => {
      const evidence = await collector(projectId, configured);
      return {
        ...evidence,
        accounts: evidence.accounts.map((account) => ({
          ...account,
          works: {
            ...account.works,
            items: account.works.items.map((work) => ({
              ...work,
              structureAnalysis: { ...work.structureAnalysis!, status: 'limited' as const },
            })),
          },
        })),
      };
    };

    const report = (await refreshBenchmarkAdvisorResearch(PROJECT_A, limitedCollector)).latestReport;
    expect(report?.accounts[0].patterns).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'promise', label: '方法清单', confidence: 'repeated' }),
    ]));
    expect(report?.accounts[0].patterns?.some((pattern) => ['structure', 'proof', 'cta'].includes(pattern.dimension))).toBe(false);
  });

  it('blocks a refresh and preserves an empty research archive when TikOmni account evidence is unavailable', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);
    const unavailableCollector: BenchmarkEvidenceCollector = async (projectId, configured) => {
      const evidence = await collector(projectId, configured);
      return {
        ...evidence,
        accounts: evidence.accounts.map((account) => ({
          ...account,
          status: 'unavailable' as const,
          reason: 'TikOmni Token 当前不可用。',
          profile: { ...account.profile, status: 'unavailable' as const, links: [], reason: 'TikOmni 不可用。' },
          works: { ...account.works, status: 'unavailable' as const, links: [], items: [], reason: 'TikOmni 不可用。' },
          comments: { ...account.comments, status: 'unavailable' as const, links: [], reason: 'TikOmni 不可用。' },
          rawEntries: [],
          evidenceLinks: [],
        })),
      };
    };

    await expect(refreshBenchmarkAdvisorResearch(PROJECT_A, unavailableCollector)).rejects.toThrow('平台数据连接失败');

    const state = await getBenchmarkAdvisorState(PROJECT_A);
    expect(state.latestReport).toBeNull();
    expect(state.reportCount).toBe(0);
  });

  it('keeps follow-up chat project-scoped, evidence-linked, and responsive to the actual question', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);
    await refreshBenchmarkAdvisorResearch(PROJECT_A, collector);
    const actionId = (await getBenchmarkAdvisorState(PROJECT_A)).latestReport?.actions[0].id || '';

    const afterComparison = await sendBenchmarkAdvisorMessage(PROJECT_A, '两个账号常用的开头有什么区别？');
    expect(afterComparison.chatHistory).toHaveLength(2);
    expect(afterComparison.chatHistory[1].content).toContain('常用开头');
    expect(afterComparison.chatHistory[1].content).toContain('来源：https://example.test/growth-a');
    expect(afterComparison.chatHistory[1].content).not.toMatch(/公开样本|母稿|CTA|机制|沉淀|赋能/);

    const afterFollowup = await sendBenchmarkAdvisorMessage(PROJECT_A, '那这周先做什么实验？');
    expect(afterFollowup.chatHistory).toHaveLength(4);
    expect(afterFollowup.chatHistory[3].content).toContain('先验证一个自己的读者问题');
    expect(afterFollowup.chatHistory[3].content).toContain('未来 4 周');
    expect(afterFollowup.chatHistory[3].content).toContain('已延续本项目上一轮问题');
    expect(afterFollowup.chatHistory[3].content).not.toBe(afterComparison.chatHistory[1].content);

    await writeJson('runs/current-run.json', { run_id: 'current-run', slug: 'current', project_id: PROJECT_A });
    await expect(adoptBenchmarkAdvisorAction(PROJECT_B, 'current-run', actionId)).rejects.toBeInstanceOf(BenchmarkAdvisorInputError);
    const adopted = await adoptBenchmarkAdvisorAction(PROJECT_A, 'current-run', actionId);
    const context = await benchmarkAdvisorContextForRun('current-run');

    expect(adopted.path).toBe('runs/current-run/benchmark-advisor/adopted-conclusions.json');
    expect(context).toContain('已确认使用的参考账号结论');
    expect(context).toContain('建议实验');
  });

  it('keeps follow-up context scoped to the selected account and work', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);
    const state = await refreshBenchmarkAdvisorResearch(PROJECT_A, collector);
    const firstAccount = state.latestReport?.accounts[0];
    const secondAccount = state.latestReport?.accounts[1];
    const firstWork = firstAccount?.works[0];
    const secondWork = secondAccount?.works[0];

    await sendBenchmarkAdvisorMessage(PROJECT_A, '先分析这条作品的开场。', {
      accountId: firstAccount?.id,
      workUrl: firstWork?.sourceUrl,
    });
    const otherWork = await sendBenchmarkAdvisorMessage(PROJECT_A, '继续展开。', {
      accountId: secondAccount?.id,
      workUrl: secondWork?.sourceUrl,
    });
    expect(otherWork.chatHistory.at(-1)?.content).not.toContain('已延续本项目上一轮问题');

    const firstWorkFollowup = await sendBenchmarkAdvisorMessage(PROJECT_A, '继续展开。', {
      accountId: firstAccount?.id,
      workUrl: firstWork?.sourceUrl,
    });
    expect(firstWorkFollowup.chatHistory.at(-1)?.content).toContain('已延续本项目上一轮问题');
  });

  it('keeps legacy adopted records readable while giving downstream writing natural copy', async () => {
    await writeJson('runs/legacy-copy-run.json', { run_id: 'legacy-copy-run', slug: 'legacy-copy', project_id: PROJECT_A });
    await writeJson('runs/legacy-copy-run/benchmark-advisor/adopted-conclusions.json', {
      schema: 'aifios.benchmark-advisor.run-adoption.v2',
      projectId: PROJECT_A,
      adopted: [{
        id: 'legacy_action',
        projectId: PROJECT_A,
        priority: 'P1',
        title: '把开场机制带入母稿',
        adoptionText: '先完成母稿，再固定 CTA。',
        guardrail: '不复制对标账号的内容资产。',
        proposedExperiment: '一周后沉淀结果。',
      }],
    });

    const context = await benchmarkAdvisorContextForRun('legacy-copy-run');

    expect(context).toContain('把开场做法带入公众号文章');
    expect(context).toContain('结尾引导');
    expect(context).not.toMatch(/对标|公开样本|母稿|CTA|机制|内容资产|沉淀|赋能/);
  });

  it('rejects advisor adoption and context when a run belongs to another project', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);
    await refreshBenchmarkAdvisorResearch(PROJECT_A, collector);
    const actionId = (await getBenchmarkAdvisorState(PROJECT_A)).latestReport?.actions[0].id || '';
    await writeJson('runs/client-beta-run.json', { run_id: 'client-beta-run', slug: 'beta', project_id: PROJECT_B });

    await expect(adoptBenchmarkAdvisorAction(PROJECT_A, 'client-beta-run', actionId)).rejects.toThrow('另一个项目');
    await writeJson('runs/client-beta-run/benchmark-advisor/adopted-conclusions.json', {
      schema: 'aifios.benchmark-advisor.run-adoption.v2',
      projectId: PROJECT_A,
      adopted: [{ id: actionId, projectId: PROJECT_A, title: '错误混入' }],
    });
    expect(await benchmarkAdvisorContextForRun('client-beta-run')).toBe('');
  });

  it('does not create a second desktop alert when a refresh finds no material change', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);
    await refreshBenchmarkAdvisorResearch(PROJECT_A, collector);
    await acknowledgeBenchmarkAdvisorDesktopReminder(PROJECT_A);

    await refreshBenchmarkAdvisorResearch(PROJECT_A, collector);

    expect((await getBenchmarkAdvisorDesktopReminder(PROJECT_A)).shouldNotify).toBe(false);
    expect((await refreshBenchmarkAdvisorIfDue(PROJECT_A, collector)).refreshed).toBe(false);
  });

  it('archives a project-scoped single-video analysis and only adopts its original angle into the matching run', async () => {
    await writeJson('runs/current-run.json', { run_id: 'current-run', slug: 'current', project_id: PROJECT_A });
    const state = await analyzeBenchmarkVideo(PROJECT_A, 'https://v.douyin.com/fixture-work/', videoCollector, videoGenerator);

    expect(state.latestVideoAnalysis).toMatchObject({
      projectId: PROJECT_A,
      evidence: { platform: 'douyin', title: '先讲一个具体问题，再说明为什么值得处理' },
      breakdown: { status: 'ready', angles: [{ id: 'angle_1' }, { id: 'angle_2' }, { id: 'angle_3' }] },
    });
    expect(state.archivePaths.videoAnalysis).toBe(`materials/advisors/benchmark/${PROJECT_A}/single-video/latest-video-analysis.json`);

    const adopted = await adoptBenchmarkVideoAngle(PROJECT_A, 'current-run', state.latestVideoAnalysis?.id || '', 'angle_1');
    expect(adopted.action.mechanism).toContain('单条视频');
    expect(await benchmarkAdvisorContextForRun('current-run')).toContain('从客户问题开始');
    await expect(adoptBenchmarkVideoAngle(PROJECT_B, 'current-run', state.latestVideoAnalysis?.id || '', 'angle_1')).rejects.toThrow('另一个项目');
  });

  it('reuses the current project archive for the same public video URL', async () => {
    let collectorCalls = 0;
    let generatorCalls = 0;
    const countingCollector: ViralVideoEvidenceCollector = async (projectId, sourceUrl) => {
      collectorCalls += 1;
      return videoCollector(projectId, sourceUrl);
    };
    const countingGenerator: ViralVideoBreakdownGenerator = async (evidence) => {
      generatorCalls += 1;
      return videoGenerator(evidence);
    };

    const first = await analyzeBenchmarkVideo(PROJECT_A, 'https://v.douyin.com/fixture-work/', countingCollector, countingGenerator);
    const second = await analyzeBenchmarkVideo(PROJECT_A, 'https://v.douyin.com/fixture-work/', countingCollector, countingGenerator);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.latestVideoAnalysis?.id).toBe(first.latestVideoAnalysis?.id);
    expect(collectorCalls).toBe(1);
    expect(generatorCalls).toBe(1);
  });

  it('rejects an unsupported URL before starting a TikOmni video collector', async () => {
    const neverCollect: ViralVideoEvidenceCollector = async () => {
      throw new Error('collector should not be called');
    };

    await expect(analyzeBenchmarkVideo(PROJECT_A, 'https://example.com/not-a-video', neverCollect, videoGenerator))
      .rejects.toThrow('抖音、视频号或小红书');
  });

  it('keeps a provider first frame distinct from an official cover when loading an archived video analysis', async () => {
    const state = await analyzeBenchmarkVideo(PROJECT_A, 'https://v.douyin.com/fixture-work/', videoCollector, videoGenerator);
    const stored = JSON.parse(await readFile(path.join(mocks.projectDir, state.archivePaths.videoAnalysis), 'utf-8')) as Record<string, unknown>;
    const evidence = stored.evidence as Record<string, unknown>;
    delete evidence.coverImage;
    delete evidence.coverType;
    delete evidence.firstFrameImage;
    delete evidence.coverPath;
    delete evidence.coverContentType;
    delete evidence.coverSource;
    delete evidence.coverLabel;
    evidence.cover_image = 'https://example.test/opening-frame.jpg';
    evidence.cover_type = 'first_frame';
    evidence.cover_path = `materials/advisors/benchmark/${PROJECT_A}/single-video/media/20260805-113000-abcdef1234/${'c'.repeat(64)}.jpg`;
    evidence.cover_source = 'video_first_frame';
    evidence.cover_label = '视频首帧';
    await writeJson(state.archivePaths.videoAnalysis, stored);

    const loaded = await getBenchmarkAdvisorState(PROJECT_A);
    expect(loaded.latestVideoAnalysis?.evidence).toMatchObject({
      coverImage: '',
      coverType: 'first_frame',
      firstFrameImage: 'https://example.test/opening-frame.jpg',
      coverPath: `materials/advisors/benchmark/${PROJECT_A}/single-video/media/20260805-113000-abcdef1234/${'c'.repeat(64)}.jpg`,
      coverSource: 'video_first_frame',
      coverLabel: '视频首帧',
    });
  });

  it('keeps a locally archived public-preview cover distinct from a video first frame', async () => {
    const state = await analyzeBenchmarkVideo(PROJECT_A, 'https://v.douyin.com/fixture-work/', videoCollector, videoGenerator);
    const stored = JSON.parse(await readFile(path.join(mocks.projectDir, state.archivePaths.videoAnalysis), 'utf-8')) as Record<string, unknown>;
    const evidence = stored.evidence as Record<string, unknown>;
    delete evidence.coverImage;
    delete evidence.coverType;
    delete evidence.firstFrameImage;
    delete evidence.coverPath;
    delete evidence.coverContentType;
    delete evidence.coverSource;
    delete evidence.coverLabel;
    evidence.cover_image = 'https://finder.video.qq.com/cover.webp?fixture=preview';
    evidence.cover_path = `materials/advisors/benchmark/${PROJECT_A}/single-video/media/20260805-113000-abcdef1234/${'d'.repeat(64)}.webp`;
    evidence.cover_source = 'wechat_channels_public_preview';
    evidence.cover_label = '视频号公开预览封面';
    await writeJson(state.archivePaths.videoAnalysis, stored);

    const loaded = await getBenchmarkAdvisorState(PROJECT_A);
    expect(loaded.latestVideoAnalysis?.evidence).toMatchObject({
      coverImage: 'https://finder.video.qq.com/cover.webp?fixture=preview',
      coverType: 'cover',
      firstFrameImage: '',
      coverPath: `materials/advisors/benchmark/${PROJECT_A}/single-video/media/20260805-113000-abcdef1234/${'d'.repeat(64)}.webp`,
      coverSource: 'wechat_channels_public_preview',
      coverLabel: '视频号公开预览封面',
    });
  });

  it('does not replace the last successful video analysis when TikOmni collection fails', async () => {
    await analyzeBenchmarkVideo(PROJECT_A, 'https://v.douyin.com/fixture-work/', videoCollector, videoGenerator);
    const unavailable: ViralVideoEvidenceCollector = async () => {
      throw new BenchmarkAdvisorInputError('TikOmni Token 当前不可用。');
    };
    await expect(analyzeBenchmarkVideo(PROJECT_A, 'https://v.douyin.com/another-work/', unavailable, videoGenerator)).rejects.toThrow('平台数据连接失败');
    expect((await getBenchmarkAdvisorState(PROJECT_A)).latestVideoAnalysis?.evidence.sourceUrl).toBe('https://v.douyin.com/fixture-work/');
  });

  it('does not persist provider errors, local paths or credentials after a failed account refresh', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);
    const unsafeCollector: BenchmarkEvidenceCollector = async () => {
      throw new Error('stderr: /Users/customer/private.json api_key=sk-super-secret-token-value stack at collector.py:42');
    };

    await expect(refreshBenchmarkAdvisorResearch(PROJECT_A, unsafeCollector)).rejects.toThrow('平台数据连接失败');
    const state = await getBenchmarkAdvisorState(PROJECT_A);
    const stored = await readFile(path.join(mocks.projectDir, `materials/advisors/benchmark/${PROJECT_A}/weekly-state.json`), 'utf-8');
    const projected = JSON.stringify(state.weekly);
    expect(projected).toContain('平台数据连接失败');
    expect(stored).not.toContain('/Users/customer');
    expect(stored).not.toContain('sk-super-secret');
    expect(stored).not.toContain('collector.py');
  });

  it('blocks unsafe account reports and single-video analysis before archive writes', async () => {
    await saveBenchmarkAccounts(PROJECT_A, accounts(), true);
    const unsafeAccountCollector: BenchmarkEvidenceCollector = async (projectId, configured) => {
      const evidence = await collector(projectId, configured);
      evidence.accounts[0].works.items[0].openingMechanisms = [
        '作为 AI，我读取了 /Users/customer/private.json api_key=sk-super-secret-token-value',
      ];
      return evidence;
    };
    await expect(refreshBenchmarkAdvisorResearch(PROJECT_A, unsafeAccountCollector)).rejects.toThrow('不适合展示');
    expect((await getBenchmarkAdvisorState(PROJECT_A)).latestReport).toBeNull();

    const unsafeVideoGenerator: ViralVideoBreakdownGenerator = async (evidence) => ({
      ...await videoGenerator(evidence),
      topic: '作为 AI，我读取了 /Users/customer/private.json api_key=sk-super-secret-token-value',
    });
    await expect(analyzeBenchmarkVideo(PROJECT_A, 'https://v.douyin.com/unsafe-work/', videoCollector, unsafeVideoGenerator)).rejects.toThrow('不适合展示');
    expect((await getBenchmarkAdvisorState(PROJECT_A)).latestVideoAnalysis).toBeNull();
  });
});

import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaterialAnalysisContext } from './material-analysis';

const mocks = vi.hoisted(() => ({ project: `/tmp/echo-preference-reuse-${process.pid}`, context: null as MaterialAnalysisContext | null }));
vi.mock('./project-root', () => ({
  PROJECT_DIR: mocks.project, projectPath: (...parts: string[]) => `${mocks.project}/${parts.join('/')}`, runtimeJoin: (...parts: string[]) => parts.join('/'),
  safeResolve: (base: string, target: string) => target.split('/').some((part) => part === '..') ? null : `${base}/${target}`,
}));
vi.mock('./material-analysis', () => ({
  getMaterialAnalysisContext: async (runId: string) => mocks.context?.runId === runId ? mocks.context : null,
  isMaterialAnalysisCurrent: (context: MaterialAnalysisContext) => context.analysisStatus === 'current' && context.inputFingerprint === context.analysisInputFingerprint,
  getMaterialWritingRequirements: (context: MaterialAnalysisContext) => context.analysis.authorRequirements || [],
}));
import { readCreativeProfile, readCreativeRules, saveCreativeProfile } from './creative-library';
import { readDraftPreferenceReview, saveDraftPreferences } from './draft-preference-reuse';
const INPUT = 'a'.repeat(64);

beforeEach(async () => {
  await rm(mocks.project, { recursive: true, force: true }); await mkdir(mocks.project, { recursive: true });
  mocks.context = { schema: 'aifios.material-analysis-context.v1', runId: 'run-a', createdAt: '', updatedAt: '', inputFingerprint: INPUT, analysisInputFingerprint: INPUT,
    analysisStatus: 'current', analysis_source: 'manual', input: { rawMaterial: '原稿保留', files: [], links: [] }, selection: null,
    analysis: { summary: '', facts: [], cases: [], risks: [], authorRequirements: ['目标读者：小团队负责人', '语气：平实', '不写营销口号'], recommendedTypeId: 'insight', recommendedStructureId: '' },
  } as unknown as MaterialAnalysisContext;
});
afterEach(async () => { await rm(mocks.project, { recursive: true, force: true }); });

async function payload() {
  const review = await readDraftPreferenceReview('run-a', INPUT);
  return { runId: 'run-a', inputFingerprint: INPUT, analysisFingerprint: review.analysisFingerprint, expectedVersion: review.profile.version,
    choices: [{ id: review.candidates.find((item) => item.field === 'writingStyle')!.id, value: '平实，用短句' }] };
}

describe('explicit preference promotion into the existing profile', () => {
  it('reading candidates neither initializes settings nor modifies the source', async () => {
    const before = JSON.stringify(mocks.context);
    expect((await readDraftPreferenceReview('run-a', INPUT)).candidates).toHaveLength(3);
    expect((await readCreativeProfile()).initialized).toBe(false);
    expect(JSON.stringify(mocks.context)).toBe(before);
  });
  it('initializes only explicitly selected and edited preferences, leaving the article intact', async () => {
    const before = JSON.stringify(mocks.context);
    const saved = await saveDraftPreferences(await payload());
    expect(saved.profile.writingStyle).toBe('平实，用短句');
    expect(saved.profile.targetAudience).toBe(''); expect(saved.profile.prohibitions).toBe(''); expect(saved.profile.creatorName).toBe('');
    expect(JSON.stringify(mocks.context)).toBe(before);
    expect((await readCreativeRules()).initialized).toBe(false);
  });
  it('appends existing settings without overwriting identity or making duplicate additions', async () => {
    await saveCreativeProfile({ action: 'initialize', profile: { creatorName: '原作者', writingStyle: '温和', identity: '原身份' } });
    const saved = await saveDraftPreferences(await payload());
    expect(saved.profile).toMatchObject({ creatorName: '原作者', identity: '原身份', writingStyle: '温和\n平实，用短句' });
    const again = await saveDraftPreferences(await payload());
    expect(again.version).toBe(saved.version);
  });
  it('rejects another run and edited or stale inputs before offering a profile candidate', async () => {
    await expect(readDraftPreferenceReview('run-b', INPUT)).rejects.toThrow();
    await expect(readDraftPreferenceReview('run-a', 'b'.repeat(64))).rejects.toThrow();
    mocks.context!.analysisStatus = 'stale';
    await expect(readDraftPreferenceReview('run-a', INPUT)).rejects.toThrow();
    expect((await readCreativeProfile()).initialized).toBe(false);
  });
  it('rejects changed author corrections even when the original source text is unchanged', async () => {
    const pending = await payload();
    mocks.context!.correctionId = 'new-correction'; mocks.context!.analysis.authorRequirements = ['语气：克制'];
    await expect(saveDraftPreferences(pending)).rejects.toThrow('本篇要求已修改');
    expect((await readCreativeProfile()).initialized).toBe(false);
  });
  it('rejects concurrent settings edits without overwriting them', async () => {
    const pending = await payload();
    await saveCreativeProfile({ action: 'initialize', profile: { writingStyle: '其他窗口的设置' } });
    await expect(saveDraftPreferences(pending)).rejects.toThrow('写作设置已更新');
    expect((await readCreativeProfile()).profile.writingStyle).toBe('其他窗口的设置');
  });
  it('rejects unselected, forged, duplicate, blank or temporary edited choices before any write', async () => {
    const pending = await payload();
    for (const choices of [[], [{ id: 'fake', value: '平实' }], [...pending.choices, ...pending.choices], [{ id: pending.choices[0].id, value: '内部测试，不要发布' }], [{ id: pending.choices[0].id, value: '' }], [{ id: pending.choices[0].id, value: '仅用于这一篇，不引导私信' }]]) {
      await expect(saveDraftPreferences({ ...pending, choices })).rejects.toThrow();
      expect((await readCreativeProfile()).initialized).toBe(false);
    }
  });
});

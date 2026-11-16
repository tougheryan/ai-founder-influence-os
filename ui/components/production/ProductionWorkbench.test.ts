import { describe, expect, it } from 'vitest';
import { modelSetupMessage } from './ProductionSetupChecklist';
import { createProductionDraft } from './production-model';
import {
  approvalRequestIdForStage,
  displayProductionNotice,
  tikOmniResearchBlockerMessage,
  topicResearchNeedsMaterialReset,
  recoverableProductionDraft,
  taskPanelCoversNotice,
  draftAfterPlatformChange,
  draftAfterMaterialChange,
  toStoredMaterialAnalysis,
  toStoredMaterialFiles,
  toStoredDraft,
  draftAfterMaterialAnalysis,
  draftAfterWritingChoice,
} from './ProductionWorkbench';

const MATERIAL_FINGERPRINT = 'a'.repeat(64);
describe('starting from an explicit author title', () => {
  it('restores the explicit reuse mode and keeps a new title during analysis', () => {
    const files = [{ name: '旧素材.md', path: 'materials/reuse.md', sourcePath: 'materials/reuse.md', extractionStatus: 'existing_extraction', writingRequirements: 'reference_only' }];
    expect(toStoredMaterialFiles(JSON.parse(JSON.stringify(files)))).toEqual(files);
    const draft = toStoredDraft({ ...createProductionDraft(), topic: '新的客户问题', writingMode: 'author_material', writingModeChosen: true });
    expect(draftAfterMaterialAnalysis(draft, '题目：新的客户问题')).toMatchObject({ topic: '新的客户问题', writingMode: 'author_material', writingModeChosen: true });
    expect(Object.values(draft.approved).every((value) => value === false)).toBe(true);
  });
  it('carries an opening title and later writing request into direct author mode without confirming it', () => {
    const input = '【付费体验模拟，非真实客户经历】\n题目：报价之后，客户问“为什么这么贵”，怎么回答。\n以下是虚构练习：客户比较两家报价。\n写给独立顾问，公众号，800字以内。只用这些材料，按这个题目写。';
    const initial = createProductionDraft();
    const next = draftAfterMaterialAnalysis(initial, input);
    expect(next).toMatchObject({ writingMode: 'author_material', topic: '报价之后，客户问“为什么这么贵”，怎么回答', runId: '', artifactPaths: {} });
    expect(next.approved).toEqual(initial.approved);
    const research = draftAfterWritingChoice(next, { writingMode: 'platform' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(research), input)).toMatchObject({ writingMode: 'platform', topic: '', writingModeChosen: true });
    const cleared = draftAfterWritingChoice(next, { topic: '' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(cleared), input).topic).toBe('');
  });
  it('prefills the separately stated paid-user title but preserves later user choices', () => {
    const input = '【虚构练习，仅用于产品体验】我是一名独立设计顾问，想写给小团队负责人。题目是“项目来不及交付，怎样提前跟客户说”。设定：还有三天交稿，客户的资料仍不齐。请写600字左右的公众号文章。';
    const draft = draftAfterMaterialAnalysis(createProductionDraft(), input);
    expect(draft).toMatchObject({ writingMode: 'author_material', topic: '项目来不及交付，怎样提前跟客户说', runId: '', artifactPaths: {} });
    expect(Object.values(draft.approved).every((value) => value === false)).toBe(true);
    const research = draftAfterWritingChoice(draft, { writingMode: 'platform' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(research), input)).toMatchObject({ writingMode: 'platform', topic: '' });
    const edited = draftAfterWritingChoice(draft, { topic: '我改过的题目' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(edited), input).topic).toBe('我改过的题目');
    const cleared = draftAfterWritingChoice(edited, { topic: '' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(cleared), input).topic).toBe('');
  });
  const material = '我想写一篇公众号文章，题目是《客户说“顺便加一页”时，我先确认三件事》。不要编造合作结果。';
  it('carries a title after the author introduction and preserves subsequent choices through reopening', () => {
    const input = '我经营一家做网站的小工作室，想写一篇公众号文章，题目是“客户加需求时，怎样开口谈费用”。读者是第一次独立接单的设计师。';
    const next = draftAfterMaterialAnalysis(createProductionDraft(), input);
    expect(next).toMatchObject({ writingMode: 'author_material', topic: '客户加需求时，怎样开口谈费用', runId: '', artifactPaths: {} });
    expect(Object.values(next.approved).every((value) => value === false)).toBe(true);
    expect(draftAfterMaterialAnalysis(toStoredDraft(next), input).topic).toBe(next.topic);
    const edited = draftAfterWritingChoice(next, { topic: '谈报价之前先确认范围' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(edited), input).topic).toBe('谈报价之前先确认范围');
    const cleared = draftAfterWritingChoice(edited, { topic: '' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(cleared), input)).toMatchObject({ writingMode: 'author_material', topic: '' });
    const research = draftAfterWritingChoice(next, { writingMode: 'platform' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(research), input)).toMatchObject({ writingMode: 'platform', topic: '' });
  });
  it('carries the audit request into author mode and preserves an intentional title change on reopening', () => {
    const input = '【体验用虚构素材】\n我的观点：先确认范围。\n请写公众号文章，题目是《客户临时加需求，先问清这三件事》。600到800字。';
    const next = draftAfterMaterialAnalysis(createProductionDraft(), input);
    expect(next).toMatchObject({ writingMode: 'author_material', topic: '客户临时加需求，先问清这三件事', runId: '' });
    expect(Object.values(next.approved).every((value) => value === false)).toBe(true);
    const edited = draftAfterWritingChoice(next, { topic: '我自己的标题' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(edited), input).topic).toBe('我自己的标题');
  });
  it('prefills an untouched draft without approving or creating any production work', () => {
    const initial = createProductionDraft();
    const next = draftAfterMaterialAnalysis(initial, material);
    expect(next.writingMode).toBe('author_material');
    expect(next.topic).toBe('客户说“顺便加一页”时，我先确认三件事');
    expect(next.runId).toBe('');
    expect(next.approved).toEqual(initial.approved);
    expect(next.artifactPaths).toEqual({});
    expect(initial.topic).toBe('');
  });
  it.each(['没有确定题目的客户笔记', '客户说：已有题目：《别人的标题》', '已有题目：《甲》\n已有题目：《乙》'])('keeps research available for absent, quoted or ambiguous titles: %s', (input) => {
    expect(draftAfterMaterialAnalysis(createProductionDraft(), input)).toMatchObject({ writingMode: 'platform', topic: '' });
  });
  it('preserves an explicit research choice through re-analysis, saving and reopening', () => {
    const first = draftAfterMaterialAnalysis(createProductionDraft(), material);
    const research = draftAfterWritingChoice(first, { writingMode: 'platform' });
    const revised = draftAfterMaterialAnalysis(research, material);
    const reopened = toStoredDraft(JSON.parse(JSON.stringify(revised)));
    expect(draftAfterMaterialAnalysis(reopened, material)).toMatchObject({ writingMode: 'platform', writingModeChosen: true, topic: '' });
  });
  it('keeps a manual title and respects deliberately clearing it', () => {
    const first = draftAfterMaterialAnalysis(createProductionDraft(), material);
    const manual = draftAfterWritingChoice(first, { topic: '我自己的改法' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(manual), material).topic).toBe('我自己的改法');
    const cleared = draftAfterWritingChoice(manual, { topic: '' });
    expect(draftAfterMaterialAnalysis(toStoredDraft(cleared), material)).toMatchObject({ writingMode: 'author_material', topic: '', writingModeChosen: true });
  });
  it('does not guess whether a legacy saved mode was an author choice', () => {
    const legacy = toStoredDraft({ writingMode: 'platform', runId: 'legacy', topic: '' });
    expect(draftAfterMaterialAnalysis(legacy, material)).toMatchObject({ writingMode: 'platform', topic: '', writingModeChosen: true });
    expect(draftAfterMaterialAnalysis(toStoredDraft({}), material).writingMode).toBe('author_material');
  });
  it('invalidates downstream approvals when the author changes writing basis', () => {
    const current = createProductionDraft();
    current.approved['material-boundary'] = true;
    current.approved['topic-template'] = true;
    current.approved['content-package'] = true;
    const next = draftAfterWritingChoice(current, { writingMode: 'author_material' });
    expect(next.approved['material-boundary']).toBe(true);
    expect(next.approved['topic-template']).toBe(false);
    expect(next.approved['content-package']).toBe(false);
    expect(current.approved['topic-template']).toBe(true);
  });
});
it('preserves qualified examples when reading analysis into a saved or reopened workbench', () => {
  const analysis = { summary: '已整理', facts: [], opinions: ['先确认范围'], cases: [], risks: ['本次是虚构情境'],
    illustrations: ['模拟或虚构情境（粘贴文字）：客户说：“顺便加一页。”'],
    authorRequirements: ['保留客户原话'], recommendedTypeId: 'business-growth', recommendedStructureId: 'customer-question-method' };
  expect(toStoredMaterialAnalysis(analysis)).toEqual(analysis);
  expect(toStoredMaterialAnalysis(toStoredMaterialAnalysis(analysis))).toEqual(analysis);
  const oldAnalysis: Partial<typeof analysis> = { ...analysis };
  delete oldAnalysis.illustrations;
  expect(toStoredMaterialAnalysis(oldAnalysis)).not.toHaveProperty('illustrations');
});
describe('changing platforms after choosing an author title', () => {
  it('keeps the author title and material while requiring a new downstream plan review', () => {
    const current = createProductionDraft();
    current.writingMode = 'author_material';
    current.topic = '临时加需求，先把这三件事写清楚';
    current.runId = 'current-run';
    current.approved['material-boundary'] = true;
    current.approved['topic-template'] = true;
    current.approved['content-package'] = true;
    current.artifactPaths = { 'material-boundary': 'pipeline/intake/current.md', 'topic-template': 'pipeline/blueprint/old.md', 'content-package': 'pipeline/package/old.md' };
    const next = draftAfterPlatformChange(current, ['wechat']);
    expect(next.topic).toBe(current.topic);
    expect(next.selectedPlatforms).toEqual(['wechat']);
    expect(next.runId).toBe('current-run');
    expect(next.artifactPaths['material-boundary']).toBe('pipeline/intake/current.md');
    expect(next.approved['material-boundary']).toBe(true);
    expect(next.approved['topic-template']).toBe(false);
    expect(next.approved['content-package']).toBe(false);
    expect(next.artifactPaths['topic-template']).toBeUndefined();
    expect(next.artifactPaths['content-package']).toBeUndefined();
    expect(current.approved['topic-template']).toBe(true);
  });
  it('requires a new topic for a different platform research selection', () => {
    const current = { ...createProductionDraft(), topic: '旧平台研究得出的选题' };
    expect(draftAfterPlatformChange(current, ['xhs']).topic).toBe('');
  });
  it('preserves a confirmed author title when material changes while invalidating old work', () => {
    const current = createProductionDraft();
    current.writingMode = 'author_material';
    current.topic = '用户已改好的标题';
    current.approved['material-boundary'] = true;
    current.approved['topic-template'] = true;
    current.artifactPaths = { 'material-boundary': 'pipeline/intake/old.md', 'topic-template': 'pipeline/blueprint/old.md' };
    const next = draftAfterMaterialChange(current);
    expect(next.topic).toBe('用户已改好的标题');
    expect(next.writingMode).toBe('author_material');
    expect(Object.values(next.approved).every((value) => !value)).toBe(true);
    expect(next.artifactPaths).toEqual({});
    expect(current.approved['material-boundary']).toBe(true);
    expect(draftAfterMaterialChange({ ...current, writingMode: 'platform' }).topic).toBe('');
  });
});
describe('task notice visibility', () => {
  const task = { taskId: 'task-1', kind: 'author-blueprint', currentStep: 'content-blueprint' };
  const props = { task, noticeTaskId: 'task-1', stageId: 'topic-template' as const, taskPanelVisible: true };
  it('deduplicates only a notice belonging to the displayed task', () => {
    expect(taskPanelCoversNotice(props)).toBe(true);
    expect(taskPanelCoversNotice({ ...props, noticeTaskId: undefined })).toBe(false);
    expect(taskPanelCoversNotice({ ...props, noticeTaskId: 'different-task' })).toBe(false);
  });
  it('keeps notices when the task is absent, hidden, or only summarized in another stage', () => {
    expect(taskPanelCoversNotice({ ...props, task: null })).toBe(false);
    expect(taskPanelCoversNotice({ ...props, taskPanelVisible: false })).toBe(false);
    expect(taskPanelCoversNotice({ ...props, stageId: 'material-boundary' })).toBe(false);
  });
});
describe('explicit period recovery', () => {
  it('offers an active run without copying approval authority from its summary', () => {
    const restored = recoverableProductionDraft({
      status: 'active', run_id: 'run-1', slug: 'topic-1', project_id: 'customer-1',
      topic: '客户反复问的问题', selected_platforms: ['xhs'], visual_template: 'wechat-native',
      approvals: { content_package: true }, phase_artifacts: { content_package: 'pipeline/package/old.md' },
    });
    expect(restored).toMatchObject({ runId: 'run-1', projectId: 'customer-1', selectedPlatforms: ['xhs'], topic: '客户反复问的问题' });
    expect(Object.values(restored!.approved).every((approved) => !approved)).toBe(true);
    expect(restored!.artifactPaths).toEqual({});
  });
  it('does not offer archived, completed or malformed runs', () => {
    for (const status of ['archived', 'completed', undefined]) {
      expect(recoverableProductionDraft({ status, run_id: 'run-1', slug: 'topic-1' })).toBeNull();
    }
    expect(recoverableProductionDraft({ status: 'active', run_id: '../other', slug: 'topic-1' })).toBeNull();
    expect(recoverableProductionDraft(null)).toBeNull();
  });
  it('keeps legacy platform selections and hides a temporary identifier from the title', () => {
    expect(recoverableProductionDraft({ status: 'active', run_id: 'run-1', slug: 'run-1', topic: 'run-1' }))
      .toMatchObject({ topic: '', selectedPlatforms: ['wechat', 'xhs', 'shipinhao'] });
  });
});
it('distinguishes missing credentials, configured direct accounts and disconnected hosted accounts', () => {
  const config = { provider: 'deepseek', model: 'test', apiKey: '' };
  expect(modelSetupMessage(config)).toContain('尚未配置模型密钥');
  expect(modelSetupMessage({ ...config, hasEnvKey: true })).toBeNull();
  expect(modelSetupMessage({ ...config, hasSavedKey: true })).toBeNull();
  expect(modelSetupMessage({ ...config, connectionMode: 'hosted', gatewayConnected: false })).toContain('连接生成服务');
  expect(modelSetupMessage({ ...config, connectionMode: 'hosted', gatewayConnected: true })).toBeNull();
  expect(modelSetupMessage(null)).toContain('尚未读到');
});
const NEWER_MATERIAL_FINGERPRINT = 'b'.repeat(64);
const researchEvidence = {
  reportPath: 'runs/material-1/market-research/report.md',
  snapshotPath: 'runs/material-1/market-research/snapshot/snapshot.json',
  snapshotSha256: 'c'.repeat(64),
  status: 'complete',
  sampleCount: 12,
  queries: ['长期主义'],
  requiredPlatforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
};

describe('tikOmniResearchBlockerMessage', () => {
  it('keeps platform-specific details while removing the provider name', () => {
    expect(tikOmniResearchBlockerMessage([
      { code: 'platform_unavailable', message: '视频号的 TikOmni 实时数据不可用。' },
      { code: 'platform_unavailable', message: '小红书的 TikOmni 实时数据不可用。' },
    ])).toBe('视频号的公开内容服务当前内容不可用。；小红书的公开内容服务当前内容不可用。');
  });

  it('ignores malformed and duplicate blocker entries', () => {
    expect(tikOmniResearchBlockerMessage([
      null,
      { code: 'platform_unavailable' },
      { message: '  TikOmni Token 未配置。  ' },
      { message: 'TikOmni Token 未配置。' },
      { message: 42 },
    ])).toBe('公开内容服务访问凭证未配置。');
  });
});

describe('displayProductionNotice', () => {
  it('turns internal workflow terms into direct product language and hides identifiers', () => {
    expect(displayProductionNotice(
      'task_abc 已生成视觉候选，内容包位于 pipeline/content/demo/package.md，版本哈希已保存。',
    )).toBe('相关记录已生成配图方案，全部内容位于相关文件，内容版本已保存。');
  });

  it('replaces unknown technical exceptions instead of exposing them', () => {
    expect(displayProductionNotice(
      'TypeError: fetch failed at /Users/customer/project/runtime.ts token=private',
    )).toBe('这一步没有完成。请重试；如果仍然失败，请到系统设置测试连接。');
  });
});

describe('topicResearchNeedsMaterialReset', () => {
  it('keeps research only when its stored material binding matches the current server analysis', () => {
    expect(topicResearchNeedsMaterialReset(researchEvidence, MATERIAL_FINGERPRINT, {
      inputFingerprint: MATERIAL_FINGERPRINT,
      analysisInputFingerprint: MATERIAL_FINGERPRINT,
      analysisStatus: 'current',
    })).toBe(false);
  });

  it('fails closed for legacy browser research that has no material binding', () => {
    expect(topicResearchNeedsMaterialReset(researchEvidence, '', {
      inputFingerprint: MATERIAL_FINGERPRINT,
      analysisInputFingerprint: MATERIAL_FINGERPRINT,
      analysisStatus: 'current',
    })).toBe(true);
  });

  it('clears restored research when the server material input has changed', () => {
    expect(topicResearchNeedsMaterialReset(researchEvidence, MATERIAL_FINGERPRINT, {
      inputFingerprint: NEWER_MATERIAL_FINGERPRINT,
      analysisInputFingerprint: NEWER_MATERIAL_FINGERPRINT,
      analysisStatus: 'current',
    })).toBe(true);
  });

  it('clears research when a current server analysis names a newer material snapshot', () => {
    expect(topicResearchNeedsMaterialReset(researchEvidence, MATERIAL_FINGERPRINT, {
      inputFingerprint: MATERIAL_FINGERPRINT,
      analysisInputFingerprint: NEWER_MATERIAL_FINGERPRINT,
      analysisStatus: 'current',
    })).toBe(true);
  });
});

describe('approvalRequestIdForStage', () => {
  it('reuses one request ID across retries and rotates only after success clears it', () => {
    const pending: Partial<Record<'content-package', string>> = {};
    let sequence = 0;
    const create = () => `approval-content-package-${sequence += 1}`;

    const first = approvalRequestIdForStage(pending, 'content-package', create);
    const retry = approvalRequestIdForStage(pending, 'content-package', create);
    delete pending['content-package'];
    const nextConfirmation = approvalRequestIdForStage(pending, 'content-package', create);

    expect(retry).toBe(first);
    expect(nextConfirmation).not.toBe(first);
  });
});

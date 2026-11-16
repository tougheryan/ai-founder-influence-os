import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_STAGES,
  createProductionDraft,
  getProductionStage,
  canAdvanceStage,
  canViewProductionStage,
  applySavedWritingBrief,
  DEFAULT_PRODUCTION_PLATFORMS,
  detachUnavailableRuntimeRun,
  invalidateApprovalsFrom,
  isProductionStageApplicable,
  normalizeProductionPlatforms,
  requiredProductionStages,
  requiresServerApproval,
  isApprovalTargetReady,
  restoreVerifiedProductionProgress,
  resumableProductionStage,
} from './production-model';
import type { ProductionFlowIntegrity } from '@/lib/production-flow';
import { MATERIAL_TYPE_CATALOG } from './MaterialIntakeWorkspace';

describe('production workbench model', () => {
  it('preserves the article for immediate comparison after saving a plan without preserving downstream approvals', () => {
    const draft = createProductionDraft();
    draft.runId = 'run-a';
    for (const stage of PRODUCTION_STAGES) draft.approved[stage.id] = true;
    draft.artifactPaths = { 'topic-template': 'old-plan.md', 'content-package': 'old-article.md', 'visual-assets': 'old-images.md' };
    const changed = applySavedWritingBrief(draft, 'new-plan.md');
    expect(changed.artifactPaths['content-package']).toBe('old-article.md');
    expect(changed.artifactPaths['topic-template']).toBe('new-plan.md');
    expect(changed.artifactPaths['visual-assets']).toBeUndefined();
    expect(changed.approved['material-boundary']).toBe(true);
    for (const stage of PRODUCTION_STAGES.slice(1)) expect(changed.approved[stage.id]).toBe(false);
    expect(canViewProductionStage(changed, 'content-package')).toBe(true);
    expect(canAdvanceStage(changed, 'content-package')).toBe(false);
    expect(canViewProductionStage(changed, 'visual-assets')).toBe(false);
    expect(resumableProductionStage(changed, 'content-package')).toBe('content-package');
    expect(resumableProductionStage(changed)).toBe('topic-template');
    expect(draft.artifactPaths['topic-template']).toBe('old-plan.md');
  });
  it('does not unlock missing articles or disconnected runs for read-only navigation', () => {
    const draft = createProductionDraft();
    draft.runId = 'run-a';
    expect(canViewProductionStage(draft, 'content-package')).toBe(false);
    draft.artifactPaths['content-package'] = 'old-article.md';
    expect(canViewProductionStage(draft, 'content-package')).toBe(true);
    expect(canAdvanceStage(draft, 'content-package')).toBe(false);
    expect(canViewProductionStage(detachUnavailableRuntimeRun(draft), 'content-package')).toBe(false);
  });
  it('restores material completion and the next editable step from server evidence, dropping stale local paths', () => {
    const draft = { ...createProductionDraft(), runId: 'run-a', artifactPaths: { 'visual-assets': 'stale.json' } };
    const integrity = {
      run_id: 'run-a',
      artifacts: {
        material_boundary: { path: 'intake.md', exists: true },
        topic_template: { path: 'blueprint.md', exists: true },
        content_package: { path: 'article.md', exists: true },
      },
      approvals: { topic_template: { approved: true }, content_package: { approved: false } },
      weekly_review: { status: 'not_due' },
    } as unknown as ProductionFlowIntegrity;
    const restored = restoreVerifiedProductionProgress(draft, integrity);
    expect(restored.approved['material-boundary']).toBe(true);
    expect(restored.approved['topic-template']).toBe(true);
    expect(restored.approved['content-package']).toBe(false);
    expect(restored.artifactPaths['visual-assets']).toBeUndefined();
    expect(resumableProductionStage(restored)).toBe('content-package');
    expect(canAdvanceStage(restored, 'content-package')).toBe(true);
    expect(resumableProductionStage(restored, 'visual-assets')).toBe('content-package');
    expect(resumableProductionStage(restored, 'topic-template')).toBe('topic-template');
    expect(restoreVerifiedProductionProgress(draft, { ...integrity, run_id: 'other-run' })).toBe(draft);
    const changed = restoreVerifiedProductionProgress(draft, integrity, true);
    expect(Object.values(changed.approved).some(Boolean)).toBe(false);
    expect(resumableProductionStage(changed)).toBe('material-boundary');
  });

  it('does not require visual approval when restoring a video-only run', () => {
    const draft = { ...createProductionDraft(), runId: 'run-a', selectedPlatforms: ['shipinhao' as const] };
    const integrity = {
      run_id: 'run-a',
      artifacts: Object.fromEntries(['material_boundary', 'topic_template', 'content_package', 'draft_information'].map((scope) => [scope, { exists: true, path: `${scope}.md` }])),
      approvals: { topic_template: { approved: true }, content_package: { approved: true }, draft_information: { approved: true } },
      weekly_review: { status: 'not_due' },
    } as unknown as ProductionFlowIntegrity;
    const restored = restoreVerifiedProductionProgress(draft, integrity);
    expect(restored.approved['draft-information']).toBe(true);
    expect(resumableProductionStage(restored)).toBe('publication-result');
  });
  it('defines the seven production phases', () => {
    expect(PRODUCTION_STAGES.map((stage) => stage.id)).toEqual([
      'material-boundary',
      'topic-template',
      'content-package',
      'visual-assets',
      'draft-information',
      'publication-result',
      'weekly-review',
    ]);
    expect(PRODUCTION_STAGES.filter((stage) => stage.creativeEnhancement).map((stage) => stage.id)).toEqual([
      'topic-template',
      'content-package',
    ]);
  });

  it('keeps the visible workbench order aligned with the production contract', () => {
    expect(PRODUCTION_STAGES.map((stage) => stage.label)).toEqual([
      '素材与共享底稿',
      '平台选择与独立研究',
      '平台原生内容',
      '平台完整发布件',
      '检查发布成品',
      '记录发布结果',
      '每周复盘（可选）',
    ]);
    expect(PRODUCTION_STAGES[1]).toMatchObject({
      output: '平台选择、独立研究依据和平台选题',
      checkpoint: '核对受众、观点、结构和结尾，确认方案后继续',
      requiresHumanApproval: true,
    });
    expect(PRODUCTION_STAGES[6].optional).toBe(true);
    expect(PRODUCTION_STAGES.map((stage) => stage.workSegment)).toEqual([
      '准备素材',
      '确定选题',
      '制作内容',
      '平台成品',
      '平台成品',
      '发布与复盘',
      '发布与复盘',
    ]);
  });

  it('models one or more primary platform-native lanes', () => {
    expect(createProductionDraft().selectedPlatforms).toEqual(['wechat']);
    expect(DEFAULT_PRODUCTION_PLATFORMS).toEqual(['wechat', 'xhs', 'shipinhao']);
    expect(normalizeProductionPlatforms(['shipinhao'])).toEqual(['shipinhao']);
    expect(normalizeProductionPlatforms(['douyin', 'xhs'])).toEqual(['xhs']);
    expect(normalizeProductionPlatforms([])).toEqual(DEFAULT_PRODUCTION_PLATFORMS);
  });

  it('skips the visual stage for a video-only run without blocking later stages', () => {
    const draft = createProductionDraft();
    draft.selectedPlatforms = ['shipinhao'];
    draft.approved['material-boundary'] = true;
    draft.approved['topic-template'] = true;
    draft.approved['content-package'] = true;

    expect(isProductionStageApplicable(draft, 'visual-assets')).toBe(false);
    expect(requiredProductionStages(draft).map((stage) => stage.id)).not.toContain('visual-assets');
    expect(canAdvanceStage(draft, 'draft-information')).toBe(true);
  });

  it('keeps material direction to one of six fixed types and compatible structures', () => {
    expect(MATERIAL_TYPE_CATALOG.map((type) => type.id)).toEqual([
      'personal-experience',
      'interview-event',
      'personal-growth',
      'work-life-vlog',
      'business-growth',
      'global-expression',
    ]);
    expect(MATERIAL_TYPE_CATALOG.every((type) => type.structures.length >= 2 && type.structures.length <= 4)).toBe(true);
    expect(MATERIAL_TYPE_CATALOG.every((type) => type.platforms.every((platform) => (
      ['公众号', '小红书', '视频号', '抖音', '朋友圈'].includes(platform)
    )))).toBe(true);
  });

  it('keeps later phases locked until the preceding stage has completed', () => {
    const draft = createProductionDraft();

    expect(canAdvanceStage(draft, 'topic-template')).toBe(false);

    draft.approved['material-boundary'] = true;
    expect(canAdvanceStage(draft, 'topic-template')).toBe(true);
    expect(canAdvanceStage(draft, 'content-package')).toBe(false);

    draft.approved['material-boundary'] = false;
    draft.approved['topic-template'] = true;
    expect(canAdvanceStage(draft, 'content-package')).toBe(false);
  });

  it('normalizes stage links to a valid workbench phase', () => {
    expect(getProductionStage('5')).toBe('draft-information');
    expect(getProductionStage('999')).toBe('material-boundary');
    expect(getProductionStage(undefined)).toBe('material-boundary');
  });

  it('clears an approval and every downstream confirmation when an artifact becomes stale', () => {
    const draft = createProductionDraft();
    for (const stage of PRODUCTION_STAGES) draft.approved[stage.id] = true;

    const invalidated = invalidateApprovalsFrom(draft, 'content-package');

    expect(invalidated.approved['topic-template']).toBe(true);
    expect(invalidated.approved['content-package']).toBe(false);
    expect(invalidated.approved['visual-assets']).toBe(false);
    expect(invalidated.approved['weekly-review']).toBe(false);
    expect(draft.approved['content-package']).toBe(true);
  });

  it('keeps local input ownership while detaching a runtime run that no longer exists', () => {
    const draft = createProductionDraft();
    draft.runId = 'run-stale';
    draft.runSlug = 'stale-period';
    draft.artifactPaths['material-boundary'] = 'pipeline/intake/stale.md';
    for (const stage of PRODUCTION_STAGES) draft.approved[stage.id] = true;

    const detached = detachUnavailableRuntimeRun(draft);

    expect(detached.runId).toBe('');
    expect(detached.runSlug).toBe('');
    expect(detached.artifactPaths).toEqual({});
    expect(Object.values(detached.approved).every((approved) => !approved)).toBe(true);
    expect(detached.projectId).toBe(draft.projectId);
    expect(draft.runId).toBe('run-stale');
  });

  it('requires server-bound confirmation for phases two through six only', () => {
    expect(requiresServerApproval('material-boundary')).toBe(false);
    expect(requiresServerApproval('topic-template')).toBe(true);
    expect(requiresServerApproval('content-package')).toBe(true);
    expect(requiresServerApproval('visual-assets')).toBe(true);
    expect(requiresServerApproval('draft-information')).toBe(true);
    expect(requiresServerApproval('publication-result')).toBe(true);
    expect(requiresServerApproval('weekly-review')).toBe(false);
  });

  it('does not expose a human approval action until a server-bound artifact and run exist', () => {
    expect(isApprovalTargetReady('topic-template', '', 'pipeline/blueprint/topic.md')).toBe(false);
    expect(isApprovalTargetReady('topic-template', 'run-1', '')).toBe(false);
    expect(isApprovalTargetReady('topic-template', 'run-1', 'pipeline/blueprint/topic.md')).toBe(true);
    expect(isApprovalTargetReady('material-boundary', '', '')).toBe(true);
    expect(isApprovalTargetReady('weekly-review', '', '')).toBe(true);
  });
});

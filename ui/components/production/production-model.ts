import { DEFAULT_BRAND_TEMPLATE } from '@/lib/brand-templates';
import { PRODUCTION_STAGE_DISPLAY_NAMES } from '@/lib/product-copy';
import type { ProductionFlowIntegrity } from '@/lib/production-flow';

export const PRODUCTION_PLATFORMS = [
  { id: 'wechat', label: '公众号', content: '原生长文', visual: '公众号全文排版' },
  { id: 'xhs', label: '小红书', content: '原生图文', visual: 'P1-P8 观点图文卡片' },
  { id: 'shipinhao', label: '视频号', content: '原生口播', visual: null },
] as const;

export type ProductionPlatform = (typeof PRODUCTION_PLATFORMS)[number]['id'];
export const DEFAULT_PRODUCTION_PLATFORMS: ProductionPlatform[] = PRODUCTION_PLATFORMS.map((platform) => platform.id);

export type VisualMode = 'ai_enhanced' | 'stable';
export type VisualPreferences = {
  mode: VisualMode;
  directionCount: 2;
  providerPolicy: 'auto';
};

export const DEFAULT_VISUAL_PREFERENCES: VisualPreferences = {
  mode: 'stable',
  directionCount: 2,
  providerPolicy: 'auto',
};

export const PRODUCTION_STAGES = [
  {
    id: 'material-boundary',
    number: 1,
    phase: '素材',
    workSegment: '准备素材',
    label: PRODUCTION_STAGE_DISPLAY_NAMES['material-boundary'],
    summary: '添加真实素材，整理事实、案例、观点、受众、目标与不可公开边界。',
    output: '共享内容底稿',
    checkpoint: '素材整理完成后继续',
    approvalScope: undefined,
    creativeEnhancement: false,
    requiresHumanApproval: false,
    optional: false,
  },
  {
    id: 'topic-template',
    number: 2,
    phase: '选题',
    workSegment: '确定选题',
    label: PRODUCTION_STAGE_DISPLAY_NAMES['topic-template'],
    summary: '选择本期平台；每个平台分别研究同类内容并确定原生选题。',
    output: '平台选择、独立研究依据和平台选题',
    checkpoint: '核对受众、观点、结构和结尾，确认方案后继续',
    approvalScope: 'topic_template',
    creativeEnhancement: true,
    requiresHumanApproval: true,
    optional: false,
  },
  {
    id: 'content-package',
    number: 3,
    phase: '写内容',
    workSegment: '制作内容',
    label: PRODUCTION_STAGE_DISPLAY_NAMES['content-package'],
    summary: '只为已选平台生成原生内容；不同平台共享事实，但不互相改写。',
    output: '公众号原生长文、小红书原生图文或视频号原生口播',
    checkpoint: '分别确认已选平台的内容',
    approvalScope: 'content_package',
    creativeEnhancement: true,
    requiresHumanApproval: true,
    optional: false,
  },
  {
    id: 'visual-assets',
    number: 4,
    phase: '排版',
    workSegment: '平台成品',
    label: PRODUCTION_STAGE_DISPLAY_NAMES['visual-assets'],
    summary: '公众号生成可查看的全文排版；小红书生成 P1-P8 图文卡片；视频号自动跳过。',
    output: '公众号全文排版，或小红书 P1-P8 图文卡片',
    checkpoint: '查看并确认各平台排版',
    approvalScope: 'visual_assets',
    creativeEnhancement: false,
    requiresHumanApproval: true,
    optional: false,
  },
  {
    id: 'draft-information',
    number: 5,
    phase: '成品',
    workSegment: '平台成品',
    label: PRODUCTION_STAGE_DISPLAY_NAMES['draft-information'],
    summary: '按已选平台检查最终长文、图文卡片或口播执行稿。',
    output: '本期已选平台的可发布内容',
    checkpoint: '确认内容可用，并确认系统不会自动发布',
    approvalScope: 'draft_information',
    creativeEnhancement: false,
    requiresHumanApproval: true,
    optional: false,
  },
  {
    id: 'publication-result',
    number: 6,
    phase: '发布',
    workSegment: '发布与复盘',
    label: PRODUCTION_STAGE_DISPLAY_NAMES['publication-result'],
    summary: '发布后，逐项填写链接、时间或截图。',
    output: '发布记录',
    checkpoint: '逐项确认是否已发布',
    approvalScope: 'publication_result',
    creativeEnhancement: false,
    requiresHumanApproval: true,
    optional: false,
  },
  {
    id: 'weekly-review',
    number: 7,
    phase: '复盘',
    workSegment: '发布与复盘',
    label: PRODUCTION_STAGE_DISPLAY_NAMES['weekly-review'],
    summary: '填写本周数据和反馈，整理下一次选题和改进建议。',
    output: '本周总结和下次建议',
    checkpoint: '可跳过，不影响本期发布',
    approvalScope: undefined,
    creativeEnhancement: false,
    requiresHumanApproval: false,
    optional: true,
  },
] as const;

export type ProductionStageId = (typeof PRODUCTION_STAGES)[number]['id'];

export type ProductionDraft = {
  topic: string;
  writingMode?: 'platform' | 'author_material';
  // Explicit choices (including clearing a title) survive material re-analysis.
  writingModeChosen?: boolean;
  // A template ID is configured in Settings. The server resolves it to a
  // renderer-safe layout style when this run is created or confirmed.
  template: string;
  // Every run is bound to one customer/project namespace.  This keeps an
  // optional benchmark-advisor conclusion from leaking into another run.
  projectId: string;
  runId: string;
  runSlug: string;
  selectedPlatforms: ProductionPlatform[];
  visualPreferences: VisualPreferences;
  approved: Record<ProductionStageId, boolean>;
  artifactPaths: Partial<Record<ProductionStageId, string>>;
};

const INITIAL_APPROVALS: Record<ProductionStageId, boolean> = {
  'material-boundary': false,
  'topic-template': false,
  'content-package': false,
  'visual-assets': false,
  'draft-information': false,
  'publication-result': false,
  'weekly-review': false,
};

export function createProductionDraft(): ProductionDraft {
  return {
    topic: '',
    writingMode: 'platform',
    writingModeChosen: false,
    template: DEFAULT_BRAND_TEMPLATE.id,
    projectId: 'default',
    runId: '',
    runSlug: '',
    selectedPlatforms: ['wechat'],
    visualPreferences: { ...DEFAULT_VISUAL_PREFERENCES },
    approved: { ...INITIAL_APPROVALS },
    artifactPaths: {},
  };
}

export function getProductionStage(value: string | undefined): ProductionStageId {
  const number = Number(value);
  return PRODUCTION_STAGES.find((stage) => stage.number === number)?.id || 'material-boundary';
}

export function getProductionStageMeta(stageId: ProductionStageId) {
  return PRODUCTION_STAGES.find((stage) => stage.id === stageId) || PRODUCTION_STAGES[0];
}

export function requiresServerApproval(stageId: ProductionStageId): boolean {
  return Boolean(getProductionStageMeta(stageId).approvalScope);
}

export function isApprovalTargetReady(
  stageId: ProductionStageId,
  runId: string,
  artifactPath: string | undefined,
): boolean {
  return !requiresServerApproval(stageId) || Boolean(runId && artifactPath);
}

export function canAdvanceStage(draft: ProductionDraft, stageId: ProductionStageId): boolean {
  const index = PRODUCTION_STAGES.findIndex((stage) => stage.id === stageId);
  if (index <= 0) return true;
  return PRODUCTION_STAGES.slice(0, index).every((stage) => (
    !isProductionStageApplicable(draft, stage.id) || draft.approved[stage.id]
  ));
}

/** Reading a saved article does not grant permission to edit, approve or advance. */
export function canViewProductionStage(draft: ProductionDraft, stageId: ProductionStageId): boolean {
  if (!isProductionStageApplicable(draft, stageId)) return false;
  return canAdvanceStage(draft, stageId) || (
    stageId === 'content-package' && Boolean(draft.runId && draft.artifactPaths[stageId])
  );
}

export function applySavedWritingBrief(draft: ProductionDraft, path: string): ProductionDraft {
  const next = invalidateApprovalsFrom(draft, 'topic-template');
  const paths = { ...next.artifactPaths, 'topic-template': path };
  // Keep the article available for comparison immediately after saving a plan.
  for (const stage of PRODUCTION_STAGES.slice(3)) delete paths[stage.id];
  return { ...next, artifactPaths: paths };
}

export function normalizeProductionPlatforms(value: unknown): ProductionPlatform[] {
  if (!Array.isArray(value)) return [...DEFAULT_PRODUCTION_PLATFORMS];
  const selected = new Set(value.filter((item): item is ProductionPlatform => (
    typeof item === 'string' && DEFAULT_PRODUCTION_PLATFORMS.includes(item as ProductionPlatform)
  )));
  const normalized = DEFAULT_PRODUCTION_PLATFORMS.filter((platform) => selected.has(platform));
  return normalized.length > 0 ? normalized : [...DEFAULT_PRODUCTION_PLATFORMS];
}

export function isProductionStageApplicable(draft: ProductionDraft, stageId: ProductionStageId): boolean {
  if (stageId !== 'visual-assets') return true;
  return draft.selectedPlatforms.some((platform) => platform === 'wechat' || platform === 'xhs');
}

export function requiredProductionStages(draft: ProductionDraft) {
  return PRODUCTION_STAGES.filter((stage) => !stage.optional && isProductionStageApplicable(draft, stage.id));
}

export function invalidateApprovalsFrom(draft: ProductionDraft, stageId: ProductionStageId): ProductionDraft {
  const startIndex = PRODUCTION_STAGES.findIndex((stage) => stage.id === stageId);
  if (startIndex < 0) return draft;
  const approved = { ...draft.approved };
  for (const stage of PRODUCTION_STAGES.slice(startIndex)) approved[stage.id] = false;
  return { ...draft, approved };
}

export function detachUnavailableRuntimeRun(draft: ProductionDraft): ProductionDraft {
  return {
    ...invalidateApprovalsFrom(draft, 'material-boundary'),
    runId: '',
    runSlug: '',
    artifactPaths: {},
  };
}

/** Restore navigation from existing files and server-verified decisions, never cached checkboxes. */
export function restoreVerifiedProductionProgress(
  draft: ProductionDraft,
  integrity: ProductionFlowIntegrity,
  materialChanged = false,
): ProductionDraft {
  if (integrity.run_id !== draft.runId) return draft;
  const paths: ProductionDraft['artifactPaths'] = {};
  const approved = { ...INITIAL_APPROVALS };
  let precedingComplete = !materialChanged;
  for (const stage of PRODUCTION_STAGES) {
    const scope = stage.id.replaceAll('-', '_');
    const artifact = integrity.artifacts[scope];
    if (artifact?.exists) paths[stage.id] = artifact.path;
    const complete = stage.id === 'material-boundary'
      ? Boolean(artifact?.exists) && !materialChanged
      : stage.id === 'weekly-review'
        ? ['completed', 'memory_applied'].includes(integrity.weekly_review.status)
        : artifact?.exists === true && integrity.approvals[scope]?.approved === true;
    approved[stage.id] = precedingComplete && complete;
    if (isProductionStageApplicable(draft, stage.id) && !stage.optional) precedingComplete &&= complete;
  }
  return { ...draft, artifactPaths: paths, approved };
}

export function resumableProductionStage(draft: ProductionDraft, preferred?: ProductionStageId): ProductionStageId {
  if (preferred && canViewProductionStage(draft, preferred)) return preferred;
  return requiredProductionStages(draft).find((stage) => !draft.approved[stage.id])?.id || 'weekly-review';
}

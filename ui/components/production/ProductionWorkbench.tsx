'use client';

import { MaterialDisclosureNotice } from './MaterialDisclosureNotice';
import { materialTitleSuggestion } from '@/lib/material-title-suggestion';
import { materialPreparationProgress } from '@/lib/material-progress';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw, Workflow } from 'lucide-react';
import { TechnicalDetailList, TechnicalDetails } from '@/components/TechnicalDetails';
import { CreativeEnhancementDrawer, type CreativeEnhancement } from './CreativeEnhancementDrawer';
import {
  ProductionStagePanel,
  ProductionTaskPanel,
  productionTaskStage,
  productionTaskStatusLabel,
  type ProductionTaskPanelTask,
} from './ProductionStagePanel';
import { ProductionStageRail } from './ProductionStageRail';
import { SavedContentReview } from './SavedContentReview';
import { ProductionDraftShelf } from './ProductionDraftShelf';
import type { ProductionDraftRecord } from '@/lib/production-drafts';
import { ProductionCallHistory } from './ProductionCallHistory';
import { LayoutCallHistory } from '@/components/LayoutCallHistory';
import { ProductionSetupChecklist, modelSetupMessage } from './ProductionSetupChecklist';
import {
  knownSampleInteractions,
  prepareTikOmniSamples,
  type TikOmniSampleFilters,
  type TikOmniSampleRow,
  type TikOmniSampleSort,
} from './TikOmniSampleBrowser';
import { readSavedTopicSuggestions, type TopicSuggestion } from '@/lib/topic-suggestions-client';
import { activeBrandTemplates, type BrandTemplate } from '@/lib/brand-templates';
import {
  readMd2WechatThemePreferences,
  resolvePreferredMd2WechatThemeId,
} from '@/lib/md2wechat-theme-preferences';
import { useAgentStream } from '@/hooks/useAgentStream';
import { useUIStore } from '@/store/uiStore';
import type { LLMConfig } from '@/lib/types';
import type { VisualWorkbenchAdoptedAsset, VisualWorkbenchState } from '@/lib/visual-workbench';
import type {
  MaterialAnalysisContext,
  MaterialExtractionStatus,
  MaterialIntakeAnalysis,
  MaterialSourceRead,
  MaterialUpload,
} from '@/lib/material-analysis';
import { authorAnalysisFingerprint } from '@/lib/author-material-review';
import { createMaterialInputFingerprint } from '@/lib/material-input-fingerprint';
import { PRODUCTION_WORKSPACE_STORAGE_KEY } from '@/lib/production-workspace-context';
import { PRODUCT_COPY } from '@/lib/product-copy';
import { displayClientError } from '@/lib/client-error-copy';
import { fillDraftWithDesktopBridge, hasDesktopPublicationBridge } from '@/lib/desktop-publication-client';
import {
  hasCompletedProductionReview,
  isProductionReviewStage,
  type ProductionReviewAssertions,
  type TopicResearchEvidence,
} from '@/lib/production-review';
import {
  canExplicitlyRetryLocalDraft,
  hasCompleteFinalDeliverables,
  hasQueuedLocalDrafts,
  isPublicationQueueComplete,
  type ProductionDraftQueue,
  type ProductionFlowIntegrity,
} from '@/lib/production-flow';
import {
  DEFAULT_VISUAL_PREFERENCES,
  PRODUCTION_STAGES,
  canAdvanceStage,
  canViewProductionStage,
  applySavedWritingBrief,
  createProductionDraft,
  detachUnavailableRuntimeRun,
  getProductionStageMeta,
  invalidateApprovalsFrom,
  restoreVerifiedProductionProgress,
  resumableProductionStage,
  isApprovalTargetReady,
  isProductionStageApplicable,
  normalizeProductionPlatforms,
  requiredProductionStages,
  requiresServerApproval,
  type ProductionDraft,
  type ProductionPlatform,
  type ProductionStageId,
} from './production-model';

type ApprovalMode = 'local' | 'server' | null;
type RuntimeRefreshResult = {
  ok: boolean;
  approvals: Partial<Record<ProductionStageId, boolean>>;
};

type RuntimeStatusResponse = {
  latest?: Record<string, unknown>;
  sessionState?: Record<string, unknown>;
  activeRun?: Record<string, unknown> | null;
};

type StoredState = {
  savedDraftId?: string;
  savedDraftVersion?: number;
  draftName?: string;
  activeStage?: ProductionStageId;
  researchSubview?: 'samples' | 'topics';
  savedAt?: string;
  draft?: Partial<ProductionDraft>;
  notes?: Partial<Record<ProductionStageId, string>>;
  materialText?: string;
  materialLinks?: string[];
  materialFiles?: MaterialUpload[];
  materialAnalysis?: MaterialIntakeAnalysis;
  materialAnalysisStale?: boolean;
  selectedMaterialTypeId?: string;
  selectedMaterialStructureId?: string;
  approvalModes?: Partial<Record<ProductionStageId, ApprovalMode>>;
  reviewAssertions?: ProductionReviewAssertions;
  topicResearch?: TopicResearchEvidence;
  /**
   * The exact material input that produced `topicResearch`. Research snapshots
   * are not reusable after the operator changes the intake in the same run.
   */
  topicResearchInputFingerprint?: string;
};

const STORAGE_KEY = PRODUCTION_WORKSPACE_STORAGE_KEY;

const EMPTY_NOTES: Record<ProductionStageId, string> = {
  'material-boundary': '',
  'topic-template': '',
  'content-package': '',
  'visual-assets': '',
  'draft-information': '',
  'publication-result': '',
  'weekly-review': '',
};

const EMPTY_APPROVAL_MODES: Record<ProductionStageId, ApprovalMode> = {
  'material-boundary': null,
  'topic-template': null,
  'content-package': null,
  'visual-assets': null,
  'draft-information': null,
  'publication-result': null,
  'weekly-review': null,
};

const EMPTY_REVIEW_ASSERTIONS: ProductionReviewAssertions = {};
const DEFAULT_TIKOMNI_FILTERS: TikOmniSampleFilters = {
  form: 'all',
  metrics: 'all',
  time: 'all',
};
const DEFAULT_TIKOMNI_SORT: TikOmniSampleSort = 'original';

type TaskResult = Record<string, unknown>;

type ProductionTaskKind = 'author-blueprint' | 'material-research' | 'topic-blueprint' | 'content-package' | 'visual-candidates' | 'draft-queue';

type ProductionTask = {
  taskId: string;
  runId: string;
  kind: ProductionTaskKind;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked';
  currentStep: string | null;
  steps: Array<{
    id: string;
    label: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';
    result?: TaskResult;
  }>;
  startedAt: string;
  updatedAt: string;
  result?: TaskResult | null;
  error?: { displayMessage?: string; message?: string; code?: string; debugId?: string } | string | null;
  resumableFrom?: string | null;
  retryMayCharge?: boolean;
};

export function taskPanelCoversNotice({ noticeTaskId, task, stageId, taskPanelVisible }: {
  noticeTaskId?: string;
  task: Pick<ProductionTaskPanelTask, 'taskId' | 'kind' | 'currentStep'> | null;
  stageId: ProductionStageId;
  taskPanelVisible: boolean;
}): boolean {
  return Boolean(noticeTaskId && task && noticeTaskId === task.taskId && taskPanelVisible
    && productionTaskStage(task.kind, task.currentStep) === stageId);
}

function toTaskPanelTask(task: ProductionTask | null, contentRecovered = false): ProductionTaskPanelTask | null {
  if (!task) return null;
  return {
    taskId: task.taskId,
    kind: task.kind,
    status: task.status,
    currentStep: typeof task.currentStep === 'string' ? task.currentStep : null,
    steps: task.steps.map((step) => ({
      id: step.id,
      label: step.label,
      status: step.status,
      result: step.result,
    })),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    error: task.error
      ? {
        ...(typeof task.error === 'object' && task.error.code ? { code: task.error.code } : {}),
        ...(typeof task.error === 'object' && task.error.debugId ? { debugId: task.error.debugId } : {}),
        displayMessage: readableTaskFailure(task),
      }
      : undefined,
    resumableFrom: task.resumableFrom,
    retryMayCharge: task.retryMayCharge,
    contentRecovered,
  };
}

function readStoredState(): StoredState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as StoredState : {};
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readableTaskFailure(task: ProductionTask): string {
  const error = task.error;
  const message = typeof error === 'string'
    ? error
    : error?.displayMessage || error?.message || '';
  return displayClientError(
    { code: typeof error === 'object' ? error?.code : '', message },
    '当前步骤处理失败。请从这里重试。',
  );
}

function applyAdoptedVisualManifest(
  state: VisualWorkbenchState,
  payload: Record<string, unknown>,
): VisualWorkbenchState | null {
  const manifest = asRecord(payload.manifest);
  const sourceContentHash = asString(manifest.sourceContentHash);
  const requiredRoles = Array.isArray(manifest.requiredRoles)
    ? manifest.requiredRoles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
    : [];
  const selections = asRecord(manifest.selections);
  if (
    manifest.schema !== 'aifios.visual-asset-manifest.v1'
    || asString(manifest.slug) !== state.slug
    || !/^[a-f0-9]{64}$/i.test(sourceContentHash)
    || requiredRoles.length === 0
    || Object.keys(selections).length === 0
  ) return null;

  const candidates = state.assetCandidates || state.assets;
  const adoptedAssets: VisualWorkbenchAdoptedAsset[] = [];
  const selectedAssets = [];
  for (const [semanticRole, rawSelection] of Object.entries(selections)) {
    const selection = asRecord(rawSelection);
    const assetId = asString(selection.assetId);
    const revisionId = asString(selection.revisionId);
    const sha256 = asString(selection.sha256);
    const candidate = candidates.find((asset) => (
      asset.id === assetId && asset.revisionId === revisionId && asset.sha256 === sha256
    ));
    if (!semanticRole || !candidate || !sha256) return null;
    const platformBindings = Array.isArray(selection.platformBindings)
      ? [...new Set(selection.platformBindings.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
      : [candidate.platform];
    adoptedAssets.push({
      semanticRole,
      id: candidate.id,
      revisionId: candidate.revisionId,
      path: candidate.path,
      sha256,
      platformBindings,
    });
    selectedAssets.push(candidate);
  }

  const hasCompleteAssetSelection = requiredRoles.every((role) => (
    adoptedAssets.some((asset) => asset.semanticRole === role)
  ));
  return {
    ...state,
    assets: selectedAssets,
    hasExplicitAssetSelection: true,
    hasCompleteAssetSelection,
    selectedAssetKeys: selectedAssets.map((asset) => `${asset.revisionId}:${asset.id}`),
    adoptedAssetManifest: { sourceContentHash, requiredRoles, assets: adoptedAssets },
  };
}

function displayResearchMessage(value: unknown, fallback: string): string {
  const message = asString(value).trim() || fallback;
  return message
    .replaceAll('TikOmni Token', '公开内容服务访问凭证')
    .replaceAll('TikOmni API Key', '公开内容服务访问凭证')
    .replaceAll('TikOmni', '公开内容服务')
    .replaceAll('三平台实时研究', '三个平台的公开内容')
    .replaceAll('三平台研究', '三个平台的公开内容')
    .replaceAll('实时抓取', '获取公开内容')
    .replaceAll('爆款抓取与对标', '查看同类内容')
    .replaceAll('实时数据', '当前内容')
    .replaceAll('实时验证', '内容检查')
    .replaceAll('研究快照', '已保存结果')
    .replaceAll('快照', '已保存结果')
    .replace(/\s+/g, ' ')
    .replace(/([\u4E00-\u9FFF])\s+(?=[\u4E00-\u9FFF])/g, '$1')
    .trim();
}

export function displayProductionNotice(value: string): string {
  const raw = displayResearchMessage(value, '');
  const friendly = raw
    .replace(/(?:pipeline|materials|runs)\/[\w./@-]+/gi, '相关文件')
    .replace(/\b(?:run|task|asset|revision)[_-][A-Za-z0-9_-]+\b/gi, '相关记录')
    .replace(/\b[a-f0-9]{32,64}\b/gi, '内容校验值')
    .replace(/素材理解/g, '素材整理')
    .replace(/素材分析/g, '素材整理')
    .replace(/提炼结果/g, '整理结果')
    .replace(/解析/g, '读取')
    .replace(/公开信息研究|公开样本研究/g, '查看同类内容')
    .replace(/公开样本/g, '同类内容')
    .replace(/主类型与行文结构|主类型和行文结构/g, '系统对素材的判断')
    .replace(/品牌排版模板|品牌模板/g, '排版样式')
    .replace(/模型配置/g, '生成服务设置')
    .replace(/内容蓝图/g, '各平台内容方案')
    .replace(/公众号母稿/g, '公众号文章')
    .replace(/(?:完整\s*)?1\s*\+\s*2\s*\+\s*3\s*内容包|内容包/g, '全部内容')
    .replace(/视觉套装|视觉资产|视觉候选/g, '配图方案')
    .replace(/三类成品/g, '发布成品')
    .replace(/发布映射|发布队列/g, '发布内容')
    .replace(/执行包/g, '视频文件')
    .replace(/创作增强/g, '专项检查')
    .replace(/立项/g, '选题')
    .replace(/后台任务/g, '当前处理')
    .replace(/本期素材任务|当前内容任务|本期任务/g, '本期内容')
    .replace(/运行时/g, '系统')
    .replace(/原始素材路径|本机素材路径|素材路径/g, '素材文件')
    .replace(/可验证的?/g, '完整的')
    .replace(/版本哈希/g, '内容版本')
    .replace(/\brun\s*信息/gi, '任务信息')
    .replace(/\s+/g, ' ')
    .replace(/([\u4E00-\u9FFF])\s+(?=[\u4E00-\u9FFF])/g, '$1')
    .trim();
  const unsafe = /(?:\/Users\/|\/private\/|[A-Za-z]:\\|\b(?:TypeError|ReferenceError|SyntaxError|ECONN[A-Z]*|ENOTFOUND|fetch failed|unexpected token|stack trace)\b|["']?(?:api[_-]?key|token|authorization|cookie|password)["']?\s*[:=]|^\s*[\[{])/i;
  if (!friendly || unsafe.test(raw) || /\b(?:pipeline|runtime|snapshot|artifact|schema|slug|hash|queue)\b/i.test(friendly)) {
    return '这一步没有完成。请重试；如果仍然失败，请到系统设置测试连接。';
  }
  return friendly;
}

function toMaterialInputFingerprint(value: unknown): string {
  const fingerprint = asString(value).trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : '';
}

/**
 * Local storage is allowed to restore form fields, but never an unverified
 * TikOmni result. The server material context is the authority for the latest
 * input and the exact input used by its current analysis.
 */
export function topicResearchNeedsMaterialReset(
  topicResearch: TopicResearchEvidence | null,
  researchInputFingerprint: unknown,
  materialContext: unknown,
): boolean {
  if (!topicResearch) return false;

  const boundFingerprint = toMaterialInputFingerprint(researchInputFingerprint);
  const context = asRecord(materialContext);
  const currentInputFingerprint = toMaterialInputFingerprint(context.inputFingerprint);
  const analysisInputFingerprint = toMaterialInputFingerprint(context.analysisInputFingerprint);

  // Older browser state did not bind the snapshot to an input. Treat it as
  // stale rather than guessing that it matches the current material.
  if (!boundFingerprint) return true;
  // A missing or stale server context cannot prove that the saved research is
  // still applicable. The user can re-run research after material analysis.
  if (!currentInputFingerprint || asString(context.analysisStatus) !== 'current') return true;
  if (boundFingerprint !== currentInputFingerprint) return true;
  // New contexts include this explicit analysis identity. Honour it whenever
  // present so a current analysis for newer material cannot revive old research.
  return Boolean(analysisInputFingerprint && boundFingerprint !== analysisInputFingerprint);
}

export function tikOmniResearchBlockerMessage(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const messages = Array.from(new Set(value
    .map((item) => displayResearchMessage(asString(asRecord(item).message), '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)));
  return messages.join('；');
}

function localDateTimeInputValue(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function newApprovalRequestId(stageId: ProductionStageId): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `approval-${stageId}-${random}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120);
}

export function approvalRequestIdForStage(
  pending: Partial<Record<ProductionStageId, string>>,
  stageId: ProductionStageId,
  create: (stage: ProductionStageId) => string = newApprovalRequestId,
): string {
  return pending[stageId] || (pending[stageId] = create(stageId));
}

function newProductionTaskId(kind: ProductionTaskKind): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `task_${kind.replaceAll('-', '_')}_${random}`.slice(0, 120);
}

function syncStageToUrl(stageId: ProductionStageId): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('stage', String(getProductionStageMeta(stageId).number));
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function toStoredDraft(value: unknown): ProductionDraft {
  const initial = createProductionDraft();
  const parsed = asRecord(value);
  const parsedApprovals = asRecord(parsed.approved);
  const parsedPaths = asRecord(parsed.artifactPaths);
  const storedTemplate = asString(parsed.template);
  const storedVisualPreferences = asRecord(parsed.visualPreferences);
  const storedVisualMode = asString(storedVisualPreferences.mode);
  return {
    ...initial,
    topic: asString(parsed.topic),
    writingMode: parsed.writingMode === 'author_material' ? 'author_material' : 'platform',
    // Legacy snapshots cannot tell a default from the author's choice. Keep
    // their mode; only new drafts explicitly marked unchosen may be prefilled.
    writingModeChosen: parsed.writingModeChosen !== false && (parsed.writingModeChosen === true || parsed.writingMode !== undefined || Boolean(asString(parsed.runId))),
    template: storedTemplate || initial.template,
    projectId: asString(parsed.projectId) || initial.projectId,
    runId: asString(parsed.runId),
    runSlug: asString(parsed.runSlug),
    // Start small for a new period. Legacy runs without a saved selection keep
    // their original three-platform contract until the server restores it.
    selectedPlatforms: parsed.selectedPlatforms === undefined && !asString(parsed.runId)
      ? initial.selectedPlatforms
      : normalizeProductionPlatforms(parsed.selectedPlatforms),
    visualPreferences: {
      mode: storedVisualMode === 'stable' ? 'stable' : DEFAULT_VISUAL_PREFERENCES.mode,
      directionCount: 2,
      providerPolicy: 'auto',
    },
    approved: Object.fromEntries(PRODUCTION_STAGES.map((stage) => [
      stage.id,
      parsedApprovals[stage.id] === true,
    ])) as ProductionDraft['approved'],
    artifactPaths: Object.fromEntries(PRODUCTION_STAGES.flatMap((stage) => {
      const path = asString(parsedPaths[stage.id]);
      return path ? [[stage.id, path]] : [];
    })) as ProductionDraft['artifactPaths'],
  };
}

export function draftAfterMaterialChange(current: ProductionDraft): ProductionDraft {
  return {
    ...invalidateApprovalsFrom(current, 'material-boundary'),
    topic: current.writingMode === 'author_material' ? current.topic : '',
    artifactPaths: {},
  };
}

export function draftAfterMaterialAnalysis(current: ProductionDraft, materialText: string): ProductionDraft {
  const title = current.writingModeChosen === false && !current.topic.trim()
    ? materialTitleSuggestion(materialText) : null;
  return {
    ...current,
    writingMode: title ? 'author_material' : current.writingMode,
    topic: title || (current.writingMode === 'author_material' ? current.topic : ''),
  };
}

export function draftAfterWritingChoice(current: ProductionDraft, patch: Partial<Pick<ProductionDraft, 'topic' | 'writingMode' | 'template' | 'projectId'>>): ProductionDraft {
  const next = {
    ...current, ...patch,
    writingModeChosen: patch.writingMode !== undefined || patch.topic !== undefined ? true : current.writingModeChosen,
  };
  return (patch.template !== undefined && patch.template !== current.template)
    || (patch.topic !== undefined && patch.topic !== current.topic)
    || (patch.writingMode !== undefined && patch.writingMode !== current.writingMode)
    ? invalidateApprovalsFrom(next, 'topic-template') : next;
}

export function draftAfterPlatformChange(current: ProductionDraft, selectedPlatforms: ProductionPlatform[]): ProductionDraft {
  return {
    ...invalidateApprovalsFrom(current, 'topic-template'),
    selectedPlatforms,
    // A platform choice changes the output format, not an author's own subject.
    // Research-derived topics must still be selected for the new platform set.
    topic: current.writingMode === 'author_material' ? current.topic : '',
    artifactPaths: {
      ...current.artifactPaths,
      'topic-template': undefined,
      'content-package': undefined,
      'visual-assets': undefined,
      'draft-information': undefined,
      'publication-result': undefined,
      'weekly-review': undefined,
    },
  };
}

export function recoverableProductionDraft(value: unknown): ProductionDraft | null {
  const run = asRecord(value);
  const runId = asString(run.run_id);
  const slug = asString(run.slug);
  if (run.status !== 'active' || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)
    || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,80}$/.test(slug)) return null;
  const initial = createProductionDraft();
  return {
    ...initial,
    runId,
    runSlug: slug,
    projectId: asString(run.project_id) || initial.projectId,
    topic: asString(run.topic) === slug ? '' : asString(run.topic),
    writingMode: run.research_mode === 'author_material' ? 'author_material' : 'platform',
    writingModeChosen: true,
    template: asString(run.visual_template) || initial.template,
    selectedPlatforms: normalizeProductionPlatforms(run.selected_platforms ?? run.target_platforms),
  };
}

function toStoredNotes(value: unknown): Record<ProductionStageId, string> {
  const parsed = asRecord(value);
  return Object.fromEntries(PRODUCTION_STAGES.map((stage) => [stage.id, asString(parsed[stage.id])])) as Record<ProductionStageId, string>;
}

function toStoredApprovalModes(value: unknown): Record<ProductionStageId, ApprovalMode> {
  const parsed = asRecord(value);
  return Object.fromEntries(PRODUCTION_STAGES.map((stage) => {
    const mode = parsed[stage.id];
    return [stage.id, mode === 'local' || mode === 'server' ? mode : null];
  })) as Record<ProductionStageId, ApprovalMode>;
}

function toStoredReviewAssertions(value: unknown): ProductionReviewAssertions {
  const parsed = asRecord(value);
  return Object.fromEntries(Object.entries(parsed).flatMap(([key, checked]) => (
    checked === true ? [[key, true]] : []
  ))) as ProductionReviewAssertions;
}

function toStoredTopicResearch(value: unknown): TopicResearchEvidence | null {
  const parsed = asRecord(value);
  const reportPath = asString(parsed.reportPath);
  const snapshotPath = asString(parsed.snapshotPath);
  const snapshotSha256 = asString(parsed.snapshotSha256);
  if (!reportPath || !snapshotPath || !/^[a-f0-9]{64}$/i.test(snapshotSha256)) return null;
  const rawQueries = Array.isArray(parsed.queries) ? parsed.queries.filter((query): query is string => typeof query === 'string').slice(0, 12) : [];
  const rawPlatforms = Array.isArray(parsed.requiredPlatforms)
    ? parsed.requiredPlatforms.filter((platform): platform is string => typeof platform === 'string').slice(0, 5)
    : [];
  const readyPlatforms = Array.isArray(parsed.readyPlatforms)
    ? parsed.readyPlatforms.filter((platform): platform is string => typeof platform === 'string').slice(0, 3)
    : rawPlatforms;
  return {
    reportPath,
    snapshotPath,
    snapshotSha256,
    status: asString(parsed.status),
    sampleCount: typeof parsed.sampleCount === 'number' && Number.isFinite(parsed.sampleCount) ? parsed.sampleCount : 0,
    queries: rawQueries,
    requiredPlatforms: rawPlatforms,
    readyPlatforms,
    partial: parsed.partial === true || readyPlatforms.length !== rawPlatforms.length,
  };
}

function productionPlatformsFromResearch(platforms: readonly string[]): ProductionPlatform[] {
  const mapping: Record<string, ProductionPlatform> = {
    wechat_mp: 'wechat',
    xiaohongshu: 'xhs',
    wechat_channels: 'shipinhao',
  };
  return normalizeProductionPlatforms(platforms.map((platform) => mapping[platform]).filter(Boolean));
}

function toStoredTextList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function toStoredMaterialLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : [];
    const url = asString(asRecord(item).url).trim();
    return url ? [url] : [];
  }).slice(0, 5);
}

export function toStoredMaterialFiles(value: unknown): MaterialUpload[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const name = asString(record.name).trim();
    const path = asString(record.path).trim();
    const sourcePath = asString(record.sourcePath).trim();
    const statusValue = asString(record.extractionStatus).trim();
    const extractionStatus: MaterialExtractionStatus | undefined = (
      statusValue === 'text_extracted'
      || statusValue === 'audio_transcribed'
      || statusValue === 'needs_transcription'
      || statusValue === 'existing_extraction'
    ) ? statusValue : undefined;
    const size = typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0
      ? Math.floor(record.size)
      : undefined;
    if (!name) return [];
    return [{
      name,
      ...(size === undefined ? {} : { size }),
      ...(sourcePath ? { sourcePath } : {}),
      ...(path ? { path } : {}),
      ...(extractionStatus ? { extractionStatus } : {}),
      ...(record.writingRequirements === 'reference_only' ? { writingRequirements: 'reference_only' as const } : {}),
    }];
  }).slice(0, 20);
}

function extractionStatusFromResponse(value: unknown): MaterialExtractionStatus | undefined {
  const status = asString(value);
  return (
    status === 'text_extracted'
    || status === 'audio_transcribed'
    || status === 'transcribing'
    || status === 'needs_transcription'
    || status === 'existing_extraction'
  ) ? status : undefined;
}

export function toStoredMaterialAnalysis(value: unknown): MaterialIntakeAnalysis | null {
  const record = asRecord(value);
  const summary = asString(record.summary).trim();
  const recommendedTypeId = asString(record.recommendedTypeId).trim();
  const recommendedStructureId = asString(record.recommendedStructureId).trim();
  if (!summary || !recommendedTypeId || !recommendedStructureId) return null;
  return {
    summary,
    facts: toStoredTextList(record.facts, 12),
    ...(Array.isArray(record.opinions) ? { opinions: toStoredTextList(record.opinions, 12) } : {}),
    ...(Array.isArray(record.authorRequirements) ? { authorRequirements: toStoredTextList(record.authorRequirements, 12) } : {}),
    cases: toStoredTextList(record.cases, 12),
    ...(Array.isArray(record.illustrations) ? { illustrations: toStoredTextList(record.illustrations, 12) } : {}),
    risks: toStoredTextList(record.risks, 12),
    recommendedTypeId: recommendedTypeId as MaterialIntakeAnalysis['recommendedTypeId'],
    recommendedStructureId,
    ...(Array.isArray(record.sources) ? {
      sources: record.sources.flatMap((item): MaterialSourceRead[] => {
        const source = asRecord(item);
        const id = asString(source.id).trim();
        const label = asString(source.label).trim();
        const detail = asString(source.detail).trim();
        const kind = asString(source.kind).trim();
        const status = asString(source.status).trim();
        const excerpt = asString(source.excerpt).trim();
        if (!id || !label || !detail || !['text', 'file', 'link'].includes(kind) || !['read', 'needs_input', 'failed'].includes(status)) return [];
        return [{
          id,
          label,
          detail,
          kind: kind as MaterialSourceRead['kind'],
          status: status as MaterialSourceRead['status'],
          ...(excerpt ? { excerpt } : {}),
        }];
      }).slice(0, 26),
    } : {}),
  };
}

function restoreStoredDraft(saved: StoredState): ProductionDraft {
  // Browser storage is a convenience for form fields, never an approval authority.
  return invalidateApprovalsFrom(toStoredDraft(saved.draft), 'topic-template');
}

function restoreApprovalModes(saved: StoredState): Record<ProductionStageId, ApprovalMode> {
  const modes = toStoredApprovalModes(saved.approvalModes);
  for (const stage of PRODUCTION_STAGES) {
    if (requiresServerApproval(stage.id)) modes[stage.id] = null;
  }
  return modes;
}

function artifactPathsFromRuntime(
  latest: Record<string, unknown>,
  session: Record<string, unknown>,
  activeRun: Record<string, unknown>,
): ProductionDraft['artifactPaths'] {
  const latestFiles = asRecord(latest.latest_files);
  const activeSteps = asRecord(activeRun.steps);
  const activeStepPath = (step: string) => asString(asRecord(activeSteps[step]).latest);
  // `sessions/latest.json` is shared by every run.  Its file map is useful
  // only as a legacy fallback when no run record is available; otherwise it
  // can resurrect another period's blueprint or package in a newly-created
  // material run.
  const path = (step: string) => activeStepPath(step)
    || (Object.keys(activeRun).length === 0 ? asString(latestFiles[step]) : '');
  const phaseSources = Object.keys(activeRun).length > 0
    ? [asRecord(activeRun.phase_artifacts)]
    : [
      asRecord(latest.phase_artifacts),
      asRecord(session.phase_artifacts),
      asRecord(asRecord(session.active_run).phase_artifacts),
    ];
  const phasePath = (scope: string) => {
    for (const source of phaseSources) {
      const candidate = source[scope];
      const direct = asString(candidate);
      const nested = asString(asRecord(candidate).path);
      if (direct || nested) return direct || nested;
    }
    return '';
  };
  return {
    'material-boundary': path('intake'),
    'topic-template': phasePath('topic_template') || path('blueprint'),
    'content-package': phasePath('content_package') || path('package'),
    // Visual approval is bound to the selected-assets manifest, not the
    // legacy visual Markdown report. Falling back to `visual` would make a
    // stale run issue an invalid server-approval request on every refresh.
    'visual-assets': phasePath('visual_assets'),
    'draft-information': phasePath('draft_information'),
    'publication-result': phasePath('publication_result') || path('publish'),
    'weekly-review': phasePath('weekly_review') || path('review'),
  };
}

function stageCanConfirm(
  stageId: ProductionStageId,
  draft: ProductionDraft,
  note: string,
  visualAssetsReady: boolean,
  contentReviewReady: boolean,
  materialReady: boolean,
  draftQueueReady: boolean,
  deliverableReviewReady: boolean,
  publicationQueueComplete: boolean,
  reviewAssertions: ProductionReviewAssertions,
  topicResearch: TopicResearchEvidence | null,
): boolean {
  switch (stageId) {
    case 'material-boundary': return materialReady;
    case 'topic-template': return Boolean(
      draft.topic.trim()
      && draft.template
      && topicResearch?.reportPath
      && topicResearch.snapshotPath
      && hasCompletedProductionReview('topic-template', reviewAssertions),
    );
    case 'content-package': return contentReviewReady && hasCompletedProductionReview('content-package', reviewAssertions, draft.selectedPlatforms);
    case 'visual-assets': return !isProductionStageApplicable(draft, stageId) || visualAssetsReady;
    case 'draft-information': return draftQueueReady && deliverableReviewReady;
    case 'publication-result': return publicationQueueComplete;
    case 'weekly-review': return false;
  }
}

function subscribeToHydration() {
  return () => undefined;
}

function useHydratedClient(): boolean {
  return useSyncExternalStore(subscribeToHydration, () => true, () => false);
}

function ProductionWorkbenchLoading() {
  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4" aria-busy="true">
      <section className="border border-[rgba(28,28,30,0.1)] bg-white px-4 py-5 sm:px-6">
        <div className="flex items-center gap-2 text-[13px] text-[#6B6B6B]">
          <LoaderCircle size={16} className="animate-spin text-[#E85D4C]" />
          <span>正在读取本机工作台</span>
        </div>
      </section>
    </div>
  );
}

export function ProductionWorkbench({
  initialStage = 'material-boundary',
  initialMaterialRequestId,
  initialSavedDraftId,
  initialSavedDraftStage,
}: {
  initialStage?: ProductionStageId;
  initialMaterialRequestId?: string;
  initialSavedDraftId?: string;
  initialSavedDraftStage?: ProductionStageId;
}) {
  const hydrated = useHydratedClient();
  if (!hydrated) return <ProductionWorkbenchLoading />;
  return <ProductionWorkbenchClient initialStage={initialStage} initialMaterialRequestId={initialMaterialRequestId} initialSavedDraftId={initialSavedDraftId} initialSavedDraftStage={initialSavedDraftStage} />;
}

function ProductionWorkbenchClient({
  initialStage = 'material-boundary',
  initialMaterialRequestId,
  initialSavedDraftId,
  initialSavedDraftStage,
}: {
  initialStage?: ProductionStageId;
  initialMaterialRequestId?: string;
  initialSavedDraftId?: string;
  initialSavedDraftStage?: ProductionStageId;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<ProductionDraft>(() => restoreStoredDraft(readStoredState()));
  const [draftName, setDraftName] = useState(() => asString(readStoredState().draftName));
  const [draftShelfRevision, setDraftShelfRevision] = useState(0);
  const [savedDraftId, setSavedDraftId] = useState(() => asString(readStoredState().savedDraftId));
  const savedDraftRef = useRef({ id: savedDraftId, version: readStoredState().savedDraftVersion || 0 });
  const lastSnapshotRef = useRef('');
  const draftSwitchingRef = useRef(false);
  const restoredSnapshotInputRef = useRef(Boolean(readStoredState().savedDraftId && Object.prototype.hasOwnProperty.call(readStoredState(), 'materialText')));

  const [recoverableDraft, setRecoverableDraft] = useState<ProductionDraft | null>(null);
  const [notes, setNotes] = useState<Record<ProductionStageId, string>>(() => {
    const saved = toStoredNotes(readStoredState().notes);
    return { ...EMPTY_NOTES, ...saved };
  });
  const [materialText, setMaterialText] = useState(() => asString(readStoredState().materialText));
  const [materialLinks, setMaterialLinks] = useState(() => toStoredMaterialLinks(readStoredState().materialLinks));
  const [materialFiles, setMaterialFiles] = useState<MaterialUpload[]>(() => toStoredMaterialFiles(readStoredState().materialFiles));
  const [materialAnalysis, setMaterialAnalysis] = useState<MaterialIntakeAnalysis | null>(() => (
    toStoredMaterialAnalysis(readStoredState().materialAnalysis)
  ));
  const [materialAnalysisStale, setMaterialAnalysisStale] = useState(() => readStoredState().materialAnalysisStale === true);
  const [materialInputSyncRevision, setMaterialInputSyncRevision] = useState(0);
  const [selectedMaterialTypeId, setSelectedMaterialTypeId] = useState(() => asString(readStoredState().selectedMaterialTypeId));
  const [selectedMaterialStructureId, setSelectedMaterialStructureId] = useState(() => asString(readStoredState().selectedMaterialStructureId));
  const [approvalModes, setApprovalModes] = useState<Record<ProductionStageId, ApprovalMode>>(() => {
    const saved = restoreApprovalModes(readStoredState());
    return { ...EMPTY_APPROVAL_MODES, ...saved };
  });
  const [reviewAssertions, setReviewAssertions] = useState<ProductionReviewAssertions>(() => ({
    ...EMPTY_REVIEW_ASSERTIONS,
    ...toStoredReviewAssertions(readStoredState().reviewAssertions),
  }));
  const [contentReviewReady, setContentReviewReady] = useState(false);
  const contentPlanKey = `${draft.runId}:${draft.artifactPaths['topic-template'] || ''}:${draft.artifactPaths['content-package'] || ''}`;
  const [contentPlanReview, setContentPlanReview] = useState({ key: '', ready: false, sha256: '', correctionId: '' });
  const contentPlanReady = contentPlanReview.key === contentPlanKey && contentPlanReview.ready;
  const [deliverableReviewReady, setDeliverableReviewReady] = useState(false);
  const [initialTopicResearch] = useState(() => {
    const stored = readStoredState();
    const evidence = toStoredTopicResearch(stored.topicResearch);
    const inputFingerprint = toMaterialInputFingerprint(stored.topicResearchInputFingerprint);
    // Legacy storage does not bind research to a material snapshot. Omit it
    // during hydration so it cannot render before server context verification.
    return evidence && inputFingerprint ? { evidence, inputFingerprint } : null;
  });
  const [topicResearch, setTopicResearch] = useState<TopicResearchEvidence | null>(() => initialTopicResearch?.evidence || null);
  const [topicResearchInputFingerprint, setTopicResearchInputFingerprint] = useState(() => initialTopicResearch?.inputFingerprint || '');
  // Restored research stays hidden until the server confirms that its material
  // binding is still the current one for this run.
  const [topicResearchContextVerified, setTopicResearchContextVerified] = useState(false);
  const [researchSubview, setResearchSubview] = useState<'samples' | 'topics'>(() => readStoredState().researchSubview === 'topics' ? 'topics' : 'samples');
  const [researchSamples, setResearchSamples] = useState<TikOmniSampleRow[]>([]);
  const [researchPlatformTotals, setResearchPlatformTotals] = useState<Record<string, number>>({});
  const [researchFilters, setResearchFilters] = useState<TikOmniSampleFilters>(DEFAULT_TIKOMNI_FILTERS);
  const [researchSort, setResearchSort] = useState<TikOmniSampleSort>(DEFAULT_TIKOMNI_SORT);
  const [topicSuggestions, setTopicSuggestions] = useState<TopicSuggestion[]>([]);
  const selectedTopicSuggestionId = topicSuggestions.find((item) => item.title === draft.topic)?.id || null;
  const [suggestionsReadRevision, setSuggestionsReadRevision] = useState(0);
  const suggestionsReadKey = [draft.runId, topicResearch?.snapshotPath, topicResearch?.snapshotSha256, suggestionsReadRevision].join('|');
  const [suggestionsReadState, setSuggestionsReadState] = useState({ key: '', error: '' });
  const suggestionsLoading = suggestionsReadState.key !== suggestionsReadKey;
  const suggestionsError = suggestionsLoading ? '' : suggestionsReadState.error;
  const [activeStage, setActiveStage] = useState<ProductionStageId>(initialStage);
  const [showStageRail, setShowStageRail] = useState(false);
  const stageContentRef = useRef<HTMLDivElement>(null);
  const lastVisibleStageRef = useRef(initialStage);
  const [lastSavedAt, setLastSavedAt] = useState('');
  const [materialReadRevision, setMaterialReadRevision] = useState(0);
  const setSidebarProductionStage = useUIStore((state) => state.setProductionStage);
  // A restored run is authoritative only after both the runtime approvals and
  // the material fingerprint return. Avoid briefly showing a completed run as
  // locked while those two small reads are still in flight.
  const [runtimeHydrating, setRuntimeHydrating] = useState(() => Boolean(draft.runId));
  const [materialContextHydrating, setMaterialContextHydrating] = useState(() => Boolean(draft.runId));
  const [restoringSavedStage, setRestoringSavedStage] = useState(() => Boolean(draft.runId));
  const [enhancementStage, setEnhancementStage] = useState<ProductionStageId | null>(null);
  const [busyAction, setBusyAction] = useState<'run' | ProductionStageId | null>(null);
  const [visualWorkbench, setVisualWorkbench] = useState<VisualWorkbenchState | null>(null);
  const [visualLoading, setVisualLoading] = useState(false);
  const [brandTemplates, setBrandTemplates] = useState<BrandTemplate[]>([]);
  const [brandTemplatesLoading, setBrandTemplatesLoading] = useState(true);
  const [config, setConfig] = useState<LLMConfig | null>(null);
  const [publicationQueue, setPublicationQueue] = useState<ProductionDraftQueue | null>(null);
  const [activeTask, setActiveTask] = useState<ProductionTask | null>(null);
  const [recoveredContent, setRecoveredContent] = useState<(NonNullable<ProductionFlowIntegrity['recovered_content_task']> & { runId: string }) | null>(null);
  const [taskRecovered, setTaskRecovered] = useState(false);
  const [publicationInputs, setPublicationInputs] = useState<Record<string, {
    url: string;
    proofPath: string;
    publishedAt: string;
    confirmed: boolean;
    unknownCompletionResolved: boolean;
  }>>({});
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'error'; text: string; taskId?: string } | null>(null);
  const { invoke: invokeAgent, isRunning: agentRunning } = useAgentStream();
  const materialRequestLoaded = useRef('');
  const incomingSavedDraft = useRef('');
  const materialContextLoaded = useRef('');
  const researchSamplesLoaded = useRef('');
  const materialInputRef = useRef({
    rawMaterial: materialText,
    files: materialFiles,
    links: materialLinks,
  });
  const materialServerFingerprintRef = useRef('');
  // The synchronous ref serves write guards; render state carries its run binding.
  const [materialServerIdentity, setMaterialServerIdentity] = useState({ runId: '', fingerprint: '' });
  const materialCorrectionSeenRef = useRef<{ runId: string; id: string; analysis: unknown }>({ runId: '', id: '', analysis: null });
  const materialInvalidationTimer = useRef<number | null>(null);
  const materialInvalidationInFlightRef = useRef<Promise<void> | null>(null);
  const materialInvalidationPendingRef = useRef(false);
  const materialRunRef = useRef(draft.runId);
  const workbenchMountedRef = useRef(true);
  const materialSelectionTimer = useRef<number | null>(null);
  const materialPersistedSelectionRef = useRef('');
  const materialDirectionDirtyRef = useRef(false);
  const initialRuntimeHydrationRef = useRef(Boolean(draft.runId));
  const materialChangedRef = useRef(materialAnalysisStale);
  const restoredStageRef = useRef(readStoredState().activeStage);
  const activeTaskRef = useRef<ProductionTask | null>(null);
  const defaultDocumentTitleRef = useRef('');
  const loadResearchSamplesRef = useRef<((evidence: TopicResearchEvidence) => Promise<void>) | null>(null);
  const prewarmTopicSuggestionsRef = useRef<((runId: string, evidence: TopicResearchEvidence) => Promise<void>) | null>(null);
  const approvalRequestIdsRef = useRef<Partial<Record<ProductionStageId, string>>>({});
  const productionTaskIdsRef = useRef<Partial<Record<ProductionTaskKind, string>>>({});
  const productionTaskInputsRef = useRef<Partial<Record<ProductionTaskKind, string>>>({});
  const onContentPlanReviewChange = useCallback((ready: boolean, sha256: string, correctionId = '') => {
    setContentPlanReview({ key: contentPlanKey, ready, sha256, correctionId });
    delete approvalRequestIdsRef.current['content-package'];
  }, [contentPlanKey]);

  useEffect(() => {
    activeTaskRef.current = activeTask;
  }, [activeTask]);

  useEffect(() => { materialChangedRef.current = materialAnalysisStale; }, [materialAnalysisStale]);

  useEffect(() => {
    const stage = getProductionStageMeta(activeStage);
    setSidebarProductionStage({ number: String(stage.number).padStart(2, '0'), label: stage.id === 'topic-template' && draft.writingMode === 'author_material' ? '核对写作方案' : stage.label });
    return () => setSidebarProductionStage(null);
  }, [activeStage, draft.writingMode, setSidebarProductionStage]);

  useEffect(() => {
    if (!restoringSavedStage || runtimeHydrating || materialContextHydrating || !draft.runId) return;
    const saved = restoredStageRef.current;
    const preferred = initialStage !== 'material-boundary' ? initialStage
      : saved && PRODUCTION_STAGES.some((stage) => stage.id === saved) ? saved : undefined;
    const stage = resumableProductionStage(draft, preferred);
    setActiveStage(stage);
    // Wait for the render containing the restored stage before autosaving or
    // switching to an incoming library draft. Other effects in this render
    // still close over the initial stage, even after a ref is cleared.
    setRestoringSavedStage(false);
    syncStageToUrl(stage);
    setNotice((current) => current?.text.startsWith('正在读取上次内容')
      ? { tone: 'success', text: '已恢复保存的内容，可以接着做。' } : current);
  }, [draft, initialStage, materialContextHydrating, runtimeHydrating, restoringSavedStage]);

  useEffect(() => {
    defaultDocumentTitleRef.current = document.title;
    const restoreTitle = () => {
      if (!document.hidden && defaultDocumentTitleRef.current) document.title = defaultDocumentTitleRef.current;
    };
    document.addEventListener('visibilitychange', restoreTitle);
    window.addEventListener('focus', restoreTitle);
    return () => {
      document.removeEventListener('visibilitychange', restoreTitle);
      window.removeEventListener('focus', restoreTitle);
      if (defaultDocumentTitleRef.current) document.title = defaultDocumentTitleRef.current;
    };
  }, []);

  const clearResearchForChangedMaterial = useCallback(() => {
    setTopicResearch(null);
    setTopicResearchInputFingerprint('');
    setTopicResearchContextVerified(false);
    setResearchSubview('samples');
    setResearchSamples([]);
    setResearchPlatformTotals({});
    researchSamplesLoaded.current = '';
    setTopicSuggestions([]);
    setDraft(draftAfterMaterialChange);
    setApprovalModes({ ...EMPTY_APPROVAL_MODES });
    setReviewAssertions({ ...EMPTY_REVIEW_ASSERTIONS });
    setContentReviewReady(false);
    setActiveStage('material-boundary');
    syncStageToUrl('material-boundary');
  }, []);

  useEffect(() => () => {
    if (materialInvalidationTimer.current !== null) window.clearTimeout(materialInvalidationTimer.current);
    if (materialSelectionTimer.current !== null) window.clearTimeout(materialSelectionTimer.current);
  }, []);

  useEffect(() => {
    workbenchMountedRef.current = true;
    return () => { workbenchMountedRef.current = false; };
  }, []);

  useEffect(() => {
    materialRunRef.current = draft.runId;
  }, [draft.runId]);

  // Keep a single, current view of operator-owned input for both the reload
  // guard and the delayed server writes below. Derived link metadata is never
  // part of this object, so a successful fetch cannot masquerade as an edit.
  useEffect(() => {
    materialInputRef.current = {
      rawMaterial: materialText,
      files: materialFiles,
      links: materialLinks,
    };
  }, [materialFiles, materialLinks, materialText]);

  const currentStoredState = useMemo<StoredState>(() => ({
      activeStage,
      researchSubview,
      draft,
      notes,
      materialText,
      materialLinks,
      materialFiles,
      ...(materialAnalysis ? { materialAnalysis } : {}),
      ...(materialAnalysisStale ? { materialAnalysisStale: true } : {}),
      ...(selectedMaterialTypeId ? { selectedMaterialTypeId } : {}),
      ...(selectedMaterialStructureId ? { selectedMaterialStructureId } : {}),
      approvalModes,
      reviewAssertions,
      ...(topicResearch && topicResearchInputFingerprint
        ? { topicResearch, topicResearchInputFingerprint }
        : {}),
  }), [activeStage, researchSubview, draft, notes, materialText, materialLinks, materialFiles, materialAnalysis, materialAnalysisStale, selectedMaterialTypeId, selectedMaterialStructureId, approvalModes, reviewAssertions, topicResearch, topicResearchInputFingerprint]);
  useEffect(() => {
    if (draftSwitchingRef.current || runtimeHydrating || materialContextHydrating || restoringSavedStage) return;
    let notificationTimer: ReturnType<typeof setTimeout>;
    try {
      const savedAt = new Date().toISOString();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...currentStoredState, savedAt, draftName, savedDraftId: savedDraftRef.current.id, savedDraftVersion: savedDraftRef.current.version }));
      notificationTimer = setTimeout(() => setLastSavedAt(savedAt), 0);
    } catch {
      notificationTimer = setTimeout(() => {
        setLastSavedAt('');
        setNotice({ tone: 'warning', text: '本机草稿暂时没有保存成功，请保留当前页面并重试。已生成的服务端结果不受影响。' });
      }, 0);
    }
    return () => clearTimeout(notificationTimer);
  }, [currentStoredState, draftName, draftShelfRevision, runtimeHydrating, materialContextHydrating, restoringSavedStage]);

  const hasDraftContent = Boolean(draft.runId || materialText.trim() || materialFiles.length || materialLinks.some((link) => link.trim()) || Object.values(notes).some((note) => note.trim()));
  const saveDraftSnapshot = useCallback(async (copy = false, updatedState?: StoredState) => {
    const snapshot = updatedState || currentStoredState;
    const original = JSON.stringify({ name: draftName, state: snapshot });
    const source = copy ? {
      ...snapshot,
      activeStage: 'material-boundary', researchSubview: 'samples',
      draft: { ...snapshot.draft, runId: '', runSlug: '', topic: '', artifactPaths: {}, approved: {} },
      materialAnalysis: undefined, materialAnalysisStale: false, selectedMaterialTypeId: '', selectedMaterialStructureId: '',
      topicResearch: undefined, topicResearchInputFingerprint: '', reviewAssertions: {}, approvalModes: {},
    } : snapshot;
    const target = { id: (!copy && savedDraftRef.current.id) || `draft_${crypto.randomUUID().replaceAll('-', '')}`, version: copy ? 0 : savedDraftRef.current.version };
    if (!copy && !savedDraftRef.current.id) {
      savedDraftRef.current = target;
      setSavedDraftId(target.id);
    }
    const response = await fetch('/api/production/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: target.id, expectedVersion: target.version, name: copy ? `${draftName || draft.topic || '素材'} · 新草稿` : draftName, state: source }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '草稿未能保存，当前内容保留。');
    const saved = data.draft as ProductionDraftRecord;
    if (!copy) {
      savedDraftRef.current = { id: saved.id, version: saved.version };
      setSavedDraftId(saved.id);
      setDraftName(saved.name);
      lastSnapshotRef.current = JSON.stringify({ name: saved.name, state: snapshot });
    } else lastSnapshotRef.current = original;
    setDraftShelfRevision((value) => value + 1);
    return saved;
  }, [currentStoredState, draftName, draft.topic]);

  const openModelSetup = useCallback(async () => {
    if (busyAction || agentRunning) return;
    setBusyAction('material-boundary');
    try {
      const saved = await saveDraftSnapshot();
      // Make the return target durable before leaving; a failed save keeps the
      // user with their material, instead of navigating to an unrelated draft.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...saved.state, savedDraftId: saved.id, savedDraftVersion: saved.version,
        draftName: saved.name, savedAt: saved.updatedAt,
      }));
      router.push('/settings#model-connection');
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '草稿未能保存，请留在本页重试。' });
    } finally {
      setBusyAction(null);
    }
  }, [agentRunning, busyAction, router, saveDraftSnapshot]);

  const openSavedDraft = useCallback(async (id: string, targetStage?: ProductionStageId) => {
    setBusyAction('material-boundary');
    try {
    if (hasDraftContent && lastSnapshotRef.current !== JSON.stringify({ name: draftName, state: currentStoredState })) await saveDraftSnapshot();
    // A settings link may have been created before this first named snapshot.
    // Reopen the just-saved draft, not a bare run that discards the local name.
    const targetId = id === `run:${currentStoredState.draft?.runId}` && savedDraftRef.current.id
      ? savedDraftRef.current.id : id;
    const response = await fetch(`/api/production/drafts?${new URLSearchParams({ id: targetId })}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '草稿未能打开，当前内容保留。');
    const saved = data.draft as ProductionDraftRecord;
    const state = { ...saved.state, ...(targetStage ? { activeStage: targetStage } : {}) } as StoredState;
    draftSwitchingRef.current = true;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, savedAt: saved.updatedAt, draftName: saved.name, ...(saved.id.startsWith('draft_') ? { savedDraftId: saved.id, savedDraftVersion: saved.version } : {}) }));
    const stage = PRODUCTION_STAGES.find((item) => item.id === state.activeStage)?.number || 1;
    router.replace(`/production?${new URLSearchParams({ stage: String(stage), draftRestore: `${saved.id}-${saved.version}-${crypto.randomUUID()}` })}`);
    } catch (error) { draftSwitchingRef.current = false; throw error; }
    finally { setBusyAction(null); }
  }, [currentStoredState, draftName, hasDraftContent, router, saveDraftSnapshot]);


  useEffect(() => {
    if (!initialSavedDraftId || runtimeHydrating || materialContextHydrating || restoringSavedStage || incomingSavedDraft.current === initialSavedDraftId) return;
    incomingSavedDraft.current = initialSavedDraftId;
    void openSavedDraft(initialSavedDraftId, initialSavedDraftStage).catch((error) => {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '新草稿未能打开，原来的内容仍保留。' });
    });
  }, [initialSavedDraftId, initialSavedDraftStage, openSavedDraft, runtimeHydrating, materialContextHydrating, restoringSavedStage]);


  useEffect(() => {
    const requestId = initialMaterialRequestId?.trim() || '';
    if (!requestId || runtimeHydrating || materialContextHydrating || restoringSavedStage || materialRequestLoaded.current === requestId) return;
    materialRequestLoaded.current = requestId;
    const loadMaterialRequest = async () => {
      try {
        const response = await fetch(`/api/materials?${new URLSearchParams({ intakeRequest: requestId }).toString()}`, { cache: 'no-store' });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok) throw new Error(asString(payload.error) || '读取个人库选择失败');
        const importedFiles = toStoredMaterialFiles(payload.materialFiles);
        const rawMaterial = asString(payload.rawMaterial);
        if (!rawMaterial.trim() && importedFiles.length === 0) throw new Error('这份素材还没有可用于写作的文字内容。请先补充文字。');
        const sourceId = asString(payload.id).replace(/-/g, '');
        if (!/^[a-f0-9]{32}$/i.test(sourceId)) throw new Error('素材引用编号不正确，请从资料库重新打开。');
        const id = `draft_${sourceId.toLowerCase()}`;
        const existing = await fetch(`/api/production/drafts?${new URLSearchParams({ id })}`, { cache: 'no-store' });
        if (existing.status === 404) {
          const saved = await fetch('/api/production/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            id, name: asString(payload.jobName) || importedFiles[0]?.name || '资料库素材', expectedVersion: 0,
            state: { activeStage: 'material-boundary', materialText: importedFiles.length ? '' : rawMaterial, materialFiles: importedFiles, materialLinks: [], notes: {}, draft: { topic: '', runId: '', runSlug: '', selectedPlatforms: draft.selectedPlatforms } },
          }) });
          if (!saved.ok) throw new Error(asString((await saved.json()).error) || '素材草稿未能保存，原内容仍保留。');
        } else if (!existing.ok) throw new Error('素材草稿暂时无法读取，原内容仍保留。');
        if (workbenchMountedRef.current) await openSavedDraft(id);
      } catch (error) {
        if (workbenchMountedRef.current) setNotice({ tone: 'error', text: error instanceof Error ? error.message : '读取个人库选择失败' });
      }
    };
    void loadMaterialRequest();
  }, [initialMaterialRequestId, runtimeHydrating, materialContextHydrating, restoringSavedStage, draft.selectedPlatforms, openSavedDraft]);

  useEffect(() => {
    const runId = draft.runId.trim();
    if (!runId) {
      materialContextLoaded.current = '';
      materialServerFingerprintRef.current = '';
      // An unbound draft cannot render the previous run's fingerprint. The
      // callbacks that detach/new a draft reset its render identity directly.
      materialPersistedSelectionRef.current = '';
      materialDirectionDirtyRef.current = false;
      return;
    }
    if (materialContextLoaded.current === runId) return;
    materialContextLoaded.current = runId;
    let cancelled = false;

    const loadMaterialContext = async () => {
      try {
        const localInput = materialInputRef.current;
        const hasLocalInput = Boolean(
          localInput.rawMaterial.trim()
          || localInput.files.length
          || localInput.links.some((link) => link.trim()),
        );
        const query = new URLSearchParams({ runId });
        if (hasLocalInput || restoredSnapshotInputRef.current) {
          query.set('inputFingerprint', await createMaterialInputFingerprint(localInput));
        }
        const response = await fetch(`/api/production/material-analysis?${query.toString()}`, {
          cache: 'no-store',
        });
        if (response.status === 404) return;
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.status === 409) {
          if (!cancelled) {
            materialServerFingerprintRef.current = asString(payload.serverInputFingerprint);
            setMaterialServerIdentity({ runId, fingerprint: asString(payload.serverInputFingerprint) });
            setMaterialAnalysisStale(true);
            materialChangedRef.current = true;
            clearResearchForChangedMaterial();
            setNotice({ tone: 'warning', text: '本机素材输入已变更，旧分析已锁定。请重新分析当前输入。' });
          }
          return;
        }
        if (cancelled) return;
        if (!response.ok) throw new Error(asString(payload.error) || '暂时无法读取上次素材，请重试。');
        const context = asRecord(payload.context);
        const input = asRecord(context.input);
        const selection = asRecord(context.selection);
        const restoredAnalysis = toStoredMaterialAnalysis(context.analysis);
        const restoredInput = {
          rawMaterial: asString(input.rawMaterial),
          files: toStoredMaterialFiles(input.files),
          links: toStoredMaterialLinks(input.links),
        };
        const contextFingerprint = asString(context.inputFingerprint);
        materialInputRef.current = restoredInput;
        materialServerFingerprintRef.current = contextFingerprint;
        setMaterialServerIdentity({ runId, fingerprint: contextFingerprint });
        setMaterialText(restoredInput.rawMaterial);
        setMaterialFiles(restoredInput.files);
        setMaterialLinks(restoredInput.links);
        setMaterialAnalysis(restoredAnalysis);
        materialCorrectionSeenRef.current = { runId, id: asString(context.correctionId), analysis: context.analysis };
        const current = asString(context.analysisStatus) === 'current';
        materialChangedRef.current = !current;
        setMaterialAnalysisStale(!current);
        const typeId = asString(selection.materialTypeId);
        const structureId = asString(selection.structureId);
        if (typeId && structureId) {
          setSelectedMaterialTypeId(typeId);
          setSelectedMaterialStructureId(structureId);
          materialPersistedSelectionRef.current = [runId, contextFingerprint, typeId, structureId].join('|');
        }
        materialDirectionDirtyRef.current = false;
        if (topicResearchNeedsMaterialReset(topicResearch, topicResearchInputFingerprint, context)) {
          clearResearchForChangedMaterial();
          setNotice({ tone: 'warning', text: '本期素材已更新，之前保存的平台数据和选题建议已清除。请用当前素材重新查看同类内容。' });
          return;
        }
        if (topicResearch) setTopicResearchContextVerified(true);
      } catch (error) {
        if (!cancelled) setNotice({ tone: 'warning', text: error instanceof Error ? error.message : '暂时无法读取上次素材，请点击“刷新本期进度”重试。' });
      } finally {
        if (!cancelled) setMaterialContextHydrating(false);
      }
    };
    void loadMaterialContext();
    return () => {
      cancelled = true;
      if (materialContextLoaded.current === runId) materialContextLoaded.current = '';
    };
  }, [clearResearchForChangedMaterial, draft.runId, topicResearch, topicResearchInputFingerprint, materialReadRevision]);

  const refreshBrandTemplates = useCallback(async () => {
    setBrandTemplatesLoading(true);
    try {
      const response = await fetch('/api/brand-templates', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as { templates?: unknown; error?: string };
      if (!response.ok || !Array.isArray(data.templates)) {
        throw new Error(data.error || '读取品牌模板失败');
      }
      const configured = data.templates.filter((value): value is BrandTemplate => (
        Boolean(value)
        && typeof value === 'object'
        && typeof (value as BrandTemplate).id === 'string'
        && typeof (value as BrandTemplate).label === 'string'
        && typeof (value as BrandTemplate).detail === 'string'
        && typeof (value as BrandTemplate).layoutStyle === 'string'
        && typeof (value as BrandTemplate).enabled === 'boolean'
      ));
      const active = activeBrandTemplates(configured);
      const preferredThemeId = resolvePreferredMd2WechatThemeId(
        active.map((template) => template.id),
        readMd2WechatThemePreferences(),
        createProductionDraft().template,
      );
      setBrandTemplates(active);
      setDraft((current) => {
        const currentAvailable = active.some((template) => template.id === current.template);
        const untouchedDraft = !current.runId
          && !current.topic
          && current.template === createProductionDraft().template;
        if (currentAvailable && !untouchedDraft) return current;
        const fallback = active.find((template) => template.id === preferredThemeId)
          || active.find((template) => template.id === 'wechat-native')
          || active[0];
        return fallback
          ? invalidateApprovalsFrom({ ...current, template: fallback.id }, 'topic-template')
          : current;
      });
    } catch (error) {
      setBrandTemplates([]);
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '读取品牌模板失败' });
    } finally {
      setBrandTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshBrandTemplates();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshBrandTemplates]);

  const refreshConfig = useCallback(async () => {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as { config?: LLMConfig; error?: string };
      if (!response.ok || !data.config) throw new Error(data.error || '读取模型配置失败');
      setConfig(data.config);
    } catch (error) {
      setConfig(null);
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '读取模型配置失败' });
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshConfig();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshConfig]);

  const refreshPublicationQueue = useCallback(async (queuePath: string | undefined) => {
    if (!queuePath) {
      setPublicationQueue(null);
      return;
    }
    try {
      const response = await fetch(`/api/publish/drafts?${new URLSearchParams({ queuePath }).toString()}`, {
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({})) as { queue?: ProductionDraftQueue; error?: string };
      if (!response.ok || !data.queue) throw new Error(data.error || '读取本期发布队列失败');
      setPublicationQueue(data.queue);
    } catch {
      setPublicationQueue(null);
    }
  }, []);

  const syncServerApprovals = useCallback(async (
    runId: string,
  ) => {
    const response = await fetch(`/api/production/flow?${new URLSearchParams({ runId })}`, { cache: 'no-store' });
    const payload = await response.json() as { integrity?: ProductionFlowIntegrity; error?: string };
    const integrity = payload.integrity;
    if (!response.ok || !integrity || integrity.run_id !== runId) throw new Error(payload.error || '无法核对这期内容的进度，请重试。');
    if (materialRunRef.current !== runId || !workbenchMountedRef.current) return {};
    const verified = restoreVerifiedProductionProgress({ ...createProductionDraft(), runId,
      selectedPlatforms: normalizeProductionPlatforms(integrity.target_platforms?.map((platform) => platform === 'xiaohongshu' ? 'xhs' : platform)),
    }, integrity, materialChangedRef.current);
    setDraft((current) => restoreVerifiedProductionProgress(current, integrity, materialChangedRef.current));
    setRecoveredContent(integrity.recovered_content_task ? { ...integrity.recovered_content_task, runId } : null);
    setApprovalModes(Object.fromEntries(PRODUCTION_STAGES.map((stage) => [stage.id,
      verified.approved[stage.id] ? stage.approvalScope ? 'server' : 'local' : null,
    ])) as Record<ProductionStageId, ApprovalMode>);
    return verified.approved;
  }, []);

  const refreshVisualWorkbench = useCallback(async (slug: string) => {
    if (!slug) {
      setVisualWorkbench(null);
      return;
    }
    try {
      const response = await fetch(`/api/visual/workbench?${new URLSearchParams({ slug }).toString()}`, {
        cache: 'no-store',
      });
      if (response.status === 204) {
        setVisualWorkbench(null);
        return;
      }
      const data = await response.json() as VisualWorkbenchState & { error?: string };
      if (!response.ok) throw new Error(data.error || '读取排版成品失败');
      setVisualWorkbench(data);
    } catch (error) {
      setVisualWorkbench(null);
      throw error;
    }
  }, []);

  const refreshRuntime = useCallback(async (): Promise<RuntimeRefreshResult> => {
    try {
      const query = new URLSearchParams({ view: 'production', ...(draft.runId ? { runId: draft.runId } : {}) });
      const response = await fetch(`/api/status?${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('读取当前任务失败');
      const data = await response.json() as RuntimeStatusResponse;
      if (!workbenchMountedRef.current || materialRunRef.current !== draft.runId) return { ok: false, approvals: {} };
      const latest = asRecord(data.latest);
      const session = asRecord(data.sessionState);
      const responseRun = asRecord(data.activeRun);
      const activeRun = Object.keys(responseRun).length ? responseRun : asRecord(session.active_run);
      const runtimeRunId = asString(latest.active_run_id) || asString(activeRun.run_id) || asString(session.active_run_id);
      const runtimeSlug = asString(latest.current_slug) || asString(activeRun.slug) || asString(session.current_slug);
      const runtimeProjectId = asString(activeRun.project_id) || asString(session.active_project_id);
      const runtimePlatforms = normalizeProductionPlatforms(
        Array.isArray(activeRun.selected_platforms) ? activeRun.selected_platforms : activeRun.target_platforms,
      );
      // Never let a background status refresh silently adopt another window's
      // active run. A fresh material entry intentionally starts unbound until
      // the operator analyzes material and creates this period's local run.
      if (!draft.runId) {
        setRecoverableDraft(recoverableProductionDraft(activeRun));
        setPublicationQueue(null);
        setVisualWorkbench(null);
        return { ok: true, approvals: {} };
      }
      setRecoverableDraft(null);
      if (!runtimeRunId || runtimeRunId !== draft.runId) {
        setDraft((current) => detachUnavailableRuntimeRun(current));
        setApprovalModes((current) => Object.fromEntries(PRODUCTION_STAGES.map((stage) => [
          stage.id,
          requiresServerApproval(stage.id) ? null : current[stage.id],
        ])) as Record<ProductionStageId, ApprovalMode>);
        materialContextLoaded.current = '';
        materialServerFingerprintRef.current = '';
        setMaterialServerIdentity({ runId: '', fingerprint: '' });
        materialPersistedSelectionRef.current = '';
        materialDirectionDirtyRef.current = false;
        setMaterialAnalysis(null);
        setMaterialAnalysisStale(false);
        setSelectedMaterialTypeId('');
        setSelectedMaterialStructureId('');
        setTopicResearch(null);
        setTopicResearchInputFingerprint('');
        setTopicResearchContextVerified(false);
        setResearchSamples([]);
        setResearchPlatformTotals({});
        setTopicSuggestions([]);
        setPublicationQueue(null);
        setVisualWorkbench(null);
        setActiveStage('material-boundary');
        syncStageToUrl('material-boundary');
        setNotice({ tone: 'warning', text: '本期连接已失效，但素材仍然保留。请重新整理素材，系统会建立新的本期进度。' });
        return { ok: false, approvals: {} };
      }
      const paths = artifactPathsFromRuntime(latest, session, activeRun);
      const freshPaths = Object.fromEntries(Object.entries(paths).filter(([, value]) => Boolean(value)));
      let runChanged = false;
      setDraft((current) => {
        runChanged = Boolean(runtimeRunId && current.runId && current.runId !== runtimeRunId);
        const nextArtifactPaths = runChanged
          ? freshPaths
          : { ...current.artifactPaths, ...freshPaths };
        // A selected-assets manifest is the only valid visual approval
        // target. Remove any localStorage-era visual Markdown path as soon as
        // runtime state confirms that no phase manifest is registered.
        if (!paths['visual-assets']) delete nextArtifactPaths['visual-assets'];
        const next: ProductionDraft = {
          ...current,
          projectId: runtimeProjectId || current.projectId,
          runId: runtimeRunId || current.runId,
          runSlug: runtimeSlug || current.runSlug,
          selectedPlatforms: runtimePlatforms,
          visualPreferences: {
            mode: 'stable',
            directionCount: 2,
            providerPolicy: 'auto',
          },
          artifactPaths: nextArtifactPaths,
        };
        return runChanged ? invalidateApprovalsFrom(next, 'material-boundary') : next;
      });
      const approvals = runtimeRunId ? await syncServerApprovals(runtimeRunId) : {};
      if (materialRunRef.current !== draft.runId) return { ok: false, approvals: {} };
      await refreshPublicationQueue(paths['draft-information']);
      // Candidate visuals exist before the selected-assets manifest is written.
      // Always refresh this small, run-scoped read so generation remains visible
      // immediately and after a page reload; only an explicit per-asset adoption
      // is allowed to create the approval manifest.
      try {
        await refreshVisualWorkbench(runtimeSlug);
      } catch {
        // Visual assets are optional until phase 4. Keep the runtime refresh usable.
      }
      return { ok: true, approvals };
    } catch (error) {
      setDraft((current) => invalidateApprovalsFrom(current, 'topic-template'));
      setRecoveredContent(null);
      setApprovalModes((current) => Object.fromEntries(PRODUCTION_STAGES.map((stage) => [
        stage.id,
        requiresServerApproval(stage.id) ? null : current[stage.id],
      ])) as Record<ProductionStageId, ApprovalMode>);
      setPublicationQueue(null);
      setVisualWorkbench(null);
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '读取当前任务失败' });
      return { ok: false, approvals: {} };
    } finally {
      if (initialRuntimeHydrationRef.current) {
        initialRuntimeHydrationRef.current = false;
        setRuntimeHydrating(false);
      }
    }
  }, [draft.runId, refreshPublicationQueue, refreshVisualWorkbench, syncServerApprovals]);

  const resumePreviousPeriod = () => {
    const input = materialInputRef.current;
    if (!recoverableDraft || draft.runId || busyAction || agentRunning
      || input.rawMaterial.trim() || input.files.length || input.links.some((link) => link.trim())) return;
    // The operator explicitly chooses this run. Material and all approvals
    // still hydrate through their existing server-bound checks.
    initialRuntimeHydrationRef.current = true;
    setRestoringSavedStage(true);
    restoredStageRef.current = undefined;
    setRuntimeHydrating(true);
    setMaterialContextHydrating(true);
    setActiveStage('material-boundary');
    syncStageToUrl('material-boundary');
    setDraft(recoverableDraft);
    setRecoverableDraft(null);
    setNotice({ tone: 'success', text: '正在读取上次内容，素材和已确认进度会从本机恢复。' });
  };

  const readProductionTask = useCallback(async (runId: string, taskId: string): Promise<ProductionTask> => {
    const response = await fetch(`/api/production/tasks?${new URLSearchParams({ runId, taskId }).toString()}`, {
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(asString(payload.error) || '读取后台任务状态失败');
    const task = asRecord(payload.task) as unknown as ProductionTask;
    if (!task?.taskId || !task.runId || !Array.isArray(task.steps)) throw new Error('后台任务状态返回不完整。');
    return task;
  }, []);

  const applyCompletedProductionTask = useCallback(async (task: ProductionTask) => {
    delete productionTaskIdsRef.current[task.kind];
    const result = asRecord(task.result);
    const taskWarnings = task.steps.flatMap((step) => {
      const values = asRecord(step.result).warnings;
      return Array.isArray(values)
        ? values.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 3)
        : [];
    });
    if (task.kind === 'material-research') {
      const section = asRecord(result.materialResearch);
      const intakePath = asString(section.intakePath) || asString(result.intakePath) || asString(result.intake_path);
      const reportPath = asString(section.reportPath) || asString(result.reportPath) || asString(result.path);
      const snapshotPath = asString(section.snapshotPath) || asString(result.snapshotPath) || asString(result.snapshot_path);
      const snapshotSha256 = asString(section.snapshotSha256) || asString(result.snapshotSha256) || asString(result.snapshot_sha256);
      if (!intakePath || !reportPath || !snapshotPath || !/^[a-f0-9]{64}$/i.test(snapshotSha256)) {
        throw new Error('同类内容已获取，但保存结果不完整。请重试。');
      }
      const evidence: TopicResearchEvidence = {
        reportPath,
        snapshotPath,
        snapshotSha256,
        status: asString(section.status) || asString(result.status) || '已完成',
        sampleCount: typeof section.sampleCount === 'number' ? section.sampleCount : typeof result.sampleCount === 'number' ? result.sampleCount : 0,
        queries: Array.isArray(section.queries)
          ? section.queries.filter((item): item is string => typeof item === 'string').slice(0, 12)
          : Array.isArray(result.queries)
            ? result.queries.filter((item): item is string => typeof item === 'string').slice(0, 12)
            : [],
        requiredPlatforms: Array.isArray(section.requiredPlatforms)
          ? section.requiredPlatforms.filter((item): item is string => typeof item === 'string').slice(0, 5)
          : Array.isArray(result.requiredPlatforms)
            ? result.requiredPlatforms.filter((item): item is string => typeof item === 'string').slice(0, 5)
            : ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
        readyPlatforms: Array.isArray(section.readyPlatforms)
          ? section.readyPlatforms.filter((item): item is string => typeof item === 'string').slice(0, 3)
          : Array.isArray(result.readyPlatforms)
            ? result.readyPlatforms.filter((item): item is string => typeof item === 'string').slice(0, 3)
            : [],
        partial: section.partial === true || result.partial === true,
      };
      if (!evidence.readyPlatforms?.length) evidence.readyPlatforms = [...evidence.requiredPlatforms];
      const readyProductionPlatforms = productionPlatformsFromResearch(evidence.readyPlatforms);
      if (!readyProductionPlatforms.length) throw new Error('同类内容已获取，但没有任何平台形成可用研究证据。请重试。');
      const researchIsPartial = readyProductionPlatforms.length !== evidence.requiredPlatforms.length;
      if (researchIsPartial) {
        const platformResponse = await fetch('/api/run', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: task.runId, platforms: readyProductionPlatforms, confirm: true }),
        });
        const platformPayload = await platformResponse.json().catch(() => ({})) as Record<string, unknown>;
        if (!platformResponse.ok) throw new Error(asString(platformPayload.error) || '保存本期可继续的平台失败。');
        evidence.partial = true;
      }
      if (!loadResearchSamplesRef.current) throw new Error('同类内容暂时无法读取，请刷新页面后重试。');
      await loadResearchSamplesRef.current(evidence);
      const inputFingerprint = await createMaterialInputFingerprint({ rawMaterial: materialText, files: materialFiles, links: materialLinks });
      setDraft((current) => ({
        ...current,
        topic: '',
        ...(researchIsPartial ? { selectedPlatforms: readyProductionPlatforms } : {}),
        artifactPaths: { ...current.artifactPaths, 'material-boundary': intakePath },
        approved: { ...current.approved, 'material-boundary': true },
      }));
      setApprovalModes((current) => ({ ...current, 'material-boundary': 'local' }));
      setTopicResearch(evidence);
      setTopicResearchInputFingerprint(inputFingerprint);
      setTopicResearchContextVerified(true);
      setTopicSuggestions([]);
      setReviewAssertions((current) => ({
        ...current,
        market_evidence_reviewed: false,
        topic_boundary_and_goal_confirmed: false,
        brand_template_confirmed: false,
      }));
      setResearchSubview('samples');
      void prewarmTopicSuggestionsRef.current?.(task.runId, evidence);
      setActiveStage('topic-template');
      syncStageToUrl('topic-template');
      const unavailableLabels = researchIsPartial
        ? draft.selectedPlatforms.filter((platform) => !readyProductionPlatforms.includes(platform)).map((platform) => ({
          wechat: '公众号', xhs: '小红书', shipinhao: '视频号',
        }[platform])).filter(Boolean)
        : [];
      setNotice(taskWarnings.length
        ? { tone: 'warning', text: `已找到同类内容。${taskWarnings[0]}` }
        : researchIsPartial
          ? { tone: 'warning', text: `${unavailableLabels.join('、')}本次没有形成可用证据，已从本期生成范围移除；其他平台可以继续选题。需要该平台时，请重新勾选并重试研究。` }
          : { tone: 'success', text: '已找到同类内容。看完后可以继续选题。' });
      return;
    }
    if (task.kind === 'topic-blueprint' || task.kind === 'author-blueprint') {
      const section = asRecord(result.topicBlueprint);
      const blueprintPath = asString(section.blueprintPath) || asString(result.blueprintPath) || asString(result.blueprint_path) || asString(result.path);
      const topic = asString(section.topic) || asString(result.topic) || draft.topic;
      const runSlug = asString(section.runSlug) || asString(result.runSlug) || asString(result.run_slug) || draft.runSlug;
      if (!blueprintPath) throw new Error('选题已保存，但没有生成各平台内容蓝图。请重试。');
      setDraft((current) => ({
        ...current,
        topic,
        runSlug,
        writingMode: task.kind === 'author-blueprint' ? 'author_material' : 'platform',
        artifactPaths: { ...current.artifactPaths, ...(task.kind === 'author-blueprint' ? { 'material-boundary': asString(asRecord(result.materialResearch).intakePath) } : {}), 'topic-template': blueprintPath },
        approved: { ...current.approved, 'material-boundary': true, 'topic-template': false },
      }));
      setApprovalModes((current) => ({ ...current, 'topic-template': null }));
      setReviewAssertions((current) => ({ ...current, topic_boundary_and_goal_confirmed: false }));
      setActiveStage('topic-template');
      syncStageToUrl('topic-template');
      setNotice(taskWarnings.length
        ? { tone: 'warning', text: `写作方案已生成，请先核对方向。${taskWarnings[0]}` }
        : { tone: 'success', text: '写作方案已生成，请先核对方向。确认后再进入正文。' });
      return;
    }
    if (task.kind === 'content-package') {
      const section = asRecord(result.contentPackage);
      const packagePath = asString(section.packagePath) || asString(result.packagePath) || asString(result.package_path) || asString(result.path);
      if (!packagePath) throw new Error('内容生成完成，但没有找到完整结果。请重试。');
      // A generated draft is ready for reading, not evidence of author review.
      setContentReviewReady(false);
      setReviewAssertions((current) => ({
        ...current,
        content_article_reviewed: false,
        content_video_1_reviewed: false,
        content_video_2_reviewed: false,
        content_opinion_1_reviewed: false,
        content_opinion_2_reviewed: false,
        content_opinion_3_reviewed: false,
      }));
      setDraft((current) => ({
        ...invalidateApprovalsFrom(current, 'content-package'),
        artifactPaths: { ...current.artifactPaths, 'content-package': packagePath },
      }));
      setApprovalModes((current) => ({ ...current, 'content-package': null }));
      setActiveStage('content-package');
      syncStageToUrl('content-package');
      setNotice(taskWarnings.length
        ? { tone: 'warning', text: `内容已生成，请阅读并确认后继续。${taskWarnings[0]}` }
        : { tone: 'success', text: '内容已生成。请核对正文、事实和结尾，确认后再制作发布成品。' });
      return;
    }
    if (task.kind === 'visual-candidates') {
      const section = asRecord(result.visualCandidates);
      const slug = asString(section.slug) || asString(result.slug) || draft.runSlug;
      if (slug) await refreshVisualWorkbench(slug);
      setNotice({ tone: 'success', text: '平台成品已生成。请确认本期公众号排版与/或小红书图文卡片。' });
      return;
    }
    if (task.kind === 'draft-queue') {
      const section = asRecord(result.draftQueue);
      const queuePath = asString(section.draftQueuePath) || asString(result.draftQueuePath) || asString(result.draft_queue_path) || asString(result.path);
      const queue = (section.draftQueue || result.draftQueue) as ProductionDraftQueue | undefined;
      if (!queuePath) throw new Error('发布成品已整理，但没有找到完整的发布内容。请重试。');
      if (queue) setPublicationQueue(queue);
      else await refreshPublicationQueue(queuePath);
      setReviewAssertions((current) => ({
        ...current,
        platform_payloads_reviewed: false,
        visual_order_reviewed: false,
        human_send_boundary_confirmed: false,
      }));
      setDeliverableReviewReady(false);
      setDraft((current) => ({ ...current, artifactPaths: { ...current.artifactPaths, 'draft-information': queuePath } }));
      setNotice({ tone: 'success', text: '已选平台的发布成品已分别整理完成，请逐个平台检查。' });
    }
  }, [draft, materialFiles, materialLinks, materialText, refreshPublicationQueue, refreshVisualWorkbench]);

  const submitProductionTask = useCallback(async (kind: ProductionTaskKind, input: Record<string, unknown>) => {
    const runId = draft.runId.trim();
    if (!runId) throw new Error('请先创建并同步当前内容任务。');
    const setupIssue = modelSetupMessage(config);
    if (['topic-blueprint', 'content-package'].includes(kind) && setupIssue) throw new Error(setupIssue);
    const inputIdentity = JSON.stringify({ runId, input });
    if (productionTaskInputsRef.current[kind] !== inputIdentity) delete productionTaskIdsRef.current[kind];
    productionTaskInputsRef.current[kind] = inputIdentity;
    const response = await fetch('/api/production/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind,
        taskId: productionTaskIdsRef.current[kind]
          || (productionTaskIdsRef.current[kind] = newProductionTaskId(kind)),
        input,
      }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(asString(payload.error) || '当前处理未能开始');
    const task = asRecord(payload.task) as unknown as ProductionTask;
    if (!task?.taskId) throw new Error('当前处理未能开始，请重试。');
    setActiveTask(task);
    setTaskRecovered(false);
    setNotice({ tone: 'success', taskId: task.taskId, text: '任务已保存，请查看当前处理状态。' });
    return task;
  }, [draft.runId, config]);

  const retryActiveProductionTask = useCallback(async (mode: 'default' | 'recover' | 'redispatch' = 'default') => {
    const task = activeTaskRef.current;
    if (!task) return;
    if (task.kind === 'author-blueprint' && (draft.writingMode !== 'author_material'
      || (asString(asRecord(asRecord(task.result).topicBlueprint).topic)
        && asString(asRecord(asRecord(task.result).topicBlueprint).topic) !== draft.topic.trim().replace(/\s+/g, ' ')))) {
      setNotice({ tone: 'warning', text: '题目或写作方式已更改。请返回素材页核对后，按新的选择开始。原任务仍保留。' });
      return;
    }
    try {
      const response = await fetch(`/api/production/tasks/${encodeURIComponent(task.taskId)}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: task.runId, mode }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(asString(payload.error) || '重试失败');
      const next = asRecord(payload.task) as unknown as ProductionTask;
      setActiveTask(next);
      setTaskRecovered(false);
      setNotice({
        tone: 'success',
        taskId: next.taskId,
        text: mode === 'recover'
          ? '已恢复上次保存的结果。'
          : mode === 'redispatch'
            ? '已确认重新执行当前步骤。'
            : '已从失败的步骤重试。',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '重试失败' });
    }
  }, [draft.topic, draft.writingMode]);

  useEffect(() => {
    const runId = draft.runId.trim();
    if (!runId || activeTask) return;
    let cancelled = false;
    const restore = async () => {
      try {
        const response = await fetch(`/api/production/tasks?${new URLSearchParams({ runId }).toString()}`, { cache: 'no-store' });
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        const task = asRecord(payload.task) as unknown as ProductionTask;
        if (!cancelled && task?.taskId && ['queued', 'running', 'failed', 'blocked'].includes(task.status)) {
          setActiveTask(task);
          setTaskRecovered(true);
        }
      } catch {
        // A missing task system must not prevent the existing saved run from opening.
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, [activeTask, draft.runId]);

  useEffect(() => {
    const task = activeTask;
    if (!task || !['queued', 'running'].includes(task.status)) return;
    let cancelled = false;
    let polling = false;
    let timer: number | null = null;
    const scheduleNextPoll = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => { void poll(); }, document.hidden ? 4_000 : 900);
    };
    const poll = async () => {
      if (cancelled || polling) return;
      polling = true;
      try {
        const next = await readProductionTask(task.runId, task.taskId);
        if (cancelled) return;
        if (next.status === 'completed') {
          await applyCompletedProductionTask(next);
          if (!cancelled) {
            if (document.hidden) document.title = `已完成 · ${defaultDocumentTitleRef.current || '内容制作'}`;
            setActiveTask(null);
          }
        } else if (next.status === 'failed' || next.status === 'blocked') {
          // Stop polling before refreshing progress: refresh changes the draft
          // and tears down this effect while its request is still awaiting.
          setActiveTask(next);
          if (next.kind === 'author-blueprint' && next.currentStep === 'content-blueprint') {
            await refreshRuntime();
            if (!workbenchMountedRef.current || materialRunRef.current !== next.runId) return;
            setActiveStage('topic-template');
            syncStageToUrl('topic-template');
          }
          if (document.hidden) document.title = `需要处理 · ${defaultDocumentTitleRef.current || '内容制作'}`;
          setNotice({ tone: 'error', taskId: next.taskId, text: readableTaskFailure(next) });
        } else {
          setActiveTask(next);
        }
      } catch (error) {
        if (!cancelled) setNotice({ tone: 'error', text: error instanceof Error ? error.message : '后台任务状态读取失败' });
      } finally {
        polling = false;
        scheduleNextPoll();
      }
    };
    const refreshWhenVisible = () => {
      if (document.hidden || cancelled) return;
      if (timer !== null) window.clearTimeout(timer);
      void poll();
    };
    void poll();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [activeTask, applyCompletedProductionTask, readProductionTask, refreshRuntime]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshRuntime();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshRuntime]);

  const updateDraft = useCallback((patch: Partial<Pick<ProductionDraft, 'topic' | 'writingMode' | 'template' | 'projectId'>>) => {
    setDraft((current) => draftAfterWritingChoice(current, patch));
    if (patch.template || patch.topic !== undefined || patch.writingMode !== undefined) {
      setApprovalModes((current) => {
        const next = { ...current };
        for (const stage of PRODUCTION_STAGES.slice(1)) next[stage.id] = null;
        return next;
      });
    }
    if (patch.template || patch.topic !== undefined || patch.writingMode !== undefined) {
      setReviewAssertions((current) => ({
        ...current,
        market_evidence_reviewed: false,
        topic_boundary_and_goal_confirmed: false,
        brand_template_confirmed: false,
      }));
      setContentReviewReady(false);
    }
  }, []);

  const changeSelectedPlatforms = useCallback(async (platforms: ProductionPlatform[]) => {
    const nextPlatforms = normalizeProductionPlatforms(platforms);
    if (
      nextPlatforms.length === draft.selectedPlatforms.length
      && nextPlatforms.every((platform, index) => platform === draft.selectedPlatforms[index])
    ) return;

    setDraft((current) => draftAfterPlatformChange(current, nextPlatforms));
    setTopicResearch(null);
    setTopicResearchInputFingerprint('');
    setTopicResearchContextVerified(false);
    setResearchSubview('samples');
    setResearchSamples([]);
    setResearchPlatformTotals({});
    researchSamplesLoaded.current = '';
    setTopicSuggestions([]);
    setReviewAssertions({ ...EMPTY_REVIEW_ASSERTIONS });
    setContentReviewReady(false);

    if (!draft.runId) return;
    setBusyAction('material-boundary');
    setNotice(null);
    try {
      const response = await fetch('/api/run', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: draft.runId, platforms: nextPlatforms }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(asString(payload.error) || '本期平台保存失败');
      setNotice({ tone: 'success', text: `本期已选择 ${nextPlatforms.length} 个平台。` });
    } catch (error) {
      await refreshRuntime();
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '本期平台保存失败' });
    } finally {
      setBusyAction(null);
    }
  }, [draft.runId, draft.selectedPlatforms, refreshRuntime]);

  const resetMaterialDirection = useCallback((options: { retainAnalysis?: boolean } = {}) => {
    materialDirectionDirtyRef.current = false;
    materialPersistedSelectionRef.current = '';
    if (materialSelectionTimer.current !== null) {
      window.clearTimeout(materialSelectionTimer.current);
      materialSelectionTimer.current = null;
    }
    if (options.retainAnalysis) {
      setMaterialAnalysisStale(true);
    } else {
      setMaterialAnalysis(null);
      setMaterialAnalysisStale(false);
    }
    setSelectedMaterialTypeId('');
    setSelectedMaterialStructureId('');
    setTopicResearch(null);
    setTopicResearchInputFingerprint('');
    setTopicResearchContextVerified(false);
    setResearchSubview('samples');
    setResearchSamples([]);
    setResearchPlatformTotals({});
    researchSamplesLoaded.current = '';
    setTopicSuggestions([]);
    setDraft(draftAfterMaterialChange);
    setApprovalModes({ ...EMPTY_APPROVAL_MODES });
    setReviewAssertions({ ...EMPTY_REVIEW_ASSERTIONS });
    setContentReviewReady(false);
  }, []);

  // Editing a restored run must invalidate its server-side analysis too.  The
  // browser keeps edits responsive and then sends one atomic snapshot after a
  // short pause; TikOmni remains locked throughout, including after refresh.
  useEffect(() => {
    const runId = draft.runId.trim();
    const input = materialInputRef.current;
    const hasInput = Boolean(
      input.rawMaterial.trim()
      || input.files.length
      || input.links.some((link) => link.trim()),
    );
    if (!runId || !hasInput || !materialServerFingerprintRef.current) return;
    // A prior request reads the latest form state again before completing. Do
    // not race another invalidation against it: rapid typing otherwise lets an
    // old fingerprint conflict with the same operator's next edit.
    if (materialInvalidationInFlightRef.current) {
      materialInvalidationPendingRef.current = true;
      return;
    }

    const timer = window.setTimeout(() => {
      materialInvalidationTimer.current = null;
      const invalidateUntilCurrent = async () => {
        while (workbenchMountedRef.current && materialRunRef.current === runId) {
          try {
            const expectedInputFingerprint = materialServerFingerprintRef.current;
            const currentInput = materialInputRef.current;
            const inputFingerprint = await createMaterialInputFingerprint(currentInput);
            if (!expectedInputFingerprint || inputFingerprint === expectedInputFingerprint) return;

            const response = await fetch('/api/production/material-analysis', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                runId,
                mode: 'invalidate',
                expectedInputFingerprint,
                rawMaterial: currentInput.rawMaterial.trim(),
                files: currentInput.files,
                links: currentInput.links.filter((link) => link.trim()),
              }),
            });
            const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
            if (!workbenchMountedRef.current || materialRunRef.current !== runId) return;
            if (!response.ok) {
              setMaterialAnalysisStale(true);
              setNotice({
                tone: 'warning',
                text: response.status === 409
                  ? '本期素材已在其他窗口更新。为避免使用旧分析，请刷新后重新分析当前输入。'
                  : displayResearchMessage(payload.error, '本期素材已变更。请重新整理素材，再查看同类内容。'),
              });
              return;
            }
            const context = asRecord(payload.context);
            const serverFingerprint = asString(context.inputFingerprint);
            if (!serverFingerprint) throw new Error('素材状态没有更新成功。请刷新后重新整理素材。');
            materialServerFingerprintRef.current = serverFingerprint;
            setMaterialServerIdentity({ runId, fingerprint: serverFingerprint });
            materialPersistedSelectionRef.current = '';
            materialDirectionDirtyRef.current = false;
            setMaterialAnalysisStale(true);
            // The user may have continued typing during the request. Loop
            // once more with the latest input instead of issuing a competing
            // write from a new effect instance.
          } catch (error) {
            if (workbenchMountedRef.current && materialRunRef.current === runId) {
              setMaterialAnalysisStale(true);
              setNotice({ tone: 'warning', text: displayResearchMessage(error instanceof Error ? error.message : '', '本期素材已变更。请重新整理素材，再查看同类内容。') });
            }
            return;
          }
        }
      };
      const task = invalidateUntilCurrent();
      materialInvalidationInFlightRef.current = task;
      void task.finally(() => {
        if (materialInvalidationInFlightRef.current === task) {
          materialInvalidationInFlightRef.current = null;
          if (materialInvalidationPendingRef.current && workbenchMountedRef.current) {
            materialInvalidationPendingRef.current = false;
            setMaterialInputSyncRevision((current) => current + 1);
          }
        }
      });
    }, 450);
    materialInvalidationTimer.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (materialInvalidationTimer.current === timer) materialInvalidationTimer.current = null;
    };
  }, [draft.runId, materialAnalysisStale, materialFiles, materialInputSyncRevision, materialLinks, materialText]);

  const startNewMaterialPeriod = useCallback(async () => {
    if (busyAction || agentRunning) return;
    setBusyAction('material-boundary');
    setNotice(null);
    try {
      if (materialInvalidationTimer.current !== null) {
        window.clearTimeout(materialInvalidationTimer.current);
        materialInvalidationTimer.current = null;
      }
      if (materialInvalidationInFlightRef.current) {
        await materialInvalidationInFlightRef.current;
      }
      if (hasDraftContent) await saveDraftSnapshot();
      savedDraftRef.current = { id: '', version: 0 };
      setSavedDraftId('');
      lastSnapshotRef.current = '';
      restoredSnapshotInputRef.current = false;
      setDraftName('');
      setRecoverableDraft(null);
      materialContextLoaded.current = '';
      researchSamplesLoaded.current = '';
      materialServerFingerprintRef.current = '';
      setMaterialServerIdentity({ runId: '', fingerprint: '' });
      materialPersistedSelectionRef.current = '';
      materialDirectionDirtyRef.current = false;
      materialInvalidationPendingRef.current = false;
      const nextDraft = createProductionDraft();
      nextDraft.template = resolvePreferredMd2WechatThemeId(
        brandTemplates.map((template) => template.id),
        readMd2WechatThemePreferences(),
        nextDraft.template,
      );
      setDraft(nextDraft);
      setNotes({ ...EMPTY_NOTES });
      setMaterialText('');
      setMaterialLinks([]);
      setMaterialFiles([]);
      setMaterialAnalysis(null);
      setMaterialAnalysisStale(false);
      setSelectedMaterialTypeId('');
      setSelectedMaterialStructureId('');
      setApprovalModes({ ...EMPTY_APPROVAL_MODES });
      setReviewAssertions({ ...EMPTY_REVIEW_ASSERTIONS });
      setContentReviewReady(false);
      setTopicResearch(null);
      setTopicResearchInputFingerprint('');
      setTopicResearchContextVerified(false);
      setResearchSubview('samples');
      setResearchSamples([]);
      setResearchPlatformTotals({});
      setTopicSuggestions([]);
      setPublicationQueue(null);
      setPublicationInputs({});
      setVisualWorkbench(null);
      setActiveTask(null);
      productionTaskIdsRef.current = {};
      setActiveStage('material-boundary');
      syncStageToUrl('material-boundary');
      window.localStorage.removeItem(STORAGE_KEY);
      setShowStageRail(false);
      setNotice({ tone: 'success', text: '本期已保存在草稿列表。现在可以开始新一期。' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '开始新一期失败' });
      throw error;
    } finally {
      setBusyAction(null);
    }
  }, [agentRunning, brandTemplates, busyAction, hasDraftContent, saveDraftSnapshot]);

  const changeMaterialText = useCallback((value: string) => {
    if (value === materialText) return;
    // Leading/trailing whitespace does not participate in the material
    // fingerprint, so it should not make an already analysed run stale.
    if (value.trim() === materialText.trim()) {
      setMaterialText(value);
      return;
    }
    const wasCurrent = Boolean(materialAnalysis) && !materialAnalysisStale;
    setMaterialText(value);
    resetMaterialDirection({ retainAnalysis: Boolean(materialAnalysis) });
    if (wasCurrent) {
      setNotice({ tone: 'warning', text: '素材已修改，之前的整理结果已失效。请重新整理当前素材，再查看同类内容。' });
    }
  }, [materialAnalysis, materialAnalysisStale, materialText, resetMaterialDirection]);

  const changeMaterialLinks = useCallback((links: string[]) => {
    const nextLinks = links.slice(0, 5);
    const currentMeaningful = Array.from(new Set(toStoredMaterialLinks(materialLinks)));
    const nextMeaningful = Array.from(new Set(toStoredMaterialLinks(nextLinks)));
    // Adding an empty input row is a presentation action, not a new source.
    // Keep the editable row without invalidating an otherwise current run.
    if (currentMeaningful.join('\u0000') === nextMeaningful.join('\u0000')) {
      setMaterialLinks(nextLinks);
      return;
    }
    const wasCurrent = Boolean(materialAnalysis) && !materialAnalysisStale;
    setMaterialLinks(nextLinks);
    resetMaterialDirection({ retainAnalysis: Boolean(materialAnalysis) });
    if (wasCurrent) {
      setNotice({ tone: 'warning', text: '素材已修改，之前的整理结果已失效。请重新整理当前素材，再查看同类内容。' });
    }
  }, [materialAnalysis, materialAnalysisStale, materialLinks, resetMaterialDirection]);

  const changeMaterialFiles = useCallback((files: MaterialUpload[]) => {
    const wasCurrent = Boolean(materialAnalysis) && !materialAnalysisStale;
    setMaterialFiles(files.slice(0, 20));
    resetMaterialDirection({ retainAnalysis: Boolean(materialAnalysis) });
    if (wasCurrent) {
      setNotice({ tone: 'warning', text: '素材已修改，之前的整理结果已失效。请重新整理当前素材，再查看同类内容。' });
    }
  }, [materialAnalysis, materialAnalysisStale, resetMaterialDirection]);

  // Audio files are added to the list immediately in the `transcribing` state;
  // the background transcription on the server reports back through this poll.
  // The effect only runs while at least one file is still transcribing, so a
  // settled list stops polling on its own.
  useEffect(() => {
    const pending = materialFiles.filter((file) => file.extractionStatus === 'transcribing' && file.sourcePath);
    if (pending.length === 0) return;

    let cancelled = false;
    let inFlight = false;

    const pollOnce = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        let changed = false;
        const updated = await Promise.all(materialFiles.map(async (file) => {
          if (file.extractionStatus !== 'transcribing' || !file.sourcePath) return file;
          try {
            const response = await fetch(`/api/materials?transcriptionStatus=${encodeURIComponent(file.sourcePath)}`);
            const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
            if (!response.ok) return file;
            const status = asString(payload.status);
            if (status === 'done') {
              changed = true;
              return {
                ...file,
                path: asString(payload.path) || file.path,
                extractionStatus: extractionStatusFromResponse(payload.extractionStatus) || 'audio_transcribed',
              };
            }
            if (status === 'failed') {
              changed = true;
              return { ...file, extractionStatus: 'needs_transcription' as const };
            }
            return file;
          } catch {
            return file;
          }
        }));
        if (!cancelled && changed) setMaterialFiles(updated.slice(0, 20));
      } finally {
        inFlight = false;
      }
    };

    void pollOnce();
    const timer = window.setInterval(pollOnce, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [materialFiles]);

  const initializeMaterialDirection = useCallback((typeId: string, structureId: string) => {
    // This only hydrates a missing recommendation. It must never invalidate an
    // already completed material boundary when the page is revisited.
    setSelectedMaterialTypeId(typeId);
    setSelectedMaterialStructureId(structureId);
  }, []);

  const selectMaterialType = useCallback((typeId: string) => {
    if (typeId === selectedMaterialTypeId) return;
    if (draft.artifactPaths['material-boundary']) {
      resetMaterialDirection();
      materialDirectionDirtyRef.current = false;
    } else {
      materialDirectionDirtyRef.current = true;
    }
    setSelectedMaterialTypeId(typeId);
  }, [draft.artifactPaths, resetMaterialDirection, selectedMaterialTypeId]);

  const selectMaterialStructure = useCallback((structureId: string) => {
    if (structureId === selectedMaterialStructureId) return;
    if (draft.artifactPaths['material-boundary']) {
      resetMaterialDirection();
      materialDirectionDirtyRef.current = false;
    } else {
      materialDirectionDirtyRef.current = true;
    }
    setSelectedMaterialStructureId(structureId);
  }, [draft.artifactPaths, resetMaterialDirection, selectedMaterialStructureId]);

  // A recommendation is only visual until the operator actively changes it.
  // Persist an explicit choice before TikOmni starts, without making each card
  // click feel like a network round trip. The final research action repeats
  // this checked write as its own hard gate.
  useEffect(() => {
    const runId = draft.runId.trim();
    if (
      !materialDirectionDirtyRef.current
      || !runId
      || !materialAnalysis
      || materialAnalysisStale
      || !selectedMaterialTypeId
      || !selectedMaterialStructureId
    ) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const persistSelection = async () => {
        try {
          const currentInput = materialInputRef.current;
          const inputFingerprint = await createMaterialInputFingerprint(currentInput);
          if (!materialServerFingerprintRef.current || inputFingerprint !== materialServerFingerprintRef.current) {
            if (!cancelled) {
              setMaterialAnalysisStale(true);
              setNotice({ tone: 'warning', text: '素材已变更，之前的判断已失效。请重新整理素材，再查看同类内容。' });
            }
            return;
          }
          const selectionKey = [runId, inputFingerprint, selectedMaterialTypeId, selectedMaterialStructureId].join('|');
          if (materialPersistedSelectionRef.current === selectionKey) {
            materialDirectionDirtyRef.current = false;
            return;
          }
          const response = await fetch('/api/production/material-analysis', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              runId,
              expectedInputFingerprint: inputFingerprint,
              selectedTypeId: selectedMaterialTypeId,
              selectedStructureId: selectedMaterialStructureId,
            }),
          });
          const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
          if (cancelled) return;
          if (!response.ok) {
            materialDirectionDirtyRef.current = false;
            if (response.status === 409) setMaterialAnalysisStale(true);
            setNotice({
              tone: 'warning',
              text: asString(payload.error) || '当前素材判断没有保存成功。请重新整理素材后再继续。',
            });
            return;
          }
          const context = asRecord(payload.context);
          const serverFingerprint = asString(context.inputFingerprint);
          if (serverFingerprint !== inputFingerprint || asString(context.analysisStatus) !== 'current') {
            throw new Error('当前素材分析已失效，请重新分析后再继续。');
          }
          materialServerFingerprintRef.current = serverFingerprint;
          setMaterialServerIdentity({ runId, fingerprint: serverFingerprint });
          materialPersistedSelectionRef.current = selectionKey;
          materialDirectionDirtyRef.current = false;
        } catch (error) {
          if (!cancelled) {
            materialDirectionDirtyRef.current = false;
            setMaterialAnalysisStale(true);
            setNotice({ tone: 'warning', text: error instanceof Error ? error.message : '当前素材判断没有保存成功，请重新整理素材后再继续。' });
          }
        }
      };
      void persistSelection();
    }, 350);
    materialSelectionTimer.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (materialSelectionTimer.current === timer) materialSelectionTimer.current = null;
      cancelled = true;
    };
  }, [
    draft.runId,
    materialAnalysis,
    materialAnalysisStale,
    selectedMaterialStructureId,
    selectedMaterialTypeId,
  ]);

  const createTemporaryMaterialRun = useCallback(async () => {
    if (draft.runId && draft.runSlug) {
      return {
        runId: draft.runId,
        runSlug: draft.runSlug,
        projectId: draft.projectId || 'default',
      };
    }
    const runStamp = Date.now();
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: `material-${runStamp}`,
        projectId: draft.projectId.trim().toLowerCase() || 'default',
        entryMode: 'material_analysis',
        platforms: draft.selectedPlatforms,
      }),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(asString(data.error) || '创建本期素材任务失败');
    const runId = asString(data.run_id) || asString(data.runId);
    const runSlug = asString(data.slug);
    if (!runId || !runSlug) throw new Error('本期素材任务没有返回可验证的 run 信息。');
    const run = {
      runId,
      runSlug,
      projectId: asString(data.project_id) || asString(data.projectId) || draft.projectId.trim().toLowerCase() || 'default',
    };
    materialServerFingerprintRef.current = '';
    setMaterialServerIdentity({ runId: '', fingerprint: '' });
    materialPersistedSelectionRef.current = '';
    materialDirectionDirtyRef.current = false;
    materialInvalidationPendingRef.current = false;
    // Persist the runtime binding before saving analysis context. A temporary
    // network failure can then be retried against the same run instead of
    // creating an orphan run for every click.
    setDraft((current) => ({
      ...draftAfterMaterialChange(current),
      projectId: run.projectId,
      runId: run.runId,
      runSlug: run.runSlug,
      artifactPaths: {},
    }));
    return run;
  }, [draft.projectId, draft.runId, draft.runSlug, draft.selectedPlatforms]);

  const uploadMaterialFiles = useCallback(async (files: File[]): Promise<MaterialUpload[]> => {
    if (busyAction || agentRunning) throw new Error('当前正在处理本期素材，请稍候。');
    setBusyAction('material-boundary');
    try {
      const uploaded: MaterialUpload[] = [];
      let failed = 0;
      // The material endpoint assigns collision-safe file names without a batch
      // lock, so keep this intentionally sequential instead of racing uploads.
      for (const file of files) {
        try {
          const uploadForm = new FormData();
          uploadForm.set('path', 'materials/intake');
          uploadForm.set('file', file, file.name);
          const uploadResponse = await fetch('/api/materials?action=upload', {
            method: 'POST',
            body: uploadForm,
          });
          const upload = await uploadResponse.json().catch(() => ({})) as Record<string, unknown>;
          if (!uploadResponse.ok) throw new Error(asString(upload.error) || `${file.name} 导入失败`);
          const sourcePath = asString(upload.path);
          if (!sourcePath) throw new Error(`${file.name} 没有返回本机素材路径`);

          // Extraction produces a text-addressable companion even for images,
          // audio, and office files. The intake skill receives this companion,
          // rather than pretending an opaque filename itself is usable material.
          const extractResponse = await fetch('/api/materials?action=extract', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: sourcePath }),
          });
          const extraction = await extractResponse.json().catch(() => ({})) as Record<string, unknown>;
          if (!extractResponse.ok) throw new Error(asString(extraction.error) || `${file.name} 解析失败`);
          const extractedPath = asString(extraction.path);
          const extractionStatus = extractionStatusFromResponse(extraction.extractionStatus);
          uploaded.push({
            name: file.name,
            size: file.size,
            sourcePath,
            path: extractedPath || sourcePath,
            ...(extractionStatus ? { extractionStatus } : {}),
          });
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        setNotice({
          tone: uploaded.length > 0 ? 'warning' : 'error',
          text: uploaded.length > 0
            ? `${failed} 个文件暂时无法导入，已保留其余 ${uploaded.length} 个文件，可继续分析。`
            : '文件暂时无法导入，请检查格式或大小后重试；也可以继续使用其他素材。',
        });
      }
      if (uploaded.length === 0) throw new Error('没有可用于本期分析的文件。');
      return uploaded;
    } finally {
      setBusyAction(null);
    }
  }, [agentRunning, busyAction]);

  const retryMaterialFileExtraction = useCallback(async (file: MaterialUpload): Promise<MaterialUpload> => {
    if (busyAction || agentRunning) throw new Error('当前正在处理本期素材，请稍候。');
    const sourcePath = file.sourcePath?.trim();
    if (!sourcePath) throw new Error('该文件缺少可重试的原始素材路径，请移除后重新添加。');

    setBusyAction('material-boundary');
    try {
      const response = await fetch('/api/materials?action=extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: sourcePath }),
      });
      const extraction = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(asString(extraction.error) || `${file.name} 暂时无法重新读取`);
      const extractedPath = asString(extraction.path);
      const extractionStatus = extractionStatusFromResponse(extraction.extractionStatus);
      if (!extractedPath || !extractionStatus) throw new Error(`${file.name} 没有返回可验证的读取结果。`);

      if (extractionStatus === 'transcribing') {
        setNotice({ tone: 'success', text: `${file.name} 已重新开始转写，请稍候。` });
      } else if (extractionStatus === 'needs_transcription') {
        setNotice({ tone: 'warning', text: `${file.name} 暂时仍无法自动读取。请稍后重试，或补充文字摘要。` });
      } else {
        setNotice({ tone: 'success', text: `${file.name} 已重新读取，可纳入本期素材分析。` });
      }
      return {
        ...file,
        sourcePath,
        path: extractedPath,
        extractionStatus,
      };
    } finally {
      setBusyAction(null);
    }
  }, [agentRunning, busyAction]);

  const loadResearchSamples = useCallback(async (evidence: TopicResearchEvidence) => {
    const query = new URLSearchParams({
      runId: draft.runId,
      snapshotPath: evidence.snapshotPath,
      snapshotSha256: evidence.snapshotSha256,
    });
    const response = await fetch(`/api/research/samples?${query.toString()}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(displayResearchMessage(payload.error, '已保存的平台数据没有完整读出。请重新查看同类内容。'));
    const groups = Array.isArray(payload.groups) ? payload.groups : [];
    const rows: TikOmniSampleRow[] = [];
    const totals: Record<string, number> = {};
    for (const value of groups) {
      const group = asRecord(value);
      const platform = asString(group.platform);
      if (!platform) continue;
      const samples = Array.isArray(group.samples) ? group.samples : [];
      totals[platform] = typeof group.sampleCount === 'number' && Number.isFinite(group.sampleCount)
        ? group.sampleCount
        : samples.length;
      for (const item of samples) {
        const sample = asRecord(item);
        const rawMetrics = asRecord(sample.metrics);
        const metrics = Object.fromEntries(Object.entries(rawMetrics).flatMap(([key, metric]) => (
          typeof metric === 'number' && Number.isFinite(metric) ? [[key, metric]] : []
        )));
        const row: TikOmniSampleRow = {
          id: asString(sample.id) || `${platform}-${rows.length + 1}`,
          platform,
          title: asString(sample.title) || '未命名样本',
          account: asString(sample.account) || '未标注账号',
          publishedAt: asString(sample.publishedAt),
          contentForm: asString(sample.contentForm),
          url: asString(sample.url),
          hitPoint: asString(sample.hook) || asString(sample.mechanism),
          metrics,
          sampleClass: ['verified_hit', 'potential', 'related', 'insufficient'].includes(asString(sample.sampleClass))
            ? asString(sample.sampleClass) as 'verified_hit' | 'potential' | 'related' | 'insufficient'
            : 'insufficient',
          hitScore: typeof sample.hitScore === 'number' ? sample.hitScore : 0,
          classificationReason: asString(sample.classificationReason),
          evidenceStatus: asString(sample.evidenceStatus) === 'sufficient' ? 'sufficient' : 'insufficient',
          confidence: typeof sample.confidence === 'number' ? sample.confidence : 0,
          metricCompleteness: typeof sample.metricCompleteness === 'number' ? sample.metricCompleteness : 0,
          ageDays: typeof sample.ageDays === 'number' ? sample.ageDays : null,
          scoreComponents: Object.fromEntries(Object.entries(asRecord(sample.scoreComponents)).flatMap(([key, value]) => (
            typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : []
          ))),
          creatorLift: typeof sample.creatorLift === 'number' ? sample.creatorLift : null,
          engagementRate: typeof sample.engagementRate === 'number' ? sample.engagementRate : null,
          scoreVersion: asString(sample.scoreVersion),
        };
        row.interactions = knownSampleInteractions(row);
        rows.push(row);
      }
    }
    setResearchSamples(rows);
    setResearchPlatformTotals(totals);
    setResearchFilters(DEFAULT_TIKOMNI_FILTERS);
    setResearchSort(DEFAULT_TIKOMNI_SORT);
    researchSamplesLoaded.current = [draft.runId, evidence.snapshotPath, evidence.snapshotSha256].join('|');
  }, [draft.runId]);

  const prewarmTopicSuggestions = useCallback(async (runId: string, evidence: TopicResearchEvidence) => {
    try {
      await fetch('/api/research/topic-suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'prewarm',
          runId,
          snapshotPath: evidence.snapshotPath,
          snapshotSha256: evidence.snapshotSha256,
        }),
      });
      // Retrieval has a synchronous cache-miss fallback, so a failed prewarm
      // remains invisible here and never blocks sample review.
    } catch {
      // The operator can still open the topic page once samples are reviewed.
    }
  }, []);

  useEffect(() => {
    loadResearchSamplesRef.current = loadResearchSamples;
    prewarmTopicSuggestionsRef.current = prewarmTopicSuggestions;
  }, [loadResearchSamples, prewarmTopicSuggestions]);

  useEffect(() => {
    if (!draft.runId || !topicResearch || !topicResearchContextVerified) return;
    const key = [draft.runId, topicResearch.snapshotPath, topicResearch.snapshotSha256].join('|');
    if (researchSamplesLoaded.current === key) return;
    let cancelled = false;
    const restoreSamples = async () => {
      try {
        await loadResearchSamples(topicResearch);
      } catch (error) {
        if (!cancelled) {
          researchSamplesLoaded.current = '';
          setNotice({ tone: 'error', text: displayResearchMessage(error instanceof Error ? error.message : '', '已保存的平台数据没有恢复成功。请重新查看同类内容。') });
        }
      }
    };
    void restoreSamples();
    return () => { cancelled = true; };
  }, [draft.runId, loadResearchSamples, topicResearch, topicResearchContextVerified]);

  const analyzeMaterial = useCallback(async () => {
    if (busyAction || agentRunning) return;
    if (!materialText.trim() && materialFiles.length === 0 && materialLinks.every((link) => !link.trim())) {
      setNotice({ tone: 'warning', text: '请先粘贴素材、添加文件或补充至少一条灵感链接。' });
      return;
    }
    setBusyAction('material-boundary');
    setNotice(null);
    try {
      if (materialInvalidationTimer.current !== null) {
        window.clearTimeout(materialInvalidationTimer.current);
        materialInvalidationTimer.current = null;
      }
      if (materialInvalidationInFlightRef.current) {
        await materialInvalidationInFlightRef.current;
      }
      const run = await createTemporaryMaterialRun();
      materialContextLoaded.current = run.runId;
      if (materialSelectionTimer.current !== null) {
        window.clearTimeout(materialSelectionTimer.current);
        materialSelectionTimer.current = null;
      }
      const currentInput = materialInputRef.current;
      const expectedInputFingerprint = materialServerFingerprintRef.current || undefined;
      const response = await fetch('/api/production/material-analysis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: run.runId,
          projectId: run.projectId,
          ...(expectedInputFingerprint ? { expectedInputFingerprint } : {}),
          rawMaterial: currentInput.rawMaterial.trim(),
          files: currentInput.files,
          links: currentInput.links.filter((link) => link.trim()),
        }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(asString(payload.error) || '本期素材分析失败');
      const context = asRecord(payload.context);
      const analysis = toStoredMaterialAnalysis(context.analysis);
      if (!analysis) throw new Error('本期素材分析没有返回完整的提炼结果。');
      const contextFingerprint = asString(context.inputFingerprint);
      if (!contextFingerprint || asString(context.analysisStatus) !== 'current') {
        throw new Error('本期素材分析没有返回可继续使用的快照。');
      }
      if (await createMaterialInputFingerprint(materialInputRef.current) !== contextFingerprint) throw new Error('素材在整理期间发生了变化。当前输入已保留，请重新整理。');
      const selection = asRecord(context.selection);
      const nextDraft = {
        ...draftAfterMaterialAnalysis(draft, currentInput.rawMaterial),
        projectId: run.projectId,
        runId: run.runId,
        runSlug: run.runSlug,
        selectedPlatforms: [...draft.selectedPlatforms],
        approved: { ...createProductionDraft().approved },
        artifactPaths: {},
      };
      setDraft(nextDraft);
      setApprovalModes({ ...EMPTY_APPROVAL_MODES });
      setReviewAssertions({ ...EMPTY_REVIEW_ASSERTIONS });
      setContentReviewReady(false);
      setTopicResearch(null);
      setTopicResearchInputFingerprint('');
      setTopicResearchContextVerified(false);
      setResearchSubview('samples');
      setResearchSamples([]);
      setResearchPlatformTotals({});
      researchSamplesLoaded.current = '';
      setTopicSuggestions([]);
      setMaterialAnalysis(analysis);
      materialCorrectionSeenRef.current = { runId: run.runId, id: asString(context.correctionId), analysis: context.analysis };
      setMaterialAnalysisStale(false);
      setSelectedMaterialTypeId(asString(selection.materialTypeId) || analysis.recommendedTypeId);
      setSelectedMaterialStructureId(asString(selection.structureId) || analysis.recommendedStructureId);
      materialServerFingerprintRef.current = contextFingerprint;
      setMaterialServerIdentity({ runId: run.runId, fingerprint: contextFingerprint });
      materialPersistedSelectionRef.current = selection.materialTypeId && selection.structureId
        ? [run.runId, contextFingerprint, asString(selection.materialTypeId), asString(selection.structureId)].join('|')
        : '';
      materialDirectionDirtyRef.current = false;
      const sources = analysis.sources || [];
      const hasReadableSource = sources.some((source) => source.status === 'read');
      const readableReferenceCount = sources.filter((source) => source.kind === 'link' && source.status === 'read').length;
      const videoChannelNeedsTranscript = sources.some((source) => (
        source.kind === 'link'
        && source.status === 'failed'
        && source.detail.includes('视频号页面未公开可读取字幕或正文')
      ));
      setNotice(
        sources.length > 0 && !hasReadableSource
          ? {
            tone: 'warning',
            text: videoChannelNeedsTranscript
              ? '已识别视频号链接，但该页面未公开可读取字幕或正文。请补充字幕、逐字稿或其他文字素材后重新分析。'
              : '素材分析已完成，但当前没有可读取的内容。请补充文字、可解析文件或其他灵感链接后重新分析。',
          }
          : {
            tone: 'success',
            text: readableReferenceCount
              ? `已读取 ${readableReferenceCount} 条参考链接。下一步会查看已选平台的同类内容，并给出各平台主题建议。`
              : '素材已整理。可以按自己的题目写，也可以查看同类内容找方向。',
          },
      );
      // Bind an already saved draft to its newly created local run before the
      // user can leave. Local-storage recovery alone cannot name the outcome
      // record or restore this draft in a fresh window.
      if (savedDraftRef.current.id) await saveDraftSnapshot(false, {
        ...currentStoredState,
        draft: nextDraft,
        materialText: currentInput.rawMaterial,
        materialFiles: currentInput.files,
        materialLinks: currentInput.links,
        materialAnalysis: analysis,
        materialAnalysisStale: false,
        selectedMaterialTypeId: asString(selection.materialTypeId) || analysis.recommendedTypeId,
        selectedMaterialStructureId: asString(selection.structureId) || analysis.recommendedStructureId,
        topicResearch: undefined,
        topicResearchInputFingerprint: '',
        researchSubview: 'samples',
        reviewAssertions: { ...EMPTY_REVIEW_ASSERTIONS },
        approvalModes: { ...EMPTY_APPROVAL_MODES },
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '本期素材分析失败' });
    } finally {
      setBusyAction(null);
    }
  }, [
    agentRunning,
    busyAction,
    createTemporaryMaterialRun,
    currentStoredState,
    draft,
    materialFiles,
    materialLinks,
    materialText,
    saveDraftSnapshot,
  ]);

  const startTikOmniResearch = useCallback(async () => {
    const runId = draft.runId;
    const runSlug = draft.runSlug;
    if (!runId || !runSlug || !materialAnalysis || materialAnalysisStale || busyAction || agentRunning) return;
    if (draft.writingMode === 'author_material' && modelSetupMessage(config)) {
      setNotice({ tone: 'warning', text: '生成方案前，请先保存草稿并连接写作服务。已整理的素材和题目会保留。' });
      return;
    }
    const effectiveTypeId = selectedMaterialTypeId || materialAnalysis.recommendedTypeId;
    const effectiveStructureId = selectedMaterialStructureId || materialAnalysis.recommendedStructureId;
    setBusyAction('material-boundary');
    setNotice(null);
    try {
      if (materialSelectionTimer.current !== null) {
        window.clearTimeout(materialSelectionTimer.current);
        materialSelectionTimer.current = null;
      }
      // New analyses already persist the system's provisional direction. This
      // checked write remains only as a compatibility fallback for older runs.
      const currentInput = {
        rawMaterial: materialText,
        files: materialFiles,
        links: materialLinks,
      };
      const inputFingerprint = await createMaterialInputFingerprint(currentInput);
      const selectionKey = [runId, inputFingerprint, effectiveTypeId, effectiveStructureId].join('|');
      if (materialPersistedSelectionRef.current !== selectionKey) {
        setNotice({ tone: 'success', text: '正在准备素材，请稍候…' });
        const selectionResponse = await fetch('/api/production/material-analysis', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId,
            expectedInputFingerprint: inputFingerprint,
            selectedTypeId: effectiveTypeId,
            selectedStructureId: effectiveStructureId,
          }),
        });
        const selectionPayload = await selectionResponse.json().catch(() => ({})) as Record<string, unknown>;
        if (!selectionResponse.ok) throw new Error(asString(selectionPayload.error) || '素材准备失败');
        const selectionContext = asRecord(selectionPayload.context);
        if (
          asString(selectionContext.inputFingerprint) !== inputFingerprint
          || asString(selectionContext.analysisStatus) !== 'current'
          || asString(asRecord(selectionContext.selection).materialTypeId) !== effectiveTypeId
          || asString(asRecord(selectionContext.selection).structureId) !== effectiveStructureId
        ) {
          throw new Error('素材判断没有准备完成。请重新整理素材后，再查看同类内容。');
        }
        materialServerFingerprintRef.current = inputFingerprint;
        setMaterialServerIdentity({ runId, fingerprint: inputFingerprint });
        materialPersistedSelectionRef.current = selectionKey;
      }
      materialDirectionDirtyRef.current = false;

      const platformResponse = await fetch('/api/run', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          platforms: draft.selectedPlatforms,
          confirm: true,
        }),
      });
      const platformPayload = await platformResponse.json().catch(() => ({})) as Record<string, unknown>;
      if (!platformResponse.ok) throw new Error(asString(platformPayload.error) || '本期平台确认失败');

      const ownTopic = draft.writingMode === 'author_material';
      if (ownTopic && !draft.topic.trim()) throw new Error('请填写这期想写的题目。');
      if (ownTopic && materialCorrectionSeenRef.current.runId !== runId) throw new Error('请重新读取并核对素材后继续。');
      await submitProductionTask(ownTopic ? 'author-blueprint' : 'material-research', {
        ...(ownTopic ? { topic: draft.topic, templateId: draft.template, reviewedMaterialCorrectionId: materialCorrectionSeenRef.current.id, reviewedAnalysisSha256: await authorAnalysisFingerprint(materialCorrectionSeenRef.current.analysis) } : {}),
        slug: runSlug,
        rawMaterial: materialText,
        files: materialFiles,
        links: materialLinks,
        selectedTypeId: effectiveTypeId,
        selectedStructureId: effectiveStructureId,
        platforms: draft.selectedPlatforms,
        inputFingerprint,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: displayResearchMessage(error instanceof Error ? error.message : '', '同类内容获取失败') });
    } finally {
      setBusyAction(null);
    }
  }, [
    agentRunning,
    busyAction,
    config,
    draft.runId,
    draft.runSlug,
    draft.selectedPlatforms,
    draft.writingMode,
    draft.topic,
    draft.template,
    materialAnalysis,
    materialAnalysisStale,
    materialFiles,
    materialLinks,
    materialText,
    selectedMaterialStructureId,
    selectedMaterialTypeId,
    submitProductionTask,
  ]);

  const loadTopicSuggestions = useCallback(() => {
    setResearchSubview('topics');
    setSuggestionsReadRevision((value) => value + 1);
  }, []);

  const suggestionsSnapshotPath = topicResearch?.snapshotPath || '';
  const suggestionsSnapshotSha256 = topicResearch?.snapshotSha256 || '';
  const hasWritingPlan = Boolean(draft.artifactPaths['topic-template']);
  useEffect(() => {
    if (activeStage !== 'topic-template' || researchSubview !== 'topics' || hasWritingPlan
      || !draft.runId || !suggestionsSnapshotPath || !topicResearchContextVerified) return;
    const controller = new AbortController();
    const runId = draft.runId;
    void readSavedTopicSuggestions({ runId, snapshotPath: suggestionsSnapshotPath,
      snapshotSha256: suggestionsSnapshotSha256 }, controller.signal).then((suggestions) => {
      if (controller.signal.aborted || materialChangedRef.current || materialRunRef.current !== runId) return;
      setTopicSuggestions(suggestions);
      setSuggestionsReadState({ key: suggestionsReadKey, error: '' });
      // Reading saved work must never change a title or invalidate approvals.
      // Only an empty, as-yet-unselected topic receives the first suggestion.
      setDraft((current) => current.runId === runId && !current.topic.trim() && suggestions[0]
        ? { ...current, topic: suggestions[0].title } : current);
    }).catch(() => {
      if (!controller.signal.aborted) setSuggestionsReadState({ key: suggestionsReadKey, error: '选题建议暂时没有读出。已保存的参考和标题仍保留，请重新读取建议；这不会重新采集。' });
    });
    return () => controller.abort();
  }, [activeStage, researchSubview, hasWritingPlan, draft.runId, suggestionsSnapshotPath,
    suggestionsSnapshotSha256, topicResearchContextVerified, suggestionsReadKey]);

  const selectTopicSuggestion = useCallback((suggestionId: string) => {
    const selected = topicSuggestions.find((suggestion) => suggestion.id === suggestionId);
    if (!selected) return;
    setDraft((current) => invalidateApprovalsFrom({ ...current, topic: selected.title }, 'topic-template'));
    setApprovalModes((current) => {
      const next = { ...current };
      for (const stage of PRODUCTION_STAGES.slice(1)) next[stage.id] = null;
      return next;
    });
    setReviewAssertions((current) => ({
      ...current,
      market_evidence_reviewed: false,
      topic_boundary_and_goal_confirmed: false,
      brand_template_confirmed: false,
    }));
  }, [topicSuggestions]);

  const confirmTopicAndBuildBlueprint = useCallback(async () => {
    const intakePath = draft.artifactPaths['material-boundary'];
    if (!draft.runId || !draft.runSlug || !intakePath || !topicResearch || !topicResearchContextVerified || !draft.topic.trim() || busyAction || agentRunning) return;
    if (!brandTemplates.some((template) => template.id === draft.template)) {
      setNotice({ tone: 'warning', text: '请先选择一个已启用的排版样式。' });
      return;
    }
    setBusyAction('topic-template');
    setNotice(null);
    try {
      const topicAssertions: ProductionReviewAssertions = {
        ...reviewAssertions,
        market_evidence_reviewed: true,
        topic_boundary_and_goal_confirmed: true,
        brand_template_confirmed: true,
      };
      await submitProductionTask('topic-blueprint', {
        intakePath,
        reportPath: topicResearch.reportPath,
        snapshotPath: topicResearch.snapshotPath,
        snapshotSha256: topicResearch.snapshotSha256,
        topic: draft.topic.trim(),
        templateId: draft.template,
        ...(selectedTopicSuggestionId ? { suggestionId: selectedTopicSuggestionId } : {}),
        reviewAssertions: topicAssertions,
        platforms: draft.selectedPlatforms,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '选题和排版样式保存失败' });
    } finally {
      setBusyAction(null);
    }
  }, [
    agentRunning,
    brandTemplates,
    busyAction,
    draft,
    reviewAssertions,
    selectedTopicSuggestionId,
    submitProductionTask,
    topicResearch,
    topicResearchContextVerified,
  ]);

  const saveWritingBrief = useCallback((path: string) => {
    setDraft((current) => {
      if (current.runId !== draft.runId) return current;
      return applySavedWritingBrief(current, path);
    });
    setContentReviewReady(false);
    setDeliverableReviewReady(false);
    setPublicationQueue(null);
    setVisualWorkbench(null);
    setReviewAssertions({});
    setApprovalModes((current) => {
      const next = { ...current };
      for (const stage of PRODUCTION_STAGES.slice(1)) next[stage.id] = null;
      return next;
    });
  }, [draft.runId]);

  const materialCorrected = useCallback((context: MaterialAnalysisContext) => {
    if (context.runId !== draft.runId) return;
    setMaterialAnalysis(context.analysis);
    materialServerFingerprintRef.current = context.inputFingerprint;
    setMaterialServerIdentity({ runId: context.runId, fingerprint: context.inputFingerprint });
    materialCorrectionSeenRef.current = { runId: context.runId, id: context.correctionId || '', analysis: context.analysis };
    setMaterialAnalysisStale(false);
    saveWritingBrief(draft.artifactPaths['topic-template'] || '');
    setContentPlanReview({ key: '', ready: false, sha256: '', correctionId: '' });
    approvalRequestIdsRef.current = {};
    setNotice({ tone: 'success', text: '素材修正已保存。已有参考与旧稿保留，请重新核对方案后继续。' });
    void refreshRuntime();
  }, [draft.runId, draft.artifactPaths, saveWritingBrief, refreshRuntime]);

  const confirmWritingBrief = useCallback(async () => {
    const result = await refreshRuntime();
    if (!result.ok || result.approvals['topic-template'] !== true) throw new Error('方案确认尚未读回，请刷新后重试。');
    setActiveStage('content-package');
    syncStageToUrl('content-package');
    setNotice({ tone: 'success', text: '方案已确认。现在可以生成正文。' });
  }, [refreshRuntime]);

  const acceptContentVersion = useCallback((path: string) => {
    setRecoveredContent(null);
    setContentReviewReady(false);
    setDeliverableReviewReady(false);
    setReviewAssertions((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [
      key, key.startsWith('content_') || ['platform_payloads_reviewed', 'visual_order_reviewed'].includes(key) ? false : value,
    ])) as ProductionReviewAssertions);
    setDraft((current) => {
      if (current.runId !== draft.runId) return current;
      const next = invalidateApprovalsFrom(current, 'content-package');
      const paths = { ...next.artifactPaths, 'content-package': path };
      for (const stage of PRODUCTION_STAGES.slice(3)) delete paths[stage.id];
      return { ...next, artifactPaths: paths };
    });
    setApprovalModes((current) => {
      const next = { ...current };
      for (const stage of PRODUCTION_STAGES.slice(2)) next[stage.id] = null;
      return next;
    });
    setPublicationQueue(null);
    setVisualWorkbench(null);
    setActiveStage('content-package');
    syncStageToUrl('content-package');
    setNotice({ tone: 'success', text: '已读取当前稿件版本。请重新核对正文，确认后再制作发布成品。' });
  }, [draft.runId]);

  const runContentPackage = useCallback(async () => {
    const blueprintPath = draft.artifactPaths['topic-template'];
    if (!draft.runId || !draft.runSlug || !blueprintPath || !canAdvanceStage(draft, 'content-package') || busyAction || agentRunning) return;
    setBusyAction('content-package');
    setNotice(null);
    try {
      await submitProductionTask('content-package', {
        slug: draft.runSlug,
        topic: draft.topic,
        blueprintPath,
        platforms: draft.selectedPlatforms,
      });
      setContentReviewReady(false);
      setReviewAssertions((current) => ({
        ...current,
        content_article_reviewed: false,
        content_video_1_reviewed: false,
        content_video_2_reviewed: false,
        content_opinion_1_reviewed: false,
        content_opinion_2_reviewed: false,
        content_opinion_3_reviewed: false,
      }));
      setDraft((current) => invalidateApprovalsFrom(current, 'content-package'));
      setApprovalModes((current) => {
        const next = { ...current };
        for (const stage of PRODUCTION_STAGES.slice(2)) next[stage.id] = null;
        return next;
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '全部内容生成失败' });
    } finally {
      setBusyAction(null);
    }
  }, [agentRunning, busyAction, draft, submitProductionTask]);

  const prepareDraftQueue = useCallback(async () => {
    const packagePath = draft.artifactPaths['content-package'];
    if (!packagePath || busyAction) return;
    setBusyAction('draft-information');
    setNotice(null);
    try {
      await submitProductionTask('draft-queue', { packagePath });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '整理发布成品失败' });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, draft.artifactPaths, submitProductionTask]);

  const fillLocalDraft = useCallback(async (jobId: string) => {
    const queuePath = draft.artifactPaths['draft-information'];
    if (!queuePath || !draft.runId || busyAction) return;
    setBusyAction('publication-result');
    setNotice(null);
    try {
      const job = publicationQueue?.jobs.find((item) => item.job_id === jobId);
      if (!job) throw new Error('当前发布内容中找不到这一项。请重新整理发布成品。');
      if (!job.payload_hash) throw new Error('这一项缺少内容版本，请重新整理发布成品。');
      const desktopResult = await fillDraftWithDesktopBridge({
        queuePath,
        runId: draft.runId,
        jobId: job.job_id,
        expectedPayloadHash: job.payload_hash,
      });
      if (desktopResult?.queue) {
        const queue = desktopResult.queue as ProductionDraftQueue;
        setPublicationQueue(queue);
        const updated = queue.jobs.find((item) => item.job_id === jobId);
        const needsAttention = updated?.status === 'retryable_failure'
          || updated?.status === 'manual_intervention_required'
          || updated?.status === 'unknown_completion';
        setNotice({
          tone: needsAttention ? 'warning' : 'success',
          text: needsAttention
            ? '这一项还没有准备好。请按提示处理后重试；系统没有发布任何内容。'
            : '草稿已填入平台编辑器，尚未发布。',
        });
        return;
      }
      const action = canExplicitlyRetryLocalDraft(job) ? 'retry' : 'execute';
      const response = await fetch('/api/publish/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, queuePath, runId: draft.runId, jobIds: [jobId] }),
      });
      const data = await response.json().catch(() => ({})) as { queue?: ProductionDraftQueue; error?: string };
      if (!response.ok || !data.queue) throw new Error(data.error || '草稿填入失败');
      setPublicationQueue(data.queue);
      setNotice({ tone: 'success', text: '草稿已更新，未向任何平台发布。' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '草稿填入失败' });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, draft.artifactPaths, draft.runId, publicationQueue]);

  const fillQueuedDrafts = useCallback(async () => {
    const queuePath = draft.artifactPaths['draft-information'];
    const startingQueue = publicationQueue;
    if (!queuePath || !draft.runId || busyAction || !startingQueue || !hasQueuedLocalDrafts(startingQueue)) return;
    setBusyAction('publication-result');
    setNotice(null);
    try {
      if (hasDesktopPublicationBridge()) {
        let nextQueue = startingQueue;
        let attempted = 0;
        for (const original of startingQueue.jobs) {
          const job = nextQueue?.jobs.find((item) => item.job_id === original.job_id);
          if (!job || (job.status !== 'pending' && job.status !== 'retryable_failure')) continue;
          if (!job.payload_hash) throw new Error('这一项缺少内容版本，请重新整理发布成品。');
          const desktopResult = await fillDraftWithDesktopBridge({
            queuePath,
            runId: draft.runId,
            jobId: job.job_id,
            expectedPayloadHash: job.payload_hash,
          });
          if (!desktopResult?.queue) throw new Error('草稿准备结果不完整，请重试。');
          nextQueue = desktopResult.queue as ProductionDraftQueue;
          attempted += desktopResult.attemptedJobIds?.length || 1;
          setPublicationQueue(nextQueue);
        }
        const retryable = nextQueue?.jobs.filter((job) => job.status === 'retryable_failure').length || 0;
        const attention = nextQueue?.jobs.filter((job) => job.status === 'manual_intervention_required' || job.status === 'unknown_completion').length || 0;
        setNotice({
          tone: retryable || attention ? 'warning' : 'success',
          text: retryable || attention
            ? `已处理 ${attempted} 项；${retryable} 项可重试、${attention} 项需要你检查，其余项目继续。未自动发布任何内容。`
            : `已填入 ${attempted} 项草稿，未向任何平台发布。`,
        });
        return;
      }
      const response = await fetch('/api/publish/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Omitting jobIds deliberately lets the queue runner continue through
        // every pending/retryable item, even after an earlier local failure.
        body: JSON.stringify({ action: 'execute', queuePath, runId: draft.runId }),
      });
      const data = await response.json().catch(() => ({})) as {
        queue?: ProductionDraftQueue;
        attemptedJobIds?: string[];
        error?: string;
      };
      if (!response.ok || !data.queue) throw new Error(data.error || '批量填入草稿失败');
      setPublicationQueue(data.queue);
      const attempted = data.attemptedJobIds?.length || 0;
      const retryable = data.queue.jobs.filter((job) => job.status === 'retryable_failure').length;
      setNotice({
        tone: retryable ? 'warning' : 'success',
        text: retryable
          ? `已连续处理 ${attempted} 项；${retryable} 项失败并保留为可重试，其余任务已继续。`
          : `已处理 ${attempted} 项草稿，未向任何平台发布。`,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '批量填入草稿失败' });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, draft.artifactPaths, draft.runId, publicationQueue]);

  const savePublicationResult = useCallback(async (jobId: string) => {
    const queuePath = draft.artifactPaths['draft-information'];
    const input = publicationInputs[jobId];
    if (!queuePath || !input?.confirmed || !input.publishedAt || (!input.url.trim() && !input.proofPath.trim()) || busyAction) return;
    setBusyAction('publication-result');
    setNotice(null);
    try {
      const publishedAt = new Date(input.publishedAt);
      if (Number.isNaN(publishedAt.getTime())) throw new Error('发布时间不正确。');
      const response = await fetch('/api/publish/results', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queuePath,
          jobId,
          humanConfirmed: true,
          ...(input.url.trim() ? { publicationUrl: input.url.trim() } : {}),
          ...(input.proofPath.trim() ? { proofPath: input.proofPath.trim() } : {}),
          publishedAt: publishedAt.toISOString(),
          unknownCompletionResolved: input.unknownCompletionResolved,
        }),
      });
      const data = await response.json().catch(() => ({})) as { queue?: ProductionDraftQueue; error?: string };
      if (!response.ok || !data.queue) throw new Error(data.error || '保存发布结果失败');
      setPublicationQueue(data.queue);
      setPublicationInputs((current) => ({
        ...current,
        [jobId]: { ...input, confirmed: false },
      }));
      await refreshRuntime();
      setNotice({ tone: 'success', text: '发布记录已保存到当前内容。' });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '保存发布结果失败' });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, draft.artifactPaths, publicationInputs, refreshRuntime]);

  const generateVisualAssets = useCallback(async (regenerate = false) => {
    const slug = draft.runSlug;
    const packagePath = draft.artifactPaths['content-package'];
    if (!slug || !packagePath || busyAction) {
      setNotice({ tone: 'warning', text: '请先确认全部内容，再生成平台完整发布件。' });
      return;
    }
    setBusyAction('visual-assets');
    setVisualLoading(true);
    setNotice(null);
    try {
      await submitProductionTask('visual-candidates', {
        slug,
        packagePath,
        visualPreferences: DEFAULT_VISUAL_PREFERENCES,
        ...(regenerate ? { regenerate: true } : {}),
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '平台完整发布件生成失败' });
    } finally {
      setVisualLoading(false);
      setBusyAction(null);
    }
  }, [busyAction, draft.artifactPaths, draft.runSlug, submitProductionTask]);

  const requestVisualRevision = useCallback(async (request: string, assetIds: string[], baseRevisionId: string) => {
    const state = visualWorkbench;
    if (!state || busyAction) throw new Error('当前没有可修改的平台成品。');
    setBusyAction('visual-assets');
    setNotice(null);
    try {
      const response = await fetch('/api/visual/revise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: state.slug, request, targetAssetIds: assetIds, baseRevisionId }),
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(asString(data.error) || asString(data.reason) || '平台成品修改失败');
      await refreshVisualWorkbench(state.slug);
      setNotice({ tone: 'success', text: assetIds.length === 1 ? '这一项已修改，请查看后确认。' : '这套成品已修改，请查看后确认。' });
      return asString(data.revisionId) || undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : '平台成品修改失败';
      setNotice({ tone: 'error', text: message });
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, refreshVisualWorkbench, visualWorkbench]);

  const adoptVisualAsset = useCallback(async (revisionId: string, assetId: string) => {
    const state = visualWorkbench;
    if (!state || busyAction) throw new Error('当前没有可以选择的配图。');
    setBusyAction('visual-assets');
    setNotice(null);
    try {
      const response = await fetch('/api/visual/adopt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: state.slug, revisionId, assetId }),
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(asString(data.error) || '选择配图失败');
      const manifestPath = asString(data.manifestPath);
      if (manifestPath) {
        setDraft((current) => ({
          ...current,
          artifactPaths: { ...current.artifactPaths, 'visual-assets': manifestPath },
        }));
      }
      // The adoption response already carries the signed-off manifest. Apply
      // it locally so each visual decision is one write, not one write plus a
      // full candidate scan with file-integrity checks for every asset.
      const nextVisualState = applyAdoptedVisualManifest(state, data);
      if (nextVisualState) setVisualWorkbench(nextVisualState);
      else await refreshVisualWorkbench(state.slug);
      const ready = asRecord(data.ready).valid === true;
      setNotice({
        tone: 'success',
        text: ready ? '所有配图都已确认，可以继续下一步。' : '这张配图已选择，请继续确认其余配图。',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '选择配图失败';
      setNotice({ tone: 'error', text: message });
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, refreshVisualWorkbench, visualWorkbench]);

  const adoptAllVisualAssets = useCallback(async (revisionId: string, assetIds: string[], reconfirm = false) => {
    const state = visualWorkbench;
    if (!state || busyAction) throw new Error('当前没有可以选择的配图。');
    if (!assetIds.length) return;
    setBusyAction('visual-assets');
    setNotice(null);
    try {
      const response = await fetch('/api/visual/adopt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: state.slug, revisionId, assetIds, ...(reconfirm ? { reconfirmSelection: {
          selectionSha256: state.adoptedAssetManifest?.selectionSha256,
          sourceContentHash: state.adoptedAssetManifest?.sourceContentHash,
        } } : {}) }),
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(asString(data.error) || '选择配图失败');
      const manifestPath = asString(data.manifestPath);
      if (manifestPath) {
        setDraft((current) => ({
          ...current,
          artifactPaths: { ...current.artifactPaths, 'visual-assets': manifestPath },
        }));
      }
      const nextVisualState = applyAdoptedVisualManifest(state, data);
      if (nextVisualState) setVisualWorkbench(nextVisualState);
      else await refreshVisualWorkbench(state.slug);
      const ready = asRecord(data.ready).valid === true;
      setNotice({
        tone: 'success',
        text: ready ? '所有配图都已确认，可以继续下一步。' : `已选择 ${assetIds.length} 张配图，请继续确认其余配图。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '选择配图失败';
      setNotice({ tone: 'error', text: message });
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, refreshVisualWorkbench, visualWorkbench]);

  const confirmStage = useCallback(async () => {
    const stage = getProductionStageMeta(activeStage);
    const materialReady = Boolean(draft.artifactPaths['material-boundary']);
    const draftQueueReady = hasCompleteFinalDeliverables(publicationQueue);
    const publicationQueueComplete = isPublicationQueueComplete(publicationQueue);
    const confirmationReviewAssertions: ProductionReviewAssertions = activeStage === 'draft-information'
      ? {
        ...reviewAssertions,
        platform_payloads_reviewed: true,
        visual_order_reviewed: true,
        human_send_boundary_confirmed: true,
      }
      : reviewAssertions;
    const canConfirm = stageCanConfirm(
      activeStage,
      draft,
      notes[activeStage],
      visualWorkbench?.hasExplicitAssetSelection === true && visualWorkbench?.hasCompleteAssetSelection === true,
      contentReviewReady,
      materialReady,
      draftQueueReady,
      deliverableReviewReady,
      publicationQueueComplete,
      confirmationReviewAssertions,
      topicResearchContextVerified ? topicResearch : null,
    );
    if (!canAdvanceStage(draft, activeStage) || !canConfirm || busyAction || (activeStage === 'content-package' && !contentPlanReady)) return;
    if (activeStage === 'topic-template' && !brandTemplates.some((template) => template.id === draft.template)) {
      setNotice({ tone: 'warning', text: '请先在设置中启用并选择一个排版样式。' });
      return;
    }
    setBusyAction(activeStage);
    setNotice(null);

    try {
      const artifactPath = draft.artifactPaths[activeStage];
      let confirmationMode: ApprovalMode = 'local';

      if (requiresServerApproval(activeStage)) {
        if (!draft.runId) throw new Error('请先开始本期内容');
        if (!artifactPath) throw new Error('当前结果还在准备中，请稍候再确认');
        const response = await fetch('/api/production/advance', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stage: activeStage,
            runId: draft.runId,
            requestId: approvalRequestIdForStage(approvalRequestIdsRef.current, activeStage),
            artifactPath,
            ...(activeStage === 'content-package' ? { reviewedMaterialCorrectionId: contentPlanReview.correctionId } : {}),
            ...(activeStage === 'content-package' && contentPlanReady && contentPlanReview.sha256 ? { reviewedPlanSha256: contentPlanReview.sha256 } : {}),
            ...(activeStage === 'topic-template' ? { templateId: draft.template } : {}),
            ...(isProductionReviewStage(activeStage) ? { reviewAssertions: confirmationReviewAssertions } : {}),
            ...(activeStage === 'draft-information' || activeStage === 'publication-result'
              ? { queuePath: draft.artifactPaths['draft-information'] }
              : {}),
          }),
        });
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok || data.advanced !== true) {
          if (asString(data.repairedPath)) await refreshRuntime();
          throw new Error(asString(data.error) || asString(data.reason) || '当前结果还不能确认');
        }
        confirmationMode = 'server';
        const verification = await refreshRuntime();
        if (!verification.ok || verification.approvals[activeStage] !== true) {
          throw new Error('确认已接收，但进度还没有更新。请刷新页面后重试。');
        }
      }

      setDraft((current) => ({
        ...current,
        approved: { ...current.approved, [activeStage]: true },
      }));
      delete approvalRequestIdsRef.current[activeStage];
      setApprovalModes((current) => ({ ...current, [activeStage]: confirmationMode }));
      if (activeStage === 'draft-information') setReviewAssertions(confirmationReviewAssertions);
      const next = PRODUCTION_STAGES.find((candidate) => (
        candidate.number > stage.number && isProductionStageApplicable(draft, candidate.id)
      ));
      if (next) {
        setActiveStage(next.id);
        syncStageToUrl(next.id);
      }
      setNotice({
        tone: confirmationMode === 'server' ? 'success' : 'warning',
        text: confirmationMode === 'server' ? '已保存本次确认' : '已保存',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '确认失败' });
    } finally {
      setBusyAction(null);
    }
  }, [activeStage, brandTemplates, busyAction, contentReviewReady, contentPlanReady, contentPlanReview.sha256, contentPlanReview.correctionId, deliverableReviewReady, draft, notes, publicationQueue, refreshRuntime, reviewAssertions, topicResearch, topicResearchContextVerified, visualWorkbench]);

  const currentStage = getProductionStageMeta(activeStage);
  const currentNote = notes[activeStage];
  const hasSelectedBrandTemplate = brandTemplates.some((template) => template.id === draft.template);
  const materialReady = Boolean(draft.artifactPaths['material-boundary']);
  const draftQueueReady = hasCompleteFinalDeliverables(publicationQueue);
  const publicationQueueComplete = isPublicationQueueComplete(publicationQueue);
  const currentApprovalReady = isApprovalTargetReady(activeStage, draft.runId, draft.artifactPaths[activeStage]);
  const currentStageApplicable = isProductionStageApplicable(draft, activeStage);
  const currentCanConfirm = currentStageApplicable && canAdvanceStage(draft, activeStage) && currentApprovalReady
    && (activeStage !== 'content-package' || contentPlanReady)
    && (activeStage !== 'topic-template' || hasSelectedBrandTemplate)
    && stageCanConfirm(
      activeStage,
      draft,
      currentNote,
      visualWorkbench?.hasExplicitAssetSelection === true && visualWorkbench?.hasCompleteAssetSelection === true,
      contentReviewReady,
      materialReady,
      draftQueueReady,
      deliverableReviewReady,
      publicationQueueComplete,
      reviewAssertions,
      topicResearchContextVerified ? topicResearch : null,
    );
  const currentUnlocked = canAdvanceStage(draft, activeStage);
  const currentReadable = canViewProductionStage(draft, activeStage);
  const requiredStage = resumableProductionStage(draft);
  const restoringCurrentRun = Boolean(draft.runId) && (runtimeHydrating || materialContextHydrating || restoringSavedStage);
  useEffect(() => {
    if (restoringCurrentRun || lastVisibleStageRef.current === activeStage) return;
    lastVisibleStageRef.current = activeStage;
    const content = stageContentRef.current;
    if (!content) return;
    // Only a stage change moves focus. Polling, saves and edits within an
    // article leave the reader's position alone.
    content.focus({ preventScroll: true });
    content.scrollIntoView({ behavior: 'instant', block: 'start' });
  }, [activeStage, restoringCurrentRun]);
  const productionTaskRunning = Boolean(activeTask && (activeTask.status === 'queued' || activeTask.status === 'running'));
  const taskPanelTask = toTaskPanelTask(activeTask, Boolean(
    recoveredContent && recoveredContent.runId === draft.runId && recoveredContent.taskId === activeTask?.taskId
    && recoveredContent.packagePath === draft.artifactPaths['content-package'] && draft.approved['content-package']
    && activeTask?.kind === 'content-package' && ['blocked', 'failed'].includes(activeTask.status)
  ));
  const interactionBusy = Boolean(busyAction) || agentRunning || productionTaskRunning;
  const requiredStages = useMemo(() => requiredProductionStages(draft), [draft]);
  const requiredStageCount = requiredStages.length;
  const completedRequiredCount = useMemo(
    () => requiredStages.filter((stage) => draft.approved[stage.id]).length,
    [draft.approved, requiredStages],
  );
  const researchView = useMemo(
    () => prepareTikOmniSamples(researchSamples, researchFilters, researchSort),
    [researchFilters, researchSamples, researchSort],
  );

  const selectStage = (stageId: ProductionStageId) => {
    if (!isProductionStageApplicable(draft, stageId)) {
      setNotice({ tone: 'warning', text: '本期只做视频号，不需要进入平台排版阶段。' });
      return;
    }
    if (!canViewProductionStage(draft, stageId)) {
      setNotice({ tone: 'warning', text: '请先完成上一阶段' });
      return;
    }
    setActiveStage(stageId);
    syncStageToUrl(stageId);
  };

  const runCreativeEnhancement = useCallback(async (enhancement: CreativeEnhancement) => {
    const stage = enhancementStage;
    if (!config) throw new Error('请先在设置中完成生成服务配置。');
    if (!stage || (stage !== 'topic-template' && stage !== 'content-package')) {
      throw new Error('请先进入可以运行专项检查的步骤。');
    }
    if (!draft.runId || !draft.projectId || !draft.runSlug) {
      throw new Error('请先开始本期内容。');
    }
    const sourcePath = stage === 'topic-template'
      ? draft.artifactPaths['material-boundary']
      : draft.artifactPaths['content-package'];
    const result = await invokeAgent(enhancement.tool, {
      runtimeStep: 'dbs-fusion',
      runId: draft.runId,
      projectId: draft.projectId,
      stage,
      topic: draft.topic,
      sourcePath: sourcePath || '',
      question: enhancement.prompt,
      instruction: '这是一次本期创作增强。不要停在追问或流程说明；请基于给出的主题和可读取材料，直接给出可采用的简洁结论、边界与下一步。',
      slug: draft.runSlug,
    }, config);
    return { output: result.output, savedPath: result.savedPath };
  }, [config, draft, enhancementStage, invokeAgent]);

  const adoptCreativeEnhancement = useCallback(async (
    enhancement: CreativeEnhancement,
    result: { output: string; savedPath: string },
  ) => {
    const stage = enhancementStage;
    if (!stage || !draft.runId || !draft.projectId) throw new Error('本期内容还没有准备好。');
    const response = await fetch('/api/creative-enhancements/adopt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: draft.runId,
        projectId: draft.projectId,
        stage,
        tool: enhancement.tool,
        sourcePath: result.savedPath,
        adoptedText: result.output,
      }),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(asString(data.error) || '保存专项检查结果失败。');
    setEnhancementStage(null);
    setNotice({ tone: 'success', text: '专项检查结果已用于本期，后续生成提纲和内容时会一起参考。' });
  }, [draft.projectId, draft.runId, enhancementStage]);

  const readingContent = activeStage === 'content-package' && Boolean(draft.artifactPaths['content-package']);

  return (
    <div className={`aifios-editorial-page aifios-production-workbench mx-auto flex w-full max-w-[1580px] flex-col ${readingContent ? 'is-reading-content' : ''} gap-3`}>
      <section style={{ minHeight: 44 }} className="aifios-production-intro flex flex-col gap-5 px-1 pt-1 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="aifios-production-intro-mark mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg">
            <Workflow size={21} strokeWidth={1.9} />
          </div>
          <div className="min-w-0">
            <h1 className="mt-1 text-[30px] font-bold leading-[1.2]">{PRODUCT_COPY.pages.production.title}</h1>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            materialContextLoaded.current = '';
            setMaterialReadRevision((value) => value + 1);
            void refreshRuntime();
          }}
          disabled={interactionBusy}
          aria-label="刷新本期进度"
          title="刷新本期进度"
          className="aifios-production-refresh inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border disabled:opacity-50"
        >
          {interactionBusy ? <LoaderCircle size={18} className="animate-spin" /> : <RefreshCw size={18} />}
        </button>
      </section>

      <ProductionDraftShelf compact currentDraftId={savedDraftId} currentRunId={draft.runId} name={draftName} onNameChange={setDraftName} busy={interactionBusy || restoringCurrentRun} hasContent={hasDraftContent} refreshKey={draftShelfRevision} onSave={saveDraftSnapshot} onOpen={openSavedDraft} onNew={startNewMaterialPeriod}
        recoverable={recoverableDraft && !hasDraftContent ? { topic: recoverableDraft.topic, onResume: resumePreviousPeriod } : undefined} />

      {(activeStage === 'material-boundary' || activeStage === 'topic-template') && (
        <ProductionSetupChecklist config={config} onRefresh={refreshConfig} writingMode={draft.writingMode} />
      )}

      <div aria-label="本期进度" className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-[#6B6B6B]">
        <span>{restoringCurrentRun ? '正在恢复本期进度' : `已确认 ${completedRequiredCount}/${requiredStageCount} 个必选步骤${readingContent && !currentUnlocked ? ' · 正在查看旧稿' : ''}`}</span>
        <button type="button" aria-expanded={showStageRail} aria-controls="production-stage-navigation" onClick={() => setShowStageRail((visible) => !visible)} className="min-h-10 rounded-md border border-[#E5DDD6] bg-white px-3 text-xs font-semibold hover:bg-[#F7F3EE] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#52790C]">
          {showStageRail ? '收起制作步骤' : '显示制作步骤'}
        </button>
        {draft.runId && <a href="#current-service-calls" className="underline">本期调用记录</a>}
        {lastSavedAt && <span>本机草稿已保存 · <time dateTime={lastSavedAt}>{new Date(lastSavedAt).toLocaleTimeString('zh-CN')}</time></span>}
      </div>

      {!restoringCurrentRun && <MaterialDisclosureNotice risks={materialAnalysis?.risks} stale={materialAnalysisStale} onReview={() => selectStage('material-boundary')} />}

      <section className="aifios-production-surface overflow-hidden rounded-xl border">
        {notice && !taskPanelCoversNotice({ noticeTaskId: notice.taskId, task: activeTask, stageId: activeStage, taskPanelVisible: !restoringCurrentRun }) && (
          <div className={`flex items-start gap-2 border-b px-5 py-3 text-[12px] sm:px-6 ${
            notice.tone === 'error'
              ? 'border-[#F1C4BD] bg-[#FFF1EE] text-[#B43C2E]'
              : notice.tone === 'warning'
                ? 'border-[#F2D7A7] bg-[#FFF8E8] text-[#8D5A00]'
                : 'border-[#C6E6CF] bg-[#EDF8F0] text-[#16803C]'
          }`}>
            {notice.tone === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <CircleAlert size={16} className="mt-0.5 shrink-0" />}
            <span>{displayProductionNotice(notice.text)}</span>
          </div>
        )}
        <div className={`grid min-h-[610px] grid-cols-1 ${showStageRail ? 'xl:grid-cols-[minmax(0,1fr)_292px]' : ''}`}>
          <div ref={stageContentRef} tabIndex={-1} aria-label={`当前步骤：${activeStage === 'topic-template' && draft.writingMode === 'author_material' ? '核对写作方案' : currentStage.label}`} className="order-2 min-w-0 scroll-mt-24 xl:order-1">
            {!restoringCurrentRun && !currentUnlocked && activeTask && <div className="p-5">
              <ProductionTaskPanel
                runId={draft.runId} task={taskPanelTask!} recovered={taskRecovered}
                currentStageId={activeStage} modelSetupIssue={modelSetupMessage(config)}
                onRetry={(mode) => void retryActiveProductionTask(mode)}
                onReturnToTaskStage={() => {
                  const stage = productionTaskStage(activeTask.kind, activeTask.currentStep);
                  setActiveStage(stage); syncStageToUrl(stage);
                }}
              />
            </div>}
            {restoringCurrentRun ? (
              <div className="flex min-h-[440px] flex-col items-center justify-center px-6 text-center" role="status" aria-live="polite">
                <LoaderCircle size={24} className="animate-spin text-[#E85D4C]" />
                <h2 className="mt-4 text-[17px] font-bold text-[#1A1A1A]">正在恢复本期进度</h2>
                <p className="mt-2 max-w-[420px] text-[13px] leading-[1.65] text-[#6B6B6B]">正在读取已确认的内容、配图和发布记录。</p>
              </div>
            ) : currentUnlocked ? (
            <ProductionStagePanel
              stageId={activeStage}
              modelSetupIssue={modelSetupMessage(config)}
              onOpenModelSetup={() => void openModelSetup()}
              draft={draft}
              note={currentNote}
              materialText={materialText}
              materialLinks={materialLinks}
              materialFiles={materialFiles}
              materialAnalysis={materialAnalysis}
              materialAnalysisStale={materialAnalysisStale}
              materialInputFingerprint={materialServerIdentity.runId === draft.runId && !materialContextHydrating && !materialAnalysisStale ? materialServerIdentity.fingerprint : ''}
              onMaterialCorrected={materialCorrected}
              onReviewExistingPlan={() => selectStage('topic-template')}
              selectedMaterialTypeId={selectedMaterialTypeId}
              selectedMaterialStructureId={selectedMaterialStructureId}
              visualWorkbench={visualWorkbench}
              visualLoading={visualLoading}
              publicationQueue={publicationQueue}
              publicationInputs={publicationInputs}
              reviewAssertions={reviewAssertions}
              researchSubview={researchSubview}
              researchSampleRows={researchView.rows}
              researchOverview={topicResearchContextVerified ? { topic: draft.topic, queries: topicResearch?.queries ?? [], samples: researchSamples } : undefined}
              researchPlatformTotals={researchPlatformTotals}
              researchFilters={researchFilters}
              researchSort={researchView.sort}
              topicSuggestions={topicSuggestions}
              suggestionsLoading={suggestionsLoading}
              suggestionsError={suggestionsError}
              researchAvailable={Boolean(topicResearch && topicResearchContextVerified)}
              onViewResearchSamples={() => setResearchSubview('samples')}
              selectedTopicSuggestionId={selectedTopicSuggestionId}
              brandTemplates={brandTemplates}
              brandTemplatesLoading={brandTemplatesLoading}
              approvalMode={approvalModes[activeStage]}
              busy={interactionBusy}
              activeTask={taskPanelTask}
              taskRecovered={taskRecovered}
              onRetryTask={(mode) => void retryActiveProductionTask(mode)}
              onReturnToTaskStage={() => {
                if (!activeTask) return;
                const taskStage = productionTaskStage(activeTask.kind, activeTask.currentStep);
                setActiveStage(taskStage);
                syncStageToUrl(taskStage);
              }}
              canConfirm={currentCanConfirm}
              approvalReady={currentApprovalReady}
              onDraftChange={updateDraft}
              onSelectedPlatformsChange={(platforms) => { void changeSelectedPlatforms(platforms); }}
              onNoteChange={(value) => setNotes((current) => ({ ...current, [activeStage]: value }))}
              onMaterialTextChange={changeMaterialText}
              onMaterialLinksChange={changeMaterialLinks}
              onMaterialFilesChange={changeMaterialFiles}
              onUploadMaterialFiles={uploadMaterialFiles}
              onRetryMaterialFileExtraction={retryMaterialFileExtraction}
              onAnalyzeMaterial={analyzeMaterial}
              onStartNewMaterialPeriod={startNewMaterialPeriod}
              onInitializeMaterialDirection={initializeMaterialDirection}
              onSelectMaterialType={selectMaterialType}
              onSelectMaterialStructure={selectMaterialStructure}
              onStartResearch={startTikOmniResearch}
              onPublicationInputChange={(jobId, patch) => setPublicationInputs((current) => {
                const existing = current[jobId] || {
                  url: '',
                  proofPath: '',
                  publishedAt: localDateTimeInputValue(),
                  confirmed: false,
                  unknownCompletionResolved: false,
                };
                return { ...current, [jobId]: { ...existing, ...patch } };
              })}
              onReviewAssertionChange={(assertion, checked) => setReviewAssertions((current) => ({
                ...current,
                [assertion]: checked,
              }))}
              onContentReviewReadyChange={setContentReviewReady}
              onContentPlanReviewChange={onContentPlanReviewChange}
              onDeliverableReviewReadyChange={setDeliverableReviewReady}
              onResearchFiltersChange={setResearchFilters}
              onResearchSortChange={setResearchSort}
              onShowTopicSuggestions={() => void loadTopicSuggestions()}
              onSelectTopicSuggestion={selectTopicSuggestion}
              onConfirmTopicAndBuildBlueprint={() => void confirmTopicAndBuildBlueprint()}
              onRunContentPackage={() => void runContentPackage()}
              onContentVersionChange={acceptContentVersion}
              onWritingBriefSaved={saveWritingBrief}
              onWritingBriefConfirmed={confirmWritingBrief}
              onViewSavedContent={() => selectStage('content-package')}
              onPrepareDraftQueue={() => void prepareDraftQueue()}
              onFillQueuedDrafts={() => void fillQueuedDrafts()}
              onFillLocalDraft={(jobId) => void fillLocalDraft(jobId)}
              onSavePublicationResult={(jobId) => void savePublicationResult(jobId)}
              onConfirm={() => void confirmStage()}
              onOpenEnhancement={() => setEnhancementStage(activeStage)}
              onGenerateVisual={() => void generateVisualAssets()}
              onRegenerateVisual={() => void generateVisualAssets(true)}
              onRequestVisualRevision={requestVisualRevision}
              onAdoptVisualAsset={adoptVisualAsset}
              onAdoptAllVisualAssets={adoptAllVisualAssets}
            />
          ) : currentReadable && activeStage === 'content-package' ? (
            <SavedContentReview
              key={`${draft.runId}:${draft.artifactPaths['content-package']}:${draft.artifactPaths['topic-template']}`}
              runId={draft.runId}
              packagePath={draft.artifactPaths['content-package']!}
              blueprintPath={draft.artifactPaths['topic-template'] || ''}
              requiredStageLabel={getProductionStageMeta(requiredStage).label}
              onReturn={() => selectStage(requiredStage)}
            />
          ) : activeTask && productionTaskStage(activeTask.kind, activeTask.currentStep) === activeStage ? (
            <p className="px-5 pb-5 text-sm text-[#6B6B6B]">任务进度会保留在这里。完成后核对结果，再继续下一步。</p>
          ) : (
            <div className="flex min-h-[440px] flex-col items-center justify-center px-6 text-center">
              <CircleAlert size={24} className="text-[#A66300]" />
              <h2 className="mt-4 text-[17px] font-bold text-[#1A1A1A]">请先完成上一步</h2>
              <p className="mt-2 max-w-[420px] text-[13px] leading-[1.65] text-[#6B6B6B]">完成上一步后，才能进入「{currentStage.label}」。</p>
            </div>
          )}
          </div>
          <div id="production-stage-navigation" hidden={!showStageRail} className="order-1 min-w-0 xl:order-2">
            <ProductionStageRail
              activeStage={activeStage}
              draft={draft}
              stageStatusLabels={{
                'material-boundary': busyAction === 'material-boundary' ? '进行中' : materialPreparationProgress({
                  hasAnalysis: Boolean(materialAnalysis), stale: materialAnalysisStale,
                  writingMode: draft.writingMode, topic: draft.topic, modelSetupIssue: modelSetupMessage(config),
                })?.label,
                ...(topicResearchContextVerified && !hasWritingPlan ? { 'topic-template': '参考已保存，待确认选题' } : {}),
                ...(activeTask && ['queued', 'running', 'blocked', 'failed'].includes(activeTask.status)
                  ? { [productionTaskStage(activeTask.kind, activeTask.currentStep)]: productionTaskStatusLabel(taskPanelTask!, modelSetupMessage(config)) } : {}),
              }}
              onSelect={selectStage}
              onLockedSelect={(stageId) => {
                const target = getProductionStageMeta(stageId);
                setNotice({ tone: 'warning', text: `请先完成上一步，再进入「${target.label}」。` });
              }}
            />
          </div>
        </div>
      </section>

      {draft.runId && !restoringCurrentRun && <ProductionCallHistory key={draft.runId} runId={draft.runId} refreshKey={activeTask?.updatedAt || ''} />}
      {draft.runId && !restoringCurrentRun && <LayoutCallHistory runId={draft.runId} refreshKey={`${activeTask?.updatedAt || ''}:${busyAction}`} />}

      {draft.runId && (
            <TechnicalDetails>
              <TechnicalDetailList items={[
                { label: '运行编号', value: draft.runId },
                ...(draft.runSlug ? [{ label: '内容标识', value: draft.runSlug }] : []),
                ...(draft.projectId ? [{ label: '项目编号', value: draft.projectId }] : []),
                ...(topicResearch?.reportPath ? [{ label: '参考内容报告', value: topicResearch.reportPath }] : []),
                ...(topicResearch?.snapshotPath ? [{ label: '参考内容文件', value: topicResearch.snapshotPath }] : []),
                ...(topicResearch?.snapshotSha256 ? [{ label: '内容校验值', value: topicResearch.snapshotSha256 }] : []),
                ...(topicResearch?.status ? [{ label: '原始研究状态', value: topicResearch.status }] : []),
              ]} />
            </TechnicalDetails>
      )}

      <CreativeEnhancementDrawer
        stage={enhancementStage}
        projectId={draft.projectId}
        runId={draft.runId}
        onClose={() => setEnhancementStage(null)}
        onRun={runCreativeEnhancement}
        onAdopt={adoptCreativeEnhancement}
      />
    </div>
  );
}

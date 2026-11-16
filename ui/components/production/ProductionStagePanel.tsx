'use client';

import { OutputDownloadLink } from '@/components/OutputDownloadLink';
import { ModelCallAction } from './ModelCallAction';
import { DraftPreferenceReuse } from '@/components/materials/DraftPreferenceReuse';
import type { MaterialAnalysisContext } from '@/lib/material-analysis';
import { materialPreparationProgress } from '@/lib/material-progress';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Check,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  ExternalLink,
  FileDown,
  FileText,
  Link2,
  LoaderCircle,
  PenLine,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react';
import { TechnicalDetailList, TechnicalDetails } from '@/components/TechnicalDetails';
import { VisualWorkbench } from '@/components/VisualWorkbench';
import { ContentRevisionEditor, type ContentRevisionActions } from './ContentRevisionEditor';
import { ContentPlanNotice } from './ContentPlanNotice';
import { WritingBriefReview } from './WritingBriefReview';
import type { BrandTemplate } from '@/lib/brand-templates';
import { PRODUCTION_STATUS_DISPLAY_NAMES, platformDisplayName } from '@/lib/product-copy';
import { publicationJobDisplayLabel } from '@/lib/publication-display-copy';
import { outputHref } from '@/lib/output-links';
import {
  canExplicitlyRetryLocalDraft,
  canPrepareLocalDraft,
  canRecordPublicationEvidence,
  hasCompleteFinalDeliverables,
  hasQueuedLocalDrafts,
  type ProductionDraftJob,
  type ProductionDraftQueue,
} from '@/lib/production-flow';
import type { VisualWorkbenchState } from '@/lib/visual-workbench';
import {
  type ProductionReviewAssertion,
  type ProductionReviewAssertions,
} from '@/lib/production-review';
import {
  PRODUCTION_PLATFORMS,
  getProductionStageMeta,
  type ProductionDraft,
  type ProductionPlatform,
  type ProductionStageId,
} from './production-model';
import {
  ContentPackageReview,
  type ContentPackageReviewChecks,
  type ContentPackageReviewUnit,
} from './ContentPackageReview';
import { ContentAttemptRecovery } from './ContentAttemptRecovery';
import { WritingRequirementsReview } from './WritingRequirementsReview';
import { FinalDeliverablesReview } from './FinalDeliverablesReview';
import {
  MaterialIntakeWorkspace,
  type MaterialIntakeAnalysis,
  type MaterialUpload,
} from './MaterialIntakeWorkspace';
import {
  TikOmniSampleBrowser,
  type TikOmniSampleFilters,
  type TikOmniSampleRow,
  type TikOmniSampleSort,
} from './TikOmniSampleBrowser';
import {
  TopicTemplateConfirmation,
  type TopicSuggestion,
} from './TopicTemplateConfirmation';

type ApprovalMode = 'local' | 'server' | null;

export type ProductionTaskPanelTask = {
  contentRecovered?: boolean;
  taskId: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked';
  currentStep: string | null;
  steps: Array<{
    id: string;
    label: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'blocked';
  }>;
  startedAt: string;
  updatedAt: string;
  error?: {
    displayMessage?: string;
    message?: string;
    code?: string;
    debugId?: string;
    details?: {
      blockers?: Array<{ platform?: string; code?: string; message?: string }>;
      platformChecks?: Record<string, { status?: string; code?: string; reason?: string; sampleCount?: number }>;
    };
  } | string | null;
  resumableFrom?: string | null;
  retryMayCharge?: boolean;
};

export type PublicationInput = {
  url: string;
  proofPath: string;
  publishedAt: string;
  confirmed: boolean;
  unknownCompletionResolved: boolean;
};

type Props = {
  stageId: ProductionStageId;
  draft: ProductionDraft;
  note: string;
  materialText: string;
  materialLinks: string[];
  materialFiles: MaterialUpload[];
  materialAnalysis: MaterialIntakeAnalysis | null;
  materialAnalysisStale: boolean;
  materialInputFingerprint?: string;
  onReviewExistingPlan?: () => void;
  onMaterialCorrected?: (context: MaterialAnalysisContext) => void;
  selectedMaterialTypeId: string;
  selectedMaterialStructureId: string;
  visualWorkbench: VisualWorkbenchState | null;
  visualLoading: boolean;
  publicationQueue: ProductionDraftQueue | null;
  publicationInputs: Record<string, PublicationInput>;
  approvalMode: ApprovalMode;
  brandTemplates: BrandTemplate[];
  brandTemplatesLoading: boolean;
  busy: boolean;
  canConfirm: boolean;
  approvalReady: boolean;
  reviewAssertions: ProductionReviewAssertions;
  researchSubview: 'samples' | 'topics';
  researchSampleRows: TikOmniSampleRow[];
  researchOverview?: React.ComponentProps<typeof TikOmniSampleBrowser>['overview'];
  researchPlatformTotals: Record<string, number>;
  researchFilters: TikOmniSampleFilters;
  researchSort: TikOmniSampleSort;
  topicSuggestions: TopicSuggestion[];
  suggestionsLoading?: boolean;
  suggestionsError?: string;
  researchAvailable?: boolean;
  onViewResearchSamples?: () => void;
  selectedTopicSuggestionId: string | null;
  onDraftChange: (patch: Partial<Pick<ProductionDraft, 'topic' | 'writingMode' | 'template' | 'projectId'>>) => void;
  onSelectedPlatformsChange: (platforms: ProductionPlatform[]) => void;
  onNoteChange: (value: string) => void;
  onMaterialTextChange: (value: string) => void;
  onMaterialLinksChange: (links: string[]) => void;
  onMaterialFilesChange: (files: MaterialUpload[]) => void;
  onUploadMaterialFiles: (files: File[]) => Promise<MaterialUpload[]>;
  onRetryMaterialFileExtraction: (file: MaterialUpload) => Promise<MaterialUpload>;
  onAnalyzeMaterial: () => Promise<void>;
  onStartNewMaterialPeriod: () => Promise<void>;
  onInitializeMaterialDirection: (typeId: string, structureId: string) => void;
  onSelectMaterialType: (typeId: string) => void;
  onSelectMaterialStructure: (structureId: string) => void;
  onStartResearch: () => Promise<void>;
  onPublicationInputChange: (jobId: string, patch: Partial<PublicationInput>) => void;
  onResearchFiltersChange: (filters: TikOmniSampleFilters) => void;
  onResearchSortChange: (sort: TikOmniSampleSort) => void;
  onShowTopicSuggestions: () => void;
  onSelectTopicSuggestion: (suggestionId: string) => void;
  onConfirmTopicAndBuildBlueprint: () => void;
  onRunContentPackage: () => void;
  onContentVersionChange?: (path: string) => void;
  onWritingBriefSaved?: (path: string) => void;
  onWritingBriefConfirmed?: (path: string) => Promise<void>;
  onViewSavedContent?: () => void;
  onPrepareDraftQueue: () => void;
  onFillQueuedDrafts: () => void;
  onFillLocalDraft: (jobId: string) => void;
  onSavePublicationResult: (jobId: string) => void;
  onConfirm: () => void;
  onOpenEnhancement: () => void;
  onGenerateVisual: () => void;
  onRegenerateVisual?: () => void;
  onRequestVisualRevision: (request: string, assetIds: string[], baseRevisionId: string) => Promise<string | void>;
  onAdoptVisualAsset: (revisionId: string, assetId: string) => Promise<void>;
  onAdoptAllVisualAssets: (revisionId: string, assetIds: string[], reconfirm?: boolean) => Promise<void>;
  onReviewAssertionChange: (assertion: ProductionReviewAssertion, checked: boolean) => void;
  onContentReviewReadyChange: (ready: boolean) => void;
  onContentPlanReviewChange: (ready: boolean, reviewedPlanSha256: string, materialCorrectionId?: string) => void;
  onDeliverableReviewReadyChange: (ready: boolean) => void;
  activeTask?: ProductionTaskPanelTask | null;
  modelSetupIssue?: string | null;
  onOpenModelSetup?: () => void;
  taskRecovered?: boolean;
  onRetryTask?: (mode?: 'default' | 'recover' | 'redispatch') => void;
  onReturnToTaskStage?: () => void;
};

const PLATFORM_DETAILS: Record<ProductionDraftJob['platform'], { label: string; detail: string }> = {
  wechat: { label: '公众号', detail: '文章、封面和正文配图' },
  xiaohongshu: { label: '小红书', detail: '图文卡片和配文' },
  shipinhao: { label: '视频号', detail: '视频稿文件' },
  douyin: { label: '抖音', detail: '视频稿文件' },
  moments: { label: '朋友圈', detail: '图文卡片和配文' },
};

function confirmationLabel(stageId: ProductionStageId): string {
  switch (stageId) {
    case 'material-boundary': return '素材已整理';
    case 'topic-template': return '确认并生成提纲';
    case 'content-package': return '确认全部内容';
    case 'visual-assets': return '确认平台排版';
    case 'draft-information': return '确认发布成品';
    case 'publication-result': return '确认发布记录';
    case 'weekly-review': return '保存本周复盘';
  }
}

function completedLabel(stageId: ProductionStageId): string {
  if (stageId === 'material-boundary') return '已整理';
  return '已确认';
}

function jobStatusMeta(job: ProductionDraftJob): { label: string; className: string } {
  if (job.delivery_kind === 'execution_package' && job.status === 'published_confirmed') {
    return { label: PRODUCTION_STATUS_DISPLAY_NAMES.failed, className: 'bg-[#FFF1EE] text-[#B43C2E]' };
  }
  switch (job.status) {
    case 'pending': return { label: PRODUCTION_STATUS_DISPLAY_NAMES.pending, className: 'bg-[#F5EDE4] text-[#6B5543]' };
    case 'authorizing': return { label: PRODUCTION_STATUS_DISPLAY_NAMES.authorizing, className: 'bg-[#FFF8E8] text-[#A66300]' };
    case 'draft_filled': return { label: PRODUCTION_STATUS_DISPLAY_NAMES.completed, className: 'bg-[#EDF8F0] text-[#16803C]' };
    case 'retryable_failure': return { label: PRODUCTION_STATUS_DISPLAY_NAMES.retryable_failure, className: 'bg-[#FFF1EE] text-[#B43C2E]' };
    case 'manual_intervention_required': return { label: PRODUCTION_STATUS_DISPLAY_NAMES.manual_intervention_required, className: 'bg-[#FFF8E8] text-[#A66300]' };
    case 'unknown_completion': return { label: PRODUCTION_STATUS_DISPLAY_NAMES.unknown_completion, className: 'bg-[#FFF8E8] text-[#A66300]' };
    case 'published_confirmed': return { label: PRODUCTION_STATUS_DISPLAY_NAMES.completed, className: 'bg-[#EDF8F0] text-[#16803C]' };
  }
}

function jobStatusDetail(job: ProductionDraftJob): string {
  if (job.delivery_kind === 'execution_package' && job.status === 'draft_filled') return '口播稿与拍摄说明可以下载，视频仍需自行拍摄';
  if (job.delivery_kind === 'execution_package' && job.status === 'published_confirmed') return '口播稿状态异常，请重新准备';
  switch (job.status) {
    case 'pending': return '尚未准备';
    case 'authorizing': return '正在连接平台';
    case 'draft_filled': return '草稿已填入平台';
    case 'retryable_failure': return '可以从这里重试';
    case 'manual_intervention_required': return '按页面提示处理后再重试';
    case 'unknown_completion': return '请到平台检查是否已填入草稿';
    case 'published_confirmed': return '已记录发布结果';
  }
}

export function stagePanelStatus({
  approved,
  busy,
  approvalReady,
  requiresHumanApproval,
  task,
  modelSetupIssue,
  preparedStatus,
}: {
  approved: boolean;
  busy: boolean;
  approvalReady: boolean;
  requiresHumanApproval: boolean;
  task?: ProductionTaskPanelTask | null;
  modelSetupIssue?: string | null;
  preparedStatus?: string;
}): string {
  if (approved) return PRODUCTION_STATUS_DISPLAY_NAMES.completed as '已完成';
  if (task && ['failed', 'blocked', 'queued', 'running'].includes(task.status)) return productionTaskStatusLabel(task, modelSetupIssue);
  if (busy) return PRODUCTION_STATUS_DISPLAY_NAMES.running as '进行中';
  if (preparedStatus) return preparedStatus;
  if (requiresHumanApproval && approvalReady) return PRODUCTION_STATUS_DISPLAY_NAMES.blocked as '待你确认';
  return PRODUCTION_STATUS_DISPLAY_NAMES.pending as '未开始';
}

export function productionTaskStatusLabel(task: ProductionTaskPanelTask, modelSetupIssue?: string | null): string {
  if (task.contentRecovered && task.kind === 'content-package' && ['blocked', 'failed'].includes(task.status)) return '正文已确认';
  if (task.status === 'blocked' && typeof task.error !== 'string' && task.error?.code === 'model_setup_required') {
    return modelSetupIssue === null ? '可以继续本期' : '等你完成模型连接';
  }
  return PRODUCTION_STATUS_DISPLAY_NAMES[task.status];
}

function canRecordResult(job: ProductionDraftJob, input: PublicationInput): boolean {
  return canRecordPublicationEvidence(job, input.unknownCompletionResolved);
}

function StageFooter({
  stageId,
  approved,
  approvalMode,
  busy,
  canConfirm,
  approvalReady,
  onConfirm,
  preparationMessage,
}: Pick<Props, 'stageId' | 'approvalMode' | 'busy' | 'canConfirm' | 'approvalReady' | 'onConfirm'> & { approved: boolean; preparationMessage?: string }) {
  const meta = getProductionStageMeta(stageId);
  const serverBound = Boolean(meta.approvalScope);
  return (
    <div className="aifios-stage-footer mt-6 flex flex-col gap-3 border-t border-[rgba(28,28,30,0.08)] pt-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-[#6B6B6B]">
        {approved ? (
          <>
            <Check size={15} className="shrink-0 text-[#16803C]" strokeWidth={2.6} />
            <span>{approvalMode === 'server' ? '已保存本次确认' : '已保存'}</span>
          </>
        ) : serverBound ? (
          <>
            <CircleAlert size={15} className="shrink-0 text-[#A66300]" />
            <span>{approvalReady ? '确认后可以继续下一步' : !busy && preparationMessage ? preparationMessage : '当前结果还在准备中'}</span>
          </>
        ) : (
          <span>{stageId === 'weekly-review' ? '保存复盘记录' : '完成整理后进入下一阶段'}</span>
        )}
      </div>
      <button
        type="button"
        onClick={onConfirm}
        disabled={approved || busy || !canConfirm}
        className="aifios-stage-primary-action inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-[#1C1C1E] px-4 text-[13px] font-bold text-white transition-colors hover:bg-[#353535] disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
      >
        {busy ? <LoaderCircle size={15} className="animate-spin" /> : approved ? <Check size={15} /> : <ClipboardCheck size={15} />}
        {approved ? completedLabel(stageId) : confirmationLabel(stageId)}
      </button>
    </div>
  );
}

function StageContract({ stageId, draft }: { stageId: ProductionStageId; draft: ProductionDraft }) {
  if (stageId === 'material-boundary') return null;
  const stage = getProductionStageMeta(stageId);
  const isResearchStep = stageId === 'topic-template';
  const isContentHumanGate = stageId === 'content-package';
  const platformLabels = PRODUCTION_PLATFORMS
    .filter((platform) => draft.selectedPlatforms.includes(platform.id))
    .map((platform) => platform.label)
    .join('、');
  return (
    <details className={`aifios-stage-contract mb-4 rounded-lg border-l-[3px] px-3 py-2 ${
      isResearchStep
        ? 'border-[#D99124] bg-[#FFF9EC]'
        : isContentHumanGate
          ? 'border-[#8BC34A] bg-[#F4FBEA]'
        : stage.optional
          ? 'border-[#AAA39B] bg-[#F7F7F7]'
          : 'border-[#E85D4C] bg-[#FFF9F7]'
    }`}>
      <summary className="cursor-pointer text-xs text-[#6B6B6B]">这一步需要核对什么</summary>
      <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <p className={`text-[12px] font-bold ${isResearchStep ? 'text-[#8D5A00]' : isContentHumanGate ? 'text-[#4F7A12]' : 'text-[#6B6B6B]'}`}>
            {isResearchStep
              ? '完成条件'
              : isContentHumanGate
                ? '需要你确认'
                : stage.optional ? '这一步可跳过' : '完成条件'}
          </p>
          <p className="mt-1 text-[12px] leading-[1.6] text-[#4F4A45]">
            {isResearchStep
              ? draft.writingMode === 'author_material' ? `依据本期素材，为${platformLabels}准备写作方案。未进行平台研究，请核对事实、观点和写作要求。` : `只研究已选的${platformLabels}。每个平台独立给出样本可信度和选题；某一平台数据不足时，只暂停该平台，不阻断其他平台。`
              : isContentHumanGate
                ? `逐项检查${platformLabels}的原生内容。它们共享事实底稿，但不是由一篇母稿相互改写。`
              : stage.optional
                ? '发布完成后可按周补充关键表现数据并生成复盘；跳过它不会影响本期内容或发布。'
                : `先得到「${stage.output}」，再执行下一步。`}
          </p>
        </div>
        <div className="shrink-0 xl:max-w-[260px] xl:text-right">
          <p className="text-[10px] font-bold text-[#8A8178]">{stage.requiresHumanApproval ? '需要你确认' : '如何继续'}</p>
          <p className="mt-1 text-[11px] leading-[1.5] text-[#1A1A1A]">{stage.checkpoint}</p>
        </div>
      </div>
    </details>
  );
}

function taskLabel(kind: string): string {
  switch (kind) {
    case 'author-blueprint': return '按你的题目准备写作方案';
    case 'material-research': return '整理素材和同类内容';
    case 'topic-blueprint': return '保存选题和生成各平台内容方案';
    case 'content-package': return '生成内容';
    case 'visual-candidates': return '生成平台完整发布件';
    case 'draft-queue': return '整理发布内容';
    default: return '正在处理';
  }
}

export function productionTaskStage(kind: string, currentStep?: string | null): ProductionStageId {
  switch (kind) {
    case 'author-blueprint': return currentStep === 'content-blueprint' || currentStep === 'template-binding' ? 'topic-template' : 'material-boundary';
    case 'material-research': return 'material-boundary';
    case 'topic-blueprint': return 'topic-template';
    case 'content-package': return 'content-package';
    case 'visual-candidates': return 'visual-assets';
    case 'draft-queue': return 'draft-information';
    default: return 'material-boundary';
  }
}

export function productionTaskProgress(task: Pick<ProductionTaskPanelTask, 'steps'>): {
  completed: number;
  skipped: number;
  total: number;
} {
  return {
    completed: task.steps.filter((step) => step.status === 'completed').length,
    skipped: task.steps.filter((step) => step.status === 'skipped').length,
    total: task.steps.length,
  };
}

function jobDisplayLabel(job: ProductionDraftJob): string {
  if (job.delivery_kind === 'execution_package') return publicationJobDisplayLabel(job);
  return job.item_label
    .replace(/公众号(?:母稿|长文)/g, '公众号文章')
    .replace(/短视频(?:执行稿|口播稿)/g, '视频稿')
    .replace(/分享观点图文|观点图文/g, '图文卡片')
    .replace(/执行包/g, '口播稿与拍摄说明');
}

function readableTaskError(error: ProductionTaskPanelTask['error']): string {
  if (!error) return '';
  return typeof error === 'string' ? error : error.displayMessage || error.message || '';
}

export function displayTaskMessage(message: string): string {
  const raw = message.trim();
  if (/TikOmni|快照|三平台/i.test(raw)) {
    return '平台数据不完整或已经变化。请重新获取平台数据后再继续。';
  }
  if (/(?:证据图|CTA).*(?:不完整|无法证明|缺少)|(?:封面).*(?:证据图|CTA)/i.test(raw)) {
    return '平台成品还不完整。请重新生成公众号排版或小红书 P1-P8。';
  }
  if (/\b(?:operation|runtime|run)\b|(?:请求|上游产物).*(?:哈希|变化)/i.test(raw)) {
    return '当前任务已经变化。请刷新后重试。';
  }
  const friendly = message
    .trim()
    .replace(/TikOmni/gi, '平台数据')
    .replace(/(?:API\s*Key|Token)/gi, '访问凭证')
    .replace(/(?:视觉调用|视觉生成)/g, '配图生成')
    .replace(/\s*CTA\s*(?:图|资产)?/gi, '结尾图')
    .replace(/证据图/g, '正文配图')
    .replace(/视觉资产|视觉候选/g, '配图方案')
    .replace(/快照/g, '已保存的平台数据')
    .replace(/(?:pipeline|materials|runs)\/[\w./@-]+/gi, '相关文件')
    .replace(/(?:\/Users\/[^\s`"'<>]+|[A-Za-z]:\\Users\\[^\s`"'<>]+)/g, '相关文件')
    .replace(/\b(?:run|task|asset|revision)[_-][A-Za-z0-9_-]+\b/gi, '相关记录')
    .replace(/\bruntime\s+run\b/gi, '当前任务')
    .replace(/\boperation\b/gi, '本次处理')
    .replace(/\bruntime\b/gi, '系统')
    .replace(/\brun\b/gi, '当前任务')
    .replace(/SHA-?256/gi, '内容校验')
    .replace(/\bJSON\b/gi, '数据格式')
    .replace(/哈希/g, '内容校验')
    .replace(/契约/g, '要求')
    .replace(/落盘/g, '保存')
    .replace(/产物/g, '结果')
    .replace(/调用/g, '处理')
    .replace(/素材理解|素材分析/g, '素材整理')
    .replace(/内容蓝图/g, '各平台内容方案')
    .replace(/内容包/g, '全部内容')
    .replace(/\b(?:slug|hash)\b/gi, '内容版本')
    .replace(/资产/g, '文件');

  if (
    /\b(?:pipeline|runtime|snapshot|artifact|queue|schema|slug|hash|operation|renderer|revision|legacy|json|run|task|id)\b/i.test(friendly)
    || /(?:^|\n)\s*at\s+\S+/.test(friendly)
    || /[{}][\s\S]*[:][\s\S]*[{}]/.test(friendly)
  ) {
    return '这一步没有处理完成，请重试。';
  }
  return friendly || '这一步没有处理完成。请重试。';
}

function taskDiagnosticLines(error: ProductionTaskPanelTask['error']): string[] {
  if (!error || typeof error === 'string') return [];
  const blockers = Array.isArray(error.details?.blockers) ? error.details.blockers : [];
  const lines = blockers.map((blocker) => blocker.message?.trim()).filter((message): message is string => Boolean(message));
  if (lines.length) return lines.slice(0, 3);
  return Object.entries(error.details?.platformChecks || {})
    .filter(([, check]) => check.status === 'unavailable' || Boolean(check.reason))
    .map(([platform, check]) => `${platformDisplayName(platform, '相关平台')}：${displayTaskMessage(check.reason || '暂时不可用')}`)
    .slice(0, 3);
}

export function ProductionTaskPanel({
  runId,
  task,
  recovered,
  onRetry,
  currentStageId,
  onReturnToTaskStage,
  modelSetupIssue,
}: {
  runId?: string;
  task: ProductionTaskPanelTask;
  recovered?: boolean;
  onRetry?: (mode?: 'default' | 'recover' | 'redispatch') => void;
  currentStageId: ProductionStageId;
  onReturnToTaskStage?: () => void;
  modelSetupIssue?: string | null;
}) {
  const [confirmingRedispatch, setConfirmingRedispatch] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!['queued', 'running'].includes(task.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [task.status]);
  const elapsedSeconds = now === null ? null : Math.max(0, Math.floor((now - Date.parse(task.startedAt)) / 1000));
  const currentIndex = task.currentStep ? task.steps.findIndex((step) => step.id === task.currentStep) : -1;
  const current = (currentIndex >= 0 ? task.steps[currentIndex] : undefined)
    || task.steps.find((step) => ['running', 'blocked', 'failed'].includes(step.status))
    || task.steps.find((step) => step.status === 'pending')
    || task.steps.at(-1);
  const failed = task.status === 'failed';
  const blocked = task.status === 'blocked';
  const active = task.status === 'queued' || task.status === 'running';
  const recoversExistingResult = typeof task.error !== 'string'
    && task.error?.code === 'operation_outcome_unknown';
  const needsModelSetup = blocked && typeof task.error !== 'string' && task.error?.code === 'model_setup_required';
  const canResumeAfterSetup = needsModelSetup && modelSetupIssue === null;
  const retryMayCharge = task.retryMayCharge !== false;
  const modelRunId = retryMayCharge && ['author-blueprint', 'topic-blueprint', 'content-package'].includes(task.kind) ? runId : undefined;
  const error = readableTaskError(task.error);
  const diagnostics = taskDiagnosticLines(task.error);
  const progress = productionTaskProgress(task);
  const taskStageId = productionTaskStage(task.kind, task.currentStep);
  if (task.contentRecovered && task.kind === 'content-package' && (blocked || failed)) {
    return <aside aria-label="当前稿件状态" aria-live="polite" className="mb-5 rounded-lg border border-[#B8D9C1] bg-[#F3FAF5] p-3">
      <p className="text-sm font-semibold text-[#256B3A]">这份稿已修好，可以继续检查成品。</p>
      <p className="mt-1 text-xs leading-6 text-[#4F4A45]">当前正文已确认。上次生成的记录仍然保留；无需为了继续制作成品而重新生成。</p>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold">查看上次生成记录</summary>
        <p className="my-2 text-xs leading-6 text-[#6B6B6B]">以下是上次生成时的状态，不代表当前稿件状态。主动重试可能产生新的模型费用。</p>
        <ProductionTaskPanel runId={runId} task={{ ...task, contentRecovered: false }} recovered={recovered}
          onRetry={onRetry} currentStageId="content-package" modelSetupIssue={modelSetupIssue} />
      </details>
    </aside>;
  }
  if (taskStageId !== currentStageId && onReturnToTaskStage) {
    return <aside aria-label="其他步骤的处理任务" aria-live="polite" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[rgba(28,28,30,0.12)] bg-[#FFFDF9] p-3">
      <div className="min-w-0 text-xs">
        <p className="font-semibold">{taskLabel(task.kind)}</p>
        <p className="mt-1 text-[#6B6B6B]">{productionTaskStatusLabel(task, modelSetupIssue)}</p>
      </div>
      <button type="button" onClick={onReturnToTaskStage} className="shrink-0 rounded-md border border-[rgba(28,28,30,0.16)] bg-white px-3 py-2 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E85D4C]">返回处理步骤</button>
    </aside>;
  }
  return (
    <aside aria-label="当前处理任务" className="mb-5 rounded-lg border border-[rgba(28,28,30,0.12)] bg-[#FFFDF9] px-3 py-3" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] font-bold text-[#1A1A1A]">{taskLabel(task.kind)}</p>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold ${
          failed || blocked ? 'bg-[#FFF1EE] text-[#B43C2E]' : active ? 'bg-[#FFF8E8] text-[#8D5A00]' : 'bg-[#EDF8F0] text-[#16803C]'
        }`}>
          {active && <LoaderCircle size={12} className="animate-spin" />}
          {productionTaskStatusLabel(task, modelSetupIssue)}
        </span>
      </div>
      {needsModelSetup ? <p className="mt-2 text-[12px] text-[#4F4A45]">{canResumeAfterSetup ? '已读到模型配置。继续会使用当前服务，可能产生费用。' : '准备进度已保存，正在等待你连接写作服务。'}</p> : <p className="mt-2 text-[12px] text-[#4F4A45]">
        {task.status === 'completed' ? '本次处理已完成，请核对结果。'
          : task.status === 'queued' ? `任务已保存，等待开始${current ? `：${current.label}` : '。'}`
            : task.status === 'running' ? `正在处理${current ? `：${current.label}` : '。'}`
              : `已暂停${current ? `：${current.label}` : '。'}`}
      </p>}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#6B6B6B]">
        <span>最近更新：<time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString('zh-CN')}</time></span>
        {active && elapsedSeconds !== null && Number.isFinite(elapsedSeconds) && <span>已等待 {Math.floor(elapsedSeconds / 60)} 分 {elapsedSeconds % 60} 秒</span>}
        {recovered && <span>已读回上次记录</span>}
      </div>
      {active && (
        <p className="mt-2 text-[11px] leading-[1.55] text-[#6B6B6B]">可以切换页面；返回后会读取已保存进度。</p>
      )}
      {error && !needsModelSetup && <p className="mt-2 text-[11px] leading-[1.55] text-[#B43C2E]">{displayTaskMessage(error)}</p>}
      {diagnostics.length > 0 && (
        <ul className="mt-2 grid gap-1 text-[10px] leading-[1.5] text-[#8C3B30]">
          {diagnostics.map((line) => <li key={line}>• {displayTaskMessage(line)}</li>)}
        </ul>
      )}
      {needsModelSetup && !canResumeAfterSetup ? <Link href="/settings#model-connection" className="mt-3 inline-block text-sm font-semibold underline underline-offset-4">连接写作服务后继续</Link> : (failed || blocked) && onRetry && (
        <div className="mt-3">
          {recoversExistingResult && (
            <p className="mb-2 text-[10px] leading-[1.5] text-[#6B6B6B]">
              {retryMayCharge
                ? '先查找已保存的完整结果，不会重新执行或产生新费用。找不到时，可以明确选择重新执行。'
                : '先查找已保存的完整结果，不会重新执行。找不到时，可以重新执行当前本地步骤。'}
            </p>
          )}
          <ModelCallAction runId={recoversExistingResult ? undefined : modelRunId} refreshKey={task.updatedAt}>{(callUnavailable) => <button type="button" disabled={callUnavailable} onClick={() => onRetry(recoversExistingResult ? 'recover' : 'default')} className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#1A1A1A] px-5 text-[12px] font-bold text-[#1A1A1A] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-40">
            <RefreshCw size={14} />{canResumeAfterSetup ? '继续本期' : recoversExistingResult ? '恢复已有结果' : '从这里重试'}
          </button>}</ModelCallAction>
          {recoversExistingResult && (
            confirmingRedispatch ? (
              <div role="alert" className="mt-2 rounded-md border border-[#E85D4C] bg-[#FFF4F1] p-3">
                <p className="text-[11px] font-bold text-[#8F3329]">确定重新执行这一步？</p>
                <p className="mt-1 text-[10px] leading-[1.5] text-[#8F3329]">
                  {retryMayCharge
                    ? '这会发起一次新的外部请求，可能产生费用。建议先使用上方“恢复已有结果”。'
                    : '这会重新执行当前本地步骤，已有版本仍会保留。'}
                </p>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => setConfirmingRedispatch(false)} className="inline-flex h-8 flex-1 items-center justify-center rounded-md border border-[rgba(143,51,41,0.3)] bg-white text-[11px] font-bold text-[#8F3329] hover:bg-[#FFF8F5]">取消</button>
                  <ModelCallAction runId={modelRunId} refreshKey={task.updatedAt}>{(callUnavailable) => <button type="button" disabled={callUnavailable} onClick={() => { setConfirmingRedispatch(false); onRetry('redispatch'); }} className="inline-flex h-8 w-full items-center justify-center rounded-md bg-[#B43C2E] text-[11px] font-bold text-white hover:bg-[#963126] disabled:opacity-40">确认重新执行</button>}</ModelCallAction>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmingRedispatch(true)} className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-[#E85D4C] px-5 text-[12px] font-bold text-[#C94A3B] hover:bg-[#FFF1EE]">
                <RefreshCw size={14} />{retryMayCharge ? '重新执行这一步（可能产生费用）' : '重新执行这一步'}
              </button>
            )
          )}
        </div>
      )}
      <details className="mt-3 border-t border-[rgba(28,28,30,0.08)] pt-2">
        <summary className="cursor-pointer text-xs text-[#6B6B6B]">查看过程 · 已完成 {progress.completed} 项{progress.skipped ? `，跳过 ${progress.skipped} 项` : ''}</summary>
        <p className="mt-2 text-xs text-[#6B6B6B]">共 {progress.total} 项，各项所需时间不同。</p>
        <ol className="mt-2 space-y-2">
          {task.steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-start justify-between gap-3 text-xs text-[#6B6B6B]">
              <span className="break-words">{step.label}</span>
              <span className="shrink-0">{{ completed: '已完成', skipped: '已跳过', running: '正在处理', pending: '尚未开始', failed: '未完成', blocked: '已暂停' }[step.status]}</span>
            </li>
          ))}
        </ol>
        <TechnicalDetails className="mt-3">
          <TechnicalDetailList items={[
            { label: '任务编号', value: task.taskId },
            { label: '任务类型', value: task.kind },
            { label: '创建时间', value: task.startedAt },
            ...(task.currentStep ? [{ label: '当前步骤 ID', value: task.currentStep }] : []),
            ...(typeof task.error !== 'string' && task.error?.code ? [{ label: '错误代码', value: task.error.code }] : []),
            ...(typeof task.error !== 'string' && task.error?.debugId ? [{ label: '排查编号', value: task.error.debugId }] : []),
          ]} />
        </TechnicalDetails>
      </details>
    </aside>
  );
}

function StageNote({
  value,
  onChange,
  placeholder,
  label,
  rows = 6,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[12px] font-bold text-[#6B6B6B]">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="block w-full resize-y rounded-md border border-[rgba(28,28,30,0.14)] bg-white px-3 py-2.5 text-[14px] leading-[1.7] text-[#1A1A1A] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]"
      />
    </label>
  );
}

const CONTENT_REVIEW_ASSERTION_BY_UNIT: Partial<Record<ContentPackageReviewUnit, ProductionReviewAssertion>> = {
  article: 'content_article_reviewed',
  'video-1': 'content_video_1_reviewed',
  'video-2': 'content_video_2_reviewed',
  'opinion-1': 'content_opinion_1_reviewed',
  'opinion-2': 'content_opinion_2_reviewed',
  'opinion-3': 'content_opinion_3_reviewed',
};

function contentReviewChecks(assertions: ProductionReviewAssertions): ContentPackageReviewChecks {
  return Object.fromEntries(
    Object.entries(CONTENT_REVIEW_ASSERTION_BY_UNIT)
      .filter((entry): entry is [string, ProductionReviewAssertion] => entry[1] !== undefined)
      .map(([unit, assertion]) => [unit, assertions[assertion] === true]),
  ) as ContentPackageReviewChecks;
}

export function ProductionStagePanel({
  stageId,
  draft,
  note,
  materialText,
  materialLinks,
  materialFiles,
  materialAnalysis,
  materialAnalysisStale,
  materialInputFingerprint,
  onMaterialCorrected,
  onReviewExistingPlan,
  selectedMaterialTypeId,
  selectedMaterialStructureId,
  visualWorkbench,
  visualLoading,
  publicationQueue,
  publicationInputs,
  approvalMode,
  reviewAssertions,
  researchSubview,
  researchSampleRows,
  researchOverview,
  researchPlatformTotals,
  researchFilters,
  researchSort,
  topicSuggestions,
  suggestionsLoading = false,
  suggestionsError = '',
  researchAvailable = false,
  onViewResearchSamples,
  selectedTopicSuggestionId,
  brandTemplates,
  brandTemplatesLoading,
  busy,
  canConfirm,
  approvalReady,
  onDraftChange,
  onSelectedPlatformsChange,
  onNoteChange,
  onMaterialTextChange,
  onMaterialLinksChange,
  onMaterialFilesChange,
  onUploadMaterialFiles,
  onRetryMaterialFileExtraction,
  onAnalyzeMaterial,
  onStartNewMaterialPeriod,
  onInitializeMaterialDirection,
  onSelectMaterialType,
  onSelectMaterialStructure,
  onStartResearch,
  onPublicationInputChange,
  onResearchFiltersChange,
  onResearchSortChange,
  onShowTopicSuggestions,
  onSelectTopicSuggestion,
  onConfirmTopicAndBuildBlueprint,
  onRunContentPackage,
  onContentVersionChange,
  onWritingBriefSaved,
  onWritingBriefConfirmed,
  onViewSavedContent,
  onPrepareDraftQueue,
  onFillQueuedDrafts,
  onFillLocalDraft,
  onSavePublicationResult,
  onConfirm,
  onOpenEnhancement,
  onGenerateVisual,
  onRegenerateVisual,
  onRequestVisualRevision,
  onAdoptVisualAsset,
  onAdoptAllVisualAssets,
  onReviewAssertionChange,
  onContentReviewReadyChange,
  onContentPlanReviewChange,
  onDeliverableReviewReadyChange,
  activeTask,
  taskRecovered,
  onRetryTask,
  onReturnToTaskStage,
  modelSetupIssue,
  onOpenModelSetup,
}: Props) {
  const [manualRetryJobId, setManualRetryJobId] = useState('');
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const editorRef = useRef<HTMLDetailsElement>(null);
  const revisionActionsRef = useRef<ContentRevisionActions>(null);
  const [inlineEditor, setInlineEditor] = useState<{ path: string; host: HTMLElement } | null>(null);
  const inlineHost = inlineEditor && inlineEditor.path === draft.artifactPaths['content-package'] && inlineEditor.host.isConnected ? inlineEditor.host : null;
  const closeInlineEditor = () => {
    const trigger = inlineHost?.previousElementSibling;
    setInlineEditor(null);
    requestAnimationFrame(() => {
      if (trigger instanceof HTMLButtonElement && trigger.isConnected) trigger.focus();
    });
  };
  const [recordingJobId, setRecordingJobId] = useState('');
  const stage = getProductionStageMeta(stageId);
  const approved = draft.approved[stageId];
  const awaitingAuthorPlan = stageId === 'topic-template' && activeTask?.kind === 'author-blueprint'
    && activeTask.status !== 'completed';
  const artifactPath = awaitingAuthorPlan ? undefined : draft.artifactPaths[stageId];
  const stageLabel = stageId === 'topic-template' && draft.writingMode === 'author_material' ? '核对写作方案' : stage.label;
  const stageSummary = stageId === 'topic-template' && draft.writingMode === 'author_material' ? '根据你确认的题目和素材准备方案，确认后再写正文。' : stage.summary;
  const isMaterialIntake = stageId === 'material-boundary';
  const stageHasTask = Boolean(activeTask && productionTaskStage(activeTask.kind, activeTask.currentStep) === stageId);
  const modelSetupHandledByTask = stageHasTask && activeTask?.status === 'blocked'
    && typeof activeTask.error !== 'string' && activeTask.error?.code === 'model_setup_required';
  const visualRevision = visualWorkbench?.revisions.find((item) => item.revisionId === visualWorkbench.selectedRevisionId);
  const visualPreparedStatus = stageId !== 'visual-assets' || !visualWorkbench ? undefined
    : visualWorkbench.hasCompleteAssetSelection ? '排版已选好，待确认'
    : visualRevision?.status === 'blocked' ? '排版需调整'
    : visualRevision?.status === 'rendering' ? '排版制作中'
    : visualRevision?.status === 'review_required' ? '排版待检查'
    : '排版已生成，待选择';
  const statusLabel = stageId === 'topic-template' && !approved && !artifactPath && !activeTask && researchAvailable
    ? '参考已保存，待确认选题' : stagePanelStatus({
    approved,
    busy,
    approvalReady,
    requiresHumanApproval: stage.requiresHumanApproval,
    modelSetupIssue,
    preparedStatus: isMaterialIntake ? materialPreparationProgress({
      hasAnalysis: Boolean(materialAnalysis), stale: materialAnalysisStale,
      writingMode: draft.writingMode, topic: draft.topic, modelSetupIssue,
    })?.label : visualPreparedStatus,
    task: activeTask && productionTaskStage(activeTask.kind, activeTask.currentStep) === stageId ? activeTask : null,
  });
  const selectedPlatformLabels = PRODUCTION_PLATFORMS
    .filter((platform) => draft.selectedPlatforms.includes(platform.id))
    .map((platform) => platform.label);
  const selectedDeliverySummary = draft.selectedPlatforms.map((platform) => ({
    wechat: '公众号完整长文与视觉',
    xhs: '小红书 P1-P8 图文',
    shipinhao: '视频号口播执行稿',
  }[platform])).filter(Boolean).join('、');

  return (
    <section className="aifios-stage-panel min-w-0 p-5 sm:p-6">
      {!isMaterialIntake && <div className="aifios-stage-panel__header flex flex-col gap-4 border-b pb-5 md:flex-row md:items-start md:justify-between">
        {stageId === 'content-package' && artifactPath ? (
          <h2 className="text-lg font-bold">阅读与修改</h2>
        ) : (
        <div className="min-w-0">
          <div className="aifios-stage-panel__meta flex items-center gap-2">
            <span className="aifios-stage-panel__number rounded-md px-2.5 py-1 text-[11px] font-bold">{String(stage.number).padStart(2, '0')}</span>
            <span className="text-[12px] font-semibold">{stage.phase}</span>
          </div>
          <h2 className="aifios-stage-panel__title mt-3 text-[25px] font-bold">{stageLabel}</h2>
          <p className="aifios-stage-panel__summary mt-2 max-w-[680px] text-[14px] leading-[1.65]">{stageSummary}</p>
        </div>
        )}
        <div className="flex items-center gap-2">
          {stage.creativeEnhancement && (
            <button
              type="button"
              onClick={onOpenEnhancement}
              className="aifios-stage-enhancement inline-flex h-9 items-center gap-2 rounded-md border px-3 text-[12px] font-bold"
            >
              <Sparkles size={14} />
              专项检查
            </button>
          )}
          {!stageHasTask && <span className={`aifios-stage-panel__status inline-flex h-8 items-center rounded-md px-3 text-[11px] font-bold ${
            statusLabel === '已完成' ? 'is-complete' : stage.optional ? 'is-optional' : 'is-pending'
          }`}>
            {statusLabel}
          </span>}
        </div>
      </div>}

      <div className={isMaterialIntake ? undefined : 'pt-5'}>
        {activeTask && (
          <ProductionTaskPanel
            runId={draft.runId}
            modelSetupIssue={modelSetupIssue}
            task={activeTask}
            recovered={taskRecovered}
            onRetry={onRetryTask}
            currentStageId={stageId}
            onReturnToTaskStage={onReturnToTaskStage}
          />
        )}
        {stageId !== 'content-package' && <StageContract stageId={stageId} draft={draft} />}
        {stageId === 'material-boundary' && (
          <>
          <MaterialIntakeWorkspace
            statusLabel={stageHasTask ? undefined : statusLabel}
            modelSetupIssue={modelSetupIssue}
            onOpenModelSetup={onOpenModelSetup}
            runId={draft.runId}
            writingMode={draft.writingMode}
            topic={draft.topic}
            onWritingModeChange={(writingMode) => onDraftChange({ writingMode })}
            onTopicChange={(topic) => onDraftChange({ topic })}
            onMaterialCorrected={onMaterialCorrected}
            onReviewExistingPlan={draft.artifactPaths['topic-template'] ? onReviewExistingPlan : undefined}
            materialText={materialText}
            links={materialLinks}
            uploadedFiles={materialFiles}
            analysis={materialAnalysis}
            analysisStale={materialAnalysisStale}
            selectedTypeId={selectedMaterialTypeId}
            selectedStructureId={selectedMaterialStructureId}
            selectedPlatforms={draft.selectedPlatforms}
            busy={busy}
            onMaterialTextChange={onMaterialTextChange}
            onLinksChange={onMaterialLinksChange}
            onFilesChange={onMaterialFilesChange}
            onUploadFiles={onUploadMaterialFiles}
            onRetryFileExtraction={onRetryMaterialFileExtraction}
            onAnalyze={onAnalyzeMaterial}
            onStartNewPeriod={onStartNewMaterialPeriod}
            onInitializeDirection={onInitializeMaterialDirection}
            onSelectType={onSelectMaterialType}
            onSelectStructure={onSelectMaterialStructure}
            onSelectedPlatformsChange={onSelectedPlatformsChange}
            onStartResearch={onStartResearch}
          />
          {draft.runId && draft.approved['material-boundary'] && materialInputFingerprint && <div className="mt-5">
            <DraftPreferenceReuse runId={draft.runId} inputFingerprint={materialInputFingerprint} disabled={busy || materialAnalysisStale} />
          </div>}
          </>
        )}

        {stageId === 'topic-template' && (
          draft.runId && artifactPath && onWritingBriefSaved && onWritingBriefConfirmed ? (
            <WritingBriefReview key={draft.runId} runId={draft.runId} templateId={draft.template} busy={busy} onSaved={onWritingBriefSaved} onConfirmed={onWritingBriefConfirmed} onViewSavedContent={draft.artifactPaths['content-package'] ? onViewSavedContent : undefined} />
          ) : draft.writingMode === 'author_material' ? (activeTask?.kind === 'author-blueprint' ? null : <p className="mt-5 text-sm leading-6">本期按你的题目写，未进行平台研究。请返回素材页核对题目与素材，开始生成方案。</p>) : researchSubview === 'topics' ? (
            <TopicTemplateConfirmation
              runId={draft.runId}
              modelSetupIssue={modelSetupIssue}
              modelSetupHandledByTask={modelSetupHandledByTask}
              suggestions={topicSuggestions}
              loading={suggestionsLoading}
              error={suggestionsError}
              researchAvailable={researchAvailable}
              onReload={onShowTopicSuggestions}
              onViewSamples={onViewResearchSamples}
              selectedSuggestionId={selectedTopicSuggestionId}
              topic={draft.topic}
              templates={brandTemplates}
              selectedTemplateId={draft.template}
              selectedPlatformLabels={selectedPlatformLabels}
              busy={busy || brandTemplatesLoading}
              onSelectSuggestion={onSelectTopicSuggestion}
              onTopicChange={(topic) => onDraftChange({ topic })}
              onSelectTemplate={(template) => onDraftChange({ template })}
              onConfirm={onConfirmTopicAndBuildBlueprint}
            />
          ) : (
            <TikOmniSampleBrowser
              onlyProvidedPlatforms
              platforms={PRODUCTION_PLATFORMS.filter((platform) => draft.selectedPlatforms.includes(platform.id)).map((platform) => ({
                id: platform.id === 'wechat' ? 'wechat_mp' : platform.id === 'xhs' ? 'xiaohongshu' : 'wechat_channels',
                label: platform.label,
              }))}
              sampleRows={researchSampleRows}
              overview={researchOverview}
              platformTotals={researchPlatformTotals}
              filters={researchFilters}
              sort={researchSort}
              onFiltersChange={onResearchFiltersChange}
              onSortChange={onResearchSortChange}
              onContinue={onShowTopicSuggestions}
              busy={busy}
            />
          )
        )}

        {stageId === 'content-package' && (
          <div className="space-y-5">
            {draft.runId && draft.artifactPaths['content-package'] && <WritingRequirementsReview runId={draft.runId}
              path={draft.artifactPaths['content-package']} refreshKey={`${draft.artifactPaths['content-package']}:${materialAnalysisStale}`} />}
            {draft.runId && <ContentAttemptRecovery
              key={draft.runId}
              runId={draft.runId}
              generating={activeTask?.kind === 'content-package' && (activeTask.status === 'queued' || activeTask.status === 'running')}
              disabled={busy || revisionBusy || Boolean(inlineHost)}
              refreshKey={`${activeTask?.taskId || ''}:${activeTask?.status || ''}:${draft.artifactPaths['content-package'] || ''}`}
              onVersionChange={onContentVersionChange}
              onBusyChange={setRecoveryBusy}
            />}
            {draft.runId && draft.artifactPaths['content-package'] && draft.artifactPaths['topic-template'] && (
              <ContentPlanNotice
                key={`${draft.runId}:${draft.artifactPaths['content-package']}:${draft.artifactPaths['topic-template']}`}
                runId={draft.runId}
                packagePath={draft.artifactPaths['content-package']}
                blueprintPath={draft.artifactPaths['topic-template']}
                disabled={busy || revisionBusy || recoveryBusy || Boolean(inlineHost)}
                onReviewChange={onContentPlanReviewChange}
                onEditEnding={onContentVersionChange ? () => {
                  if (inlineHost) return;
                  setInlineEditor(null);
                  revisionActionsRef.current?.selectEnding();
                  if (editorRef.current) {
                    editorRef.current.open = true;
                    editorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                } : undefined}
              />
            )}
            <ContentPackageReview
              packagePath={draft.artifactPaths['content-package']}
              checked={contentReviewChecks(reviewAssertions)}
              onChange={(unit, checked) => {
                const assertion = CONTENT_REVIEW_ASSERTION_BY_UNIT[unit];
                if (assertion) onReviewAssertionChange(assertion, checked);
              }}
              onReadyChange={onContentReviewReadyChange}
              readerEditing={Boolean(inlineHost)}
              editDisabled={busy || revisionBusy || recoveryBusy || Boolean(inlineHost)}
              onEditSelection={draft.runId && onContentVersionChange ? (request, host) => {
                revisionActionsRef.current?.selectText(request);
                setInlineEditor(host ? { path: request.path, host } : null);
                if (editorRef.current) editorRef.current.open = !host;
              } : undefined}
              onEditIssue={draft.runId && onContentVersionChange ? (request) => {
                setInlineEditor(null);
                revisionActionsRef.current?.selectIssue(request);
                if (editorRef.current) {
                  editorRef.current.open = true;
                  editorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              } : undefined}
              onEdit={draft.runId && onContentVersionChange ? () => {
                setInlineEditor(null);
                if (editorRef.current) {
                  editorRef.current.open = true;
                  editorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              } : undefined}
            />
            {draft.runId && draft.artifactPaths['content-package'] && onContentVersionChange && (
              <details ref={editorRef} className="rounded-lg border border-[#D8D1C9] p-3">
                <summary className="cursor-pointer text-sm font-semibold">{revisionBusy ? '正在修改，展开查看进度' : '修改稿件与检查提示'}</summary>
              <ContentRevisionEditor
                key={draft.runId}
                actionsRef={revisionActionsRef}
                showPublishingIssues={false}
                inlineTarget={inlineHost}
                onCloseInline={closeInlineEditor}
                onOpenFullEditor={() => {
                  setInlineEditor(null);
                  if (editorRef.current) {
                    editorRef.current.open = true;
                    editorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    requestAnimationFrame(() => editorRef.current?.querySelector('summary')?.focus());
                  }
                }}
                runId={draft.runId}
                packagePath={draft.artifactPaths['content-package']}
                disabled={busy || recoveryBusy}
                onVersionChange={(path) => { setInlineEditor(null); onContentVersionChange(path); }}
                onBusyChange={setRevisionBusy}
              />
              </details>
            )}
            {!draft.artifactPaths['content-package'] && (
            <div className="grid gap-3 md:grid-cols-3">
              {PRODUCTION_PLATFORMS.filter((platform) => draft.selectedPlatforms.includes(platform.id)).map((platform) => (
                <div key={platform.id} className="rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] p-3">
                  {platform.id === 'wechat'
                    ? <FileText size={17} className="text-[#E85D4C]" />
                    : platform.id === 'xhs'
                      ? <PenLine size={17} className="text-[#E85D4C]" />
                      : <Send size={17} className="text-[#E85D4C]" />}
                  <p className="mt-3 text-[13px] font-bold text-[#1A1A1A]">{platform.label} · {platform.content}</p>
                  <p className="mt-1 text-[12px] leading-[1.55] text-[#6B6B6B]">
                    {draft.writingMode === 'author_material' ? `依据已确认素材准备${platform.label}内容，本期未进行平台研究。` : platform.id === 'wechat'
                      ? '基于公众号样本独立确定标题、结构与正文'
                      : platform.id === 'xhs'
                        ? '基于小红书样本独立确定钩子、卡片结构与配文'
                        : '基于视频号样本独立确定口播、镜头、字幕和发布文案'}
                  </p>
                </div>
              ))}
            </div>
            )}
            <details open={!draft.artifactPaths['content-package']} className="rounded-lg border border-[#D8D1C9] p-3">
              <summary className="cursor-pointer text-sm font-semibold">{draft.artifactPaths['content-package'] ? '重新生成内容' : '生成初稿'}</summary>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-3 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-[#1A1A1A]">生成 {draft.selectedPlatforms.length} 条平台原生内容线</p>
                <p className="mt-1 text-[12px] leading-[1.55] text-[#6B6B6B]">系统会先生成、再按平台审稿并局部修订；每个平台只共享事实，不共享标题、结构或成稿。</p>
              </div>
              <ModelCallAction runId={draft.runId} refreshKey={`${busy}:${activeTask?.updatedAt || ''}`}>{(callUnavailable) => modelSetupIssue ? (modelSetupHandledByTask ? null : <div className="text-sm">
                <p className="mb-2 text-[#6B6B6B]">{modelSetupIssue} 已有方案和稿件会保留。</p>
                <Link href="/settings#model-connection" className="font-semibold underline underline-offset-4">连接写作服务后继续</Link>
              </div>) : <button
                type="button"
                onClick={onRunContentPackage}
                disabled={callUnavailable || busy || revisionBusy || recoveryBusy || !draft.approved['topic-template'] || !draft.artifactPaths['topic-template'] || !draft.runId}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[#1C1C1E] px-3 text-[12px] font-bold text-white transition-colors hover:bg-[#353535] disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
              >
                {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {draft.artifactPaths['content-package'] ? '重新生成已选平台内容' : '生成已选平台内容'}
              </button>}</ModelCallAction>
            </div>
            </details>
            <details>
              <summary className="cursor-pointer text-sm text-[#6B6B6B]">我的检查笔记</summary>
              <StageNote
                label="个人备注（不会用于改稿）"
                value={note}
                onChange={onNoteChange}
                placeholder="记录留给自己看的信息。要修改正文，请使用上方的改稿入口。"
                rows={3}
              />
            </details>
          </div>
        )}

        {stageId === 'visual-assets' && (
          <div className="space-y-3">
            {draft.selectedPlatforms.includes('wechat') && <p className="rounded-lg bg-[#FFF9EC] px-4 py-3 text-sm leading-relaxed text-[#6B5543]">公众号排版和换版会将本期文章发送给 md2wechat 服务，可能产生费用。首次生成失败可使用基础排版；换版失败保留原成品。排版费用不计入本期模型调用次数上限，实际扣费以服务方记录为准。</p>}
            {visualWorkbench ? (
              <VisualWorkbench
                state={visualWorkbench}
                onRequestRevision={onRequestVisualRevision}
                onAdoptAsset={onAdoptVisualAsset}
                onAdoptAllAssets={onAdoptAllVisualAssets}
                selectionNeedsReview={!approvalReady}
                onRegenerate={onRegenerateVisual}
                onReviewCopy={onViewSavedContent}
                regenerationPending={visualLoading || busy}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-[rgba(28,28,30,0.18)] bg-[#FDF8F3] px-4 py-5">
                <div className="flex items-start gap-2 text-[13px] leading-[1.6] text-[#6B6B6B]">
                  <CircleAlert size={16} className="mt-0.5 shrink-0 text-[#A66300]" />
                  <span>生成公众号全文排版和小红书 P1-P8 图文卡片。</span>
                </div>
                <button
                  type="button"
                  onClick={onGenerateVisual}
                  disabled={visualLoading || busy || !draft.artifactPaths['content-package']}
                  className="mt-4 inline-flex h-9 items-center gap-2 rounded-full bg-[#1C1C1E] px-3 text-[12px] font-bold text-white transition-colors hover:bg-[#353535] disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
                >
                  {visualLoading || busy ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  生成平台排版
                </button>
              </div>
            )}
          </div>
        )}

        {stageId === 'draft-information' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-3 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-[#1A1A1A]">
                  {hasCompleteFinalDeliverables(publicationQueue)
                    ? '发布成品已准备好'
                    : publicationQueue
                      ? '还有图片未准备好，请重新整理'
                      : '还没有整理发布成品'}
                </p>
                <p className="mt-1 text-[12px] text-[#6B6B6B]">本期只整理：{selectedDeliverySummary || '已选平台的原生成品'}。每个平台分别检查、分别发布。</p>
              </div>
              <button
                type="button"
                onClick={onPrepareDraftQueue}
                disabled={busy || !draft.artifactPaths['content-package']}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[#1C1C1E] px-3 text-[12px] font-bold text-white transition-colors hover:bg-[#353535] disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
              >
                {busy ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {publicationQueue ? '重新整理成品' : '整理发布成品'}
              </button>
            </div>
            {publicationQueue && (
              <FinalDeliverablesReview
                packagePath={draft.artifactPaths['content-package']}
                queue={publicationQueue}
                onReviewReadyChange={onDeliverableReviewReadyChange}
              />
            )}
          </div>
        )}

        {stageId === 'publication-result' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-[13px] text-[#6B6B6B]">
              <CheckCircle2 size={16} className="text-[#E85D4C]" />
              <span>本期交付：{selectedDeliverySummary || '已选平台的成品'}。你在平台发布后，再填写链接、时间或截图。</span>
            </div>
            {publicationQueue && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-3 py-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-bold text-[#1A1A1A]">准备平台草稿和口播稿</p>
                  <p className="mt-1 text-[12px] text-[#6B6B6B]">仅处理本期所选平台：图文内容填入平台草稿，口播稿与拍摄说明供下载。视频仍需自行拍摄，系统不会自动发布。</p>
                </div>
                <button
                  type="button"
                  onClick={onFillQueuedDrafts}
                  disabled={busy || !hasQueuedLocalDrafts(publicationQueue)}
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[#1C1C1E] px-3 text-[12px] font-bold text-white hover:bg-[#353535] disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
                >
                  {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}
                  准备草稿和口播稿
                </button>
              </div>
            )}
            {!publicationQueue && (
              <div className="rounded-lg border border-dashed border-[rgba(28,28,30,0.18)] bg-[#FDF8F3] px-4 py-5 text-[13px] text-[#6B6B6B]">请先在上一步整理并确认发布成品。</div>
            )}
            {publicationQueue?.jobs.map((job) => {
              const input = publicationInputs[job.job_id] || { url: '', proofPath: '', publishedAt: '', confirmed: false, unknownCompletionResolved: false };
              const status = jobStatusMeta(job);
              const canRecord = canRecordResult(job, input);
              const resourcePath = job.payload.execution_package_path || job.payload.copy_path || job.payload.html_path;
              return (
                <article key={job.job_id} className="rounded-lg border border-[rgba(28,28,30,0.1)] bg-white px-3 py-3 sm:px-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-bold text-[#1A1A1A]">{jobDisplayLabel(job)}</span>
                        <span className={`inline-flex rounded-md px-2 py-1 text-[11px] font-bold ${status.className}`}>{status.label}</span>
                      </div>
                      <p className="mt-1 text-[12px] text-[#6B6B6B]">{PLATFORM_DETAILS[job.platform].label} · {job.payload.title || '本期内容'}</p>
                      <p className="mt-1 text-[11px] text-[#8A8178]">{jobStatusDetail(job)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {resourcePath && (
                        <a
                          href={outputHref(resourcePath, 'view')}
                          target="_blank"
                          rel="noreferrer"
                          title="打开内容"
                          aria-label={`打开${jobDisplayLabel(job)}`}
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-[rgba(28,28,30,0.14)] text-[#6B6B6B] hover:border-[#E85D4C] hover:text-[#C94A3B]"
                        >
                          <ExternalLink size={14} />
                        </a>
                      )}
                      {resourcePath && job.delivery_kind === 'execution_package' && (
                        <OutputDownloadLink
                          href={outputHref(resourcePath, 'download')}
                          aria-label={`下载${jobDisplayLabel(job)}`}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgba(28,28,30,0.14)] px-2.5 text-[11px] font-bold text-[#6B6B6B] hover:border-[#E85D4C] hover:text-[#C94A3B]"
                        >
                          <FileDown size={14} />下载口播稿
                        </OutputDownloadLink>
                      )}
                      {(canPrepareLocalDraft(job) || canExplicitlyRetryLocalDraft(job)) && (
                        <button
                          type="button"
                          onClick={() => {
                            if (job.status === 'manual_intervention_required') {
                              setManualRetryJobId(job.job_id);
                              return;
                            }
                            onFillLocalDraft(job.job_id);
                          }}
                          disabled={busy}
                          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#1A1A1A] bg-[#1A1A1A] px-3 text-[11px] font-bold text-white hover:bg-[#333] disabled:opacity-50"
                        >
                          {busy ? <LoaderCircle size={13} className="animate-spin" /> : canExplicitlyRetryLocalDraft(job) ? <RefreshCw size={13} /> : <Send size={13} />}
                          {job.status === 'manual_intervention_required' ? '按提示处理后重试' : job.status === 'retryable_failure' ? '重试' : job.delivery_kind === 'execution_package' ? '准备口播稿' : '填入草稿'}
                        </button>
                      )}
                      {canRecord && (
                        <button
                          type="button"
                          onClick={() => setRecordingJobId((current) => current === job.job_id ? '' : job.job_id)}
                          aria-expanded={recordingJobId === job.job_id}
                          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#1A1A1A] bg-white px-3 text-[11px] font-bold text-[#1A1A1A] hover:border-[#E85D4C] hover:text-[#C94A3B]"
                        >
                          <PenLine size={13} />
                          {recordingJobId === job.job_id ? '收起记录' : '记录发布'}
                        </button>
                      )}
                      {job.delivery_kind === 'draft_fill' && job.status === 'published_confirmed' && <CheckCircle2 size={18} className="text-[#16803C]" aria-label="已确认发布" />}
                      {job.delivery_kind === 'execution_package' && job.status === 'draft_filled' && <CheckCircle2 size={18} className="text-[#16803C]" aria-label="口播稿可下载" />}
                    </div>
                  </div>

                  {job.status === 'manual_intervention_required' && manualRetryJobId === job.job_id && (
                    <div role="alert" className="mt-3 rounded-lg border border-[#E4A43B] bg-[#FFF8E8] px-3 py-3">
                      <p className="text-[12px] font-bold text-[#6B5543]">确认手动操作已完成</p>
                      <p className="mt-1 text-[11px] leading-[1.55] text-[#6B5543]">请先完成登录、验证码、设备确认或本机连接，再重试这一项。系统仍只会填入草稿，不会点击公开发送。</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={() => setManualRetryJobId('')} className="inline-flex h-8 items-center justify-center rounded-full border border-[#D8C7B3] bg-white px-3 text-[11px] font-bold text-[#6B5543] hover:border-[#A66300]">取消</button>
                        <button type="button" onClick={() => { setManualRetryJobId(''); onFillLocalDraft(job.job_id); }} className="inline-flex h-8 items-center justify-center rounded-full bg-[#8D5A00] px-3 text-[11px] font-bold text-white hover:bg-[#704700]">已完成手动操作，继续重试</button>
                      </div>
                    </div>
                  )}

                  <TechnicalDetails className="mt-3">
                    <TechnicalDetailList items={[
                      { label: '发布项编号', value: job.job_id },
                      { label: '原始状态', value: job.status },
                      ...(job.payload_hash ? [{ label: '内容校验值', value: job.payload_hash }] : []),
                      ...(resourcePath ? [{ label: '内容文件', value: resourcePath }] : []),
                    ]} />
                  </TechnicalDetails>

                  {canRecord && recordingJobId === job.job_id && (
                    <div className="mt-3 grid gap-3 border-t border-[rgba(28,28,30,0.08)] pt-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] xl:items-end">
                      <div>
                        <label className="block">
                          <span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold text-[#6B6B6B]"><Link2 size={12} />发布链接（可选）</span>
                          <input
                            value={input.url}
                            onChange={(event) => onPublicationInputChange(job.job_id, { url: event.target.value })}
                            placeholder="https://..."
                            className="h-9 w-full rounded-md border border-[rgba(28,28,30,0.14)] px-3 text-[12px] outline-none focus:border-[#E85D4C]"
                          />
                        </label>
                      </div>
                      <div>
                        <label className="block">
                          <span className="mb-1.5 block text-[11px] font-bold text-[#6B6B6B]">发布时间</span>
                          <input
                            type="datetime-local"
                            value={input.publishedAt}
                            onChange={(event) => onPublicationInputChange(job.job_id, { publishedAt: event.target.value })}
                            className="h-9 w-full rounded-md border border-[rgba(28,28,30,0.14)] px-3 text-[12px] outline-none focus:border-[#E85D4C]"
                          />
                        </label>
                      </div>
                      <div>
                        <label className="block">
                          <span className="mb-1.5 block text-[11px] font-bold text-[#6B6B6B]">截图文件位置（可选）</span>
                          <input
                            value={input.proofPath}
                            onChange={(event) => onPublicationInputChange(job.job_id, { proofPath: event.target.value })}
                            placeholder="粘贴截图文件位置"
                            className="h-9 w-full rounded-md border border-[rgba(28,28,30,0.14)] px-3 text-[12px] outline-none focus:border-[#E85D4C]"
                          />
                        </label>
                      </div>
                      <div>
                        <label className="flex h-9 items-center gap-2 whitespace-nowrap text-[12px] text-[#6B6B6B]">
                          <input
                            type="checkbox"
                            checked={input.confirmed}
                            onChange={(event) => onPublicationInputChange(job.job_id, { confirmed: event.target.checked })}
                            className="h-4 w-4 accent-[#E85D4C]"
                          />
                          <span>已在平台发送</span>
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() => onSavePublicationResult(job.job_id)}
                        disabled={busy || !input.confirmed || !input.publishedAt || (!input.url.trim() && !input.proofPath.trim()) || !canRecord}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-[#1A1A1A] bg-[#1A1A1A] px-3 text-[11px] font-bold text-white hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? <LoaderCircle size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                        保存发布结果
                      </button>
                    </div>
                  )}

                  {job.status === 'unknown_completion' && (
                    <label className="mt-3 flex items-center gap-2 border-t border-[rgba(28,28,30,0.08)] pt-3 text-[12px] text-[#6B6B6B]">
                      <input
                        type="checkbox"
                        checked={input.unknownCompletionResolved}
                        onChange={(event) => onPublicationInputChange(job.job_id, { unknownCompletionResolved: event.target.checked })}
                        className="h-4 w-4 accent-[#E85D4C]"
                      />
                      <span>我已在平台中检查这一项</span>
                    </label>
                  )}
                </article>
              );
            })}
            <StageNote
              label="发布记录"
              value={note}
              onChange={onNoteChange}
              placeholder="可以记录问题、负责人或之后需要回看的信息。"
              rows={3}
            />
          </div>
        )}

        {stageId === 'weekly-review' && (
          <div className="space-y-5">
            <div className="grid gap-3 md:grid-cols-3">
              {[
                ['表现', '阅读、互动、收藏与转化'],
                ['反馈', '高频问题、反对意见与私信'],
                ['下一轮', '继续、调整或停止的依据'],
              ].map(([label, detail]) => (
                <div key={label} className="rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] p-3">
                  <p className="text-[13px] font-bold text-[#1A1A1A]">{label}</p>
                  <p className="mt-1 text-[12px] leading-[1.6] text-[#6B6B6B]">{detail}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-3 rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-[680px] text-[12px] leading-[1.6] text-[#6B6B6B]">填写本周的阅读、互动和用户反馈，会得到下一次选题和改进建议。这一步可以跳过。</p>
              <a href="/weekly-review" className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border border-[#1A1A1A] bg-[#1A1A1A] px-3 text-[12px] font-bold text-white hover:bg-[#353535]">
                <ExternalLink size={14} />去填写本周复盘
              </a>
            </div>
          </div>
        )}
      </div>

      {artifactPath && stageId !== 'material-boundary' && (
        <div className="mt-5 space-y-2">
          <a
            href={outputHref(artifactPath, 'view')}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-[rgba(28,28,30,0.12)] bg-[#FDF8F3] px-3 py-2 text-[11px] font-bold text-[#6B6B6B] hover:border-[#E85D4C] hover:text-[#C94A3B]"
          >
            <ExternalLink size={13} className="shrink-0" />
            打开生成结果
          </a>
          <TechnicalDetails>
            <TechnicalDetailList items={[{ label: '结果文件', value: artifactPath }]} />
          </TechnicalDetails>
        </div>
      )}

      {stageId !== 'material-boundary' && stageId !== 'topic-template' && stageId !== 'weekly-review' && (
        <StageFooter
          preparationMessage={visualPreparedStatus === '排版需调整' ? '请先处理上方的排版问题' : visualPreparedStatus ? '选择平台成品后再确认' : undefined}
          stageId={stageId}
          approved={approved}
          approvalMode={approvalMode}
          busy={busy || revisionBusy || recoveryBusy}
          canConfirm={canConfirm}
          approvalReady={approvalReady}
          onConfirm={onConfirm}
        />
      )}
    </section>
  );
}

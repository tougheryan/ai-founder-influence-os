'use client';

import { ModelCallAction } from './ModelCallAction';

import { MaterialCorrectionEditor } from './MaterialCorrectionEditor';
import type { MaterialAnalysisContext } from '@/lib/material-analysis';
import { materialTitleSuggestion } from '@/lib/material-title-suggestion';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleAlert,
  FileText,
  FileUp,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  MATERIAL_TYPE_CATALOG as MATERIAL_DIRECTION_CATALOG,
  type MaterialTypeDefinition,
} from '@/lib/material-direction';
import type {
  MaterialIntakeAnalysis,
  MaterialSourceRead,
  MaterialUpload,
} from '@/lib/material-analysis';
import {
  PRODUCTION_PLATFORMS,
  type ProductionPlatform,
} from './production-model';

export type {
  MaterialStructure,
  MaterialTypeDefinition,
  MaterialTypeId,
} from '@/lib/material-direction';
export type { MaterialIntakeAnalysis, MaterialUpload } from '@/lib/material-analysis';

const MATERIAL_TYPE_COPY: Record<string, { title: string; description: string; structures: Record<string, { title: string; description: string }> }> = {
  'personal-experience': {
    title: '职业经验与方法',
    description: '适合写职业经历、工作方法和行业看法。',
    structures: {
      'experience-turn-method': { title: '从经历到方法', description: '从一段真实经历说起，再总结出能复用的做法。' },
      'review-decision-principle': { title: '从问题复盘到做法', description: '复盘一个问题，说明当时怎么选、以后怎么做。' },
      'judgement-case-action': { title: '先说判断，再讲案例', description: '先给出看法，再用案例说明。' },
    },
  },
  'interview-event': {
    title: '访谈与活动',
    description: '适合整理访谈、演讲和活动现场。',
    structures: {
      'scene-viewpoint-interpretation': { title: '从现场故事讲到观点', description: '从一个现场片段说起，再解释其中的观点。' },
      'quote-collision-stance': { title: '围绕一句话展开', description: '从嘉宾的一句话出发，讲清楚自己的看法。' },
      'issue-dialogue-conclusion': { title: '从讨论到结论', description: '保留讨论过程，并给出下一步做法。' },
    },
  },
  'personal-growth': {
    title: '个人成长',
    description: '适合写转折、选择、压力和恢复。',
    structures: {
      'difficulty-turn-choice': { title: '一次困境和选择', description: '讲清楚遇到了什么，以及为什么换了一种选择。' },
      'pressure-repair-longterm': { title: '一次失败和恢复', description: '写出低谷、恢复过程和留下的经验。' },
      'life-question-story-resonance': { title: '用经历回答一个问题', description: '用自己的经历回应读者也会遇到的问题。' },
    },
  },
  'work-life-vlog': {
    title: '工作与生活记录',
    description: '适合记录出差、会议、拜访和日常工作。',
    structures: {
      'scene-detail-judgement': { title: '从一个细节说起', description: '抓住一个现场细节，再讲它说明了什么。' },
      'work-problem-solution': { title: '记录解决问题的过程', description: '按发生顺序写清问题和解决办法。' },
      'behind-method-insight': { title: '从幕后过程总结经验', description: '记录事情怎么做完，再总结能留下的经验。' },
    },
  },
  'business-growth': {
    title: '业务与客户案例',
    description: '适合讲客户问题、产品价值和服务过程。',
    structures: {
      'customer-question-method': { title: '用方法回答一个问题', description: '先讲判断依据，再给做法和适用范围。' },
      'customer-solution-case-cta': { title: '客户问题和解决办法', description: '从客户的问题说起，讲清解决办法和下一步。' },
      'business-product-conversion': { title: '业务判断和转化路径', description: '说明为什么这样做，以及客户如何继续行动。' },
      'growth-mistake-mechanism-list': { title: '常见误区和行动清单', description: '指出常见错误，再给出具体做法。' },
    },
  },
  'global-expression': {
    title: '出海与跨境',
    description: '适合面向海外用户，或讨论不同市场和文化。',
    structures: {
      'global-change-local-action': { title: '海外变化对本地的影响', description: '说明外部变化会带来什么，以及可以怎么做。' },
      'crossculture-case-adaptation': { title: '跨文化案例和适配方法', description: '对比不同文化中的做法，再说明如何调整。' },
      'global-trend-market-opportunity': { title: '趋势判断和市场机会', description: '先讲趋势，再说明值得关注的机会。' },
    },
  },
};

export const MATERIAL_TYPE_CATALOG: readonly MaterialTypeDefinition[] = MATERIAL_DIRECTION_CATALOG.map((type) => {
  const copy = MATERIAL_TYPE_COPY[type.id];
  return {
    ...type,
    title: copy.title,
    description: copy.description,
    structures: type.structures.map((structure) => ({
      ...structure,
      ...copy.structures[structure.id],
    })),
  };
});

export type MaterialIntakeWorkspaceProps = {
  statusLabel?: string;
  modelSetupIssue?: string | null;
  onOpenModelSetup?: () => void;
  writingMode?: 'platform' | 'author_material';
  topic?: string;
  onWritingModeChange?: (mode: 'platform' | 'author_material') => void;
  onTopicChange?: (topic: string) => void;
  runId?: string;
  onReviewExistingPlan?: () => void;
  onMaterialCorrected?: (context: MaterialAnalysisContext) => void;
  materialText: string;
  links: string[];
  uploadedFiles: MaterialUpload[];
  analysis: MaterialIntakeAnalysis | null;
  analysisStale: boolean;
  selectedTypeId: string;
  selectedStructureId: string;
  selectedPlatforms: ProductionPlatform[];
  busy: boolean;
  onMaterialTextChange: (value: string) => void;
  onLinksChange: (links: string[]) => void;
  onFilesChange: (files: MaterialUpload[]) => void;
  onUploadFiles: (files: File[]) => Promise<MaterialUpload[]>;
  onRetryFileExtraction: (file: MaterialUpload) => Promise<MaterialUpload>;
  onAnalyze: () => Promise<void>;
  onStartNewPeriod: () => Promise<void>;
  onInitializeDirection: (typeId: string, structureId: string) => void;
  onSelectType: (typeId: string) => void;
  onSelectStructure: (structureId: string) => void;
  onSelectedPlatformsChange: (platforms: ProductionPlatform[]) => void;
  onStartResearch: () => void;
};

function catalogType(typeId: string): MaterialTypeDefinition | undefined {
  return MATERIAL_TYPE_CATALOG.find((type) => type.id === typeId);
}

/** Choosing this suggestion only fills the form; continuing is a separate action. */
export function MaterialTitleSuggestion({
  materialText, topic = '', writingMode = 'platform', busy, analysisStale,
  onTopicChange, onWritingModeChange,
}: Pick<MaterialIntakeWorkspaceProps,
  'materialText' | 'topic' | 'writingMode' | 'busy' | 'analysisStale' | 'onTopicChange' | 'onWritingModeChange'
>) {
  const suggestedTitle = topic.trim() || analysisStale ? null : materialTitleSuggestion(materialText);
  if (!suggestedTitle || !onTopicChange || !onWritingModeChange) return null;
  return (
    <div className="rounded-lg border border-[#E5DDD6] bg-white p-3 text-[13px] leading-[1.65]">
      <p className="text-[#746D67]">素材里已有题目，是否沿用？</p>
      <p className="mt-1 break-words font-semibold text-[#1A1A1A]">{suggestedTitle}</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          onTopicChange(suggestedTitle);
          if (writingMode !== 'author_material') onWritingModeChange('author_material');
        }}
        className="mt-2 inline-flex min-h-10 items-center rounded border border-[#D8D1C9] px-3 font-semibold text-[#4F4A45] hover:border-[#E85D4C] disabled:cursor-not-allowed disabled:opacity-50"
      >使用素材里的题目</button>
      <p className="mt-2 text-[12px] text-[#746D67]">带入后可以修改；按自己的题目写，不采集平台数据。确认素材后才生成方案。</p>
    </div>
  );
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes < 1) return '未上传';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractionStatusLabel(file: MaterialUpload): string {
  if (file.extractionStatus === 'transcribing') return '正在转成文字';
  if (file.extractionStatus === 'needs_transcription') return '未读出内容';
  if (file.extractionStatus === 'audio_transcribed') return '已转成文字';
  if (file.extractionStatus === 'text_extracted') return '已读取';
  return '';
}

function materialFileKey(file: MaterialUpload, index: number): string {
  return `${file.sourcePath || file.path || file.name}-${index}`;
}

export function isValidReferenceUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function sourceStatusMeta(status: MaterialSourceRead['status']) {
  switch (status) {
    case 'read':
      return { label: '已读取', className: 'bg-[#EDF8F0] text-[#16803C]' };
    case 'needs_input':
      return { label: '需要补充', className: 'bg-[#FFF8E8] text-[#8D5A00]' };
    case 'failed':
      return { label: '读取失败', className: 'bg-[#FFF1EE] text-[#B43C2E]' };
  }
}

function sourceKindLabel(kind: MaterialSourceRead['kind']): string {
  if (kind === 'text') return '文字';
  if (kind === 'file') return '文件';
  return '链接';
}

function displaySourceDetail(detail: string): string {
  return detail
    .replace(/(?:pipeline|materials|runs)\/[\w./@-]+/gi, '相关文件')
    .replace(/\b(?:run|task|asset|revision)[_-][A-Za-z0-9_-]+\b/gi, '相关记录')
    .replace(/OCR/gi, '图片文字')
    .replace(/解析/g, '读取');
}

function SourceLedger({ sources }: { sources: MaterialSourceRead[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="mt-5 border-t border-[rgba(28,28,30,0.1)] pt-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-[14px] font-bold text-[#1A1A1A]">素材读取情况</h3>
        <p className="text-[12px] text-[#8A8178]">仅供本期核对，不会写入成稿</p>
      </div>
      <ul className="mt-3 divide-y divide-[rgba(28,28,30,0.08)] border-y border-[rgba(28,28,30,0.08)]">
        {sources.map((source) => {
          const meta = sourceStatusMeta(source.status);
          return (
            <li key={source.id} className="min-w-0 px-1 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 shrink-0 text-[12px] font-bold text-[#8A8178]">{sourceKindLabel(source.kind)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-bold text-[#1A1A1A]" title={source.label}>{source.label}</p>
                  <p className="mt-1 text-[12px] leading-[1.55] text-[#6B6B6B]">{displaySourceDetail(source.detail)}</p>
                  {source.excerpt && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[12px] font-bold text-[#2763A6]">查看读取内容</summary>
                      <p className="mt-2 whitespace-pre-wrap border-l-2 border-[#F1D4CD] pl-2 text-[12px] leading-[1.65] text-[#4F4A45]">{source.excerpt}</p>
                    </details>
                  )}
                </div>
                <span className={`shrink-0 px-2 py-1 text-[12px] font-bold ${meta.className}`}>{meta.label}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function textItems(items: string[], emptyLabel: string) {
  if (items.length === 0) {
    return <p className="text-[12px] leading-[1.65] text-[#8A8178]">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={`${item}-${index}`} className="flex gap-2 text-[12px] leading-[1.65] text-[#4F4A45]">
          <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 bg-[#E85D4C]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function AnalysisLoading({ inputCount }: { inputCount: number }) {
  return (
    <section aria-live="polite" className="border-t border-[rgba(28,28,30,0.1)] pt-7">
      <div className="flex items-center gap-2 text-[13px] font-bold text-[#1A1A1A]">
        <LoaderCircle size={16} className="animate-spin text-[#E85D4C]" />
        正在整理素材
      </div>
      <div className="mt-3 space-y-2 text-[12px] leading-[1.6] text-[#6B6B6B]">
        <p className="animate-pulse">正在读取 {inputCount} 项素材</p>
        <p className="animate-pulse">正在找出事实、案例和需要确认的内容</p>
      </div>
    </section>
  );
}

export function MaterialIntakeWorkspace({
  statusLabel,
  modelSetupIssue, onOpenModelSetup,
  runId, onMaterialCorrected, onReviewExistingPlan,
  writingMode = 'platform', topic = '', onWritingModeChange, onTopicChange,
  materialText,
  links,
  uploadedFiles,
  analysis,
  analysisStale,
  selectedTypeId,
  selectedStructureId,
  selectedPlatforms,
  busy,
  onMaterialTextChange,
  onLinksChange,
  onFilesChange,
  onUploadFiles,
  onRetryFileExtraction,
  onAnalyze,
  onStartNewPeriod,
  onInitializeDirection,
  onSelectedPlatformsChange,
  onStartResearch,
}: MaterialIntakeWorkspaceProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastAppliedAnalysisKey = useRef<string>('');
  const [inputError, setInputError] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [retryingFileKey, setRetryingFileKey] = useState('');
  const [showLinkErrors, setShowLinkErrors] = useState(false);

  const filledLinks = links.filter((link) => link.trim());
  const validLinks = filledLinks.filter(isValidReferenceUrl);
  const invalidLinkIndexes = links.flatMap((link, index) => (
    link.trim() && !isValidReferenceUrl(link) ? [index] : []
  ));
  const hasInput = Boolean(materialText.trim() || validLinks.length > 0 || uploadedFiles.length > 0);
  const inputCount = Number(Boolean(materialText.trim())) + uploadedFiles.length + validLinks.length;
  const inputSummary = [
    materialText.trim() ? `文字 ${materialText.trim().length.toLocaleString()} 字` : '',
    uploadedFiles.length ? `文件 ${uploadedFiles.length} 项` : '',
    validLinks.length ? `链接 ${validLinks.length} 条` : '',
  ].filter(Boolean);
  const interactionLocked = busy || isAnalyzing;
  const sources = analysis?.sources || [];
  const hasReadableSource = sources.length === 0 || sources.some((source) => source.status === 'read');
  const hasBlockedFile = sources.some((source) => source.kind === 'file' && source.status !== 'read');
  const needsModelSetup = writingMode === 'author_material' && Boolean(modelSetupIssue);
  const canStartResearch = Boolean(
    analysis
    && !analysisStale
    && invalidLinkIndexes.length === 0
    && hasReadableSource
    && !hasBlockedFile
    && !needsModelSetup
    && (writingMode !== 'author_material' || Boolean(topic.trim()))
    && !interactionLocked,
  );

  useEffect(() => {
    if (!analysis || analysisStale) {
      lastAppliedAnalysisKey.current = '';
      return;
    }
    const type = catalogType(selectedTypeId)
      || catalogType(analysis.recommendedTypeId)
      || MATERIAL_TYPE_CATALOG[0];
    const structure = type.structures.find((item) => item.id === selectedStructureId)
      || type.structures.find((item) => item.id === analysis.recommendedStructureId)
      || type.structures[0];
    const key = [analysis.recommendedTypeId, analysis.recommendedStructureId, analysis.summary, selectedTypeId, selectedStructureId].join('|');
    if (lastAppliedAnalysisKey.current === key) return;
    lastAppliedAnalysisKey.current = key;

    if (selectedTypeId !== type.id || selectedStructureId !== structure.id) {
      onInitializeDirection(type.id, structure.id);
    }
  }, [analysis, analysisStale, onInitializeDirection, selectedStructureId, selectedTypeId]);

  const handleAnalyze = async () => {
    if (invalidLinkIndexes.length > 0) {
      setShowLinkErrors(true);
      setInputError('有参考链接格式不正确。请改为以 http:// 或 https:// 开头的完整链接，或移除该项。');
      return;
    }
    if (!hasInput) {
      setInputError('请先粘贴文字、添加文件或补充一条参考链接。');
      return;
    }
    setInputError('');
    setIsAnalyzing(true);
    try {
      await onAnalyze();
    } catch {
      // The parent owns operational errors and presents them in the workbench notice.
    } finally {
      setIsAnalyzing(false);
    }
  };

  const updateLink = (index: number, value: string) => {
    const next = links.length === 0 ? [''] : [...links];
    next[index] = value;
    if (showLinkErrors && (!value.trim() || isValidReferenceUrl(value))) {
      setInputError('');
    }
    onLinksChange(next.slice(0, 5));
  };

  const removeLink = (index: number) => {
    onLinksChange(links.filter((_, itemIndex) => itemIndex !== index));
  };

  const addLink = () => {
    if (links.length >= 5) return;
    onLinksChange([...links, '']);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const remaining = 20 - uploadedFiles.length;
    if (remaining <= 0) {
      setInputError('本期最多保留 20 个文件。请移除不需要的文件后再添加。');
      return;
    }
    const selectedFiles = Array.from(files).slice(0, remaining);
    try {
      const uploaded = await onUploadFiles(selectedFiles);
      onFilesChange([...uploadedFiles, ...uploaded]);
      setInputError(files.length > remaining ? `本期最多保留 20 个文件，已先导入前 ${remaining} 个。` : '');
    } catch {
      setInputError('文件暂时无法导入，请检查文件格式或大小后重试。');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRetryFileExtraction = async (file: MaterialUpload, index: number) => {
    const key = materialFileKey(file, index);
    setInputError('');
    setRetryingFileKey(key);
    try {
      const retried = await onRetryFileExtraction(file);
      onFilesChange(uploadedFiles.map((candidate, candidateIndex) => (
        candidateIndex === index ? retried : candidate
      )));
    } catch (error) {
      setInputError(displaySourceDetail(error instanceof Error ? error.message : '系统暂时无法重新读取该文件。'));
    } finally {
      setRetryingFileKey('');
    }
  };

  const linkRows = links.length > 0 ? links : [''];

  return (
    <div className="space-y-7" aria-busy={interactionLocked}>
      <section aria-labelledby="material-input-heading" className="aifios-material-intake rounded-xl border border-[#ECE5DF] bg-[#FCFBF9] p-4 sm:p-5">
        <div className="aifios-material-intake__header flex flex-col gap-3 border-b border-[#ECE5DF] pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="material-input-heading" className="text-[18px] font-bold text-[#1A1A1A]">添加本期素材</h2>
              {statusLabel && <span className="rounded-md bg-[#F2F5ED] px-2 py-1 text-xs text-[#4F5944]">{statusLabel}</span>}
            </div>
            <p className="mt-1 text-[13px] leading-[1.6] text-[#746D67]">把笔记、访谈、案例或链接放进来，系统会整理出能用的内容和写法。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {hasInput || analysis ? (
              <button
                type="button"
                onClick={() => void onStartNewPeriod().catch((error) => setInputError(error instanceof Error ? error.message : '草稿未能保存，请重试。'))}
                disabled={interactionLocked}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-[#E5DDD6] bg-white px-3.5 text-[13px] font-bold text-[#6B6B6B] transition-colors hover:border-[#E85D4C] hover:text-[#C94A3B] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={15} />保留并新建
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleAnalyze()}
              disabled={interactionLocked || !hasInput}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-[#1C1C1E] px-4 text-[13px] font-bold text-white transition-colors hover:bg-[#353535] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
            >
              {isAnalyzing ? <LoaderCircle size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {analysisStale ? '重新整理' : '整理素材'}
            </button>
          </div>
        </div>

        <div className="aifios-material-input-grid mt-6 grid min-w-0 grid-cols-1 gap-4">
          <label className="aifios-material-editor flex min-h-[430px] min-w-0 flex-col rounded-lg border border-[#ECE5DF] bg-white p-4">
            <span className="flex items-center gap-2 text-[15px] font-bold text-[#1A1A1A]">
              <FileText size={17} className="text-[#E85D4C]" />
              粘贴文字
            </span>
            <span className="mt-1 block text-[12px] leading-[1.55] text-[#746D67]">笔记、访谈逐字稿、案例、观点和事实均可，不需要先写主题。</span>
            <textarea
              value={materialText}
              onChange={(event) => onMaterialTextChange(event.target.value)}
              disabled={interactionLocked}
              placeholder="粘贴笔记、访谈逐字稿、案例、观点或事实材料。不需要先写主题。"
              rows={10}
              className="mt-4 block min-h-[240px] w-full flex-1 resize-y rounded-md border border-[#E7DED6] bg-[#FCFBF9] px-4 py-3 text-[14px] leading-[1.7] text-[#1A1A1A] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C] focus:ring-1 focus:ring-[#E85D4C] disabled:cursor-not-allowed disabled:bg-[#F7F3EE]"
            />
          </label>

          <details className="rounded-lg border border-[#ECE5DF] bg-white px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-bold text-[#4F4A45]">还没整理笔记？从一个问题说起</summary>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-[13px] leading-[1.65] text-[#746D67]">
              <li>最近，客户或同行反复问你什么？</li>
              <li>你通常怎么回答？有没有亲自处理过的过程可以讲？</li>
              <li>你希望谁读到这篇内容，读完做什么？</li>
            </ol>
            <p className="mt-3 text-[12px] leading-[1.6] text-[#746D67]">挑一个问题，在上面的输入框里用自己的话回答即可。不用写完整文章，也不必每项都填；只有观点、没有案例也可以开始。</p>
          </details>

          <details className="aifios-material-support min-w-0" open={uploadedFiles.length > 0 || filledLinks.length > 0 || undefined}>
            <summary className="cursor-pointer text-[14px] font-semibold text-[#4F4A45] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#52790C]">
              文件与参考链接{uploadedFiles.length || filledLinks.length ? ` · ${uploadedFiles.length} 个文件，${filledLinks.length} 条链接` : '（可选）'}
              {invalidLinkIndexes.length > 0 && <span className="ml-2 text-[#B43C2E]"> · 有链接待修正</span>}
              {uploadedFiles.some((file) => file.extractionStatus === 'needs_transcription' || file.extractionStatus === 'transcribing') && <span className="ml-2 text-[#A66300]"> · 有文件尚未读完</span>}
            </summary>
            <div className="mt-5">
            <section aria-labelledby="material-file-heading" className="aifios-material-tool flex min-w-0 flex-col">
              <h3 id="material-file-heading" className="flex items-center gap-2 text-[15px] font-bold text-[#1A1A1A]">
                <FileUp size={17} className="text-[#E85D4C]" />
                添加文件
              </h3>
              <p className="mt-1.5 text-[12px] leading-[1.65] text-[#746D67]">支持文档、图片、音频和表格；系统会先检查是否可读。</p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => void handleFiles(event.target.files)}
                accept=".txt,.md,.html,.htm,.json,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.rtf,.jpg,.jpeg,.png,.webp,.heic,.mp3,.m4a,.wav,.aac,.flac"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={interactionLocked}
                className="mt-4 inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-md border border-[#E5DDD6] bg-white px-3.5 text-[13px] font-bold text-[#1A1A1A] transition-colors hover:border-[#E85D4C] hover:bg-[#FFF8F6] hover:text-[#C94A3B] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={17} strokeWidth={2.25} />选择文件
              </button>
              {uploadedFiles.length > 0 ? (
                <ul className="mt-4 max-h-[220px] divide-y divide-[#F0E9E3] overflow-y-auto border-y border-[#F0E9E3]">
                  {uploadedFiles.map((file, index) => {
                    const fileKey = materialFileKey(file, index);
                    const retrying = retryingFileKey === fileKey;
                    return (
                    <li key={fileKey} className="flex min-w-0 items-center gap-2 py-2.5">
                      {file.extractionStatus === 'transcribing' ? (
                        <LoaderCircle size={15} className="shrink-0 animate-spin text-[#A66300]" />
                      ) : (
                        <FileText size={15} className="shrink-0 text-[#8A8178]" />
                      )}
                      <span className="min-w-0 flex-1 break-all text-[13px] leading-[1.5] text-[#4F4A45]" title={file.name}>{file.name}</span>
                      {extractionStatusLabel(file) && (
                        <span className={`shrink-0 text-[12px] font-bold ${file.extractionStatus === 'needs_transcription' || file.extractionStatus === 'transcribing' ? 'text-[#A66300]' : 'text-[#6B6B6B]'}`}>
                          {extractionStatusLabel(file)}
                        </span>
                      )}
                      <span className="shrink-0 text-[12px] text-[#8A8178]">{formatFileSize(file.size)}</span>
                      {file.extractionStatus === 'needs_transcription' && (
                        <button
                          type="button"
                          onClick={() => void handleRetryFileExtraction(file, index)}
                          disabled={interactionLocked || retrying}
                          className="inline-flex h-10 shrink-0 items-center gap-1.5 border border-[rgba(28,28,30,0.14)] bg-white px-2.5 text-[12px] font-bold text-[#6B6B6B] transition-colors hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`重新读取文件 ${file.name}`}
                          title="重新尝试自动读取"
                        >
                          {retrying ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                          <span className="hidden sm:inline">重新读取</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onFilesChange(uploadedFiles.filter((_, itemIndex) => itemIndex !== index))}
                        disabled={interactionLocked}
                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-[#8A8178] hover:bg-[#FFF1EE] hover:text-[#B43C2E] disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`移除文件 ${file.name}`}
                        title="移除文件"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="aifios-material-tool__empty mt-4 flex min-h-[72px] flex-1 items-center text-[13px] leading-[1.65] text-[#8A8178]">如果文件里没有读出文字，整理结果中会明确提示。</p>
              )}
              {uploadedFiles.some((file) => file.extractionStatus === 'needs_transcription') && (
                <p className="mt-3 text-[13px] leading-[1.55] text-[#8D5A00]">文件读取未完成时可以直接重试；如果仍然失败，可以补充图片中的文字或一段摘要。</p>
              )}
            </section>

            <section aria-labelledby="inspiration-link-heading" className="aifios-material-tool flex min-w-0 flex-col">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="inspiration-link-heading" className="flex items-center gap-2 text-[15px] font-bold text-[#1A1A1A]">
                    <Link2 size={17} className="text-[#E85D4C]" />
                    参考链接（最多 5 条）
                  </h3>
                  <p className="mt-1 text-[12px] leading-[1.55] text-[#746D67]">可以添加文章或视频链接。某个链接打不开时，仍可用其他素材继续。</p>
                </div>
                <span className="shrink-0 font-mono text-[12px] text-[#8A8178]">{validLinks.length}/5</span>
              </div>
              <div className="mt-3 space-y-2">
                {linkRows.map((link, index) => {
                  const invalid = Boolean(link.trim() && !isValidReferenceUrl(link) && (showLinkErrors || analysis));
                  return (
                  <div key={`link-${index}`}>
                    <div className="flex items-center gap-2">
                      <input
                        value={link}
                        onChange={(event) => updateLink(index, event.target.value)}
                        onBlur={() => {
                          if (link.trim() && !isValidReferenceUrl(link)) setShowLinkErrors(true);
                        }}
                        disabled={interactionLocked}
                        type="url"
                        inputMode="url"
                        placeholder="粘贴文章或视频链接"
                        aria-invalid={invalid || undefined}
                        aria-describedby={invalid ? `reference-link-error-${index}` : undefined}
                        className={`h-10 min-w-0 flex-1 rounded-md border bg-[#FCFBF9] px-3 text-[13px] text-[#1A1A1A] outline-none placeholder:text-[#AAA39B] focus:ring-1 disabled:cursor-not-allowed disabled:bg-[#F7F3EE] ${invalid ? 'border-[#D34A3A] focus:border-[#D34A3A] focus:ring-[#D34A3A]' : 'border-[#E7DED6] focus:border-[#E85D4C] focus:ring-[#E85D4C]'}`}
                      />
                      {(links.length > 1 || link) && (
                        <button
                          type="button"
                          onClick={() => removeLink(index)}
                          disabled={interactionLocked}
                          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#E7DED6] bg-white text-[#8A8178] transition-colors hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label="移除参考链接"
                          title="移除链接"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    {invalid && <p id={`reference-link-error-${index}`} className="mt-1 text-[11px] leading-[1.5] text-[#B43C2E]">请输入以 http:// 或 https:// 开头的完整链接。</p>}
                  </div>
                  );
                })}
              </div>
              {links.length > 0 && links.length < 5 && (
                <button
                  type="button"
                  onClick={addLink}
                  disabled={interactionLocked}
                  className="mt-2 inline-flex h-10 items-center gap-1.5 text-[13px] font-bold text-[#6B6B6B] transition-colors hover:text-[#C94A3B] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus size={13} />添加链接
                </button>
              )}
            </section>
            </div>
          </details>
        </div>

        {inputError && (
          <div role="alert" className="mt-4 flex items-start gap-2 border-l-[3px] border-[#D99124] bg-[#FFF8E8] px-3 py-2.5 text-[12px] leading-[1.6] text-[#8D5A00]">
            <CircleAlert size={15} className="mt-0.5 shrink-0" />
            <span>{inputError}</span>
          </div>
        )}

        {analysisStale && (
          <div role="status" aria-live="polite" className="mt-4 flex items-start gap-2 border-l-[3px] border-[#D99124] bg-[#FFF8E8] px-3 py-2.5 text-[12px] leading-[1.6] text-[#8D5A00]">
            <CircleAlert size={15} className="mt-0.5 shrink-0" />
            <span>{writingMode === 'author_material' ? '素材已更改。请重新整理后，再核对题目和写作要求。' : '素材已更改。请重新整理后，再查看同类内容。'}</span>
          </div>
        )}

        <div className="aifios-material-input-summary mt-5 flex flex-col gap-1 rounded-lg bg-[#FFF3F0] px-4 py-3 text-[12px] leading-[1.6] text-[#746D67]" aria-live="polite">
          <p className="font-bold text-[#4F4A45]">本次输入：{inputSummary.length > 0 ? inputSummary.join(' · ') : '尚未添加素材'}</p>
          <p>{hasInput ? '系统会先读取素材，再整理出只用于本期的结果。' : '至少添加一项素材后，即可开始整理。'}</p>
        </div>
      </section>

      {isAnalyzing && <AnalysisLoading inputCount={inputCount} />}

      {analysis && (
        <>
          <section aria-labelledby="analysis-heading" className={`border-t border-[rgba(28,28,30,0.1)] pt-7 ${analysisStale ? 'bg-[#FCFBF9]' : ''}`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-[#8A8178]">
                  <span className="font-mono text-[11px] font-bold">02</span>
                  <span className="h-px w-5 bg-[rgba(28,28,30,0.16)]" />
                  <span className="text-[11px] font-bold">整理结果</span>
                </div>
                <h2 id="analysis-heading" className="mt-2 text-[18px] font-bold text-[#1A1A1A]">素材里有什么</h2>
              </div>
              <span className="text-[12px] text-[#8A8178]">{analysisStale ? '素材已更改，请重新整理' : '只保存到本期'}</span>
            </div>

            {analysisStale ? (
              <div className="mt-4 max-w-[760px] border-l-[3px] border-[#D99124] bg-[#FFF8E8] px-3 py-3 text-[12px] leading-[1.65] text-[#8D5A00]" role="status">
                上次整理结果已失效，不会作为当前事实底稿，也不会进入后续选题和内容生成。请点击“重新整理”，核对新结果后再继续。
              </div>
            ) : (
              <>
              <p className="mt-4 max-w-[760px] text-[14px] leading-[1.75] text-[#303030]">{analysis.summary}</p>
              {runId && onMaterialCorrected ? <MaterialCorrectionEditor key={runId} runId={runId} analysis={analysis} disabled={interactionLocked} onSaved={onMaterialCorrected} /> : Boolean(analysis.authorRequirements?.length) && (
                <section aria-label="本期写作要求" className="mt-4 rounded-xl border border-[#DDE5D7] bg-[#F8FAF5] p-4">
                  <h3 className="text-sm font-semibold text-[#1A1A1A]">这次按你的要求写</h3>
                  <p className="mt-1 text-sm text-[#666]">请核对从素材中识别的要求；它们优先于系统推荐。需要调整时，可在下方直接修改整理结果。</p>
                  <ul className="mt-2 space-y-1 text-sm leading-relaxed text-[#303030]">
                    {analysis.authorRequirements?.map((requirement) => <li key={requirement}>{requirement}</li>)}
                  </ul>
                </section>
              )}
              <p className="mt-3 max-w-[760px] border-l-[3px] border-[#2763A6] bg-[#EEF5FF] px-3 py-2 text-[12px] leading-[1.6] text-[#315C87]">
                请核对下面的事实、案例和公开边界。继续写作不表示同意公开发布；“仅供内部使用”等限制应继续保留。系统不会把目标、禁令或待核验说法当成事实。
              </p>
            {onReviewExistingPlan && <div className="mt-3 text-sm leading-6"><p>这期已有写作方案。修正后可以直接核对，已有参考继续保留；只有需要新的参考时才重新研究。</p><button type="button" disabled={interactionLocked} onClick={onReviewExistingPlan} className="mt-2 font-semibold underline underline-offset-4">核对现有方案</button></div>}
            <SourceLedger sources={sources} />
            {Boolean(analysis.opinions?.length) && (
              <div className="mt-5 border-t border-[rgba(28,28,30,0.1)] pt-4">
                <h3 className="text-[12px] font-bold text-[#1A1A1A]">你想表达的观点</h3>
                <p className="mt-1 text-[12px] text-[#8A8178]">保留你的判断，后续写作时与事实依据分开。</p>
                <div className="mt-3">{textItems(analysis.opinions || [], '')}</div>
              </div>
            )}
            <div className="mt-5 grid gap-x-8 gap-y-5 border-t border-[rgba(28,28,30,0.1)] pt-4 md:grid-cols-2">
              <div>
                <h3 className="text-[12px] font-bold text-[#1A1A1A]">能用的事实</h3>
                <div className="mt-3">{textItems(analysis.facts, '暂未识别出需要单独列出的事实。')}</div>
              </div>
              <div>
                <h3 className="text-[12px] font-bold text-[#1A1A1A]">能用的案例</h3>
                <div className="mt-3">{textItems(analysis.cases, '暂未识别出真实案例。可以继续写观点或方法；需要案例时，请补充实际发生的过程，不必为了成稿编造。')}</div>
              </div>
            </div>
            {Boolean(analysis.illustrations?.length) && (
              <section aria-label="示例与待核实描述" className="mt-5 border-t border-[rgba(28,28,30,0.1)] pt-4">
                <h3 className="text-sm font-bold text-[#1A1A1A]">示例与待核实描述</h3>
                <p className="mt-1 text-[13px] leading-6 text-[#62584F]">这些摘录保留原文的模拟、虚构或待核实性质。如用于文章，需要说明其性质，不能当作真实客户案例或你的亲身经历。</p>
                <div className="mt-3">{textItems(analysis.illustrations || [], '')}</div>
              </section>
            )}
            <div className="mt-5 flex items-start gap-2 border-l-[3px] border-[#D99124] bg-[#FFF8E8] px-3 py-3">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#A66300]" />
              <div className="min-w-0">
                <h3 className="text-[12px] font-bold text-[#8D5A00]">需要注意</h3>
                <div className="mt-1.5">{textItems(analysis.risks, '尚未提取到公开限制，不代表已获授权。请补充不能公开的内容，或修改上方整理结果。')}</div>
              </div>
            </div>
              </>
            )}
          </section>

          <section aria-labelledby="next-step-heading" className={`border-t border-[rgba(28,28,30,0.1)] pt-7 ${analysisStale ? 'bg-[#FCFBF9]' : ''}`}>
            <div className="flex items-center gap-2 text-[#8A8178]">
              <span className="font-mono text-[11px] font-bold">03</span>
              <span className="h-px w-5 bg-[rgba(28,28,30,0.16)]" />
              <span className="text-[11px] font-bold">下一步</span>
            </div>
            <h2 id="next-step-heading" className="mt-2 text-[18px] font-bold text-[#1A1A1A]">选择这期要做的平台</h2>
            <p className="mt-3 max-w-[720px] text-[13px] leading-[1.7] text-[#6B6B6B]">
              {writingMode === 'author_material' ? '只为你选择的平台写作，依据本期素材，不进行平台研究。生成方案和正文会使用已连接的模型服务。' : '可以只选一个，也可以多选。系统只研究你选择的平台，并为每个平台独立确定选题和原生表达，不会从公众号文章改写其他平台。'}
            </p>

            {onWritingModeChange && <fieldset className="mt-5 space-y-3" disabled={interactionLocked}>
              <legend className="text-sm font-semibold">这次怎样开始</legend>
              <div className="flex flex-wrap gap-5 text-sm">
                <label><input type="radio" name="writing-mode" checked={writingMode === 'author_material'} onChange={() => onWritingModeChange('author_material')} /> 按我的题目写</label>
                <label><input type="radio" name="writing-mode" checked={writingMode === 'platform'} onChange={() => onWritingModeChange('platform')} /> 帮我找方向</label>
              </div>
              <MaterialTitleSuggestion
                materialText={materialText}
                topic={topic}
                writingMode={writingMode}
                busy={interactionLocked}
                analysisStale={analysisStale}
                onTopicChange={onTopicChange}
                onWritingModeChange={onWritingModeChange}
              />
              {writingMode === 'author_material' && <label className="block text-sm font-semibold">这期想写什么<input className="mt-2 block w-full rounded border border-[#D8D1C9] bg-white p-3 font-normal" value={topic} maxLength={240} onChange={(event) => onTopicChange?.(event.target.value)} placeholder="例如：客户说顺便改一下时，我会先确认什么" /></label>}
            </fieldset>}

            <div className="mt-5 grid gap-3 sm:grid-cols-3" role="group" aria-label="选择本期内容平台">
              {PRODUCTION_PLATFORMS.map((platform) => {
                const selected = selectedPlatforms.includes(platform.id);
                const onlySelected = selected && selectedPlatforms.length === 1;
                return (
                  <button
                    key={platform.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={interactionLocked || onlySelected}
                    onClick={() => onSelectedPlatformsChange(
                      selected
                        ? selectedPlatforms.filter((item) => item !== platform.id)
                        : PRODUCTION_PLATFORMS
                          .map((item) => item.id)
                          .filter((item) => item === platform.id || selectedPlatforms.includes(item)),
                    )}
                    className={`min-h-[112px] rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed ${
                      selected
                        ? 'border-[#E85D4C] bg-[#FFF3F0]'
                        : 'border-[#E7DED6] bg-white hover:border-[#C9BDB2]'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="text-[14px] font-bold text-[#1A1A1A]">{platform.label}</span>
                      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full border ${selected ? 'border-[#E85D4C] bg-[#E85D4C] text-white' : 'border-[#C9BDB2] text-transparent'}`}>
                        <Check size={12} strokeWidth={2.8} />
                      </span>
                    </span>
                    <span className="mt-2 block text-[12px] leading-[1.55] text-[#6B6B6B]">{platform.content}</span>
                    <span className="mt-1 block text-[11px] leading-[1.5] text-[#8A8178]">{platform.visual || '无需额外生成视觉资产'}</span>
                  </button>
                );
              })}
            </div>

            <ol className="mt-5 grid border-y border-[rgba(28,28,30,0.1)] sm:grid-cols-3 sm:divide-x sm:divide-[rgba(28,28,30,0.1)]">
              <li className="flex items-center gap-3 px-1 py-3 sm:px-4">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center bg-[#EDF8F0] text-[#16803C]">
                  <Check size={13} strokeWidth={2.5} />
                </span>
                <span className="text-[12px] font-bold text-[#1A1A1A]">已整理你的素材</span>
              </li>
              <li className="flex items-center gap-3 border-t border-[rgba(28,28,30,0.1)] px-1 py-3 sm:border-t-0 sm:px-4">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center bg-[#F5EDE4] font-mono text-[10px] font-bold text-[#6B5543]">02</span>
                <span className="text-[12px] font-bold text-[#1A1A1A]">{writingMode === 'author_material' ? '保存题目与素材' : '查看同类内容'}</span>
              </li>
              <li className="flex items-center gap-3 border-t border-[rgba(28,28,30,0.1)] px-1 py-3 sm:border-t-0 sm:px-4">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center bg-[#F5EDE4] font-mono text-[10px] font-bold text-[#6B5543]">03</span>
                <span className="text-[12px] font-bold text-[#1A1A1A]">{writingMode === 'author_material' ? '生成写作方案' : '给出主题建议'}</span>
              </li>
            </ol>

            {needsModelSetup && !analysisStale && (
              <section aria-label="生成前连接写作服务" className="mt-5 rounded-xl border border-[#E0D5BA] bg-[#FFF9EE] p-4 text-sm leading-6">
                <h3 className="font-semibold text-[#303030]">生成方案前，先连接写作服务</h3>
                <p className="mt-1 text-[#625744]">{modelSetupIssue} 已整理的素材、题目和本篇要求会保留。</p>
                <p className="mt-1 text-[#625744]">保存草稿和模型设置不调用模型；测试连接、生成方案和正文可能产生所用服务的费用。</p>
                {onOpenModelSetup && <button type="button" disabled={interactionLocked} onClick={onOpenModelSetup} className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-[#1C1C1E] px-4 font-semibold text-white disabled:opacity-50">保存草稿并连接写作服务</button>}
              </section>
            )}

            <ModelCallAction runId={writingMode === 'author_material' ? runId : undefined} refreshKey={String(busy)}>{(callUnavailable) => <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-2 text-[12px] leading-[1.6] text-[#6B6B6B]">
                <CircleAlert size={15} className="mt-0.5 shrink-0 text-[#A66300]" />
                <span>{analysisStale ? '素材已更改，请先重新整理。' : !hasReadableSource ? '当前没有可读取的素材。请补充文字、可读取的文件或其他参考链接后重试。' : hasBlockedFile ? '请先移除无法读取的文件，再重新整理素材。' : writingMode === 'author_material' ? (topic.trim() ? '先保存题目与素材，再生成供你确认的写作方案。不会采集平台数据。' : '请填写这期想写的题目。') : `已选择 ${selectedPlatforms.length} 个平台；下一步会分别查看各平台的同类内容。`}</span>
              </div>
              <button
                type="button"
                onClick={onStartResearch}
                disabled={!canStartResearch || callUnavailable}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 bg-[#1C1C1E] px-4 text-[12px] font-bold text-white transition-colors hover:bg-[#353535] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
              >
                {interactionLocked ? <LoaderCircle size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                {writingMode === 'author_material' ? '确认素材，按这个题目写' : '确认底稿并开始找选题'}
              </button>
            </div>}</ModelCallAction>
          </section>
        </>
      )}
    </div>
  );
}

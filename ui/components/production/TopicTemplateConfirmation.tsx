'use client';

import { ModelCallAction } from './ModelCallAction';

import { useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  Check,
  FileText,
  LayoutTemplate,
  Lightbulb,
  LoaderCircle,
  Sparkles,
} from 'lucide-react';
import { Md2WechatThemePreview } from '@/components/Md2WechatThemePreview';
import { Md2WechatThemeBrowser } from '@/components/Md2WechatThemeBrowser';
import { Md2WechatThemeComparison } from '@/components/Md2WechatThemeComparison';
import { useMd2WechatThemePreferences } from '@/hooks/useMd2WechatThemePreferences';
import type { BrandTemplate } from '@/lib/brand-templates';
import { toggleMd2WechatThemeComparison } from '@/lib/md2wechat-theme-directory';

import type { TopicSuggestion } from '@/lib/topic-suggestions-client';
export type { TopicSuggestion } from '@/lib/topic-suggestions-client';

export function nextTopicSuggestionIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
): number | null {
  if (itemCount <= 0) return null;
  const safeIndex = currentIndex >= 0 && currentIndex < itemCount ? currentIndex : 0;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (safeIndex + 1) % itemCount;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (safeIndex - 1 + itemCount) % itemCount;
  return null;
}

export type TopicTemplateConfirmationProps = {
  runId?: string;
  /** At most three directions supported by this period’s material. */
  suggestions: readonly TopicSuggestion[];
  selectedSuggestionId?: string | null;
  topic: string;
  templates: readonly BrandTemplate[];
  selectedTemplateId: string;
  selectedPlatformLabels: readonly string[];
  busy?: boolean;
  loading?: boolean;
  error?: string;
  researchAvailable?: boolean;
  modelSetupIssue?: string | null;
  modelSetupHandledByTask?: boolean;
  onReload?: () => void;
  onViewSamples?: () => void;
  onSelectSuggestion: (suggestionId: string) => void;
  onTopicChange: (topic: string) => void;
  onSelectTemplate: (templateId: string) => void;
  onConfirm: () => void;
};

function EvidenceLine({ evidence }: { evidence: readonly string[] }) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-4 border-t border-[rgba(28,28,30,0.08)] pt-3">
      <p className="text-[10px] font-bold text-[#8A8178]">为什么推荐</p>
      <ul className="mt-1.5 space-y-1.5">
        {evidence.slice(0, 2).map((item, index) => (
          <li key={`${item}-${index}`} className="flex gap-1.5 text-[11px] leading-[1.5] text-[#5E5953]">
            <span aria-hidden="true" className="mt-[7px] h-1 w-1 shrink-0 bg-[#D99124]" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function previewTemplateChoice(
  activeTemplates: readonly BrandTemplate[],
  selectedTemplateId: string,
  previewThemeId: string,
): BrandTemplate | undefined {
  const previewable = activeTemplates.filter((template) => (
    template.source === 'md2wechat' && template.themeType === 'api'
  ));
  return previewable.find((template) => template.id === previewThemeId)
    || previewable.find((template) => template.id === selectedTemplateId)
    || previewable[0];
}

export function TopicTemplateConfirmation({
  runId,
  suggestions,
  selectedSuggestionId,
  topic,
  templates,
  selectedTemplateId,
  selectedPlatformLabels,
  busy = false,
  loading = false,
  error = '',
  researchAvailable = false,
  modelSetupIssue,
  modelSetupHandledByTask = false,
  onReload,
  onViewSamples,
  onSelectSuggestion,
  onTopicChange,
  onSelectTemplate,
  onConfirm,
}: TopicTemplateConfirmationProps) {
  const [previewThemeId, setPreviewThemeId] = useState('');
  const [compareThemeIds, setCompareThemeIds] = useState<string[]>([]);
  const suggestionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { preferences, recordRecent, toggleFavorite, setDefault } = useMd2WechatThemePreferences();
  const visibleSuggestions = suggestions.slice(0, 3);
  const selectedSuggestionIndex = visibleSuggestions.findIndex((suggestion) => suggestion.id === selectedSuggestionId);
  const tabbableSuggestionIndex = selectedSuggestionIndex >= 0 ? selectedSuggestionIndex : 0;
  const activeTemplates = templates.filter((template) => template.enabled);
  const previewTheme = previewTemplateChoice(activeTemplates, selectedTemplateId, previewThemeId);
  const compareThemes = compareThemeIds.flatMap((themeId) => {
    const theme = activeTemplates.find((candidate) => candidate.id === themeId);
    return theme ? [theme] : [];
  });
  const canConfirm = Boolean(topic.trim() && selectedTemplateId && researchAvailable && !busy && !loading);

  function previewTemplate(themeId: string) {
    setPreviewThemeId(themeId);
    recordRecent(themeId);
  }

  function toggleComparison(themeId: string) {
    setCompareThemeIds((current) => toggleMd2WechatThemeComparison(current, themeId));
  }

  function handleSuggestionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = nextTopicSuggestionIndex(index, visibleSuggestions.length, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    const nextSuggestion = visibleSuggestions[nextIndex];
    if (!nextSuggestion) return;
    onSelectSuggestion(nextSuggestion.id);
    suggestionRefs.current[nextIndex]?.focus();
  }

  return (
    <div className="space-y-7">
      <section aria-labelledby="topic-template-confirmation-heading" className="border-b border-[rgba(28,28,30,0.1)] pb-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[#8A8178]">
              <span className="font-mono text-[11px] font-bold">第二步</span>
              <span className="h-px w-5 bg-[rgba(28,28,30,0.16)]" />
              <span className="text-[11px] font-bold">选择主题</span>
            </div>
            <h2 id="topic-template-confirmation-heading" className="mt-2 text-[20px] font-bold text-[#1A1A1A]">确定这篇写什么</h2>
            <p className="mt-2 max-w-[700px] text-[12px] leading-[1.65] text-[#6B6B6B]">从素材支持的方向中选一个，也可以自己写标题。公众号先沿用默认排版，写完后可以再换。</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-lg border-l-[3px] border-[#D99124] bg-[#FFF9EC] px-3 py-2.5">
            <Lightbulb size={16} className="shrink-0 text-[#A66300]" />
            <div>
              <p className="text-[10px] font-bold text-[#8D5A00]">可选主题</p>
              <p className="mt-0.5 text-[12px] font-bold text-[#1A1A1A]">{loading ? '正在读取' : `${visibleSuggestions.length} 个方向`}</p>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="topic-suggestions-heading">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 id="topic-suggestions-heading" className="text-[15px] font-bold text-[#1A1A1A]">选题建议</h3>
            <p className="mt-1 text-[12px] leading-[1.6] text-[#6B6B6B]">点击一个主题，会自动填入下方标题框；也可以直接改写。</p>
          </div>
          <span className="text-[11px] text-[#8A8178]">选一个作为本期主题</span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px] text-[#6B6B6B]">
          <span>{researchAvailable ? '本期参考已保存，读取建议不会重新采集。' : '正在核对本期研究记录。'}</span>
          {researchAvailable && onViewSamples && <button type="button" onClick={onViewSamples} className="underline underline-offset-4">查看已保存参考</button>}
          {researchAvailable && onReload && <button type="button" onClick={onReload} disabled={busy || loading} className="underline underline-offset-4 disabled:opacity-50">重新读取选题</button>}
        </div>
        {loading ? <p role="status" className="mt-4 text-sm">正在读取本期选题建议，你的标题会保留。</p> : error ? <p role="alert" className="mt-4 text-sm text-[#B43C2E]">{error}</p> : visibleSuggestions.length > 0 ? (
          <div role="radiogroup" aria-label="本期主题建议" className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleSuggestions.map((suggestion, index) => {
              const selected = suggestion.id === selectedSuggestionId;
              return (
                <button
                  key={suggestion.id}
                  ref={(node) => {
                    suggestionRefs.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={index === tabbableSuggestionIndex ? 0 : -1}
                  onClick={() => onSelectSuggestion(suggestion.id)}
                  onKeyDown={(event) => handleSuggestionKeyDown(event, index)}
                  className={`relative flex min-h-[184px] flex-col rounded-lg border p-4 text-left transition-colors active:translate-y-px ${
                    selected
                      ? 'border-[#E85D4C] bg-[#FFF8F5]'
                      : 'border-[rgba(28,28,30,0.14)] bg-white hover:border-[#C94A3B] hover:bg-[#FFFDF9]'
                  }`}
                >
                  {selected && <span aria-hidden="true" className="absolute left-0 top-4 h-8 w-[3px] bg-[#E85D4C]" />}
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] font-bold text-[#8A8178]">{String(index + 1).padStart(2, '0')}</span>
                    {selected ? (
                      <span className="inline-flex h-6 items-center gap-1 rounded-md bg-[#E85D4C] px-1.5 text-[10px] font-bold text-white"><Check size={12} strokeWidth={2.6} />已选</span>
                    ) : (
                      <span className="text-[10px] font-bold text-[#8A8178]">推荐</span>
                    )}
                  </div>
                  <h4 className="mt-5 text-[14px] font-bold leading-[1.6] text-[#1A1A1A]">{suggestion.title}</h4>
                  {suggestion.rationale && <p className="mt-2 text-[11px] leading-[1.6] text-[#6B6B6B]">{suggestion.rationale}</p>}
                  {suggestion.audience && <p className="mt-2 text-[11px] text-[#6B6B6B]">写给：{suggestion.audience}</p>}
                  <EvidenceLine evidence={suggestion.evidence || []} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-dashed border-[rgba(28,28,30,0.18)] bg-[#FFFDF9] px-3 py-4 text-[12px] leading-[1.6] text-[#6B6B6B]">
            <Lightbulb size={15} className="mt-0.5 shrink-0 text-[#A66300]" />
            <p>{researchAvailable ? '这份素材还不足以给出具体建议。可以直接填写你要写的标题，已有参考仍可查看。' : '本期研究尚未核对完成，请先查看同类内容。'}</p>
          </div>
        )}
      </section>

      <section aria-labelledby="topic-edit-heading" className="border-t border-[rgba(28,28,30,0.1)] pt-5">
        <label className="block">
          <span id="topic-edit-heading" className="mb-2 flex items-center gap-2 text-[12px] font-bold text-[#1A1A1A]">
            <FileText size={14} className="text-[#E85D4C]" />
            标题
          </span>
          <textarea
            value={topic}
            onChange={(event) => onTopicChange(event.target.value)}
            rows={2}
            maxLength={120}
            placeholder="选一个推荐主题，或直接输入你想写的标题。"
            className="block min-h-[72px] w-full resize-y rounded-md border border-[rgba(28,28,30,0.16)] bg-white px-3 py-2.5 text-[14px] font-semibold leading-[1.65] text-[#1A1A1A] outline-none placeholder:font-normal placeholder:text-[#AAA39B] focus:border-[#E85D4C] focus:ring-1 focus:ring-[#E85D4C]"
          />
          <span className="mt-1.5 block text-right text-[10px] tabular-nums text-[#8A8178]">{topic.length}/120</span>
        </label>
      </section>

      <details className="border-t border-[rgba(28,28,30,0.1)] pt-5">
        <summary className="cursor-pointer text-[12px] font-semibold">沿用当前排版 · 如需更换，展开选择</summary>
        <section aria-labelledby="brand-template-heading" className="mt-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 id="brand-template-heading" className="flex items-center gap-2 text-[15px] font-bold text-[#1A1A1A]"><LayoutTemplate size={16} className="text-[#E85D4C]" />公众号排版主题</h3>
            <p className="mt-1 text-[12px] leading-[1.6] text-[#6B6B6B]">直接来自本机 md2wechat。只影响公众号 HTML，不改变小红书 P1-P8 的平台原生结构。</p>
          </div>
          <span className="text-[11px] text-[#8A8178]">只显示可直接排版的 API 主题</span>
        </div>

        {activeTemplates.length > 0 ? (
          <div className="mt-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,0.88fr)_minmax(390px,1.12fr)] lg:items-start">
              <Md2WechatThemeBrowser
                themes={activeTemplates}
                selectedThemeId={selectedTemplateId}
                previewThemeId={previewTheme?.id || ''}
                onPreview={previewTemplate}
                compareThemeIds={compareThemeIds}
                onToggleCompare={toggleComparison}
                preferences={preferences}
                onToggleFavorite={toggleFavorite}
                recommendationContext={topic}
              />
              <aside aria-label="当前公众号排版预览" className="min-w-0 lg:sticky lg:top-4">
                {previewTheme ? (
                  <Md2WechatThemePreview
                    theme={previewTheme}
                    className="mt-0"
                    selected={previewTheme.id === selectedTemplateId}
                    isDefault={previewTheme.id === preferences.defaultThemeId}
                    onSelect={() => onSelectTemplate(previewTheme.id)}
                    onSetDefault={() => setDefault(previewTheme.id)}
                  />
                ) : (
                  <div className="flex min-h-[260px] items-center justify-center rounded-[16px] border border-dashed border-[rgba(28,28,30,0.16)] bg-[#FFFDF9] px-6 text-center text-[12px] leading-[1.7] text-[#6B6B6B]">
                    当前只有基础回退排版；检测到 md2wechat API 主题后会在这里显示真实预览。
                  </div>
                )}
              </aside>
            </div>
            <Md2WechatThemeComparison
              themes={compareThemes}
              selectedThemeId={selectedTemplateId}
              defaultThemeId={preferences.defaultThemeId}
              onSelect={onSelectTemplate}
              onSetDefault={setDefault}
              onRemove={toggleComparison}
              onClear={() => setCompareThemeIds([])}
            />
          </div>
        ) : (
          <div className="mt-4 rounded-lg border-l-[3px] border-[#D99124] bg-[#FFF9EC] px-3 py-3 text-[12px] leading-[1.6] text-[#8D5A00]">
            还没有可用的排版样式。请先到设置中启用一个。
          </div>
        )}
      </section>
      </details>

      <ModelCallAction runId={runId} refreshKey={String(busy)}>{(callUnavailable) => <div className="flex flex-col gap-3 border-t border-[rgba(28,28,30,0.1)] pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-[650px] text-[12px] leading-[1.6] text-[#6B6B6B]">确认后，会分别生成{selectedPlatformLabels.join('、') || '已选平台'}的内容方案，再独立制作各平台原生内容。</p>
        {modelSetupIssue ? (modelSetupHandledByTask ? null : <div className="text-sm">
          <p className="mb-2 text-[#6B6B6B]">{modelSetupIssue} 选题和参考会保留。</p>
          <Link href="/settings#model-connection" className="font-semibold underline underline-offset-4">连接写作服务后继续</Link>
        </div>) : <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm || callUnavailable}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-[#1C1C1E] px-4 text-[12px] font-bold text-white transition-colors hover:bg-[#353535] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
        >
          {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}
          确认并生成内容方案
        </button>}
      </div>}</ModelCallAction>
    </div>
  );
}

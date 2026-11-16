'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  BellRing,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileText,
  Lightbulb,
  Link2,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  Music2,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  Trash2,
  UsersRound,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TechnicalDetailList, TechnicalDetails } from '@/components/TechnicalDetails';
import { advisorGeneratedDisplayList, advisorGeneratedDisplayText } from '@/lib/benchmark-display-copy';
import { displayClientError } from '@/lib/client-error-copy';
import { PRODUCT_COPY, platformDisplayName } from '@/lib/product-copy';
import type {
  AdvisorChatMessage,
  BenchmarkAccount,
  BenchmarkAction,
  BenchmarkAdvisorState,
  BenchmarkPattern,
  BenchmarkPlatform,
  BenchmarkReport,
  BenchmarkWorkEvidence,
  ViralVideoAnalysis,
  ViralVideoAngle,
} from '@/lib/benchmark-advisor';

type AccountDraft = Omit<BenchmarkAccount, 'createdAt' | 'updatedAt'>;
type WorkbenchMode = 'accounts' | 'video';
type LibraryView = 'distillation' | 'stream' | 'comparison';
type ContentTab = 'original' | 'breakdown';
type VideoTab = 'source' | 'breakdown';
type StreamPeriod = '7d' | '30d' | '90d';
type StreamSort = 'latest' | 'heat';

type StatusResponse = {
  activeRun?: { run_id?: string; project_id?: string } | null;
  latest?: { active_run_id?: string };
};

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROJECT_STORAGE_KEY = 'aifios.benchmark-advisor.project-id';
const DEFAULT_VISIBLE_WORKS = 3;
const PLATFORM_OPTIONS: Array<{ value: BenchmarkPlatform; label: string; mark: string }> = [
  { value: 'wechat_mp', label: platformDisplayName('wechat_mp'), mark: '公' },
  { value: 'xiaohongshu', label: platformDisplayName('xiaohongshu'), mark: '小' },
  { value: 'wechat_channels', label: platformDisplayName('wechat_channels'), mark: '视' },
];

const EMPTY_STATE: BenchmarkAdvisorState = {
  projectId: 'default',
  authorizationConfirmed: false,
  accounts: [],
  latestReport: null,
  latestVideoAnalysis: null,
  reportCount: 0,
  chatHistory: [],
  weekly: {
    lastRefreshAt: null,
    nextRefreshAt: null,
    refreshDue: true,
    unreadChangeSummary: false,
    changeSummary: '',
    lastAttemptAt: null,
    lastRefreshError: '',
  },
  archivePaths: {
    accounts: '',
    research: '',
    chat: '',
    evidence: '',
    videoAnalysis: '',
  },
};

function makeAccount(): AccountDraft {
  return {
    id: `benchmark_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    label: '',
    handle: '',
    platform: 'xiaohongshu',
    publicUrl: '',
    focus: '',
    observation: '',
  };
}

function toDraft(account: BenchmarkAccount): AccountDraft {
  return {
    id: account.id,
    label: account.label,
    handle: account.handle,
    platform: account.platform,
    publicUrl: account.publicUrl,
    focus: account.focus,
    observation: account.observation,
  };
}

function formatDate(value: string | null | undefined, withTime = false): string {
  if (!value) return '尚未分析';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', withTime
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(date);
}

function platformMeta(platform: BenchmarkPlatform) {
  return PLATFORM_OPTIONS.find((item) => item.value === platform) || PLATFORM_OPTIONS[0];
}

function workKey(work: BenchmarkWorkEvidence, index = 0): string {
  return work.sourceUrl || `${work.title}:${work.publishedAt}:${index}`;
}

function verifiedMechanisms(values: string[]): string[] {
  return values
    .filter((mechanism) => mechanism && !mechanism.includes('待人工核验'))
    .map(advisorGeneratedDisplayText);
}

function patternDimensionLabel(dimension: BenchmarkPattern['dimension']): string {
  return {
    topic: '主题',
    promise: '开头承诺',
    structure: '内容结构',
    proof: '怎么让人相信',
    cta: '怎么引导互动',
    visual: '画面风格',
  }[dimension];
}

function comparisonDimensionLabel(dimension: string): string {
  const labels: Record<string, string> = {
    '内容形式': '常用形式',
    '开场机制': '常用开头',
    '互动': '互动方式',
    '更新节奏': '发布频率',
    '可迁移机制': '可以借鉴的方法',
    '不可迁移条件': '不要复制的内容',
  };
  return labels[dimension] || dimension;
}

function workStructure(work: BenchmarkWorkEvidence) {
  return work.structureAnalysis || {
    status: 'limited' as const,
    topicSignals: [],
    promiseTypes: [],
    narrativeStructure: [],
    proofSignals: [],
    ctaTypes: [],
    visualSignals: [],
    basis: [],
    evidenceLimits: ['这条作品来自旧记录；更新分析后可重新读取内容结构。'],
  };
}

function metricTotal(work: BenchmarkWorkEvidence): number {
  return Object.values(work.metrics).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function metricLabel(key: string): string {
  const labels: Record<string, string> = {
    plays: '播放', views: '阅读', likes: '赞', digg: '赞', comments: '评', shares: '转', collects: '藏', favorites: '藏',
  };
  return labels[key] || key.slice(0, 3);
}

function compactMetric(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: value >= 10_000 ? 1 : 0 }).format(value);
}

function publicHttpUrl(value: string | null | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const privateIpv4 = /^(?:127|10|0)\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[0-1])\.|^169\.254\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname);
    const localIpv6 = hostname === '::1' || hostname.startsWith('fe80:') || hostname.startsWith('fc') || hostname.startsWith('fd');
    if (!['http:', 'https:'].includes(parsed.protocol) || hostname === 'localhost' || hostname.endsWith('.local') || localIpv6 || privateIpv4) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function isSupportedVideoUrl(value: string): boolean {
  const source = publicHttpUrl(value);
  if (!source) return false;
  try {
    const parsed = new URL(source);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const matches = (suffixes: string[]) => suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    return matches(['douyin.com', 'douyin.cn', 'iesdouyin.com'])
      || matches(['xiaohongshu.com', 'xhslink.com', 'xhsurl.com'])
      || matches(['channels.weixin.qq.com', 'finder.video.qq.com'])
      || (matches(['weixin.qq.com']) && parsed.pathname.startsWith('/sph/'));
  } catch {
    return false;
  }
}

function benchmarkMediaUrl(params: { path?: string; url?: string }): string {
  const value = params.path?.trim() || params.url?.trim() || '';
  if (!value) return '';
  const search = new URLSearchParams(params.path ? { path: value } : { url: value });
  return `/api/benchmark-advisor/media?${search.toString()}`;
}

function initialDraftFromUrl(value: string, current: AccountDraft): AccountDraft {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const platform: BenchmarkPlatform = /xiaohongshu|xhslink|xhsurl/.test(host)
      ? 'xiaohongshu'
      : /weixin|video\.qq/.test(host)
        ? 'wechat_channels'
        : current.platform;
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const possibleHandle = pathParts.at(-1)?.replace(/[^a-zA-Z0-9_@.-]/g, '') || '';
    return {
      ...current,
      platform,
      publicUrl: value,
      handle: current.handle || possibleHandle,
      label: current.label || (possibleHandle ? `公开账号 ${possibleHandle.slice(-10)}` : ''),
    };
  } catch {
    return { ...current, publicUrl: value };
  }
}

function postAdvisor(projectId: string, payload: Record<string, unknown>) {
  return fetch('/api/benchmark-advisor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, projectId }),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.error === 'string' ? advisorGeneratedDisplayText(data.error) : '账号与视频分析操作失败。');
  return data as unknown as BenchmarkAdvisorState & { adoptedCount?: number; cached?: boolean };
  });
}

function StatusChip({ tone, children }: { tone: 'fresh' | 'stale' | 'neutral' | 'warning'; children: React.ReactNode }) {
  const tones = {
    fresh: 'bg-[#EDF8F0] text-[#16803C]',
    stale: 'bg-[#FFF8E8] text-[#8D5A00]',
    neutral: 'bg-[#F5EDE4] text-[#6B6B6B]',
    warning: 'bg-[#FFF1EE] text-[#B43C2E]',
  };
  return <span className={`inline-flex h-6 items-center whitespace-nowrap px-2 text-[10px] font-bold ${tones[tone]}`}>{children}</span>;
}

function PlatformMark({ platform }: { platform: BenchmarkPlatform }) {
  const meta = platformMeta(platform);
  const background = platform === 'xiaohongshu' ? 'bg-[#FFF1EE] text-[#C94A3B]' : platform === 'wechat_channels' ? 'bg-[#EDF8F0] text-[#16803C]' : 'bg-[#EEF5FF] text-[#2763A6]';
  return <span className={`flex h-7 w-7 shrink-0 items-center justify-center text-[11px] font-bold ${background}`} title={meta.label}>{meta.mark}</span>;
}

function MetricLine({ work, limit = 3 }: { work: BenchmarkWorkEvidence; limit?: number }) {
  const entries = Object.entries(work.metrics).filter(([, value]) => Number.isFinite(value)).slice(0, limit);
  if (!entries.length) return <span className="text-[11px] text-[#AAA39B]">互动数据未返回</span>;
  return (
    <span className="flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] font-semibold tabular-nums text-[#6B6B6B]">
      {entries.map(([key, value]) => <span key={key}>{metricLabel(key)} {compactMetric(value)}</span>)}
    </span>
  );
}

function WorkCover({ work, compact = false }: { work: BenchmarkWorkEvidence; compact?: boolean }) {
  const archivedSource = work.coverPath ? benchmarkMediaUrl({ path: work.coverPath }) : '';
  const publicImage = publicHttpUrl(work.coverImage);
  const remoteSource = publicImage ? benchmarkMediaUrl({ url: publicImage }) : '';
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const imageSource = [archivedSource, remoteSource].find((source) => source && !failedSources.includes(source)) || '';
  const FormatIcon = work.format.toLowerCase().includes('audio')
    ? Music2
    : work.format.toLowerCase().includes('video')
      ? Video
      : FileText;

  return (
    <div className={`relative shrink-0 overflow-hidden bg-[#F5EDE4] ${compact ? 'h-[74px] w-[64px]' : 'aspect-[4/3] w-full'}`}>
      {imageSource ? (
        <Image
          src={imageSource}
          alt={`${work.title || '公开作品'}的公开主图`}
          fill
          unoptimized
          sizes={compact ? '64px' : '(max-width: 767px) 100vw, 360px'}
          className="object-cover"
          onError={() => setFailedSources((current) => current.includes(imageSource) ? current : [...current, imageSource])}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-[#A66300]">
          <FormatIcon size={compact ? 18 : 24} aria-hidden="true" />
          {!compact && <span className="mt-2 text-[10px] font-bold">主图未保存</span>}
        </div>
      )}
      {imageSource && !compact && <span className="absolute bottom-0 left-0 bg-[rgba(28,28,30,0.76)] px-2 py-1 text-[10px] font-bold text-white">公开主图 · 仅供查看</span>}
    </div>
  );
}

function EmptySurface({ icon: Icon, title, detail, action }: {
  icon: typeof Lightbulb;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center px-7 text-center">
      <span className="flex h-10 w-10 items-center justify-center bg-[#F5EDE4] text-[#A66300]"><Icon size={19} /></span>
      <p className="mt-3 text-[14px] font-bold text-[#1A1A1A]">{title}</p>
      <p className="mt-1.5 max-w-[300px] text-[12px] leading-[1.65] text-[#6B6B6B]">{detail}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function SourceEvidencePanel({
  sourceUrl,
  hasCover,
  hasDirectMedia,
  hasReadableText,
  showSourceLink = true,
}: {
  sourceUrl: string;
  hasCover: boolean;
  hasDirectMedia: boolean;
  hasReadableText: boolean;
  showSourceLink?: boolean;
}) {
  const verifiedSource = publicHttpUrl(sourceUrl);
  const fields: Array<[string, boolean]> = [
    ['公开封面', hasCover],
    ['音视频地址', hasDirectMedia],
    ['可读文字', hasReadableText],
  ];
  return (
    <section className="border border-[rgba(28,28,30,0.1)] bg-[#FFFDFC] p-3.5">
      <p className="text-[11px] font-bold text-[#1A1A1A]">可查看的内容</p>
      <p className="mt-1.5 text-[11px] leading-[1.65] text-[#6B6B6B]">这里只显示已保存的公开主图或视频首帧。完整视频和原文请从“打开来源”查看；分析不会复制原内容。</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {fields.map(([label, present]) => <div key={label} className="border border-[rgba(28,28,30,0.08)] bg-white px-2.5 py-2"><p className="text-[10px] text-[#8A8178]">{label}</p><p className={`mt-1 text-[11px] font-bold ${present ? 'text-[#16803C]' : 'text-[#8A8178]'}`}>{present ? '可以查看' : '暂时没有'}</p></div>)}
      </div>
      {showSourceLink && verifiedSource && <a href={verifiedSource} target="_blank" rel="noreferrer" className="mt-3 inline-flex h-8 items-center gap-1.5 border border-[rgba(28,28,30,0.13)] bg-white px-2.5 text-[11px] font-bold text-[#2763A6] transition-colors hover:border-[#2763A6] hover:bg-[#F7FBFF]" title="在公开来源中核验"><ExternalLink size={13} />打开来源</a>}
    </section>
  );
}

function AdvisorWorkbenchSkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-[216px_minmax(310px,0.92fr)_minmax(360px,1.08fr)]" aria-label="正在加载账号分析">
      <section className="min-h-[540px] border border-[rgba(28,28,30,0.1)] bg-white p-4">
        <div className="h-4 w-24 animate-pulse bg-[#F5EDE4]" />
        <div className="mt-5 space-y-3">{[1, 2, 3].map((item) => <div key={item} className="h-14 animate-pulse bg-[#FDF8F3]" />)}</div>
      </section>
      <section className="min-h-[540px] border border-[rgba(28,28,30,0.1)] bg-white p-4">
        <div className="h-4 w-28 animate-pulse bg-[#F5EDE4]" />
        <div className="mt-5 space-y-0 divide-y divide-[rgba(28,28,30,0.07)]">{[1, 2, 3, 4].map((item) => <div key={item} className="h-[88px] animate-pulse py-3"><div className="h-3 w-4/5 bg-[#F5EDE4]" /><div className="mt-3 h-2.5 w-2/5 bg-[#FDF8F3]" /></div>)}</div>
      </section>
      <section className="min-h-[540px] border border-[rgba(28,28,30,0.1)] bg-white p-4">
        <div className="h-4 w-2/3 animate-pulse bg-[#F5EDE4]" />
        <div className="mt-6 h-52 animate-pulse bg-[#FDF8F3]" />
        <div className="mt-5 h-3 w-5/6 animate-pulse bg-[#F5EDE4]" />
      </section>
    </div>
  );
}

function ChatDock({
  messages,
  busy,
  onSend,
  placeholder = '继续追问',
}: {
  messages: AdvisorChatMessage[];
  busy: boolean;
  onSend: (question: string) => Promise<void>;
  placeholder?: string;
}) {
  const [question, setQuestion] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || busy) return;
    const next = question.trim();
    setQuestion('');
    try {
      await onSend(next);
    } catch {
      setQuestion(next);
    }
  };
  const visible = messages.slice(-2);
  return (
    <section className="border-t border-[rgba(28,28,30,0.09)] bg-[#FFFDFC] px-4 py-3">
      <div className="flex items-center gap-2">
        <MessageCircle size={15} className="text-[#E85D4C]" />
        <p className="text-[12px] font-bold text-[#1A1A1A]">继续追问</p>
        {visible.length > 0 && <span className="text-[10px] text-[#8A8178]">会结合当前分析回答</span>}
      </div>
      {visible.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {visible.map((message) => (
            <div key={message.id} className={`grid grid-cols-[32px_minmax(0,1fr)] gap-2 px-2.5 py-2 ${message.role === 'advisor' ? 'bg-[#FFF8F5]' : 'bg-white'}`}>
              <span className={`text-[10px] font-bold ${message.role === 'advisor' ? 'text-[#C94A3B]' : 'text-[#8A8178]'}`}>{message.role === 'advisor' ? '分析' : '你'}</span>
              <p className={`line-clamp-3 text-[11px] leading-[1.55] ${message.role === 'advisor' ? 'text-[#5D4037]' : 'text-[#6B6B6B]'}`}>
                {(message.role === 'advisor' ? advisorGeneratedDisplayText(message.content) : message.content).replace(/\n+/g, ' ')}
              </p>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="mt-2 flex gap-2">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={placeholder}
          className="h-9 min-w-0 flex-1 border border-[rgba(28,28,30,0.13)] bg-white px-2.5 text-[12px] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]"
        />
        <button type="submit" disabled={busy || !question.trim()} className="inline-flex h-9 w-9 shrink-0 items-center justify-center bg-[#1C1C1E] text-white hover:bg-[#353535] disabled:opacity-45" title="发送问题" aria-label="发送问题">
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </form>
    </section>
  );
}

function AccountFormDialog({
  open,
  draft,
  authorizationConfirmed,
  saving,
  error,
  onOpenChange,
  onChange,
  onAuthorizationChange,
  onSave,
}: {
  open: boolean;
  draft: AccountDraft | null;
  authorizationConfirmed: boolean;
  saving: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onChange: (value: AccountDraft) => void;
  onAuthorizationChange: (value: boolean) => void;
  onSave: () => void;
}) {
  if (!draft) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[680px] rounded-[8px] border border-[rgba(28,28,30,0.12)] bg-white p-0 shadow-[0_24px_64px_rgba(28,28,30,0.16)]">
        <DialogHeader className="border-b border-[rgba(28,28,30,0.08)] px-5 py-4">
          <DialogTitle className="text-[18px] font-bold text-[#1A1A1A]">{draft.label ? '编辑参考账号' : '添加参考账号'}</DialogTitle>
          <p className="mt-1 text-[12px] leading-[1.6] text-[#6B6B6B]">从公开链接预填，再核对账号名称与公开 ID。</p>
        </DialogHeader>
        <div className="space-y-4 px-5 py-5">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">公开主页链接</span>
            <input
              value={draft.publicUrl}
              onChange={(event) => onChange({ ...draft, publicUrl: event.target.value })}
              onBlur={() => onChange(initialDraftFromUrl(draft.publicUrl, draft))}
              placeholder="https://..."
              className="h-10 w-full border border-[rgba(28,28,30,0.14)] bg-white px-3 text-[13px] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">平台</span>
              <select value={draft.platform} onChange={(event) => onChange({ ...draft, platform: event.target.value as BenchmarkPlatform })} className="h-10 w-full border border-[rgba(28,28,30,0.14)] bg-white px-3 text-[13px] outline-none focus:border-[#E85D4C]">
                {PLATFORM_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">公开 ID</span>
              <input value={draft.handle} onChange={(event) => onChange({ ...draft, handle: event.target.value })} placeholder={draft.platform === 'wechat_mp' ? 'gh_xxx' : draft.platform === 'wechat_channels' ? '@finder' : '账号 ID'} className="h-10 w-full border border-[rgba(28,28,30,0.14)] bg-white px-3 text-[13px] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]" />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-[0.82fr_1.18fr]">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">账号名称</span>
              <input value={draft.label} onChange={(event) => onChange({ ...draft, label: event.target.value })} placeholder="公开显示名称" className="h-10 w-full border border-[rgba(28,28,30,0.14)] bg-white px-3 text-[13px] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">关注主题</span>
              <input value={draft.focus} onChange={(event) => onChange({ ...draft, focus: event.target.value })} placeholder="例如：创始人内容、增长方法" className="h-10 w-full border border-[rgba(28,28,30,0.14)] bg-white px-3 text-[13px] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]" />
            </label>
          </div>
          <label className="flex items-start gap-2.5 border-l-2 border-[#E85D4C] bg-[#FFF8F5] px-3 py-2.5 text-[12px] leading-[1.6] text-[#5D4037]">
            <input type="checkbox" checked={authorizationConfirmed} onChange={(event) => onAuthorizationChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#E85D4C]" />
            已获得查看这些公开账号并保存分析结果的授权
          </label>
          {error && <p role="alert" className="flex items-start gap-1.5 border-l-2 border-[#B43C2E] bg-[#FFF1EE] px-3 py-2.5 text-[12px] leading-[1.6] text-[#B43C2E]"><CircleAlert size={14} className="mt-0.5 shrink-0" />{error}</p>}
        </div>
        <DialogFooter className="border-t border-[rgba(28,28,30,0.08)] px-5 py-3.5">
          <button type="button" onClick={() => onOpenChange(false)} className="inline-flex h-9 items-center border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[12px] font-bold text-[#6B6B6B] transition-colors duration-150 hover:border-[#E85D4C] hover:text-[#C94A3B] active:translate-y-px">取消</button>
          <button type="button" onClick={onSave} disabled={saving || !authorizationConfirmed} className="inline-flex h-9 items-center gap-2 bg-[#E85D4C] px-3.5 text-[12px] font-bold text-white transition-colors duration-150 hover:bg-[#C94A3B] active:translate-y-px disabled:opacity-45">
            {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />}保存账号
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountRail({
  accounts,
  report,
  selectedId,
  stale,
  onSelect,
  onAdd,
  onEdit,
  onRemove,
}: {
  accounts: BenchmarkAccount[];
  report: BenchmarkReport | null;
  selectedId: string;
  stale: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (account: BenchmarkAccount) => void;
  onRemove: (account: BenchmarkAccount) => void;
}) {
  const reportByAccount = new Map((report?.accounts || []).map((item) => [item.id, item]));
  return (
    <aside className="min-w-0 border border-[rgba(28,28,30,0.1)] bg-white xl:min-h-[660px]">
      <div className="flex items-center justify-between border-b border-[rgba(28,28,30,0.08)] px-4 py-3.5">
        <div>
          <p className="text-[14px] font-bold text-[#1A1A1A]">参考账号</p>
          <p className="mt-0.5 text-[11px] text-[#8A8178]">{accounts.length} / 5 个公开账号</p>
        </div>
        <button type="button" onClick={onAdd} disabled={accounts.length >= 5} className="flex h-8 w-8 items-center justify-center border border-[rgba(28,28,30,0.12)] text-[#5D5650] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-35" title="添加参考账号" aria-label="添加参考账号"><Plus size={15} /></button>
      </div>
      {accounts.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto p-2 xl:block xl:space-y-1 xl:overflow-visible">
          {accounts.map((account) => {
            const data = reportByAccount.get(account.id);
            const active = account.id === selectedId;
            const unavailable = data?.evidenceStatus === 'unavailable';
            return (
              <div key={account.id} className={`group relative min-w-[192px] border-l-[3px] xl:min-w-0 ${active ? 'border-[#E85D4C] bg-[#FFF1EE]' : 'border-transparent hover:bg-[#FDF8F3]'}`}>
                <button type="button" onClick={() => onSelect(account.id)} className="flex w-full min-w-0 items-center gap-2.5 px-3 py-3 pr-10 text-left">
                  <PlatformMark platform={account.platform} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-bold text-[#1A1A1A]">{account.label}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-[#8A8178]">{platformMeta(account.platform).label} · 已收集 {data?.works?.length || 0} 条作品</span>
                  </span>
                </button>
                <div className="absolute right-2 top-2 flex items-center gap-1">
                  {(stale || unavailable) && <StatusChip tone={unavailable ? 'warning' : 'stale'}>{unavailable ? '不可用' : '已过期'}</StatusChip>}
                  <button type="button" onClick={() => onEdit(account)} className="flex h-6 w-6 items-center justify-center text-[#8A8178] opacity-100 hover:text-[#C94A3B] xl:opacity-0 xl:group-hover:opacity-100" title="编辑账号" aria-label={`编辑 ${account.label}`}><MoreHorizontal size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="p-4">
          <p className="text-[12px] leading-[1.65] text-[#6B6B6B]">添加 1 至 5 个公开账号后，就可以分析他们常用的内容方法。</p>
          <button type="button" onClick={onAdd} className="mt-3 inline-flex h-9 items-center gap-2 bg-[#1C1C1E] px-3 text-[12px] font-bold text-white hover:bg-[#353535]"><Plus size={14} />添加账号</button>
        </div>
      )}
      {accounts.length > 0 && (
        <div className="border-t border-[rgba(28,28,30,0.08)] px-3 py-2.5">
          <button type="button" onClick={() => {
            const account = accounts.find((item) => item.id === selectedId);
            if (account) onRemove(account);
          }} className="inline-flex h-7 items-center gap-1.5 text-[11px] font-bold text-[#8A8178] hover:text-[#B43C2E]" title="移除当前账号"><Trash2 size={13} />移除当前账号</button>
        </div>
      )}
    </aside>
  );
}

function ResearchProgress({
  accountCount,
  report,
  activeAccount,
  selectedWork,
  runId,
}: {
  accountCount: number;
  report: BenchmarkReport | null;
  activeAccount: BenchmarkReport['accounts'][number] | undefined;
  selectedWork: BenchmarkWorkEvidence | undefined;
  runId: string;
}) {
  const steps = [
    { label: '选择账号', detail: accountCount ? `${accountCount} 个账号` : '待添加', done: accountCount > 0 },
    { label: '收集作品', detail: report ? formatDate(report.generatedAt) : '等待更新', done: Boolean(report) },
    {
      label: '找共同做法',
      detail: activeAccount?.patterns?.filter((pattern) => pattern.confidence === 'repeated').length
        ? `${activeAccount.patterns.filter((pattern) => pattern.confidence === 'repeated').length} 个常用方法`
        : '还没找到重复做法',
      done: Boolean(activeAccount?.patterns?.some((pattern) => pattern.confidence === 'repeated')),
    },
    { label: '分析作品', detail: selectedWork ? '可以查看' : '先选一条作品', done: Boolean(selectedWork) },
    { label: '用于本期内容', detail: runId ? '已连接本期内容' : '先开始一次创作', done: Boolean(runId) },
  ];
  return (
    <section aria-label="账号分析进度" className="border-t border-[rgba(28,28,30,0.08)] bg-[#FFFDFC]">
      <div className="grid grid-cols-1 md:grid-cols-5">
        {steps.map((step, index) => (
          <div key={step.label} className="flex min-w-0 items-center gap-2 border-b border-[rgba(28,28,30,0.07)] px-3 py-2.5 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center text-[10px] font-bold ${step.done ? 'bg-[#1C1C1E] text-white' : 'bg-[#F5EDE4] text-[#8A8178]'}`}>{step.done ? <Check size={12} /> : index + 1}</span>
            <span className="min-w-0"><span className="block text-[12px] font-bold text-[#393939] md:truncate">{step.label}</span><span className="mt-0.5 block text-[11px] text-[#6B625A] md:truncate">{step.detail}</span></span>
          </div>
        ))}
      </div>
    </section>
  );
}

function accountComparisonValue(report: BenchmarkReport, accountId: string, dimension: string): string {
  const value = report.comparison.find((row) => row.dimension === dimension)?.cells.find((cell) => cell.accountId === accountId)?.value;
  return value ? advisorGeneratedDisplayText(value) : '这次收集的信息不足，暂不判断。';
}

function AccountDistillation({
  account,
  configuredAccount,
  report,
  onOpenWorks,
  onOpenComparison,
}: {
  account: BenchmarkReport['accounts'][number] | undefined;
  configuredAccount: BenchmarkAccount | undefined;
  report: BenchmarkReport | null;
  onOpenWorks: () => void;
  onOpenComparison: () => void;
}) {
  if (!account || !report) {
    return (
      <section className="border border-[rgba(28,28,30,0.1)] bg-white">
        <EmptySurface icon={Sparkles} title="还没有账号分析" detail="保存公开账号并更新分析后，这里会总结账号定位、常用形式和互动方式。" />
      </section>
    );
  }
  const works = account.works;
  const formats = Array.from(new Set(works.map((work) => work.format).filter(Boolean)));
  const patterns = account.patterns || [];
  const repeatedPatterns = patterns.filter((pattern) => pattern.confidence === 'repeated');
  const transferablePatterns = repeatedPatterns.filter((pattern) => ['promise', 'structure', 'proof', 'cta'].includes(pattern.dimension));
  const singlePatterns = patterns.filter((pattern) => pattern.confidence === 'single_sample').slice(0, 6);
  const covers = works.filter((work) => work.coverPath || publicHttpUrl(work.coverImage)).length;
  const readable = works.filter((work) => work.primaryText.trim()).length;
  const ctas = works.filter((work) => work.ctaPresent).length;
  const datedWorks = works
    .map((work) => ({ value: work.publishedAt, stamp: new Date(work.publishedAt).getTime() }))
    .filter((item) => Number.isFinite(item.stamp))
    .sort((left, right) => left.stamp - right.stamp);
  const coverage = datedWorks.length > 1
    ? `${formatDate(datedWorks[0].value)}—${formatDate(datedWorks.at(-1)?.value)}`
    : datedWorks.length
      ? formatDate(datedWorks[0].value)
      : '来源日期待核验';
  const dimensions = [
    ['账号定位', accountComparisonValue(report, account.id, '定位')],
    ['常讲什么、说给谁', accountComparisonValue(report, account.id, '主题分布')],
    ['常用形式', formats.length ? formats.join('、') : accountComparisonValue(report, account.id, '内容形式')],
    ['怎么引导互动', `${accountComparisonValue(report, account.id, '互动')}；${works.length} 条作品中有 ${ctas} 条出现互动引导`],
  ];
  return (
    <section className="min-w-0 border border-[rgba(28,28,30,0.1)] bg-white">
      <div className="flex flex-col gap-3 border-b border-[rgba(28,28,30,0.08)] px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><PlatformMark platform={account.platform} /><h2 className="text-[18px] font-bold text-[#1A1A1A]">{account.label} · 常用内容方法</h2><StatusChip tone={account.evidenceStatus === 'available' ? 'fresh' : 'warning'}>{account.evidenceStatus === 'available' ? '有原始来源' : '来源不足'}</StatusChip></div>
          <p className="mt-2 max-w-[760px] text-[12px] leading-[1.65] text-[#6B6B6B]">根据本次收集的公开作品，总结这个账号常用的选题、结构和互动方式。只参考方法，不复制内容。</p>
        </div>
        <div className="flex shrink-0 gap-2"><button type="button" onClick={onOpenWorks} className="inline-flex h-9 items-center gap-1.5 bg-[#1C1C1E] px-3 text-[11px] font-bold text-white hover:bg-[#353535]"><FileText size={13} />查看作品分析</button>{report.accounts.length > 1 && <button type="button" onClick={onOpenComparison} className="inline-flex h-9 items-center gap-1.5 border border-[rgba(28,28,30,0.13)] bg-white px-3 text-[11px] font-bold text-[#5D5650] hover:border-[#E85D4C] hover:text-[#C94A3B]"><BarChart3 size={13} />账号对比</button>}</div>
      </div>

      <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_310px]">
        <div className="min-w-0">
          <div className="grid gap-3 sm:grid-cols-2">
            {dimensions.map(([label, value]) => <article key={label} className="border-l-2 border-[#F0B6AC] bg-[#FFFDFC] px-3.5 py-3"><p className="text-[10px] font-bold text-[#C94A3B]">{label}</p><p className="mt-1.5 text-[12px] leading-[1.65] text-[#393939]">{value}</p></article>)}
          </div>
          <section className="mt-5 border-t border-[rgba(28,28,30,0.08)] pt-4">
            <div className="flex items-center gap-2"><Sparkles size={15} className="text-[#E85D4C]" /><h3 className="text-[14px] font-bold text-[#1A1A1A]">多篇作品都在用的做法</h3><span className="text-[10px] text-[#8A8178]">至少出现 2 次</span></div>
            {transferablePatterns.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{transferablePatterns.map((pattern) => <article key={`${pattern.dimension}:${pattern.label}`} className="border border-[#F0D6D1] bg-[#FFF8F5] px-3 py-2.5"><div className="flex items-center justify-between gap-2"><span className="text-[10px] font-bold text-[#C94A3B]">{patternDimensionLabel(pattern.dimension)}</span><span className="text-[10px] font-bold tabular-nums text-[#8E3F35]">{pattern.sampleCount}/{works.length} 条</span></div><p className="mt-1 text-[12px] font-bold text-[#5D4037]">{advisorGeneratedDisplayText(pattern.label)}</p>{pattern.sampleUrls.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{pattern.sampleUrls.slice(0, 3).map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[9px] font-bold text-[#2763A6] hover:text-[#C94A3B]"><Link2 size={10} />来源 {index + 1}</a>)}</div>}</article>)}</div> : <p className="mt-2 text-[12px] leading-[1.65] text-[#8A8178]">还没有在至少 2 条作品中重复出现的做法。只出现一次的内容不会当成账号的常用方法。</p>}
            <p className="mt-3 text-[11px] leading-[1.65] text-[#6B6B6B]">借鉴时保留方法，换成自己的用户问题、事实、案例和语言，再看发布后的真实数据。</p>
          </section>
          {singlePatterns.length > 0 && <section className="mt-5 border-t border-[rgba(28,28,30,0.08)] pt-4"><div className="flex items-center gap-2"><CircleAlert size={14} className="text-[#A66300]" /><h3 className="text-[12px] font-bold text-[#5D5650]">只出现 1 次，先别当成常用方法</h3></div><div className="mt-2 flex flex-wrap gap-1.5">{singlePatterns.map((pattern) => <span key={`${pattern.dimension}:${pattern.label}`} className="border border-[#E8D9BD] bg-[#FFFBF1] px-2 py-1 text-[10px] text-[#7A5B1A]">{patternDimensionLabel(pattern.dimension)} · {advisorGeneratedDisplayText(pattern.label)}</span>)}</div></section>}
          {(configuredAccount?.focus || configuredAccount?.observation) && <section className="mt-5 border-t border-[rgba(28,28,30,0.08)] pt-4"><p className="text-[11px] font-bold text-[#8A8178]">你想重点观察的内容</p>{configuredAccount.focus && <p className="mt-1.5 text-[12px] leading-[1.65] text-[#393939]">关注：{configuredAccount.focus}</p>}{configuredAccount.observation && <p className="mt-1 text-[11px] leading-[1.65] text-[#6B6B6B]">备注：{configuredAccount.observation}</p>}<p className="mt-2 text-[10px] text-[#A66300]">你的备注和平台公开信息会分开显示。</p></section>}
        </div>

        <aside className="space-y-4 border-l-0 border-[rgba(28,28,30,0.08)] xl:border-l xl:pl-5">
          <section><p className="text-[11px] font-bold text-[#1A1A1A]">已收集的数据</p><dl className="mt-3 grid grid-cols-2 gap-2"><div className="bg-[#FDF8F3] p-2.5"><dt className="text-[9px] text-[#8A8178]">作品数</dt><dd className="mt-1 text-[15px] font-bold tabular-nums text-[#1A1A1A]">{works.length}</dd></div><div className="bg-[#FDF8F3] p-2.5"><dt className="text-[9px] text-[#8A8178]">时间范围</dt><dd className="mt-1 text-[11px] font-bold text-[#1A1A1A]">{coverage}</dd></div><div className="bg-[#FDF8F3] p-2.5"><dt className="text-[9px] text-[#8A8178]">可查看主图</dt><dd className="mt-1 text-[15px] font-bold tabular-nums text-[#1A1A1A]">{covers}/{works.length}</dd></div><div className="bg-[#FDF8F3] p-2.5"><dt className="text-[9px] text-[#8A8178]">可读文字</dt><dd className="mt-1 text-[15px] font-bold tabular-nums text-[#1A1A1A]">{readable}/{works.length}</dd></div></dl></section>
          <section className="border-l-2 border-[#E85D4C] bg-[#FFF8F5] px-3 py-3"><p className="text-[10px] font-bold text-[#C94A3B]">不要复制</p><p className="mt-1.5 text-[11px] leading-[1.65] text-[#5D4037]">账号身份、经历、标题原句、正文、封面、镜头、声音和未经核实的商业结论。</p></section>
          <section><p className="text-[11px] font-bold text-[#1A1A1A]">原始来源</p><div className="mt-2 space-y-1.5">{account.evidenceLinks.slice(0, 3).map((link, index) => <a key={`${link.url}:${index}`} href={link.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 border border-[rgba(28,28,30,0.09)] px-2.5 py-2 text-[10px] font-bold text-[#2763A6] hover:border-[#2763A6]"><Link2 size={12} />{link.kind === 'profile' ? '账号主页' : '作品来源'}<span className="ml-auto text-[#8A8178]">{formatDate(link.capturedAt)}</span></a>)}</div></section>
        </aside>
      </div>
    </section>
  );
}

function ContentStream({
  account,
  works,
  totalWorks,
  period,
  sort,
  selectedKey,
  stale,
  error,
  onPeriodChange,
  onSortChange,
  onSelect,
  onShowAll,
}: {
  account: BenchmarkReport['accounts'][number] | undefined;
  works: BenchmarkWorkEvidence[];
  totalWorks: number;
  period: StreamPeriod;
  sort: StreamSort;
  selectedKey: string;
  stale: boolean;
  error: string;
  onPeriodChange: (value: StreamPeriod) => void;
  onSortChange: (value: StreamSort) => void;
  onSelect: (key: string) => void;
  onShowAll: () => void;
}) {
  return (
    <section className="min-w-0 border border-[rgba(28,28,30,0.1)] bg-white xl:min-h-[660px]">
      <div className="border-b border-[rgba(28,28,30,0.08)] px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[14px] font-bold text-[#1A1A1A]">近期作品</p>
            <p className="mt-0.5 truncate text-[11px] text-[#8A8178]">{account ? `${account.label} · 当前有 ${totalWorks} 条` : '选择一个参考账号'}</p>
          </div>
          {stale && <StatusChip tone="stale">数据需要更新</StatusChip>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex border border-[rgba(28,28,30,0.12)] bg-white p-0.5">
            {(['7d', '30d', '90d'] as StreamPeriod[]).map((value) => <button key={value} type="button" onClick={() => onPeriodChange(value)} className={`h-9 px-3 text-[12px] font-bold transition-colors duration-150 active:translate-y-px ${period === value ? 'bg-[#1C1C1E] text-white' : 'text-[#6B6B6B] hover:bg-[#FDF8F3]'}`}>近 {value.replace('d', ' 天')}</button>)}
          </div>
          <button type="button" onClick={() => onSortChange(sort === 'latest' ? 'heat' : 'latest')} className="inline-flex h-10 items-center gap-2 border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[12px] font-bold text-[#5D5650] transition-colors duration-150 hover:border-[#E85D4C] hover:text-[#C94A3B] active:translate-y-px">
            <BarChart3 size={16} strokeWidth={2.25} />{sort === 'latest' ? '最新发布' : '互动热度'}
          </button>
        </div>
        {error && <p className="mt-2.5 flex items-start gap-1.5 text-[10px] leading-[1.5] text-[#B43C2E]"><CircleAlert size={12} className="mt-0.5 shrink-0" />{error}</p>}
      </div>
      {!account ? <EmptySurface icon={UsersRound} title="还没有可查看的账号" detail="添加参考账号并更新分析后，这里会显示近期作品。" /> : works.length ? (
        <div className="divide-y divide-[rgba(28,28,30,0.08)]">
          {works.map((work, index) => {
            const key = workKey(work, index);
            const selected = key === selectedKey;
            return (
              <button key={key} type="button" onClick={() => onSelect(key)} className={`grid w-full grid-cols-[64px_minmax(0,1fr)] gap-3 px-3.5 py-3 text-left transition-colors ${selected ? 'bg-[#FFF8F5]' : 'hover:bg-[#FDF8F3]'}`}>
                <WorkCover work={work} compact />
                <span className="min-w-0">
                  <span className="line-clamp-2 text-[12px] font-bold leading-[1.5] text-[#1A1A1A]">{work.title || work.summary || '公开内容标题未返回'}</span>
                  <span className="mt-1 flex items-center gap-1.5 text-[10px] text-[#8A8178]"><span>{work.format || '公开内容'}</span><span>·</span><span>{formatDate(work.publishedAt)}</span></span>
                  <span className="mt-1.5 block"><MetricLine work={work} limit={3} /></span>
                  {work.openingMechanisms[0] && <span className="mt-1.5 inline-flex max-w-full truncate bg-[#FFF1EE] px-1.5 py-0.5 text-[10px] font-bold text-[#B43C2E]">{advisorGeneratedDisplayText(work.openingMechanisms[0])}</span>}
                </span>
              </button>
            );
          })}
          {totalWorks > works.length && (
            <div className="px-3.5 py-3">
              <button type="button" onClick={onShowAll} className="inline-flex h-8 items-center gap-1.5 text-[11px] font-bold text-[#2763A6] transition-colors hover:text-[#C94A3B]">
                <ChevronDown size={14} />查看其余 {totalWorks - works.length} 条
              </button>
            </div>
          )}
        </div>
      ) : <EmptySurface icon={Clock3} title="这个时间范围没有作品" detail="切换时间范围，或更新一次账号分析。" />}
    </section>
  );
}

function WorkBreakdown({ work }: { work: BenchmarkWorkEvidence }) {
  const metrics = metricTotal(work);
  const hasCover = Boolean(work.coverPath || publicHttpUrl(work.coverImage));
  const hasText = Boolean(work.primaryText.trim());
  const confirmedMechanisms = verifiedMechanisms(work.openingMechanisms);
  const analysis = workStructure(work);
  const confidence = analysis.status === 'ready' ? '信息足够，可以分析' : '信息不足，仅供参考';
  const fallbackGaps = [
    !hasText ? '未返回正文、字幕或转写文本，不能还原完整内容。' : '',
    !hasCover ? '未保存公开主图，不能观察首屏画面。' : '',
    !publicHttpUrl(work.embedUrl) ? '未返回可播放媒体，不能做镜头级判断。' : '',
  ].filter(Boolean);
  const gaps = Array.from(new Set([...analysis.evidenceLimits, ...fallbackGaps]));
  return (
    <div className="space-y-4 px-4 py-4">
      <section className="grid gap-3 sm:grid-cols-[132px_minmax(0,1fr)]">
        <WorkCover work={work} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><StatusChip tone={analysis.status === 'ready' ? 'fresh' : 'stale'}>{confidence}</StatusChip><span className="text-[10px] text-[#8A8178]">{work.format || '形式未返回'}</span></div>
          <p className="mt-2 text-[11px] font-bold text-[#8A8178]">为什么选中这条</p>
          <p className="mt-1 text-[12px] leading-[1.65] text-[#393939]">{metrics ? `公开互动合计约 ${compactMetric(metrics)}。` : '公开互动数据未完整返回。'} {work.interactionSignal ? advisorGeneratedDisplayText(work.interactionSignal) : '还没有找到明确的互动数据。'}</p>
          <div className="mt-2"><MetricLine work={work} limit={5} /></div>
          {analysis.topicSignals.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{analysis.topicSignals.map((topic) => <span key={topic} className="bg-[#EEF5FF] px-1.5 py-0.5 text-[9px] font-bold text-[#2763A6]">{advisorGeneratedDisplayText(topic)}</span>)}</div>}
        </div>
      </section>

      <section className="border-t border-[rgba(28,28,30,0.08)] pt-4">
        <p className="text-[11px] font-bold text-[#1A1A1A]">内容结构</p>
        <ol className="mt-3 space-y-2.5">
          <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5"><span className="flex h-6 w-6 items-center justify-center bg-[#1C1C1E] text-[10px] font-bold text-white">1</span><div><p className="text-[10px] font-bold text-[#8A8178]">开头怎么吸引人</p><p className="mt-1 text-[12px] leading-[1.6] text-[#393939]">{confirmedMechanisms.length ? confirmedMechanisms.join('、') : '还不能确定开头用了什么方法'}{analysis.promiseTypes.length ? `；读者会得到：${advisorGeneratedDisplayList(analysis.promiseTypes).join('、')}` : ''}</p></div></li>
          <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5"><span className="flex h-6 w-6 items-center justify-center bg-[#F5EDE4] text-[10px] font-bold text-[#6B5543]">2</span><div><p className="text-[10px] font-bold text-[#8A8178]">内容怎么展开</p>{analysis.narrativeStructure.length ? <div className="mt-1.5 flex flex-wrap items-center gap-1">{analysis.narrativeStructure.map((stage, index) => <span key={`${stage}:${index}`} className="inline-flex items-center gap-1 text-[11px] text-[#393939]"><span className="border border-[rgba(28,28,30,0.1)] bg-white px-1.5 py-1 font-bold">{advisorGeneratedDisplayText(stage)}</span>{index < analysis.narrativeStructure.length - 1 && <span className="text-[#B0A69D]">→</span>}</span>)}</div> : <p className="mt-1 text-[12px] leading-[1.6] text-[#393939]">文字信息不足，不能判断内容顺序。</p>}</div></li>
          <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5"><span className="flex h-6 w-6 items-center justify-center bg-[#F5EDE4] text-[10px] font-bold text-[#6B5543]">3</span><div><p className="text-[10px] font-bold text-[#8A8178]">怎么让人相信</p><p className="mt-1 text-[12px] leading-[1.6] text-[#393939]">{analysis.proofSignals.length ? advisorGeneratedDisplayList(analysis.proofSignals).join('、') : '还没有找到案例、数字或来源。'}</p></div></li>
          <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5"><span className="flex h-6 w-6 items-center justify-center bg-[#F5EDE4] text-[10px] font-bold text-[#6B5543]">4</span><div><p className="text-[10px] font-bold text-[#8A8178]">怎么引导互动</p><p className="mt-1 text-[12px] leading-[1.6] text-[#393939]">{analysis.ctaTypes.length ? advisorGeneratedDisplayList(analysis.ctaTypes).join('、') : work.ctaPresent ? '发现了互动引导，具体位置需要打开来源确认。' : '公开信息中没有找到互动引导。'}</p></div></li>
          <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5"><span className="flex h-6 w-6 items-center justify-center bg-[#F5EDE4] text-[10px] font-bold text-[#6B5543]">5</span><div><p className="text-[10px] font-bold text-[#8A8178]">画面和制作</p><p className="mt-1 text-[12px] leading-[1.6] text-[#393939]">{analysis.visualSignals.length ? advisorGeneratedDisplayList(analysis.visualSignals).join('、') : '画面信息不足。'} 没有时间点或可播放视频时，不判断具体镜头。</p></div></li>
        </ol>
      </section>

      <section className="border-l-2 border-[#E85D4C] bg-[#FFF8F5] px-3 py-3">
        <p className="text-[10px] font-bold text-[#C94A3B]">你可以怎么借鉴</p>
        <p className="mt-1.5 text-[11px] leading-[1.65] text-[#5D4037]">{confirmedMechanisms[0] ? `参考「${confirmedMechanisms[0]}」这个方法；` : '先打开来源确认开头用了什么方法；'}再换成自己的场景、事实、语言和画面。</p>
      </section>

      {gaps.length > 0 && <section className="border-t border-[rgba(28,28,30,0.08)] pt-3"><p className="text-[10px] font-bold text-[#8A8178]">缺少哪些信息</p><ul className="mt-1.5 space-y-1 text-[10px] leading-[1.55] text-[#8A8178]">{gaps.map((gap) => <li key={gap}>• {advisorGeneratedDisplayText(gap)}</li>)}</ul></section>}
    </div>
  );
}

function ContentDetail({
  work,
  account,
  tab,
  chatMessages,
  busy,
  onTabChange,
  onChat,
}: {
  work: BenchmarkWorkEvidence | undefined;
  account: BenchmarkReport['accounts'][number] | undefined;
  tab: ContentTab;
  chatMessages: AdvisorChatMessage[];
  busy: boolean;
  onTabChange: (tab: ContentTab) => void;
  onChat: (question: string) => Promise<void>;
}) {
  if (!work) return <section className="border border-[rgba(28,28,30,0.1)] bg-white"><EmptySurface icon={PanelRightOpen} title="选择一条内容" detail="原始来源和内容结构会在这里展开。" /></section>;
  return (
    <section className="flex min-h-[660px] min-w-0 flex-col border border-[rgba(28,28,30,0.1)] bg-white">
      <div className="border-b border-[rgba(28,28,30,0.08)] px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="line-clamp-2 text-[14px] font-bold leading-[1.5] text-[#1A1A1A]">{work.title || work.summary || '公开内容'}</p>
            <p className="mt-1 text-[10px] text-[#8A8178]">{account?.label || '参考账号'} · {formatDate(work.publishedAt, true)}</p>
          </div>
          {work.sourceUrl && <a href={work.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1.5 border border-[rgba(28,28,30,0.12)] bg-white px-2 text-[10px] font-bold text-[#2763A6] hover:border-[#2763A6]" title="打开来源页面"><ExternalLink size={13} />打开来源</a>}
        </div>
        <div className="mt-3 inline-flex border border-[rgba(28,28,30,0.12)] bg-white p-0.5">
          <button type="button" onClick={() => onTabChange('original')} className={`h-7 px-2.5 text-[10px] font-bold ${tab === 'original' ? 'bg-[#1C1C1E] text-white' : 'text-[#6B6B6B] hover:bg-[#FDF8F3]'}`}>原始来源</button>
          <button type="button" onClick={() => onTabChange('breakdown')} className={`h-7 px-2.5 text-[10px] font-bold ${tab === 'breakdown' ? 'bg-[#1C1C1E] text-white' : 'text-[#6B6B6B] hover:bg-[#FDF8F3]'}`}>内容结构</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'original' ? (
          <div className="p-4">
            <SourceEvidencePanel
              sourceUrl={work.sourceUrl}
              hasCover={Boolean(work.coverImage || work.coverPath)}
              hasDirectMedia={Boolean(publicHttpUrl(work.embedUrl))}
              hasReadableText={Boolean(work.primaryText)}
              showSourceLink={false}
            />
            <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-[rgba(28,28,30,0.08)] pt-3">
              <div><dt className="text-[10px] text-[#8A8178]">形式</dt><dd className="mt-1 text-[11px] font-bold text-[#393939]">{work.format || '-'}</dd></div>
              <div><dt className="text-[10px] text-[#8A8178]">发布时间</dt><dd className="mt-1 text-[11px] font-bold text-[#393939]">{formatDate(work.publishedAt)}</dd></div>
              <div><dt className="text-[10px] text-[#8A8178]">公开互动</dt><dd className="mt-1 text-[11px] font-bold text-[#393939]">{metricTotal(work) ? compactMetric(metricTotal(work)) : '-'}</dd></div>
            </dl>
          </div>
        ) : <WorkBreakdown work={work} />}
      </div>
      <ChatDock messages={chatMessages} busy={busy} onSend={onChat} placeholder="继续追问这条内容" />
    </section>
  );
}

function ActionCard({ action, runId, busy, onAdopt }: { action: BenchmarkAction; runId: string; busy: boolean; onAdopt: () => void }) {
  const tone = action.priority === 'P0' ? 'bg-[#FFF1EE] text-[#B43C2E]' : action.priority === 'P1' ? 'bg-[#FFF8E8] text-[#8D5A00]' : 'bg-[#EEF5FF] text-[#2763A6]';
  const priorityLabel = action.priority === 'P0' ? '优先' : action.priority === 'P1' ? '其次' : '可选';
  return (
    <article className="border border-[rgba(28,28,30,0.1)] bg-white p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><span className={`inline-flex h-5 items-center px-1.5 text-[10px] font-bold ${tone}`}>{priorityLabel}</span><p className="mt-2 text-[13px] font-bold leading-[1.45] text-[#1A1A1A]">{advisorGeneratedDisplayText(action.title)}</p></div>
        <button type="button" onClick={onAdopt} disabled={!runId || busy} className="inline-flex h-8 shrink-0 items-center gap-1 bg-[#1C1C1E] px-2 text-[10px] font-bold text-white hover:bg-[#353535] disabled:opacity-40" title={runId ? '用于本期内容' : '请先开始做本期内容'}>{busy ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />}用于本期</button>
      </div>
      <p className="mt-2.5 text-[11px] leading-[1.65] text-[#6B6B6B]">{advisorGeneratedDisplayText(action.rationale)}</p>
    </article>
  );
}

function ComparisonWorkbench({ report, runId, busy, onBack, onAdopt }: { report: BenchmarkReport | null; runId: string; busy: string | null; onBack: () => void; onAdopt: (action: BenchmarkAction) => void }) {
  if (!report) return <section className="border border-[rgba(28,28,30,0.1)] bg-white"><EmptySurface icon={BarChart3} title="还没有账号对比" detail="更新一次账号分析后，这里会对比各账号常用的内容方法。" action={<button type="button" onClick={onBack} className="inline-flex h-9 items-center gap-2 border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[12px] font-bold text-[#6B6B6B]"><ArrowLeft size={14} />返回常用方法</button>} /></section>;
  const dimensions = report.comparison.filter((row) => ['内容形式', '开场机制', '互动', '更新节奏', '可迁移机制', '不可迁移条件'].includes(row.dimension));
  return (
    <section className="border border-[rgba(28,28,30,0.1)] bg-white">
      <div className="flex flex-col gap-3 border-b border-[rgba(28,28,30,0.08)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[11px] font-bold text-[#6B6B6B] hover:text-[#C94A3B]"><ArrowLeft size={13} />返回常用方法</button><h2 className="mt-1.5 text-[17px] font-bold text-[#1A1A1A]">账号对比</h2><p className="mt-1 text-[11px] text-[#8A8178]">更新于 {formatDate(report.generatedAt, true)}</p></div>
        <StatusChip tone={report.evidence.status === 'available' ? 'fresh' : 'warning'}>{report.evidence.status === 'available' ? '有原始来源' : '来源信息不足'}</StatusChip>
      </div>
      <TechnicalDetails className="mx-4 mt-4" summary="分析记录"><TechnicalDetailList items={[{ label: '分析编号', value: report.id }]} /></TechnicalDetails>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-3 md:grid-cols-2">
          {dimensions.map((row) => (
            <article key={row.dimension} className="border border-[rgba(28,28,30,0.1)] bg-[#FFFDFC] p-3.5">
              <p className="text-[12px] font-bold text-[#1A1A1A]">{comparisonDimensionLabel(row.dimension)}</p>
              <div className="mt-3 space-y-2.5">
                {row.cells.map((cell) => {
                  const account = report.accounts.find((item) => item.id === cell.accountId);
                  return <div key={cell.accountId} className="border-l-2 border-[#F5EDE4] pl-2.5"><p className="text-[10px] font-bold text-[#8A8178]">{account?.label || '未知账号'}</p><p className="mt-1 text-[11px] leading-[1.6] text-[#393939]">{advisorGeneratedDisplayText(cell.value)}</p>{cell.evidenceLinks[0] && <a href={cell.evidenceLinks[0].url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[10px] text-[#2763A6] hover:underline"><Link2 size={11} />来源</a>}</div>;
                })}
              </div>
            </article>
          ))}
        </div>
        <aside className="border-l-0 border-[rgba(28,28,30,0.09)] xl:border-l xl:pl-4">
          <div className="flex items-center gap-2"><Target size={15} className="text-[#E85D4C]" /><p className="text-[14px] font-bold text-[#1A1A1A]">建议先做</p></div>
          <div className="mt-3 space-y-3">{report.actions.map((action) => <ActionCard key={action.id} action={action} runId={runId} busy={busy === action.id} onAdopt={() => onAdopt(action)} />)}</div>
        </aside>
      </div>
    </section>
  );
}

function videoPlatformLabel(platform: ViralVideoAnalysis['evidence']['platform']): string {
  return platformDisplayName(platform, '视频号');
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '未返回';
  const seconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒` : `${seconds} 秒`;
}

function videoEvidenceFieldLabel(value: string): string {
  const labels: Record<string, string> = {
    title: '标题', author: '作者', published_at: '发布时间', metrics: '互动数据', cover_image: '正式封面', first_frame_image: '视频首帧', video_url: '视频地址', primary_text: '文案/字幕', duration_ms: '时长',
  };
  return labels[value] || '其他信息';
}

function videoTextSourceLabel(value: string): string {
  const labels: Record<string, string> = {
    caption: '字幕',
    captions: '字幕',
    subtitle: '字幕',
    transcript: '转写文字',
    asr: '转写文字',
    description: '公开文案',
    primary_text: '公开文字',
  };
  return labels[value.trim().toLowerCase()] || (value ? '公开文字' : '');
}

function videoCoverLabel(evidence: ViralVideoAnalysis['evidence']): string {
  if (evidence.coverLabel) return advisorGeneratedDisplayText(evidence.coverLabel);
  if (evidence.coverSource === 'wechat_channels_public_preview') return '视频号公开预览封面';
  if (evidence.coverSource === 'video_first_frame' || evidence.coverType === 'first_frame') return '视频首帧';
  if (evidence.coverSource === 'tikomni_cover') return '平台公开封面';
  return evidence.coverPath || evidence.coverImage || evidence.firstFrameImage ? '公开视频主图' : '主图未返回';
}

function videoCoverStatus(evidence: ViralVideoAnalysis['evidence']): string {
  if (evidence.coverPath) return '已保存';
  if (publicHttpUrl(evidence.coverImage) || publicHttpUrl(evidence.firstFrameImage)) return '可以预览，尚未保存';
  return '未返回';
}

function VideoPlatformMark({ platform }: { platform: ViralVideoAnalysis['evidence']['platform'] }) {
  const mark = platform === 'douyin' ? '抖' : platform === 'xiaohongshu' ? '图' : '视';
  const color = platform === 'douyin' ? 'bg-[#FFF1EE] text-[#C94A3B]' : platform === 'xiaohongshu' ? 'bg-[#FFF8E8] text-[#A66300]' : 'bg-[#EDF8F0] text-[#16803C]';
  return <span className={`flex h-7 w-7 shrink-0 items-center justify-center text-[11px] font-bold ${color}`} title={videoPlatformLabel(platform)}>{mark}</span>;
}

function VideoCoverPreview({ evidence }: { evidence: ViralVideoAnalysis['evidence'] }) {
  const archivedSource = evidence.coverPath ? benchmarkMediaUrl({ path: evidence.coverPath }) : '';
  const publicImage = publicHttpUrl(evidence.coverImage) || publicHttpUrl(evidence.firstFrameImage);
  const remoteSource = publicImage ? benchmarkMediaUrl({ url: publicImage }) : '';
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const imageSource = [archivedSource, remoteSource].find((source) => source && !failedSources.includes(source)) || '';

  const label = videoCoverLabel(evidence);
  const showingRemoteFallback = Boolean(archivedSource && remoteSource && imageSource === remoteSource);
  return (
    <figure className="overflow-hidden border border-[rgba(28,28,30,0.1)] bg-[#F5EDE4]">
      <div className="relative aspect-[3/4] min-h-[198px] bg-[#FDF8F3]">
        {imageSource ? (
          <Image
            src={imageSource}
            alt={`${evidence.title || '公开视频'}的${label}`}
            fill
            unoptimized
            sizes="(max-width: 767px) 100vw, (max-width: 1280px) 240px, 280px"
            className="object-cover"
            onError={() => {
              setFailedSources((current) => current.includes(imageSource) ? current : [...current, imageSource]);
            }}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center text-[#8A8178]">
            <Video size={23} strokeWidth={1.8} />
            <p className="mt-2 text-[11px] font-bold">主图暂时无法加载</p>
            <p className="mt-1 text-[10px] leading-[1.55]">可通过来源入口查看原内容</p>
          </div>
        )}
        {imageSource && <span className="absolute bottom-0 left-0 max-w-full bg-[rgba(28,28,30,0.78)] px-2.5 py-1.5 text-[10px] font-bold text-white">{showingRemoteFallback ? '公开来源备用预览' : label}</span>}
      </div>
      <figcaption className="flex items-center justify-between gap-2 border-t border-[rgba(28,28,30,0.08)] bg-white px-2.5 py-2 text-[10px] text-[#6B6B6B]">
        <span className="truncate">{label}</span>
        <span className={`shrink-0 font-bold ${evidence.coverPath ? 'text-[#16803C]' : 'text-[#8A8178]'}`}>{evidence.coverPath ? '已保存' : '公开预览'}</span>
      </figcaption>
    </figure>
  );
}

function VideoEvidenceOverview({ analysis }: { analysis: ViralVideoAnalysis }) {
  const { evidence } = analysis;
  const metrics = Object.entries(evidence.metrics).filter(([, value]) => Number.isFinite(value));
  const coverReturned = Boolean(evidence.coverPath || publicHttpUrl(evidence.coverImage) || publicHttpUrl(evidence.firstFrameImage));
  const videoReturned = Boolean(publicHttpUrl(evidence.videoUrl));
  const returnedFields = [
    Boolean(evidence.title),
    Boolean(evidence.author),
    Boolean(evidence.publishedAt),
    metrics.length > 0,
    coverReturned,
    videoReturned,
    Boolean(evidence.primaryText),
    evidence.durationMs !== null,
  ].filter(Boolean).length;
  const missing = evidence.missingFields.map(videoEvidenceFieldLabel);
  return (
    <section className="mt-3 border-t border-[rgba(28,28,30,0.08)] pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] font-bold text-[#1A1A1A]">已获取的信息</p><span className={`inline-flex h-5 items-center px-1.5 text-[10px] font-bold ${returnedFields >= 7 ? 'bg-[#EDF8F0] text-[#16803C]' : 'bg-[#FFF8E8] text-[#8D5A00]'}`}>已获取 {returnedFields}/8 项</span></div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-4">
        <div><dt className="text-[10px] text-[#8A8178]">平台</dt><dd className="mt-0.5 text-[11px] font-bold text-[#393939]">{videoPlatformLabel(evidence.platform)}</dd></div>
        <div><dt className="text-[10px] text-[#8A8178]">发布时间</dt><dd className="mt-0.5 text-[11px] font-bold text-[#393939]">{formatDate(evidence.publishedAt, true)}</dd></div>
        <div><dt className="text-[10px] text-[#8A8178]">公开时长</dt><dd className="mt-0.5 text-[11px] font-bold text-[#393939]">{formatDuration(evidence.durationMs)}</dd></div>
        <div><dt className="text-[10px] text-[#8A8178]">获取时间</dt><dd className="mt-0.5 text-[11px] font-bold text-[#393939]">{formatDate(evidence.capturedAt, true)}</dd></div>
      </dl>
      <div className="mt-3 border-l-2 border-[#EEF5FF] bg-[#F8FBFF] px-3 py-2.5"><p className="text-[10px] font-bold text-[#2763A6]">公开互动指标</p>{metrics.length ? <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] font-bold tabular-nums text-[#393939]">{metrics.map(([key, value]) => <span key={key}>{metricLabel(key)} {compactMetric(value)}</span>)}</div> : <p className="mt-1 text-[11px] text-[#8A8178]">来源未返回可展示的互动指标。</p>}</div>
      <div className="mt-3 grid gap-2 border-t border-[rgba(28,28,30,0.08)] pt-3 sm:grid-cols-3">
        <div className="border border-[rgba(28,28,30,0.08)] bg-white px-2.5 py-2"><p className="text-[10px] text-[#8A8178]">主图</p><p className={`mt-1 text-[11px] font-bold ${coverReturned ? 'text-[#16803C]' : 'text-[#8D5A00]'}`}>{videoCoverStatus(evidence)}</p><p className="mt-0.5 text-[10px] leading-[1.45] text-[#8A8178]">{coverReturned ? videoCoverLabel(evidence) : '来源暂未提供可验证主图'}</p></div>
        <div className="border border-[rgba(28,28,30,0.08)] bg-white px-2.5 py-2"><p className="text-[10px] text-[#8A8178]">视频地址</p><p className={`mt-1 text-[11px] font-bold ${videoReturned ? 'text-[#A66300]' : 'text-[#8D5A00]'}`}>{videoReturned ? '可以打开查看' : '没有可用地址'}</p><p className="mt-0.5 text-[10px] leading-[1.45] text-[#8A8178]">请在原平台确认完整视频</p></div>
        <div className="border border-[rgba(28,28,30,0.08)] bg-white px-2.5 py-2"><p className="text-[10px] text-[#8A8178]">文字内容</p><p className={`mt-1 text-[11px] font-bold ${evidence.primaryText ? 'text-[#2763A6]' : 'text-[#8D5A00]'}`}>{videoTextSourceLabel(evidence.primaryTextSource) || (evidence.primaryText ? '公开文字' : '暂时没有')}</p><p className="mt-0.5 text-[10px] leading-[1.45] text-[#8A8178]">只根据已获取的文字分析</p></div>
      </div>
      {missing.length > 0 && <p className="mt-2 text-[10px] leading-[1.55] text-[#8A8178]">还缺少：{Array.from(new Set(missing)).join('、')}</p>}
    </section>
  );
}

function VideoAnalysisScope({ analysis }: { analysis: ViralVideoAnalysis }) {
  const { evidence } = analysis;
  const hasReadableText = Boolean(evidence.primaryText.trim());
  const hasDirectVideo = Boolean(publicHttpUrl(evidence.videoUrl));
  return (
    <section className="border-t border-[rgba(28,28,30,0.08)] px-4 py-4">
      <p className="text-[11px] font-bold text-[#8A8178]">使用说明</p>
      <div className="mt-2.5 grid gap-2.5">
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5"><span className={`inline-flex h-5 w-fit items-center px-1.5 text-[10px] font-bold ${hasReadableText ? 'bg-[#EEF5FF] text-[#2763A6]' : 'bg-[#FFF8E8] text-[#8D5A00]'}`}>文字分析</span><p className="text-[11px] leading-[1.65] text-[#5D5650]">{hasReadableText ? `根据${videoTextSourceLabel(evidence.primaryTextSource) || '公开文字'}分析选题、结构和表达。` : '没有完整文案、字幕或转写文本，不会把标题当成全文。'}</p></div>
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5"><span className={`inline-flex h-5 w-fit items-center px-1.5 text-[10px] font-bold ${hasDirectVideo ? 'bg-[#F5EDE4] text-[#A66300]' : 'bg-[#FFF1EE] text-[#B43C2E]'}`}>画面分析</span><p className="text-[11px] leading-[1.65] text-[#5D5650]">{hasDirectVideo ? '可以查看公开封面或视频首帧；完整视频仍需在原平台播放，因此不会猜测具体镜头和时间点。' : '没有可播放的视频地址，暂时不能分析具体镜头。'}</p></div>
      </div>
      {evidence.analysisFields.evidenceLimits.length > 0 && <div className="mt-3 border-l-2 border-[#F0B6AC] bg-[#FFF8F5] px-3 py-2.5"><p className="text-[10px] font-bold text-[#C94A3B]">缺少哪些信息</p><ul className="mt-1.5 space-y-1 text-[10px] leading-[1.55] text-[#6B6B6B]">{evidence.analysisFields.evidenceLimits.map((limit) => <li key={limit}>• {advisorGeneratedDisplayText(limit)}</li>)}</ul></div>}
    </section>
  );
}

function VideoSourcePreview({ analysis, compact = false }: { analysis: ViralVideoAnalysis; compact?: boolean }) {
  const { evidence } = analysis;
  const sourceUrl = publicHttpUrl(evidence.canonicalUrl || evidence.sourceUrl);
  const metrics = Object.entries(evidence.metrics).filter(([, value]) => Number.isFinite(value));
  const sourceTitle = evidence.title || '公开视频标题未返回';
  return (
    <div className="border border-[rgba(28,28,30,0.1)] bg-[#FFFDFC] p-3.5">
      <div className={compact ? 'grid gap-3.5' : 'grid gap-4 sm:grid-cols-[minmax(156px,205px)_minmax(0,1fr)]'}>
        <VideoCoverPreview evidence={evidence} />
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <VideoPlatformMark platform={evidence.platform} />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-[#8A8178]">{videoPlatformLabel(evidence.platform)} · 公开来源</p>
                <h3 className="mt-1 line-clamp-3 text-[15px] font-bold leading-[1.55] text-[#1A1A1A]">{sourceTitle}</h3>
              </div>
            </div>
            {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1.5 border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[10px] font-bold text-[#2763A6] transition-colors hover:border-[#2763A6] hover:bg-[#F7FBFF] active:translate-y-px" title="打开公开来源"><ExternalLink size={13} />来源</a>}
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-y border-[rgba(28,28,30,0.08)] py-3">
            <div><dt className="text-[10px] text-[#8A8178]">作者</dt><dd className="mt-1 truncate text-[11px] font-bold text-[#393939]">{evidence.author || '未返回'}</dd></div>
            <div><dt className="text-[10px] text-[#8A8178]">平台</dt><dd className="mt-1 text-[11px] font-bold text-[#393939]">{videoPlatformLabel(evidence.platform)}</dd></div>
            <div><dt className="text-[10px] text-[#8A8178]">发布时间</dt><dd className="mt-1 text-[11px] font-bold text-[#393939]">{formatDate(evidence.publishedAt, true)}</dd></div>
            <div><dt className="text-[10px] text-[#8A8178]">时长</dt><dd className="mt-1 text-[11px] font-bold text-[#393939]">{formatDuration(evidence.durationMs)}</dd></div>
          </dl>

          <div className="mt-3">
            <p className="text-[10px] font-bold text-[#8A8178]">公开互动数据</p>
            {metrics.length ? <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] font-bold tabular-nums text-[#393939]">{metrics.map(([key, value]) => <span key={key}>{metricLabel(key)} {compactMetric(value)}</span>)}</div> : <p className="mt-1 text-[11px] text-[#8A8178]">来源未返回可展示的互动指标。</p>}
          </div>
        </div>
      </div>
      <VideoEvidenceOverview analysis={analysis} />
      <div className="mt-4"><SourceEvidencePanel sourceUrl={evidence.canonicalUrl || evidence.sourceUrl} hasCover={Boolean(evidence.coverPath || publicHttpUrl(evidence.coverImage) || publicHttpUrl(evidence.firstFrameImage))} hasDirectMedia={Boolean(publicHttpUrl(evidence.videoUrl))} hasReadableText={Boolean(evidence.primaryText.trim())} /></div>
    </div>
  );
}

function VideoReport({
  analysis,
  tab,
  runId,
  busy,
  chatMessages,
  onTabChange,
  onAdopt,
  onChat,
}: {
  analysis: ViralVideoAnalysis;
  tab: VideoTab;
  runId: string;
  busy: string | null;
  chatMessages: AdvisorChatMessage[];
  onTabChange: (value: VideoTab) => void;
  onAdopt: (angle: ViralVideoAngle) => void;
  onChat: (question: string) => Promise<void>;
}) {
  const { breakdown } = analysis;
  return (
    <section className="min-w-0 border border-[rgba(28,28,30,0.1)] bg-white">
      <div className="flex flex-col gap-3 border-b border-[rgba(28,28,30,0.08)] px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div><div className="flex flex-wrap items-center gap-2"><Sparkles size={16} className="text-[#E85D4C]" /><h2 className="text-[17px] font-bold text-[#1A1A1A]">视频内容分析</h2>{breakdown.status === 'limited' && <StatusChip tone="stale">信息不足</StatusChip>}{breakdown.structure.length > 0 && <StatusChip tone="fresh">内容结构 {breakdown.structure.length} 步</StatusChip>}</div><p className="mt-1 text-[11px] text-[#8A8178]">{formatDate(analysis.createdAt, true)} · 已保存到本项目</p></div>
        <div className="inline-flex border border-[rgba(28,28,30,0.12)] bg-white p-0.5"><button type="button" onClick={() => onTabChange('source')} className={`h-7 px-2.5 text-[10px] font-bold ${tab === 'source' ? 'bg-[#1C1C1E] text-white' : 'text-[#6B6B6B]'}`}>原始来源</button><button type="button" onClick={() => onTabChange('breakdown')} className={`h-7 px-2.5 text-[10px] font-bold ${tab === 'breakdown' ? 'bg-[#1C1C1E] text-white' : 'text-[#6B6B6B]'}`}>内容结构</button></div>
      </div>
      {tab === 'source' ? <div className="max-w-[880px] p-5"><VideoSourcePreview analysis={analysis} /></div> : (
        <div className="p-5">
          {breakdown.qualityWarnings && breakdown.qualityWarnings.length > 0 && (
            <div className="mb-4 border border-[#E7D7A7] bg-[#FFF9E8] px-3 py-2.5 text-[11px] leading-[1.65] text-[#6E5A24]" role="status">
              这次分析有几处表达需要你复核：{advisorGeneratedDisplayText(breakdown.qualityWarnings[0])}
            </div>
          )}
          <div className="grid gap-5 border-b border-[rgba(28,28,30,0.08)] pb-5 xl:grid-cols-[minmax(260px,0.38fr)_minmax(0,0.62fr)]">
            <VideoSourcePreview analysis={analysis} compact />
            <div className="min-w-0 border border-[rgba(28,28,30,0.1)] bg-[#FFFDFC]">
              <section className="px-4 py-4">
                <div className="flex items-center gap-2 text-[#A66300]"><Target size={14} /><p className="text-[11px] font-bold">这条视频讲什么</p></div>
                <p className="mt-2 text-[16px] font-bold leading-[1.5] text-[#1A1A1A]">{breakdown.topic ? advisorGeneratedDisplayText(breakdown.topic) : '未从公开信息中确认选题'}</p>
                <div className="mt-3 border-l-2 border-[#F0B6AC] pl-3"><p className="text-[10px] font-bold text-[#8A8178]">适合谁看</p><p className="mt-1 text-[12px] leading-[1.65] text-[#5D5650]">{breakdown.audience ? advisorGeneratedDisplayText(breakdown.audience) : '公开信息不足，暂时不能判断读者。'}</p></div>
              </section>
              <section className="border-t border-[rgba(28,28,30,0.08)] bg-[#FFF8F5] px-4 py-4">
                <div className="flex items-center gap-2 text-[#C94A3B]"><Play size={14} /><p className="text-[11px] font-bold">开头怎么吸引人</p></div>
                <p className="mt-2 text-[13px] font-bold leading-[1.7] text-[#5D4037]">{breakdown.hook ? advisorGeneratedDisplayText(breakdown.hook) : '公开文字不足，暂时不能判断开头用了什么方法。'}</p>
              </section>
              <VideoBreakdownList title="内容结构" values={breakdown.structure} icon={FileText} ordered dense description="按内容顺序查看，借鉴方法但不照搬原文。" />
              <VideoBreakdownList title="可能有效的原因" values={breakdown.whyItWorks} icon={Sparkles} dense />
              <VideoAnalysisScope analysis={analysis} />
            </div>
          </div>

          <div className="mt-5 grid gap-x-6 gap-y-5 lg:grid-cols-2">
            <VideoBreakdownList title="表达方式" values={breakdown.expressionMethods} icon={MessageCircle} description="只总结从公开内容中能确认的表达选择。" />
            <VideoBreakdownList title="可以借鉴的做法" values={breakdown.reusablePractices} icon={Check} variant="accent" description="用于自己的内容时，换成自己的事实、案例和语言。" />
            <VideoBreakdownList title="拍摄与剪辑提示" values={breakdown.productionNotes} icon={Video} variant="warm" description="只写公开内容能支持的观察，信息不足时会明确说明。" />
          </div>

          <section className="mt-6 border-t border-[rgba(28,28,30,0.08)] pt-4"><div className="flex items-center gap-2"><Lightbulb size={15} className="text-[#E85D4C]" /><p className="text-[14px] font-bold text-[#1A1A1A]">3 个适合你账号的新角度</p></div><div className="mt-3 grid gap-3 xl:grid-cols-3">{breakdown.angles.map((angle) => <VideoAngleCard key={angle.id} angle={angle} runId={runId} busy={busy === angle.id} onAdopt={() => onAdopt(angle)} />)}</div></section>
          <div className="mt-5 border-l-2 border-[#E85D4C] bg-[#FFF8F5] px-3 py-2.5 text-[11px] leading-[1.65] text-[#5D4037]">{advisorGeneratedDisplayList(breakdown.guardrails).join(' ')}</div>
        </div>
      )}
      <ChatDock messages={chatMessages} busy={busy === 'chat'} onSend={onChat} placeholder="继续追问这条视频" />
    </section>
  );
}

function VideoBreakdownList({
  title,
  values,
  icon: Icon,
  description,
  ordered = false,
  dense = false,
  variant = 'default',
}: {
  title: string;
  values: string[];
  icon: typeof Target;
  description?: string;
  ordered?: boolean;
  dense?: boolean;
  variant?: 'default' | 'accent' | 'warm';
}) {
  const color = variant === 'accent' ? 'text-[#C94A3B]' : variant === 'warm' ? 'text-[#A66300]' : 'text-[#2763A6]';
  const marker = variant === 'accent' ? 'bg-[#FFF1EE] text-[#C94A3B]' : variant === 'warm' ? 'bg-[#FFF8E8] text-[#8D5A00]' : 'bg-[#EEF5FF] text-[#2763A6]';
  const rows = values.length ? values : ['公开信息不足，暂时不能判断。'];
  return (
    <section className={dense ? 'border-t border-[rgba(28,28,30,0.08)] px-4 py-4' : 'border-t border-[rgba(28,28,30,0.08)] pt-4'}>
      <div className={`flex items-center gap-2 ${color}`}><Icon size={14} /><p className="text-[12px] font-bold">{title}</p></div>
      {description && <p className="mt-1 text-[10px] leading-[1.55] text-[#8A8178]">{description}</p>}
      <ol className="mt-3 space-y-2">
        {rows.map((item, index) => (
          <li key={`${item}:${index}`} className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5">
            <span className={`mt-0.5 flex h-5 w-5 items-center justify-center text-[10px] font-bold ${marker}`}>{ordered ? String(index + 1).padStart(2, '0') : <Check size={12} strokeWidth={2.5} />}</span>
            <p className="text-[12px] leading-[1.7] text-[#393939]">{advisorGeneratedDisplayText(item)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function VideoAngleCard({ angle, runId, busy, onAdopt }: { angle: ViralVideoAngle; runId: string; busy: boolean; onAdopt: () => void }) {
  return (
    <article className="border border-[rgba(28,28,30,0.1)] bg-[#FFFDFC] p-3.5">
      <p className="text-[13px] font-bold text-[#1A1A1A]">{advisorGeneratedDisplayText(angle.title)}</p>
      <p className="mt-2 text-[11px] leading-[1.65] text-[#6B6B6B]">{advisorGeneratedDisplayText(angle.rationale)}</p>
      <p className="mt-2 border-l-2 border-[#E85D4C] pl-2.5 text-[11px] leading-[1.6] text-[#5D4037]">{advisorGeneratedDisplayText(angle.adoptionText)}</p>
      <div className="mt-3 border-t border-[rgba(28,28,30,0.08)] pt-2.5">
        <p className="text-[10px] font-bold text-[#2763A6]">发布后观察</p>
        <p className="mt-1 text-[10px] leading-[1.55] text-[#6B6B6B]">{advisorGeneratedDisplayText(angle.proposedExperiment)}</p>
      </div>
      <p className="mt-2 text-[10px] leading-[1.55] text-[#8A8178]">不要照搬：{advisorGeneratedDisplayText(angle.guardrail)}</p>
      <button type="button" onClick={onAdopt} disabled={!runId || busy} className="mt-3 inline-flex h-8 items-center gap-1.5 bg-[#1C1C1E] px-2.5 text-[10px] font-bold text-white hover:bg-[#353535] disabled:opacity-40" title={runId ? '用于本期内容' : '请先开始做本期内容'}>{busy ? <LoaderCircle size={12} className="animate-spin" /> : <ArrowUpRight size={12} />}用于本期内容</button>
    </article>
  );
}

export default function BenchmarkAdvisorPage() {
  const [mode, setMode] = useState<WorkbenchMode>('accounts');
  const [libraryView, setLibraryView] = useState<LibraryView>('distillation');
  const [state, setState] = useState<BenchmarkAdvisorState>(EMPTY_STATE);
  const [projectId, setProjectId] = useState(() => {
    if (typeof window === 'undefined') return 'default';
    const query = new URLSearchParams(window.location.search).get('projectId') || '';
    const saved = window.localStorage.getItem(PROJECT_STORAGE_KEY) || '';
    return PROJECT_ID_RE.test(query) ? query : PROJECT_ID_RE.test(saved) ? saved : 'default';
  });
  const [runId, setRunId] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedWorkKey, setSelectedWorkKey] = useState('');
  const [period, setPeriod] = useState<StreamPeriod>('30d');
  const [sort, setSort] = useState<StreamSort>('latest');
  const [visibleWorks, setVisibleWorks] = useState(DEFAULT_VISIBLE_WORKS);
  const [contentTab, setContentTab] = useState<ContentTab>('breakdown');
  const [videoTab, setVideoTab] = useState<VideoTab>('breakdown');
  const [videoUrl, setVideoUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshIssue, setRefreshIssue] = useState('');
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [accountDraft, setAccountDraft] = useState<AccountDraft | null>(null);
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const [accountFormError, setAccountFormError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const loadAdvisorState = useCallback(async (targetProjectId: string) => {
    const response = await fetch(`/api/benchmark-advisor?${new URLSearchParams({ projectId: targetProjectId }).toString()}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({})) as BenchmarkAdvisorState & { error?: string };
    if (!response.ok) throw new Error(data.error || '读取账号与视频分析失败。');
    return data;
  }, []);

  const loadActiveRun = useCallback(async () => {
    try {
      const response = await fetch('/api/status?view=active-run', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as StatusResponse;
      const nextRun = data.activeRun?.run_id || data.latest?.active_run_id || '';
      const activeProject = data.activeRun?.project_id || '';
      if (nextRun) setRunId(nextRun);
      if (activeProject && PROJECT_ID_RE.test(activeProject)) setProjectId((current) => current === 'default' ? activeProject : current);
    } catch {
      // The workbench remains usable when runtime state is not available.
    }
  }, []);

  useEffect(() => {
    if (!PROJECT_ID_RE.test(projectId)) return;
    window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
    let disposed = false;
    const load = async () => {
      try {
        const advisor = await loadAdvisorState(projectId);
        if (disposed) return;
        setState(advisor);
        setAuthorizationConfirmed(advisor.authorizationConfirmed);
        setRefreshIssue(advisor.weekly.lastRefreshError
          ? displayClientError(advisor.weekly.lastRefreshError, '账号内容没有更新成功。请重试。')
          : '');
        setIsLoading(false);
        // The advisor archive is already local. Do not keep its first render behind
        // the much larger global runtime status response.
        void loadActiveRun();
      } catch (error) {
        if (!disposed) {
          setIsLoading(false);
          toast.error(displayClientError(error, '账号与视频分析没有读取成功。请刷新后重试。'));
        }
      }
    };
    void load();
    return () => { disposed = true; };
  }, [loadActiveRun, loadAdvisorState, projectId]);

  const activeAccountId = state.accounts.some((item) => item.id === selectedAccountId) ? selectedAccountId : state.accounts[0]?.id || '';
  const reportAccount = useMemo(() => state.latestReport?.accounts.find((item) => item.id === activeAccountId), [activeAccountId, state.latestReport]);
  const streamWorks = useMemo(() => {
    const source = reportAccount?.works || [];
    const snapshotTime = new Date(state.latestReport?.generatedAt || state.weekly.lastRefreshAt || '').getTime();
    const cutoff = Number.isFinite(snapshotTime) ? snapshotTime - ({ '7d': 7, '30d': 30, '90d': 90 }[period] * 24 * 60 * 60 * 1000) : 0;
    const filtered = source.filter((work) => {
      const stamp = new Date(work.publishedAt).getTime();
      return !Number.isFinite(stamp) || stamp >= cutoff;
    });
    return [...filtered].sort((left, right) => sort === 'heat'
      ? metricTotal(right) - metricTotal(left)
      : new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime());
  }, [period, reportAccount, sort, state.latestReport?.generatedAt, state.weekly.lastRefreshAt]);
  const activeWorkKey = streamWorks.some((work, index) => workKey(work, index) === selectedWorkKey) ? selectedWorkKey : (streamWorks[0] ? workKey(streamWorks[0], 0) : '');
  const selectedWork = useMemo(() => streamWorks.find((work, index) => workKey(work, index) === activeWorkKey), [activeWorkKey, streamWorks]);
  const displayedStreamWorks = useMemo(() => streamWorks.slice(0, visibleWorks), [streamWorks, visibleWorks]);
  const stale = Boolean(state.latestReport && (state.weekly.refreshDue || refreshIssue || state.weekly.lastRefreshError));
  const chatMessages = state.chatHistory;
  const accountChatMessages = useMemo(() => chatMessages.filter((message) => (
    message.context?.accountId === activeAccountId
    && (!selectedWork?.sourceUrl || message.context?.workUrl === selectedWork.sourceUrl)
  )), [activeAccountId, chatMessages, selectedWork]);

  const refresh = async () => {
    setBusy('refresh');
    try {
      const next = await postAdvisor(projectId, { action: 'refresh' });
      setState(next);
      setRefreshIssue('');
      toast.success('账号分析已更新。');
    } catch (error) {
      const message = displayClientError(error, '账号分析没有更新成功。请重试。');
      setRefreshIssue(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const openAddAccount = () => {
    setAccountDraft(makeAccount());
    setAuthorizationConfirmed(state.authorizationConfirmed);
    setAccountFormError('');
    setAccountDialogOpen(true);
  };
  const openEditAccount = (account: BenchmarkAccount) => {
    setAccountDraft(toDraft(account));
    setAuthorizationConfirmed(state.authorizationConfirmed);
    setAccountFormError('');
    setAccountDialogOpen(true);
  };
  const saveAccount = async () => {
    if (!accountDraft) return;
    const existing = state.accounts.map(toDraft);
    const exists = existing.some((account) => account.id === accountDraft.id);
    const accounts = exists ? existing.map((account) => account.id === accountDraft.id ? accountDraft : account) : [...existing, accountDraft];
    setBusy('save-account');
    try {
      const next = await postAdvisor(projectId, { action: 'save_accounts', accounts, customerAuthorizationConfirmed: authorizationConfirmed });
      setState(next);
      setSelectedAccountId(accountDraft.id);
      setAccountDialogOpen(false);
      setAccountFormError('');
      toast.success('参考账号已保存。');
    } catch (error) {
      const message = displayClientError(error, '账号没有保存成功。请重试。');
      setAccountFormError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };
  const removeAccount = async (account: BenchmarkAccount) => {
    if (!window.confirm(`移除「${account.label}」？已有的分析记录会保留。`)) return;
    const accounts = state.accounts.filter((item) => item.id !== account.id).map(toDraft);
    if (!accounts.length) {
      toast.error('至少保留一个账号；如需清空，请到项目文件中处理。');
      return;
    }
    setBusy('remove-account');
    try {
      const next = await postAdvisor(projectId, { action: 'save_accounts', accounts, customerAuthorizationConfirmed: true });
      setState(next);
      toast.success('参考账号已移除。');
    } catch (error) {
      toast.error(displayClientError(error, '账号没有移除成功。请重试。'));
    } finally {
      setBusy(null);
    }
  };

  const adoptAction = async (action: BenchmarkAction) => {
    if (!runId) {
      toast.error('请先开始做本期内容，再把这个方法带过去。');
      return;
    }
    setBusy(action.id);
    try {
      const result = await postAdvisor(projectId, { action: 'adopt', runId, actionId: action.id });
      toast.success(`已用于本期内容，当前保存 ${result.adoptedCount || 1} 条方法。`);
    } catch (error) {
      toast.error(displayClientError(error, '暂时无法用于本期内容。请稍后重试。'));
    } finally {
      setBusy(null);
    }
  };

  const sendChat = async (question: string, context: Record<string, unknown> = {}) => {
    setBusy('chat');
    try {
      const next = await postAdvisor(projectId, { action: 'chat', question, context });
      setState(next);
    } catch (error) {
      const message = displayClientError(error, '暂时无法回答这个问题。请稍后重试。');
      toast.error(message);
      throw error;
    } finally {
      setBusy(null);
    }
  };

  const analyzeVideo = async () => {
    if (!isSupportedVideoUrl(videoUrl)) return;
    setBusy('analyze-video');
    setVideoTab('breakdown');
    try {
      const next = await postAdvisor(projectId, { action: 'analyze_video', sourceUrl: videoUrl.trim() });
      setState(next);
      toast.success(next.cached ? '已打开本项目保存的视频分析。' : '视频内容分析已生成。');
    } catch (error) {
      toast.error(displayClientError(error, '视频没有分析成功。请重试。'));
    } finally {
      setBusy(null);
    }
  };

  const adoptVideoAngle = async (angle: ViralVideoAngle) => {
    const analysis = state.latestVideoAnalysis;
    if (!analysis || !runId) {
      toast.error('请先开始做本期内容，再把这个角度带过去。');
      return;
    }
    setBusy(angle.id);
    try {
      const result = await postAdvisor(projectId, { action: 'adopt_video_angle', runId, analysisId: analysis.id, angleId: angle.id });
      toast.success(`已用于本期内容，当前保存 ${result.adoptedCount || 1} 个角度。`);
    } catch (error) {
      toast.error(displayClientError(error, '暂时无法把这个角度用于本期内容。请稍后重试。'));
    } finally {
      setBusy(null);
    }
  };

  const accountChat = (question: string) => sendChat(question, { accountId: activeAccountId, workUrl: selectedWork?.sourceUrl || '' });
  const videoChat = (question: string) => sendChat(question, { videoAnalysisId: state.latestVideoAnalysis?.id || '' });
  const videoInputInvalid = Boolean(videoUrl.trim()) && !isSupportedVideoUrl(videoUrl);
  const resetContentStream = () => {
    setVisibleWorks(DEFAULT_VISIBLE_WORKS);
    setSelectedWorkKey('');
  };

  return (
    <div className="aifios-editorial-page mx-auto w-full max-w-[1640px] space-y-3">
      <section className="border border-[rgba(28,28,30,0.1)] bg-white shadow-[0_8px_22px_rgba(74,51,44,0.035)]">
        <div className="flex flex-col gap-4 px-5 pb-4 pt-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[#E85D4C]"><Target size={16} /><span className="text-[11px] font-bold">参考分析</span></div>
            <h1 className="mt-1.5 text-balance text-[24px] font-bold leading-[1.2] text-[#1A1A1A]">{PRODUCT_COPY.pages.benchmarkAdvisor.title}</h1>
            <nav aria-label="账号与视频分析方式" className="mt-3 grid w-full max-w-[320px] grid-cols-2 rounded-lg border border-[#E7DED6] bg-[#FBF7F3] p-1">
              <button type="button" onClick={() => setMode('accounts')} aria-pressed={mode === 'accounts'} className={`h-10 min-w-0 rounded-md px-2 text-[13px] font-bold transition-colors duration-150 active:translate-y-px ${mode === 'accounts' ? 'bg-[#1C1C1E] text-white shadow-[0_1px_2px_rgba(28,28,30,0.12)]' : 'text-[#6B6B6B] hover:bg-white hover:text-[#1A1A1A]'}`}>分析账号</button>
              <button type="button" onClick={() => setMode('video')} aria-pressed={mode === 'video'} className={`h-10 min-w-0 rounded-md px-2 text-[13px] font-bold transition-colors duration-150 active:translate-y-px ${mode === 'video' ? 'bg-[#1C1C1E] text-white shadow-[0_1px_2px_rgba(28,28,30,0.12)]' : 'text-[#6B6B6B] hover:bg-white hover:text-[#1A1A1A]'}`}>分析视频</button>
            </nav>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {mode === 'accounts' && <button type="button" onClick={() => void refresh()} disabled={busy === 'refresh' || !state.authorizationConfirmed || !state.accounts.length} className="inline-flex h-9 items-center gap-2 bg-[#1C1C1E] px-3.5 text-[12px] font-bold text-white transition-colors duration-150 hover:bg-[#353535] active:translate-y-px disabled:opacity-45">{busy === 'refresh' ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}更新分析</button>}
            <StatusChip tone={stale ? 'stale' : state.latestReport ? 'fresh' : 'neutral'}>{stale ? `数据需要更新 · ${formatDate(state.weekly.lastRefreshAt)}` : state.latestReport ? `上次更新 ${formatDate(state.weekly.lastRefreshAt)}` : '尚未分析'}</StatusChip>
          </div>
        </div>
        {mode === 'accounts' && <nav aria-label="账号分析视图" className="grid grid-cols-3 gap-1 border-t border-[rgba(28,28,30,0.08)] bg-white px-3 py-2 sm:flex sm:px-5"><button type="button" onClick={() => setLibraryView('distillation')} aria-pressed={libraryView === 'distillation'} className={`min-h-10 min-w-0 rounded-md px-1.5 text-[11px] font-bold leading-[1.35] sm:h-8 sm:min-h-0 sm:whitespace-nowrap sm:px-3 ${libraryView === 'distillation' ? 'bg-[#FFF1EE] text-[#B43C2E]' : 'text-[#6B6B6B] hover:bg-[#FDF8F3]'}`}>常用内容方法</button><button type="button" onClick={() => setLibraryView('stream')} aria-pressed={libraryView === 'stream'} className={`min-h-10 min-w-0 rounded-md px-1.5 text-[11px] font-bold leading-[1.35] sm:h-8 sm:min-h-0 sm:whitespace-nowrap sm:px-3 ${libraryView === 'stream' ? 'bg-[#FFF1EE] text-[#B43C2E]' : 'text-[#6B6B6B] hover:bg-[#FDF8F3]'}`}>作品列表与分析</button><button type="button" onClick={() => setLibraryView('comparison')} aria-pressed={libraryView === 'comparison'} disabled={!state.latestReport} className={`min-h-10 min-w-0 rounded-md px-1.5 text-[11px] font-bold leading-[1.35] disabled:opacity-35 sm:h-8 sm:min-h-0 sm:whitespace-nowrap sm:px-3 ${libraryView === 'comparison' ? 'bg-[#FFF1EE] text-[#B43C2E]' : 'text-[#6B6B6B] hover:bg-[#FDF8F3]'}`}>账号对比</button></nav>}
        {mode === 'accounts' && <div className="flex flex-col gap-2 border-t border-[rgba(28,28,30,0.08)] bg-[#FFFDFC] px-5 py-2.5 sm:flex-row sm:items-center"><div className="flex min-w-0 items-center gap-2"><BellRing size={14} className="shrink-0 text-[#A66300]" /><p className="truncate text-[11px] leading-[1.6] text-[#5D5650]"><span className="font-bold">本周变化</span> · {state.weekly.changeSummary ? advisorGeneratedDisplayText(state.weekly.changeSummary) : state.accounts.length ? '等待本周分析结果。' : '添加公开账号后开始每周记录变化。'}</p></div>{state.latestReport?.actions[0] && <span className="hidden shrink-0 text-[11px] text-[#8A8178] sm:block">建议先做：{advisorGeneratedDisplayText(state.latestReport.actions[0].title)}</span>}</div>}
        {mode === 'accounts' && <ResearchProgress accountCount={state.accounts.length} report={state.latestReport} activeAccount={reportAccount} selectedWork={selectedWork} runId={runId} />}
      </section>

      {mode === 'accounts' ? (
        libraryView === 'comparison' ? <ComparisonWorkbench report={state.latestReport} runId={runId} busy={busy} onBack={() => setLibraryView('distillation')} onAdopt={adoptAction} /> : libraryView === 'distillation' ? (
          isLoading ? <AdvisorWorkbenchSkeleton /> : <div className="grid gap-4 xl:grid-cols-[216px_minmax(0,1fr)]">
            <AccountRail accounts={state.accounts} report={state.latestReport} selectedId={activeAccountId} stale={stale} onSelect={(id) => { setSelectedAccountId(id); resetContentStream(); }} onAdd={openAddAccount} onEdit={openEditAccount} onRemove={(account) => void removeAccount(account)} />
            <AccountDistillation account={reportAccount} configuredAccount={state.accounts.find((item) => item.id === activeAccountId)} report={state.latestReport} onOpenWorks={() => setLibraryView('stream')} onOpenComparison={() => setLibraryView('comparison')} />
          </div>
        ) : (
          isLoading ? <AdvisorWorkbenchSkeleton /> : <div className="grid gap-4 xl:grid-cols-[216px_minmax(310px,0.92fr)_minmax(360px,1.08fr)]">
            <AccountRail accounts={state.accounts} report={state.latestReport} selectedId={activeAccountId} stale={stale} onSelect={(id) => { setSelectedAccountId(id); setContentTab('breakdown'); resetContentStream(); }} onAdd={openAddAccount} onEdit={openEditAccount} onRemove={(account) => void removeAccount(account)} />
            <ContentStream account={reportAccount} works={displayedStreamWorks} totalWorks={streamWorks.length} period={period} sort={sort} selectedKey={activeWorkKey} stale={stale} error={refreshIssue || (state.weekly.lastRefreshError ? displayClientError(state.weekly.lastRefreshError, '账号内容没有更新成功。请重试。') : '')} onPeriodChange={(value) => { setPeriod(value); resetContentStream(); }} onSortChange={(value) => { setSort(value); resetContentStream(); }} onSelect={(key) => { setSelectedWorkKey(key); setContentTab('breakdown'); }} onShowAll={() => setVisibleWorks(streamWorks.length)} />
            <ContentDetail work={selectedWork} account={reportAccount} tab={contentTab} chatMessages={accountChatMessages} busy={busy === 'chat'} onTabChange={setContentTab} onChat={accountChat} />
          </div>
        )
      ) : (
        <div className="grid gap-3 xl:grid-cols-[294px_minmax(0,1fr)]">
          <aside className="self-start border border-[rgba(28,28,30,0.1)] bg-white p-4 xl:sticky xl:top-0">
            <div className="flex items-center gap-2"><Video size={16} className="text-[#E85D4C]" /><p className="text-[15px] font-bold text-[#1A1A1A]">视频链接</p></div>
            <p className="mt-1.5 text-[11px] leading-[1.65] text-[#6B6B6B]">支持已公开可访问的视频来源链接。</p>
            <textarea value={videoUrl} onChange={(event) => setVideoUrl(event.target.value)} rows={6} placeholder="粘贴一个公开视频链接" aria-invalid={videoInputInvalid} aria-describedby={videoInputInvalid ? 'video-url-error' : undefined} className={`mt-4 block w-full resize-none border bg-[#FDF8F3] p-3 text-[12px] leading-[1.6] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C] ${videoInputInvalid ? 'border-[#C94A3B]' : 'border-[rgba(28,28,30,0.14)]'}`} />
            {videoInputInvalid && <p id="video-url-error" className="mt-2 text-[11px] leading-[1.5] text-[#B43C2E]">请使用抖音、小红书或视频号的公开视频链接。</p>}
            <button type="button" onClick={() => void analyzeVideo()} disabled={busy === 'analyze-video' || !isSupportedVideoUrl(videoUrl)} className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 bg-[#E85D4C] text-[12px] font-bold text-white hover:bg-[#C94A3B] disabled:opacity-45">{busy === 'analyze-video' ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}{busy === 'analyze-video' ? '正在读取公开信息并分析视频' : '分析视频'}</button>
            {busy === 'analyze-video' && <p className="mt-2 text-[11px] leading-[1.5] text-[#6B6B6B]" aria-live="polite">正在读取视频信息，请稍候。</p>}
            <div className="mt-4 border-t border-[rgba(28,28,30,0.08)] pt-3"><p className="text-[10px] font-bold text-[#8A8178]">使用说明</p><p className="mt-1.5 text-[11px] leading-[1.65] text-[#6B6B6B]">只参考选题、结构和表达方式，不复制原内容。</p></div>
          </aside>
          {state.latestVideoAnalysis ? <VideoReport analysis={state.latestVideoAnalysis} tab={videoTab} runId={runId} busy={busy} chatMessages={chatMessages.filter((message) => message.videoAnalysisId === state.latestVideoAnalysis?.id)} onTabChange={setVideoTab} onAdopt={(angle) => void adoptVideoAngle(angle)} onChat={videoChat} /> : <section className="border border-[rgba(28,28,30,0.1)] bg-white"><EmptySurface icon={Play} title="还没有视频分析" detail="粘贴一个公开视频链接，分析结果会显示在这里。" /></section>}
        </div>
      )}

      <AccountFormDialog open={accountDialogOpen} draft={accountDraft} authorizationConfirmed={authorizationConfirmed} saving={busy === 'save-account'} error={accountFormError} onOpenChange={(open) => { setAccountDialogOpen(open); if (!open) setAccountFormError(''); }} onChange={(draft) => { setAccountDraft(draft); setAccountFormError(''); }} onAuthorizationChange={setAuthorizationConfirmed} onSave={() => void saveAccount()} />
    </div>
  );
}

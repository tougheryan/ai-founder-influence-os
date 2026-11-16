'use client';

import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Filter,
  Flame,
  Layers3,
  SearchCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { useMemo, useState } from 'react';

export type TikOmniSampleMetricValue = number | string | null | undefined;

export type TikOmniSampleRow = {
  id: string;
  platform: string;
  title: string;
  account: string;
  publishedAt?: string;
  interactions?: number | null;
  contentForm?: string;
  url?: string;
  hitPoint?: string;
  metrics?: Record<string, TikOmniSampleMetricValue>;
  sampleClass?: 'verified_hit' | 'potential' | 'related' | 'insufficient';
  hitScore?: number;
  classificationReason?: string;
  evidenceStatus?: 'sufficient' | 'insufficient';
  confidence?: number;
  metricCompleteness?: number;
  ageDays?: number | null;
  scoreComponents?: Record<string, number>;
  creatorLift?: number | null;
  engagementRate?: number | null;
  scoreVersion?: string;
};

export type TikOmniPlatform = {
  id: string;
  label: string;
  detail?: string;
};

export type TikOmniSampleFilters = {
  form: string;
  metrics: string;
  time: string;
};

export type TikOmniSampleSort =
  | 'original'
  | 'interactions_desc'
  | 'interactions_asc'
  | 'published_desc'
  | 'published_asc';

export type TikOmniSampleFilterOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type TikOmniSampleFilterOptions = {
  forms?: readonly TikOmniSampleFilterOption[];
  metrics?: readonly TikOmniSampleFilterOption[];
  times?: readonly TikOmniSampleFilterOption[];
};

export type TikOmniSamplePlatformGroup = {
  id: string;
  label: string;
  detail?: string;
  total: number;
  samples: TikOmniSampleRow[];
};

export type TikOmniSampleBrowserProps = {
  /** Rows should already reflect the current filters and sort owned by the parent. */
  sampleRows: readonly TikOmniSampleRow[];
  /** Current draft context and the complete, unfiltered saved references. */
  overview?: {
    topic: string;
    queries: readonly string[];
    samples: readonly TikOmniSampleRow[];
  };
  /** The total returned by the research service before any client-side presentation. */
  platformTotals: Readonly<Record<string, number>>;
  filters: TikOmniSampleFilters;
  sort: TikOmniSampleSort;
  onFiltersChange: (filters: TikOmniSampleFilters) => void;
  onSortChange: (sort: TikOmniSampleSort) => void;
  onContinue: () => void;
  busy?: boolean;
  platforms?: readonly TikOmniPlatform[];
  onlyProvidedPlatforms?: boolean;
  filterOptions?: TikOmniSampleFilterOptions;
};

const DEFAULT_PLATFORMS: readonly TikOmniPlatform[] = [
  { id: 'wechat_mp', label: '公众号', detail: '相关文章' },
  { id: 'xiaohongshu', label: '小红书', detail: '相关图文' },
  { id: 'wechat_channels', label: '视频号', detail: '相关视频' },
];

const DEFAULT_METRIC_OPTIONS: readonly TikOmniSampleFilterOption[] = [
  { value: 'all', label: '全部分级' },
  { value: 'verified_hit', label: '可验证爆款' },
  { value: 'potential', label: '高潜样本' },
  { value: 'related', label: '相关样本' },
  { value: 'insufficient', label: '指标不足' },
];

const DEFAULT_TIME_OPTIONS: readonly TikOmniSampleFilterOption[] = [
  { value: 'all', label: '全部时间' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
];

const SORT_OPTIONS: readonly TikOmniSampleFilterOption[] = [
  { value: 'original', label: '采集存档顺序' },
  { value: 'interactions_desc', label: '已知互动合计：从高到低' },
  { value: 'interactions_asc', label: '已知互动合计：从低到高' },
  { value: 'published_desc', label: '发布时间：从近到远' },
  { value: 'published_asc', label: '发布时间：从远到近' },
];

function platformFromRow(platformId: string): TikOmniPlatform {
  return DEFAULT_PLATFORMS.find((platform) => platform.id === platformId)
    || { id: platformId, label: '其他平台', detail: '相关内容' };
}

/**
 * Preserves a supplied platform order while still rendering any returned source group.
 * Sample filtering and sorting remain parent-owned so this component stays a transparent viewer.
 */
export function buildTikOmniPlatformGroups(
  sampleRows: readonly TikOmniSampleRow[],
  platformTotals: Readonly<Record<string, number>>,
  platforms: readonly TikOmniPlatform[] = DEFAULT_PLATFORMS,
  onlyProvidedPlatforms = false,
): TikOmniSamplePlatformGroup[] {
  const knownPlatforms = new Map(platforms.map((platform) => [platform.id, platform]));
  const extraPlatformIds = new Set<string>([
    ...Object.keys(platformTotals),
    ...sampleRows.map((sample) => sample.platform),
  ]);

  const orderedPlatforms = [
    ...platforms,
    ...Array.from(onlyProvidedPlatforms ? [] : extraPlatformIds)
      .filter((platformId) => !knownPlatforms.has(platformId))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
      .map(platformFromRow),
  ];

  return orderedPlatforms.map((platform) => {
    const samples = sampleRows.filter((sample) => sample.platform === platform.id);
    return {
      id: platform.id,
      label: platform.label,
      detail: platform.detail,
      total: platformTotals[platform.id] ?? samples.length,
      samples,
    };
  });
}

export function formatTikOmniMetric(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '未知';
  return new Intl.NumberFormat('zh-CN', {
    notation: 'compact',
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

function recordedCount(value: TikOmniSampleMetricValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// A partial sum describes only recorded engagement. Reads/views are not engagement,
// and no recorded engagement must remain unknown rather than becoming zero.
export function knownSampleInteractions(sample: TikOmniSampleRow): number | null {
  const total = recordedCount(sample.interactions) ?? recordedCount(sample.metrics?.interactions);
  if (total !== null) return total;
  const values = ['likes', 'collects', 'comments', 'shares']
    .map((key) => recordedCount(sample.metrics?.[key]))
    .filter((value): value is number => value !== null);
  if (!values.length) return null;
  const sum = values.reduce((result, value) => result + value, 0);
  return Number.isFinite(sum) ? sum : null;
}

function sampleTimestamp(sample: TikOmniSampleRow): number | null {
  const time = sample.publishedAt ? Date.parse(sample.publishedAt) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

function compareRecorded(left: number | null, right: number | null, ascending: boolean): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return ascending ? left - right : right - left;
}

export function prepareTikOmniSamples(
  samples: readonly TikOmniSampleRow[],
  filters: TikOmniSampleFilters,
  requestedSort: TikOmniSampleSort,
  now = Date.now(),
): { rows: TikOmniSampleRow[]; sort: TikOmniSampleSort } {
  const windows: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
  const days = windows[filters.time];
  const rows = samples.filter((sample) => {
    if (filters.form !== 'all' && sample.contentForm !== filters.form) return false;
    if (filters.metrics !== 'all' && sample.sampleClass !== filters.metrics) return false;
    const timestamp = sampleTimestamp(sample);
    return !days || (timestamp !== null && timestamp <= now && now - timestamp <= days * 86_400_000);
  });
  const interactionSort = requestedSort.startsWith('interactions_');
  const dateSort = requestedSort.startsWith('published_');
  const available = interactionSort ? rows.some((row) => knownSampleInteractions(row) !== null)
    : dateSort ? rows.some((row) => sampleTimestamp(row) !== null) : true;
  const sort = available ? requestedSort : 'original';
  if (sort !== 'original') rows.sort((left, right) => {
    const value = sort.startsWith('interactions_') ? knownSampleInteractions : sampleTimestamp;
    return compareRecorded(value(left), value(right), sort.endsWith('_asc'));
  });
  return { rows, sort };
}

function formOptions(
  sampleRows: readonly TikOmniSampleRow[],
  suppliedOptions: readonly TikOmniSampleFilterOption[] | undefined,
): readonly TikOmniSampleFilterOption[] {
  if (suppliedOptions?.length) return suppliedOptions;
  const forms = Array.from(new Set(sampleRows.map((sample) => sample.contentForm?.trim()).filter(Boolean))) as string[];
  return [
    { value: 'all', label: '全部形式' },
    ...forms.map((form) => ({ value: form, label: form })),
  ];
}

function sampleMetricEntries(metrics: TikOmniSampleRow['metrics']): Array<[string, TikOmniSampleMetricValue]> {
  if (!metrics) return [];
  return Object.entries(metrics).filter(([, value]) => value !== null && value !== undefined && value !== '');
}

const METRIC_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  reads: '阅读',
  views: '观看',
  plays: '播放',
  likes: '点赞',
  collects: '收藏',
  comments: '评论',
  shares: '分享',
  interactions: '互动',
};

function metricDisplayName(metric: string): string {
  return METRIC_DISPLAY_NAMES[metric.toLowerCase()] || '其他数据';
}

function SampleMetric({ label, value }: { label: string; value: TikOmniSampleMetricValue }) {
  const displayValue = value === null || value === undefined || value === ''
    ? '未知'
    : typeof value === 'number'
      ? formatTikOmniMetric(value)
      : value;
  return (
    <div>
      <dt className="text-[10px] font-medium text-[#8A8178]">{label}</dt>
      <dd className="mt-0.5 truncate text-[12px] font-bold tabular-nums text-[#1A1A1A]" title={String(value)}>
        {displayValue}
      </dd>
    </div>
  );
}

function FilterControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly TikOmniSampleFilterOption[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="text-[10px] font-bold text-[#6B6B6B]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full min-w-0 rounded-md border border-[rgba(28,28,30,0.14)] bg-white px-2.5 text-[12px] font-semibold text-[#1A1A1A] outline-none transition-colors focus:border-[#E85D4C] focus:ring-1 focus:ring-[#E85D4C]"
      >
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
    </label>
  );
}

function SampleRow({ sample, rowNumber }: { sample: TikOmniSampleRow; rowNumber: number }) {
  const metrics = sampleMetricEntries(sample.metrics);
  const classification = sample.sampleClass === 'verified_hit'
    ? { label: '可验证爆款', className: 'border-[#E85D4C] bg-[#FFF1EE] text-[#B43C2E]' }
    : sample.sampleClass === 'potential'
      ? { label: '高潜样本', className: 'border-[#D99124] bg-[#FFF8E8] text-[#8D5A00]' }
      : sample.sampleClass === 'insufficient'
        ? { label: '指标不足', className: 'border-[#B8B3AD] bg-[#F4F2EF] text-[#746D67]' }
        : { label: '相关样本', className: 'border-[#C9BDB2] bg-[#F7F3EE] text-[#6B6B6B]' };
  return (
    <article className="border-t border-[rgba(28,28,30,0.09)] py-4 first:border-t-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[#8A8178]">
          <span className="font-mono text-[10px] font-bold">{String(rowNumber).padStart(2, '0')}</span>
          {sample.contentForm && <span className="rounded-md border border-[rgba(28,28,30,0.12)] bg-white px-1.5 py-0.5 text-[10px] font-bold text-[#6B6B6B]">{sample.contentForm}</span>}
          <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${classification.className}`}>{classification.label}</span>
        </div>
        <div className="mt-2 flex min-w-0 items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[14px] font-bold leading-[1.55] text-[#1A1A1A]">{sample.title}</h3>
          {sample.url && (
            <a
              href={sample.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[rgba(28,28,30,0.14)] bg-white text-[#2763A6] transition-colors hover:border-[#2763A6] hover:bg-[#F4F8FD] active:translate-y-px"
              title="在浏览器中打开"
              aria-label={`在浏览器中打开：${sample.title}`}
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
        <p className="mt-1 text-[11px] text-[#6B6B6B]">{sample.account || '未识别账号'}{sample.publishedAt ? ` · ${sample.publishedAt}` : ''}</p>
        {sample.hitPoint && (
          <div className="mt-3 flex gap-2 rounded-lg border-l-2 border-[#E85D4C] bg-[#FFF9F7] px-2.5 py-2">
            <Flame size={13} className="mt-0.5 shrink-0 text-[#C94A3B]" />
            <p className="text-[11px] leading-[1.55] text-[#5B4742]">{sample.hitPoint}</p>
          </div>
        )}
      </div>
      <details className="mt-3 text-[12px] text-[#6B6B6B]">
        <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#E85D4C]">查看数据与评分依据<span className="sr-only">：{sample.title}</span></summary>
        <p className="mt-3 leading-relaxed">{sample.classificationReason || '缺少足够的公开表现指标，只能作为相关内容参考。'}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <SampleMetric label="已知互动合计" value={knownSampleInteractions(sample)} />
          <SampleMetric label="发布时间" value={sample.publishedAt || null} />
          {metrics.map(([label, value]) => <SampleMetric key={label} label={metricDisplayName(label)} value={value} />)}
        </dl>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#746D67]">
          <span>综合分 {sample.hitScore ?? '未知'}</span>
          <span>置信度 {sample.confidence ?? '未知'}</span>
          {typeof sample.scoreComponents?.performance === 'number' && <span>表现 {Math.round(sample.scoreComponents.performance)}</span>}
          {typeof sample.scoreComponents?.evidence === 'number' && <span>证据 {Math.round(sample.scoreComponents.evidence)}</span>}
          {typeof sample.scoreComponents?.batch_percentile === 'number' && <span>批次百分位 {Math.round(sample.scoreComponents.batch_percentile)}</span>}
        </div>
      </details>
    </article>
  );
}

export function TikOmniSampleBrowser({
  sampleRows,
  overview,
  platformTotals,
  filters,
  sort,
  onFiltersChange,
  onSortChange,
  onContinue,
  busy = false,
  platforms = DEFAULT_PLATFORMS,
  onlyProvidedPlatforms = false,
  filterOptions,
}: TikOmniSampleBrowserProps) {
  const [expandedPlatformIds, setExpandedPlatformIds] = useState<readonly string[]>(() => (
    platforms[0] ? [platforms[0].id] : []
  ));
  const platformGroups = useMemo(
    () => buildTikOmniPlatformGroups(sampleRows, platformTotals, platforms, onlyProvidedPlatforms),
    [platformTotals, platforms, sampleRows, onlyProvidedPlatforms],
  );
  const totalSamples = platformGroups.reduce((total, group) => total + group.total, 0);
  const visibleSamples = platformGroups.reduce((total, group) => total + group.samples.length, 0);
  const allRows = overview?.samples ?? sampleRows;
  const overviewGroups = buildTikOmniPlatformGroups(allRows, platformTotals, platforms, onlyProvidedPlatforms);
  const overviewRows = overviewGroups.flatMap((group) => group.samples);
  const sourcesCount = overviewRows.filter((sample) => Boolean(sample.url)).length;
  const knownInteractionsCount = overviewRows.filter((sample) => knownSampleInteractions(sample) !== null).length;
  const insufficientCount = overviewRows.filter((sample) => sample.evidenceStatus !== 'sufficient').length;
  const queries = [...new Set(overview?.queries.map((query) => query.trim()).filter(Boolean) ?? [])];
  const forms = useMemo(() => formOptions(allRows, filterOptions?.forms), [filterOptions?.forms, allRows]);
  const metricOptions = filterOptions?.metrics?.length ? filterOptions.metrics : DEFAULT_METRIC_OPTIONS;
  const timeOptions = filterOptions?.times?.length ? filterOptions.times : DEFAULT_TIME_OPTIONS;
  const displayedRows = platformGroups.flatMap((group) => group.samples);
  const interactionCount = displayedRows.filter((sample) => knownSampleInteractions(sample) !== null).length;
  const publishedCount = displayedRows.filter((sample) => sampleTimestamp(sample) !== null).length;
  const sortOptions = SORT_OPTIONS.map((option) => ({ ...option,
    disabled: option.value.startsWith('interactions_') ? interactionCount === 0
      : option.value.startsWith('published_') ? publishedCount === 0 : false,
  }));

  const updateFilters = (key: keyof TikOmniSampleFilters, value: string) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="tikomni-sample-browser-heading" className="border-b border-[rgba(28,28,30,0.1)] pb-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[#8A8178]">
              <span className="font-mono text-[11px] font-bold">第一步</span>
              <span className="h-px w-5 bg-[rgba(28,28,30,0.16)]" />
              <span className="text-[11px] font-bold">看看同类内容</span>
            </div>
            <h2 id="tikomni-sample-browser-heading" className="mt-2 text-[20px] font-bold text-[#1A1A1A]">同类内容</h2>
            <p className="mt-2 max-w-[680px] text-[12px] leading-[1.65] text-[#6B6B6B]">先看别人怎样提出问题、展开内容，再判断哪些适合本期。</p>
          </div>
          <div className="flex shrink-0 items-center gap-3 rounded-lg border-l-[3px] border-[#D99124] bg-[#FFF9EC] px-3 py-2.5">
            <SearchCheck size={16} className="shrink-0 text-[#A66300]" />
            <div>
              <p className="text-[10px] font-bold text-[#8D5A00]">本期已保存</p>
              <p className="mt-0.5 text-[12px] font-bold tabular-nums text-[#1A1A1A]">{totalSamples} 条内容</p>
            </div>
          </div>
        </div>
        {overview && <div aria-label="本期参考概况" className="mt-4 space-y-2 rounded-lg bg-[#F7F3EE] px-4 py-3 text-[12px] leading-relaxed text-[#5B5148]">
          {overview.topic.trim() && <p className="break-words"><span className="font-bold">本期题目：</span>{overview.topic}</p>}
          <p className="break-words"><span className="font-bold">当时检索：</span>{queries.length ? queries.join('、') : '这份存档未记录检索词'}</p>
          <p>{overviewGroups.map((group) => `${group.label} ${group.total} 条`).join(' · ')}。这份概况不随下方筛选变化。</p>
          {overviewRows.length > 0 ? <>
            <p>已读取 {overviewRows.length} 条，其中 {sourcesCount} 条附有来源链接，{knownInteractionsCount} 条有互动记录{insufficientCount > 0 ? `，${insufficientCount} 条表现证据不足` : ''}。</p>
            <p>{insufficientCount === overviewRows.length ? '这批内容目前只能帮助你参考切入方式和写法，不能据此判断传播效果。' : '数据只描述已记录的表现；与本期是否相关、能否借鉴，还需要阅读原文判断。'}{sourcesCount < overviewRows.length ? `其中 ${overviewRows.length - sourcesCount} 条未附来源链接，需要另行核对原文。` : ''}</p>
            {overviewRows.length < totalSamples && <p>还有 {totalSamples - overviewRows.length} 条明细尚未读取，以上数据仅覆盖已读取的内容。</p>}
          </> : <p>目前没有可读取的参考明细，暂时无法汇总来源和表现数据。</p>}
        </div>}
      </section>

      <section aria-label="内容筛选与排序" className="rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FFFDF9] px-3 py-3 sm:px-4">
        <div className="flex items-center gap-2 text-[#6B6B6B]">
          <Filter size={14} className="text-[#E85D4C]" />
          <span className="text-[11px] font-bold">筛选</span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterControl label="内容形式" value={filters.form} options={forms} onChange={(value) => updateFilters('form', value)} />
          <FilterControl label="样本分级" value={filters.metrics} options={metricOptions} onChange={(value) => updateFilters('metrics', value)} />
          <FilterControl label="发布时间" value={filters.time} options={timeOptions} onChange={(value) => updateFilters('time', value)} />
          <FilterControl label="排序" value={sort} options={sortOptions} onChange={(value) => onSortChange(value as TikOmniSampleSort)} />
        </div>
        <p className="mt-3 text-[11px] leading-[1.55] text-[#8A8178]">当前显示 {visibleSamples} 条。筛选和排序只改变当前显示，不会删除已找到的内容。</p>
        {visibleSamples > 0 && <p className="mt-2 text-xs leading-relaxed text-[#6B6B6B]">
          {interactionCount === 0 ? '这些参考没有互动记录，不能按互动量排序。' : `已知互动只合计有记录的点赞、收藏、评论和分享，不包含阅读量；缺失分项仍为未知。${visibleSamples - interactionCount > 0 ? `其中 ${visibleSamples - interactionCount} 条没有互动记录，按互动排序时放在最后。` : ''}`}
          {sort === 'original' ? '当前按采集存档顺序显示，不代表相关性或热度排名。' : sort.startsWith('published_') ? '当前按发布时间排序，日期未知的放在最后。' : '这不是完整互动量或传播效果排名。'}
        </p>}
      </section>

      <section aria-label="按平台展开的内容列表" className="space-y-3">
        {platformGroups.map((group, groupIndex) => (
          <details
            key={group.id}
            open={expandedPlatformIds.includes(group.id)}
            onToggle={(event) => {
              const expanded = event.currentTarget.open;
              setExpandedPlatformIds((current) => (
                expanded
                  ? current.includes(group.id) ? current : [...current, group.id]
                  : current.filter((platformId) => platformId !== group.id)
              ));
            }}
            className="group overflow-hidden rounded-lg border border-[rgba(28,28,30,0.12)] bg-white"
          >
            <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 transition-colors hover:bg-[#FFF9F7] [&::-webkit-details-marker]:hidden">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#F5EDE4] font-mono text-[10px] font-bold text-[#6B5543]">{String(groupIndex + 1).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-[14px] font-bold text-[#1A1A1A]">{group.label}</span>
                  {group.detail && <span className="text-[11px] text-[#6B6B6B]">{group.detail}</span>}
                </span>
              </span>
              <span className="text-[11px] font-bold tabular-nums text-[#6B6B6B]">{group.samples.length === group.total ? `${group.total} 条` : `显示 ${group.samples.length} / ${group.total} 条`}</span>
              <ChevronDown size={16} className="shrink-0 text-[#8A8178] transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-[rgba(28,28,30,0.1)] px-4">
              {group.samples.length > 0 ? (
                group.samples.map((sample, index) => <SampleRow key={sample.id} sample={sample} rowNumber={index + 1} />)
              ) : (
                <div className="flex items-start gap-2 py-5 text-[12px] leading-[1.6] text-[#6B6B6B]">
                  <Layers3 size={15} className="mt-0.5 shrink-0 text-[#8A8178]" />
                  <p>当前筛选条件下没有 {group.label} 内容。可以调整内容形式、样本分级或发布时间。</p>
                </div>
              )}
            </div>
          </details>
        ))}
      </section>

      <div className="flex flex-col gap-3 border-t border-[rgba(28,28,30,0.1)] pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-[640px] text-[12px] leading-[1.6] text-[#6B6B6B]">不用逐条选择。下一步会结合这些内容和你的素材，给出选题建议。</p>
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-[#1C1C1E] px-4 text-[12px] font-bold text-white transition-colors hover:bg-[#353535] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
        >
          <SlidersHorizontal size={15} />
          下一步：选题
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

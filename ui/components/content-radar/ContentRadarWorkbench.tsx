'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BookOpenText,
  Check,
  CircleAlert,
  CircleGauge,
  FileChartColumn,
  FlaskConical,
  History,
  LoaderCircle,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
  Target,
  TrendingUp,
  UsersRound,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { TechnicalDetailList, TechnicalDetails } from '@/components/TechnicalDetails';
import { displayClientError } from '@/lib/client-error-copy';
import { contentRadarContext, radarForQuery, radarQueryReady } from '@/lib/content-radar-context';
import { PRODUCTION_WORKSPACE_STORAGE_KEY } from '@/lib/production-workspace-context';
import { contentRadarGeneratedDisplayText } from '@/lib/content-radar-display-copy';
import { COMMON_ACTION_DISPLAY_NAMES, PRODUCT_COPY, contentRadarTierDisplayName } from '@/lib/product-copy';
import type {
  ContentRadarComparison,
  ContentRadarOpportunity,
  ContentRadarPlatform,
  ContentRadarReport,
  ContentRadarSnapshot,
} from '@/lib/content-radar';

type RadarResponse = { ok?: boolean; radar?: ContentRadarSnapshot | null; error?: string };
type ComparisonResponse = { ok?: boolean; comparison?: ContentRadarComparison; error?: string };
type MaterialResponse = { ok?: boolean; path?: string; nextUrl?: string; error?: string };

const PLATFORM_OPTIONS: Array<{ value: ContentRadarPlatform; label: string; hint: string }> = [
  { value: 'xiaohongshu', label: '小红书', hint: '图文、测评和收藏' },
  { value: 'wechat_mp', label: '公众号', hint: '深度文章和观点' },
  { value: 'wechat_channels', label: '视频号', hint: '口播、播放和互动' },
];

const REPORT_ICONS = [Target, FlaskConical, UsersRound, Sparkles];

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '尚未扫描';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function snapshotAgeHours(value: string): number {
  const captured = new Date(value).getTime();
  return Number.isFinite(captured) ? Math.max(0, (Date.now() - captured) / 3_600_000) : Number.POSITIVE_INFINITY;
}

function publicLink(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function tierClass(tier: ContentRadarOpportunity['tier']): string {
  if (tier === '立即做') return 'border-[#74AD4B] bg-[#E9F6DF] text-[#2E6226]';
  if (tier === '差异化切入') return 'border-[#B7C98F] bg-[#F4F8E9] text-[#536B2E]';
  if (tier === '继续观察') return 'border-[#D7D3B5] bg-[#FBFAEF] text-[#706A3D]';
  return 'border-[#D9D9D2] bg-[#F5F5F2] text-[#6D7068]';
}

const SAMPLE_CLASS_COPY = {
  verified_hit: { label: '可验证爆款', className: 'border-[#74AD4B] bg-[#E9F6DF] text-[#2E6226]' },
  potential: { label: '高潜样本', className: 'border-[#B7C98F] bg-[#F4F8E9] text-[#536B2E]' },
  related: { label: '相关样本', className: 'border-[#D9D9D2] bg-[#F5F5F2] text-[#6D7068]' },
  insufficient: { label: '指标不足', className: 'border-[#E1D6BA] bg-[#FFFDF5] text-[#77653C]' },
} as const;

const METRIC_LABELS: Record<string, string> = {
  views: '浏览', plays: '播放', reads: '阅读', likes: '点赞', digg: '点赞',
  collects: '收藏', favorites: '收藏', comments: '评论', shares: '分享',
  wows: '在看', recommends: '推荐', followers: '粉丝',
};

function trendVisual(trend: ContentRadarOpportunity['trend']) {
  if (trend.status === 'rising') return { icon: TrendingUp, className: 'text-[#397246]' };
  if (trend.status === 'falling') return { icon: ArrowDownRight, className: 'text-[#9A5C42]' };
  return { icon: History, className: 'text-[#777F72]' };
}

function RadarSkeleton() {
  return (
    <div className="space-y-5" aria-label="正在读取热门选题" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => <Skeleton className="h-[108px] rounded-xl bg-[#E8EEE3]" key={index} />)}
      </div>
      <Skeleton className="h-[164px] rounded-xl bg-[#E8EEE3]" />
      <div className="grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => <Skeleton className="h-[230px] rounded-xl bg-[#E8EEE3]" key={index} />)}
      </div>
    </div>
  );
}

function sourceTypeDisplayName(sourceType: ContentRadarOpportunity['sourceType']): string {
  return sourceType === '固定领域词' ? '你输入的关键词' : '新发现的关键词';
}

function SectionTitle({ icon: Icon, children, detail }: {
  icon: typeof Radar;
  children: React.ReactNode;
  detail?: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#E6F1DE] text-[#397246]" aria-hidden="true">
          <Icon size={15} strokeWidth={1.9} />
        </span>
        <h2 className="text-[16px] font-bold text-[#24301F]">{children}</h2>
      </div>
      {detail && <p className="mt-1.5 max-w-[760px] pl-9 text-xs leading-5 text-[#758070]">{detail}</p>}
    </div>
  );
}

function EmptyRadar({ industry, onScan, loading, ready }: { industry: string; onScan: () => void; loading: boolean; ready: boolean }) {
  return (
    <section className="rounded-xl bg-white px-6 py-10 shadow-[0_12px_36px_rgba(43,65,36,0.05)] md:px-9 md:py-12">
      <div className="grid items-center gap-9 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)] lg:gap-14">
        <div>
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#E8F3DF] text-[#397246]">
            <Radar size={24} strokeWidth={1.7} />
          </div>
          <h2 className="mt-5 text-[21px] font-bold text-[#24301F]">{industry.trim() ? `查找「${industry.trim()}」的参考` : '先选平台，再写下想了解的主题'}</h2>
          <p className="mt-2 max-w-[600px] text-sm leading-6 text-[#667060]">
            第一次会收集公开内容；下次再查时，就能看出哪些话题在升温或降温。
          </p>
          <button
            type="button"
            onClick={onScan}
            disabled={loading || !ready}
            className="mt-6 inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-lg bg-[#397246] px-4 text-sm font-bold text-white transition hover:bg-[#2E6139] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/35 disabled:cursor-not-allowed disabled:opacity-60 active:translate-y-px"
          >
            {loading ? <LoaderCircle className="animate-spin" size={16} /> : <Search size={16} />}
            {COMMON_ACTION_DISPLAY_NAMES.findTopics}
          </button>
        </div>

        <ol className="grid gap-2.5" aria-label="热门选题查找方式">
          {[
            ['01', '收集公开内容', '保留原始链接和发布时间。'],
            ['02', '看话题升温或降温', '同一领域再次查找后，就能比较前后变化。'],
            ['03', '保存为选题', '把选题和参考依据带入本期内容。'],
          ].map(([number, title, detail]) => (
            <li key={number} className="grid grid-cols-[38px_minmax(0,1fr)] gap-3 bg-[#F7F9F5] px-4 py-3.5">
              <span className="font-mono text-[11px] font-bold tracking-[0.08em] text-[#4F9724]">{number}</span>
              <span>
                <strong className="block text-[13px] text-[#34402F]">{title}</strong>
                <span className="mt-1 block text-[12px] leading-5 text-[#758070]">{detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function opportunityReport(direction: ContentRadarOpportunity): ContentRadarReport {
  return {
    id: `opportunity-${direction.query}`,
    title: direction.topicTitle,
    summary: direction.contentSuggestion,
    sections: [
      { title: '为什么现在做', bullets: direction.whyNow },
      { title: '公开证据覆盖', bullets: direction.evidenceReasons },
      { title: '分数怎么算', bullets: [
        `推荐分 ${direction.opportunityScore}，合理区间 ${direction.scoreRange.low}–${direction.scoreRange.high}，热门潜力 ${direction.heat}。`,
        `内容新鲜度 ${direction.freshnessScore}，数据完整度 ${direction.evidenceScore}。`,
        `同类内容集中度 ${direction.saturationScore}。数值越高，代表这批同类内容越集中。`,
        `现有素材准备度 ${direction.assetReadiness.score}：${direction.assetReadiness.label}，找到 ${direction.assetReadiness.matchedAssetCount} 份可用素材。`,
      ]},
      { title: direction.demandEvidence.label, bullets: direction.demandEvidence.signals.length ? direction.demandEvidence.signals : ['当前没有足够需求信号。'] },
      { title: '风险和不适合的原因', bullets: direction.risks.length ? direction.risks : ['当前未发现额外风险，但仍需人工核对来源和事实。'] },
      { title: '发布后看什么', bullets: [
        direction.experiment.hypothesis,
        `主指标：${direction.experiment.primaryMetric}。${direction.experiment.metricDefinition}。`,
        `检查点：${direction.experiment.checkpoints.join('、')}。`,
        `成功规则：${direction.experiment.successRule}`,
      ]},
      { title: '执行步骤', bullets: direction.actionPlan },
      { title: '参考内容', bullets: [
        direction.leadSample.title || '标题未公开',
        direction.leadSample.author ? `作者：${direction.leadSample.author}` : '作者信息未公开',
        '只借鉴常用写法，不复制标题、正文或个人经历。',
      ]},
    ],
  };
}

function buildOpportunityBrief(radar: ContentRadarSnapshot, direction: ContentRadarOpportunity): string {
  return [
    '---',
    `radar_opportunity_id: ${direction.id}`,
    `radar_snapshot_id: ${radar.snapshotId}`,
    `radar_platform: ${radar.platform}`,
    `radar_source_snapshot: ${radar.snapshotPath}`,
    `radar_experiment_id: ${direction.experiment.id}`,
    'performance_status: pending_authorized_return',
    '---',
    '',
    `# ${direction.topicTitle}`,
    '',
    '## 选题判断',
    `- 行业：${radar.industry}`,
    `- 平台：${radar.platformLabel}`,
    `- 候选范围：${radar.profile.label}`,
    `- 建议：${contentRadarTierDisplayName(direction.tier)}`,
    `- 推荐分：${direction.opportunityScore}`,
    `- 合理区间：${direction.scoreRange.low}–${direction.scoreRange.high}`,
    `- 趋势：${direction.trend.label}`,
    `- 生命周期：${direction.lifecycle.label}`,
    '',
    '## 创作建议',
    direction.contentSuggestion,
    '',
    '## 为什么现在做',
    ...direction.whyNow.map((item) => `- ${item}`),
    '',
    '## 公开证据覆盖',
    ...direction.evidenceReasons.map((item) => `- ${item}`),
    '',
    '## 现有素材是否够用',
    `- 评分：${direction.assetReadiness.score}（${direction.assetReadiness.label}）`,
    `- 命中素材：${direction.assetReadiness.matchedAssetCount} 份`,
    `- 已有证据类型：${direction.assetReadiness.evidenceTypes.join('、') || '尚未识别'}`,
    `- 建议补充：${direction.assetReadiness.gaps.join('、') || '无明显缺口'}`,
    `- 隐私边界：${direction.assetReadiness.privacyNote}`,
    '',
    `## ${direction.demandEvidence.label}`,
    ...(direction.demandEvidence.signals.length ? direction.demandEvidence.signals : ['当前没有足够需求信号。']).map((item) => `- ${item}`),
    '',
    '## 风险和不适合的原因',
    ...(direction.risks.length ? direction.risks : ['当前未识别到额外风险，仍需人工核验。']).map((item) => `- ${item}`),
    '',
    '## 发布后看什么',
    `- 假设：${direction.experiment.hypothesis}`,
    `- 主指标：${direction.experiment.primaryMetric}`,
    `- 指标定义：${direction.experiment.metricDefinition}`,
    `- 对照数据：${direction.experiment.baseline}`,
    `- 检查点：${direction.experiment.checkpoints.join('、')}`,
    `- 成功规则：${direction.experiment.successRule}`,
    `- 数据边界：${direction.experiment.dataBoundary}`,
    '',
    '## 执行步骤',
    ...direction.actionPlan.map((item) => `- ${item}`),
    '',
    '## 公开证据',
    `- 代表样本：${direction.leadSample.title || '标题未公开'}`,
    `- 作者：${direction.leadSample.author || '作者未公开'}`,
    `- 来源：${direction.leadSample.sourceUrl}`,
    `- 检索词：${direction.query}`,
    '',
    '## 技术详情',
    `- 选题编号：${direction.id}`,
    `- 测试编号：${direction.experiment.id}`,
    `- 扫描记录：${radar.snapshotPath}`,
    '',
    '## 原创边界',
    '- 只迁移问题结构、内容机制与信息组织。',
    '- 使用自己的产品体验、客户问题或专业证据完成表达。',
    '- 不复制第三方标题、正文、图片或个人经历。',
    '',
    '## 发布后回流',
    '- 发布后使用相同选题编号绑定已授权的 24h、72h 与 7d 表现数据。',
    '- 未提供来源、发布时间或授权证明的数据，不进入效果校准。',
  ].join('\n');
}

function subscribeWorkspace(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === PRODUCTION_WORKSPACE_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', onChange);
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('focus', onChange); };
}

function readWorkspace() {
  try { return window.localStorage.getItem(PRODUCTION_WORKSPACE_STORAGE_KEY); }
  catch { return '{'; }
}

export function ContentRadarWorkbench() {
  const raw = useSyncExternalStore(subscribeWorkspace, readWorkspace, () => null);
  const origin = contentRadarContext(raw);
  return <DraftContentRadar key={JSON.stringify(origin)} origin={origin} />;
}

function DraftContentRadar({ origin }: { origin: ReturnType<typeof contentRadarContext> }) {
  const [platform, setPlatform] = useState<ContentRadarPlatform | null>(origin.platforms[0] || null);
  const [industry, setIndustry] = useState(origin.industry);
  const [snapshot, setRadar] = useState<ContentRadarSnapshot | null>(null);
  const radar = radarForQuery(snapshot, platform, industry);
  const [savedComparison, setComparison] = useState<ContentRadarComparison | null>(null);
  const comparison = radar && savedComparison?.industry === radar.industry ? savedComparison : null;
  const [showAll, setShowAll] = useState(false);
  const [tierFilter, setTierFilter] = useState<'全部' | ContentRadarOpportunity['tier']>('全部');
  const [loading, setLoading] = useState(Boolean(origin.platforms.length));
  const [scanning, setScanning] = useState(false);
  const [adoptingQuery, setAdoptingQuery] = useState('');
  const [error, setError] = useState('');
  const [activeReport, setActiveReport] = useState<ContentRadarReport | null>(null);
  const scanInFlight = useRef(false);
  const adoptionInFlight = useRef(false);
  const mounted = useRef(false);
  const ready = radarQueryReady(platform, industry);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!platform) return;
    let disposed = false;
    const controller = new AbortController();
    const request = async () => {
      try {
        const response = await fetch(`/api/content-radar?${new URLSearchParams({ platform }).toString()}`, { cache: 'no-store', signal: controller.signal });
        const payload = await response.json().catch(() => ({})) as RadarResponse;
        if (!response.ok) throw new Error(payload.error || '读取热门选题失败。');
        if (disposed) return;
        const latest = payload.radar || null;
        setRadar(latest);
      } catch (issue) {
        if (!disposed) {
          setRadar(null);
          setError(displayClientError(issue, '热门选题没有读取成功。请刷新后重试。'));
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void request();
    return () => { disposed = true; controller.abort(); };
  }, [platform]);

  useEffect(() => {
    if (!radar) return;
    let disposed = false;
    const controller = new AbortController();
    const request = async () => {
      try {
        const query = new URLSearchParams({ view: 'compare', industry: radar.industry });
        const response = await fetch(`/api/content-radar?${query.toString()}`, { cache: 'no-store', signal: controller.signal });
        const payload = await response.json().catch(() => ({})) as ComparisonResponse;
        if (!disposed && response.ok) setComparison(payload.comparison || null);
      } catch { /* A missing comparison does not invalidate the saved platform results. */ }
    };
    void request();
    return () => { disposed = true; controller.abort(); };
  }, [radar]);

  const scan = useCallback(async () => {
    if (!radarQueryReady(platform, industry) || loading || scanInFlight.current || adoptingQuery) return;
    scanInFlight.current = true;
    setScanning(true);
    setError('');
    try {
      const response = await fetch('/api/content-radar', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ industry, platform }),
      });
      const payload = await response.json().catch(() => ({})) as RadarResponse;
      if (!mounted.current) return;
      if (!response.ok || !payload.radar) throw new Error(payload.error || '查找选题失败。');
      if (!radarForQuery(payload.radar, platform, industry)) throw new Error('返回结果与本次平台或关键词不一致，请重新核对。');
      setComparison(null);
      setRadar(payload.radar);
      setShowAll(false);
      setTierFilter('全部');
    } catch (issue) {
      if (mounted.current) setError(displayClientError(issue, '暂时没有查到选题。请检查网络后重试。'));
    } finally {
      scanInFlight.current = false;
      if (mounted.current) setScanning(false);
    }
  }, [industry, platform, loading, adoptingQuery]);

  const adoptOpportunity = useCallback(async (direction: ContentRadarOpportunity) => {
    if (!radar || scanInFlight.current || adoptionInFlight.current) return;
    adoptionInFlight.current = true;
    setAdoptingQuery(direction.query);
    setError('');
    try {
      const createResponse = await fetch('/api/materials?action=create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'materials/content-radar/selected',
          name: `${direction.topicTitle}.md`,
          content: buildOpportunityBrief(radar, direction),
        }),
      });
      const created = await createResponse.json().catch(() => ({})) as MaterialResponse;
      if (!mounted.current) return;
      if (!createResponse.ok || !created.path) throw new Error(created.error || '保存选题简报失败。');
      const targetPlatform = radar.platform === 'xiaohongshu'
        ? 'xiaohongshu'
        : radar.platform === 'wechat_channels'
          ? 'shipinhao'
          : 'wechat';
      const intakeResponse = await fetch('/api/materials?action=start-intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: created.path,
          platforms: [targetPlatform],
          targetPlatform,
          scenario: 'business',
          jobName: direction.topicTitle,
          research: true,
        }),
      });
      const intake = await intakeResponse.json().catch(() => ({})) as MaterialResponse;
      if (!mounted.current) return;
      if (!intakeResponse.ok || !intake.nextUrl) throw new Error(intake.error || '创建内容任务失败。');
      window.location.assign(intake.nextUrl);
    } catch (issue) {
      if (mounted.current) {
        setError(displayClientError(issue, '这个选题没有加入本期内容。请重试。'));
        setAdoptingQuery('');
      }
    } finally {
      adoptionInFlight.current = false;
    }
  }, [radar]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void scan();
  };

  const metricCards = useMemo(() => radar ? [
    { value: compactNumber(radar.metrics.sampleCount), label: '有来源的内容', detail: `${radar.coverage.successfulQueryCount}/${radar.coverage.queryCount} 组搜索完成` },
    { value: compactNumber(radar.metrics.verifiedHitCount), label: '可验证爆款', detail: '通过 v5 多证据门槛' },
    { value: compactNumber(radar.metrics.potentialSampleCount), label: '高潜样本', detail: '有潜力，但证据未达爆款门槛' },
    { value: compactNumber(radar.metrics.insufficientSampleCount), label: '指标不足', detail: '保留展示，不进入爆款排序' },
    { value: `${radar.metrics.evidenceCoverage}%`, label: '数据完整度', detail: `发布时间完整度 ${radar.quality.timeCoverage}%` },
    { value: radar.baseline.snapshotCount, label: '扫描记录', detail: radar.baseline.trackedDays ? `已比较 ${radar.baseline.trackedDays} 天` : '下次扫描后可比较趋势' },
  ] : [], [radar]);

  const visibleOpportunities = useMemo(() => {
    if (!radar) return [];
    const filtered = tierFilter === '全部' ? radar.opportunities : radar.opportunities.filter((item) => item.tier === tierFilter);
    return showAll ? filtered : filtered.slice(0, 3);
  }, [radar, showAll, tierFilter]);

  return (
    <div className="aifios-editorial-page mx-auto w-full max-w-[1440px] pb-12 text-[#24301F]">
      <section className="mb-5 rounded-xl border border-[#DCE4D7] bg-[#F4F7F0] p-4 shadow-[0_10px_32px_rgba(43,65,36,0.04)] md:p-5">
        <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
          <div className="max-w-[520px]">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#397246]">
              <Radar size={17} strokeWidth={1.9} />
              公开平台数据
            </div>
            <h1 className="mt-2 text-[26px] font-bold tracking-[-0.02em] text-[#24301F]">{PRODUCT_COPY.pages.contentRadar.title}</h1>
            <p className="mt-1 text-sm leading-6 text-[#667060]">
              输入行业或主题，查看完整候选池、爆款证据与近期选题机会。
            </p>
          </div>

          <form onSubmit={submit} className="grid w-full items-end gap-3 sm:grid-cols-[minmax(260px,1fr)_auto] 2xl:max-w-[680px]">
            <label className="grid gap-1.5 text-xs font-semibold text-[#4E5949]">
              行业或领域关键词
              <span className="flex h-10 items-center gap-2 rounded-lg border border-[#C8D4C2] bg-white px-3 focus-within:border-[#397246] focus-within:ring-2 focus-within:ring-[#397246]/15">
                <Search size={15} className="shrink-0 text-[#7A8574]" />
                <input
                  value={industry}
                  onChange={(event) => { setIndustry(event.target.value); setError(''); setComparison(null); setActiveReport(null); setShowAll(false); setTierFilter('全部'); }}
                  disabled={scanning || Boolean(adoptingQuery) || !origin}
                  maxLength={120}
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[#24301F] outline-none placeholder:text-[#8B9487]"
                  placeholder="例如：美妆行业"
                />
              </span>
            </label>

            <button
              type="submit"
              disabled={scanning || loading || Boolean(adoptingQuery) || !ready}
              className="inline-flex h-10 min-w-[112px] items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#397246] px-4 text-sm font-bold text-white transition hover:bg-[#2E6139] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/35 disabled:cursor-not-allowed disabled:opacity-60 active:translate-y-px"
            >
              {scanning ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              {scanning ? '正在查找' : radar ? '更新结果' : '查找选题'}
            </button>
          </form>
        </div>

        <p className="mt-3 text-xs leading-5 text-[#667060]">
          {origin?.context.state === 'selected' ? <>来自「{origin.context.name}」的题目，可在这里改关键词，原稿不变。{origin.platforms.length > 1 ? '本期有多个平台，先带入第一个，可在下方切换。' : ''} <a className="underline" href={origin.context.returnHref}>返回这份草稿</a></> : origin?.context.state === 'unavailable' ? '当前草稿信息未能读取，请自行选择平台和关键词。' : '选择平台并输入关键词后再查找。'}
          {' '}打开页面只读取本机已有结果；点击查找才会采集，可能产生数据服务费用。
        </p>
        {industry.trim().replace(/\s+/g, ' ').length > 30 && <p role="status" className="mt-2 text-sm text-[#85452F]">请缩短为 2—30 个字符的关键词再查找，此处修改不会改变原稿标题。</p>}

        <div className="mt-4 flex flex-col gap-3 border-t border-[#DCE4D7] pt-3 sm:flex-row sm:items-center sm:justify-between">
          <fieldset className="flex items-center gap-2">
            <legend className="sr-only">创作平台</legend>
            <span className="text-xs font-semibold text-[#5D6858]">平台</span>
            <div className="flex h-9 rounded-lg border border-[#C8D4C2] bg-white p-1">
              {PLATFORM_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.hint}
                  aria-pressed={platform === option.value}
                  disabled={scanning || Boolean(adoptingQuery) || !origin}
                  onClick={() => {
                    if (option.value === platform) return;
                    setComparison(null);
                    setRadar(null);
                    setActiveReport(null);
                    setShowAll(false);
                    setTierFilter('全部');
                    setError('');
                    setLoading(true);
                    setPlatform(option.value);
                  }}
                  className={`h-full rounded-md px-3 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/30 active:translate-y-px ${platform === option.value ? 'bg-[#397246] text-white' : 'text-[#5D6858] hover:bg-[#EEF3EA]'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-[#6D7768]">{radar ? `最后更新：${formatDate(radar.capturedAt)}，` : ''}全量候选，不按账号类型或内容目标过滤</p>
        </div>
      </section>

      {error && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-[#E3C8BD] bg-[#FFF8F4] p-4 text-sm text-[#85452F]" role="alert">
          <CircleAlert size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-bold">暂时无法查找选题</p>
            <p className="mt-1 leading-6">{error}</p>
          </div>
        </div>
      )}

      {radar && snapshotAgeHours(radar.capturedAt) > (radar.platform === 'wechat_mp' ? 48 : 24) && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-[#E1D6BA] bg-[#FFFDF5] p-4 text-sm text-[#77653C]" role="status">
          <span><strong>这批结果需要更新。</strong> 距离上次查找时间较久，建议更新后再判断当前热度。</span>
          <button type="button" onClick={() => void scan()} disabled={scanning} className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[#CDBD91] px-3 text-xs font-bold hover:bg-white disabled:opacity-60"><RefreshCw size={14} />更新结果</button>
        </div>
      )}

      {radar?.quality.languageStatus === 'review_required' && Boolean(radar.quality.languageWarnings?.length) && (
        <div className="mb-5 rounded-xl border border-[#E1D6BA] bg-[#FFFDF5] p-4 text-sm text-[#77653C]" role="status">
          这次分析有几处表达需要你复核：{contentRadarGeneratedDisplayText(radar.quality.languageWarnings?.[0] || '')}
        </div>
      )}

      {loading ? <RadarSkeleton /> : !radar ? <EmptyRadar industry={industry} onScan={() => void scan()} loading={scanning} ready={ready && !adoptingQuery} /> : (
        <div className="space-y-7">
          <section aria-label="热门选题概况" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {metricCards.map((metric) => (
              <article key={metric.label} className="rounded-xl border border-[#DCE4D7] bg-white p-4 shadow-[0_8px_24px_rgba(43,65,36,0.04)]">
                <p className="font-mono text-[27px] font-black leading-none tracking-[-0.03em] text-[#4F9724]">{metric.value}</p>
                <p className="mt-2 text-sm font-bold text-[#34402F]">{metric.label}</p>
                <p className="mt-1 text-xs leading-5 text-[#758070]">{metric.detail}</p>
              </article>
            ))}
          </section>

          <section className="grid gap-3 rounded-xl border border-[#CEDAC8] bg-[#F8FBF6] p-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.65fr)_minmax(280px,0.65fr)]">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E4F1DC] text-[#397246]"><History size={18} /></span>
              <div>
                <p className="text-sm font-bold text-[#2C3728]">{radar.baseline.status === 'compared' ? '已和上次结果比较' : '下次扫描后可比较趋势'}</p>
                <p className="mt-1 text-xs leading-5 text-[#667060]">{contentRadarGeneratedDisplayText(radar.baseline.note)}</p>
              </div>
            </div>
            <div className="rounded-lg border border-[#DEE7D9] bg-white px-3 py-2.5">
              <p className="text-xs font-bold text-[#397246]">推荐效果 · {radar.calibration.status === 'calibrated' ? '已有结果' : radar.calibration.status === 'tracking' ? '记录中' : '等待发布数据'}</p>
              <p className="mt-1 text-xs leading-5 text-[#667060]">{contentRadarGeneratedDisplayText(radar.calibration.note)}</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ['来源', radar.quality.evidenceCoverage],
                ['时间', radar.quality.timeCoverage],
                ['互动', radar.quality.metricCoverage],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-[#DEE7D9] bg-white px-2 py-2">
                  <p className="font-mono text-base font-black text-[#397246]">{value}%</p>
                  <p className="mt-0.5 text-[11px] text-[#758070]">{label}数据完整度</p>
                </div>
              ))}
            </div>
          </section>

          {radar.discovery.emergingKeywords.length > 0 && (
            <section>
              <SectionTitle icon={Sparkles} detail="系统从第一批公开内容中发现这些关键词，并继续搜索相关内容。">新出现的关键词</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {radar.discovery.emergingKeywords.map((item) => (
                  <span key={item.query} className="rounded-lg border border-[#CFE1C5] bg-[#F2F8ED] px-3 py-2 text-xs font-semibold text-[#42653A]">{item.label}<span className="ml-2 font-normal text-[#758070]">{item.query}</span></span>
                ))}
              </div>
            </section>
          )}

          {comparison && (
            <section>
              <SectionTitle icon={ArrowUpRight} detail={comparison.missingPlatforms.length ? '只显示已经查到的平台数据，不会猜测缺失结果。' : '对比同一个选题在小红书、公众号和视频号的表现。'}>平台对比</SectionTitle>
              <div className="overflow-hidden rounded-xl border border-[#DCE4D7] bg-white">
                {comparison.rows.slice(0, 3).map((row) => (
                  <article key={row.query} className="grid gap-3 border-b border-[#E7ECE3] px-4 py-3 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_96px_96px_96px_minmax(220px,0.8fr)] lg:items-center">
                    <div><p className="text-sm font-bold text-[#2C3728]">{row.title}</p><p className="mt-0.5 truncate text-[11px] text-[#7B8576]">{row.query}</p></div>
                    <p className="text-xs text-[#596654]"><span className="mr-2 font-mono text-base font-black text-[#4F9724]">{row.xiaohongshu?.score ?? '—'}</span>小红书</p>
                    <p className="text-xs text-[#596654]"><span className="mr-2 font-mono text-base font-black text-[#4F9724]">{row.wechat_mp?.score ?? '—'}</span>公众号</p>
                    <p className="text-xs text-[#596654]"><span className="mr-2 font-mono text-base font-black text-[#4F9724]">{row.wechat_channels?.score ?? '—'}</span>视频号</p>
                    <p className="text-xs leading-5 text-[#667060]">{contentRadarGeneratedDisplayText(row.recommendation)}</p>
                  </article>
                ))}
                {comparison.rows.length === 0 && <p className="p-4 text-sm text-[#667060]">另一个平台还没有同领域结果，查找后即可对比。</p>}
              </div>
            </section>
          )}

          <section>
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <SectionTitle icon={Target} detail="不按账号类型或内容目标裁剪；按多证据表现、相关性、新鲜度和完整度排序。">建议优先做</SectionTitle>
              <label className="flex items-center gap-2 text-xs font-semibold text-[#5D6858]">建议
                <select value={tierFilter} onChange={(event) => { setTierFilter(event.target.value as typeof tierFilter); setShowAll(false); }} className="h-9 rounded-lg border border-[#C8D4C2] bg-white px-3 text-xs font-bold outline-none focus:border-[#397246]">
                  {['全部', '立即做', '差异化切入', '继续观察', '暂缓'].map((value) => <option key={value} value={value}>{value === '全部' ? value : contentRadarTierDisplayName(value)}</option>)}
                </select>
              </label>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {visibleOpportunities.map((direction) => {
                const trend = trendVisual(direction.trend);
                const TrendIcon = trend.icon;
                const adopting = adoptingQuery === direction.query;
                return (
                  <article key={direction.query} className="rounded-xl border border-[#DCE4D7] bg-white p-5 shadow-[0_6px_20px_rgba(43,65,36,0.03)]">
                    <div className="flex flex-col items-start justify-between gap-3 min-[420px]:flex-row min-[420px]:gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-md border px-2 py-1 text-[11px] font-bold ${tierClass(direction.tier)}`}>{contentRadarTierDisplayName(direction.tier)}</span>
                          <span className="rounded-md bg-[#F1F3EF] px-2 py-1 text-[11px] font-semibold text-[#687164]">{sourceTypeDisplayName(direction.sourceType)}</span>
                          <span className={`inline-flex items-center gap-1 text-[11px] font-bold ${trend.className}`}><TrendIcon size={13} />{contentRadarGeneratedDisplayText(direction.trend.label)}{direction.trend.delta === null ? '' : ` ${direction.trend.delta > 0 ? '+' : ''}${direction.trend.delta}`}</span>
                          <span className="rounded-md border border-[#D8E4D2] px-2 py-1 text-[11px] font-semibold text-[#536B4D]">{contentRadarGeneratedDisplayText(direction.lifecycle.label)} · {direction.lifecycle.observationCount} 次记录</span>
                        </div>
                        <h3 className="mt-3 text-[17px] font-bold leading-6 text-[#2C3728]">{contentRadarGeneratedDisplayText(direction.topicTitle)}</h3>
                        <p className="mt-1 text-xs text-[#7A8475]">主题：{direction.title}，搜索词：{direction.query}</p>
                      </div>
                      <div className="shrink-0 text-left min-[420px]:text-right">
                        <p className="font-mono text-3xl font-black leading-none text-[#4F9724]">{direction.opportunityScore}</p>
                        <p className="mt-1 text-[11px] font-semibold text-[#758070]">推荐分 · {direction.scoreRange.low}–{direction.scoreRange.high}</p>
                      </div>
                    </div>

                    <p className="mt-4 text-sm leading-6 text-[#596654]">{contentRadarGeneratedDisplayText(direction.contentSuggestion)}</p>
                    <div className="mt-4 grid grid-cols-4 gap-2">
                      {[
                        ['热门潜力', direction.heat],
                        ['新鲜度', direction.freshnessScore],
                        ['样本覆盖度', direction.coverageScore],
                        ['素材准备度', direction.assetReadiness.score],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-lg bg-[#F6F8F4] px-2 py-2 text-center">
                          <p className="font-mono text-sm font-black text-[#34402F]">{value}</p>
                          <p className="mt-0.5 text-[10px] text-[#7B8576]">{label}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {(direction.mechanisms.length ? direction.mechanisms : ['具体问题开头']).map((mechanism) => (
                        <span key={mechanism} className="rounded-md bg-[#EEF7E5] px-2 py-1 text-[11px] font-semibold text-[#4B6E38]">{contentRadarGeneratedDisplayText(mechanism)}</span>
                      ))}
                      <span className={`rounded-md px-2 py-1 text-[11px] font-semibold ${direction.assetReadiness.status === 'ready' ? 'bg-[#E7F5DE] text-[#397246]' : direction.assetReadiness.status === 'partial' ? 'bg-[#F4F2DE] text-[#756B35]' : 'bg-[#F7EAE5] text-[#8A513E]'}`}>{contentRadarGeneratedDisplayText(direction.assetReadiness.label)} · {direction.assetReadiness.matchedAssetCount} 份</span>
                      <span className="rounded-md bg-[#F1F3EF] px-2 py-1 text-[11px] font-semibold text-[#687164]">{contentRadarGeneratedDisplayText(direction.demandEvidence.label)}</span>
                      {Object.entries(direction.windows).map(([window, delta]) => delta === null ? null : (
                        <span key={window} className="rounded-md border border-[#D8E4D2] px-2 py-1 text-[11px] font-semibold text-[#536B4D]">{window} {delta > 0 ? '+' : ''}{delta}</span>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-col gap-3 border-t border-[#E7ECE3] pt-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-xs text-[#758070]">{direction.sampleCount} 条参考内容，{compactNumber(direction.engagement)} 公开互动</span>
                      <div className="grid w-full grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:flex sm:w-auto">
                        <button type="button" onClick={() => setActiveReport(opportunityReport(direction))} className="inline-flex min-h-11 w-full min-w-0 items-center justify-center whitespace-nowrap rounded-lg border border-[#C7D4C1] px-3 text-xs font-bold text-[#397246] hover:bg-[#F1F6EE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/30 active:translate-y-px sm:h-9 sm:min-h-0 sm:w-auto sm:min-w-[76px]">查看依据</button>
                        <button type="button" onClick={() => void adoptOpportunity(direction)} disabled={scanning || loading || Boolean(adoptingQuery)} className="inline-flex min-h-11 w-full min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-[#397246] px-3 text-xs font-bold text-white hover:bg-[#2E6139] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/35 disabled:cursor-not-allowed disabled:opacity-60 active:translate-y-px sm:h-9 sm:min-h-0 sm:w-auto sm:min-w-[92px]">
                          {adopting ? <LoaderCircle size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                          {adopting ? '正在创建' : '用这个选题写内容'}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            {(tierFilter === '全部' ? radar.opportunities.length : radar.opportunities.filter((item) => item.tier === tierFilter).length) > 3 && (
              <button type="button" onClick={() => setShowAll((value) => !value)} className="mt-3 inline-flex h-9 items-center rounded-lg border border-[#C7D4C1] bg-white px-3 text-xs font-bold text-[#397246] hover:bg-[#F1F6EE]">
                {showAll ? '只看前 3 个' : `查看全部 ${tierFilter === '全部' ? radar.opportunities.length : radar.opportunities.filter((item) => item.tier === tierFilter).length} 个选题`}
              </button>
            )}
          </section>

          <section>
            <SectionTitle icon={BookOpenText}>分析报告</SectionTitle>
            <div className="grid gap-3 xl:grid-cols-[1.15fr_1fr]">
              <button type="button" onClick={() => setActiveReport(radar.deepReport)} className="group grid min-h-[164px] grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-[#CFE0C6] bg-[#F5FAF1] p-5 text-left transition hover:border-[#AFC8A5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/30 active:translate-y-px">
                <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-[#397246] text-white"><FileChartColumn size={25} /></span>
                <span>
                  <span className="block text-lg font-bold text-[#24301F]">{contentRadarGeneratedDisplayText(radar.deepReport.title)}</span>
                  <span className="mt-2 block text-sm leading-6 text-[#667060]">{contentRadarGeneratedDisplayText(radar.deepReport.summary)}</span>
                </span>
                <ArrowUpRight size={18} className="text-[#71806B] group-hover:text-[#397246]" />
              </button>
              <div className="grid grid-cols-2 gap-3">
                {radar.specialReports.map((report, index) => {
                  const Icon = REPORT_ICONS[index % REPORT_ICONS.length];
                  return (
                    <button key={report.id} type="button" onClick={() => setActiveReport(report)} className="group rounded-xl border border-[#DCE4D7] bg-white p-4 text-left transition hover:border-[#AFC8A5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/30 active:translate-y-px">
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#E9F7DB] text-[#4F9724]"><Icon size={17} /></span>
                      <span className="mt-3 block text-sm font-bold leading-5 text-[#2C3728]">{contentRadarGeneratedDisplayText(report.title)}</span>
                      <span className="mt-1 line-clamp-2 block text-xs leading-5 text-[#758070]">{contentRadarGeneratedDisplayText(report.summary)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section>
            <SectionTitle icon={UsersRound} detail="根据这次找到的公开内容排序，不代表全行业排名。">值得关注的创作者</SectionTitle>
            {radar.creatorWatchlist.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {radar.creatorWatchlist.map((creator) => {
                  const source = publicLink(creator.sourceUrl);
                  const content = <>
                    <span className="font-mono text-2xl font-black text-[#4F9724]">{String(creator.rank).padStart(2, '0')}</span>
                    <span className="mt-2 block truncate text-sm font-bold text-[#2C3728]" title={creator.name}>{creator.name}</span>
                    <span className="mt-1 block text-xs text-[#758070]">平均热门潜力 {creator.averagePotential}，比平时 {creator.creatorLift > 0 ? '+' : ''}{creator.creatorLift}%</span>
                    <span className="mt-1 block text-[11px] text-[#879182]">{creator.baselineStatus === 'historical' ? `已参考 ${creator.historySampleCount} 条历史内容` : '历史内容不足，仅参考本次结果'}</span>
                    <span className="mt-2 line-clamp-2 text-[11px] leading-5 text-[#667060]">{contentRadarGeneratedDisplayText(creator.primaryMechanism)}</span>
                  </>;
                  return source ? <a key={`${creator.rank}-${creator.name}`} href={source} target="_blank" rel="noreferrer" className="rounded-xl border border-[#DCE4D7] bg-white p-4 transition hover:border-[#AFC8A5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/30">{content}</a> : <article key={`${creator.rank}-${creator.name}`} className="rounded-xl border border-[#DCE4D7] bg-white p-4">{content}</article>;
                })}
              </div>
            ) : <p className="rounded-xl border border-[#DCE4D7] bg-white p-5 text-sm text-[#667060]">本轮公开结果没有返回可识别作者。</p>}
          </section>

          <section>
            <SectionTitle icon={FlaskConical} detail="候选内容全部保留；只有通过多证据门槛的内容才称为爆款。">爆款内容证据</SectionTitle>
            <div className="mb-3 grid gap-2 md:grid-cols-4">
              {[
                ['可验证爆款', '证据≥80、表现≥75、相关性≥60、总分≥80，并有至少 2 个表现指标和 1 个强比较信号。'],
                ['高潜样本', '综合分 60–79，值得参考，但没有同时达到所有爆款门槛。'],
                ['相关样本', '与搜索主题相关，但综合表现暂不足以称为高潜或爆款。'],
                ['指标不足', '时间、公开链接或表现指标不足；完整保留供查看，但不进入爆款排序。'],
              ].map(([label, detail]) => (
                <article key={label} className="rounded-lg border border-[#DCE4D7] bg-[#F8FAF6] p-3">
                  <p className="text-xs font-bold text-[#34402F]">{label}</p>
                  <p className="mt-1 text-[11px] leading-5 text-[#758070]">{detail}</p>
                </article>
              ))}
            </div>
            <div className="overflow-hidden rounded-xl border border-[#DCE4D7] bg-white">
              {radar.samples.map((sample, index) => {
                const source = publicLink(sample.sourceUrl);
                const classification = SAMPLE_CLASS_COPY[sample.sampleClass];
                const visibleMetrics = Object.entries(sample.metrics).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
                return (
                  <article key={sample.sourceUrl || `${sample.title}-${index}`} className="grid gap-3 border-b border-[#E7ECE3] p-4 last:border-b-0 md:grid-cols-[72px_minmax(0,1fr)_auto] md:items-center">
                    <div className="text-center">
                      <p className="font-mono text-xl font-black text-[#4F9724]">{sample.sampleClass === 'insufficient' ? '—' : sample.breakoutScore}</p>
                      <p className="text-[10px] text-[#7B8576]">{sample.sampleClass === 'insufficient' ? '不参与排序' : '综合分'}</p>
                    </div>
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${classification.className}`}>{classification.label}</span>
                        <p className="min-w-0 flex-1 truncate text-sm font-bold text-[#2C3728]" title={sample.title || '标题未公开'}>{sample.title || '标题未公开'}</p>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#758070]">{contentRadarGeneratedDisplayText(sample.summary || sample.mechanism)}</p>
                      <p className="mt-1 text-[11px] leading-5 text-[#6F796B]">{contentRadarGeneratedDisplayText(sample.classificationReason)}</p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#879182]">
                        <span>{sample.author || '作者未公开'}</span>
                        <span>证据可信度 {sample.confidence}%</span>
                        <span>{sample.ageDays === null ? '发布时间缺失' : `发布 ${sample.ageDays} 天`}</span>
                        {sample.creatorLift !== null && <span>作者/批次提升 {Math.round((sample.creatorLift - 1) * 100) > 0 ? '+' : ''}{Math.round((sample.creatorLift - 1) * 100)}%</span>}
                        {sample.engagementRate !== null && <span>互动率 {(sample.engagementRate * 100).toFixed(2)}%</span>}
                        {visibleMetrics.map(([key, value]) => <span key={key}>{METRIC_LABELS[key] || key} {compactNumber(value)}</span>)}
                      </div>
                    </div>
                    {source && <a href={source} target="_blank" rel="noreferrer" className="inline-flex h-[32px] items-center justify-center gap-1 whitespace-nowrap rounded-lg border border-[#CCD8C6] px-2.5 text-xs font-bold text-[#397246] hover:bg-[#EEF5EA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397246]/30">查看原始内容 <ArrowUpRight size={13} /></a>}
                  </article>
                );
              })}
            </div>
          </section>

          <section>
            <SectionTitle icon={CircleGauge}>计算方法和数据限制</SectionTitle>
            <TechnicalDetails summary="查看分数怎么算、搜索了什么、有哪些限制" className="border-[#DCE4D7]">
              <div className="grid gap-5 lg:grid-cols-3">
                <div><h3 className="text-xs font-bold text-[#397246]">推荐分怎么算</h3><ul className="mt-2 space-y-1.5 text-xs leading-5">{radar.methodology.formulaFactors.map((item) => <li key={item}>{contentRadarGeneratedDisplayText(item)}</li>)}</ul></div>
                <div><h3 className="text-xs font-bold text-[#397246]">分数代表什么</h3><ul className="mt-2 space-y-1.5 text-xs leading-5">{radar.methodology.scoreLegend.map((item) => <li key={item}>{contentRadarGeneratedDisplayText(item)}</li>)}</ul></div>
                <div><h3 className="text-xs font-bold text-[#397246]">数据限制</h3><ul className="mt-2 space-y-1.5 text-xs leading-5">{radar.methodology.limitations.map((item) => <li key={item}>{contentRadarGeneratedDisplayText(item)}</li>)}</ul></div>
              </div>
              <div className="mt-4 border-t border-[#E7ECE3] pt-3 text-xs leading-5 text-[#758070]">
                <p>{contentRadarGeneratedDisplayText(radar.methodology.rankScope)}。{contentRadarGeneratedDisplayText(radar.methodology.freshnessLabel)}。</p>
                <p className="mt-1">数据完整度：{radar.provenance.completeness}，搜索记录 {radar.provenance.extractTrace.length} 条，补充读取文章 {radar.coverage.enrichedArticleCount}/{radar.coverage.enrichmentAttemptCount}，包含评论的内容 {radar.coverage.commentArticleCount} 篇。</p>
                <TechnicalDetailList items={[
                  { label: '扫描编号', value: radar.snapshotId },
                  { label: '扫描记录文件', value: radar.snapshotPath },
                  { label: '计算版本', value: radar.methodology.formulaVersion },
                ]} />
              </div>
            </TechnicalDetails>
            {radar.coverage.warnings.length > 0 && (
              <TechnicalDetails className="mt-3 border-[#E1D6BA] bg-[#FFFDF5]" summary={`${radar.coverage.warnings.length} 组搜索结果不完整`}>
                <ul className="mt-2 space-y-1.5 leading-5">{radar.coverage.warnings.map((warning) => <li key={warning}>{contentRadarGeneratedDisplayText(warning)}</li>)}</ul>
              </TechnicalDetails>
            )}
          </section>
        </div>
      )}

      <Dialog open={Boolean(activeReport)} onOpenChange={(open) => { if (!open) setActiveReport(null); }}>
        <DialogContent className="max-h-[82dvh] max-w-[760px] overflow-y-auto rounded-xl border border-[#DCE4D7] bg-[#FBFDF9] p-0 text-[#24301F] shadow-[0_24px_80px_rgba(35,52,29,0.18)] sm:max-w-[760px]">
          {activeReport && <>
            <DialogHeader className="border-b border-[#DCE4D7] bg-white px-6 py-5 pr-14">
              <DialogTitle className="text-xl font-bold leading-7 text-[#24301F]">{contentRadarGeneratedDisplayText(activeReport.title)}</DialogTitle>
              <DialogDescription className="leading-6 text-[#667060]">{contentRadarGeneratedDisplayText(activeReport.summary)}</DialogDescription>
            </DialogHeader>
            <div className="space-y-5 px-6 py-5">
              {activeReport.sections.map((section) => (
                <section key={section.title}>
                  <h3 className="text-sm font-bold text-[#397246]">{contentRadarGeneratedDisplayText(section.title)}</h3>
                  <ul className="mt-2 space-y-2">
                    {section.bullets.map((bullet) => <li key={bullet} className="flex gap-3 text-sm leading-6 text-[#53604E]"><Check className="mt-1 shrink-0 text-[#79B94E]" size={15} /><span>{contentRadarGeneratedDisplayText(bullet)}</span></li>)}
                  </ul>
                </section>
              ))}
              <p className="rounded-lg bg-[#EDF4E8] p-3 text-xs leading-5 text-[#5B6A55]">报告只使用已收集的公开信息和根据这些信息计算的分数。只参考选题和结构，不复制原内容。</p>
            </div>
          </>}
        </DialogContent>
      </Dialog>
    </div>
  );
}

'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Database,
  ExternalLink,
  FileCheck2,
  LoaderCircle,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { displayClientError } from '@/lib/client-error-copy';
import { TechnicalDetailList, TechnicalDetails } from '@/components/TechnicalDetails';
import { PRODUCT_COPY, PRODUCTION_STATUS_DISPLAY_NAMES, platformDisplayName } from '@/lib/product-copy';
import { ProductionOutcomes } from '@/components/production/ProductionOutcomes';

type MetricSource = 'manual_operator' | 'performance_evidence' | 'tikomni_live';

type Metric = {
  value: number;
  source: MetricSource;
  recorded_at: string;
  evidence_path?: string;
};

type PublicCollection = {
  status: 'available' | 'unavailable';
  captured_at: string;
  endpoint_id?: string;
  raw_path?: string;
  reason?: string;
};

type ReviewItem = {
  source_record_id: string;
  platform: 'wechat' | 'xiaohongshu' | 'moments' | 'shipinhao' | 'douyin';
  item_id: string;
  published_url: string;
  proof_path?: string;
  proof_sha256?: string;
  published_at: string;
  adopted_visual_assets: Array<{ path: string; sha256: string; role?: string }>;
  required_metrics: string[];
  metrics: Record<string, Metric>;
  comment_samples: string[];
  public_collection?: PublicCollection;
};

type ReviewRecord = {
  record_id: string;
  week: string;
  status: 'waiting_metrics' | 'ready' | 'completed' | 'memory_applied' | 'no_publications';
  items: ReviewItem[];
  report_path?: string;
  quality_status?: 'pass' | 'review_required' | 'blocked';
  quality_issues?: { blocking?: string[]; review?: string[] };
  proposed_memory?: Record<string, string[]>;
  memory_paths?: string[];
};

type WeeklyResponse = {
  status: ReviewRecord['status'] | 'not_due';
  record_path?: string;
  record?: ReviewRecord;
  missing_metrics?: Array<{ source_record_id: string; platform: string; metric: string; label: string }>;
  report_path?: string;
  reminder?: { should_notify: boolean; message: string };
  next_scheduled_at?: string;
  error?: string;
};

type Notice = { tone: 'success' | 'warning' | 'error'; text: string } | null;

const PLATFORM_LABELS: Record<ReviewItem['platform'], string> = {
  wechat: platformDisplayName('wechat'),
  xiaohongshu: platformDisplayName('xiaohongshu'),
  moments: platformDisplayName('moments'),
  shipinhao: platformDisplayName('shipinhao'),
  douyin: platformDisplayName('douyin'),
};

const METRIC_LABELS: Record<string, string> = {
  exposures: '曝光',
  reads: '阅读',
  readers: '阅读人数',
  plays: '播放',
  likes: '点赞',
  wows: '在看',
  shares: '分享',
  collects: '收藏',
  comments: '评论',
  new_followers: '新增关注',
  profile_visits: '主页访问',
  leads: '线索',
};

const STATUS_META: Record<ReviewRecord['status'] | 'not_due', { label: string; className: string }> = {
  waiting_metrics: { label: PRODUCTION_STATUS_DISPLAY_NAMES.blocked, className: 'bg-[#FFF8E8] text-[#8D5A00]' },
  ready: { label: PRODUCTION_STATUS_DISPLAY_NAMES.pending, className: 'bg-[#EEF5FF] text-[#2763A6]' },
  completed: { label: PRODUCTION_STATUS_DISPLAY_NAMES.completed, className: 'bg-[#EDF8F0] text-[#16803C]' },
  memory_applied: { label: PRODUCTION_STATUS_DISPLAY_NAMES.completed, className: 'bg-[#EDF8F0] text-[#16803C]' },
  no_publications: { label: PRODUCTION_STATUS_DISPLAY_NAMES.pending, className: 'bg-[#F7F7F7] text-[#6B6B6B]' },
  not_due: { label: PRODUCTION_STATUS_DISPLAY_NAMES.pending, className: 'bg-[#F7F7F7] text-[#6B6B6B]' },
};

const METRIC_SOURCE_META: Record<MetricSource, { label: string; className: string }> = {
  manual_operator: { label: '手动填写', className: 'bg-[#F7F7F7] text-[#6B6B6B]' },
  performance_evidence: { label: '导入数据', className: 'bg-[#EEF5FF] text-[#2763A6]' },
  tikomni_live: { label: '平台公开数据', className: 'bg-[#EDF8F0] text-[#16803C]' },
};

const OUTPUT_READABLE_ROOTS = [
  'pipeline/',
  'quality/',
  'materials/research/',
  'materials/publish-proof/',
  'materials/publish-evidence/',
  'materials/performance/',
  'materials/tikomni/raw/',
  'materials/weekly-review/',
  'runs/',
];

function outputHref(path: string | undefined): string {
  const normalized = (path || '').trim().replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !normalized
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || !OUTPUT_READABLE_ROOTS.some((root) => normalized.startsWith(root))
  ) {
    return '';
  }
  return `/api/output/${segments.map(encodeURIComponent).join('/')}`;
}

function externalHref(value: string | undefined): string {
  const candidate = value?.trim() || '';
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function metricKey(recordId: string, metric: string): string {
  return `${recordId}:${metric}`;
}

function dateTime(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export default function WeeklyReviewPage() {
  const [data, setData] = useState<WeeklyResponse | null>(null);
  const [metricValues, setMetricValues] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'load' | 'collect' | 'save' | 'complete' | 'memory' | null>('load');
  const [notice, setNotice] = useState<Notice>(null);
  const [memoryConfirmed, setMemoryConfirmed] = useState(false);

  const hydrate = useCallback((payload: WeeklyResponse) => {
    setData(payload);
    const nextMetrics: Record<string, string> = {};
    const nextComments: Record<string, string> = {};
    for (const item of payload.record?.items || []) {
      for (const metric of item.required_metrics) {
        const value = item.metrics[metric]?.value;
        if (value !== undefined) nextMetrics[metricKey(item.source_record_id, metric)] = String(value);
      }
      nextComments[item.source_record_id] = item.comment_samples.join('\n');
    }
    setMetricValues(nextMetrics);
    setComments(nextComments);
  }, []);

  const load = useCallback(async () => {
    setBusy('load');
    try {
      const response = await fetch('/api/weekly-review', { cache: 'no-store' });
      const payload = await response.json() as WeeklyResponse;
      if (!response.ok) throw new Error(payload.error || '读取本周发布复盘失败');
      hydrate(payload);
      if (payload.reminder?.should_notify) {
        setNotice({
          tone: 'warning',
          text: displayClientError(payload.reminder.message, '本周发布结果还没有汇总。请先保存发布结果。'),
        });
      }
    } catch (error) {
      setNotice({ tone: 'error', text: displayClientError(error, '本周发布记录没有读取成功。请刷新后重试。') });
    } finally {
      setBusy(null);
    }
  }, [hydrate]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const submit = async (action: 'collect' | 'save_metrics' | 'complete' | 'apply_memory', body: Record<string, unknown> = {}) => {
    const busyState = action === 'collect' ? 'collect' : action === 'save_metrics' ? 'save' : action === 'complete' ? 'complete' : 'memory';
    setBusy(busyState);
    setNotice(null);
    try {
      const response = await fetch('/api/weekly-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
      });
      const payload = await response.json() as WeeklyResponse;
      if (!response.ok) throw new Error(payload.error || '本周发布复盘操作失败');
      hydrate(payload);
      const messages: Record<typeof action, string> = {
        collect: '已汇总本周发布结果和可用数据',
        save_metrics: '已保存发布数据和代表性评论',
        complete: '本周复盘已生成，请确认是否保存为今后的写作参考',
        apply_memory: '复盘结论已保存为写作参考',
      };
      setNotice({ tone: 'success', text: messages[action] });
      toast.success(messages[action]);
      if (action === 'apply_memory') setMemoryConfirmed(false);
    } catch (error) {
      const message = displayClientError(error, '本周发布复盘没有完成。请重试。');
      setNotice({ tone: 'error', text: message });
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const saveMetrics = async (event: FormEvent) => {
    event.preventDefault();
    const record = data?.record;
    if (!record || !data?.record_path) return;
    const updates: Record<string, { metrics?: Record<string, number>; comments?: string[] }> = {};
    for (const item of record.items) {
      const metrics: Record<string, number> = {};
      for (const metric of item.required_metrics) {
        const raw = metricValues[metricKey(item.source_record_id, metric)]?.trim();
        if (!raw) continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
          setNotice({ tone: 'error', text: `${PLATFORM_LABELS[item.platform]}的${METRIC_LABELS[metric] || metric}必须是非负数字` });
          return;
        }
        metrics[metric] = value;
      }
      const samples = (comments[item.source_record_id] || '')
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 10);
      if (Object.keys(metrics).length || samples.length) {
        updates[item.source_record_id] = {
          ...(Object.keys(metrics).length ? { metrics } : {}),
          ...(samples.length ? { comments: samples } : {}),
        };
      }
    }
    if (!Object.keys(updates).length) {
      setNotice({ tone: 'warning', text: '请先填写至少一项发布数据或代表性评论' });
      return;
    }
    await submit('save_metrics', { recordPath: data.record_path, updates });
  };

  const record = data?.record;
  const missingCount = data?.missing_metrics?.length || 0;
  const totals = useMemo(() => ({
    items: record?.items.length || 0,
    visuals: record?.items.reduce((count, item) => count + item.adopted_visual_assets.length, 0) || 0,
    missing: missingCount,
  }), [missingCount, record]);
  const status = STATUS_META[data?.status || 'not_due'];
  const canComplete = Boolean(record && data?.record_path && record.status === 'ready');
  const canApplyMemory = Boolean(record && data?.record_path && record.status === 'completed' && record.quality_status === 'pass' && memoryConfirmed);
  const reportHref = outputHref(record?.report_path || data?.report_path);
  const initialLoadFailed = !data && notice?.tone === 'error';

  return (
    <div className="aifios-editorial-page mx-auto flex w-full max-w-[1480px] flex-col gap-4">
      <header><h1 className="text-[24px] font-bold text-[#1A1A1A]">{PRODUCT_COPY.pages.weeklyReview.title}</h1><p className="mt-2 text-sm leading-6 text-[#656B5F]">未写完的草稿、已保存的文章和发布结果，都从这里继续。</p></header>
      <ProductionOutcomes />
      <section className="border border-[rgba(28,28,30,0.1)] bg-white">
        <div className="flex flex-col gap-4 border-b border-[rgba(28,28,30,0.08)] px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[#E85D4C]">
              <BarChart3 size={17} />
              <span className="text-[12px] font-bold">数据复盘</span>
            </div>
            <h2 className="mt-2 text-[21px] font-bold text-[#1A1A1A]">本周发布复盘</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex h-8 items-center px-3 text-[12px] font-bold ${status.className}`}>{status.label}</span>
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy !== null}
              title="刷新本周发布复盘"
              className="flex h-9 w-9 items-center justify-center border border-[rgba(28,28,30,0.14)] text-[#6B6B6B] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50"
            >
              {busy === 'load' ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </button>
            <button
              type="button"
              onClick={() => void submit('collect')}
              disabled={busy !== null}
              className="inline-flex h-9 items-center gap-2 border border-[#1A1A1A] bg-[#1A1A1A] px-3 text-[12px] font-bold text-white hover:bg-[#353535] disabled:opacity-50"
            >
              {busy === 'collect' ? <LoaderCircle size={14} className="animate-spin" /> : <Database size={14} />}
              汇总本周发布
            </button>
          </div>
        </div>

        {notice && (
          <div className={`flex items-start gap-2 border-b px-4 py-3 text-[13px] sm:px-6 ${
            notice.tone === 'error'
              ? 'border-[#F1C4BD] bg-[#FFF1EE] text-[#B43C2E]'
              : notice.tone === 'warning'
                ? 'border-[#F2D7A7] bg-[#FFF8E8] text-[#8D5A00]'
                : 'border-[#C6E6CF] bg-[#EDF8F0] text-[#16803C]'
          }`}>
            {notice.tone === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
            <span>{notice.text}</span>
          </div>
        )}

        {record ? (
          <>
            <div className="grid grid-cols-3 border-b border-[rgba(28,28,30,0.08)]">
              {[
                ['已发布内容', totals.items],
                ['使用的图片', totals.visuals],
                ['待填数据', totals.missing],
              ].map(([label, count]) => (
                <div key={String(label)} className="border-r border-[rgba(28,28,30,0.08)] px-4 py-3 last:border-r-0 sm:px-6">
                  <p className="text-[11px] font-bold text-[#8A8178]">{label}</p>
                  <p className="mt-1 text-[19px] font-bold text-[#1A1A1A]">{count}</p>
                </div>
              ))}
            </div>

            {record.status === 'no_publications' ? (
              <div className="px-4 py-12 text-center text-[13px] text-[#6B6B6B] sm:px-6">本周尚无已确认发布结果。</div>
            ) : (
              <form onSubmit={saveMetrics} className="divide-y divide-[rgba(28,28,30,0.08)]">
                {record.items.map((item) => {
                  const publicationHref = externalHref(item.published_url);
                  const proofHref = outputHref(item.proof_path);
                  const publicCollection = item.public_collection;
                  const rawEvidenceHref = outputHref(publicCollection?.raw_path);

                  return (
                    <section key={item.source_record_id} className="px-4 py-5 sm:px-6">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="text-[14px] font-bold text-[#1A1A1A]">{PLATFORM_LABELS[item.platform]}</p>
                          <div className="mt-1 flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-[12px] font-medium">
                            {publicationHref && (
                              <a href={publicationHref} target="_blank" rel="noreferrer" title={publicationHref} className="inline-flex max-w-full items-center gap-1 text-[#2763A6] hover:underline">
                                <ExternalLink size={13} className="shrink-0" />
                                <span className="whitespace-nowrap">查看发布链接</span>
                              </a>
                            )}
                            {proofHref && (
                              <a href={proofHref} target="_blank" rel="noreferrer" title="查看发布截图或凭证" className="inline-flex max-w-full items-center gap-1 text-[#2763A6] hover:underline">
                                <FileCheck2 size={13} className="shrink-0" />
                                <span className="whitespace-nowrap">查看本机发布凭证</span>
                              </a>
                            )}
                            {!publicationHref && !proofHref && (
                              <span className="text-[#A66300]">未提供可验证发布链接或本机凭证</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] font-medium text-[#8A8178]">
                          <span>{dateTime(item.published_at)}</span>
                          <span>使用 {item.adopted_visual_assets.length} 张图片</span>
                        </div>
                      </div>

                      {publicCollection && (
                        <div className="mt-3 border-l-2 border-[#B9D1F1] bg-[#F7FAFF] px-3 py-2 text-[11px] text-[#52606D]">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-bold text-[#2763A6]">平台数据</span>
                            <span className={publicCollection.status === 'available' ? 'font-bold text-[#16803C]' : 'font-bold text-[#A66300]'}>
                              {publicCollection.status === 'available' ? '已获取' : '暂不可用'}
                            </span>
                            <span>获取时间 {dateTime(publicCollection.captured_at)}</span>
                            {rawEvidenceHref && (
                              <a href={rawEvidenceHref} target="_blank" rel="noreferrer" title="查看原始数据" className="inline-flex items-center gap-1 font-bold text-[#2763A6] hover:underline">
                                <ExternalLink size={12} />
                                查看原始数据
                              </a>
                            )}
                            {publicCollection.raw_path && !rawEvidenceHref && <span className="text-[#A66300]">原始数据文件暂时无法打开</span>}
                          </div>
                          {publicCollection.reason && (
                            <p className="mt-1 leading-[1.5] text-[#6B6B6B]">
                              {displayClientError(publicCollection.reason, '平台数据暂时没有获取成功。请稍后重试。')}
                            </p>
                          )}
                        </div>
                      )}

                      <TechnicalDetails className="mt-3" summary="数据文件信息">
                        <TechnicalDetailList items={[
                          { label: '发布记录编号', value: item.source_record_id },
                          ...(item.proof_path ? [{ label: '发布凭证文件', value: item.proof_path }] : []),
                          ...(item.proof_sha256 ? [{ label: '文件校验码', value: item.proof_sha256 }] : []),
                          ...(publicCollection?.endpoint_id ? [{ label: '数据接口编号', value: publicCollection.endpoint_id }] : []),
                          ...(publicCollection?.raw_path ? [{ label: '原始数据文件', value: publicCollection.raw_path }] : []),
                          ...Object.entries(item.metrics)
                            .filter(([, metric]) => Boolean(metric.evidence_path))
                            .map(([metricName, metric]) => ({
                              label: `${METRIC_LABELS[metricName] || metricName}数据文件`,
                              value: metric.evidence_path || '',
                            })),
                          ...(item.adopted_visual_assets.length ? [{
                            label: '图片文件',
                            value: item.adopted_visual_assets.map((asset) => `${asset.path} · ${asset.sha256}`).join('\n'),
                          }] : []),
                        ]} />
                      </TechnicalDetails>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                        {item.required_metrics.map((metric) => {
                          const key = metricKey(item.source_record_id, metric);
                          const metricRecord = item.metrics[metric];
                          const sourceMeta = metricRecord ? METRIC_SOURCE_META[metricRecord.source] : undefined;
                          const evidenceHref = outputHref(metricRecord?.evidence_path);
                          return (
                            <label key={metric} className="block">
                              <span className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-bold text-[#6B6B6B]">
                                {METRIC_LABELS[metric] || metric}
                              </span>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={metricValues[key] || ''}
                                onChange={(event) => setMetricValues((current) => ({ ...current, [key]: event.target.value }))}
                                className="h-9 w-full border border-[rgba(28,28,30,0.14)] bg-white px-2 text-[13px] text-[#1A1A1A] outline-none focus:border-[#E85D4C]"
                              />
                              <span className="mt-1.5 flex min-h-[26px] flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] leading-[1.4] text-[#8A8178]">
                                {metricRecord ? (
                                  <>
                                    <span className={`px-1.5 py-0.5 font-bold ${sourceMeta?.className || 'bg-[#F7F7F7] text-[#6B6B6B]'}`}>
                                      {sourceMeta?.label || '来源待确认'}
                                    </span>
                                    <span>记录时间 {dateTime(metricRecord.recorded_at)}</span>
                                    {evidenceHref && (
                                      <a href={evidenceHref} target="_blank" rel="noreferrer" title="查看数据来源" className="inline-flex items-center gap-0.5 font-bold text-[#2763A6] hover:underline">
                                        <ExternalLink size={11} />
                                        查看来源
                                      </a>
                                    )}
                                    {metricRecord.evidence_path && !evidenceHref && <span className="text-[#A66300]">数据来源文件暂时无法打开</span>}
                                  </>
                                ) : (
                                  <span>等待填写</span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <label className="mt-4 block">
                        <span className="mb-1.5 block text-[11px] font-bold text-[#6B6B6B]">代表性评论</span>
                        <textarea
                          value={comments[item.source_record_id] || ''}
                          onChange={(event) => setComments((current) => ({ ...current, [item.source_record_id]: event.target.value }))}
                          rows={3}
                          placeholder="每行粘贴一条评论"
                          className="w-full resize-y border border-[rgba(28,28,30,0.14)] bg-white px-3 py-2 text-[13px] leading-[1.6] text-[#1A1A1A] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]"
                        />
                      </label>
                    </section>
                  );
                })}
                {record.status === 'waiting_metrics' && (
                  <div className="flex flex-col gap-3 bg-[#FDF8F3] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                    <p className="text-[12px] text-[#6B6B6B]">还有 {missingCount} 项数据没填。</p>
                    <button type="submit" disabled={busy !== null} className="inline-flex h-9 items-center justify-center gap-2 border border-[#1A1A1A] bg-[#1A1A1A] px-3 text-[12px] font-bold text-white hover:bg-[#353535] disabled:opacity-50">
                      {busy === 'save' ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}
                      保存数据
                    </button>
                  </div>
                )}
              </form>
            )}

            {record.status === 'ready' && (
              <div className="flex flex-col gap-3 border-t border-[rgba(28,28,30,0.08)] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <p className="text-[12px] text-[#2763A6]">关键数据已填完，可以生成本周复盘。</p>
                <button type="button" onClick={() => data.record_path && void submit('complete', { recordPath: data.record_path })} disabled={!canComplete || busy !== null} className="inline-flex h-9 items-center justify-center gap-2 border border-[#E85D4C] bg-[#E85D4C] px-3 text-[12px] font-bold text-white hover:bg-[#C94A3B] disabled:opacity-50">
                  {busy === 'complete' ? <LoaderCircle size={14} className="animate-spin" /> : <FileCheck2 size={14} />}
                  生成本周复盘
                </button>
              </div>
            )}

            {(record.status === 'completed' || record.status === 'memory_applied') && (
              <div className="border-t border-[rgba(28,28,30,0.08)] px-4 py-4 sm:px-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold text-[#1A1A1A]">本周复盘已生成</p>
                    {record.quality_status && <p className="mt-1 text-[12px] text-[#6B6B6B]">复盘完整度：{record.quality_status === 'pass' ? '可以保存' : '还需补充你的判断'}</p>}
                    {record.quality_status !== 'pass' && (record.quality_issues?.blocking?.length || record.quality_issues?.review?.length) ? (
                      <p className="mt-1 max-w-[680px] text-[11px] leading-[1.6] text-[#A66300]">
                        {[...(record.quality_issues?.blocking || []), ...(record.quality_issues?.review || [])].slice(0, 2).join('；')}
                      </p>
                    ) : null}
                  </div>
                  {reportHref && (
                    <a href={reportHref} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center justify-center gap-2 border border-[rgba(28,28,30,0.14)] px-3 text-[12px] font-bold text-[#2763A6] hover:border-[#2763A6]">
                      <ExternalLink size={14} />
                      查看复盘
                    </a>
                  )}
                </div>
                {record.status === 'completed' && (
                  <div className="mt-4 flex flex-col gap-3 border-t border-[rgba(28,28,30,0.08)] pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <label className="flex items-center gap-2 text-[12px] text-[#1A1A1A]">
                      <input type="checkbox" checked={memoryConfirmed} onChange={(event) => setMemoryConfirmed(event.target.checked)} className="h-4 w-4 accent-[#E85D4C]" />
                      确认把这次复盘结论保存为今后写作参考
                    </label>
                    <button type="button" onClick={() => data.record_path && void submit('apply_memory', { recordPath: data.record_path, humanConfirmed: true })} disabled={!canApplyMemory || busy !== null} className="inline-flex h-9 items-center justify-center gap-2 border border-[#1A1A1A] bg-white px-3 text-[12px] font-bold text-[#1A1A1A] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50">
                      {busy === 'memory' ? <LoaderCircle size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                      保存为写作参考
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : initialLoadFailed ? (
          <div className="px-4 py-14 text-center sm:px-6" role="alert">
            <p className="text-[14px] font-bold text-[#B43C2E]">暂时无法确认本周是否有发布记录</p>
            <p className="mt-2 text-[12px] text-[#6B6B6B]">现有数据没有被清空。请检查连接后重新读取。</p>
            <button type="button" onClick={() => void load()} disabled={busy !== null} className="mt-4 inline-flex h-9 items-center justify-center gap-2 border border-[#1A1A1A] bg-[#1A1A1A] px-3 text-[12px] font-bold text-white hover:bg-[#353535] disabled:opacity-50">
              {busy === 'load' ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              重新读取
            </button>
          </div>
        ) : (
          <div className="px-4 py-14 text-center sm:px-6">
            <p className="text-[14px] font-bold text-[#1A1A1A]">还没有可复盘的发布记录</p>
            <p className="mt-2 text-[12px] text-[#6B6B6B]">先到发布准备与记录，保存至少一条发布结果。</p>
            <a href="/publication-desk" className="mt-4 inline-flex h-9 items-center justify-center border border-[#1A1A1A] bg-[#1A1A1A] px-3 text-[12px] font-bold text-white hover:bg-[#353535]">
              去记录发布结果
            </a>
          </div>
        )}
      </section>
    </div>
  );
}

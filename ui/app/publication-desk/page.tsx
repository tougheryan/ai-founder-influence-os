'use client';

import { OutputDownloadLink } from '@/components/OutputDownloadLink';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileDown,
  Link2,
  LoaderCircle,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { TechnicalDetails } from '@/components/TechnicalDetails';
import { displayClientError } from '@/lib/client-error-copy';
import { outputHref } from '@/lib/output-links';
import { fillDraftWithDesktopBridge, hasDesktopPublicationBridge } from '@/lib/desktop-publication-client';
import { PRODUCT_COPY, PRODUCTION_STATUS_DISPLAY_NAMES, platformDisplayName } from '@/lib/product-copy';
import {
  publicationJobDisplayLabel,
  publicationJobErrorCopy,
  publicationPrimaryAction,
  safePublicationJobErrorCode,
} from '@/lib/publication-display-copy';
import {
  canExplicitlyRetryLocalDraft,
  canRecordPublicationEvidence,
  hasCompleteDraftQueue,
  MANUAL_DRAFT_RETRY_CONFIRMATION,
  publicationQueueMatchesIntegrity,
  type ProductionFlowIntegrity,
} from '@/lib/production-flow';

type JobStatus =
  | 'pending'
  | 'authorizing'
  | 'draft_filled'
  | 'retryable_failure'
  | 'manual_intervention_required'
  | 'published_confirmed'
  | 'unknown_completion';

type PublicationJob = {
  job_id: string;
  platform: 'wechat' | 'xiaohongshu' | 'moments' | 'shipinhao' | 'douyin';
  item_id: string;
  item_label: string;
  delivery_kind: 'draft_fill' | 'execution_package';
  adapter: 'wechat_official_api' | 'authorized_browser' | 'mobile_bridge' | 'download';
  fallback_adapter?: 'authorized_browser';
  payload_hash: string;
  status: JobStatus;
  payload: {
    title: string;
    summary?: string;
    copy_path?: string;
    html_path?: string;
    execution_package_path?: string;
    asset_paths?: string[];
  };
  selected_asset_hashes?: Array<{ id?: string; path: string; sha256: string; role?: string }>;
  last_error?: { code?: string; message?: string };
  result_reference?: string;
};

type PublicationQueue = {
  run_id: string;
  run_slug: string;
  package_path: string;
  target_platforms?: Array<'wechat' | 'xiaohongshu' | 'shipinhao'>;
  jobs: PublicationJob[];
};

type Notice = { tone: 'success' | 'error' | 'warning'; text: string } | null;

const PLATFORM_LABELS: Record<PublicationJob['platform'], string> = {
  wechat: platformDisplayName('wechat'),
  xiaohongshu: platformDisplayName('xiaohongshu'),
  moments: platformDisplayName('moments'),
  shipinhao: platformDisplayName('shipinhao'),
  douyin: platformDisplayName('douyin'),
};

const STATUS_META: Record<JobStatus, { label: string; className: string }> = {
  pending: { label: PRODUCTION_STATUS_DISPLAY_NAMES.pending, className: 'bg-[#F7F7F7] text-[#6B6B6B]' },
  authorizing: { label: PRODUCTION_STATUS_DISPLAY_NAMES.authorizing, className: 'bg-[#EEF5FF] text-[#2763A6]' },
  draft_filled: { label: PRODUCTION_STATUS_DISPLAY_NAMES.draft_filled, className: 'bg-[#EDF8F0] text-[#16803C]' },
  retryable_failure: { label: PRODUCTION_STATUS_DISPLAY_NAMES.retryable_failure, className: 'bg-[#FFF1EE] text-[#B43C2E]' },
  manual_intervention_required: { label: PRODUCTION_STATUS_DISPLAY_NAMES.manual_intervention_required, className: 'bg-[#FFF8E8] text-[#8D5A00]' },
  published_confirmed: { label: PRODUCTION_STATUS_DISPLAY_NAMES.published_confirmed, className: 'bg-[#EDF8F0] text-[#16803C]' },
  unknown_completion: { label: PRODUCTION_STATUS_DISPLAY_NAMES.unknown_completion, className: 'bg-[#FFF8E8] text-[#8D5A00]' },
};

const NATIVE_PLATFORM_ORDER = ['wechat', 'xiaohongshu', 'shipinhao'] as const;

function platformSelectionCopy(platforms: ReadonlyArray<(typeof NATIVE_PLATFORM_ORDER)[number]>): string {
  if (!platforms.length) return '本期已选平台';
  return platforms.map((platform) => PLATFORM_LABELS[platform]).join('、');
}

function PublicationProofPathDetails({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <TechnicalDetails summary="添加本地凭证（高级）" className="rounded-none xl:col-span-full">
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">本地凭证文件路径（可选）</span>
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="materials/publish-proof/...png" className="h-10 w-full border border-[rgba(28,28,30,0.14)] px-3 font-mono text-[12px] outline-none focus:border-[#E85D4C]" />
      </label>
    </TechnicalDetails>
  );
}

function statusMeta(job: PublicationJob) {
  if (job.delivery_kind === 'execution_package') {
    if (job.status === 'draft_filled') {
      return { label: PRODUCTION_STATUS_DISPLAY_NAMES.completed, className: 'bg-[#EDF8F0] text-[#16803C]' };
    }
    if (job.status === 'published_confirmed') {
      return { label: PRODUCTION_STATUS_DISPLAY_NAMES.failed, className: 'bg-[#FFF1EE] text-[#B43C2E]' };
    }
  }
  return STATUS_META[job.status] || STATUS_META.pending;
}

export default function PublicationDeskPage() {
  const [runId, setRunId] = useState('');
  const [packagePath, setPackagePath] = useState('');
  const [deliverablesPath, setDeliverablesPath] = useState('');
  const [visualManifestPath, setVisualManifestPath] = useState('');
  const [queuePath, setQueuePath] = useState('');
  const [queue, setQueue] = useState<PublicationQueue | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'execute' | 'retry' | 'result' | 'load' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [resultJob, setResultJob] = useState<PublicationJob | null>(null);
  const [publicationUrl, setPublicationUrl] = useState('');
  const [proofPath, setProofPath] = useState('');
  const [publishedAt, setPublishedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [humanConfirmed, setHumanConfirmed] = useState(false);
  const [unknownResolved, setUnknownResolved] = useState(false);
  const [integrity, setIntegrity] = useState<ProductionFlowIntegrity | null>(null);

  const counts = useMemo(() => {
    const all = queue?.jobs || [];
    return {
      total: all.length,
      ready: all.filter((job) => job.delivery_kind === 'draft_fill' && job.status === 'draft_filled').length,
      packagesReady: all.filter((job) => job.delivery_kind === 'execution_package' && job.status === 'draft_filled').length,
      published: all.filter((job) => job.delivery_kind === 'draft_fill' && job.status === 'published_confirmed').length,
      attention: all.filter((job) => job.status === 'manual_intervention_required' || job.status === 'unknown_completion').length,
    };
  }, [queue]);
  const queueIsCurrent = publicationQueueMatchesIntegrity(queue, integrity, queuePath);
  const primaryAction = publicationPrimaryAction(queueIsCurrent, queue ? hasCompleteDraftQueue(queue) : false);
  const selectedPlatforms = queue?.target_platforms?.length ? queue.target_platforms : integrity?.target_platforms || [];
  const targetPlatforms = NATIVE_PLATFORM_ORDER.filter((platform) => selectedPlatforms.includes(platform));
  const targetPlatformCopy = platformSelectionCopy(targetPlatforms);

  const loadQueuePath = useCallback(async (path: string, announce = true, expectedRunId?: string) => {
    if (!path.trim()) return;
    setBusy('load');
    if (announce) setNotice(null);
    try {
      const response = await fetch(`/api/publish/drafts?queuePath=${encodeURIComponent(path.trim())}`, { cache: 'no-store' });
      const data = await response.json() as { queue?: PublicationQueue; queuePath?: string; error?: string };
      if (!response.ok || !data.queue) throw new Error(data.error || '读取发布任务失败');
      if (!hasCompleteDraftQueue(data.queue)) throw new Error('当前发布任务与本期所选平台不一致。请回到“做本期内容”重新生成。');
      if (expectedRunId && data.queue.run_id !== expectedRunId) throw new Error('这份发布任务不属于当前内容任务。');
      setQueue(data.queue);
      setQueuePath(data.queuePath || path.trim());
      setRunId(data.queue.run_id);
      setPackagePath(data.queue.package_path);
      if (announce) setNotice({ tone: 'success', text: '已加载当前发布任务' });
    } catch (error) {
      setQueue(null);
      setNotice({ tone: 'error', text: displayClientError(error, '发布内容没有读取成功。请刷新后重试。') });
    } finally {
      setBusy(null);
    }
  }, []);

  const loadQueue = async () => loadQueuePath(queuePath);

  const hydrateCurrentRun = useCallback(async () => {
    setBusy('load');
    try {
      const response = await fetch('/api/production/flow', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as {
        integrity?: ProductionFlowIntegrity | null;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || '读取本期内容失败');
      if (!data.integrity) {
        setIntegrity(null);
        setRunId('');
        setPackagePath('');
        setDeliverablesPath('');
        setVisualManifestPath('');
        setQueuePath('');
        setQueue(null);
        setNotice({ tone: 'warning', text: '还没有本期内容，请先完成内容和配图确认。' });
        return;
      }
      const current = data.integrity;
      setIntegrity(current);
      setRunId(current.run_id);
      setPackagePath(current.resolved_paths.package_path);
      setDeliverablesPath(current.resolved_paths.deliverables_path);
      setVisualManifestPath(current.resolved_paths.visual_manifest_path);
      setQueuePath(current.resolved_paths.draft_queue_path);
      if (current.draft_queue.total > 0 && current.draft_queue.lineage_current === true) {
        await loadQueuePath(current.resolved_paths.draft_queue_path, false, current.run_id);
      } else {
        setQueue(null);
        if (current.draft_queue.total > 0) {
          setNotice({ tone: 'warning', text: '本期内容或配图已变化，请重新生成所选平台的发布内容。' });
        }
      }
    } catch (error) {
      setIntegrity(null);
      setQueue(null);
      setNotice({ tone: 'error', text: displayClientError(error, '本期内容没有读取成功。请刷新后重试。') });
    } finally {
      setBusy(null);
    }
  }, [loadQueuePath]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void hydrateCurrentRun(); }, 0);
    return () => window.clearTimeout(timer);
  }, [hydrateCurrentRun]);

  const prepareCurrentRun = async () => {
    if (!packagePath.trim()) return;
    setBusy('prepare');
    setNotice(null);
    try {
      const response = await fetch('/api/production/flow', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'prepare_drafts' }),
      });
      const data = await response.json().catch(() => ({})) as {
        draftQueue?: PublicationQueue;
        draftQueuePath?: string;
        error?: string;
      };
      if (!response.ok || !data.draftQueue || !data.draftQueuePath) {
        throw new Error(data.error || '整理当前任务草稿失败');
      }
      if (!hasCompleteDraftQueue(data.draftQueue)) throw new Error('生成结果与本期所选平台不一致。');
      setQueue(data.draftQueue);
      setQueuePath(data.draftQueuePath);
      setRunId(data.draftQueue.run_id);
      const generatedPlatforms = platformSelectionCopy(data.draftQueue.target_platforms || []);
      setNotice({ tone: 'success', text: `已为${generatedPlatforms}生成 ${data.draftQueue.jobs.length} 条发布内容，不会自动发布。` });
      toast.success('所选平台发布内容已生成');
      await hydrateCurrentRun();
    } catch (error) {
      const message = displayClientError(error, '所选平台发布内容没有生成成功。请重试。');
      setNotice({ tone: 'error', text: message });
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const prepareQueue = async (event: FormEvent) => {
    event.preventDefault();
    if (!packagePath.trim() || !deliverablesPath.trim()) return;
    setBusy('prepare');
    setNotice(null);
    try {
      const response = await fetch('/api/publish/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'prepare',
          runId: runId.trim() || undefined,
          packagePath: packagePath.trim(),
          deliverablesPath: deliverablesPath.trim(),
          visualManifestPath: visualManifestPath.trim() || undefined,
        }),
      });
      const data = await response.json() as { queue?: PublicationQueue; queuePath?: string; error?: string };
      if (!response.ok || !data.queue || !data.queuePath) throw new Error(data.error || '创建发布任务失败');
      if (!hasCompleteDraftQueue(data.queue)) throw new Error('生成结果与本期所选平台不一致。');
      setQueue(data.queue);
      setQueuePath(data.queuePath);
      setRunId(data.queue.run_id);
      setNotice({ tone: 'success', text: '发布内容已生成，可以继续填入平台草稿并生成文件。' });
      toast.success('发布任务已生成');
      await hydrateCurrentRun();
    } catch (error) {
      const message = displayClientError(error, '发布内容没有生成成功。请重试。');
      setNotice({ tone: 'error', text: message });
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const execute = async (action: 'execute' | 'retry', jobId?: string) => {
    if (!queuePath) return;
    if (!queueIsCurrent) {
      setNotice({ tone: 'warning', text: '这份发布任务不是本期内容的最新版本，请刷新或重新生成。' });
      return;
    }
    setBusy(action === 'retry' ? 'retry' : 'execute');
    setNotice(null);
    try {
      if (hasDesktopPublicationBridge() && queue) {
        const candidates = jobId
          ? queue.jobs.filter((job) => job.job_id === jobId)
          : queue.jobs.filter((job) => job.status === 'pending' || (action === 'retry' && job.status === 'retryable_failure'));
        let nextQueue = queue;
        let attempted = 0;
        for (const job of candidates) {
          if (job.status !== 'pending' && !(action === 'retry' && canExplicitlyRetryLocalDraft(job))) continue;
          const result = await fillDraftWithDesktopBridge({
            queuePath,
            runId: queue.run_id,
            jobId: job.job_id,
            expectedPayloadHash: job.payload_hash,
          });
          if (!result?.queue) throw new Error('没有收到发布任务的处理结果。');
          nextQueue = result.queue as PublicationQueue;
          attempted += result.attemptedJobIds?.length || 1;
          setQueue(nextQueue);
        }
        const attention = nextQueue.jobs.filter((job) => job.status === 'retryable_failure' || job.status === 'manual_intervention_required' || job.status === 'unknown_completion').length;
        setNotice({
          tone: attention ? 'warning' : 'success',
          text: attention
            ? `已处理 ${attempted} 项；失败或需要手动处理的内容仍保留在发布任务中，没有自动发送。`
            : `已准备 ${attempted} 份平台草稿或下载文件，没有自动发送。`,
        });
        return;
      }
      const response = await fetch('/api/publish/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          queuePath,
          runId: queue?.run_id,
          ...(jobId ? { jobIds: [jobId] } : {}),
        }),
      });
      const data = await response.json() as { queue?: PublicationQueue; error?: string };
      if (!response.ok || !data.queue) throw new Error(data.error || '更新发布任务失败');
      setQueue(data.queue);
      setNotice({ tone: 'success', text: action === 'retry' ? '已重试所选内容' : '已继续处理发布任务' });
    } catch (error) {
      const message = displayClientError(error, '发布内容没有准备好。请重试。');
      setNotice({ tone: 'error', text: message });
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const openResult = (job: PublicationJob) => {
    if (job.delivery_kind !== 'draft_fill') {
      setNotice({ tone: 'warning', text: '下载文件准备好后即完成，不需要确认发布，也不会记录到发布结果。' });
      return;
    }
    setResultJob(job);
    setPublicationUrl('');
    setProofPath('');
    setHumanConfirmed(false);
    setUnknownResolved(false);
  };

  const submitResult = async (event: FormEvent) => {
    event.preventDefault();
    if (!resultJob || !queuePath || !humanConfirmed || (!publicationUrl.trim() && !proofPath.trim())) return;
    if (resultJob.delivery_kind !== 'draft_fill') {
      setResultJob(null);
      setNotice({ tone: 'warning', text: '下载文件不需要记录发布结果；文件可下载就代表准备完成。' });
      return;
    }
    if (!queueIsCurrent) {
      setNotice({ tone: 'warning', text: '这份发布任务不是本期内容的最新版本，不能保存发布结果。' });
      return;
    }
    setBusy('result');
    setNotice(null);
    try {
      const response = await fetch('/api/publish/results', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queuePath,
          jobId: resultJob.job_id,
          humanConfirmed,
          ...(publicationUrl.trim() ? { publicationUrl: publicationUrl.trim() } : {}),
          ...(proofPath.trim() ? { proofPath: proofPath.trim() } : {}),
          publishedAt: new Date(publishedAt).toISOString(),
          unknownCompletionResolved: unknownResolved,
        }),
      });
      const data = await response.json() as { queue?: PublicationQueue; error?: string };
      if (!response.ok || !data.queue) throw new Error(data.error || '保存发布结果失败');
      setQueue(data.queue);
      setResultJob(null);
      setNotice({ tone: 'success', text: '发布结果已保存到本期内容。' });
      toast.success('发布结果已保存');
    } catch (error) {
      const message = displayClientError(error, '发布结果没有保存成功。请重试。');
      setNotice({ tone: 'error', text: message });
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="aifios-editorial-page mx-auto flex w-full max-w-[1480px] flex-col gap-4">
      <section className="border border-[rgba(28,28,30,0.1)] bg-white">
        <div className="flex flex-col gap-4 border-b border-[rgba(28,28,30,0.08)] px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[#E85D4C]">
              <Send size={17} />
              <span className="text-[12px] font-bold">发布</span>
            </div>
            <h1 className="mt-2 text-[21px] font-bold text-[#1A1A1A]">{PRODUCT_COPY.pages.publicationDesk.title}</h1>
          </div>
          <div className="grid grid-cols-2 border border-[rgba(28,28,30,0.1)] sm:grid-cols-5">
            {[
              ['发布内容', counts.total],
              ['草稿已填好', counts.ready],
              ['文件可下载', counts.packagesReady],
              ['已发布', counts.published],
              ['需要处理', counts.attention],
            ].map(([label, count]) => (
              <div key={label} className="min-w-[92px] border-r border-[rgba(28,28,30,0.08)] px-3 py-2 last:border-r-0">
                <p className="text-[11px] font-bold text-[#8A8178]">{label}</p>
                <p className="mt-1 text-[18px] font-bold text-[#1A1A1A]">{count}</p>
              </div>
            ))}
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

        <div data-testid="publication-current-run" className="grid gap-3 border-b border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-bold text-[#1A1A1A]">本期内容</span>
              {integrity && <span className="rounded bg-[#EEF5FF] px-2 py-1 text-[10px] font-bold text-[#2763A6]">步骤 {integrity.current_phase.number} / 7</span>}
            </div>
            <p className="mt-1 text-[11px] text-[#6B6B6B]">
              系统会为{targetPlatformCopy}分别准备原生发布内容；不会生成未选平台，也不会自动发布。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void hydrateCurrentRun()}
              disabled={busy !== null}
              className="flex h-10 items-center justify-center gap-2 border border-[rgba(28,28,30,0.14)] bg-white px-3 text-[12px] font-bold text-[#6B6B6B] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50"
            >
              {busy === 'load' ? <LoaderCircle size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              刷新本期内容
            </button>
            {primaryAction === 'prepare' ? (
              <button
                type="button"
                onClick={() => void prepareCurrentRun()}
                disabled={busy !== null || !packagePath.trim()}
                className="flex h-10 items-center justify-center gap-2 border border-[#1A1A1A] bg-[#1A1A1A] px-4 text-[12px] font-bold text-white hover:bg-[#333] disabled:opacity-50"
              >
                {busy === 'prepare' ? <LoaderCircle size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                生成所选平台发布内容
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void execute('execute')}
                disabled={busy !== null}
                className="flex h-10 items-center justify-center gap-2 border border-[#E85D4C] bg-[#E85D4C] px-4 text-[12px] font-bold text-white hover:bg-[#C94A3B] disabled:opacity-50"
              >
                {busy === 'execute' ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}
                填入草稿并生成文件
              </button>
            )}
          </div>
        </div>

        <TechnicalDetails testId="publication-advanced-diagnostics" summary="手动选择文件（高级）" className="rounded-none border-x-0 border-t-0 border-b border-[rgba(28,28,30,0.08)] bg-white">
          <form onSubmit={prepareQueue} className="grid gap-3 border-t border-[rgba(28,28,30,0.08)] p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">本期内容文件</span>
            <input
              value={packagePath}
              onChange={(event) => setPackagePath(event.target.value)}
              placeholder="pipeline/package/...-package.md"
              className="h-10 w-full border border-[rgba(28,28,30,0.14)] px-3 font-mono text-[12px] outline-none focus:border-[#E85D4C]"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">平台发布内容文件</span>
            <input
              value={deliverablesPath}
              onChange={(event) => setDeliverablesPath(event.target.value)}
              placeholder="pipeline/publish-assets/...-platform-deliverables.json"
              className="h-10 w-full border border-[rgba(28,28,30,0.14)] px-3 font-mono text-[12px] outline-none focus:border-[#E85D4C]"
            />
          </label>
          <button
            type="submit"
            disabled={busy !== null || !packagePath.trim() || !deliverablesPath.trim()}
            className="flex h-10 items-center justify-center gap-2 self-end border border-[#1A1A1A] bg-[#1A1A1A] px-4 text-[12px] font-bold text-white transition-colors hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'prepare' ? <LoaderCircle size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
            生成发布任务
          </button>
          <label className="block lg:col-span-2">
            <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">已选图片文件（可选）</span>
            <input
              value={visualManifestPath}
              onChange={(event) => setVisualManifestPath(event.target.value)}
              placeholder="pipeline/visual/.../selected-assets.json"
              className="h-10 w-full border border-[rgba(28,28,30,0.14)] px-3 font-mono text-[12px] outline-none focus:border-[#E85D4C]"
            />
          </label>
          <label className="block lg:col-span-1">
            <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">任务编号（可选）</span>
            <input
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
              placeholder="当前任务"
              className="h-10 w-full border border-[rgba(28,28,30,0.14)] px-3 font-mono text-[12px] outline-none focus:border-[#E85D4C]"
            />
          </label>
          </form>

          <div className="flex flex-col gap-3 border-t border-[rgba(28,28,30,0.08)] px-4 py-3 sm:flex-row sm:items-end sm:px-6">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">已有发布任务文件</span>
            <input
              value={queuePath}
              onChange={(event) => setQueuePath(event.target.value)}
              placeholder="materials/publication/drafts/.../draft-queue.json"
              className="h-10 w-full border border-[rgba(28,28,30,0.14)] px-3 font-mono text-[12px] outline-none focus:border-[#E85D4C]"
            />
          </label>
          <button
            type="button"
            onClick={() => void loadQueue()}
            disabled={!queuePath.trim() || busy !== null}
            title="加载发布任务"
            className="flex h-10 w-10 shrink-0 items-center justify-center border border-[rgba(28,28,30,0.14)] text-[#6B6B6B] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50"
          >
            {busy === 'load' ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
          <button
            type="button"
            onClick={() => void execute('execute')}
            disabled={!queueIsCurrent || busy !== null}
            className="flex h-10 items-center justify-center gap-2 border border-[#E85D4C] bg-[#E85D4C] px-4 text-[12px] font-bold text-white hover:bg-[#C94A3B] disabled:opacity-50"
          >
            {busy === 'execute' ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}
            继续处理
          </button>
          </div>
        </TechnicalDetails>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead className="bg-[#FDF8F3] text-[11px] font-bold text-[#8A8178]">
              <tr>
                <th className="px-4 py-3 sm:px-6">平台</th>
                <th className="px-4 py-3">内容</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">草稿或文件</th>
                <th className="px-4 py-3 text-right sm:px-6">操作</th>
              </tr>
            </thead>
            <tbody>
              {!queue && (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-[13px] text-[#8A8178]">还没有本期发布内容</td></tr>
              )}
              {queue?.jobs.map((job) => {
                const status = statusMeta(job);
                const packagePath = job.payload.execution_package_path || job.payload.copy_path || job.payload.html_path;
                const canRecord = canRecordPublicationEvidence(job, job.status === 'unknown_completion');
                const errorCopy = publicationJobErrorCopy(job);
                return (
                  <tr key={job.job_id} className="border-t border-[rgba(28,28,30,0.08)]">
                    <td className="px-4 py-3 align-top sm:px-6">
                      <span className="text-[13px] font-bold text-[#1A1A1A]">{PLATFORM_LABELS[job.platform]}</span>
                      <span className="mt-1 block text-[11px] text-[#8A8178]">{job.delivery_kind === 'execution_package' ? '可下载文件' : '平台草稿'}</span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="max-w-[320px] text-[13px] font-medium text-[#1A1A1A]">{publicationJobDisplayLabel(job)}</p>
                      {errorCopy && <p className="mt-1 max-w-[360px] text-[11px] leading-[1.5] text-[#B43C2E]">{errorCopy}</p>}
                      {job.last_error && (
                        <TechnicalDetails summary="技术详情" className="mt-2 max-w-[360px] rounded-none border-[rgba(28,28,30,0.08)]">
                          <span className="font-mono text-[11px]">错误代码：{safePublicationJobErrorCode(job.last_error.code)}</span>
                        </TechnicalDetails>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top"><span className={`inline-flex h-6 items-center px-2 text-[11px] font-bold ${status.className}`}>{status.label}</span></td>
                    <td className="px-4 py-3 align-top">
                      {packagePath ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <a href={outputHref(packagePath, 'view')} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-bold text-[#2763A6] hover:underline">
                            <ExternalLink size={14} />
                            {job.delivery_kind === 'execution_package' ? '打开口播稿' : '查看发布稿'}
                          </a>
                          {job.delivery_kind === 'execution_package' && (
                            <OutputDownloadLink href={outputHref(packagePath, 'download')} className="inline-flex items-center gap-1 text-[12px] font-bold text-[#2763A6] hover:underline">
                              <FileDown size={14} />下载口播稿
                            </OutputDownloadLink>
                          )}
                        </div>
                      ) : <span className="text-[12px] text-[#8A8178]">-</span>}
                    </td>
                    <td className="px-4 py-3 text-right align-top sm:px-6">
                      <div className="inline-flex items-center gap-2">
                        {canExplicitlyRetryLocalDraft(job) && queueIsCurrent && (
                          <button
                            type="button"
                            title={job.status === 'manual_intervention_required' ? '已完成人工前置动作后重试' : '重试本项'}
                            onClick={() => {
                              if (job.status === 'manual_intervention_required' && !window.confirm(MANUAL_DRAFT_RETRY_CONFIRMATION)) return;
                              void execute('retry', job.job_id);
                            }}
                            disabled={busy !== null}
                            className="flex h-8 w-8 items-center justify-center border border-[rgba(28,28,30,0.14)] text-[#6B6B6B] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50"
                          ><RefreshCw size={14} /></button>
                        )}
                        {canRecord && queueIsCurrent && (
                          <button type="button" onClick={() => openResult(job)} disabled={busy !== null} className="flex h-8 items-center gap-1 border border-[rgba(28,28,30,0.14)] px-2 text-[11px] font-bold text-[#1A1A1A] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50"><Link2 size={13} />发布结果</button>
                        )}
                        {job.delivery_kind === 'draft_fill' && job.status === 'published_confirmed' && <CheckCircle2 size={17} className="text-[#16803C]" aria-label="已确认发布" />}
                        {job.delivery_kind === 'execution_package' && job.status === 'draft_filled' && <CheckCircle2 size={17} className="text-[#16803C]" aria-label="文件可下载" />}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {resultJob?.delivery_kind === 'draft_fill' && (
        <section className="border border-[rgba(28,28,30,0.14)] bg-white p-4 sm:p-6" aria-label="保存发布结果">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[12px] font-bold text-[#E85D4C]">发布结果</p>
              <h2 className="mt-1 text-[17px] font-bold text-[#1A1A1A]">{publicationJobDisplayLabel(resultJob)}</h2>
            </div>
            <button type="button" onClick={() => setResultJob(null)} className="text-[12px] font-bold text-[#6B6B6B] hover:text-[#1A1A1A]">关闭</button>
          </div>
          <form onSubmit={submitResult} className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px_auto_auto] xl:items-end">
            <label>
              <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">发布链接</span>
              <input value={publicationUrl} onChange={(event) => setPublicationUrl(event.target.value)} placeholder="https://..." className="h-10 w-full border border-[rgba(28,28,30,0.14)] px-3 text-[13px] outline-none focus:border-[#E85D4C]" />
            </label>
            <label>
              <span className="mb-1.5 block text-[12px] font-bold text-[#6B6B6B]">发布时间</span>
              <input type="datetime-local" value={publishedAt} onChange={(event) => setPublishedAt(event.target.value)} className="h-10 w-full border border-[rgba(28,28,30,0.14)] px-3 text-[13px] outline-none focus:border-[#E85D4C]" />
            </label>
            <label className="flex h-10 items-center gap-2 whitespace-nowrap text-[12px] text-[#6B6B6B]">
              <input type="checkbox" checked={humanConfirmed} onChange={(event) => setHumanConfirmed(event.target.checked)} className="h-4 w-4 accent-[#E85D4C]" />
              <span>已在平台发送</span>
            </label>
            <button type="submit" disabled={busy !== null || !humanConfirmed || (!publicationUrl.trim() && !proofPath.trim()) || (resultJob.status === 'unknown_completion' && !unknownResolved)} className="flex h-10 items-center justify-center gap-2 border border-[#1A1A1A] bg-[#1A1A1A] px-4 text-[12px] font-bold text-white hover:bg-[#333] disabled:opacity-50">
              {busy === 'result' ? <LoaderCircle size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
              确认已发送
            </button>
            <PublicationProofPathDetails value={proofPath} onChange={setProofPath} />
          </form>
          {resultJob.status === 'unknown_completion' && (
            <label className="mt-4 flex items-center gap-2 text-[12px] text-[#6B6B6B]">
              <input type="checkbox" checked={unknownResolved} onChange={(event) => setUnknownResolved(event.target.checked)} className="h-4 w-4 accent-[#E85D4C]" />
              <span>已在平台内人工核实本项状态</span>
            </label>
          )}
        </section>
      )}
    </div>
  );
}

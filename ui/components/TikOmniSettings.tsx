'use client';

import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  DatabaseZap,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Wifi,
} from 'lucide-react';
import { toast } from 'sonner';
import { displayClientError } from '@/lib/client-error-copy';
import { MACOS_KEYCHAIN_EXPLANATION, platformDisplayName } from '@/lib/product-copy';
import { ResearchActivityStatus } from './ResearchActivityStatus';
import { serviceRecordStatus } from '@/lib/service-status-copy';

type PlatformId = 'wechat_mp' | 'xiaohongshu' | 'wechat_channels';
type PlatformCheck = 'available' | 'unavailable' | 'unknown';

type TikOmniSettingsStatus = {
  credential: {
    configured: boolean;
    source: 'process' | 'env_file' | 'missing';
    localFileConfigured: boolean;
    endpointConfigured: boolean;
  };
  runtime: {
    providerEnabled: boolean;
    socialMediaCrawlInstalled: boolean;
  };
  wechatPublicAccount: {
    configured: boolean;
    source: 'project_config' | 'process_env' | 'missing';
    configValid: boolean;
    requiredForKeywordSearch: false;
    mode: 'optional_account_tracking';
  };
  platforms: Array<{
    id: PlatformId;
    label: string;
    detail: string;
  }>;
  setup: {
    status: 'blocked' | 'ready_to_test';
    blockers: string[];
  };
  recentCollection: {
    lastAttemptAt: string | null;
    lastAttemptWeek: string | null;
    lastStatus: string | null;
    lastSuccessWeek: string | null;
    snapshotAvailable: boolean;
    collectedAt: string | null;
    sampleCount: number | null;
    platformChecks: Record<PlatformId, PlatformCheck>;
  };
};

type CollectionResult = {
  tone: 'success' | 'error';
  title: string;
  detail: string;
};

function formatTime(value: string | null): string {
  if (!value) return '尚未记录';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function credentialSourceLabel(status: TikOmniSettingsStatus['credential']): string {
  if (!status.configured) return '未配置';
  if (status.source === 'process') return '当前本机服务环境';
  return '本机环境文件';
}

function wechatSourceLabel(status: TikOmniSettingsStatus['wechatPublicAccount']): string {
  if (!status.configured) return '未启用（不影响关键词检索）';
  return status.source === 'project_config' ? '本期项目设置' : '当前本机服务环境';
}

function statusMeta(status: PlatformCheck) {
  if (status === 'available') return { label: '有存档数据', className: 'bg-[#EDF8F0] text-[#16803C]' };
  if (status === 'unavailable') return { label: '当时未取得数据', className: 'bg-[#FFF2EF] text-[#C94A3B]' };
  return { label: '未记录', className: 'bg-[#F5EDE4] text-[#6B5543]' };
}

function displayResearchMessage(value: unknown, fallback: string): string {
  return displayClientError(value, fallback);
}

function sourceLabel(id: PlatformId, fallback: string): string {
  return platformDisplayName(id, fallback);
}

function blockersFromPayload(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.blockers)) return [];
  return payload.blockers
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const row = item as Record<string, unknown>;
      return displayResearchMessage(
        { message: row.message, code: row.code },
        '平台数据暂时不可用。请稍后重试。',
      );
    })
    .filter(Boolean);
}

export function TikOmniSettings() {
  const [status, setStatus] = useState<TikOmniSettingsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'token' | 'ghid' | 'remove' | null>(null);
  const [testing, setTesting] = useState(false);
  const [token, setToken] = useState('');
  const [ghid, setGhid] = useState('');
  const [desktopCredentialVault, setDesktopCredentialVault] = useState(false);
  const [desktopCredentialConfigured, setDesktopCredentialConfigured] = useState(false);
  const [collectionResult, setCollectionResult] = useState<CollectionResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const credentialBridge = typeof window !== 'undefined' ? window.aifiosCredentials : undefined;
      setDesktopCredentialVault(Boolean(credentialBridge));
      const [response, credentialStatuses] = await Promise.all([
        fetch('/api/settings/tikomni', { cache: 'no-store' }),
        credentialBridge ? credentialBridge.status() : Promise.resolve([]),
      ]);
      const payload = await response.json().catch(() => ({})) as TikOmniSettingsStatus & { error?: string; code?: string };
      if (!response.ok) throw payload;
      setStatus(payload);
      setStatusRevision((value) => value + 1);
      setDesktopCredentialConfigured(
        credentialStatuses.some((item) => item.id === 'tikomni' && item.configured),
      );
    } catch (error) {
      setLoadError(displayResearchMessage(error, '读取平台数据设置失败。请重试。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const saveSettings = async (
    kind: 'token' | 'ghid' | 'remove',
    body: Record<string, unknown>,
  ) => {
    setSaving(kind);
    try {
      const credentialBridge = typeof window !== 'undefined' ? window.aifiosCredentials : undefined;
      if (credentialBridge && kind === 'token') {
        await credentialBridge.save('tikomni', String(body.token || ''));
        setDesktopCredentialConfigured(true);
      } else if (credentialBridge && kind === 'remove') {
        await credentialBridge.delete('tikomni');
        setDesktopCredentialConfigured(false);
      }
      const response = await fetch('/api/settings/tikomni', {
        ...(credentialBridge && (kind === 'token' || kind === 'remove')
          ? { cache: 'no-store' as const }
          : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
      });
      const payload = await response.json().catch(() => ({})) as TikOmniSettingsStatus & { status?: TikOmniSettingsStatus; error?: string; code?: string };
      const nextStatus = credentialBridge && (kind === 'token' || kind === 'remove') ? payload : payload.status;
      if (!response.ok || !nextStatus) throw payload;
      setStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      const message = displayResearchMessage(error, '保存平台数据设置失败。请重试。');
      toast.error(message);
      return null;
    } finally {
      setSaving(null);
    }
  };

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) {
      toast.error('请填写平台数据密钥');
      return;
    }
    void saveSettings('token', { action: 'save_token', token: token.trim() }).then((next) => {
      if (!next) return;
      setToken('');
      toast.success(window.aifiosCredentials ? '平台数据密钥已保存到 macOS 钥匙串' : '平台数据密钥已保存到本机设置');
    });
  };

  const submitGhid = (event: FormEvent) => {
    event.preventDefault();
    if (!ghid.trim()) {
      toast.error('请填写需要定向追踪的公众号 GHID');
      return;
    }
    void saveSettings('ghid', { action: 'save_wechat_ghid', ghid: ghid.trim() }).then((next) => {
      if (!next) return;
      setGhid('');
      toast.success('定向公众号 GHID 已保存到当前项目');
    });
  };

  const removeToken = () => {
    void saveSettings('remove', { action: 'remove_token' }).then((next) => {
      if (!next) return;
      toast.success(window.aifiosCredentials ? '已从 macOS 钥匙串移除平台数据密钥' : '已从本机设置移除平台数据密钥');
    });
  };

  const collectWeekly = async () => {
    setTesting(true);
    setCollectionResult(null);
    try {
      const response = await fetch('/api/research/weekly-market', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      const blocked = !response.ok || !['ready', 'already_collected'].includes(String(payload.status)) || payload.ok !== true;
      if (blocked) {
        const details = blockersFromPayload(payload);
        const detail = details[0] || displayResearchMessage(payload, '周度参考没有更新完成。请检查配置与网络；本期已有研究仍单独保留。');
        setCollectionResult({
          tone: 'error',
          title: '本次周度更新未完成',
          detail,
        });
        toast.error('周度参考更新未完成');
      } else {
        const sampleCount = typeof payload.sample_count === 'number' ? `已读取 ${payload.sample_count} 条公开内容。` : '已更新本周平台数据。';
        setCollectionResult({
          tone: 'success',
          title: '本周参考已更新',
          detail: `${sampleCount} 这是周度参考；本期内容仍使用自己的研究存档。`,
        });
        toast.success('周度参考已更新');
      }
    } catch (error) {
      const message = displayResearchMessage(error, '周度参考没有更新完成。请检查网络与配置后再试，本期研究不受此状态影响。');
      setCollectionResult({ tone: 'error', title: '本次周度更新未完成', detail: message });
      toast.error(message);
    } finally {
      setTesting(false);
      void refresh();
    }
  };

  const setupLabel = useMemo(() => {
    if (!status) return { label: '读取配置中', className: 'bg-[#F5EDE4] text-[#6B5543]' };
    return status.setup.status === 'ready_to_test'
      ? { label: '配置齐全', className: 'bg-[#EDF8F0] text-[#16803C]' }
      : { label: '配置待补全', className: 'bg-[#FFF8E8] text-[#A66300]' };
  }, [status]);

  const inputClass = 'h-11 w-full border border-[rgba(28,28,30,0.14)] bg-white px-3.5 text-[13px] text-[#1A1A1A] outline-none placeholder:text-[#8D968D] focus:border-[#52790C] focus:ring-2 focus:ring-[#ADF13E]/20';
  const actionClass = 'inline-flex h-10 shrink-0 items-center justify-center gap-2 border border-[rgba(28,28,30,0.14)] bg-white px-3.5 text-[12px] font-bold text-[#1A1A1A] transition hover:border-[#52790C] hover:bg-[#F7FAF4] hover:text-[#3B5E06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#52790C]/25 disabled:cursor-not-allowed disabled:opacity-50';
  const destructiveActionClass = 'inline-flex h-10 shrink-0 items-center justify-center gap-2 border border-[#E7C9C0] bg-[#FFF9F7] px-3.5 text-[12px] font-bold text-[#934A39] transition hover:border-[#C88776] hover:bg-[#FFF2EE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#934A39]/20 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <section className="aifios-settings-section border border-[rgba(28,28,30,0.1)] bg-white">
      <div className="aifios-settings-section__header flex flex-col gap-4 border-b border-[rgba(28,28,30,0.08)] px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center bg-[#FDF3F0] text-[#E85D4C]">
            <DatabaseZap size={17} />
          </span>
          <div>
            <h2 className="text-[17px] font-bold text-[#1A1A1A]">平台数据服务</h2>
            <p className="mt-1 max-w-[720px] text-[12px] leading-[1.6] text-[#6B6B6B]">分别显示配置、本期研究与周度参考。刷新只读取本机记录，不会重新采集或显示密钥。</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`inline-flex h-6 items-center px-2 text-[10px] font-bold ${setupLabel.className}`}>{setupLabel.label}</span>
          <button type="button" onClick={() => void refresh()} disabled={loading || saving !== null || testing} aria-label="刷新选题数据设置" title="刷新选题数据设置" className="flex h-10 w-10 items-center justify-center border border-[rgba(28,28,30,0.14)] text-[#6B6B6B] transition hover:border-[#52790C] hover:bg-[#F7FAF4] hover:text-[#3B5E06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#52790C]/25 disabled:opacity-50">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="m-4 flex items-start gap-2 border border-[#F1C7BE] bg-[#FFF7F5] p-3 text-[12px] leading-[1.6] text-[#8A4A3E]">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      ) : null}

      <div className="aifios-settings-grid grid gap-4 bg-[#F7F9F5] p-5 xl:grid-cols-2">
        <form onSubmit={submitToken} className="aifios-settings-card flex h-full flex-col gap-3 bg-white p-5 shadow-[0_12px_32px_rgba(31,61,37,0.04)]">
          <SettingsCardHeader icon={<KeyRound size={15} />} title="平台数据密钥" state={status?.credential.configured ? '已配置' : '未配置'} ready={Boolean(status?.credential.configured)} />
          <p className="text-[12px] leading-[1.55] text-[#6B6B6B]">保存位置：{desktopCredentialConfigured ? 'macOS 钥匙串' : status ? credentialSourceLabel(status.credential) : '读取中'}。密钥内容不会在页面显示。{status?.credential.endpointConfigured ? '当前使用自定义服务地址。' : '当前使用默认服务地址。'}</p>
          {desktopCredentialVault ? (
            <p className="text-[11px] leading-[1.55] text-[#7A716A]">{MACOS_KEYCHAIN_EXPLANATION}</p>
          ) : null}
          <label>
            <span className="mb-1 block text-[11px] font-bold text-[#6B6B6B]">平台数据密钥</span>
            <input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="new-password" placeholder="输入新密钥" className={inputClass} disabled={saving !== null} />
          </label>
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={saving !== null || !token.trim()} className={actionClass}>{saving === 'token' ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}保存密钥</button>
            {(desktopCredentialConfigured || status?.credential.localFileConfigured) ? <button type="button" onClick={removeToken} disabled={saving !== null} className={destructiveActionClass}>{saving === 'remove' ? <Loader2 size={13} className="animate-spin" /> : <EyeOff size={13} />}移除密钥</button> : null}
          </div>
        </form>

        <form onSubmit={submitGhid} className="aifios-settings-card flex h-full flex-col gap-3 bg-white p-5 shadow-[0_12px_32px_rgba(31,61,37,0.04)]">
          <SettingsCardHeader icon={<Wifi size={15} />} title="定向公众号追踪（可选）" state={status?.wechatPublicAccount.configured ? '已配置' : '未启用'} ready={Boolean(status?.wechatPublicAccount.configured)} />
          <p className="text-[12px] leading-[1.55] text-[#6B6B6B]">查找公众号热门选题不需要 GHID。只有想长期跟踪某个公众号时，才需要填写该账号的 GHID。</p>
          <p className="text-[11px] leading-[1.5] text-[#7C857C]">当前状态：{status ? wechatSourceLabel(status.wechatPublicAccount) : '读取中'}。</p>
          <label>
            <span className="mb-1 block text-[11px] font-bold text-[#6B6B6B]">指定公众号 GHID（可选）</span>
            <input value={ghid} onChange={(event) => setGhid(event.target.value)} autoComplete="off" placeholder="仅在定向追踪单个公众号时填写" className={inputClass} disabled={saving !== null} />
          </label>
          <div className="mt-auto pt-1"><button type="submit" disabled={saving !== null || !ghid.trim()} className={actionClass}>{saving === 'ghid' ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}保存定向账号</button></div>
        </form>
      </div>

      <ResearchActivityStatus refreshKey={statusRevision} />

      <div className="border-t border-[rgba(28,28,30,0.08)] px-5 py-5">
        <div className="mb-3 flex items-center gap-2">
          <ShieldAlert size={16} className="text-[#E85D4C]" />
          <div>
            <h3 className="text-[14px] font-bold text-[#1A1A1A]">最近保存的周度样本</h3>
            <p className="mt-0.5 text-[12px] text-[#6B6B6B]">只反映下方采集时间的周度存档，不代表当前连接或本期研究状态。</p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {(status?.platforms || []).map((platform) => {
            const recent = status?.recentCollection.platformChecks[platform.id] || 'unknown';
            const meta = statusMeta(recent);
            return (
              <div key={platform.id} className="min-w-0 bg-[#F7F9F5] p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[13px] font-bold text-[#1A1A1A]">{sourceLabel(platform.id, platform.label)}</span>
                  <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-bold ${meta.className}`}>{meta.label}</span>
                </div>
                <p className="mt-2 text-[12px] leading-[1.55] text-[#6B6B6B]">{status?.recentCollection.collectedAt ? `存档采集于 ${formatTime(status.recentCollection.collectedAt)}` : '尚无该平台的周度采集时间。'}</p>
              </div>
            );
          })}
        </div>
        {status?.setup.blockers.length ? (
          <div className="mt-3 border border-[#F1C7BE] bg-[#FFF7F5] p-3 text-[12px] leading-[1.65] text-[#8A4A3E]">
            <p className="font-bold">开始新的采集前，需要补全配置</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {status.setup.blockers.map((blocker, index) => (
                <li key={`${index}:${blocker}`}>{displayResearchMessage(blocker, '平台数据设置还不完整。请检查密钥后重试。')}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="border-t border-[rgba(28,28,30,0.08)] px-5 py-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-[14px] font-bold text-[#1A1A1A]">周度参考更新（可选）</h3>
            <p className="mt-1 text-[12px] leading-[1.55] text-[#6B6B6B]">这会重新采集三平台参考内容，可能产生数据服务费用。它不是简单的连接测试，也不会替换本期研究。</p>
          </div>
          <button type="button" onClick={() => void collectWeekly()} disabled={testing || saving !== null || loading || status?.setup.status !== 'ready_to_test'} className="inline-flex h-10 min-w-[152px] shrink-0 items-center justify-center gap-2 bg-[#1C1C1E] px-4 text-[12px] font-bold text-white transition hover:bg-[#2B2B2E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1C1C1E]/25 disabled:cursor-not-allowed disabled:bg-[#CFCFCF]">
            {testing ? <Loader2 size={13} className="animate-spin" /> : collectionResult?.tone === 'error' ? <RotateCcw size={13} /> : <Wifi size={13} />}
            {testing ? '正在更新周度参考' : '重新采集本周参考'}
          </button>
        </div>

        {collectionResult ? (
          <div className={`mt-3 flex items-start gap-2 border p-3 text-[12px] leading-[1.6] ${collectionResult.tone === 'success' ? 'border-[#BFE3C8] bg-[#F3FBF5] text-[#256B37]' : 'border-[#F1C7BE] bg-[#FFF7F5] text-[#8A4A3E]'}`}>
            {collectionResult.tone === 'success' ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> : <AlertCircle size={15} className="mt-0.5 shrink-0" />}
            <div><p className="font-bold">{collectionResult.title}</p><p className="mt-1">{collectionResult.detail}</p></div>
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatCell label="最近一次周度尝试" value={formatTime(status?.recentCollection.lastAttemptAt || null)} detail={serviceRecordStatus(status?.recentCollection.lastStatus)} />
          <StatCell label="上次成功的周" value={status?.recentCollection.lastSuccessWeek || '尚未成功'} detail={status?.recentCollection.snapshotAvailable ? '已保存本地数据' : '还没有本地数据'} />
          <StatCell label="最近保存的周度样本" value={typeof status?.recentCollection.sampleCount === 'number' ? `${status.recentCollection.sampleCount} 条` : '数量未记录'} detail={status?.recentCollection.collectedAt ? `采集于 ${formatTime(status.recentCollection.collectedAt)}` : '尚无可读取的周度存档'} />
        </div>
      </div>
    </section>
  );
}

function SettingsCardHeader({ icon, title, state, ready }: { icon: ReactNode; title: string; state: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[#E85D4C]">{icon}</span>
        <span className="text-[13px] font-bold text-[#1A1A1A]">{title}</span>
      </div>
      <span className={`inline-flex h-5 items-center px-1.5 text-[10px] font-bold ${ready ? 'bg-[#EDF8F0] text-[#16803C]' : 'bg-[#F5EDE4] text-[#6B5543]'}`}>{state}</span>
    </div>
  );
}

function StatCell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-[#F7F9F5] p-4">
      <p className="text-[10px] font-bold text-[#8A8178]">{label}</p>
      <p title={value} className="mt-1 line-clamp-2 text-[14px] font-bold leading-[1.45] text-[#1A1A1A]">{value}</p>
      <p title={detail} className="mt-1 line-clamp-2 text-[11px] leading-[1.5] text-[#6B6B6B]">{detail}</p>
    </div>
  );
}

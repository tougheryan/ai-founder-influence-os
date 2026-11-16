'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, KeyRound, Loader2, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { displayClientError } from '@/lib/client-error-copy';
import type { LLMConfig } from '@/lib/types';

type HostedStatus = {
  connected: boolean;
  account?: { label?: string; sessionExpiresAt?: string };
  quota?: { limit: number; used: number; remaining: number };
  message?: string;
};

function formatDate(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function HostedAccessPanel({
  config,
  onConfigChanged,
}: {
  config: LLMConfig;
  onConfigChanged: (config: LLMConfig) => void;
}) {
  const [inviteCode, setInviteCode] = useState('');
  const [status, setStatus] = useState<HostedStatus>({ connected: Boolean(config.gatewayConnected) });
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/config/hosted/status', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as HostedStatus;
      if (!response.ok) throw payload;
      setStatus({
        ...payload,
        ...(payload.message
          ? { message: displayClientError(payload.message, '账户状态没有读取成功。请刷新后重试。') }
          : {}),
      });
    } catch (error) {
      setStatus({
        connected: false,
        message: displayClientError(error, '账户状态没有读取成功。请刷新后重试。'),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshStatus]);

  const reloadConfig = useCallback(async () => {
    const response = await fetch('/api/config', { cache: 'no-store' });
    const payload = await response.json().catch(() => null) as { config?: LLMConfig } | null;
    if (payload?.config) onConfigChanged(payload.config);
  }, [onConfigChanged]);

  const activate = async () => {
    if (!inviteCode.trim()) {
      toast.error('请输入授权码');
      return;
    }
    setActivating(true);
    try {
      const response = await fetch('/api/config/hosted/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode }),
      });
      const payload = await response.json().catch(() => ({})) as HostedStatus & { error?: string; code?: string };
      if (!response.ok || !payload.connected) throw payload;
      setInviteCode('');
      setStatus(payload);
      await reloadConfig();
      toast.success('授权码已激活');
    } catch (error) {
      toast.error(displayClientError(error, '设备没有激活成功。请检查授权码后重试。'));
    } finally {
      setActivating(false);
    }
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const response = await fetch('/api/config/hosted/deactivate', { method: 'POST' });
      const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
      if (!response.ok) throw payload;
      setStatus({ connected: false });
      await reloadConfig();
      toast.success('已退出当前设备');
    } catch (error) {
      toast.error(displayClientError(error, '当前设备没有退出成功。请重试。'));
    } finally {
      setDisconnecting(false);
    }
  };

  const quota = status.quota;
  return (
    <div className="mx-auto w-full max-w-[880px] space-y-5">
      <header className="border-b border-[rgba(28,28,30,0.12)] pb-5">
        <p className="text-[13px] font-semibold text-[#9A9A9A]">授权</p>
        <div className="mt-2 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center bg-[#FDF3F0] text-[#E85D4C]">
            <ShieldCheck size={21} />
          </span>
          <div>
            <h1 className="text-[25px] font-bold leading-tight text-[#1A1A1A]">激活此设备</h1>
            <p className="mt-1 text-[14px] leading-[1.6] text-[#6B6B6B]">输入购买后获得的唯一授权码。授权码只可绑定一台设备。</p>
          </div>
        </div>
      </header>

      {status.connected ? (
        <section className="border border-[rgba(22,128,60,0.2)] bg-[#F8FBF6] p-5" aria-label="账户状态">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <CheckCircle2 size={21} className="mt-0.5 shrink-0 text-[#16803C]" />
              <div>
                <p className="text-[17px] font-bold text-[#1A1A1A]">已连接</p>
                <p className="mt-1 text-[13px] text-[#5B6B5F]">{status.account?.label || '内测用户'} · 有效至 {formatDate(status.account?.sessionExpiresAt)}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={disconnecting}
              title="退出当前设备"
              aria-label="退出当前设备"
              className="inline-flex h-9 w-9 items-center justify-center border border-[rgba(28,28,30,0.12)] bg-white text-[#6B6B6B] transition hover:border-[#E85D4C] hover:text-[#E85D4C] disabled:opacity-50"
            >
              {disconnecting ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}
            </button>
          </div>

          <div className="mt-5 grid grid-cols-3 border border-[rgba(22,128,60,0.16)] bg-white">
            <div className="min-w-0 border-r border-[rgba(22,128,60,0.16)] px-4 py-3">
              <p className="text-[11px] font-semibold text-[#778078]">可用次数</p>
              <p className="mt-1 text-[22px] font-bold text-[#1A1A1A]">{quota?.remaining ?? '-'}</p>
            </div>
            <div className="min-w-0 border-r border-[rgba(22,128,60,0.16)] px-4 py-3">
              <p className="text-[11px] font-semibold text-[#778078]">已使用</p>
              <p className="mt-1 text-[22px] font-bold text-[#1A1A1A]">{quota?.used ?? '-'}</p>
            </div>
            <div className="min-w-0 px-4 py-3">
              <p className="text-[11px] font-semibold text-[#778078]">总额度</p>
              <p className="mt-1 text-[22px] font-bold text-[#1A1A1A]">{quota?.limit ?? '-'}</p>
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <a
              href="/production?stage=1"
              className="inline-flex h-9 items-center gap-2 bg-[#1C1C1E] px-3 text-[13px] font-bold text-white transition hover:bg-[#2B2B2E]"
            >
              进入工作台
              <ArrowRight size={15} />
            </a>
          </div>
        </section>
      ) : (
        <section className="border border-[rgba(28,28,30,0.12)] bg-white p-5" aria-label="设备授权激活">
          <div className="flex items-start gap-3">
            <KeyRound size={20} className="mt-0.5 shrink-0 text-[#E85D4C]" />
            <div>
              <h2 className="text-[18px] font-bold text-[#1A1A1A]">输入授权码</h2>
              <p className="mt-1 text-[13px] leading-[1.6] text-[#6B6B6B]">授权码由购买渠道或管理员发放，首次激活后会绑定当前设备。</p>
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row">
            <input
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void activate();
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="AIF-授权码"
              className="h-10 min-w-0 flex-1 border border-[rgba(28,28,30,0.15)] px-3 font-mono text-[14px] outline-none transition focus:border-[#E85D4C]"
            />
            <button
              type="button"
              onClick={() => void activate()}
              disabled={activating}
              className="inline-flex h-10 items-center justify-center gap-2 bg-[#E85D4C] px-4 text-[13px] font-bold text-white transition hover:bg-[#D84F40] disabled:opacity-50"
            >
              {activating ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}
              激活设备
            </button>
          </div>
          {status.message ? <p className="mt-3 text-[12px] text-[#9A4B40]">{displayClientError(status.message, '设备没有激活成功。请检查授权码后重试。')}</p> : null}
        </section>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={loading}
          title="刷新账户状态"
          aria-label="刷新账户状态"
          className="inline-flex h-9 w-9 items-center justify-center border border-[rgba(28,28,30,0.12)] text-[#6B6B6B] transition hover:border-[#E85D4C] hover:text-[#E85D4C] disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
    </div>
  );
}

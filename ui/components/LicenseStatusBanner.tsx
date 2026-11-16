'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { displayClientError } from '@/lib/client-error-copy';
import type { LLMConfig } from '@/lib/types';

function formatDate(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function LicenseStatusBanner({
  config,
  onDeactivated,
}: {
  config: LLMConfig;
  onDeactivated: () => void;
}) {
  const [disconnecting, setDisconnecting] = useState(false);

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      const response = await fetch('/api/config/hosted/deactivate', { method: 'POST' });
      const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
      if (!response.ok) throw payload;
      toast.success('已退出当前设备');
      onDeactivated();
    } catch (error) {
      toast.error(displayClientError(error, '当前设备没有退出成功。请重试。'));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <section
      className="flex items-center justify-between gap-4 border border-[rgba(22,128,60,0.2)] bg-[#F8FBF6] p-4"
      aria-label="设备授权状态"
    >
      <div className="flex min-w-0 items-center gap-3">
        <CheckCircle2 size={20} className="shrink-0 text-[#16803C]" />
        <div className="min-w-0">
          <p className="text-[15px] font-bold text-[#1A1A1A]">设备已激活</p>
          <p className="mt-0.5 truncate text-[13px] text-[#5B6B5F]">
            {config.gatewayAccountLabel || '已授权用户'}
            {config.gatewaySessionExpiresAt ? ` · 有效至 ${formatDate(config.gatewaySessionExpiresAt)}` : ''}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void disconnect()}
        disabled={disconnecting}
        title="退出当前设备"
        aria-label="退出当前设备"
        className="inline-flex h-9 shrink-0 items-center gap-2 border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[13px] font-semibold text-[#6B6B6B] transition hover:border-[#E85D4C] hover:text-[#E85D4C] disabled:opacity-50"
      >
        {disconnecting ? <Loader2 size={15} className="animate-spin" /> : <LogOut size={15} />}
        退出
      </button>
    </section>
  );
}

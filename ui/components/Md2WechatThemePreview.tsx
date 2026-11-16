'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ExternalLink, Pin, RefreshCw, X } from 'lucide-react';
import type { BrandTemplate } from '@/lib/brand-templates';
import {
  fetchMd2WechatPreview,
  getCachedMd2WechatPreview,
  md2WechatPreviewCacheKey,
} from '@/lib/md2wechat-preview-client';

type PreviewProps = {
  theme: BrandTemplate;
  onClose?: () => void;
  onSelect?: () => void;
  onSetDefault?: () => void;
  selected?: boolean;
  isDefault?: boolean;
  compact?: boolean;
  className?: string;
};

export function Md2WechatThemePreview(props: PreviewProps) {
  return <ThemePreviewContent key={md2WechatPreviewCacheKey(props.theme)} {...props} />;
}

function ThemePreviewContent({
  theme,
  onClose,
  onSelect,
  onSetDefault,
  selected = false,
  isDefault = false,
  compact = false,
  className = 'mt-4',
}: PreviewProps) {
  const headingId = useId();
  const [html, setHtml] = useState(() => getCachedMd2WechatPreview(theme)?.html || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function refreshPreview() {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError('');
    try {
      const payload = await fetchMd2WechatPreview(theme, { force: Boolean(html), confirmExternalCall: true });
      if (mounted.current) setHtml(payload.html);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '排版预览没有生成成功。');
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className={`${className} overflow-hidden rounded-[16px] border border-[rgba(28,28,30,0.12)] bg-[#F3F1ED] shadow-[0_18px_48px_rgba(78,68,56,0.08)]`}>
      <div className="flex flex-col gap-3 border-b border-[rgba(28,28,30,0.1)] bg-white px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ExternalLink size={14} className="shrink-0 text-[#E85D4C]" />
            <h4 id={headingId} className="truncate text-[16px] font-bold text-[#1A1A1A]">
              {theme.label} · 示例排版
            </h4>
          </div>
          {!compact && <p className="mt-1 text-[13px] leading-[1.6] text-[#5D5852]">用同一篇内置示例比较样式；这不是本期文章的最终排版。</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {onSelect && (
            <button
              type="button"
              onClick={onSelect}
              disabled={selected}
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E85D4C]/30 active:translate-y-px ${selected ? 'cursor-default bg-[#EEF4E8] text-[#52790C]' : 'bg-[#1C1C1E] text-white hover:bg-[#353535]'}`}
            >
              <Check size={13} strokeWidth={2.5} />
              {selected ? '当前已选' : '使用此主题'}
            </button>
          )}
          {onSetDefault && (
            <button
              type="button"
              onClick={onSetDefault}
              disabled={isDefault}
              className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E85D4C]/30 active:translate-y-px ${isDefault ? 'cursor-default bg-[#FFF1E8] text-[#B4532F]' : 'text-[#5D5852] hover:bg-[#F4EFEA] hover:text-[#1A1A1A]'}`}
            >
              <Pin size={12} />
              {isDefault ? '默认主题' : '设为默认'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void refreshPreview()}
            disabled={loading}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-[9px] border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[13px] font-bold text-[#5D5852] transition hover:border-[#E85D4C] hover:text-[#C94A3B] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={`${html ? '重新生成' : error ? '重试生成' : '生成'} ${theme.label} 示例预览（外部服务）`}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            {loading ? '正在生成' : html ? '重新生成预览' : error ? '重试预览' : '生成示例预览'}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 w-10 items-center justify-center rounded-[9px] text-[#706A63] transition hover:bg-[#F4EFEA] hover:text-[#1A1A1A] active:translate-y-px"
              aria-label="关闭排版预览"
              title="关闭排版预览"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      <p className="border-b border-[rgba(28,28,30,0.1)] bg-[#FFF9EC] px-4 py-3 text-[12px] leading-relaxed text-[#6B5543]">生成或重试会将内置示例发送给 md2wechat 排版服务，需该服务账号，可能计费。费用以服务方记录为准，不计入本期模型调用次数上限。浏览目录、收藏和查看已生成的示例不会再次请求排版。</p>

      <div className="p-3 sm:p-4" aria-live="polite" aria-busy={loading}>
        {error && <p role="alert" className="mb-3 rounded-lg bg-white p-4 text-[14px] leading-relaxed text-[#9B3F34]">{error}{html ? ' 上次生成的示例仍保留，可继续查看。' : ' 可检查排版服务配置，再点击上方重试。'}</p>}
        {loading && !html ? (
          <div className={`${compact ? 'min-h-[420px]' : 'min-h-[640px]'} animate-pulse rounded-[12px] bg-white px-7 py-9`} aria-label="正在生成真实主题预览">
            <div className="mx-auto h-8 w-2/3 rounded bg-[#E9E5DF]" />
            <div className="mt-10 h-5 w-1/3 rounded bg-[#EEEAE4]" />
            <div className="mt-5 space-y-3">
              <div className="h-3 rounded bg-[#F0EDE8]" />
              <div className="h-3 w-11/12 rounded bg-[#F0EDE8]" />
              <div className="h-3 w-4/5 rounded bg-[#F0EDE8]" />
            </div>
            <div className="mt-10 h-20 rounded bg-[#F4F1ED]" />
          </div>
        ) : html ? (
          <iframe
            title={`${theme.label} 公众号排版预览`}
            srcDoc={html}
            sandbox=""
            referrerPolicy="no-referrer"
            className={`${compact ? 'h-[460px]' : 'h-[640px]'} w-full rounded-[12px] border-0 bg-white`}
          />
        ) : <p className="flex min-h-[180px] items-center justify-center rounded-[12px] bg-white px-5 text-center text-sm leading-relaxed text-[#69635D]">尚未生成示例。需要看实际效果时，点击上方“生成示例预览”。</p>}
      </div>
    </section>
  );
}

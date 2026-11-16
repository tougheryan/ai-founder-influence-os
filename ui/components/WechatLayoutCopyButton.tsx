'use client';

import { useEffect, useRef, useState } from 'react';
import { Clipboard } from 'lucide-react';
import { copyWechatLayout, writeWechatLayoutClipboard } from '@/lib/wechat-layout-copy';
import { outputHref } from '@/lib/output-links';
import { displayClientError } from '@/lib/client-error-copy';
import type { VisualWorkbenchAsset } from '@/lib/visual-workbench';

type Props = { asset: VisualWorkbenchAsset };

export function WechatLayoutCopyButton({ asset }: Props) {
  if (asset.id !== 'wechat-html' || asset.platform !== 'wechat' || asset.status !== 'generated'
    || asset.quality !== 'pass' || !/\.html?$/i.test(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) return null;
  return <WechatLayoutCopyControl key={`${asset.path}:${asset.sha256}`} path={asset.path} sha256={asset.sha256!} />;
}

function WechatLayoutCopyControl({ path, sha256 }: { path: string; sha256: string }) {
  const [state, setState] = useState({ busy: false, notice: '', copied: false, fallback: false });
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  return <div className="space-y-1">
    <button type="button" disabled={state.busy} onClick={async () => {
      if (pending.current && !pending.current.signal.aborted) return;
      const controller = new AbortController();
      pending.current = controller;
      setState({ busy: true, notice: '', copied: false, fallback: false });
      try {
        const result = await copyWechatLayout(path, sha256, {
          signal: controller.signal,
          isCurrent: () => pending.current === controller,
          write: writeWechatLayoutClipboard,
        });
        if (result.status !== 'cancelled') setState({ busy: false, notice: result.notice,
          copied: result.status === 'copied', fallback: result.status !== 'copied',
        });
      } catch (error) {
        if (!controller.signal.aborted && pending.current === controller) setState({ busy: false,
          notice: displayClientError(error, '复制未完成。请打开排版预览手动复制，或下载排版文件。'), copied: false, fallback: true,
        });
      } finally {
        if (pending.current === controller) pending.current = null;
      }
    }} className="inline-flex min-h-[36px] items-center gap-[5px] rounded-[7px] border border-[rgba(28,28,30,0.12)] bg-white px-[10px] text-[12px] font-bold text-[#4F4B46] hover:border-[#568C13] hover:text-[#568C13] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#568C13] disabled:opacity-50">
      <Clipboard size={13} />{state.busy ? '正在复制排版…' : '复制排版'}
    </button>
    {state.notice && <p role="status" className={`max-w-[32rem] text-xs leading-relaxed ${state.copied ? 'text-[#16803C]' : 'text-[#9B5322]'}`}>{state.notice}</p>}
    {state.fallback && <a href={outputHref(path, 'view')} target="_blank" rel="noreferrer" className="inline-flex min-h-[32px] items-center text-xs text-[#476D13] underline">打开排版预览并核对使用说明</a>}
  </div>;
}

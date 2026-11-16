'use client';

import { useEffect, useRef, useState } from 'react';
import { Clipboard, Download, RefreshCw } from 'lucide-react';
import { OutputDownloadLink } from '@/components/OutputDownloadLink';
import { displayClientError } from '@/lib/client-error-copy';
import { readableArticleHref } from '@/lib/output-links';
import { copyReadableArticle } from '@/lib/readable-article-copy';

type Props = { path: string; sha256: string; onRefresh: () => void; refreshDisabled?: boolean };
const actionClass = 'inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[rgba(28,28,30,0.14)] bg-white px-3 text-xs font-bold text-[#4F4A45] hover:border-[#E85D4C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E85D4C] disabled:opacity-50';

export function ReadableArticleActions(props: Props) {
  return <ReadableArticleActionsControl key={`${props.path}:${props.sha256}`} {...props} />;
}

export function ReadableArticleActionsControl({ path, sha256, onRefresh, refreshDisabled }: Props) {
  const [state, setState] = useState({ busy: false, text: '', notice: '', copied: false, manual: false, error: '' });
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const available = /^[a-f0-9]{64}$/.test(sha256);
  return <div className="my-4 space-y-2" aria-label="复制和保存文章">
    <div className="flex flex-wrap items-start gap-2">
      <button type="button" disabled={!available || state.busy} className={actionClass} onClick={async () => {
        if (pending.current && !pending.current.signal.aborted) return;
        const controller = new AbortController();
        pending.current = controller;
        setState({ busy: true, text: '', notice: '', copied: false, manual: false, error: '' });
        try {
          const result = await copyReadableArticle(path, sha256, {
            signal: controller.signal,
            isCurrent: () => pending.current === controller,
            writeText: (text) => navigator.clipboard.writeText(text),
          });
          if (result.status !== 'cancelled') setState({ busy: false, text: result.text, notice: result.notice, copied: result.status === 'copied', manual: result.status === 'manual', error: '' });
        } catch (error) {
          if (!controller.signal.aborted && pending.current === controller) setState({ busy: false, text: '', notice: '', copied: false, manual: false, error: displayClientError(error, '暂时无法复制文章。请重试。') });
        } finally {
          if (pending.current === controller) pending.current = null;
        }
      }}><Clipboard size={14} />{state.busy ? '正在读取文章…' : '复制文章'}</button>
      {available && <OutputDownloadLink href={readableArticleHref(path, sha256, true)} className={actionClass} title="保存为可直接打开阅读的 HTML 草稿"><Download size={14} />保存可读稿</OutputDownloadLink>}
      <button type="button" onClick={onRefresh} disabled={refreshDisabled} className={actionClass}><RefreshCw size={14} />重新读取文章</button>
    </div>
    <p className="text-xs leading-relaxed text-[#6B6B6B]">包含标题、摘要和正文。保存为 HTML 草稿，使用前请核对。</p>
    {!available && <p role="status" className="text-xs text-[#8D5A00]">暂时无法核对文章版本，请重新读取后再复制或保存。</p>}
    {state.error && <p role="alert" className="text-xs text-[#8F3329]">{state.error}</p>}
    {state.copied && <p role="status" className="text-xs text-[#176936]">已复制文章{state.notice ? '，已附使用说明' : ''}。</p>}
    {state.notice && <p className="text-xs text-[#8D5A00]">{state.notice.split('\n')[0]}；使用说明已附在文字前。</p>}
    {state.manual && <div>
      <p role="status" className="text-xs text-[#8D5A00]">自动复制不可用。点击下方文字全选后手动复制。</p>
      <textarea aria-label="文章：手动复制" readOnly value={state.text} onFocus={(event) => event.currentTarget.select()} className="mt-2 w-full rounded-md border p-3 text-sm" rows={7} />
    </div>}
  </div>;
}

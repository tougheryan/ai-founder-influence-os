'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContentSection, ContentSelectionRequest } from '@/lib/content-editing';
import { readerSelectionRequest, readerTextRuns, type ReaderTextPoint, type ReaderTextRange } from '@/lib/reader-selection';

type Props = { path: string; sha256: string; section: ContentSection; range?: ReaderTextRange; label?: string; compact?: boolean; disabled?: boolean; onEdit: (request: ContentSelectionRequest, container?: HTMLElement) => void };

export function SelectableArticleBody(props: Props) {
  return <SelectionReader key={`${props.path}:${props.sha256}:${props.section.id}:${props.range?.start ?? ''}:${props.range?.end ?? ''}`} {...props} />;
}

function SelectionReader({ path, sha256, section, range, label, compact, disabled, onEdit }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const editorSlots = useRef<(HTMLDivElement | null)[]>([]);
  const runs = useMemo(() => readerTextRuns(section.text, range), [section.text, range]);
  const [picked, setPicked] = useState<{ request: ContentSelectionRequest; anchor: number; x: number; y: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      if (disabled || !root.current || !selection || selection.isCollapsed || selection.rangeCount !== 1) { setPicked(null); return; }
      const range = selection.getRangeAt(0);
      if (!root.current.contains(range.startContainer) || !root.current.contains(range.endContainer)) { setPicked(null); return; }
      const point = (node: Node, offset: number): ReaderTextPoint | null => {
        const element = (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>('[data-reader-run]');
        if (!element || !root.current?.contains(element)) return null;
        const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(node, offset);
        return { run: Number(element.dataset.readerRun), offset: prefix.toString().length };
      };
      const start = point(range.startContainer, range.startOffset), end = point(range.endContainer, range.endOffset);
      if (!start || !end) { setPicked(null); return; }
      try {
        const request = readerSelectionRequest({ path, sha256, section }, runs, start, end);
        const rect = range.getBoundingClientRect();
        setPicked({ request, anchor: end.run, x: Math.max(12, Math.min(rect.left, window.innerWidth - 332)), y: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 130)) });
        setError('');
      } catch (reason) { setPicked(null); setError(reason instanceof Error ? reason.message : '请重新选择正文。'); }
    };
    const clear = () => setPicked(null);
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', clear, true); window.addEventListener('resize', clear);
    return () => { document.removeEventListener('selectionchange', update); window.removeEventListener('scroll', clear, true); window.removeEventListener('resize', clear); };
  }, [disabled, path, sha256, section, runs]);
  const edit = (request: ContentSelectionRequest, anchor: number) => { if (!disabled) { onEdit(request, editorSlots.current[anchor] || undefined); setPicked(null); } };
  return <>
    {!compact && <p className="mb-3 text-xs text-[#6B6B6B]">选中文字即可修改，也可用每段旁的“修改这段”。先预览，再决定是否采用。</p>}
    <div ref={root} aria-label={`可选段修改的${label || '正文'}`} className="space-y-3 text-[14px] leading-[1.8] text-[#303030]">
      {runs.map((run, index) => <div key={index} className="group relative">
        {run.kind === 'heading' ? <h4 data-reader-run={index} className="mb-1.5 whitespace-pre-wrap text-[15px] font-bold text-[#1A1A1A]">{run.text}</h4>
          : run.kind === 'quote' ? <blockquote data-reader-run={index} className="whitespace-pre-wrap rounded-lg border-l-[3px] border-[#E85D4C] bg-[#FFF8F5] px-3 py-2.5 font-medium text-[#4F4A45]">{run.text}</blockquote>
            : <p data-reader-run={index} className="whitespace-pre-wrap">{run.text}</p>}
        <button type="button" aria-label={compact && label && runs.length === 1 ? `修改${label}` : `修改${label || ''}第 ${index + 1} 段`} disabled={disabled} className={`mt-1 rounded px-1 text-xs text-[#6B6B6B] underline opacity-100 focus-visible:outline-2 ${compact ? '' : 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100'} disabled:opacity-40`} onClick={() => {
          try { edit(readerSelectionRequest({ path, sha256, section }, runs, { run: index, offset: 0 }, { run: index, offset: run.text.length }), index); setError(''); }
          catch (reason) { setError(reason instanceof Error ? reason.message : '请重新选择正文。'); }
        }}>修改这段</button>
        <div ref={(element) => { editorSlots.current[index] = element; }} />
      </div>)}
    </div>
    {error && <p role="alert" className="mt-2 text-sm text-[#9D3327]">{error}</p>}
    {picked && !disabled && <div role="region" aria-label="修改选中的正文" className="fixed z-40 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-[#D8D1C9] bg-white p-3 shadow-lg" style={{ left: picked.x, top: picked.y }}>
      <p className="mb-2 line-clamp-2 text-xs text-[#6B6B6B]">已选：{picked.request.selection.slice(0, 100)}</p>
      <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => edit(picked.request, picked.anchor)} className="rounded-md bg-[#1C1C1E] px-3 py-2 text-sm font-semibold text-white">修改选中文字</button>
      <button type="button" onClick={() => setPicked(null)} className="ml-3 px-2 py-2 text-sm text-[#6B6B6B]">取消</button>
    </div>}
  </>;
}

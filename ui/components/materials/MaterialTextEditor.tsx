'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MaterialNatureLabels } from './MaterialNatureLabels';
import { materialSourceNature } from '@/lib/material-source-nature';
import { useRouter } from 'next/navigation';
import type { RawMaterialDetail } from '@/lib/material-library';
import { displayClientError } from '@/lib/client-error-copy';
import { materialTitleSuggestion } from '@/lib/material-title-suggestion';
import { materialWritingRequirements } from '@/lib/material-writing-requirements';

export function MaterialTextEditor({ id, onSaved, onEditingChange }: { id: string; onSaved: () => Promise<void>; onEditingChange?: (editing: boolean) => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<RawMaterialDetail | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reuseOpen, setReuseOpen] = useState(false);
  const [reuseMode, setReuseMode] = useState<'new_topic' | 'same_topic'>('new_topic');
  const [newTopic, setNewTopic] = useState('');
  const reuseRequest = useRef('');
  const receive = useCallback((value: RawMaterialDetail) => {
    setDetail(value);
    setTitle(value.item.title);
    setContent(value.content);
    setSourceLabel(value.item.sourceLineage.sourceLabel || '');
    setSourceUrl(value.item.sourceLineage.sourceUrl || '');
    setEditing(false);
    setReuseOpen(false);
    setReuseMode('new_topic');
    setNewTopic('');
    reuseRequest.current = '';
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try {
      const response = await fetch(`/api/material-library?${new URLSearchParams({ view: 'detail', id })}`, { signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '素材全文未能读取。');
      if (!signal?.aborted) receive(value);
    } catch (cause) { if (!signal?.aborted) setError(displayClientError(cause, '素材全文未能读取，请重试。')); }
  }, [id, receive]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { void load(controller.signal); }, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function act(action: 'edit' | 'reuse') {
    if (!detail || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (!reuseRequest.current) reuseRequest.current = crypto.randomUUID();
      const response = await fetch('/api/material-library', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id, expectedVersion: detail.version, requestId: reuseRequest.current, ...(action === 'edit' ? { title, content, sourceLabel, sourceUrl } : { mode: reuseMode, topic: newTopic }) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '素材未能保存。');
      if (action === 'edit') {
        receive(result);
        setNotice('已保存到个人库。原文件与已经开始的内容任务保持原版本。');
        await onSaved();
      } else router.push(result.nextUrl);
    } catch (cause) { setError(displayClientError(cause, '这次操作未完成，你填写的内容仍保留。')); }
    finally { setBusy(false); }
  }
  async function extractFile() {
    if (!detail?.item.sourceLineage.sourcePath) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/materials?action=extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: detail.item.sourceLineage.sourcePath }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '原文件暂时无法读取。');
      if (!['text_extracted', 'existing_extraction', 'audio_transcribed'].includes(result.extractionStatus) || !result.content?.trim()) {
        setNotice('文件还没有可用文字。可以稍后再次读取，或在编辑中补充文字。');
        return;
      }
      setContent(result.content); setEditing(true);
      setNotice('文字已读出，请核对后保存到个人库。');
    } catch (cause) { setError(displayClientError(cause, '原文件暂时无法读取，请重试。')); }
    finally { setBusy(false); }
  }
  const fieldClass = 'mt-1 w-full rounded border border-[#D8D2CA] bg-white p-2 text-sm leading-6 disabled:opacity-50';
  const previousTopic = detail ? materialTitleSuggestion(detail.content) : null;
  const previousRequirements = detail ? materialWritingRequirements(detail.content) : [];
  return (
    <section aria-label="素材全文" className="space-y-3 text-sm text-[#443C35]">
      {!detail && !error && <p role="status">正在读取素材全文…</p>}
      {detail && (editing ? (
        <div className="space-y-3">
          <label className="block">素材标题<input className={fieldClass} value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label>
          <label className="block">素材全文<textarea className={fieldClass} rows={12} value={content} onChange={(event) => setContent(event.target.value)} disabled={busy} /></label>
          <label className="block">来源说明<input className={fieldClass} value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} disabled={busy} /></label>
          <label className="block">原始链接<input className={fieldClass} type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} disabled={busy} /></label>
          <div className="flex gap-3"><button type="button" disabled={busy || !title.trim()} onClick={() => void act('edit')} className="rounded bg-[#1C1C1E] px-3 py-2 text-white disabled:opacity-50">保存素材修改</button><button type="button" disabled={busy} onClick={() => receive(detail)}>取消编辑</button></div>
        </div>
      ) : (
        <>
          <MaterialNatureLabels nature={materialSourceNature(detail.content)} />
          <p className="text-xs leading-5 text-[#625C56]">按原文声明提示，尚未独立核验；未标注也不表示内容真实。</p>
          <p className="font-semibold">全文</p>
          <div className="max-h-[420px] overflow-y-auto whitespace-pre-wrap break-words rounded border border-[#E5DFD7] bg-[#FCFAF7] p-4 leading-7">{detail.content || '尚未保存文字全文。可以读取原文件、打开来源链接，或补充文字。'}</div>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded border border-[#D8D2CA] px-3 py-2">编辑全文与来源</button>
            <button type="button" disabled={busy} aria-expanded={reuseOpen} onClick={() => setReuseOpen(!reuseOpen)} className="rounded bg-[#1C1C1E] px-3 py-2 text-white disabled:opacity-50">用这份素材写一篇</button>
          </div>
          {reuseOpen && <div className="space-y-3 rounded border border-[#D8D2CA] bg-[#FCFAF7] p-4">
            <fieldset disabled={busy} className="space-y-2">
              <legend className="mb-2 font-semibold">这次怎样使用素材</legend>
              <label className="flex items-start gap-2"><input type="radio" name={`reuse-${id}`} checked={reuseMode === 'new_topic'} onChange={() => { setReuseMode('new_topic'); reuseRequest.current = ''; }} className="mt-1" /><span>只用素材，写新题目</span></label>
              <label className="flex items-start gap-2"><input type="radio" name={`reuse-${id}`} checked={reuseMode === 'same_topic'} disabled={!previousTopic} onChange={() => { setReuseMode('same_topic'); reuseRequest.current = ''; }} className="mt-1" /><span>沿用上次题目和要求{!previousTopic && <span className="block text-xs">没有读到明确的原题目，请填写新题目。</span>}</span></label>
            </fieldset>
            {reuseMode === 'new_topic' ? <>
              <label className="block">这篇想写什么<input className={fieldClass} value={newTopic} maxLength={240} disabled={busy} onChange={(event) => { setNewTopic(event.target.value); reuseRequest.current = ''; }} placeholder="例如：客户临时增加需求，怎样重新确认范围" /></label>
              <p className="leading-6">旧题目、受众、字数、语气和结尾要求不带入本篇。你可以在新草稿中补充这次的要求。</p>
            </> : <>
              <p>沿用题目：{previousTopic}</p>
              <details><summary className="cursor-pointer">查看将沿用的写作要求（{previousRequirements.length} 条）</summary><ul className="mt-2 list-disc space-y-1 pl-5">{previousRequirements.map((value, index) => <li key={index}>{value}</li>)}</ul></details>
            </>}
            <p className="leading-6">两种方式都会保留原材料、来源、虚构或待核实性质，以及公开限制。打开草稿不会研究选题或生成文章。</p>
            <div className="flex flex-wrap gap-3"><button type="button" disabled={busy || (reuseMode === 'new_topic' ? !newTopic.trim() : !previousTopic)} onClick={() => void act('reuse')} className="rounded bg-[#1C1C1E] px-3 py-2 text-white disabled:opacity-50">{busy ? '正在准备草稿…' : '打开新草稿'}</button><button type="button" disabled={busy} onClick={() => setReuseOpen(false)}>取消</button></div>
          </div>}
          <p className="text-xs leading-5 text-[#81776D]">打开新草稿前会先保存工作台当前内容。{detail.content ? '本次引用单独保存，之后修改素材库不会改写这份文字。' : '本期会读取原文件或参考链接，整理后请核对读取结果。'}</p>
          {!detail.content && detail.item.sourceLineage.sourcePath?.startsWith('materials/') && <><button type="button" disabled={busy} className="underline" onClick={() => void extractFile()}>读取原文件文字</button><p className="text-xs text-[#81776D]">音频转写可能产生所选服务的费用。</p></>}
          {detail.item.sourceLineage.sourceUrl && <a href={detail.item.sourceLineage.sourceUrl} target="_blank" rel="noreferrer" className="inline-block underline">打开原始链接</a>}
        </>
      ))}
      {notice && <p role="status" className="text-[#386444]">{notice}</p>}
      {error && <div role="alert" className="text-[#A13D30]"><p>{error}</p><button type="button" disabled={busy} onClick={() => void load()} className="mt-2 underline">重新读取素材（放弃当前编辑）</button></div>}
    </section>
  );
}

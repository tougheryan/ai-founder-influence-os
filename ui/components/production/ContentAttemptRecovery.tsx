'use client';

import { OutputDownloadLink } from '@/components/OutputDownloadLink';
import { useEffect, useState } from 'react';
import type { ContentAttempt } from '@/lib/content-attempts';
import { ContentRevisionEditor } from './ContentRevisionEditor';
import { WritingRequirementsReview } from './WritingRequirementsReview';

type Attempt = Omit<ContentAttempt, 'ownerPid'>;

export function ContentAttemptRecovery({ runId, generating, disabled, refreshKey, onVersionChange, onBusyChange }: {
  runId: string; generating: boolean; disabled?: boolean; refreshKey: string;
  onVersionChange?: (path: string) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [repairId, setRepairId] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function read() {
      try {
        const response = await fetch(`/api/production/content-attempts?${new URLSearchParams({ runId })}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '暂时无法读取保留的文字。');
        if (cancelled) return;
        setAttempts(data.attempts); setError('');
        if (generating || data.attempts.some((item: Attempt) => item.status === 'generating')) timer = setTimeout(read, 2_000);
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : '暂时无法读取保留的文字。'); }
    }
    void read();
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [runId, generating, refreshKey, reload]);

  if (error) return <div role="alert" className="rounded-lg bg-[#FFF8E8] p-3 text-sm"><p>{error}</p><button type="button" className="mt-2 underline" onClick={() => setReload((value) => value + 1)}>重新读取保留的文字</button></div>;
  if (!attempts.length || attempts.every((item) => item.status === 'saved' && !item.reason)) return null;
  const selected = attempts.find((item) => item.id === selectedId) || attempts[0];
  const currentBody = selected.workingDraft?.body ?? selected.body;
  const currentIssues = selected.workingDraft?.issues ?? selected.issues;
  const path = `runs/${runId}/content-attempts/${selected.id}.json`;
  const download = `/api/production/content-attempts?${new URLSearchParams({ runId, id: selected.id, download: '1', ...(selected.workingDraft ? { working: '1' } : {}) })}`;
  return <section aria-label="生成记录与保留的文字" className="space-y-3 rounded-lg border border-[#D8C8B5] bg-[#FFF9EF] p-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-bold">{selected.status === 'generating' ? selected.body ? '生成中，文字已分次保存' : '正在等待第一段文字' : selected.status === 'saved' ? '这次内容已另存为正文' : selected.body ? '这次没有完成，已有文字保留了' : '这次没有收到可用文字'}</h3>
      {attempts.length > 1 && <select aria-label="选择生成记录" value={selected.id} onChange={(event) => { setSelectedId(event.target.value); setRepairId(''); }} className="max-w-full rounded-md border bg-white p-1">
        {attempts.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.status === 'generating' ? '生成中' : item.status === 'saved' ? '已保存正文' : '未完成'}</option>)}
      </select>}
    </div>
    <p role="status">{selected.workingDraft ? `待完成稿第 ${selected.workingDraft.version} 版 · ` : ''}已保存 {Array.from(currentBody).length} 字 · <time dateTime={selected.updatedAt}>{new Date(selected.updatedAt).toLocaleTimeString('zh-CN')}</time></p>
    {selected.status === 'generating' ? <p>正在等待后续文字。离开页面后服务会继续处理；这里显示最近一次保存的部分。</p> : selected.status === 'failed' ? <>
      <p>{selected.workingDraft ? '修改已经逐次保存，原始生成文字保留。核对完成后仍需另存为正式正文。' : selected.reason}</p>
      {currentIssues.length > 0 && <div><p className="font-semibold">{selected.workingDraft ? '当前还需补齐或修改' : '生成当时的检查结果'}</p><ul className="mt-1 list-disc space-y-1 pl-5">{currentIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
      <p>这份文字尚未通过检查，不会直接进入排版或发布。查看、导出和手动修改不会调用模型；让模型补写会新增一次调用，实际费用以服务商记录为准。</p>
      <a href="/settings?diagnostics=1#desktop-diagnostics" className="inline-block underline">查看运行诊断</a>
    </> : <p>原始生成记录仍然保留。请继续核对正文，采用补写不会代替文章确认。</p>}
    {selected.body && <>
      {selected.status === 'failed' && !generating && <WritingRequirementsReview runId={runId} path={path} recoveryId={selected.id} refreshKey={`${selected.updatedAt}:${reload}`} />}
      <div className="flex flex-wrap gap-4">
        <OutputDownloadLink href={download} className="font-semibold underline">导出已有文字</OutputDownloadLink>
        {selected.status === 'failed' && onVersionChange && <button type="button" disabled={generating || disabled} className="font-semibold underline disabled:opacity-40" onClick={() => setRepairId(selected.id)}>补写或修改这份稿</button>}
      </div>
      <details><summary className="cursor-pointer">查看这次保留的原文</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 font-sans leading-7">{selected.body}</pre></details>
      {selected.workingDraft && <details><summary className="cursor-pointer">查看当前待完成稿</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 font-sans leading-7">{currentBody}</pre></details>}
    </>}
    {selected.status === 'failed' && repairId === selected.id && onVersionChange && <ContentRevisionEditor key={selected.id} runId={runId} recoveryId={selected.id} packagePath={path} disabled={generating || disabled} onBusyChange={onBusyChange} onDraftSaved={() => setReload((value) => value + 1)} onVersionChange={(newPath) => { onVersionChange(newPath); setReload((value) => value + 1); }} />}
  </section>;
}

'use client';

import { useEffect, useState } from 'react';
import type { ProductionDraftSummary } from '@/lib/production-drafts';
import { DRAFT_FILTERS, filterProductionDrafts, type DraftFilter } from '@/lib/production-draft-filter';

type Props = {
  compact?: boolean; currentDraftId?: string; currentRunId?: string;
  recoverable?: { topic: string; onResume: () => void };
  name: string; onNameChange: (name: string) => void; busy: boolean; hasContent: boolean; refreshKey: number;
  onSave: (copy?: boolean) => Promise<unknown>; onOpen: (id: string) => Promise<void>; onNew: () => Promise<void>;
};
export function ProductionDraftShelf({ compact, currentDraftId, currentRunId, recoverable, name, onNameChange, busy, hasContent, refreshKey, onSave, onOpen, onNew }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProductionDraftSummary[]>([]);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<DraftFilter>('all');
  const [loaded, setLoaded] = useState(false);
  const [readMessage, setReadMessage] = useState('');
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch('/api/production/drafts', { cache: 'no-store' }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '草稿列表未能读取。');
      if (!Array.isArray(data.items)) throw new Error('草稿列表格式不完整，请重新读取。');
      if (!cancelled) { setItems(data.items); setLoaded(true); setReadMessage(data.unreadable ? `有 ${data.unreadable} 份草稿无法读取，原文件保留。其他草稿可以继续使用。` : ''); }
    }).catch((error) => { if (!cancelled) { setLoaded(true); setReadMessage(`${error.message} 如已有列表，仍显示上次读取的结果。`); } });
    return () => { cancelled = true; };
  }, [open, refreshKey, reload]);
  async function act(action: () => Promise<unknown>, success = '') {
    if (working || busy) return;
    setWorking(true); setMessage('');
    try { await action(); setMessage(success); setReload((value) => value + 1); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作没有完成，当前草稿保留。'); }
    finally { setWorking(false); }
  }
  const disabled = busy || working;
  const visible = filterProductionDrafts(items, query, filter);
  return <section aria-label="我的草稿" className={`rounded-xl border border-[#E5DDD6] bg-white px-5 ${compact ? 'py-3' : 'py-4'}`}>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-[180px] flex-1 text-xs font-semibold text-[#6B6B6B]"><span className={compact ? 'sr-only' : undefined}>这份草稿叫什么</span><input aria-label="草稿名称" value={name} onChange={(event) => onNameChange(event.target.value)} maxLength={100} disabled={disabled} placeholder="例如：客户常问的问题" className={`${compact ? '' : 'mt-1.5'} block h-9 w-full rounded-md border border-[#D8D1C9] px-3 text-sm font-normal text-[#1A1A1A]`} /></label>
      <button type="button" disabled={disabled || !hasContent} onClick={() => void act(() => onSave(), '草稿已保存，可以从列表重新打开。')} className="h-9 rounded-full border border-[#1A1A1A] px-3 text-sm disabled:opacity-40">保存草稿</button>
      <button type="button" disabled={disabled || !hasContent} onClick={() => void act(async () => { await onNew(); setOpen(false); })} className="h-9 rounded-full bg-[#1A1A1A] px-3 text-sm text-white disabled:opacity-40">保留本期并新建</button>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="h-9 px-2 text-sm underline">{open ? '收起草稿' : '查看草稿'}</button>
    </div>
    {open && <div className="mt-4 border-t border-[#E5DDD6] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-bold">我的草稿</h2><button type="button" disabled={disabled} onClick={() => setReload((value) => value + 1)} className="text-xs underline">刷新草稿列表</button></div>
      <p className="mt-2 text-xs leading-5 text-[#6B6B6B]">打开另一份前会先保存当前内容。草稿保存在本机项目中，未完成的任务也可以接着做。</p>
      {recoverable && <section aria-label="继续上次内容" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#E5DDD6] p-3 text-sm">
        <div className="min-w-0 flex-1"><p className="font-semibold">本机还有一期未完成的内容</p><p className="mt-1 break-words text-[#6B6B6B]">{recoverable.topic || '上次添加的素材已保存在本机，可以接着做。'}</p></div>
        <button type="button" onClick={() => { recoverable.onResume(); setOpen(false); }} disabled={disabled} className="rounded-full border border-[#BEB5AB] px-3 py-2 text-sm disabled:opacity-50">继续上次内容</button>
      </section>}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="min-w-[180px] flex-1 text-xs text-[#6B6B6B]">搜索草稿<input aria-label="搜索草稿" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="草稿名、题目或素材摘要" className="mt-1 block h-9 w-full rounded-md border border-[#D8D1C9] px-3 text-sm text-[#1A1A1A]" /></label>
        <label className="text-xs text-[#6B6B6B]">筛选进度<select aria-label="筛选草稿进度" value={filter} onChange={(event) => setFilter(event.target.value as DraftFilter)} className="mt-1 block h-9 rounded-md border border-[#D8D1C9] px-2 text-sm text-[#1A1A1A]">{DRAFT_FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        {(query || filter !== 'all') && <button type="button" className="h-9 text-xs underline" onClick={() => { setQuery(''); setFilter('all'); }}>清除搜索和筛选</button>}
      </div>
      {loaded && <p role="status" className="mt-2 text-xs text-[#6B6B6B]">显示 {visible.length} / {items.length} 份草稿{readMessage ? '（列表可能不完整）' : ''}</p>}
      {readMessage && <p role="alert" className="mt-2 text-sm text-[#6B5543]">{readMessage}</p>}
      <details className="mt-2 text-xs leading-5 text-[#6B6B6B]"><summary className="cursor-pointer">这些状态和时间是什么意思</summary><p>列表显示上次保存的内容。“待继续处理”包括准备素材、连接服务、写作和修改。“可导出”需要当前文章与成品已确认；“已有发布记录”包括部分成品已发布，打开后核对范围。文件存在或下载不等于发布。旧版本发布不计入当前成品状态。</p><p>输入修改记录草稿名称、题目、素材、写作要求、笔记等变化，不包含正文改稿时间；快照保存也包括页面位置等记录。打开草稿不会更新输入修改时间。</p></details>
      <ProductionDraftList items={visible} currentDraftId={currentDraftId} currentRunId={currentRunId} disabled={disabled} onOpen={(id) => void act(() => onOpen(id))} />
      {!loaded ? <p role="status" className="mt-3 text-sm">正在读取草稿。</p> : !items.length && !readMessage ? <p className="mt-3 text-sm text-[#6B6B6B]">还没有保存的草稿。先放入素材，再点击“保存草稿”。</p> : items.length > 0 && !visible.length ? <p className="mt-3 text-sm text-[#6B6B6B]">没有符合条件的草稿。可以换个关键词，或清除搜索和筛选。</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" disabled={disabled || !hasContent} onClick={() => void act(() => onSave(true), '已另存为新草稿；保留素材和笔记，重新开始研究与写作。当前内容不变。')} className="rounded-full border border-[#BEB5AB] px-3 py-1.5 text-xs disabled:opacity-40">另存素材为新草稿</button><span className="text-xs text-[#6B6B6B]">保留素材和笔记，重新开始研究与写作。</span></div>
    </div>}
    {message && <p role="status" className="mt-3 text-sm leading-6 text-[#6B5543]">{message}</p>}
  </section>;
}


function displayTime(value?: string): string {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '未记录';
  return new Date(value).toLocaleString('zh-CN');
}

/** Each row comes from its own saved snapshot/run; the current marker is identity only. */
export function ProductionDraftList({ items, currentDraftId, currentRunId, disabled, onOpen }: {
  items: ProductionDraftSummary[]; currentDraftId?: string; currentRunId?: string;
  disabled: boolean; onOpen: (id: string) => void;
}) {
  return <ul className="mt-3 max-h-[32rem] space-y-2 overflow-y-auto">{items.map((item) => {
    const current = Boolean(currentDraftId ? item.id === currentDraftId : currentRunId && item.id === `run:${currentRunId}`);
    return <li key={item.id} aria-current={current ? 'true' : undefined} className={`flex items-start justify-between gap-3 rounded-md border p-3 ${current ? 'border-[#B2B8A4] bg-[#F2F5ED]' : 'border-transparent bg-[#F8F7F4]'}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><p className="break-words text-sm font-semibold">{item.name}</p>{current && <span className="rounded-full bg-[#DFE6D4] px-2 py-0.5 text-xs font-semibold text-[#34442A]">正在编辑</span>}</div>
        <p className="mt-1 text-xs text-[#6B6B6B]">{item.platforms.map((platform) => ({ wechat: '公众号', xhs: '小红书', xiaohongshu: '小红书', shipinhao: '视频号' }[platform] || platform)).join(' · ') || '尚未选择平台'}</p>
        {item.topic && item.topic !== item.name && <p className="mt-1 break-words text-sm text-[#4B4B4B]">题目：{item.topic}</p>}
        <p className="mt-2 text-xs font-semibold leading-5 text-[#3F4935]">{item.progress?.label || '进度待核对'}</p>
        <p className="text-xs leading-5 text-[#6B6B6B]">下一步：{item.progress?.nextStep || '打开草稿，核对素材和已保存的内容。'}</p>
        <details className="mt-2 text-xs leading-5 text-[#6B6B6B]"><summary className="cursor-pointer">素材摘要与保存时间</summary><p className="mt-1 break-words">{item.excerpt || '旧草稿尚无摘要，打开后可查看素材。'}</p><p className="mt-1 text-[11px] leading-5 text-[#6B6B6B]">{item.source === 'runtime' ? `任务记录更新：${displayTime(item.updatedAt)} · 输入修改时间未记录` : `输入修改：${displayTime(item.modifiedAt)} · 快照保存：${displayTime(item.updatedAt)}`}</p></details>
      </div>
      <button type="button" disabled={disabled || current} onClick={() => onOpen(item.id)} aria-label={current ? `正在编辑草稿：${item.name}` : `打开草稿：${item.name}`} className="shrink-0 rounded-full border border-[#BEB5AB] px-3 py-1.5 text-xs disabled:opacity-50">{current ? '当前草稿' : '打开'}</button>
    </li>;
  })}</ul>;
}

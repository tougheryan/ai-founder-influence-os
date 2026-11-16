'use client';

import { useEffect, useState } from 'react';
import type { CurrentResearchStatus } from '@/lib/research-status';
import { serviceRecordStatus, serviceRecordTime } from '@/lib/service-status-copy';
import { PRODUCTION_WORKSPACE_STORAGE_KEY, productionWorkspaceContext, type ProductionWorkspaceContext } from '@/lib/production-workspace-context';

export function ResearchActivityStatus({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<CurrentResearchStatus | null>(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<ProductionWorkspaceContext | null>(null);
  useEffect(() => {
    let controller: AbortController | undefined;
    const load = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      let current: ProductionWorkspaceContext;
      try { current = productionWorkspaceContext(window.localStorage.getItem(PRODUCTION_WORKSPACE_STORAGE_KEY)); }
      catch { current = { state: 'unavailable' }; }
      setSelection(current); setData(null); setError('');
      if (current.state !== 'selected') return;
      const runId = current.runId;
      void fetch(`/api/research/status?runId=${encodeURIComponent(runId)}`, { cache: 'no-store', signal: request.signal }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok || (payload.runId !== runId && !(payload.runId === null && payload.state === 'no_run'))) throw new Error('Research task mismatch');
        if (!request.signal.aborted) setData(payload);
      }).catch(() => { if (!request.signal.aborted) setError('这份草稿的研究记录暂时读不到，请刷新平台数据设置；不会自动重新采集。'); });
    };
    const storageChanged = (event: StorageEvent) => { if (event.key === PRODUCTION_WORKSPACE_STORAGE_KEY || event.key === null) load(); };
    load();
    window.addEventListener('storage', storageChanged);
    window.addEventListener('focus', load);
    return () => { controller?.abort(); window.removeEventListener('storage', storageChanged); window.removeEventListener('focus', load); };
  }, [refreshKey]);
  return <section aria-label="本期研究存档" className="space-y-2 border-t border-[rgba(28,28,30,0.08)] px-5 py-5 text-sm">
    <h3 className="font-bold">本期研究存档</h3>
    {error ? <p role="alert">{error}</p>
      : selection?.state === 'none' ? <p>当前工作台还没有需要研究的草稿。<a href="/production?stage=1" className="ml-1 underline">打开工作台</a></p>
        : selection?.state === 'unavailable' ? <p>无法确定当前打开的是哪份草稿。<a href="/production?stage=1" className="ml-1 underline">回到工作台选择草稿</a></p>
          : !data ? <p>正在读取本期存档，不会重新采集。</p>
            : <ResearchActivityRecord data={data} name={selection?.state === 'selected' ? selection.name : undefined} returnHref={selection?.state === 'selected' ? selection.returnHref : undefined} />}
  </section>;
}

export function ResearchActivityRecord({ data, name, returnHref }: { data: CurrentResearchStatus; name?: string; returnHref?: string }) {
  return <>
    {(name || data.runId) && <p className="font-semibold">{name || (data.title !== data.runId && data.title) || '未命名草稿'}</p>}
    <p>{data.reason}</p>
    {data.lastAttempt && <p className="text-xs text-[#6B6B6B]">最近一次本期采集：{serviceRecordStatus(data.lastAttempt.status)} · 开始于 {serviceRecordTime(data.lastAttempt.startedAt)}{data.lastAttempt.completedAt ? ` · 结束于 ${serviceRecordTime(data.lastAttempt.completedAt)}` : ''}</p>}
    {data.collectedAt && <p className="text-xs text-[#6B6B6B]">存档采集时间：{serviceRecordTime(data.collectedAt)}</p>}
    {(data.state === 'current' || data.state === 'collected') && <ul className="flex flex-wrap gap-3">{data.platforms.map((platform) => <li key={platform.id} className="rounded-md bg-[#F7F9F5] px-3 py-2">{platform.label}：{platform.sampleCount === null ? '样本数未记录' : `${platform.sampleCount} 条样本`} · {platform.status === 'available' ? '已取得数据' : platform.status === 'unavailable' ? '未取得数据' : '返回状态未知'}</li>)}</ul>}
    {data.runId && <a href={returnHref || `/production?stage=2&openDraft=${encodeURIComponent(`run:${data.runId}`)}`} className="inline-block font-semibold underline">{data.state === 'author_material' ? '回到本期核对写作方案' : '回到本期核对研究'}</a>}
    <p className="text-xs text-[#6B6B6B]">周度参考、当前连接和本期存档分别记录；周度更新失败不会抹掉本期已有研究。</p>
  </>;
}

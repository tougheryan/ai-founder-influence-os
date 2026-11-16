'use client';

import { useEffect, useState } from 'react';
import { LAYOUT_CALLS_CHANGED, layoutCallLabel, layoutCallStatus, type LayoutCallHistory as History } from '@/lib/layout-call-types';
import { serviceRecordTime } from '@/lib/service-status-copy';

export function LayoutCallRecords({ data, visible = data.records.length }: { data: History; visible?: number }) {
  return <div className="space-y-3 text-sm leading-6">
    <p>记录启用后的 md2wechat 排版请求尝试，费用未知，以服务方账单为准。失败、中断或回退到基础排版也可能计费；这些请求不计入模型调用次数上限。</p>
    <p>取得排版文件不代表最终成品通过检查或已被采用。历史请求、产品外调用和实际扣费尚未核对，不能当作完整账单。</p>
    {data.runId !== null && <p>这里只显示本期文章排版。主题示例不绑定草稿，可到<a href="/settings#layout-service-calls" className="underline">设置中查看全部排版记录</a>。</p>}
    {!data.records.length ? <p role="status">当前范围还没有排版请求记录，不代表历史上没有调用或费用。</p> : <>
      <p>已保存 {data.records.length} 条排版请求记录</p>
      <ol className="space-y-3">{data.records.slice(0, visible).map((record) => <li key={record.id} className="rounded-lg border border-black/10 bg-white p-3">
        <div className="flex flex-wrap justify-between gap-2"><strong>{layoutCallLabel(record.operation)}</strong><span>{layoutCallStatus(record.status)}</span></div>
        <p className="break-words">样式：{record.theme}{record.revisionId ? ` · 排版版本 ${Number(record.revisionId.slice(1))}` : ''}</p>
        {data.runId === null && <p className="break-all">{record.runSlug ? `所属内容：${record.runSlug}` : '内置示例，未绑定草稿'}</p>}
        <p className="text-xs text-[#6B6B6B]">发起于 {serviceRecordTime(record.startedAt)}{record.completedAt ? ` · 结果记录于 ${serviceRecordTime(record.completedAt)}` : ' · 结束时间未记录'}</p>
        {record.status !== 'completed' && <p>请先查看已有成品，再决定是否重新请求。再次请求可能产生费用。</p>}
      </li>)}</ol>
    </>}
  </div>;
}

function HistoryPanel({ runId, refreshKey }: { runId: string | null; refreshKey: string }) {
  const [open, setOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<History | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(20);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function read() {
      setPending(true); setError('');
      try {
        const query = runId === null ? '' : `?${new URLSearchParams({ runId })}`;
        const response = await fetch(`/api/layout-calls${query}`, { cache: 'no-store', signal: controller.signal });
        const payload = await response.json() as History;
        if (!response.ok || payload.runId !== runId || !Array.isArray(payload.records)) throw new Error('unverified');
        if (!controller.signal.aborted) setData(payload);
      } catch {
        if (!controller.signal.aborted) setError('排版请求记录暂时无法核对，不能据此判断次数或费用。请重新读取；已有结果如显示在下方，为上次读取的记录。');
      } finally { if (!controller.signal.aborted) setPending(false); }
    }
    void read();
    return () => controller.abort();
  }, [open, reload, runId, refreshKey]);
  useEffect(() => {
    if (!open) return;
    const refresh = () => setReload((value) => value + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener(LAYOUT_CALLS_CHANGED, refresh);
    const timer = data?.records.some((record) => record.status === 'started') ? window.setInterval(refresh, 5000) : undefined;
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(LAYOUT_CALLS_CHANGED, refresh);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [open, data]);
  return <details id="layout-service-calls" className="rounded-xl border border-black/10 bg-white p-4" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-semibold">{runId ? '本期排版服务请求' : '排版服务请求记录'}</summary>
    {open && <div className="mt-3 space-y-3">
      <button type="button" className="text-sm underline" disabled={pending} onClick={() => setReload((value) => value + 1)}>重新读取排版记录</button>
      <p className="text-xs leading-5 text-[#6B6B6B]">查看和刷新只读取本机记录，不会请求排版服务。</p>
      {pending && <p role="status" className="text-sm">正在读取排版记录。</p>}
      {error && <p role="alert" className="text-sm">{error}</p>}
      {data && <LayoutCallRecords data={data} visible={visible} />}
      {data && visible < data.records.length && <button type="button" className="text-sm underline" onClick={() => setVisible((value) => value + 20)}>再显示 20 条记录</button>}
    </div>}
  </details>;
}

export function LayoutCallHistory({ runId = null, refreshKey = '' }: { runId?: string | null; refreshKey?: string }) {
  return <HistoryPanel key={runId ?? 'project'} runId={runId} refreshKey={refreshKey} />;
}

'use client';

import type { ReactNode } from 'react';
import type { ModelCallLimit } from '@/lib/service-call-types';
import { useServiceCallHistory } from '@/hooks/useServiceCallHistory';
import { ModelCallLimitEditor } from './ProductionCallHistory';

export function ModelCallSummary({ limit, pending, error }: { limit?: ModelCallLimit; pending: boolean; error: string }) {
  return <div className="space-y-1 text-sm leading-6 text-[#514A43]" aria-live="polite">
    {limit && <p>{pending || error ? '上次读取：' : '本期已记录 '}{pending || error ? `已调用 ${limit.recordedCalls} 次` : `${limit.recordedCalls} 次`}
      {limit.maxCalls === null ? ' · 未设次数上限' : ` · 上限 ${limit.maxCalls} 次 · 剩余 ${limit.remaining} 次`}</p>}
    {pending && <p>正在核对调用次数，读取不会调用模型。</p>}
    {error && <p role="alert">{error}</p>}
    {!pending && !error && limit?.remaining === 0 && <p className="font-semibold text-[#8D5A00]">本期次数已用尽或已暂停；调整上限后才能请求模型，手动改稿仍可使用。</p>}
    <p>本次费用未知，以服务商账单为准。一次生成可能包含多次请求，次数上限不是金额上限。</p>
  </div>;
}

export function ModelCallAction({ runId, refreshKey = '', children }: { runId?: string; refreshKey?: string; children: (unavailable: boolean) => ReactNode }) {
  return runId ? <BoundModelCallAction key={runId} runId={runId} refreshKey={refreshKey}>{children}</BoundModelCallAction> : children(false);
}

function BoundModelCallAction({ runId, refreshKey, children }: { runId: string; refreshKey: string; children: (unavailable: boolean) => ReactNode }) {
  const { data, pending, error, reload, onSaved } = useServiceCallHistory(runId, true, refreshKey);
  const limit = data?.limit;
  return <section aria-label="生成前的调用与费用" className="w-full space-y-3 rounded-lg border border-[#D8D1C9] bg-[#FAFAF6] p-3">
    <ModelCallSummary limit={limit} pending={pending} error={error} />
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 text-sm">
      <details className="min-w-0 flex-1">
        <summary className="cursor-pointer font-semibold underline underline-offset-4">设置本期次数上限</summary>
        <div className="mt-3">{limit ? <ModelCallLimitEditor runId={runId} limit={limit} readVerified={!pending && !error} onSaved={onSaved} /> : <p>读取当前限制后即可设置。</p>}</div>
      </details>
      <button type="button" className="underline underline-offset-4 disabled:opacity-50" disabled={pending} onClick={reload}>刷新调用信息</button>
    </div>
    {children(pending || Boolean(error) || !limit || limit.remaining === 0)}
  </section>;
}

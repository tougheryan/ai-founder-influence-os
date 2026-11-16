'use client';

import { useEffect, useState } from 'react';
import type { ModelCallLimit, ServiceCallHistory } from '@/lib/service-call-types';

const changedEvent = 'echo-model-call-limit-changed';

/** Missing or inconsistent limits must never be displayed as unlimited. */
export function verifiedCallHistory(value: unknown, runId: string): ServiceCallHistory {
  const data = value as ServiceCallHistory | null;
  const limit = data?.limit;
  if (!data || data.runId !== runId || !Array.isArray(data.records) || !limit
    || !(limit.maxCalls === null || (Number.isSafeInteger(limit.maxCalls) && limit.maxCalls >= 0 && limit.maxCalls <= 10000))
    || !Number.isSafeInteger(limit.revision) || limit.revision < 0
    || !Number.isSafeInteger(limit.recordedCalls) || limit.recordedCalls !== data.records.length
    || limit.remaining !== (limit.maxCalls === null ? null : Math.max(0, limit.maxCalls - limit.recordedCalls))) {
    throw new Error('Call history unavailable');
  }
  return data;
}

/** A read started before saving a limit must not roll that saved state back. */
export function newerCallHistory(current: ServiceCallHistory | null, incoming: ServiceCallHistory): ServiceCallHistory {
  return current?.runId === incoming.runId && current.limit && incoming.limit
    && (current.limit.revision > incoming.limit.revision || current.limit.recordedCalls > incoming.limit.recordedCalls)
    ? current : incoming;
}

type Snapshot = { runId: string; data: ServiceCallHistory | null; pending: boolean; error: string };

export function useServiceCallHistory(runId: string, enabled: boolean, refreshKey = '') {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled || !runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => setRevision((value) => value + 1);
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === runId) refresh(); };
    async function read() {
      setSnapshot((current) => ({ runId, data: current?.runId === runId ? current.data : null, pending: true, error: '' }));
      try {
        const response = await fetch(`/api/production/service-calls?${new URLSearchParams({ runId, includeLimit: '1' })}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Call history unavailable');
        const payload = verifiedCallHistory(await response.json(), runId);
        if (controller.signal.aborted) return;
        setSnapshot((current) => ({ runId, data: newerCallHistory(current?.data || null, payload), pending: false, error: '' }));
        if (payload.records.some((record) => record.status === 'started')) timer = setTimeout(read, 5_000);
      } catch {
        if (!controller.signal.aborted) setSnapshot((current) => ({ runId, data: current?.runId === runId ? current.data : null, pending: false, error: '本期调用次数暂时无法核对，费用仍未知。请重新读取；读取记录不会调用模型。' }));
      }
    }
    void read();
    window.addEventListener('focus', refresh);
    window.addEventListener(changedEvent, changed);
    return () => {
      controller.abort(); if (timer) clearTimeout(timer);
      window.removeEventListener('focus', refresh); window.removeEventListener(changedEvent, changed);
    };
  }, [runId, enabled, refreshKey, revision]);
  const current = snapshot?.runId === runId ? snapshot : null;
  return {
    data: current?.data || null,
    pending: current?.pending ?? true,
    error: current?.error || '',
    reload: () => setRevision((value) => value + 1),
    onSaved: (limit: ModelCallLimit) => {
      setSnapshot((value) => value?.runId === runId && value.data ? { ...value, data: { ...value.data, limit } } : value);
      window.dispatchEvent(new CustomEvent(changedEvent, { detail: runId }));
    },
  };
}

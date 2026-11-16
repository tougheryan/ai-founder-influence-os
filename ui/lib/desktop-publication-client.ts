'use client';

type DesktopResultResponse = {
  queue?: unknown;
  attemptedJobIds?: string[];
  error?: string;
};

export function hasDesktopPublicationBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.aifiosPublication?.fillDraft === 'function';
}

/**
 * Electron signs its result before it reaches this helper. The web service
 * verifies that signature against its per-session secret before mutating a
 * local queue, so renderer code cannot invent a successful platform fill.
 */
export async function fillDraftWithDesktopBridge(input: {
  queuePath: string;
  runId: string;
  jobId: string;
  expectedPayloadHash: string;
}): Promise<DesktopResultResponse | null> {
  if (!hasDesktopPublicationBridge()) return null;
  const bridge = window.aifiosPublication!;
  const bridgeResponse = await bridge.fillDraft(input);
  if (!bridgeResponse?.receipt) throw new Error('桌面发布桥没有返回可验证的草稿结果。');
  const response = await fetch('/api/publish/drafts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'desktop_result',
      queuePath: input.queuePath,
      runId: input.runId,
      desktopReceipt: bridgeResponse.receipt,
    }),
  });
  const data = await response.json().catch(() => ({})) as DesktopResultResponse;
  if (!response.ok || !data.queue) throw new Error(data.error || '桌面草稿结果没有写入本机队列。');
  return data;
}

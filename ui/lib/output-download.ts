import { displayClientError } from './client-error-copy';

const DOWNLOAD_FAILURE = '暂时无法下载文件。请重试。';
const INVALID_DOWNLOAD = '没有收到完整的下载文件。请重试。';
export type OutputDownloadReceipt = { id: string; runId: string };
export type OutputDownloadRecording = 'prepared' | 'unavailable' | 'unattributed' | 'unsupported';
export type PreparedOutputDownload = { blob: Blob; fileName: string; receipt?: OutputDownloadReceipt; recording: OutputDownloadRecording };
const RECEIPT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RUN_ID = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;

function downloadReceipt(headers: Headers): Pick<PreparedOutputDownload, 'receipt' | 'recording'> {
  const status = headers.get('x-echo-download-record');
  if (!status) return { recording: 'unsupported' };
  if (status === 'unattributed' || status === 'unavailable') return { recording: status };
  try {
    const id = headers.get('x-echo-download-receipt') || '';
    const runId = decodeURIComponent(headers.get('x-echo-download-run-id') || '');
    if (status === 'prepared' && RECEIPT_ID.test(id) && RUN_ID.test(runId)) return { recording: 'prepared', receipt: { id, runId } };
  } catch { /* An invalid receipt must not turn a complete file into a failed download. */ }
  return { recording: 'unavailable' };
}

function safeDownloadName(value: string): string | null {
  const basename = value.replace(/\\/g, '/').split('/').pop()
    ?.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().replace(/[. ]+$/, '');
  if (!basename || new TextEncoder().encode(basename).length > 255) return null;
  return basename;
}

function attachmentName(disposition: string | null): string | null {
  if (!disposition || !/^attachment(?:\s*;|\s*$)/i.test(disposition)) return null;
  const extended = /;\s*filename\*\s*=\s*([^;]+)/i.exec(disposition)?.[1]?.trim();
  if (extended) {
    const utf8 = /^utf-8'[^']*'(.*)$/i.exec(extended);
    if (utf8) {
      try {
        const name = safeDownloadName(decodeURIComponent(utf8[1]));
        if (name) return name;
      } catch { /* Try the ordinary filename when the extended value is malformed. */ }
    }
  }
  const ordinary = /;\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i.exec(disposition);
  return ordinary ? safeDownloadName((ordinary[1] ?? ordinary[2]).replace(/\\(.)/g, '$1')) : null;
}

/** Fetch a response copy without navigating away or interpreting file bytes as text. */
export async function fetchOutputDownload(
  href: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PreparedOutputDownload> {
  const response = await fetcher(href, { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok) {
    let failure: unknown;
    try { failure = await response.json(); } catch { /* Never display an HTML error page or raw exception. */ }
    throw new Error(displayClientError(failure, DOWNLOAD_FAILURE));
  }
  const fileName = attachmentName(response.headers.get('content-disposition'));
  if (!fileName || [204, 205, 206].includes(response.status)) throw new Error(INVALID_DOWNLOAD);
  // The server bounds original files at 256MB before reading them. Its marked
  // response can be slightly larger; do not impose a conflicting copy limit.
  const blob = await response.blob();
  const length = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  // Fetch decodes gzip/br automatically, while Content-Length describes the
  // encoded transfer. Compare lengths only for an unencoded response.
  if ((!encoding || encoding.trim().toLowerCase() === 'identity') && length !== null
    && (!/^\d+$/.test(length) || Number(length) !== blob.size)) throw new Error(INVALID_DOWNLOAD);
  const preparedBytes = response.headers.get('x-echo-download-bytes');
  if (preparedBytes !== null && (!/^\d+$/.test(preparedBytes) || Number(preparedBytes) !== blob.size)) throw new Error(INVALID_DOWNLOAD);
  if (signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
  return { blob, fileName, ...downloadReceipt(response.headers) };
}


/** This POST is metadata only. A failure must never repeat the file download. */
export async function acknowledgeOutputDownload(receipt: OutputDownloadReceipt, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (signal?.aborted || !RECEIPT_ID.test(receipt.id) || !RUN_ID.test(receipt.runId)) return false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = (async () => {
      try {
        const response = await fetcher('/api/production/export-events', {
          method: 'POST', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receiptId: receipt.id, runId: receipt.runId }),
        });
        if (!response.ok) return false;
        const result = await response.json();
        return !controller.signal.aborted && result?.ok === true && result.event?.id === receipt.id && result.event?.runId === receipt.runId
          && typeof result.event?.downloadStartedAt === 'string' && Number.isFinite(Date.parse(result.event.downloadStartedAt));
      } catch { return false; }
    })();
    // The file has already been handed to the browser. Metadata must not leave
    // that successful action looking stuck or trigger a second download.
    return await Promise.race([request, new Promise<boolean>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(false); }, 5000); })]);
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

/** The browser click happens only after the whole Blob, and before acknowledging its receipt. */
export async function startOutputDownload(href: string, options: {
  signal?: AbortSignal; fetcher?: typeof fetch; startDownload: (blob: Blob, fileName: string) => void;
}): Promise<{ recorded: boolean; message: string }> {
  const output = await fetchOutputDownload(href, options.signal, options.fetcher);
  if (options.signal?.aborted) throw new DOMException('Download aborted', 'AbortError');
  options.startDownload(output.blob, output.fileName);
  if (output.receipt) {
    const recorded = await acknowledgeOutputDownload(output.receipt, options.signal, options.fetcher);
    return { recorded, message: recorded
      ? '已发起浏览器下载，并记录到本篇。请在浏览器下载列表确认文件保存。'
      : '已发起浏览器下载，但记录尚未确认。无需重新下载，请在浏览器下载列表确认文件。' };
  }
  return { recorded: false, message: output.recording === 'unattributed'
    ? '已发起浏览器下载；文件版本或所属稿件未核实，未计入本篇记录。'
    : output.recording === 'unavailable'
      ? '已发起浏览器下载，但记录尚未确认。无需重新下载，请在浏览器下载列表确认文件。'
      : '已发起浏览器下载；当前入口未记录下载操作，请在浏览器下载列表确认文件。' };
}

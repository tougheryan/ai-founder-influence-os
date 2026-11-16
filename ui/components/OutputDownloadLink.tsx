'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { displayClientError } from '@/lib/client-error-copy';
import { startOutputDownload } from '@/lib/output-download';

type Props = {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
  onRecorded?: () => void;
  'aria-label'?: string;
};

export function OutputDownloadLink({ href, children, className, title, onRecorded, 'aria-label': label }: Props) {
  const [state, setState] = useState({ href, busy: false, error: '', message: '' });
  const pending = useRef<AbortController | null>(null);
  const messageId = useId();
  const current = state.href === href ? state : { busy: false, error: '', message: '' };

  useEffect(() => () => pending.current?.abort(), [href]);

  return (
    <span className="inline-flex min-w-0 flex-col items-start">
      <a
        href={href}
        className={className}
        title={title}
        aria-label={label}
        aria-busy={current.busy || undefined}
        aria-disabled={current.busy || undefined}
        aria-describedby={current.busy || current.error || current.message ? messageId : undefined}
        onClick={async (event) => {
          event.preventDefault();
          if (pending.current && !pending.current.signal.aborted) return;
          const controller = new AbortController();
          pending.current = controller;
          setState({ href, busy: true, error: '', message: '' });
          try {
            const result = await startOutputDownload(href, {
              signal: controller.signal,
              startDownload: (blob, fileName) => {
                if (controller.signal.aborted || pending.current !== controller) throw new DOMException('Download aborted', 'AbortError');
                const objectUrl = URL.createObjectURL(blob);
                try {
                  const download = document.createElement('a');
                  download.href = objectUrl;
                  download.download = fileName;
                  document.body.appendChild(download);
                  try { download.click(); } finally { download.remove(); }
                } finally {
                  // Let the browser consume the Blob before releasing its URL.
                  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
                }
                setState({ href, busy: true, error: '', message: '已发起浏览器下载，正在记录…' });
              },
            });
            if (!controller.signal.aborted && pending.current === controller) {
              setState({ href, busy: false, error: '', message: result.message });
              if (result.recorded === true && onRecorded) {
                try {
                  void Promise.resolve(onRecorded()).catch(() => undefined);
                } catch {
                  // Refresh failures must not turn a confirmed download into a download error.
                }
              }
            }
          } catch (error) {
            if (!controller.signal.aborted && pending.current === controller) {
              setState({ href, busy: false, error: displayClientError(error, '暂时无法下载文件。请重试。'), message: '' });
            }
          } finally {
            if (pending.current === controller) pending.current = null;
          }
        }}
      >
        {children}
      </a>
      {(current.busy || current.error || current.message) && (
        <span id={messageId} role={current.error ? 'alert' : 'status'} className={`mt-1 max-w-sm text-xs leading-relaxed ${current.error ? 'text-[#8F3329]' : 'text-[#6B6B6B]'}`}>
          {current.error || current.message || '正在准备下载…'}
        </span>
      )}
    </span>
  );
}

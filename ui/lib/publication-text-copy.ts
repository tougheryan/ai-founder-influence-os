import { outputHref } from './output-links';
import type { PublicationTextField } from './publication-text';

export type PublishingCopy = {
  text: string; previewText: string; notice: string; reviewToken: string;
  disclosureStatus: 'no_whole_draft_limit' | 'restricted_details' | 'internal_only' | 'unverified';
};
export type PublishingCopyResult = { status: 'cancelled' }
  | ({ status: 'review' } & PublishingCopy)
  | { status: 'copied' | 'manual'; text: string; notice: string; includedNotice: boolean; reviewToken: string };

/** Re-read source and limits for every click, including the click after reviewing a notice. */
export async function copyPublicationText(path: string, sha256: string, field: PublicationTextField, options: {
  signal: AbortSignal; isCurrent: () => boolean; writeText: (value: string) => Promise<void>;
  reviewedToken?: string; withNotice?: boolean; fetcher?: typeof fetch;
}): Promise<PublishingCopyResult> {
  const controller = new AbortController(); const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) controller.abort();
  const timeout = setTimeout(abort, 10000);
  let copy: PublishingCopy;
  try {
    const response = await (options.fetcher || fetch)(`${outputHref(path)}?${new URLSearchParams({ publicationText: field, sha256 })}`, {
      cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
    });
    const payload = await response.json();
    if (options.signal.aborted || !options.isCurrent()) return { status: 'cancelled' };
    if (controller.signal.aborted) throw new Error('读取文案超时，请重试。');
    if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : '暂时无法复制文案，请重试。');
    if (payload?.sha256 !== sha256 || payload?.field !== field || typeof payload?.text !== 'string' || !payload.text.trim()
      || typeof payload?.previewText !== 'string' || !payload.previewText.trim() || typeof payload?.notice !== 'string'
      || typeof payload?.reviewToken !== 'string' || !/^[a-f0-9]{64}$/.test(payload.reviewToken)
      || !['no_whole_draft_limit', 'restricted_details', 'internal_only', 'unverified'].includes(payload.disclosureStatus)
      || (payload.disclosureStatus !== 'no_whole_draft_limit' && !payload.notice.trim())) throw new Error('文案没有读取完整，请刷新成品后重试。');
    copy = payload;
  } finally { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); }
  if (options.signal.aborted || !options.isCurrent()) return { status: 'cancelled' };
  const plainAllowed = copy.disclosureStatus === 'no_whole_draft_limit'
    || copy.disclosureStatus === 'restricted_details' && copy.reviewToken === options.reviewedToken;
  if (!options.withNotice && !plainAllowed) return { status: 'review', ...copy };
  const text = options.withNotice ? copy.previewText : copy.text;
  const result = { text, notice: copy.notice, includedNotice: Boolean(options.withNotice && copy.notice), reviewToken: plainAllowed ? copy.reviewToken : '' };
  try {
    await options.writeText(text);
    return options.signal.aborted || !options.isCurrent() ? { status: 'cancelled' } : { status: 'copied', ...result };
  } catch {
    return options.signal.aborted || !options.isCurrent() ? { status: 'cancelled' } : { status: 'manual', ...result };
  }
}

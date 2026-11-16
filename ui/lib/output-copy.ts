import type { OutputDisclosure } from './output-disclosure';
import { disclosureNotice, markExportText } from './output-disclosure-format';
import { outputHref } from './output-links';

const UNVERIFIED: OutputDisclosure = { status: 'unverified', restrictions: [] };

function readDisclosure(value: unknown): OutputDisclosure {
  if (!value || typeof value !== 'object') return UNVERIFIED;
  const candidate = value as Partial<OutputDisclosure>;
  if (!['internal_only', 'restricted_details', 'no_whole_draft_limit', 'unverified'].includes(candidate.status || '')
    || !Array.isArray(candidate.restrictions) || !candidate.restrictions.every((entry) => typeof entry === 'string')
    || (candidate.status === 'no_whole_draft_limit' && candidate.restrictions.length > 0)) return UNVERIFIED;
  return candidate as OutputDisclosure;
}

/** Read this file's current author limits for every copy, including manual fallback. */
export async function prepareOutputCopy(
  sourcePath: string,
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<{ text: string; notice: string }> {
  let disclosure = UNVERIFIED;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    if (sourcePath.trim()) {
      const response = await fetcher(`${outputHref(sourcePath)}?disclosure=1`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (response.ok) {
        const payload: unknown = await response.json();
        if (payload && typeof payload === 'object' && 'disclosure' in payload) disclosure = readDisclosure(payload.disclosure);
      }
    }
  } catch {
    // Local copying remains available, but uncertainty travels with the copy.
  } finally {
    clearTimeout(timeout);
  }
  return { text: markExportText(value, '.txt', disclosure), notice: disclosureNotice(disclosure) };
}

export async function copyOutput(
  sourcePath: string,
  value: string,
  options: { isCurrent: () => boolean; writeText: (text: string) => Promise<void>; fetcher?: typeof fetch },
): Promise<{ status: 'cancelled' } | { status: 'copied' | 'manual'; text: string; notice: string }> {
  const prepared = await prepareOutputCopy(sourcePath, value, options.fetcher);
  if (!options.isCurrent()) return { status: 'cancelled' };
  try {
    await options.writeText(prepared.text);
    return options.isCurrent() ? { status: 'copied', ...prepared } : { status: 'cancelled' };
  } catch {
    return options.isCurrent() ? { status: 'manual', ...prepared } : { status: 'cancelled' };
  }
}

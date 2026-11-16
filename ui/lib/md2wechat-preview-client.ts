import type { BrandTemplate } from './brand-templates';
import { LAYOUT_CALLS_CHANGED } from './layout-call-types';

export type Md2WechatPreviewPayload = {
  themeId: string;
  html: string;
  renderer: string;
  exact: boolean;
};

type PreviewFetcher = typeof fetch;
type PreviewOptions = {
  force?: boolean;
  fetcher?: PreviewFetcher;
  confirmExternalCall?: boolean;
};

const previewCache = new Map<string, Md2WechatPreviewPayload>();
const previewRequests = new Map<string, Promise<Md2WechatPreviewPayload>>();
const MAX_CACHED_PREVIEWS = 12;

function cachePreview(key: string, preview: Md2WechatPreviewPayload): void {
  previewCache.delete(key);
  previewCache.set(key, preview);
  while (previewCache.size > MAX_CACHED_PREVIEWS) {
    const oldestKey = previewCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    previewCache.delete(oldestKey);
  }
}

export function md2WechatPreviewCacheKey(theme: Pick<BrandTemplate, 'id' | 'version'>): string {
  return `${theme.id}@${theme.version || 'unknown'}`;
}

export function getCachedMd2WechatPreview(
  theme: Pick<BrandTemplate, 'id' | 'version'>,
): Md2WechatPreviewPayload | null {
  return previewCache.get(md2WechatPreviewCacheKey(theme)) || null;
}

export async function fetchMd2WechatPreview(
  theme: Pick<BrandTemplate, 'id' | 'version'>,
  options: PreviewOptions = {},
): Promise<Md2WechatPreviewPayload> {
  const key = md2WechatPreviewCacheKey(theme);
  if (!options.force) {
    const cached = previewCache.get(key);
    if (cached) return cached;
  }
  // A forced refresh must also join an in-flight request: comparisons can
  // display the same theme in several mounted panels.
  const pending = previewRequests.get(key);
  if (pending) return pending;
  if (options.confirmExternalCall !== true) throw new Error('请先确认本次预览会请求外部排版服务。');
  const fetcher = options.fetcher || fetch;
  const request = fetcher('/api/brand-templates/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ themeId: theme.id, confirmExternalCall: true }),
    cache: 'no-store',
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({})) as Partial<Md2WechatPreviewPayload> & { error?: string };
    if (!response.ok || typeof payload.html !== 'string' || !payload.html) {
      throw new Error(payload.error || '排版预览没有生成成功。');
    }
    const result: Md2WechatPreviewPayload = {
      themeId: typeof payload.themeId === 'string' ? payload.themeId : theme.id,
      html: payload.html,
      renderer: typeof payload.renderer === 'string' ? payload.renderer : 'md2wechat',
      exact: payload.exact === true,
    };
    cachePreview(key, result);
    return result;
  }).finally(() => {
    if (previewRequests.get(key) === request) previewRequests.delete(key);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(LAYOUT_CALLS_CHANGED));
  });
  previewRequests.set(key, request);
  return request;
}

export function clearMd2WechatPreviewCache(): void {
  previewCache.clear();
  previewRequests.clear();
}

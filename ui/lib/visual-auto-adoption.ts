type VisualSelectionResponse = {
  status?: unknown;
  slug?: unknown;
  revisionId?: unknown;
  error?: unknown;
};

export type VisualSelectionFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function revisionFromGeneratedIndex(slug: string, indexPath: string): string {
  const match = /^pipeline\/visual\/([^/]+)\/revisions\/(r\d{3,})\.index\.json$/.exec(indexPath);
  if (!match || match[1] !== slug) {
    throw new Error('视觉渲染没有返回当前任务可采用的版本索引。');
  }
  return match[2];
}

export async function adoptGeneratedVisualRevision(input: {
  slug: string;
  indexPath: string;
  fetcher?: VisualSelectionFetcher;
}): Promise<string> {
  const revisionId = revisionFromGeneratedIndex(input.slug, input.indexPath);
  const fetcher = input.fetcher || fetch;
  const response = await fetcher('/api/visual/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: input.slug, revisionId }),
  });
  const payload = await response.json().catch(() => ({})) as VisualSelectionResponse;
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' && payload.error.trim()
      ? payload.error
      : '视觉版本采用失败。');
  }
  if (payload.status !== 'selected' || payload.slug !== input.slug || payload.revisionId !== revisionId) {
    throw new Error('视觉版本采用响应与本次渲染结果不一致。');
  }
  return revisionId;
}

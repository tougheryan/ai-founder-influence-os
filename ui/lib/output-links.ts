export type OutputLinkMode = 'json' | 'view' | 'download';

/** Keep API reads separate from links that open or save the actual file. */
export function outputHref(path: string, mode: OutputLinkMode = 'json'): string {
  const href = `/api/output/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (mode === 'view') return `${href}?raw=1`;
  if (mode === 'download') return `${href}?download=1`;
  return href;
}

export function readableArticleHref(path: string, sha256: string, download = false): string {
  const query = new URLSearchParams({ readable: 'article', sha256 });
  if (download) query.set('download', '1');
  return `${outputHref(path)}?${query}`;
}

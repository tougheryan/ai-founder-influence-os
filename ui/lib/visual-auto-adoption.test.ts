import { describe, expect, it, vi } from 'vitest';
import { adoptGeneratedVisualRevision } from './visual-auto-adoption';

describe('adoptGeneratedVisualRevision', () => {
  it('adopts the exact revision produced by the current visual generation', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'selected',
      slug: 'demo',
      revisionId: 'r007',
    }), { status: 200 }));

    await expect(adoptGeneratedVisualRevision({
      slug: 'demo',
      indexPath: 'pipeline/visual/demo/revisions/r007.index.json',
      fetcher,
    })).resolves.toBe('r007');

    expect(fetcher).toHaveBeenCalledWith('/api/visual/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'demo', revisionId: 'r007' }),
    });
  });
});

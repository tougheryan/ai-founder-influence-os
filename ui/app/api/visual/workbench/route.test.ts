import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  slug: '',
  state: {
    slug: 'demo',
    selectedRevisionId: 'r001',
    hasExplicitSelection: false,
    revisions: [],
    assets: [],
    reviewAssets: [],
    comparison: [],
  } as Record<string, unknown> | null,
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/visual-workbench', () => ({
  loadVisualWorkbenchState: async (slug: string) => {
    mocks.slug = slug;
    return mocks.state;
  },
}));

import { GET } from './route';

describe('GET /api/visual/workbench', () => {
  beforeEach(() => {
    mocks.slug = '';
    mocks.state = {
      slug: 'demo',
      selectedRevisionId: 'r001',
      hasExplicitSelection: false,
      revisions: [],
      assets: [],
      reviewAssets: [],
      comparison: [],
    };
  });

  it('returns the verified visual state for a valid local run slug', async () => {
    const response = await GET(new NextRequest('http://localhost/api/visual/workbench?slug=demo'));

    expect(response.status).toBe(200);
    expect(mocks.slug).toBe('demo');
    expect(await response.json()).toEqual(mocks.state);
  });

  it('rejects a missing or unsafe slug before reading state', async () => {
    const response = await GET(new NextRequest('http://localhost/api/visual/workbench?slug=../outside'));

    expect(response.status).toBe(400);
    expect(mocks.slug).toBe('');
  });

  it('returns an empty success response when the run has not generated visual assets', async () => {
    mocks.state = null;

    const response = await GET(new NextRequest('http://localhost/api/visual/workbench?slug=demo'));

    expect(response.status).toBe(204);
  });
});

import { describe, expect, it } from 'vitest';
import { POST } from './route';

describe('POST /api/publish', () => {
  it('rejects the legacy direct-publish path so callers cannot skip the approved draft queue', async () => {
    const response = await POST();

    expect(response.status).toBe(410);
    const payload = await response.json();
    expect(payload.migration).toBe('/api/publish/results');
  });
});

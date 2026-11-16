import { describe, expect, it, vi } from 'vitest';
const writes = vi.hoisted(() => vi.fn());
vi.mock('@/lib/config-lite', () => ({ writeLiteConfig: writes }));
import { POST } from './route';

describe('retired product password endpoint', () => {
  it('returns a retirement notice without writing an authorization flag', async () => {
    const response = await POST();
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: 'product_password_retired' } });
    expect(writes).not.toHaveBeenCalled();
  });
});

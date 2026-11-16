import { stat } from 'fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCommercialAcceptanceFile } from './commercial-acceptance-file';

vi.mock('fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('fs/promises')>();
  return { ...original, stat: vi.fn(original.stat) };
});
afterEach(() => vi.mocked(stat).mockReset());

describe('unreadable acceptance', () => {
  it('does not turn permission failures into missing or successful records', async () => {
    vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('/private/path/private-message'), { code: 'EACCES' }));
    const result = await readCommercialAcceptanceFile('/private/path');
    expect(result.record.readState).toBe('unreadable');
    expect(result.eligibility.status).toBe('invalid');
    expect(result.record.pass).toBe(false);
    expect(JSON.stringify(result)).not.toContain('/private/path');
  });
});

import { describe, expect, it, vi } from 'vitest';
const readFile = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', () => ({ readFile }));
import { demoUnlockRequired, verifyDemoUnlockCode } from './demo-unlock';

describe('retired local product passwords', () => {
  it('does not read or activate historical password configuration', async () => {
    await expect(demoUnlockRequired()).resolves.toBe(false);
    await expect(verifyDemoUnlockCode('OLD-CODE')).resolves.toBe(false);
    expect(readFile).not.toHaveBeenCalled();
  });
});

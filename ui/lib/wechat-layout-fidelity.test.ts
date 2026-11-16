import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execute }) };
});
vi.mock('./project-root', () => ({
  PROJECT_DIR: '/tmp/customer project',
  skillPath: (...parts: string[]) => `/runtime/skills/${parts.join('/')}`,
}));
vi.mock('./runtime-binary', () => ({ runtimePythonBinary: () => '/runtime/bin/python3' }));
import { verifyWechatLayout } from './wechat-layout-fidelity';

describe('fresh WeChat fidelity verification', () => {
  beforeEach(() => { mocks.execute.mockReset(); });

  it('checks the requested revision through the packaged interpreter without shell interpolation', async () => {
    mocks.execute.mockResolvedValue({ stdout: JSON.stringify({ status: 'pass', errors: [] }) });
    expect(await verifyWechatLayout('article', 'r002')).toBe(true);
    expect(mocks.execute).toHaveBeenCalledWith('/runtime/bin/python3', [
      '/runtime/skills/content-runtime/scripts/visual_publish.py', '--project', '/tmp/customer project',
      'verify', '--slug', 'article', '--revision', 'r002',
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  });

  it.each([
    '{"status":"failed","errors":["缺句号"]}',
    '{"status":"pass","errors":["链接错误"]}',
    '{"status":"pass"}',
    'not json',
  ])('does not accept an unsuccessful or incomplete result: %s', async (stdout) => {
    mocks.execute.mockResolvedValue({ stdout });
    expect(await verifyWechatLayout('article', 'r002')).toBe(false);
  });

  it('fails closed when the interpreter cannot complete', async () => {
    mocks.execute.mockRejectedValue(new Error('timeout'));
    expect(await verifyWechatLayout('article', 'r002')).toBe(false);
  });
});

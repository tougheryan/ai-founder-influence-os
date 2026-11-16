import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ args: [] as string[] }));

vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  return {
    execFile: Object.assign(() => undefined, {
      [custom]: (_file: string, args: string[]) => {
        mocks.args = args;
        return Promise.resolve({ stdout: JSON.stringify({ status: 'selected', visual_template: 'wechat-native' }), stderr: '' });
      },
    }),
  };
});
vi.mock('@/lib/brand-template-config', () => {
  class BrandTemplateResolutionError extends Error {}
  return {
    BrandTemplateResolutionError,
    resolveConfiguredBrandTemplate: async (id: string) => {
      if (id !== 'wechat-native') {
        throw new BrandTemplateResolutionError('这个 md2wechat 主题当前不可直接使用。');
      }
      return {
        id,
        label: id,
        detail: '微信公众号原生主题',
        layoutStyle: id,
        enabled: true,
        source: 'md2wechat',
      };
    },
  };
});
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({
  PROJECT_DIR: '/tmp/aifios-run-template',
  contentRuntimeToolPath: (name: string) => `/tmp/${name}`,
  redactLocalPaths: <T>(value: T) => value,
}));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
}));

import { POST } from './route';

describe('POST /api/run/template', () => {
  beforeEach(() => { mocks.args = []; });

  it('writes the chosen reviewed template into the current run before topic confirmation', async () => {
    const response = await POST(new NextRequest('http://localhost/api/run/template', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'demo-run', visualTemplate: 'wechat-native' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.args).toEqual([
      '/tmp/content_runtime.py', '--project', '/tmp/aifios-run-template', 'run-template-set',
      '--run-id', 'demo-run', '--visual-template', 'wechat-native',
    ]);
  });

  it('rejects unsupported templates before invoking the runtime', async () => {
    const response = await POST(new NextRequest('http://localhost/api/run/template', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'demo-run', visualTemplate: '../../outside' }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.args).toEqual([]);
  });
});

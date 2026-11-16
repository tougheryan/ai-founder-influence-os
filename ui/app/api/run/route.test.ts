import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  args: [] as string[],
  templateIds: [] as string[],
  clearedEvidence: [] as Array<{ projectId: string; runId: string }>,
  evidenceCleanupError: false,
}));

vi.mock('child_process', () => ({
  execFile: Object.assign(
    (...args: unknown[]) => {
      mocks.args = (args[1] as string[]) || [];
      const platformIndex = mocks.args.indexOf('--platforms');
      const targetPlatforms = platformIndex >= 0 ? mocks.args[platformIndex + 1].split(',') : [];
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, JSON.stringify({
        status: 'created',
        run_id: 'all-platform-run',
        slug: 'all-platform',
        project_id: 'client_alpha',
        target_platforms: targetPlatforms,
        selected_platforms: targetPlatforms,
        run_file: 'runs/all-platform-run.json',
      }), '');
    },
    {
      [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => {
        mocks.args = (args[1] as string[]) || [];
        const platformIndex = mocks.args.indexOf('--platforms');
        const targetPlatforms = platformIndex >= 0 ? mocks.args[platformIndex + 1].split(',') : [];
        return Promise.resolve({
          stdout: JSON.stringify({
            status: 'created',
            run_id: 'all-platform-run',
            slug: 'all-platform',
            project_id: 'client_alpha',
            target_platforms: targetPlatforms,
            selected_platforms: targetPlatforms,
            run_file: 'runs/all-platform-run.json',
          }),
          stderr: '',
        });
      },
    },
  ),
}));

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => {},
}));

vi.mock('@/lib/brand-template-config', () => {
  class BrandTemplateResolutionError extends Error {}
  return {
    BrandTemplateResolutionError,
    resolveConfiguredBrandTemplate: async (id?: string) => {
      mocks.templateIds.push(id || '');
      if (id === 'untrusted-template') {
        throw new BrandTemplateResolutionError('品牌排版模板不存在或已停用，请先在设置中启用它。');
      }
      if (id === 'wechat-native') {
        return {
          id: 'wechat-native',
          label: '微信原生',
          detail: 'md2wechat API 主题。',
          layoutStyle: 'wechat-native',
          enabled: true,
        };
      }
      return {
        id: id || 'wechat-native',
        label: '默认模板',
        detail: '默认模板。',
        layoutStyle: id || 'wechat-native',
        enabled: true,
      };
    },
  };
});

vi.mock('@/lib/project-root', () => ({
  PROJECT_DIR: '/tmp/aifios-run-route',
  contentRuntimeToolPath: (name: string) => `/tmp/${name}`,
  redactLocalPaths: <T>(value: T) => value,
  toProjectRelativePath: (value: string | undefined | null) => value || '',
}));

vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock('@/lib/tikomni-content-link-evidence', () => ({
  clearTikOmniContentLinkEvidence: async (scope: { projectId: string; runId: string }) => {
    mocks.clearedEvidence.push(scope);
    if (mocks.evidenceCleanupError) throw new Error('local cleanup failed');
    return { ...scope, relativePath: `sessions/content-link-reads/${scope.projectId}/${scope.runId}`, removed: true };
  },
}));

import { DELETE, PATCH, POST } from './route';

describe('POST /api/run', () => {
  beforeEach(() => {
    mocks.args = [];
    mocks.templateIds = [];
    mocks.clearedEvidence = [];
    mocks.evidenceCleanupError = false;
  });

  it('creates only the platform lanes selected by the operator', async () => {
    const response = await POST(new NextRequest('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: '内容生产整改',
        projectId: 'client_alpha',
        platforms: ['wechat'],
        visualTemplate: 'wechat-native',
      }),
    }));

    const payload = await response.json();
    if (!response.ok) throw new Error(JSON.stringify({ payload, args: mocks.args }));
    expect(response.status).toBe(200);
    expect(mocks.args).toContain('wechat');
    expect(mocks.args).toEqual(expect.arrayContaining(['--visual-template', 'wechat-native']));
    expect(mocks.args).toEqual(expect.arrayContaining(['--project-id', 'client_alpha']));
    expect(payload.target_platforms).toEqual(['wechat']);
    expect(payload.selected_platforms).toEqual(['wechat']);
  });

  it('defaults to the three primary platform-native lanes', async () => {
    const response = await POST(new NextRequest('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '三平台协同' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.args).toContain('wechat,xhs,shipinhao');
    expect((await response.json()).selected_platforms).toEqual(['wechat', 'xhs', 'shipinhao']);
  });

  it('rejects an empty or unsupported platform selection', async () => {
    const empty = await POST(new NextRequest('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '空平台', platforms: [] }),
    }));
    const unsupported = await POST(new NextRequest('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '旧平台', platforms: ['douyin'] }),
    }));

    expect(empty.status).toBe(400);
    expect(unsupported.status).toBe(400);
  });

  it('rejects an unsafe customer project identifier before creating a run', async () => {
    const response = await POST(new NextRequest('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '内容生产整改', projectId: '../other-project' }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.args).toEqual([]);
  });

  it('rejects an unconfigured brand layout template before invoking the runtime', async () => {
    const response = await POST(new NextRequest('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '内容生产整改', visualTemplate: 'untrusted-template' }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'brand_template_unavailable' });
    expect(mocks.args).toEqual([]);
  });

  it('resolves a selected md2wechat theme to its renderer theme id', async () => {
    const response = await POST(new NextRequest('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: '创始人复盘', templateId: 'wechat-native' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.templateIds).toEqual(['wechat-native']);
    expect(mocks.args).toEqual(expect.arrayContaining(['--visual-template', 'wechat-native']));
    expect((await response.json()).brand_template).toMatchObject({ id: 'wechat-native', layoutStyle: 'wechat-native' });
  });

  it('creates a provisional three-platform run for material analysis without a topic or project ID', async () => {
    const response = await POST(new NextRequest('http://localhost/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryMode: 'material_analysis' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.args).toEqual(expect.arrayContaining(['--topic', '素材分析任务', '--project-id', 'default']));
    expect(mocks.args).toEqual(expect.arrayContaining(['--visual-template', 'default']));
    const payload = await response.json();
    expect(mocks.templateIds).toEqual([]);
    expect(payload.entry_mode).toBe('material_analysis');
    expect(payload.template_selection).toBe('deferred');
    expect(payload.brand_template).toBeNull();
    expect(payload.selected_platforms).toEqual(['wechat', 'xhs', 'shipinhao']);
  });

  it('updates and confirms the selected platform lanes before research', async () => {
    const response = await PATCH(new NextRequest('http://localhost/api/run', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'all-platform-run', platforms: ['xhs', 'shipinhao'], confirm: true }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.args).toEqual(expect.arrayContaining([
      'run-platforms-set', '--run-id', 'all-platform-run', '--platforms', 'xhs,shipinhao', '--confirm',
    ]));
  });

  it('persists the run-level visual mode while keeping direction count and provider policy fixed', async () => {
    const response = await PATCH(new NextRequest('http://localhost/api/run', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'all-platform-run',
        visualPreferences: { mode: 'stable', directionCount: 2, providerPolicy: 'auto' },
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.args).toEqual(expect.arrayContaining([
      'run-visual-preferences-set', '--run-id', 'all-platform-run',
      '--mode', 'stable', '--direction-count', '2', '--provider-policy', 'auto',
    ]));
  });

  it('archives a temporary material run and clears only its TikOmni link evidence', async () => {
    const response = await DELETE(new NextRequest('http://localhost/api/run?runId=all-platform-run', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(mocks.args).toEqual(expect.arrayContaining(['run-archive', '--run-id', 'all-platform-run']));
    expect(mocks.clearedEvidence).toEqual([{ projectId: 'client_alpha', runId: 'all-platform-run' }]);
    expect((await response.json()).evidence_cleanup).toBe('cleared');
  });

  it('keeps a committed archive successful when disposable TikOmni evidence cannot be removed', async () => {
    mocks.evidenceCleanupError = true;
    const response = await DELETE(new NextRequest('http://localhost/api/run?runId=all-platform-run', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).evidence_cleanup).toBe('failed');
    expect(mocks.args).toEqual(expect.arrayContaining(['run-archive', '--run-id', 'all-platform-run']));
  });
});

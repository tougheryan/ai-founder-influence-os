import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-visual-publish-${process.pid}`,
  externalPackagePath: `/tmp/aifios-visual-publish-external-${process.pid}.md`,
  execCalls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  lockCalls: [] as Array<{ key: string; options: Record<string, unknown> | undefined }>,
  approved: true,
  frozenApproved: true,
  frozenCalls: [] as Array<{ step: string; runId?: string }>,
  visualTemplate: 'wechat-native',
  visualMode: 'stable' as 'ai_enhanced' | 'stable',
}));

vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(() => undefined, {
    [custom]: async (file: string, args: string[], options: Record<string, unknown>) => {
      mocks.execCalls.push({ file, args, options });
      return {
        stdout: JSON.stringify({
          status: 'generated',
          slug: 'demo',
          index_path: path.join(mocks.projectDir, 'pipeline/visual/demo/publish/index.json'),
          outputs: [{ output: path.join(mocks.projectDir, 'pipeline/visual/demo/publish/r001/wechat/article.html') }],
        }),
        stderr: '',
      };
    },
  });
  return { execFile };
});

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => {
    await mkdir(mocks.projectDir, { recursive: true });
  },
}));

vi.mock('@/lib/project-root', async () => {
  const pathModule = await import('node:path');
  const redact = <T>(value: T): T => {
    if (typeof value === 'string') {
      const root = `${mocks.projectDir}${pathModule.sep}`;
      return (value.startsWith(root) ? value.slice(root.length) : value) as T;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)])) as T;
    }
    return value;
  };
  return {
    PROJECT_DIR: mocks.projectDir,
    contentRuntimeToolPath: (name: string) => `/runtime/scripts/${name}`,
    redactLocalPaths: redact,
    safeResolve: (base: string, target: string) => {
      const resolved = pathModule.resolve(base, target);
      const root = pathModule.resolve(base);
      return resolved === root || resolved.startsWith(`${root}${pathModule.sep}`) ? resolved : null;
    },
  };
});

vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(
    key: string,
    callback: () => Promise<T>,
    options?: Record<string, unknown>,
  ) => {
    mocks.lockCalls.push({ key, options });
    return callback();
  },
}));

vi.mock('@/lib/runtime-run-resolver', () => ({
  runsForPipelinePath: async () => [{
    run_id: 'demo-run',
    slug: 'demo',
    visual_template: mocks.visualTemplate,
    visual_preferences: { mode: mocks.visualMode, direction_count: 2, provider_policy: 'auto' },
    steps: { package: { latest: 'pipeline/package/demo-package.md' } },
  }],
}));

vi.mock('@/lib/runtime-writer', () => ({
  getRuntimeProductionApproval: async () => ({ approved: mocks.approved }),
  assertFrozenRuntimeTikomniMarketSnapshot: async (step: string, runId?: string) => {
    mocks.frozenCalls.push({ step, runId });
    if (!mocks.frozenApproved) {
      throw new Error('TikOmni 冻结研究快照未通过校验，不能继续 visual：snapshot_integrity_failed');
    }
  },
}));

import { POST } from './route';

const packagePath = 'pipeline/package/demo-package.md';

function request(payload: Record<string, unknown>) {
  return new Request('http://localhost/api/visual/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function writePackage(): Promise<void> {
  const destination = path.join(mocks.projectDir, packagePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, '# 内容包\n', 'utf-8');
}

describe('POST /api/visual/publish', () => {
  beforeEach(async () => {
    mocks.execCalls = [];
    mocks.lockCalls = [];
    mocks.approved = true;
    mocks.frozenApproved = true;
    mocks.frozenCalls = [];
    mocks.visualTemplate = 'wechat-native';
    mocks.visualMode = 'stable';
    await rm(mocks.projectDir, { recursive: true, force: true });
    await rm(mocks.externalPackagePath, { force: true });
    await writePackage();
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    await rm(mocks.externalPackagePath, { force: true });
  });

  it('passes an explicit regeneration request as a new revision without changing account or review requirements', async () => {
    await writePackage();
    const result = await POST(request({ slug: 'demo', packagePath, regenerate: true }));
    expect(result.status).toBe(200);
    expect(mocks.execCalls[0].args).toContain('--new-revision');
    mocks.execCalls = [];
    mocks.approved = false;
    expect((await POST(request({ slug: 'demo', packagePath, regenerate: true }))).status).toBe(409);
    expect(mocks.execCalls).toEqual([]);
  });

  it('runs only the local renderer with a bounded slug lock and redacts project paths', async () => {
    const response = await POST(request({ slug: 'demo', packagePath }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'generated',
      slug: 'demo',
      index_path: 'pipeline/visual/demo/publish/index.json',
      outputs: [{ output: 'pipeline/visual/demo/publish/r001/wechat/article.html' }],
    });
    expect(mocks.execCalls).toEqual([{
      file: 'python3',
      args: [
        '/runtime/scripts/visual_publish.py',
        '--project', mocks.projectDir,
        'generate',
        '--slug', 'demo',
        '--package', packagePath,
        '--renderer', 'local',
        '--layout-style', 'wechat-native',
        '--visual-mode', 'stable',
        '--direction-count', '2',
        '--provider-policy', 'auto',
        '--selected-direction', 'direction-a',
      ],
      options: {
        cwd: mocks.projectDir,
        encoding: 'utf-8',
        timeout: 10 * 60 * 1000,
        maxBuffer: 12 * 1024 * 1024,
      },
    }]);
    expect(mocks.lockCalls).toEqual([{
      key: 'visual-publish:demo',
      options: { timeoutMs: 30_000, staleMs: 11 * 60 * 1000 },
    }]);
  });

  it('passes any safe md2wechat theme id through and rejects unsafe stored values', async () => {
    mocks.visualTemplate = 'tech-blue';
    const themed = await POST(request({ slug: 'demo', packagePath }));
    expect(themed.status).toBe(200);
    expect(mocks.execCalls[0].args).toEqual(expect.arrayContaining(['--layout-style', 'tech-blue']));

    mocks.execCalls = [];
    mocks.visualTemplate = '../unsafe';
    const fallback = await POST(request({ slug: 'demo', packagePath }));
    expect(fallback.status).toBe(200);
    expect(mocks.execCalls[0].args).toEqual(expect.arrayContaining(['--layout-style', 'default']));
  });

  it('forces layout-only output even when an older run stored automatic-image mode', async () => {
    mocks.visualMode = 'ai_enhanced';
    const response = await POST(request({
      slug: 'demo',
      packagePath,
      visualPreferences: { mode: 'ai_enhanced', directionCount: 2, providerPolicy: 'auto' },
    }));

    expect(response.status).toBe(200);
    expect(mocks.execCalls[0].args).toEqual(expect.arrayContaining(['--visual-mode', 'stable']));
  });

  it('prepares two low-cost direction previews without requesting the full render', async () => {
    const response = await POST(request({ slug: 'demo', packagePath, previewOnly: true }));

    expect(response.status).toBe(200);
    expect(mocks.execCalls).toHaveLength(1);
    expect(mocks.execCalls[0].args).toContain('--preview-only');
    expect(mocks.execCalls[0].args).toEqual(expect.arrayContaining([
      '--direction-count', '2', '--provider-policy', 'auto',
    ]));
  });

  it('rejects paths outside the package boundary before invoking the renderer', async () => {
    const response = await POST(request({ slug: 'demo', packagePath: '../outside.md' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.execCalls).toEqual([]);
    expect(mocks.lockCalls).toEqual([]);
  });

  it('rejects a symlinked package before invoking the renderer', async () => {
    await writeFile(mocks.externalPackagePath, '# outside\n', 'utf-8');
    await rm(path.join(mocks.projectDir, packagePath));
    await symlink(mocks.externalPackagePath, path.join(mocks.projectDir, packagePath));

    const response = await POST(request({ slug: 'demo', packagePath }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.execCalls).toEqual([]);
  });

  it('requires the current package hash to have passed final-content confirmation', async () => {
    mocks.approved = false;

    const response = await POST(request({ slug: 'demo', packagePath }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_publish_precondition_failed' });
    expect(mocks.execCalls).toEqual([]);
    expect(mocks.lockCalls).toEqual([]);
  });

  it('requires the current topic approval and frozen TikOmni snapshot before invoking the renderer', async () => {
    mocks.frozenApproved = false;

    const response = await POST(request({ slug: 'demo', packagePath }));

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toMatchObject({ code: 'visual_publish_precondition_failed' });
    expect(JSON.stringify(payload)).not.toMatch(/TikOmni|快照|runtime|pipeline/i);
    expect(mocks.frozenCalls).toEqual([{ step: 'visual', runId: 'demo-run' }]);
    expect(mocks.execCalls).toEqual([]);
    expect(mocks.lockCalls).toEqual([]);
  });
});

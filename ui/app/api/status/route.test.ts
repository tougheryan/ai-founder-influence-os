import { createHmac } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-status-${process.pid}`,
}));
const originalDesktopServiceSecret = process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET;

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', async () => {
  const pathModule = await import('node:path');
  return {
    PROJECT_DIR: mocks.projectDir,
    PROJECT_NAME: 'AIFI OS Test',
    projectPath: (...parts: string[]) => pathModule.join(mocks.projectDir, ...parts),
    runtimeJoin: (...parts: string[]) => pathModule.join(...parts),
    safeResolve: (base: string, target: string) => {
      const resolved = pathModule.resolve(base, target);
      const root = pathModule.resolve(base);
      return resolved === root || resolved.startsWith(`${root}${pathModule.sep}`) ? resolved : null;
    },
    toProjectRelativePath: (value: string) => pathModule.relative(mocks.projectDir, value),
    redactLocalPaths: <T>(value: T) => value,
  };
});

import { GET } from './route';

function statusRequest(headers?: HeadersInit, search = ''): Request {
  return new Request(`http://127.0.0.1/api/status${search}`, { headers });
}

async function writeJson(relativePath: string, value: unknown): Promise<void> {
  const target = path.join(mocks.projectDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value), 'utf-8');
}

describe('GET /api/status', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    await mkdir(path.join(mocks.projectDir, 'pipeline'), { recursive: true });
  });

  afterAll(async () => {
    if (originalDesktopServiceSecret === undefined) delete process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET;
    else process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET = originalDesktopServiceSecret;
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('reads an explicit run without inheriting the other window’s active run or paths', async () => {
    await writeJson('sessions/latest.json', { active_run_id: 'other-run', current_slug: 'other-slug', latest_files: { package: 'other.md' } });
    await writeJson('runs/other-run.json', { run_id: 'other-run', slug: 'other-slug' });
    await writeJson('runs/my-run.json', { run_id: 'my-run', slug: 'my-slug', steps: { package: { latest: 'mine.md' } } });
    const response = await GET(statusRequest(undefined, '?view=production&runId=my-run'));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.latest).toMatchObject({ active_run_id: 'my-run', current_slug: 'my-slug' });
    expect(payload.activeRun).toMatchObject({ run_id: 'my-run', steps: { package: { latest: 'mine.md' } } });
    expect(payload.latest).not.toHaveProperty('latest_files');
    expect((await GET(statusRequest(undefined, '?view=production&runId=missing'))).status).toBe(404);
    expect((await GET(statusRequest(undefined, '?view=production&runId=../other'))).status).toBe(400);
  });

  it('exposes the active runtime run so phase-artifact approvals can be hydrated', async () => {
    await writeJson('sessions/latest.json', {
      active_run_id: 'demo-run',
      current_slug: 'demo',
      latest_files: {},
      latest_by_slug: { demo: {} },
    });
    await writeJson('runs/demo-run.json', {
      run_id: 'demo-run',
      slug: 'demo',
      phase_artifacts: {
        visual_assets: { path: 'pipeline/visual/demo/selected-assets.json', version: 2 },
      },
    });

    const response = await GET(statusRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.activeRun).toEqual(expect.objectContaining({
      run_id: 'demo-run',
      slug: 'demo',
      phase_artifacts: {
        visual_assets: { path: 'pipeline/visual/demo/selected-assets.json', version: 2 },
      },
    }));
  });

  it('returns only the active-run fields for lightweight workbench hydration', async () => {
    await writeJson('sessions/latest.json', {
      active_run_id: 'demo-run',
      current_slug: 'demo',
      latest_files: { very_large_payload: 'pipeline/large.json' },
      latest_by_slug: { demo: {} },
    });
    await writeJson('runs/demo-run.json', {
      run_id: 'demo-run',
      project_id: 'client-alpha',
      phase_artifacts: { visual_assets: { path: 'pipeline/visual/demo/selected-assets.json', version: 2 } },
    });

    const response = await GET(statusRequest(undefined, '?view=active-run'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      latest: { active_run_id: 'demo-run' },
      activeRun: { run_id: 'demo-run', project_id: 'client-alpha' },
    });
    expect(payload).not.toHaveProperty('pipelineFiles');
    expect(payload.activeRun).not.toHaveProperty('phase_artifacts');
  });

  it('returns a compact production view without the global file index', async () => {
    await writeJson('sessions/latest.json', {
      active_run_id: 'demo-run',
      current_slug: 'demo',
      latest_files: { intake: 'pipeline/intake/demo.md', unrelated: 'pipeline/large.json' },
      phase_artifacts: { topic_template: { path: 'pipeline/blueprint/demo.md' } },
    });
    await writeJson('sessions/session-state.json', {
      active_run_id: 'demo-run',
      active_project_id: 'client-alpha',
      phase_artifacts: { content_package: { path: 'pipeline/package/demo.md' } },
    });
    await writeJson('runs/demo-run.json', {
      run_id: 'demo-run',
      slug: 'demo',
      project_id: 'client-alpha',
      steps: { intake: { latest: 'pipeline/intake/demo.md' } },
    });

    const response = await GET(statusRequest(undefined, '?view=production'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.latest).toMatchObject({ active_run_id: 'demo-run', current_slug: 'demo' });
    expect(payload.latest).not.toHaveProperty('latest_files');
    expect(payload.sessionState).toMatchObject({ active_run_id: 'demo-run', active_project_id: 'client-alpha' });
    expect(payload).not.toHaveProperty('pipelineFiles');
  });

  it('does not resolve a malformed active run id into a filesystem path', async () => {
    await writeJson('sessions/latest.json', {
      active_run_id: '../outside',
      current_slug: 'demo',
      latest_files: {},
      latest_by_slug: { demo: {} },
    });

    const response = await GET(statusRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.activeRun).toBeNull();
  });

  it('proves desktop-service ownership only for a valid local challenge', async () => {
    process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET = 'desktop-test-secret';
    const challenge = 'desktop-startup-challenge';

    const response = await GET(statusRequest({ 'x-aifios-desktop-challenge': challenge }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-aifios-desktop-proof')).toBe(
      createHmac('sha256', process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET).update(challenge).digest('hex')
    );
  });
});

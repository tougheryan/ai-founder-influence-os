import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type RuntimeRun = {
  run_id: string;
  slug: string;
  target_platforms: string[];
  steps: Record<string, { latest: string }>;
};

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-delivery-readiness-${process.pid}`,
  runtimeRun: null as RuntimeRun | null,
  disclosureRuns: [] as string[],
}));

vi.mock('@/lib/output-disclosure', () => ({
  getRunDisclosure: async (runId: string) => {
    mocks.disclosureRuns.push(runId);
    return { status: 'internal_only', restrictions: ['作者要求仅供内部使用'] };
  },
}));

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, JSON.stringify(mocks.runtimeRun), '');
  },
}));

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => {
    await mkdir(mocks.projectDir, { recursive: true });
  },
}));

vi.mock('@/lib/project-root', async () => {
  const pathModule = await import('node:path');
  const safeResolve = (base: string, relativePath: string) => {
    const resolved = pathModule.resolve(base, relativePath);
    return resolved === pathModule.resolve(base) || resolved.startsWith(`${pathModule.resolve(base)}${pathModule.sep}`)
      ? resolved
      : null;
  };
  return {
    PROJECT_NAME: 'AIFIOS test project',
    contentRuntimeToolPath: (name: string) => `/tmp/${name}`,
    redactLocalPaths: <T>(value: T) => value,
    runtimeJoin: (...parts: string[]) => pathModule.join(...parts),
    toProjectRelativePath: (value: string | undefined | null) => {
      if (!value) return '';
      const relative = pathModule.relative(mocks.projectDir, value);
      return relative && !relative.startsWith(`..${pathModule.sep}`) && relative !== '..' ? relative : value;
    },
    safeResolve,
  };
});

vi.mock('@/lib/output-files', async () => {
  const pathModule = await import('node:path');
  return {
    BASE_DIR: mocks.projectDir,
    safeResolve: (base: string, relativePath: string) => {
      const resolved = pathModule.resolve(base, relativePath);
      return resolved === pathModule.resolve(base) || resolved.startsWith(`${pathModule.resolve(base)}${pathModule.sep}`)
        ? resolved
        : null;
    },
  };
});

vi.mock('@/lib/visual-workbench', () => ({
  loadVisualWorkbenchState: async () => null,
}));

vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
}));

import { GET } from './route';

type ReadinessItem = {
  title: string;
  runtimeSteps: string[];
  path: string;
  ready: boolean;
  requiredForDelivery: boolean;
};

type DeliveryStatus = {
  readiness: ReadinessItem[];
  missingRequired: ReadinessItem[];
};

const coreSteps = ['intake', 'validate', 'blueprint', 'write', 'package', 'visual', 'prelaunch', 'compliance', 'audit'];

function makeRun(includeXhsOverride = false): RuntimeRun {
  const steps = Object.fromEntries(coreSteps.map((step) => [
    step,
    { latest: `pipeline/${step}/all-platform-${step}.md` },
  ]));
  if (includeXhsOverride) {
    steps.xhs = { latest: 'pipeline/xhs/all-platform-xhs.md' };
  }
  return {
    run_id: 'all-platform-run',
    slug: 'all-platform',
    target_platforms: ['wechat', 'xhs', 'shipinhao', 'douyin', 'moments'],
    steps,
  };
}

async function seedRun(run: RuntimeRun) {
  mocks.runtimeRun = run;
  await mkdir(path.join(mocks.projectDir, 'runs'), { recursive: true });
  await mkdir(path.join(mocks.projectDir, 'sessions'), { recursive: true });
  await Promise.all([
    writeFile(path.join(mocks.projectDir, 'runs', `${run.run_id}.json`), JSON.stringify(run)),
    writeFile(path.join(mocks.projectDir, 'sessions', 'latest.json'), JSON.stringify({
      active_run_id: run.run_id,
      current_slug: run.slug,
      latest_files: {},
    })),
  ]);
}

async function getStatus(): Promise<DeliveryStatus> {
  const response = await GET(new NextRequest('http://localhost/api/delivery'));
  expect(response.status).toBe(200);
  return await response.json() as DeliveryStatus;
}

describe('GET /api/delivery readiness', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    mocks.disclosureRuns = [];
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('retains current author limits alongside an already prepared legacy package', async () => {
    const run = makeRun();
    await seedRun(run);
    const directory = path.join(mocks.projectDir, 'deliveries', 'ready-package');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      run_id: run.run_id, slug: run.slug, delivery_gate: { can_deliver: true },
    }));
    await writeFile(`${directory}.zip`, Buffer.from('original delivery bytes'));
    const response = await GET(new NextRequest('http://localhost/api/delivery?download=deliveries/ready-package.zip'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.disclosureRuns).toEqual([run.run_id]);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.includes(Buffer.from('original delivery bytes'))).toBe(true);
    expect(body.includes(Buffer.from('作者要求仅供内部使用'))).toBe(true);
    expect(decodeURIComponent(response.headers.get('content-disposition') || '')).toContain('仅供内部预览');
  });

  it('does not require a legacy xhs draft for a default five-platform package', async () => {
    await seedRun(makeRun());

    const status = await getStatus();
    const editorialDecision = status.readiness.find(
      (item) => item.runtimeSteps.join(',') === 'validate,blueprint'
    );
    const packageArtifact = status.readiness.find(
      (item) => item.runtimeSteps.join(',') === 'package'
    );
    const terminalTrustCheck = status.readiness.find(
      (item) => item.runtimeSteps.join(',') === 'audit'
    );

    expect(editorialDecision?.path).toBe('pipeline/blueprint/all-platform-blueprint.md');
    expect(packageArtifact).toMatchObject({
      path: 'pipeline/package/all-platform-package.md',
      ready: true,
      requiredForDelivery: true,
    });
    expect(terminalTrustCheck).toMatchObject({
      path: 'pipeline/audit/all-platform-audit.md',
      requiredForDelivery: false,
    });
    expect(status.readiness.some((item) => item.runtimeSteps[0] === 'xhs')).toBe(false);
    expect(status.missingRequired.some((item) => item.runtimeSteps[0] === 'xhs')).toBe(false);
    expect(status.readiness.some((item) => item.runtimeSteps.length === 0)).toBe(false);
  });

  it('does not treat validate as a completed topic-and-blueprint group', async () => {
    const partial = makeRun();
    delete partial.steps.blueprint;
    await seedRun(partial);

    const status = await getStatus();
    const editorialDecision = status.readiness.find(
      (item) => item.runtimeSteps.join(',') === 'validate,blueprint'
    );

    expect(editorialDecision).toMatchObject({
      path: '',
      ready: false,
      requiredForDelivery: true,
    });
    expect(status.missingRequired.some(
      (item) => item.runtimeSteps.join(',') === 'validate,blueprint'
    )).toBe(true);
  });

  it('requires the terminal package rather than accepting a motherpiece alone', async () => {
    const partial = makeRun();
    delete partial.steps.package;
    await seedRun(partial);

    const status = await getStatus();
    const packageArtifact = status.readiness.find(
      (item) => item.runtimeSteps.join(',') === 'package'
    );

    expect(packageArtifact).toMatchObject({
      path: '',
      ready: false,
      requiredForDelivery: true,
    });
    expect(status.missingRequired.some(
      (item) => item.runtimeSteps.join(',') === 'package'
    )).toBe(true);
  });

  it('does not borrow a terminal artifact from global state when the active run lacks it', async () => {
    const partial = makeRun();
    delete partial.steps.package;
    await seedRun(partial);
    await writeFile(
      path.join(mocks.projectDir, 'sessions', 'latest.json'),
      JSON.stringify({
        active_run_id: partial.run_id,
        current_slug: partial.slug,
        latest_files: { package: 'pipeline/package/another-run-package.md' },
      }),
    );

    const status = await getStatus();
    const packageArtifact = status.readiness.find(
      (item) => item.runtimeSteps.join(',') === 'package'
    );

    expect(packageArtifact?.path).toBe('');
    expect(packageArtifact?.ready).toBe(false);
  });

  it('shows an existing xhs override without making it a delivery requirement', async () => {
    await seedRun(makeRun(true));

    const status = await getStatus();
    const override = status.readiness.find((item) => item.runtimeSteps[0] === 'xhs');

    expect(override).toMatchObject({
      title: '小红书独立改写（可选）',
      ready: true,
      requiredForDelivery: false,
    });
    expect(status.missingRequired.some((item) => item.runtimeSteps[0] === 'xhs')).toBe(false);
  });

  it('does not download an internal-review ZIP as a formal delivery package', async () => {
    const run = makeRun();
    await seedRun(run);
    const deliveryDir = path.join(mocks.projectDir, 'deliveries', 'internal-review');
    await mkdir(deliveryDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(deliveryDir, 'manifest.json'), JSON.stringify({
        run_id: run.run_id,
        slug: run.slug,
        delivery_gate: { can_deliver: false },
      })),
      writeFile(`${deliveryDir}.zip`, 'internal review only'),
    ]);

    const response = await GET(new NextRequest(
      'http://localhost/api/delivery?download=deliveries/internal-review.zip',
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: '这份交付包还未通过发布检查，暂时不能下载。',
      code: 'delivery_not_ready',
    });
  });
});

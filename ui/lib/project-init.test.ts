import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exists: false,
  execCalls: 0,
}));

vi.mock('fs', () => ({
  existsSync: () => mocks.exists,
}));

vi.mock('child_process', () => {
  const execFile = () => {};
  Object.assign(execFile, {
    [Symbol.for('nodejs.util.promisify.custom')]: async () => {
      mocks.execCalls += 1;
      return { stdout: '', stderr: '' };
    },
  });
  return { execFile };
});

vi.mock('./project-root', () => ({
  INSTALL_ROOT: '/tmp/aifios-install',
  PROJECT_DIR: '/tmp/aifios-project',
  contentRuntimeToolPath: (name: string) => `/tmp/${name}`,
  runtimeJoin: (...parts: string[]) => parts.join('/'),
}));

vi.mock('./runtime-binary', () => ({ runtimePythonBinary: () => 'python3' }));

describe('ensureProjectInitialized', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.exists = false;
    mocks.execCalls = 0;
  });

  it('does not start the runtime again for an initialized project', async () => {
    mocks.exists = true;
    const { ensureProjectInitialized } = await import('./project-init');

    await ensureProjectInitialized();

    expect(mocks.execCalls).toBe(0);
  });

  it('shares one initialization process across concurrent callers', async () => {
    const { ensureProjectInitialized } = await import('./project-init');

    await Promise.all([
      ensureProjectInitialized(),
      ensureProjectInitialized(),
      ensureProjectInitialized(),
    ]);

    expect(mocks.execCalls).toBe(1);
  });
});

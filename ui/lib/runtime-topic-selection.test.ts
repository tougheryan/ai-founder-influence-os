import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ args: [] as string[] }));

vi.mock('child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  return {
    execFile: Object.assign(() => undefined, {
      [custom]: (_file: string, args: string[]) => {
        mocks.args = args;
        return Promise.resolve({
          stdout: JSON.stringify({ status: 'selected', run_id: 'topic-run', slug: 'neutral-run', topic: '已选主题' }),
          stderr: '',
        });
      },
    }),
  };
});
vi.mock('./project-root', () => ({
  INSTALL_ROOT: '/tmp/aifios-install',
  PROJECT_DIR: '/tmp/aifios-project',
  contentRuntimeToolPath: (name: string) => `/tmp/${name}`,
  toProjectRelativePath: (value: string) => value,
}));
vi.mock('./runtime-binary', () => ({ runtimePythonBinary: () => 'python3' }));

import { setRuntimeRunTopic } from './runtime-writer';

describe('runtime topic selection writer', () => {
  beforeEach(() => { mocks.args = []; });

  it('uses the existing run command and never asks the runtime to create a new run', async () => {
    const result = await setRuntimeRunTopic({
      runId: 'topic-run',
      topic: '已选主题',
      snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshotSha256: 'a'.repeat(64),
      suggestionId: 'topic-2',
    });

    expect(result).toMatchObject({ run_id: 'topic-run', slug: 'neutral-run', topic: '已选主题' });
    expect(mocks.args).toEqual([
      '/tmp/content_runtime.py', '--project', '/tmp/aifios-project', 'run-topic-set',
      '--run-id', 'topic-run', '--topic', '已选主题',
      '--snapshot', 'runs/topic-run/market-research/fixture/snapshot.json',
      '--snapshot-sha256', 'a'.repeat(64), '--suggestion-id', 'topic-2',
    ]);
    expect(mocks.args).not.toContain('run-create');
  });
});

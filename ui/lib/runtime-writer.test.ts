import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  approval: { approved: true } as Record<string, unknown>,
  frozen: { verified: true } as Record<string, unknown>,
  author: { verified: true, research_mode: 'author_material', run_id: 'topic-run' } as Record<string, unknown>,
  calls: [] as string[][],
  activeRunId: 'run-a',
  blockWrites: false,
  pendingWrites: [] as Array<{ args: string[]; resolve: () => void }>,
  writeError: '' as string,
}));

vi.mock('child_process', () => ({
  execFile: (() => {
    const custom = Symbol.for('nodejs.util.promisify.custom');
    return Object.assign(() => undefined, {
      [custom]: async (_file: string, args: string[]) => {
        mocks.calls.push(args);
        if (args.includes('state')) {
          return {
            stdout: JSON.stringify({ active_run_id: mocks.activeRunId }),
            stderr: '',
          };
        }
        if (args.includes('run-switch')) {
          mocks.activeRunId = args[args.indexOf('--run-id') + 1];
          return { stdout: JSON.stringify({ run_id: mocks.activeRunId }), stderr: '' };
        }
        if (args.includes('write')) {
          if (mocks.writeError) throw Object.assign(new Error('runtime process failed'), { stderr: mocks.writeError });
          if (mocks.blockWrites) {
            await new Promise<void>((resolve) => {
              mocks.pendingWrites.push({ args, resolve });
            });
          }
          const runId = args[args.indexOf('--run-id') + 1] || 'implicit';
          return {
            stdout: JSON.stringify({ path: `pipeline/intake/${runId}.md`, ...(args.includes('--require-valid') ? { validation: { valid: true } } : {}) }),
            stderr: '',
          };
        }
        if (args.includes('run')) {
          return {
            stdout: JSON.stringify({
              run_id: 'topic-run',
              steps: { blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' } },
            }),
            stderr: '',
          };
        }
        if (args.includes('blueprint-approval')) {
          return { stdout: JSON.stringify(mocks.approval), stderr: '' };
        }
        if (args.includes('topic-verify')) {
          return { stdout: JSON.stringify(mocks.frozen), stderr: '' };
        }
        if (args.includes('writing-source-verify')) return { stdout: JSON.stringify(mocks.author), stderr: '' };
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    });
  })(),
}));

import { assertFrozenRuntimeTikomniMarketSnapshot, RuntimeOutputValidationError, writeRuntimeOutput, writeValidatedRuntimeOutput } from './runtime-writer';

describe('runtime writer TikOmni enforcement', () => {
  beforeEach(() => {
    mocks.approval = { approved: true };
    mocks.frozen = { verified: true };
    mocks.author = { verified: true, research_mode: 'author_material', run_id: 'topic-run' };
    mocks.calls = [];
    mocks.activeRunId = 'run-a';
    mocks.blockWrites = false;
    mocks.writeError = '';
    mocks.pendingWrites.splice(0).forEach(({ resolve }) => resolve());
  });

  it('validates the exact candidate inside the runtime commit and returns its validation', async () => {
    const result = await writeValidatedRuntimeOutput('intake', 'slug-a', 'source report', 'production-material-analysis', 'run-a');
    expect(result).toMatchObject({ path: 'pipeline/intake/run-a.md', validation: { valid: true } });
    expect(mocks.calls.find((args) => args.includes('write'))).toContain('--require-valid');
  });

  it('carries an explicitly selected plan into the same runtime transaction as the body expectation', async () => {
    const expected = { path: 'pipeline/package/first.md', sha256: 'a'.repeat(64), blueprint: { path: 'pipeline/blueprint/current.md', sha256: 'b'.repeat(64) } };
    await writeRuntimeOutput('package', 'slug-a', 'selected edit', 'content-revision:test', 'run-a', expected);
    const args = mocks.calls.find((call) => call.includes('write'))!;
    expect(args.slice(args.indexOf('--expected-path'), args.indexOf('--expected-path') + 8)).toEqual([
      '--expected-path', expected.path, '--expected-sha256', expected.sha256,
      '--expected-blueprint-path', expected.blueprint.path, '--expected-blueprint-sha256', expected.blueprint.sha256,
    ]);
  });

  it('keeps rejected validation distinct from process failures and cleans up temporary source text', async () => {
    mocks.writeError = JSON.stringify({ code: 'runtime_output_invalid', validation: { valid: false, quality_errors: ['missing explanation'] } });
    await expect(writeValidatedRuntimeOutput('intake', 'slug-a', 'source report', 'test', 'run-a')).rejects.toBeInstanceOf(RuntimeOutputValidationError);
    const args = mocks.calls.find((call) => call.includes('write'))!;
    const sourcePath = args[args.indexOf('--content') + 1].slice(1);
    const { access } = await import('node:fs/promises');
    await expect(access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the current digest-bound topic/template approval before checking the frozen snapshot', async () => {
    mocks.approval = { approved: false, reason: '产物版本已变化，需要重新确认' };

    await expect(assertFrozenRuntimeTikomniMarketSnapshot('write', 'topic-run'))
      .rejects.toThrow('选题与模板确认已失效');

    expect(mocks.calls.some((args) => args.includes('topic-verify'))).toBe(false);
  });

  it('blocks a downstream write when the frozen snapshot no longer verifies', async () => {
    mocks.frozen = { verified: false, reason: 'snapshot_integrity_failed' };

    await expect(assertFrozenRuntimeTikomniMarketSnapshot('package', 'topic-run'))
      .rejects.toThrow('TikOmni 冻结研究快照未通过校验');
  });

  it('permits a downstream write only after both checks pass', async () => {
    await expect(assertFrozenRuntimeTikomniMarketSnapshot('visual', 'topic-run'))
      .resolves.toBeUndefined();
    expect(mocks.calls.some((args) => args.includes('blueprint-approval'))).toBe(true);
    expect(mocks.calls.some((args) => args.includes('topic-verify'))).toBe(true);
  });

  it('uses author evidence authority only for an explicitly approved author source', async () => {
    mocks.approval = { approved: true, research_mode: 'author_material' };
    await expect(assertFrozenRuntimeTikomniMarketSnapshot('package', 'topic-run')).resolves.toBeUndefined();
    expect(mocks.calls.some((args) => args.includes('writing-source-verify'))).toBe(true);
    expect(mocks.calls.some((args) => args.includes('topic-verify'))).toBe(false);
  });

  it('rejects a changed author source without falling back to existing market evidence', async () => {
    mocks.approval = { approved: true, research_mode: 'author_material' };
    mocks.author = { verified: true, research_mode: 'platform', run_id: 'topic-run' };
    await expect(writeRuntimeOutput('package', 'topic', 'body', 'test', 'topic-run')).rejects.toThrow('作者素材或确认已变化');
    expect(mocks.calls.some((args) => args.includes('write'))).toBe(false);
    expect(mocks.calls.some((args) => args.includes('topic-verify'))).toBe(false);
  });

  it('addresses concurrent explicit writes directly without switching the active run', async () => {
    mocks.blockWrites = true;

    const writeB = writeRuntimeOutput('intake', 'slug-b', 'B content', 'test', 'run-b');
    const writeC = writeRuntimeOutput('intake', 'slug-c', 'C content', 'test', 'run-c');
    await vi.waitFor(() => expect(mocks.pendingWrites).toHaveLength(2));

    expect(mocks.activeRunId).toBe('run-a');
    const pending = mocks.pendingWrites.splice(0);
    pending.forEach(({ resolve }) => resolve());
    await expect(Promise.all([writeB, writeC])).resolves.toEqual([
      'pipeline/intake/run-b.md',
      'pipeline/intake/run-c.md',
    ]);

    const writeCalls = mocks.calls.filter((args) => args.includes('write'));
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['--slug', 'slug-b', '--run-id', 'run-b']),
      expect.arrayContaining(['--slug', 'slug-c', '--run-id', 'run-c']),
    ]));
    expect(mocks.calls.some((args) => args.includes('state') || args.includes('run-switch'))).toBe(false);
    expect(mocks.activeRunId).toBe('run-a');
  });

  it('does not restore a stale active run after the operator switches while a write is pending', async () => {
    mocks.blockWrites = true;

    const writeB = writeRuntimeOutput('intake', 'slug-b', 'B content', 'test', 'run-b');
    await vi.waitFor(() => expect(mocks.pendingWrites).toHaveLength(1));

    // Model an independent, intentional run-switch while Python is still
    // committing B. The writer must not replay the active run it saw earlier.
    mocks.activeRunId = 'run-d';
    mocks.pendingWrites.shift()?.resolve();

    await expect(writeB).resolves.toBe('pipeline/intake/run-b.md');
    expect(mocks.calls.some((args) => args.includes('state') || args.includes('run-switch'))).toBe(false);
    expect(mocks.activeRunId).toBe('run-d');
  });
});

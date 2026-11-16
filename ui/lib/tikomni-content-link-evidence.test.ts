import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-content-link-evidence-${process.pid}`,
}));

vi.mock('./project-root', async () => {
  const pathModule = await import('node:path');
  return {
    PROJECT_DIR: mocks.projectDir,
    safeResolve: (base: string, relativePath: string) => {
      const normalizedBase = pathModule.resolve(base);
      const resolved = pathModule.resolve(normalizedBase, relativePath);
      return resolved === normalizedBase || resolved.startsWith(`${normalizedBase}${pathModule.sep}`)
        ? resolved
        : null;
    },
  };
});

import {
  TikOmniContentLinkEvidenceError,
  clearTikOmniContentLinkEvidence,
} from './tikomni-content-link-evidence';
import { tikomniContentLinkRunScope } from './tikomni-content-link';

async function seed(relativePath: string): Promise<void> {
  const target = path.join(mocks.projectDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'fixture', 'utf-8');
}

describe('TikOmni temporary content-link evidence cleanup', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('removes only the requested project and run scope', async () => {
    const selectedRunScope = tikomniContentLinkRunScope('run-a');
    const otherRunScope = tikomniContentLinkRunScope('run-b');
    await seed(`sessions/content-link-reads/client_alpha/${selectedRunScope}/raw/capture.json`);
    await seed(`sessions/content-link-reads/client_alpha/${selectedRunScope}/normalized/result.json`);
    await seed(`sessions/content-link-reads/client_alpha/${otherRunScope}/raw/other-run.json`);
    await seed(`sessions/content-link-reads/client_beta/${selectedRunScope}/raw/other-project.json`);

    await expect(clearTikOmniContentLinkEvidence({
      projectId: 'client_alpha',
      runId: 'run-a',
    })).resolves.toMatchObject({
      relativePath: `sessions/content-link-reads/client_alpha/${selectedRunScope}`,
      removed: true,
    });

    expect(existsSync(path.join(mocks.projectDir, `sessions/content-link-reads/client_alpha/${selectedRunScope}`))).toBe(false);
    expect(existsSync(path.join(mocks.projectDir, `sessions/content-link-reads/client_alpha/${otherRunScope}/raw/other-run.json`))).toBe(true);
    expect(existsSync(path.join(mocks.projectDir, `sessions/content-link-reads/client_beta/${selectedRunScope}/raw/other-project.json`))).toBe(true);
  });

  it('is a no-op when the current run has no captured platform content', async () => {
    await expect(clearTikOmniContentLinkEvidence({
      projectId: 'client_alpha',
      runId: 'run-a',
    })).resolves.toMatchObject({ removed: false });
  });

  it('rejects invalid path components instead of broadening the cleanup scope', async () => {
    await expect(clearTikOmniContentLinkEvidence({
      projectId: 'client_alpha/other',
      runId: 'run-a',
    })).rejects.toBeInstanceOf(TikOmniContentLinkEvidenceError);
  });
});

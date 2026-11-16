import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const paths = vi.hoisted(() => ({ configFile: '' }));

vi.mock('./project-root', () => ({
  get CONFIG_FILE() { return paths.configFile; },
}));

import { readLiteConfig, writeLiteConfig } from './config-lite';

const ROOT = join('/tmp', `aifios-config-lite-${process.pid}`);
const ORIGINAL_DESKTOP = process.env.AIFIOS_DESKTOP;

describe('desktop LLM config secret boundary', () => {
  beforeEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
    paths.configFile = join(ROOT, 'project', 'config', 'llm-config.json');
    await mkdir(dirname(paths.configFile), { recursive: true });
    delete process.env.AIFIOS_DESKTOP;
  });

  afterEach(async () => {
    if (ORIGINAL_DESKTOP === undefined) delete process.env.AIFIOS_DESKTOP;
    else process.env.AIFIOS_DESKTOP = ORIGINAL_DESKTOP;
    await rm(ROOT, { recursive: true, force: true });
  });

  it('preserves source-mode compatibility outside Electron', async () => {
    await writeLiteConfig({ provider: 'openai', apiKey: 'source-key', model: 'test' });

    expect(await readLiteConfig()).toMatchObject({ apiKey: 'source-key' });
  });

  it('never writes or reads a plaintext API key in desktop mode', async () => {
    process.env.AIFIOS_DESKTOP = '1';
    await writeLiteConfig({ provider: 'openai', apiKey: 'must-not-write', model: 'test' });

    const persisted = JSON.parse(await readFile(paths.configFile, 'utf8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('apiKey');

    await writeFile(paths.configFile, JSON.stringify({ provider: 'openai', apiKey: 'legacy-key', model: 'test' }));
    expect(await readLiteConfig()).not.toHaveProperty('apiKey');
  });
});

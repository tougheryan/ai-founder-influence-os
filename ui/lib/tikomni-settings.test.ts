import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';

const paths = vi.hoisted(() => ({
  installRoot: `/tmp/aifios-tikomni-settings-${process.pid}/install`,
  projectDir: `/tmp/aifios-tikomni-settings-${process.pid}/project`,
}));

vi.mock('./project-root', () => ({
  get INSTALL_ROOT() { return paths.installRoot; },
  get PROJECT_DIR() { return paths.projectDir; },
  runtimeJoin: (...parts: string[]) => join(...parts),
  safeResolve: (base: string, target: string) => {
    const value = resolve(base, target);
    const relation = relative(resolve(base), value);
    return relation === '..' || relation.startsWith('../') || isAbsolute(relation) ? null : value;
  },
}));

import { readTikOmniSettingsStatus, removeTikOmniApiToken, saveTikOmniApiToken } from './tikomni-settings';

const ROOT = join('/tmp', `aifios-tikomni-settings-${process.pid}`);
const ORIGINAL_ENV = {
  desktopUserData: process.env.AIFIOS_DESKTOP_USER_DATA_DIR,
  envFile: process.env.AIFIOS_TIKOMNI_ENV_FILE,
  apiKey: process.env.TIKOMNI_API_KEY,
  apiToken: process.env.TIKOMNI_API_TOKEN,
  desktop: process.env.AIFIOS_DESKTOP,
};

function restore(name: keyof typeof ORIGINAL_ENV) {
  const envKey = {
    desktopUserData: 'AIFIOS_DESKTOP_USER_DATA_DIR',
    envFile: 'AIFIOS_TIKOMNI_ENV_FILE',
    apiKey: 'TIKOMNI_API_KEY',
    apiToken: 'TIKOMNI_API_TOKEN',
    desktop: 'AIFIOS_DESKTOP',
  }[name];
  const value = ORIGINAL_ENV[name];
  if (value === undefined) delete process.env[envKey];
  else process.env[envKey] = value;
}

describe('TikOmni desktop-local settings', () => {
  beforeEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
    paths.installRoot = join(ROOT, 'install');
    paths.projectDir = join(ROOT, 'project');
    await mkdir(join(paths.installRoot, 'skills', 'social-media-crawl', 'scripts', 'core'), { recursive: true });
    // The status check only tests file presence; keep it independent of locally installed connectors.
    await writeFile(join(paths.installRoot, 'skills', 'social-media-crawl', 'scripts', 'core', 'call_tikomni_api.py'), '# Synthetic presence fixture, never executed.\n');
    await mkdir(paths.projectDir, { recursive: true });
    await chmod(paths.installRoot, 0o700);
    delete process.env.AIFIOS_TIKOMNI_ENV_FILE;
    delete process.env.TIKOMNI_API_KEY;
    delete process.env.TIKOMNI_API_TOKEN;
    delete process.env.AIFIOS_DESKTOP;
    process.env.AIFIOS_DESKTOP_USER_DATA_DIR = join(ROOT, 'desktop-user-data');
  });

  afterEach(async () => {
    for (const name of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) restore(name);
    await rm(ROOT, { recursive: true, force: true });
  });

  it('writes the token to the desktop user-data directory instead of the installed bundle', async () => {
    const expected = join(ROOT, 'desktop-user-data', 'credentials', 'tikomni.env');

    const status = await saveTikOmniApiToken('desktop-local-token');

    expect(status.credential).toMatchObject({ configured: true, source: 'env_file', localFileConfigured: true });
    expect(await readFile(expected, 'utf-8')).toContain('TIKOMNI_API_KEY=desktop-local-token');
    expect(await stat(expected).then((value) => value.mode & 0o777)).toBe(0o600);
    await expect(readFile(join(paths.installRoot, '.env.local'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an explicit credential file override for managed deployments', async () => {
    const explicit = join(ROOT, 'managed', 'tikomni.env');
    process.env.AIFIOS_TIKOMNI_ENV_FILE = explicit;

    await saveTikOmniApiToken('managed-token');

    expect(await readFile(explicit, 'utf-8')).toContain('TIKOMNI_API_KEY=managed-token');
    expect(await readTikOmniSettingsStatus()).toMatchObject({
      credential: { configured: true, source: 'env_file' },
    });
  });

  it('does not require a GHID for the catalogued WeChat keyword-search endpoint', async () => {
    process.env.TIKOMNI_API_KEY = 'process-token';

    const status = await readTikOmniSettingsStatus();

    expect(status.wechatPublicAccount).toMatchObject({
      configured: false,
      requiredForKeywordSearch: false,
      mode: 'optional_account_tracking',
    });
    expect(status.setup).toEqual({ status: 'ready_to_test', blockers: [] });
  });

  it('fails closed instead of touching a plaintext env file in desktop mode', async () => {
    const target = join(ROOT, 'desktop-user-data', 'credentials', 'tikomni.env');
    await mkdir(join(ROOT, 'desktop-user-data', 'credentials'), { recursive: true });
    await writeFile(target, 'TIKOMNI_API_KEY=legacy-token\n');
    process.env.AIFIOS_DESKTOP = '1';

    await expect(saveTikOmniApiToken('must-not-write')).rejects.toThrow('系统钥匙串');
    await expect(removeTikOmniApiToken()).rejects.toThrow('系统钥匙串');
    expect(await readFile(target, 'utf8')).toBe('TIKOMNI_API_KEY=legacy-token\n');
  });

  it.each([null, '', '10', -1, undefined])('keeps unknown weekly counts %s separate from a failed latest attempt', async (value) => {
    await mkdir(join(paths.projectDir, 'sessions'), { recursive: true });
    await writeFile(join(paths.projectDir, 'sessions/tikomni-weekly-market-state.json'), JSON.stringify({ last_status: 'blocked', last_attempt_at: '2026-09-16', snapshot_path: 'sessions/weekly-snapshot.json' }));
    await writeFile(join(paths.projectDir, 'sessions/weekly-snapshot.json'), JSON.stringify({ created_at: '2026-09-15', sufficiency: { sample_count: value }, platform_checks: { wechat_mp: { status: 'available' } } }));
    expect((await readTikOmniSettingsStatus()).recentCollection).toMatchObject({ lastStatus: 'blocked', collectedAt: '2026-09-15', sampleCount: null, platformChecks: { wechat_mp: 'available' } });
  });
});

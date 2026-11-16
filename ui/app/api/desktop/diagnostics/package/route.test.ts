import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeSupportPayload, secretRedactedString } from '@/lib/diagnostic-redaction';
import {
  readManifestSummary,
  readTextTail,
  type SecureFileStats,
  type SecureReadHandle,
} from './secure-local-files';


describe('desktop diagnostic package redaction', () => {
  it('redacts authorization, cookie, JSON, query-style and provider secrets in text', () => {
    const raw = [
      'Authorization: Bearer bearer-secret',
      'Cookie: session=cookie-secret; Path=/',
      '{"apiKey":"json-secret","access_token":"query-secret"}',
      '{"token":"generic-token-secret","auth_token":"auth-token-secret","client_secret":"client-secret-value"}',
      'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
      'TIKOMNI_API_TOKEN=tikomni-generic-token',
      'jwt=abcdefghijklmnopqrstuvwxyz.ABCDEFGHIJKLMNOPQRSTUVWX.abcdefghijklmnopqrstuvwxyz',
    ].join('\n');

    const sanitized = secretRedactedString(raw);

    for (const secret of [
      'bearer-secret', 'cookie-secret', 'json-secret', 'query-secret', 'generic-token-secret',
      'auth-token-secret', 'client-secret-value', 'sk-abcdefghijklmnopqrstuvwxyz', 'tikomni-generic-token',
    ]) {
      expect(sanitized).not.toContain(secret);
    }
    expect(sanitized).not.toContain('abcdefghijklmnopqrstuvwxyz.ABCDEFGHIJKLMNOPQRSTUVWX.abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts sensitive object fields recursively without hiding harmless status metadata', () => {
    const payload = {
      apiKey: 'top-secret',
      nested: {
        pairingToken: 'pairing-secret',
        authToken: 'auth-secret',
        clientSecret: 'client-secret',
        tikomniApiToken: 'tikomni-secret',
        cookie: 'session-secret',
        hasEnvKey: true,
        envKeyName: 'OPENAI_API_KEY',
      },
    };

    expect(sanitizeSupportPayload(payload)).toEqual({
      apiKey: '[secret redacted]',
      nested: {
        pairingToken: '[secret redacted]',
        authToken: '[secret redacted]',
        clientSecret: '[secret redacted]',
        tikomniApiToken: '[secret redacted]',
        cookie: '[secret redacted]',
        hasEnvKey: true,
        envKeyName: 'OPENAI_API_KEY',
      },
    });
  });

  it('redacts full local paths from nested log data', () => {
    const sanitized = sanitizeSupportPayload({ error: '/Users/customer/private/project/file.txt failed' });

    expect(JSON.stringify(sanitized)).not.toContain('/Users/customer/private/project/file.txt');
  });
});

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'echo-founder-diagnostics-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('desktop diagnostic package secure local reads', () => {
  it('reads only a bounded tail from a verified regular desktop log', async () => {
    await withTempDir(async (root) => {
      const logPath = path.join(root, 'desktop.log');
      await writeFile(logPath, `${'discarded\n'.repeat(8000)}final-safe-line\n`, { mode: 0o600 });

      const result = await readTextTail(logPath);

      expect(result.status).toBe('included_tail');
      expect(result.tailBytes).toBe(64 * 1024);
      expect(result.tail).toContain('final-safe-line');
      expect(result.tail).not.toContain('discarded\n'.repeat(8000));
    });
  });

  it('rejects a symlinked log without reading the target contents', async () => {
    await withTempDir(async (root) => {
      const victimPath = path.join(root, 'victim.txt');
      const logPath = path.join(root, 'desktop.log');
      await writeFile(victimPath, 'arbitrary-private-file-content', { mode: 0o600 });
      await symlink(victimPath, logPath);

      const result = await readTextTail(logPath);

      expect(result.status).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('arbitrary-private-file-content');
    });
  });

  it('continues reading the verified descriptor when the path is replaced after open', async () => {
    await withTempDir(async (root) => {
      const logPath = path.join(root, 'desktop.log');
      const openedPath = path.join(root, 'opened.log');
      const victimPath = path.join(root, 'victim.txt');
      await writeFile(logPath, 'verified-log-entry', { mode: 0o600 });
      await writeFile(victimPath, 'must-never-be-included', { mode: 0o600 });

      const result = await readTextTail(logPath, async (target, flags) => {
        expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
        const handle = await open(target, flags);
        await rename(target, openedPath);
        await symlink(victimPath, target);
        return handle;
      });

      expect(result.status).toBe('included_tail');
      expect(result.tail).toBe('verified-log-entry');
      expect(JSON.stringify(result)).not.toContain('must-never-be-included');
      expect(await readFile(victimPath, 'utf8')).toBe('must-never-be-included');
    });
  });

  it('fails closed if descriptor metadata changes while the log is read', async () => {
    const initial: SecureFileStats = {
      size: 16,
      dev: 1,
      ino: 2,
      mtimeMs: 100,
      nlink: 1,
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      isFile: () => true,
    };
    let statCalls = 0;
    const handle: SecureReadHandle = {
      stat: async () => {
        statCalls += 1;
        return statCalls === 1 ? initial : { ...initial, size: 17, mtimeMs: 101 };
      },
      read: async (buffer, offset, length) => {
        buffer.write('raced-file-value'.slice(0, length), offset, 'utf8');
        return { bytesRead: length };
      },
      close: async () => {},
    };

    const result = await readTextTail('/ignored/desktop.log', async () => handle);

    expect(result.status).toBe('unavailable');
    expect(result.error).toBe('diagnostic_source_changed_during_read');
    expect(JSON.stringify(result)).not.toContain('raced-file-value');
  });

  it('rejects oversized log sources before allocating their contents', async () => {
    await withTempDir(async (root) => {
      const logPath = path.join(root, 'desktop.log');
      await writeFile(logPath, 'small', { mode: 0o600 });
      await truncate(logPath, (512 * 1024 * 1024) + 1);

      const result = await readTextTail(logPath);

      expect(result.status).toBe('unavailable');
      expect(result.error).toBe('diagnostic_source_size_out_of_bounds');
    });
  });

  it('reads manifests through the verified descriptor and rejects symlink manifests', async () => {
    await withTempDir(async (root) => {
      const manifestPath = path.join(root, 'manifest.json');
      const symlinkPath = path.join(root, 'manifest-link.json');
      await writeFile(manifestPath, JSON.stringify({ status: 'pass', app_name: 'Echo Founder' }), { mode: 0o600 });
      await symlink(manifestPath, symlinkPath);

      const included = await readManifestSummary(manifestPath);
      const rejected = await readManifestSummary(symlinkPath);

      expect(included).toMatchObject({
        status: 'included_summary',
        summary: { status: 'pass', app_name: 'Echo Founder' },
      });
      expect(rejected.status).toBe('unavailable');
      expect(JSON.stringify(rejected)).not.toContain('Echo Founder');
    });
  });
});

#!/usr/bin/env node
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const gatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(
  outputIndex >= 0 ? process.argv[outputIndex + 1] || 'dist/cloudbase-gateway.zip' : 'dist/cloudbase-gateway.zip',
);

if (!output || output === gatewayRoot) throw new Error('A separate --output archive path is required.');
await mkdir(dirname(output), { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'aifios-cloudbase-bundle-'));
try {
  await cp(join(gatewayRoot, 'package.json'), join(temporary, 'package.json'));
  await cp(join(gatewayRoot, 'package-lock.json'), join(temporary, 'package-lock.json'));
  await cp(join(gatewayRoot, 'cloudbase-handler.cjs'), join(temporary, 'cloudbase-handler.cjs'));
  await cp(join(gatewayRoot, 'src'), join(temporary, 'src'), { recursive: true });
  await cp(join(gatewayRoot, 'README.md'), join(temporary, 'README.md'));

  const install = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
    cwd: temporary,
    stdio: 'inherit',
  });
  if (install.status !== 0) throw new Error(`npm ci failed with status ${install.status}`);

  const zip = spawnSync('zip', ['-qr', output, '.'], {
    cwd: temporary,
    stdio: 'inherit',
  });
  if (zip.status !== 0) throw new Error(`zip failed with status ${zip.status}`);
  console.log(`CloudBase function bundle: ${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

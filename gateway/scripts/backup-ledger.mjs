#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const source = resolve(process.env.GATEWAY_DATA_DIR || './data', 'ledger.json');
const destinationDir = resolve(process.env.GATEWAY_BACKUP_DIR || './backups');

try {
  const parsed = JSON.parse(await readFile(source, 'utf8'));
  if (!parsed || !['aifios.gateway-ledger.v1', 'aifios.gateway-ledger.v2'].includes(parsed.schema)) {
    throw new Error('source ledger schema is invalid');
  }
  await mkdir(destinationDir, { recursive: true, mode: 0o700 });
  await chmod(destinationDir, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = resolve(destinationDir, `${basename(source, '.json')}-${timestamp}.json`);
  await copyFile(source, target);
  await chmod(target, 0o600);
  await writeFile(`${target}.sha256`, `${await sha256(await readFile(target))}  ${basename(target)}\n`, { mode: 0o600 });
  await chmod(`${target}.sha256`, 0o600);
  console.log(`backup=${target} schema=${parsed.schema}`);
} catch (error) {
  console.error(`Gateway backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function sha256(value) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}

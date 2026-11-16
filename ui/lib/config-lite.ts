import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { BrandTemplate } from './brand-templates';
import { CONFIG_FILE } from './project-root';

export interface LiteConfig {
  connectionMode?: 'direct' | 'hosted';
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  gatewayUrl?: string;
  // The gateway session is a user-specific bearer credential, not an owner
  // model key. It is never included in the public settings response.
  gatewaySession?: string;
  gatewaySessionExpiresAt?: string;
  gatewayAccountLabel?: string;
  demoUnlocked?: boolean;
  // Legacy v1 builds stored the raw code. New unlocks remove this field.
  demoUnlockCode?: string;
  brandTemplates?: BrandTemplate[];
}

export async function readLiteConfig(): Promise<LiteConfig> {
  try {
    const content = await readFile(/* turbopackIgnore: true */ CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as LiteConfig;
    if (process.env.AIFIOS_DESKTOP === '1') delete config.apiKey;
    return config;
  } catch {
    return {};
  }
}

export async function writeLiteConfig(config: LiteConfig): Promise<void> {
  const persisted = { ...config };
  // Electron injects the decrypted key into the child environment. Keeping a
  // second plaintext copy in project data would defeat the desktop vault and
  // leak through unrelated config writers such as brand-template updates.
  if (process.env.AIFIOS_DESKTOP === '1') delete persisted.apiKey;
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(/* turbopackIgnore: true */ CONFIG_FILE, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  await chmod(/* turbopackIgnore: true */ CONFIG_FILE, 0o600);
}

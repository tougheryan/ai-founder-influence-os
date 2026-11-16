import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { INSTALL_ROOT, PROJECT_DIR, runtimeJoin, safeResolve } from './project-root';

export const TIKOMNI_MARKET_PLATFORMS = [
  {
    id: 'wechat_mp',
    label: '公众号',
    detail: '按行业关键词检索公众号公开文章；GHID 仅用于可选的定向账号追踪。',
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    detail: '固定执行公开内容检索。',
  },
  {
    id: 'wechat_channels',
    label: '视频号',
    detail: '固定执行公开内容检索，同时作为抖音口播研究代理。',
  },
] as const;

export type TikOmniMarketPlatformId = (typeof TIKOMNI_MARKET_PLATFORMS)[number]['id'];

function activeMarketPlatformIds(): TikOmniMarketPlatformId[] {
  // This is a commercial workflow invariant, not an operator preference.
  // A degraded platform must block stage 2 instead of silently shrinking the
  // evidence contract through a process environment override.
  return TIKOMNI_MARKET_PLATFORMS.map((platform) => platform.id);
}
type CredentialSource = 'process' | 'env_file' | 'missing';
type WechatSource = 'project_config' | 'process_env' | 'missing';
type PlatformCheckStatus = 'available' | 'unavailable' | 'unknown';

const MARKET_CONFIG_FILE = runtimeJoin(PROJECT_DIR, 'config', 'tikomni-market-research.json');
const WEEKLY_STATE_FILE = runtimeJoin(PROJECT_DIR, 'sessions', 'tikomni-weekly-market-state.json');
const MAX_TIKOMNI_TOKEN_LENGTH = 4096;
const MAX_WECHAT_GHID_LENGTH = 512;

export class TikOmniSettingsError extends Error {}

function assertPlaintextCredentialWriteAllowed(): void {
  if (process.env.AIFIOS_DESKTOP === '1') {
    throw new TikOmniSettingsError('桌面端研究服务凭据必须通过系统钥匙串管理。');
  }
}

export type TikOmniSettingsStatus = {
  credential: {
    configured: boolean;
    source: CredentialSource;
    localFileConfigured: boolean;
    endpointConfigured: boolean;
  };
  runtime: {
    providerEnabled: boolean;
    socialMediaCrawlInstalled: boolean;
  };
  wechatPublicAccount: {
    configured: boolean;
    source: WechatSource;
    configValid: boolean;
    requiredForKeywordSearch: false;
    mode: 'optional_account_tracking';
  };
  platforms: readonly (typeof TIKOMNI_MARKET_PLATFORMS)[number][];
  setup: {
    status: 'blocked' | 'ready_to_test';
    blockers: string[];
  };
  recentCollection: {
    lastAttemptAt: string | null;
    lastAttemptWeek: string | null;
    lastStatus: string | null;
    lastSuccessWeek: string | null;
    snapshotAvailable: boolean;
    collectedAt: string | null;
    sampleCount: number | null;
    platformChecks: Record<TikOmniMarketPlatformId, PlatformCheckStatus>;
  };
};

function configuredEnvFile(): string {
  const explicit = process.env.AIFIOS_TIKOMNI_ENV_FILE?.trim();
  // A packaged desktop app must never try to update Resources/aifios/.env.local:
  // that location belongs to the installed bundle and is normally read-only.
  // The Electron main process supplies its userData directory to the local
  // server, so each operator keeps their TikOmni credential in a private file
  // outside the application bundle.
  const desktopUserData = process.env.AIFIOS_DESKTOP_USER_DATA_DIR?.trim();
  const value = explicit || (desktopUserData
    ? runtimeJoin(desktopUserData, 'credentials', 'tikomni.env')
    : runtimeJoin(INSTALL_ROOT, '.env.local'));
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  return resolve(expanded);
}

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readRegularTextFile(path: string): Promise<{ exists: boolean; text: string }> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TikOmniSettingsError('本机 TikOmni 设置文件不可安全读取。');
    }
    return { exists: true, text: await readFile(path, 'utf-8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '' };
    throw error;
  }
}

function parseEnvValues(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) values[key] = value;
  }
  return values;
}

function replaceEnvValues(content: string, updates: Record<string, string | null>): string {
  const existingLines = content ? content.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of existingLines) {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !Object.prototype.hasOwnProperty.call(updates, key)) {
      lines.push(rawLine);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const value = updates[key];
    if (value !== null) lines.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key) && value !== null) lines.push(`${key}=${value}`);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.length ? `${lines.join('\n')}\n` : '';
}

async function writePrivateTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf-8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readMarketConfig(): Promise<{ config: Record<string, unknown>; valid: boolean }> {
  const file = await readRegularTextFile(MARKET_CONFIG_FILE);
  if (!file.exists || !file.text.trim()) return { config: {}, valid: true };
  try {
    const parsed = JSON.parse(file.text) as unknown;
    return isObject(parsed) ? { config: parsed, valid: true } : { config: {}, valid: false };
  } catch {
    return { config: {}, valid: false };
  }
}

function socialMediaCrawlInstalled(): boolean {
  const explicit = plainText(process.env.TIKOMNI_SOCIAL_MEDIA_CRAWL_DIR) || plainText(process.env.TIKOMNI_SKILL_DIR);
  const candidates = [
    ...(explicit ? [explicit] : []),
    runtimeJoin(INSTALL_ROOT, 'skills', 'social-media-crawl'),
    join(homedir(), '.codex', 'skills', 'social-media-crawl'),
    join(homedir(), '.agents', 'skills', 'social-media-crawl'),
    '/private/tmp/tikomni-skill-inspect/social-media-crawl',
  ];
  return candidates.some((candidate) => existsSync(join(candidate, 'scripts', 'core', 'call_tikomni_api.py')));
}

function emptyPlatformChecks(): Record<TikOmniMarketPlatformId, PlatformCheckStatus> {
  return {
    wechat_mp: 'unknown',
    xiaohongshu: 'unknown',
    wechat_channels: 'unknown',
  };
}

function platformCheckStatus(value: unknown): PlatformCheckStatus {
  if (!isObject(value)) return 'unknown';
  const status = plainText(value.status);
  if (status === 'available') return 'available';
  if (status === 'unavailable') return 'unavailable';
  return 'unknown';
}

async function readRecentCollection(): Promise<TikOmniSettingsStatus['recentCollection']> {
  const fallback: TikOmniSettingsStatus['recentCollection'] = {
    lastAttemptAt: null,
    lastAttemptWeek: null,
    lastStatus: null,
    lastSuccessWeek: null,
    snapshotAvailable: false,
    collectedAt: null,
    sampleCount: null,
    platformChecks: emptyPlatformChecks(),
  };
  const stateFile = await readRegularTextFile(WEEKLY_STATE_FILE);
  if (!stateFile.exists || !stateFile.text.trim()) return fallback;

  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stateFile.text) as unknown;
    if (!isObject(parsed)) return fallback;
    state = parsed;
  } catch {
    return fallback;
  }

  const recent = {
    ...fallback,
    lastAttemptAt: plainText(state.last_attempt_at) || null,
    lastAttemptWeek: plainText(state.last_attempt_week) || null,
    lastStatus: plainText(state.last_status) || null,
    lastSuccessWeek: plainText(state.last_success_week) || null,
  };
  const snapshotPath = plainText(state.snapshot_path);
  if (!snapshotPath) return recent;
  const safeSnapshotPath = safeResolve(PROJECT_DIR, snapshotPath);
  if (!safeSnapshotPath) return recent;

  try {
    const snapshotFile = await readRegularTextFile(safeSnapshotPath);
    if (!snapshotFile.exists) return recent;
    const snapshot = JSON.parse(snapshotFile.text) as unknown;
    if (!isObject(snapshot)) return recent;
    const checks = isObject(snapshot.platform_checks) ? snapshot.platform_checks : {};
    const sufficiency = isObject(snapshot.sufficiency) ? snapshot.sufficiency : {};
    const sampleCount = sufficiency.sample_count;
    return {
      ...recent,
      snapshotAvailable: true,
      collectedAt: plainText(snapshot.created_at) || null,
      sampleCount: typeof sampleCount === 'number' && Number.isSafeInteger(sampleCount) && sampleCount >= 0 ? sampleCount : null,
      platformChecks: {
        wechat_mp: platformCheckStatus(checks.wechat_mp),
        xiaohongshu: platformCheckStatus(checks.xiaohongshu),
        wechat_channels: platformCheckStatus(checks.wechat_channels),
      },
    };
  } catch {
    return recent;
  }
}

export async function readTikOmniSettingsStatus(): Promise<TikOmniSettingsStatus> {
  const envFile = await readRegularTextFile(configuredEnvFile());
  const envValues = parseEnvValues(envFile.text);
  const processCredential = Boolean(plainText(process.env.TIKOMNI_API_KEY) || plainText(process.env.TIKOMNI_API_TOKEN));
  const localFileCredential = Boolean(plainText(envValues.TIKOMNI_API_KEY) || plainText(envValues.TIKOMNI_API_TOKEN));
  const source: CredentialSource = processCredential ? 'process' : localFileCredential ? 'env_file' : 'missing';
  const marketConfig = await readMarketConfig();
  const wechatConfig = isObject(marketConfig.config.wechat_mp) ? marketConfig.config.wechat_mp : {};
  const projectGhid = plainText(wechatConfig.ghid);
  const environmentGhid = plainText(process.env.AIFIOS_TIKOMNI_WECHAT_MP_GHID);
  const wechatSource: WechatSource = projectGhid ? 'project_config' : environmentGhid ? 'process_env' : 'missing';
  const providerEnabled = (plainText(process.env.AIFIOS_MARKET_SIGNAL_PROVIDER) || 'tikomni').toLowerCase() === 'tikomni';
  const crawlerInstalled = socialMediaCrawlInstalled();
  const activePlatforms = activeMarketPlatformIds();
  const blockers: string[] = [];
  if (!providerEnabled) blockers.push('TikOmni 实时研究服务已被本机环境禁用。');
  if (!processCredential && !localFileCredential) blockers.push('未检测到 TikOmni Token；选题阶段会完全阻断。');
  if (!crawlerInstalled) blockers.push('未检测到本机 TikOmni 数据连接组件。');
  // The frozen market-research adapter uses the catalogued WeChat keyword
  // search endpoint. That endpoint does not accept or require a GHID. Keep
  // GHID as an optional account-tracking setting instead of blocking every
  // industry/topic search when no single public account has been selected.

  return {
    credential: {
      configured: processCredential || localFileCredential,
      source,
      localFileConfigured: localFileCredential,
      endpointConfigured: Boolean(plainText(process.env.TIKOMNI_API_BASE) || plainText(process.env.TIKOMNI_BASE_URL) || plainText(envValues.TIKOMNI_API_BASE) || plainText(envValues.TIKOMNI_BASE_URL)),
    },
    runtime: {
      providerEnabled,
      socialMediaCrawlInstalled: crawlerInstalled,
    },
    wechatPublicAccount: {
      configured: Boolean(projectGhid || environmentGhid),
      source: wechatSource,
      configValid: marketConfig.valid,
      requiredForKeywordSearch: false,
      mode: 'optional_account_tracking',
    },
    platforms: TIKOMNI_MARKET_PLATFORMS.filter((p) => activePlatforms.includes(p.id)),
    setup: {
      status: blockers.length ? 'blocked' : 'ready_to_test',
      blockers,
    },
    recentCollection: await readRecentCollection(),
  };
}

export async function saveTikOmniApiToken(value: unknown): Promise<TikOmniSettingsStatus> {
  assertPlaintextCredentialWriteAllowed();
  const token = plainText(value);
  if (!token) throw new TikOmniSettingsError('TikOmni Token 不能为空。');
  if (token.length > MAX_TIKOMNI_TOKEN_LENGTH || /[\r\n]/.test(token)) {
    throw new TikOmniSettingsError('TikOmni Token 格式不正确。');
  }
  const path = configuredEnvFile();
  const file = await readRegularTextFile(path);
  await writePrivateTextFile(path, replaceEnvValues(file.text, {
    TIKOMNI_API_KEY: token,
    TIKOMNI_API_TOKEN: null,
  }));
  return readTikOmniSettingsStatus();
}

export async function removeTikOmniApiToken(): Promise<TikOmniSettingsStatus> {
  assertPlaintextCredentialWriteAllowed();
  const path = configuredEnvFile();
  const file = await readRegularTextFile(path);
  if (file.exists) {
    await writePrivateTextFile(path, replaceEnvValues(file.text, {
      TIKOMNI_API_KEY: null,
      TIKOMNI_API_TOKEN: null,
    }));
  }
  return readTikOmniSettingsStatus();
}

export async function saveWechatPublicAccountGhid(value: unknown): Promise<TikOmniSettingsStatus> {
  const ghid = plainText(value);
  if (!ghid) throw new TikOmniSettingsError('公众号 GHID 不能为空。');
  if (ghid.length > MAX_WECHAT_GHID_LENGTH || /[\r\n]/.test(ghid)) {
    throw new TikOmniSettingsError('公众号 GHID 格式不正确。');
  }
  const file = await readRegularTextFile(MARKET_CONFIG_FILE);
  let config: Record<string, unknown> = {};
  if (file.exists && file.text.trim()) {
    try {
      const parsed = JSON.parse(file.text) as unknown;
      if (!isObject(parsed)) throw new TikOmniSettingsError('公众号研究配置文件格式无效，不能覆盖。');
      config = parsed;
    } catch (error) {
      if (error instanceof TikOmniSettingsError) throw error;
      throw new TikOmniSettingsError('公众号研究配置文件格式无效，不能覆盖。');
    }
  }
  const priorWechat = isObject(config.wechat_mp) ? config.wechat_mp : {};
  const next = {
    ...config,
    wechat_mp: {
      ...priorWechat,
      ghid,
    },
  };
  await writePrivateTextFile(MARKET_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return readTikOmniSettingsStatus();
}

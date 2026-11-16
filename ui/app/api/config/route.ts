import { NextRequest, NextResponse } from 'next/server';
import { readLiteConfig, writeLiteConfig } from '@/lib/config-lite';
import { ensureProjectInitialized } from '@/lib/project-init';
import { hostedLicenseRequired, readHostedClientBootstrap } from '@/lib/hosted-client-config';
import { HOSTED_PROVIDER, PROVIDER_PRESETS, normalizeProvider, validateLLMConfig } from '@/lib/llm-client';
import type { LLMConfig, PersistedConfig } from '@/lib/types';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';

const CONFIG_KEYS = ['provider', 'apiKey', 'model', 'baseUrl', 'temperature', 'maxTokens'];

const ENV_KEY_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  gemini: 'GEMINI_API_KEY',
  siliconflow: 'SILICONFLOW_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
};

function desktopCredentialVaultRequired(): boolean {
  return process.env.AIFIOS_DESKTOP === '1';
}

function hasEnvKey(provider: string): boolean {
  const envVar = ENV_KEY_MAP[provider];
  if (!envVar) return false;
  if (provider === 'anthropic') {
    return !!(process.env[envVar] || process.env.ANTHROPIC_AUTH_TOKEN);
  }
  return !!process.env[envVar];
}

function getEnvKeyName(provider: string): string {
  const primary = ENV_KEY_MAP[provider] || '';
  if (provider === 'anthropic' && !process.env[primary] && process.env.ANTHROPIC_AUTH_TOKEN) {
    return 'ANTHROPIC_AUTH_TOKEN';
  }
  return primary;
}

function getProviderPreset(provider: string) {
  return PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.deepseek;
}

function numericValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function publicConfig(config: PersistedConfig, provider: string, envKeyExists: boolean, envKeyName: string): LLMConfig {
  return {
    provider,
    apiKey: '',
    model: config.model,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    hasEnvKey: envKeyExists,
    envKeyName,
    hasSavedKey: Boolean(config.apiKey),
  };
}

function publicHostedConfig(saved: Awaited<ReturnType<typeof readLiteConfig>>, gatewayUrl: string): LLMConfig {
  return {
    provider: HOSTED_PROVIDER,
    apiKey: '',
    model: saved.model || 'Echo Founder Hosted',
    baseUrl: gatewayUrl,
    temperature: numericValue(saved.temperature, 0.7),
    maxTokens: numericValue(saved.maxTokens, 8000),
    connectionMode: 'hosted',
    gatewayUrl,
    gatewayConnected: Boolean(gatewayUrl && saved.gatewaySession),
    hasEnvKey: false,
    hasSavedKey: Boolean(saved.gatewaySession),
  };
}

async function activeHostedGateway(saved: Awaited<ReturnType<typeof readLiteConfig>>): Promise<string> {
  if (saved.connectionMode !== 'hosted') return '';
  const bootstrap = await readHostedClientBootstrap();
  return bootstrap?.gatewayUrl || saved.gatewayUrl || '';
}

export async function GET() {
  try {
    await ensureProjectInitialized();
    const saved = await readLiteConfig();
    const gatewayUrl = await activeHostedGateway(saved);
    if (gatewayUrl) {
      return NextResponse.json({ config: publicHostedConfig(saved, gatewayUrl) });
    }

    const licenseRequired = hostedLicenseRequired();
    const provider = normalizeProvider(saved.provider || process.env.DEFAULT_PROVIDER || 'deepseek');
    const preset = getProviderPreset(provider);
    const envKeyName = getEnvKeyName(provider);
    const envKeyExists = hasEnvKey(provider);

    const config: PersistedConfig = {
      provider,
      model: saved.model || process.env.DEFAULT_MODEL || preset.model,
      baseUrl: saved.baseUrl || process.env.DEFAULT_BASE_URL || preset.baseUrl,
      temperature: numericValue(saved.temperature ?? process.env.DEFAULT_TEMPERATURE, 0.7),
      maxTokens: numericValue(saved.maxTokens ?? process.env.DEFAULT_MAX_TOKENS, 8000),
    };
    if (saved.apiKey) config.apiKey = saved.apiKey;

    const resolved = publicConfig(config, provider, envKeyExists, envKeyName);
    if (licenseRequired) {
      resolved.licenseRequired = true;
      resolved.gatewayConnected = Boolean(saved.gatewaySession);
      if (saved.gatewayAccountLabel) resolved.gatewayAccountLabel = saved.gatewayAccountLabel;
      if (saved.gatewaySessionExpiresAt) resolved.gatewaySessionExpiresAt = saved.gatewaySessionExpiresAt;
    }
    return NextResponse.json({ config: resolved });
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取模型设置，请重试。',
      code: 'model_settings_read_failed',
      status: 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const rawBody = await req.json();
    const body = rawBody && typeof rawBody === 'object' ? rawBody as Record<string, unknown> : {};
    if (desktopCredentialVaultRequired() && Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
      return expectedUserFacingErrorResponse({
        error: '请在应用设置中保存模型密钥。桌面版会使用系统钥匙串保护它。',
        code: 'desktop_keychain_required',
        status: 400,
        action: { label: '打开设置', href: '/settings' },
      });
    }
    const result = await withProjectWriteLock('settings-config', async () => {
      const existing = { ...await readLiteConfig() };
      // A desktop child process receives its key from Electron. Even if a
      // legacy plaintext field reappears, never preserve it during a write.
      if (desktopCredentialVaultRequired()) delete existing.apiKey;
      const gatewayUrl = await activeHostedGateway(existing);
      if (gatewayUrl) {
        return { hosted: true, gatewayUrl, issues: [], provider: HOSTED_PROVIDER, merged: existing as PersistedConfig };
      }
      const payloadHasApiKey = Object.prototype.hasOwnProperty.call(body, 'apiKey');

      const updates = Object.fromEntries(
        Object.entries(body).filter(([key]) => CONFIG_KEYS.includes(key))
      ) as Partial<PersistedConfig>;
      const provider = String(updates.provider || existing.provider || 'deepseek').trim();
      const preset = getProviderPreset(provider);

      const merged: PersistedConfig = {
        provider,
        model: existing.model || preset.model,
        baseUrl: existing.baseUrl || preset.baseUrl,
        temperature: existing.temperature ?? 0.7,
        maxTokens: existing.maxTokens ?? 8000,
        ...updates,
      };

      if (!payloadHasApiKey && existing.apiKey && existing.provider === provider) {
        merged.apiKey = existing.apiKey;
      }

      const issues = validateLLMConfig(merged);
      if (issues.length > 0) {
        return { hosted: false, issues, provider, merged };
      }

      if (!merged.apiKey) {
        delete merged.apiKey;
      }

      // The brand template registry lives in the same local settings file.
      // Preserve it when API credentials are updated independently.
      const persisted = { ...existing, ...merged };
      if (!merged.apiKey) delete persisted.apiKey;
      await writeLiteConfig(persisted);
      return { hosted: false, issues: [], provider, merged };
    });
    if (result.hosted) {
      const saved = await readLiteConfig();
      return NextResponse.json({ config: publicHostedConfig(saved, result.gatewayUrl || '') });
    }
    if (result.issues.length > 0) {
      return expectedUserFacingErrorResponse({
        error: '模型设置不完整，请检查标出的项目。',
        code: 'model_settings_invalid',
        status: 400,
        extra: { issues: result.issues.map(friendlyModelSettingIssue) },
      });
    }
    return NextResponse.json({
      config: publicConfig(result.merged, result.provider, hasEnvKey(result.provider), getEnvKeyName(result.provider)),
    });
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法保存模型设置，请重试。',
      code: 'model_settings_save_failed',
      status: error instanceof WriteLockError ? 409 : 500,
    });
  }
}

function friendlyModelSettingIssue(issue: string): string {
  return issue
    .replaceAll('Provider', '模型服务')
    .replaceAll('Model', '模型名称')
    .replaceAll('Base URL', '服务地址')
    .replaceAll('Temperature', '创意程度')
    .replaceAll('Max Tokens', '最大输出长度')
    .replaceAll('API Key', '模型密钥');
}

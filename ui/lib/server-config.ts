import { readLiteConfig } from './config-lite';
import { readHostedClientBootstrap } from './hosted-client-config';
import { getProviderPreset, HOSTED_PROVIDER, isSupportedProvider, normalizeProvider } from './llm-client';
import type { LLMConfig } from './types';

function numericValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function resolveServerLLMConfig(input: Partial<LLMConfig> | undefined | null): Promise<LLMConfig> {
  const saved = await readLiteConfig();
  const hostedBootstrap = await readHostedClientBootstrap();
  if (saved.connectionMode === 'hosted') {
    const gatewayUrl = hostedBootstrap?.gatewayUrl || saved.gatewayUrl || '';
    if (gatewayUrl) {
      return {
        provider: HOSTED_PROVIDER,
        apiKey: saved.gatewaySession || '',
        model: saved.model || 'Echo Founder Hosted',
        baseUrl: gatewayUrl,
        temperature: numericValue(saved.temperature ?? process.env.DEFAULT_TEMPERATURE, 0.7),
        maxTokens: numericValue(saved.maxTokens ?? process.env.DEFAULT_MAX_TOKENS, 8000),
        connectionMode: 'hosted',
        gatewayUrl,
        gatewayConnected: Boolean(saved.gatewaySession),
      };
    }
  }
  const explicitProvider = typeof input?.provider === 'string' && input.provider.trim() ? input.provider.trim() : '';
  const rawProvider = String(explicitProvider || saved.provider || process.env.DEFAULT_PROVIDER || 'deepseek').trim();
  const provider = explicitProvider
    ? rawProvider
    : isSupportedProvider(rawProvider) ? rawProvider : normalizeProvider(rawProvider);
  const preset = getProviderPreset(provider);
  const savedKeyApplies = !saved.provider || saved.provider === provider;
  const providedKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';

  return {
    provider,
    apiKey: providedKey || (savedKeyApplies ? saved.apiKey || '' : ''),
    model: input?.model || saved.model || process.env.DEFAULT_MODEL || preset.model,
    baseUrl: input?.baseUrl || saved.baseUrl || process.env.DEFAULT_BASE_URL || preset.baseUrl,
    temperature: numericValue(input?.temperature ?? saved.temperature ?? process.env.DEFAULT_TEMPERATURE, 0.7),
    maxTokens: numericValue(input?.maxTokens ?? saved.maxTokens ?? process.env.DEFAULT_MAX_TOKENS, 8000),
  };
}

/** Only provider-reported units. Missing usage is never inferred from text length. */
export type LLMUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
};

export const emptyLLMUsage = (): LLMUsage => ({ inputTokens: null, outputTokens: null, totalTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null });
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function providerUsage(value: unknown, kind: 'openai' | 'anthropic'): LLMUsage {
  const usage = object(value);
  return {
    inputTokens: count(usage[kind === 'openai' ? 'prompt_tokens' : 'input_tokens']),
    outputTokens: count(usage[kind === 'openai' ? 'completion_tokens' : 'output_tokens']),
    totalTokens: kind === 'openai' ? count(usage.total_tokens) : null,
    cacheReadInputTokens: count(kind === 'openai' ? object(usage.prompt_tokens_details).cached_tokens ?? usage.prompt_cache_hit_tokens : usage.cache_read_input_tokens),
    cacheCreationInputTokens: kind === 'anthropic' ? count(usage.cache_creation_input_tokens) : null,
  };
}

/** Anthropic's message_delta usage is cumulative, not an increment to add. */
export function mergeLLMUsage(previous: LLMUsage, next: LLMUsage): LLMUsage {
  return Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, next[key as keyof LLMUsage] ?? value])) as LLMUsage;
}

export type LLMRequestRecord = {
  finish: (status: 'completed' | 'failed' | 'interrupted', usage: LLMUsage) => Promise<void>;
};
export type LLMRequestRecorder = (request: { provider: string; model: string; transport: 'stream' | 'completion' }) => Promise<LLMRequestRecord>;

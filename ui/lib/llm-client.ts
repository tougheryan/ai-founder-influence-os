import OpenAI from 'openai';
import { fetchHostedGatewayResponse } from './hosted-gateway-transport';
import type { LLMConfig } from './types';
import { emptyLLMUsage, mergeLLMUsage, providerUsage, type LLMUsage, type LLMRequestRecorder } from './llm-usage';

export type ProviderApiKind = 'openai-compatible' | 'anthropic-messages';

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  model: string;
  keyEnv: string;
  apiKind: ProviderApiKind;
  badge: string;
  note: string;
}

const SMOKE_PROVIDER = 'aifios-smoke';
export const HOSTED_PROVIDER = 'aifios-hosted';
const SMOKE_PROVIDER_TOKEN_ENV = 'AIFIOS_SMOKE_PROVIDER_TOKEN';
const SMOKE_PROVIDER_ENABLED_ENV = 'AIFIOS_ENABLE_SMOKE_PROVIDER';
const DEFAULT_LLM_TIMEOUT_MS = 120000;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /sk-proj-[A-Za-z0-9_-]{12,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
];

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    keyEnv: 'OPENAI_API_KEY',
    apiKind: 'openai-compatible',
    badge: '官方',
    note: '适合复杂推理、长文和高质量内容生产。',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    apiKind: 'openai-compatible',
    badge: '官方兼容',
    note: 'OpenAI-compatible，适合成本敏感的长上下文生产。',
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-3.5-flash',
    keyEnv: 'GEMINI_API_KEY',
    apiKind: 'openai-compatible',
    badge: '官方兼容',
    note: 'Google 官方 OpenAI-compatible 入口，适合轻量快速任务。',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/',
    model: 'claude-opus-4-8',
    keyEnv: 'ANTHROPIC_API_KEY',
    apiKind: 'anthropic-messages',
    badge: '专用适配',
    note: '使用 Anthropic Messages API，适合高质量推理和风格保持；Opus 4.7+ 会自动省略采样参数。',
  },
  siliconflow: {
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'zai-org/GLM-5.2',
    keyEnv: 'SILICONFLOW_API_KEY',
    apiKind: 'openai-compatible',
    badge: '聚合兼容',
    note: 'OpenAI-compatible 聚合入口，具体模型权限以控制台为准。',
  },
  dashscope: {
    label: 'DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-max',
    keyEnv: 'DASHSCOPE_API_KEY',
    apiKind: 'openai-compatible',
    badge: '官方兼容',
    note: '阿里云百炼 OpenAI-compatible 入口，适合 Qwen 系列模型。',
  },
  moonshot: {
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    keyEnv: 'MOONSHOT_API_KEY',
    apiKind: 'openai-compatible',
    badge: '官方兼容',
    note: 'Kimi 官方兼容接口，适合长上下文与 Agent 类任务。',
  },
};

export function getProviderPreset(provider: string): ProviderPreset {
  return PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.deepseek;
}

export function isSupportedProvider(provider: string): boolean {
  return provider === SMOKE_PROVIDER || provider === HOSTED_PROVIDER || Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, provider);
}

export function normalizeProvider(provider: string | undefined | null): string {
  const value = String(provider || '').trim();
  return Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, value) ? value : 'deepseek';
}

export function assertSupportedProvider(provider: string): void {
  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported provider "${provider}"`);
  }
}

export function getApiKey(config: LLMConfig): string {
  if (config.provider === HOSTED_PROVIDER) return config.apiKey;
  const preset = getProviderPreset(config.provider);
  const envKey = process.env[preset.keyEnv] || '';
  const fallbackKey = config.provider === 'anthropic' ? process.env.ANTHROPIC_AUTH_TOKEN || '' : '';
  return config.apiKey || envKey || fallbackKey;
}

function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);
}

export function buildClient(config: LLMConfig): OpenAI {
  if (config.provider === SMOKE_PROVIDER || config.provider === HOSTED_PROVIDER) {
    throw new Error(`${config.provider} provider is only available through createLLMTextStream/createLLMTextCompletion.`);
  }
  assertSupportedProvider(config.provider);
  const preset = getProviderPreset(config.provider);
  const apiKey = getApiKey(config);
  const baseURL = config.baseUrl || preset.baseUrl;

  if (!apiKey) {
    throw new Error(`Missing API key for provider "${config.provider}"`);
  }

  return new OpenAI({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: false,
    timeout: DEFAULT_LLM_TIMEOUT_MS,
  });
}

export function getModel(config: LLMConfig): string {
  if (config.provider === HOSTED_PROVIDER) return config.model || 'Echo Founder Hosted';
  const preset = getProviderPreset(config.provider);
  return config.model || preset.model;
}

export function explainLLMError(error: unknown): string {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  const lower = message.toLowerCase();

  if (lower.includes('unsupported provider')) return '当前 Provider 不受支持，请回到设置页选择系统内置 Provider。';
  if (lower.includes('gateway') || lower.includes('邀请码') || lower.includes('授权码') || lower.includes('登录状态')) return message || '托管服务连接失败，请检查授权状态后重试。';
  if (lower.includes('missing api key')) return '缺少 API Key，请填写密钥或配置对应环境变量。';
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return 'API Key 无效或无权限，请检查密钥是否正确。';
  }
  if (lower.includes('404') || lower.includes('model')) {
    return '模型名称不可用，请检查当前 Provider 是否支持该模型。';
  }
  if (lower.includes('http/2 stream failed') || lower.includes('http2 stream failed')) {
    return '模型服务的流式连接中断。请先查看已保存结果和调用记录，再决定是否重试；再次调用可能产生费用。';
  }
  if (lower.includes('baseurl') || lower.includes('base url') || lower.includes('fetch failed') || lower.includes('enotfound')) {
    return 'Base URL 或网络连接异常，请检查接口地址。';
  }
  if (lower.includes('timeout')) return '模型接口响应超时，请检查网络、Base URL 或稍后重试。';

  return message || '模型调用失败，请检查 Provider、模型、Base URL 和 API Key。';
}

export function validateLLMConfig(config: Partial<LLMConfig>): string[] {
  const issues: string[] = [];
  const provider = String(config.provider || '').trim();
  if (!provider) {
    issues.push('Provider 不能为空。');
  } else if (!isSupportedProvider(provider)) {
    issues.push(`Provider 不受支持：${provider}`);
  }

  if (provider === HOSTED_PROVIDER) {
    if (!String(config.apiKey || '').trim()) issues.push('授权登录状态缺失，请重新激活。');
    const gatewayUrl = String(config.baseUrl || config.gatewayUrl || '').trim();
    try {
      const parsed = new URL(gatewayUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) issues.push('托管服务地址格式不正确。');
    } catch {
      issues.push('托管服务地址格式不正确。');
    }
    return issues;
  }

  const model = String(config.model || '').trim();
  if (!model) issues.push('Model 不能为空。');

  const baseUrl = String(config.baseUrl || '').trim();
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        issues.push('Base URL 只支持 http 或 https。');
      }
    } catch {
      issues.push('Base URL 格式不正确。');
    }
  }

  if (config.temperature !== undefined) {
    const temperature = Number(config.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      issues.push('Temperature 必须在 0 到 2 之间。');
    }
  }

  if (config.maxTokens !== undefined) {
    const maxTokens = Number(config.maxTokens);
    if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > 200000) {
      issues.push('Max Tokens 必须在 1 到 200000 之间。');
    }
  }

  return issues;
}

export function shouldOmitAnthropicSamplingParams(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith('claude-opus-4-7') ||
    normalized.startsWith('claude-opus-4-8') ||
    normalized.startsWith('claude-sonnet-5')
  );
}

function buildAnthropicPayload(
  config: LLMConfig,
  options: ChatOptions,
  payload: {
    system?: string;
    messages: unknown;
    stream: boolean;
  }
) {
  const model = options.model || getModel(config);
  return {
    model,
    max_tokens: options.maxTokens ?? config.maxTokens ?? 8000,
    ...(!shouldOmitAnthropicSamplingParams(model)
      ? { temperature: options.temperature ?? config.temperature ?? 0.7 }
      : {}),
    system: payload.system || undefined,
    messages: payload.messages,
    stream: payload.stream,
  };
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  recordRequest?: LLMRequestRecorder;
  /** Internal provider usage sink; contains no content or credentials. */
  onUsage?: (usage: LLMUsage) => void;
}

function requestTimeout(options: ChatOptions): number {
  return options.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    error instanceof Error && error.name === 'AbortError'
  );
}

async function withTimeout<T>(
  timeoutMs: number,
  action: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await action(controller.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`LLM request timeout after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createChatCompletion(
  client: OpenAI,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: ChatOptions = {}
) {
  const { temperature = 0.7, maxTokens = 8000, stream = false, model } = options;

  return client.chat.completions.create({
    model: model || PROVIDER_PRESETS.deepseek.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream,
  }, { timeout: requestTimeout(options) });
}

// A bound production request is never silently retried, including by the SDK.
// Records describe service responses, not whether the author adopted an article.
function assertRecordableConfig(config: LLMConfig) {
  if (validateLLMConfig(config).length || !getApiKey(config).trim()) throw new Error('请先完成模型连接，本次尚未调用生成服务。');
}

async function finishRequest(record: Awaited<ReturnType<LLMRequestRecorder>>, status: 'completed' | 'failed' | 'interrupted', usage: LLMUsage) {
  try { await record.finish(status, usage); }
  catch { console.warn('Model request result could not be recorded; it must not trigger another paid request.'); }
}

export async function createLLMTextStream(config: LLMConfig, messages: OpenAI.Chat.ChatCompletionMessageParam[], options: ChatOptions = {}): Promise<AsyncIterable<string>> {
  if (!options.recordRequest || config.provider === SMOKE_PROVIDER) return createUnrecordedTextStream(config, messages, options);
  assertRecordableConfig(config);
  return (async function* recordedStream() {
    let usage = emptyLLMUsage();
    const record = await options.recordRequest!({ provider: config.provider, model: options.model || getModel(config), transport: 'stream' });
    let status: 'completed' | 'failed' | 'interrupted' = 'interrupted';
    try {
      const stream = await createUnrecordedTextStream(config, messages, { ...options, maxRetries: 0, onUsage: (next) => { usage = mergeLLMUsage(usage, next); } });
      let received = false;
      for await (const chunk of stream) { if (chunk.trim()) received = true; yield chunk; }
      status = received ? 'completed' : 'failed';
    } catch (error) { status = 'failed'; throw error; }
    finally { await finishRequest(record, status, usage); }
  })();
}

export async function createLLMTextCompletion(config: LLMConfig, messages: OpenAI.Chat.ChatCompletionMessageParam[], options: ChatOptions = {}): Promise<string> {
  if (!options.recordRequest || config.provider === SMOKE_PROVIDER) return createUnrecordedTextCompletion(config, messages, options);
  assertRecordableConfig(config);
  let usage = emptyLLMUsage();
  const record = await options.recordRequest({ provider: config.provider, model: options.model || getModel(config), transport: 'completion' });
  let status: 'completed' | 'failed' = 'failed';
  try {
    const text = await createUnrecordedTextCompletion(config, messages, { ...options, maxRetries: 0, onUsage: (next) => { usage = mergeLLMUsage(usage, next); } });
    if (text.trim()) status = 'completed';
    return text;
  } finally { await finishRequest(record, status, usage); }
}

async function createUnrecordedTextStream(
  config: LLMConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: ChatOptions = {}
): Promise<AsyncIterable<string>> {
  if (config.provider === SMOKE_PROVIDER) {
    assertSmokeProviderEnabled(config);
    const text = smokeResponseText(messages);
    return (async function* smokeStream() {
      yield text;
    })();
  }

  if (config.provider === HOSTED_PROVIDER) {
    return createHostedTextStream(config, messages, options);
  }

  const preset = getProviderPreset(config.provider);
  if (preset.apiKind === 'anthropic-messages') {
    return createAnthropicTextStream(config, messages, options);
  }

  const client = buildClient(config);
  // Paid draft generation checkpoints each delta. Never hide a failed stream
  // behind a second paid request when the caller explicitly disables retries.
  if (options.maxRetries === 0) {
    return (async function* incrementalStream() {
      const response = await client.chat.completions.create({
        model: options.model || getModel(config), messages,
        temperature: options.temperature ?? config.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? config.maxTokens ?? 8000, stream: true,
        ...(options.onUsage ? { stream_options: { include_usage: true } } : {}),
      }, { timeout: requestTimeout(options), maxRetries: 0 });
      let finishReason: string | null = null;
      for await (const chunk of response) {
        if (chunk.usage) options.onUsage?.(providerUsage(chunk.usage, 'openai'));
        const choice = chunk.choices[0];
        if (choice?.delta?.content) yield choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
      if (finishReason !== 'stop') throw new Error(finishReason === 'length'
        ? '生成达到服务长度限制，已收到的文字保留，请补写未完成部分。'
        : '生成服务没有确认完整结束，已收到的文字保留，不会自动重新调用。');
    })();
  }
  return (async function* openAIStream() {
    const chunks: string[] = [];
    let streamCompleted = false;
    try {
      const response = await client.chat.completions.create({
        model: options.model || getModel(config),
        messages,
        temperature: options.temperature ?? config.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? config.maxTokens ?? 8000,
        stream: true,
      }, { timeout: requestTimeout(options) });

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) chunks.push(delta);
      }
      streamCompleted = true;
    } catch {
      // A transport failure mid-stream truncates the output (e.g. a SHA-256 cut
      // short). Fall through to the non-streaming completion below rather than
      // surfacing a half-written result.
    }

    if (streamCompleted && chunks.length > 0) {
      for (const chunk of chunks) yield chunk;
      return;
    }

    // The stream either failed or produced nothing. Some OpenAI-compatible
    // relays accept regular completions but close their HTTP/2 event stream
    // early, so retry once without streaming.
    try {
      const completion = await client.chat.completions.create({
        model: options.model || getModel(config),
        messages,
        temperature: options.temperature ?? config.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? config.maxTokens ?? 8000,
        stream: false,
      }, { timeout: requestTimeout(options) });
      const content = completion.choices[0]?.message?.content;
      if (content) {
        yield content;
        return;
      }
    } catch {
      // Completion also failed; fall back to whatever the stream produced.
    }

    for (const chunk of chunks) yield chunk;
  })();
}

async function createUnrecordedTextCompletion(
  config: LLMConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: ChatOptions = {}
): Promise<string> {
  if (config.provider === SMOKE_PROVIDER) {
    assertSmokeProviderEnabled(config);
    return smokeResponseText(messages);
  }

  if (config.provider === HOSTED_PROVIDER) {
    return createHostedTextCompletion(config, messages, options);
  }

  const preset = getProviderPreset(config.provider);
  if (preset.apiKind === 'anthropic-messages') {
    return createAnthropicTextCompletion(config, messages, options);
  }

  const client = buildClient(config);
  const response = await client.chat.completions.create({
    model: options.model || getModel(config),
    messages,
    temperature: options.temperature ?? config.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? config.maxTokens ?? 8000,
    stream: false,
  }, { timeout: requestTimeout(options), maxRetries: options.maxRetries });

  if (response.usage) options.onUsage?.(providerUsage(response.usage, 'openai'));
  return response.choices[0]?.message?.content?.trim() || '';
}

function hostedGatewayUrl(config: LLMConfig): string {
  const raw = String(config.gatewayUrl || config.baseUrl || '').trim();
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error('托管服务地址无效，请重新激活授权码。');
  }
}

function hostedMessages(messages: OpenAI.Chat.ChatCompletionMessageParam[]) {
  return messages
    .filter((message) => ['system', 'user', 'assistant'].includes(message.role))
    .map((message) => ({ role: message.role, content: messageContentToText(message) }))
    .filter((message) => message.content.trim());
}

async function requestHostedGateway(
  config: LLMConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: ChatOptions,
  stream: boolean,
): Promise<Response> {
  const token = String(config.apiKey || '').trim();
  if (!token) throw new Error('授权登录状态缺失，请重新激活。');
  const response = await withTimeout(requestTimeout(options), (signal) => fetchHostedGatewayResponse(
    hostedGatewayUrl(config),
    '/v1/llm/chat',
    {
    method: 'POST',
    token,
    signal,
    body: {
      messages: hostedMessages(messages),
      options: {
        temperature: options.temperature ?? config.temperature ?? 0.7,
        maxTokens: options.maxTokens ?? config.maxTokens ?? 8000,
      },
      stream,
    },
  }));
  if (response.ok) return response;
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  throw new Error(payload?.error?.message || `托管服务请求失败（${response.status}）。`);
}

async function createHostedTextStream(
  config: LLMConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: ChatOptions,
): Promise<AsyncIterable<string>> {
  const response = await requestHostedGateway(config, messages, options, true);
  if (!response.body) throw new Error('托管服务没有返回生成内容。');
  return parseHostedStream(response.body, options.maxRetries === 0);
}

async function createHostedTextCompletion(
  config: LLMConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: ChatOptions,
): Promise<string> {
  const response = await requestHostedGateway(config, messages, options, false);
  const payload = await response.json().catch(() => null) as { content?: unknown } | null;
  if (typeof payload?.content !== 'string') throw new Error('托管服务没有返回生成内容。');
  return payload.content.trim();
}

async function* parseHostedStream(body: ReadableStream<Uint8Array>, requireCompletion = false): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let dataLines: string[] = [];
  let completed = false;

  const consumeEvent = () => {
    if (!dataLines.length) return null;
    const payload = dataLines.join('\n');
    const currentEvent = event;
    event = '';
    dataLines = [];
    return { event: currentEvent, payload };
  };

  const parseEvent = (current: { event: string; payload: string } | null): string | null => {
    if (!current) return null;
    let payload: { type?: string; content?: string; message?: string };
    try {
      payload = JSON.parse(current.payload) as { type?: string; content?: string; message?: string };
    } catch {
      return null;
    }
    if (current.event === 'error') throw new Error(payload.message || '托管服务生成中断，请稍后重试。');
    if (current.event === 'done') { completed = true; return null; }
    return payload.type === 'text' && typeof payload.content === 'string' ? payload.content : null;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) {
        const text = parseEvent(consumeEvent());
        if (text) yield text;
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.startsWith('event:')) event = buffer.slice(6).trim();
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trim());
  const text = parseEvent(consumeEvent());
  if (text) yield text;
  if (requireCompletion && !completed) throw new Error('托管服务没有确认完整结束，已收到的文字保留，不会自动重新调用。');
}

function assertSmokeProviderEnabled(config: LLMConfig): void {
  const expectedToken = process.env[SMOKE_PROVIDER_TOKEN_ENV] || '';
  const enabled = process.env[SMOKE_PROVIDER_ENABLED_ENV] === '1';
  const packagedDesktop = process.env.AIFIOS_DESKTOP === '1'
    && process.env.AIFIOS_NEXT_STANDALONE === '1';
  if (packagedDesktop || process.env.NODE_ENV === 'production' || !enabled || !expectedToken || config.apiKey !== expectedToken) {
    throw new Error('aifios-smoke provider is disabled outside release smoke tests.');
  }
}

function smokeResponseText(messages: OpenAI.Chat.ChatCompletionMessageParam[]): string {
  const text = messages.map(messageContentToText).join('\n\n');
  if (text.includes('请只回复 OK')) return 'OK';
  return [
    '# AIFIOS Smoke Agent Output',
    '',
    '## 0. 内容元信息',
    '- 来源：前端 smoke 本地回显 provider',
    '',
    '## 1. 表现记录',
    '| 平台 | 阅读量 | 互动量 | 收藏/转发 | 评论数 | 转化 |',
    '|---|---:|---:|---:|---:|---|',
    '| 公众号 | 1200 | 86 | 42 | 18 | 3 条咨询线索 |',
    '',
    '## 2. 复盘/归档/观察摘要',
    '- 该输出用于验证 agent invoke 的 runtime 写回和 run 绑定，不作为真实内容质量样例。',
    '',
    '## 3. 评论洞察',
    '- 高频词：真实、卡住、开头。',
    '',
    '## 4. 用户问题归类',
    '| 问题类型 | 数量 | 典型问题 | 是否值得单独成题 |',
    '|---|---:|---|---|',
    '| 开头表达 | 6 | 第一篇怎么写 | 是 |',
    '',
    '## 5. 选题命中率',
    '- 临时观察：可进入下一轮选题校准。',
    '',
    '## 6. 选题优化',
    '- 命中点：先讲客户问题。',
    '- 失误点：细节仍需补强。',
    '',
    '## 7. 下一条建议',
    '- 推荐选题 1：第一篇内容怎么开头。',
    '- 推荐选题 2：咨询服务如何降低销售感。',
    '',
    '## 8. 洞察沉淀',
    '- 已写入 brain/insights.md：smoke 验证项。',
    '',
  ].join('\n');
}

async function createAnthropicTextStream(
  config: LLMConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: ChatOptions
): Promise<AsyncIterable<string>> {
  const apiKey = getApiKey(config);
  if (!apiKey) {
    throw new Error(`Missing API key for provider "${config.provider}"`);
  }

  const preset = getProviderPreset(config.provider);
  const baseUrl = config.baseUrl || preset.baseUrl;
  const endpoint = new URL('messages', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const normalized = normalizeAnthropicMessages(messages);
  const system = messages
    .filter((message) => message.role === 'system')
    .map(messageContentToText)
    .filter(Boolean)
    .join('\n\n');

  const response = await withTimeout(requestTimeout(options), (signal) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal,
    body: JSON.stringify(buildAnthropicPayload(config, options, {
      system: system || undefined,
      messages: normalized,
      stream: true,
    })),
  }));

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Anthropic API 错误：${errorText || response.statusText}`);
  }

  return parseAnthropicStream(response.body, options.maxRetries === 0, options.onUsage);
}

async function createAnthropicTextCompletion(
  config: LLMConfig,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  options: ChatOptions
): Promise<string> {
  const apiKey = getApiKey(config);
  if (!apiKey) {
    throw new Error(`Missing API key for provider "${config.provider}"`);
  }

  const preset = getProviderPreset(config.provider);
  const baseUrl = config.baseUrl || preset.baseUrl;
  const endpoint = new URL('messages', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const normalized = normalizeAnthropicMessages(messages);
  const system = messages
    .filter((message) => message.role === 'system')
    .map(messageContentToText)
    .filter(Boolean)
    .join('\n\n');

  const response = await withTimeout(requestTimeout(options), (signal) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal,
    body: JSON.stringify(buildAnthropicPayload(config, options, {
      system: system || undefined,
      messages: normalized,
      stream: false,
    })),
  }));

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Anthropic API 错误：${errorText || response.statusText}`);
  }

  const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }>; usage?: unknown };
  options.onUsage?.(providerUsage(data.usage, 'anthropic'));
  return data.content?.find((item) => item.type === 'text' && item.text)?.text?.trim() || '';
}

function normalizeAnthropicMessages(messages: OpenAI.Chat.ChatCompletionMessageParam[]) {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: messageContentToText(message),
    }))
    .filter((message) => message.content.trim().length > 0);
}

function messageContentToText(message: OpenAI.Chat.ChatCompletionMessageParam): string {
  const content = 'content' in message ? message.content : '';
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      if (part && typeof part === 'object' && 'type' in part && part.type === 'image_url') {
        return '[图片输入]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function* parseAnthropicStream(body: ReadableStream<Uint8Array>, requireCompletion = false, onUsage?: (usage: LLMUsage) => void): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  while (true) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      const event = JSON.parse(payload) as {
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
        message?: { usage?: unknown };
        usage?: unknown;
        error?: { message?: string };
      };

      if (event.type === 'message_start') onUsage?.(providerUsage(event.message?.usage, 'anthropic'));
      if (event.type === 'message_delta') onUsage?.(providerUsage(event.usage, 'anthropic'));
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        yield event.delta.text;
      }
      if (event.type === 'error') {
        throw new Error(event.error?.message || 'Anthropic 流式响应失败');
      }
      if (event.type === 'message_stop') completed = true;
      if (requireCompletion && event.type === 'message_delta' && event.delta?.stop_reason === 'max_tokens') throw new Error('生成达到服务长度限制，已收到的文字保留，请补写未完成部分。');
    }
    if (done) break;
  }
  if (requireCompletion && !completed) throw new Error('生成服务没有确认完整结束，已收到的文字保留，不会自动重新调用。');
}

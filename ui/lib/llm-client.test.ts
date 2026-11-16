import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: mocks.create } };
  },
}));

import { createLLMTextCompletion, createLLMTextStream } from './llm-client';
import { emptyLLMUsage } from './llm-usage';

const config = {
  provider: 'openai',
  apiKey: 'test-key',
  baseUrl: 'https://relay.example/v1',
  model: 'test-model',
  temperature: 0.7,
  maxTokens: 100,
};

describe('recorded production requests', () => {
  afterEach(() => { mocks.create.mockReset(); vi.unstubAllGlobals(); });
  const messages = [{ role: 'user' as const, content: 'private article content' }];
  const recorder = () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    return { finish, recordRequest: vi.fn().mockResolvedValue({ finish }) };
  };
  it('records a single completion and provider usage without exposing content or credentials', async () => {
    const tracking = recorder();
    mocks.create.mockResolvedValue({ choices: [{ message: { content: '完成' } }], usage: { prompt_tokens: 17, completion_tokens: 8, total_tokens: 25, prompt_tokens_details: { cached_tokens: 0 } } });
    expect(await createLLMTextCompletion(config, messages, tracking)).toBe('完成');
    expect(tracking.recordRequest).toHaveBeenCalledWith({ provider: 'openai', model: 'test-model', transport: 'completion' });
    expect(tracking.finish).toHaveBeenCalledWith('completed', { inputTokens: 17, outputTokens: 8, totalTokens: 25, cacheReadInputTokens: 0, cacheCreationInputTokens: null });
    expect(mocks.create.mock.calls[0][1].maxRetries).toBe(0);
    expect(JSON.stringify(tracking.recordRequest.mock.calls)).not.toMatch(/test-key|private article content|relay.example/);
  });
  it('reads the final OpenAI usage-only chunk after the finish signal', async () => {
    const tracking = recorder();
    mocks.create.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: '一段' }, finish_reason: 'stop' }] };
      yield { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_cache_hit_tokens: 4 } };
    })());
    const stream = await createLLMTextStream(config, messages, tracking);
    expect(tracking.recordRequest).not.toHaveBeenCalled();
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual(['一段']);
    expect(tracking.finish).toHaveBeenCalledWith('completed', expect.objectContaining({ inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadInputTokens: 4 }));
    expect(mocks.create.mock.calls[0][0].stream_options).toEqual({ include_usage: true });
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('records an interrupted paid stream once and never falls back to another request', async () => {
    const tracking = recorder();
    mocks.create.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: '已收到' } }] };
      throw new Error('private upstream error');
    })());
    const stream = await createLLMTextStream(config, messages, tracking);
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('已收到');
    await expect(iterator.next()).rejects.toThrow('private upstream error');
    expect(tracking.finish).toHaveBeenCalledWith('failed', emptyLLMUsage());
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('marks consumer abandonment as unconfirmed, without claiming a successful response', async () => {
    const tracking = recorder();
    mocks.create.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: '先收到' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    })());
    for await (const chunk of await createLLMTextStream(config, messages, tracking)) { expect(chunk).toBe('先收到'); break; }
    expect(tracking.finish).toHaveBeenCalledWith('interrupted', emptyLLMUsage());
  });
  it('never calls the model when the initial record cannot be saved', async () => {
    const recordRequest = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    await expect(createLLMTextCompletion(config, messages, { recordRequest })).rejects.toThrow('storage unavailable');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('does not lose the response or retry the model when the result record cannot be saved', async () => {
    const tracking = recorder(); tracking.finish.mockRejectedValue(new Error('storage unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.create.mockResolvedValue({ choices: [{ message: { content: '已完成' } }] });
    try {
      expect(await createLLMTextCompletion(config, messages, tracking)).toBe('已完成');
      expect(mocks.create).toHaveBeenCalledOnce(); expect(tracking.finish).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });
  it('does not create an external-call record for a local configuration error', async () => {
    const tracking = recorder();
    await expect(createLLMTextCompletion({ ...config, provider: 'unsupported' }, messages, tracking)).rejects.toThrow('尚未调用');
    expect(tracking.recordRequest).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('keeps a successful response with missing usage unknown, while an empty response is not success', async () => {
    const tracking = recorder();
    mocks.create.mockResolvedValueOnce({ choices: [{ message: { content: '成功' } }], usage: { prompt_tokens: '10', completion_tokens: -1 } });
    await createLLMTextCompletion(config, messages, tracking);
    expect(tracking.finish).toHaveBeenLastCalledWith('completed', emptyLLMUsage());
    mocks.create.mockResolvedValueOnce({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } });
    await createLLMTextCompletion(config, messages, tracking);
    expect(tracking.finish).toHaveBeenLastCalledWith('failed', expect.objectContaining({ inputTokens: 5, outputTokens: 0 }));
  });
  it('merges Anthropic cumulative usage without double-counting output or cache tokens', async () => {
    const tracking = recorder();
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '内容' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))));
    const stream = await createLLMTextStream({ ...config, provider: 'anthropic' }, messages, tracking);
    for await (const chunk of stream) expect(chunk).toBe('内容');
    expect(tracking.finish).toHaveBeenCalledWith('completed', { inputTokens: 20, outputTokens: 9, totalTokens: null, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 });
  });
  it('records a hosted request without converting quota or text length into token usage', async () => {
    const tracking = recorder();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: '已完成', quota: { used: 1 } }))));
    await createLLMTextCompletion({ ...config, provider: 'aifios-hosted', gatewayUrl: 'https://gateway.example' }, messages, tracking);
    expect(tracking.finish).toHaveBeenCalledWith('completed', emptyLLMUsage());
  });
});

describe('createLLMTextStream', () => {
  afterEach(() => mocks.create.mockReset());
  it('falls back to a normal completion when an OpenAI-compatible stream fails before content', async () => {
    async function* failedStream() {
      throw new Error('Upstream HTTP/2 stream failed');
    }
    mocks.create
      .mockResolvedValueOnce(failedStream())
      .mockResolvedValueOnce({ choices: [{ message: { content: '可继续生成' } }] });

    const stream = await createLLMTextStream(config, [{ role: 'user', content: '测试' }]);
    const output: string[] = [];
    for await (const chunk of stream) output.push(chunk);

    expect(output).toEqual(['可继续生成']);
    expect(mocks.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ stream: true }), expect.anything());
    expect(mocks.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ stream: false }), expect.anything());
  });
  it('delivers paid draft chunks before completion and never retries an interrupted stream', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    async function* interrupted() {
      yield { choices: [{ delta: { content: '已经收到的第一段' } }] };
      await wait;
      throw new Error('connection interrupted');
    }
    mocks.create.mockResolvedValueOnce(interrupted());
    const stream = await createLLMTextStream(config, [{ role: 'user', content: '测试' }], { maxRetries: 0 });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('已经收到的第一段');
    release();
    await expect(iterator.next()).rejects.toThrow('connection interrupted');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][1].maxRetries).toBe(0);
  });
  it.each([null, 'length'])('keeps incomplete paid output when the stream finishes with %s', async (finish_reason) => {
    mocks.create.mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: '收到但没有写完' }, finish_reason }] };
    })());
    const stream = await createLLMTextStream(config, [{ role: 'user', content: '测试' }], { maxRetries: 0 });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('收到但没有写完');
    await expect(iterator.next()).rejects.toThrow();
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('accepts a completed paid stream without requesting a second completion', async () => {
    mocks.create.mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: '完整文字' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    })());
    const stream = await createLLMTextStream(config, [{ role: 'user', content: '测试' }], { maxRetries: 0 });
    const output: string[] = [];
    for await (const chunk of stream) output.push(chunk);
    expect(output).toEqual(['完整文字']);
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});

describe('release smoke provider boundary', () => {
  const keys = [
    'AIFIOS_ENABLE_SMOKE_PROVIDER',
    'AIFIOS_SMOKE_PROVIDER_TOKEN',
    'AIFIOS_DESKTOP',
    'AIFIOS_NEXT_STANDALONE',
    'NODE_ENV',
  ] as const;

  async function withEnvironment(
    values: Partial<Record<(typeof keys)[number], string>>,
    task: () => Promise<void>,
  ) {
    const mutableEnvironment = process.env as Record<string, string | undefined>;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) {
      if (values[key] === undefined) delete mutableEnvironment[key];
      else mutableEnvironment[key] = values[key];
    }
    try {
      await task();
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete mutableEnvironment[key];
        else mutableEnvironment[key] = previous[key];
      }
    }
  }

  it('works only in an explicit non-production source smoke process', async () => {
    await withEnvironment({
      AIFIOS_ENABLE_SMOKE_PROVIDER: '1',
      AIFIOS_SMOKE_PROVIDER_TOKEN: 'source-smoke-token',
      NODE_ENV: 'test',
    }, async () => {
      const content = await createLLMTextCompletion({
        provider: 'aifios-smoke',
        apiKey: 'source-smoke-token',
        baseUrl: 'http://127.0.0.1',
        model: 'smoke',
      }, [{ role: 'user', content: 'smoke' }]);
      expect(content).toContain('Smoke Agent Output');
    });
  });

  it('is disabled inside packaged desktop even when inherited flags and token match', async () => {
    await withEnvironment({
      AIFIOS_ENABLE_SMOKE_PROVIDER: '1',
      AIFIOS_SMOKE_PROVIDER_TOKEN: 'poisoned-smoke-token',
      AIFIOS_DESKTOP: '1',
      AIFIOS_NEXT_STANDALONE: '1',
      NODE_ENV: 'test',
    }, async () => {
      await expect(createLLMTextCompletion({
        provider: 'aifios-smoke',
        apiKey: 'poisoned-smoke-token',
        baseUrl: 'http://127.0.0.1',
        model: 'smoke',
      }, [{ role: 'user', content: 'write fake runtime content' }]))
        .rejects.toThrow('disabled outside release smoke tests');
    });
  });
});

describe('hosted gateway model calls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends only the session token to the gateway and accepts a managed completion', async () => {
    let requestInit: RequestInit | undefined;
    const gatewayFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({ content: '托管完成' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', gatewayFetch);

    const content = await createLLMTextCompletion({
      provider: 'aifios-hosted',
      apiKey: 'friend-session-token',
      baseUrl: 'https://gateway.example.com',
      model: 'AIFIOS Hosted',
      temperature: 0.7,
      maxTokens: 100,
    }, [{ role: 'user', content: '测试' }]);

    expect(content).toBe('托管完成');
    expect(gatewayFetch).toHaveBeenCalledWith(
      'https://gateway.example.com/v1/llm/chat',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer friend-session-token' }),
      }),
    );
    const requestBody = JSON.parse(String(requestInit?.body || ''));
    expect(requestBody).not.toHaveProperty('model');
    expect(requestBody).not.toHaveProperty('apiKey');
  });
});

describe('native provider interruption checkpoints', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['aifios-hosted', 'anthropic'])('retains partial %s text and rejects a response without a completion event', async (provider) => {
    const partial = provider === 'anthropic'
      ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"已收到的文字"}}\n\n'
      : 'event: text\ndata: {"type":"text","content":"已收到的文字"}\n\n';
    const fetch = vi.fn().mockResolvedValue(new Response(partial));
    vi.stubGlobal('fetch', fetch);
    const stream = await createLLMTextStream({ ...config, provider }, [{ role: 'user', content: '测试' }], { maxRetries: 0 });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('已收到的文字');
    await expect(iterator.next()).rejects.toThrow('没有确认完整结束');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['aifios-hosted', 'anthropic'])('accepts the explicit %s completion event', async (provider) => {
    const content = provider === 'anthropic'
      ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"完整文字"}}\n\ndata: {"type":"message_stop"}'
      : 'event: text\ndata: {"type":"text","content":"完整文字"}\n\nevent: done\ndata: {"type":"done"}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(content)));
    const stream = await createLLMTextStream({ ...config, provider }, [{ role: 'user', content: '测试' }], { maxRetries: 0 });
    const output: string[] = [];
    for await (const chunk of stream) output.push(chunk);
    expect(output).toEqual(['完整文字']);
  });
});

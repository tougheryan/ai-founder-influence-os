import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { GatewayStore, GatewayStoreError } from './store.mjs';
import { HostedMarketResearchError, readHostedMarketResearchConfig, runHostedMarketResearch } from './market-research.mjs';
import {
  DEVICE_PROOF_ALGORITHM,
  DEVICE_PROOF_VERSION,
  DeviceProofError,
  normalizePublicOrigin,
  parseDeviceRegistration,
  verifyDeviceProof,
} from './device-proof.mjs';

const MAX_BODY_BYTES = 1_500_000;
const MAX_MESSAGE_CHARS = 900_000;

class HttpError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function plainText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value, fallback, max = 100000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function enabled(value) {
  return ['1', 'true', 'yes'].includes(plainText(value).toLowerCase());
}

function baseUrl(value) {
  const raw = plainText(value);
  if (!raw) throw new Error('UPSTREAM_BASE_URL is required.');
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('UPSTREAM_BASE_URL must use http or https.');
  return parsed.toString().endsWith('/') ? parsed.toString() : `${parsed.toString()}/`;
}

export function readGatewayConfig(env = process.env) {
  const apiKind = plainText(env.UPSTREAM_API_KIND || 'openai-compatible');
  if (!['openai-compatible', 'anthropic-messages'].includes(apiKind)) {
    throw new Error('UPSTREAM_API_KIND must be openai-compatible or anthropic-messages.');
  }
  const apiKey = plainText(env.UPSTREAM_API_KEY);
  const model = plainText(env.UPSTREAM_MODEL);
  const adminToken = plainText(env.GATEWAY_ADMIN_TOKEN);
  const tokenPepper = plainText(env.GATEWAY_TOKEN_PEPPER);
  if (!apiKey) throw new Error('UPSTREAM_API_KEY is required.');
  if (!model) throw new Error('UPSTREAM_MODEL is required.');
  if (!adminToken) throw new Error('GATEWAY_ADMIN_TOKEN is required.');
  if (!tokenPepper) throw new Error('GATEWAY_TOKEN_PEPPER is required.');
  return {
    bindHost: plainText(env.GATEWAY_BIND_HOST) || '127.0.0.1',
    port: positiveInteger(env.GATEWAY_PORT, 8787, 65535),
    dataDir: resolve(plainText(env.GATEWAY_DATA_DIR) || './data'),
    publicOrigin: normalizePublicOrigin(env.GATEWAY_PUBLIC_ORIGIN),
    adminToken,
    tokenPepper,
    inviteDefaultQuota: positiveInteger(env.INVITE_DEFAULT_QUOTA, 50),
    sessionTtlDays: positiveInteger(env.SESSION_TTL_DAYS, 30, 365),
    activationRateLimit: positiveInteger(env.ACTIVATION_RATE_LIMIT, 12, 1000),
    activationRateWindowSeconds: positiveInteger(env.ACTIVATION_RATE_WINDOW_SECONDS, 900, 86_400),
    deviceProofMaxSkewSeconds: positiveInteger(env.DEVICE_PROOF_MAX_SKEW_SECONDS, 300, 900),
    trustProxy: enabled(env.GATEWAY_TRUST_PROXY),
    research: readHostedMarketResearchConfig(env),
    upstream: {
      apiKind,
      apiKey,
      baseUrl: baseUrl(env.UPSTREAM_BASE_URL),
      model,
      maxTokens: positiveInteger(env.UPSTREAM_MAX_TOKENS, 8000, 32000),
      temperature: boundedNumber(env.UPSTREAM_TEMPERATURE, 0.7, 0, 2),
    },
  };
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const known = error instanceof HttpError || error instanceof GatewayStoreError
    || error instanceof HostedMarketResearchError || error instanceof DeviceProofError;
  const status = known ? error.status : 500;
  const message = known ? error.message : '服务暂时不可用，请稍后重试。';
  const code = known ? error.code : 'internal_error';
  json(res, status, { error: { code, message } });
}

async function readJsonWithBytes(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError('请求内容过大。', 413, 'payload_too_large');
    chunks.push(chunk);
  }
  const rawBody = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
  if (!chunks.length) return { body: {}, rawBody };
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return { body: parsed, rawBody };
  } catch {
    throw new HttpError('请求格式不正确。', 400, 'invalid_json');
  }
}

async function readJson(req) {
  return (await readJsonWithBytes(req)).body;
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') throw new HttpError('缺少登录状态，请重新输入授权码。', 401, 'missing_session');
  const match = header.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) throw new HttpError('登录状态格式不正确，请重新输入授权码。', 401, 'invalid_session');
  return match[1];
}

function rejectUnexpectedGetBody(req) {
  const contentLength = plainText(req.headers['content-length']);
  if (req.headers['transfer-encoding'] || (contentLength && contentLength !== '0')) {
    throw new HttpError('GET 接口不接受请求体。', 400, 'unexpected_body');
  }
}

const DEVICE_PROOF_HEADERS = [
  'x-aifios-device-proof-version',
  'x-aifios-device-key-id',
  'x-aifios-device-timestamp',
  'x-aifios-device-nonce',
  'x-aifios-device-signature',
];

function rawHeaderCount(req, wanted) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index] || '').toLowerCase() === wanted) count += 1;
  }
  return count;
}

function assertExactSignedRequest(req, method, path, requiresSession) {
  if ((req.method || '').toUpperCase() !== method || req.url !== path) {
    throw new HttpError('请求目标不能用于设备签名。', 400, 'invalid_device_proof_path');
  }
  for (const name of DEVICE_PROOF_HEADERS) {
    const count = rawHeaderCount(req, name);
    if (count === 0) throw new DeviceProofError('缺少设备签名，请重新激活。', 401, 'missing_device_proof');
    if (count !== 1) throw new DeviceProofError('设备签名头不能重复。', 401, 'invalid_device_proof');
  }
  if (requiresSession && rawHeaderCount(req, 'authorization') !== 1) {
    throw new HttpError('登录状态无效，请重新输入授权码。', 401, 'invalid_session');
  }
  const contentEncoding = plainText(req.headers['content-encoding']).toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new HttpError('设备签名请求不支持内容编码。', 415, 'unsupported_content_encoding');
  }
}

function adminAuthorized(req, expected) {
  const actual = plainText(req.headers.authorization);
  const wanted = `Bearer ${expected}`;
  return actual.length === wanted.length && timingSafeEqual(Buffer.from(actual), Buffer.from(wanted));
}

function quotaHeaders(quota) {
  return {
    'x-aifios-quota-limit': String(quota.quotaLimit),
    'x-aifios-quota-used': String(quota.requestsUsed),
    'x-aifios-quota-remaining': String(quota.requestsRemaining),
  };
}

function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = plainText(req.headers['x-forwarded-for']).split(',')[0]?.trim();
    if (forwarded && forwarded.length <= 128) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

export function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const attempts = new Map();
  return (key) => {
    const startedAfter = now() - windowMs;
    const recent = (attempts.get(key) || []).filter((timestamp) => timestamp > startedAfter);
    if (recent.length >= limit) {
      attempts.set(key, recent);
      throw new HttpError('尝试次数过多，请稍后重试。', 429, 'rate_limited');
    }
    recent.push(now());
    attempts.set(key, recent);
  };
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    throw new HttpError('消息内容格式不正确。', 400, 'invalid_messages');
  }
  let total = 0;
  const messages = value.map((message) => {
    if (!message || typeof message !== 'object') throw new HttpError('消息内容格式不正确。', 400, 'invalid_messages');
    const role = plainText(message.role);
    const content = typeof message.content === 'string' ? message.content : '';
    if (!['system', 'user', 'assistant'].includes(role) || !content.trim()) {
      throw new HttpError('消息内容格式不正确。', 400, 'invalid_messages');
    }
    total += content.length;
    return { role, content };
  });
  if (total > MAX_MESSAGE_CHARS) throw new HttpError('消息内容过大。', 413, 'payload_too_large');
  return { messages, inputChars: total };
}

function normalizeOptions(value, upstream) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    maxTokens: Math.min(upstream.maxTokens, positiveInteger(input.maxTokens, upstream.maxTokens, upstream.maxTokens)),
    temperature: boundedNumber(input.temperature, upstream.temperature, 0, 2),
  };
}

function endpoint(base, path) {
  return new URL(path, base).toString();
}

function upstreamHeaders(upstream) {
  if (upstream.apiKind === 'anthropic-messages') {
    return {
      'content-type': 'application/json',
      'x-api-key': upstream.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${upstream.apiKey}`,
  };
}

function anthropicPayload(messages, options, stream, upstream) {
  const system = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n\n');
  return {
    model: upstream.model,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    ...(system ? { system } : {}),
    messages: messages.filter((item) => item.role !== 'system'),
    stream,
  };
}

async function openUpstream(upstream, messages, options, stream, fetchImpl) {
  const url = upstream.apiKind === 'anthropic-messages'
    ? endpoint(upstream.baseUrl, 'messages')
    : endpoint(upstream.baseUrl, 'chat/completions');
  const payload = upstream.apiKind === 'anthropic-messages'
    ? anthropicPayload(messages, options, stream, upstream)
    : {
      model: upstream.model,
      messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream,
    };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: upstreamHeaders(upstream),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new HttpError('模型服务连接失败，请稍后重试。', 502, 'upstream_unavailable');
  }
  if (!response.ok || !response.body) {
    throw new HttpError('模型服务暂时不可用，请稍后重试。', 502, 'upstream_error');
  }
  return response;
}

async function readUpstreamCompletion(upstream, response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError('模型服务返回格式异常。', 502, 'upstream_error');
  }
  const content = upstream.apiKind === 'anthropic-messages'
    ? payload?.content?.find((item) => item?.type === 'text')?.text
    : payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new HttpError('模型服务未返回可用内容。', 502, 'upstream_error');
  return content;
}

async function* readSseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const flush = () => {
    if (!data.length) return null;
    const value = data.join('\n');
    data = [];
    return value;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) {
        const value = flush();
        if (value !== null) yield value;
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trim());
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
  const value = flush();
  if (value !== null) yield value;
}

function streamTextFromEvent(apiKind, data) {
  if (!data || data === '[DONE]') return '';
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return '';
  }
  if (apiKind === 'anthropic-messages') {
    return payload?.type === 'content_block_delta' && payload?.delta?.type === 'text_delta'
      ? String(payload.delta.text || '')
      : '';
  }
  const content = payload?.choices?.[0]?.delta?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('');
  return '';
}

async function streamUpstreamText(upstream, response, onText) {
  for await (const data of readSseData(response.body)) {
    const text = streamTextFromEvent(upstream.apiKind, data);
    if (text) await onText(text);
  }
}

function sse(res, event, payload) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function publicMe(session, invite, store) {
  const data = store.publicInvite(invite);
  return {
    account: {
      label: data.label,
      sessionExpiresAt: session.expiresAt,
      deviceKeyId: data.deviceKeyId,
      deviceProofVersion: DEVICE_PROOF_VERSION,
    },
    quota: {
      limit: data.quotaLimit,
      used: data.requestsUsed,
      remaining: data.requestsRemaining,
    },
  };
}

function verifyRequestDeviceProof({
  req,
  ledger,
  config,
  expectedDevice,
  token,
  method,
  path,
  rawBody = Buffer.alloc(0),
}) {
  return verifyDeviceProof({
    headers: req.headers,
    publicOrigin: config.publicOrigin,
    expectedDevice,
    method,
    path,
    bodyBytes: rawBody,
    token,
    now: ledger.now(),
    maxSkewMs: (config.deviceProofMaxSkewSeconds || 300) * 1000,
  });
}

export async function createGatewayHandler({ config = readGatewayConfig(), fetchImpl = fetch, store } = {}) {
  config.publicOrigin = normalizePublicOrigin(config.publicOrigin);
  const ledger = store || new GatewayStore({ dataDir: config.dataDir, pepper: config.tokenPepper });
  await ledger.init();
  const limitActivation = createRateLimiter({
    limit: config.activationRateLimit || 12,
    windowMs: (config.activationRateWindowSeconds || 900) * 1000,
  });

  const handler = async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://gateway.local');
      const path = requestUrl.pathname;
      const method = req.method || 'GET';

      if (method === 'GET' && path === '/healthz') {
        return json(res, 200, {
          ok: true,
          service: 'aifios-gateway',
          deviceProof: { version: DEVICE_PROOF_VERSION, algorithm: DEVICE_PROOF_ALGORITHM },
        });
      }

      if (method === 'POST' && path === '/v1/activate') {
        assertExactSignedRequest(req, 'POST', '/v1/activate', false);
        limitActivation(clientAddress(req, config.trustProxy));
        const { body, rawBody } = await readJsonWithBytes(req);
        const device = parseDeviceRegistration(body.device);
        const proof = verifyRequestDeviceProof({
          req,
          ledger,
          config,
          expectedDevice: device,
          token: '',
          method,
          path,
          rawBody,
        });
        const activation = await ledger.activate(body.code, config.sessionTtlDays, device, proof);
        return json(res, 201, {
          sessionToken: activation.token,
          sessionExpiresAt: activation.session.expiresAt,
          account: {
            label: activation.session.invite.label,
            deviceKeyId: activation.session.invite.deviceKeyId,
            deviceProofVersion: DEVICE_PROOF_VERSION,
          },
          quota: {
            limit: activation.session.invite.quotaLimit,
            used: activation.session.invite.requestsUsed,
            remaining: activation.session.invite.requestsRemaining,
          },
        });
      }

      if (method === 'GET' && path === '/v1/me') {
        assertExactSignedRequest(req, 'GET', '/v1/me', true);
        rejectUnexpectedGetBody(req);
        const token = bearerToken(req);
        const initialAuth = await ledger.authenticate(token);
        const proof = verifyRequestDeviceProof({
          req, ledger, config, expectedDevice: initialAuth.invite.device, token, method, path,
        });
        const auth = await ledger.consumeAuthenticatedDeviceNonce(token, proof.keyId, proof.nonce, proof.expiresAt);
        return json(res, 200, publicMe(auth.session, auth.invite, ledger));
      }

      if (method === 'POST' && path === '/v1/llm/chat') {
        assertExactSignedRequest(req, 'POST', '/v1/llm/chat', true);
        const token = bearerToken(req);
        const initialAuth = await ledger.authenticate(token);
        const { body, rawBody } = await readJsonWithBytes(req);
        const proof = verifyRequestDeviceProof({
          req, ledger, config, expectedDevice: initialAuth.invite.device, token, method, path, rawBody,
        });
        const auth = await ledger.consumeAuthenticatedDeviceNonce(token, proof.keyId, proof.nonce, proof.expiresAt);
        const { messages, inputChars } = normalizeMessages(body.messages);
        const options = normalizeOptions(body.options, config.upstream);
        const stream = body.stream !== false;
        const usageState = await ledger.consumeQuota(auth, { inputChars });

        let upstreamResponse;
        try {
          upstreamResponse = await openUpstream(config.upstream, messages, options, stream, fetchImpl);
        } catch (error) {
          await ledger.refundUsage(usageState.usage.id);
          throw error;
        }

        if (!stream) {
          try {
            const content = await readUpstreamCompletion(config.upstream, upstreamResponse);
            await ledger.finishUsage(usageState.usage.id, { status: 'completed', outputChars: content.length });
            return json(res, 200, { content, model: config.upstream.model, quota: usageState.quota }, quotaHeaders(usageState.quota));
          } catch (error) {
            await ledger.finishUsage(usageState.usage.id, { status: 'failed' });
            throw error;
          }
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          ...quotaHeaders(usageState.quota),
        });
        let outputChars = 0;
        try {
          await streamUpstreamText(config.upstream, upstreamResponse, async (text) => {
            outputChars += text.length;
            sse(res, null, { type: 'text', content: text });
          });
          await ledger.finishUsage(usageState.usage.id, { status: 'completed', outputChars });
          sse(res, 'done', { quota: usageState.quota });
        } catch {
          await ledger.finishUsage(usageState.usage.id, { status: 'failed', outputChars });
          sse(res, 'error', { message: '模型生成中断，请稍后重试。' });
        }
        res.end();
        return;
      }

      if (method === 'POST' && path === '/v1/research/market-signal') {
        assertExactSignedRequest(req, 'POST', '/v1/research/market-signal', true);
        const token = bearerToken(req);
        const initialAuth = await ledger.authenticate(token);
        const { body, rawBody } = await readJsonWithBytes(req);
        const proof = verifyRequestDeviceProof({
          req, ledger, config, expectedDevice: initialAuth.invite.device, token, method, path, rawBody,
        });
        const auth = await ledger.consumeAuthenticatedDeviceNonce(token, proof.keyId, proof.nonce, proof.expiresAt);
        if (!config.research?.enabled) {
          throw new HostedMarketResearchError(
            config.research?.reason || '托管 TikOmni 研究尚未由管理员配置。',
            503,
            'research_unavailable',
          );
        }
        const inputChars = Array.isArray(body.queries)
          ? body.queries.reduce((total, item) => total + (typeof item === 'string' ? item.length : 0), 0)
          : 0;
        const usageState = await ledger.consumeQuota(auth, { kind: 'market_research', inputChars });
        try {
          const result = await runHostedMarketResearch({ research: config.research, body, fetchImpl });
          await ledger.finishUsage(usageState.usage.id, { status: 'completed' });
          return json(res, 200, { ...result, quota: usageState.quota }, quotaHeaders(usageState.quota));
        } catch (error) {
          await ledger.finishUsage(usageState.usage.id, { status: 'failed' });
          throw error;
        }
      }

      if (path.startsWith('/admin/')) {
        if (!adminAuthorized(req, config.adminToken)) throw new HttpError('管理员身份验证失败。', 401, 'admin_unauthorized');
        if (method === 'GET' && path === '/admin/invites') {
          return json(res, 200, { invites: await ledger.listInvites() });
        }
        if (method === 'POST' && path === '/admin/invites') {
          const body = await readJson(req);
          const created = await ledger.createInvite({
            label: body.label,
            quotaLimit: body.quotaLimit,
            expiresAt: body.expiresAt,
            defaultQuota: config.inviteDefaultQuota,
          });
          return json(res, 201, { code: created.code, invite: created.invite });
        }
        const revokeMatch = path.match(/^\/admin\/invites\/([^/]+)\/revoke$/);
        if (method === 'POST' && revokeMatch) {
          return json(res, 200, { invite: await ledger.revokeInvite(decodeURIComponent(revokeMatch[1])) });
        }
        const reissueMatch = path.match(/^\/admin\/invites\/([^/]+)\/reissue$/);
        if (method === 'POST' && reissueMatch) {
          return json(res, 201, await ledger.reissueInvite(decodeURIComponent(reissueMatch[1])));
        }
        const quotaMatch = path.match(/^\/admin\/invites\/([^/]+)\/quota$/);
        if (method === 'POST' && quotaMatch) {
          const body = await readJson(req);
          return json(res, 200, { invite: await ledger.updateInviteQuota(decodeURIComponent(quotaMatch[1]), body.quotaLimit) });
        }
      }

      throw new HttpError('接口不存在。', 404, 'not_found');
    } catch (error) {
      if (!res.headersSent) return sendError(res, error);
      res.end();
    }
  };

  return { handler, store: ledger, config };
}

export async function createGatewayServer(options = {}) {
  const { handler, store, config } = await createGatewayHandler(options);
  const server = createServer(handler);

  return { server, store, config };
}

async function main() {
  const config = readGatewayConfig();
  const { server } = await createGatewayServer({ config });
  server.listen(config.port, config.bindHost, () => {
    // Deliberately no credentials, prompts, invite codes or session data in logs.
    console.log(`AIFIOS gateway listening on ${config.bindHost}:${config.port}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`AIFIOS gateway failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}

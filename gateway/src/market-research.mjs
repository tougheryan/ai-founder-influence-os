import { createPrivateKey, sign } from 'node:crypto';

export const REQUIRED_MARKET_PLATFORMS = Object.freeze([
  'wechat_mp',
  'xiaohongshu',
  'wechat_channels',
]);

const RESEARCH_SCHEMA = 'aifios.hosted-market-research.v1';
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUERY_COUNT = 3;
const MAX_QUERY_CHARS = 80;
const MAX_RESEARCH_RESPONSE_BYTES = 1_500_000;
const ENVELOPE_TTL_MS = 5 * 60 * 1000;

// These are the same fixed, catalogued endpoint IDs used by the local
// TikOmni adapter. The client cannot select a path, method, endpoint, or
// parameter shape, so this proxy cannot be repurposed as a generic crawler.
const MARKET_ENDPOINTS = Object.freeze({
  wechat_mp: Object.freeze({
    endpointId: 'wechat_search.search.v2.fetch_search',
    method: 'POST',
    path: '/api/u1/v1/wechat_search/v2/fetch_search',
    params: (query) => ({ keyword: query, business_type: 'article', raw: false }),
  }),
  xiaohongshu: Object.freeze({
    endpointId: 'xiaohongshu.search.app_v2.search_notes',
    method: 'GET',
    path: '/api/u1/v1/xiaohongshu/app_v2/search_notes',
    params: (query) => ({ keyword: query, page: 1 }),
  }),
  wechat_channels: Object.freeze({
    endpointId: 'wechat_search.video_search.v2.fetch_search_videos',
    method: 'POST',
    path: '/api/u1/v1/wechat_search/v2/fetch_search_videos',
    params: (query) => ({ keyword: query, raw: false }),
  }),
});

export class HostedMarketResearchError extends Error {
  constructor(message, status = 400, code = 'market_research_error') {
    super(message);
    this.name = 'HostedMarketResearchError';
    this.status = status;
    this.code = code;
  }
}

function plainText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value, fallback, max = 120_000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function researchBaseUrl(value) {
  const raw = plainText(value) || 'https://api.tikomni.com';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('TIKOMNI_BASE_URL must be a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('TIKOMNI_BASE_URL must use HTTP(S).');
  }
  return parsed.toString().replace(/\/$/, '');
}

function privateKeyFromBase64(value) {
  const raw = plainText(value);
  if (!raw) return null;
  if (!/^[A-Za-z0-9_-]{40,4096}$/.test(raw)) {
    throw new Error('GATEWAY_RESEARCH_SIGNING_PRIVATE_KEY_BASE64 must be base64url PKCS#8 DER.');
  }
  try {
    return createPrivateKey({ key: Buffer.from(raw, 'base64url'), format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('GATEWAY_RESEARCH_SIGNING_PRIVATE_KEY_BASE64 is not a valid private key.');
  }
}

export function readHostedMarketResearchConfig(env = process.env) {
  const token = plainText(env.TIKOMNI_API_KEY || env.TIKOMNI_API_TOKEN);
  const privateKey = privateKeyFromBase64(env.GATEWAY_RESEARCH_SIGNING_PRIVATE_KEY_BASE64);
  const keyId = plainText(env.GATEWAY_RESEARCH_SIGNING_KEY_ID || 'market-v1');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId)) {
    throw new Error('GATEWAY_RESEARCH_SIGNING_KEY_ID must use letters, digits, dot, underscore, or hyphen.');
  }
  if (!token || !privateKey) {
    return {
      enabled: false,
      reason: '托管 TikOmni 研究尚未由管理员配置。',
    };
  }
  return {
    enabled: true,
    token,
    baseUrl: researchBaseUrl(env.TIKOMNI_BASE_URL || env.TIKOMNI_API_BASE),
    timeoutMs: positiveInteger(env.TIKOMNI_TIMEOUT_MS, 14_000, 60_000),
    keyId,
    privateKey,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function hostedResearchSigningBytes(keyId, payload) {
  return Buffer.from(JSON.stringify(stableValue({ keyId, payload })), 'utf8');
}

function validateRequest(body) {
  const requestId = plainText(body?.requestId);
  if (!REQUEST_ID_RE.test(requestId)) {
    throw new HostedMarketResearchError('研究请求标识无效，请重新发起研究。', 400, 'invalid_research_request');
  }
  if (!Array.isArray(body?.queries) || !body.queries.length || body.queries.length > MAX_QUERY_COUNT) {
    throw new HostedMarketResearchError('研究检索词格式不正确。', 400, 'invalid_research_queries');
  }
  const queries = [];
  for (const value of body.queries) {
    const query = plainText(value);
    if (query.length < 2 || query.length > MAX_QUERY_CHARS || /[\r\n\u0000]/.test(query) || queries.includes(query)) {
      throw new HostedMarketResearchError('研究检索词格式不正确。', 400, 'invalid_research_queries');
    }
    queries.push(query);
  }
  return { requestId, queries };
}

function compactFailure(value, fallback) {
  const text = plainText(value).replace(/[\r\n]+/g, ' ');
  return (text || fallback).slice(0, 240);
}

async function readJsonResponse(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > MAX_RESEARCH_RESPONSE_BYTES) {
    throw new HostedMarketResearchError('TikOmni 返回内容过大。', 502, 'tikomni_response_too_large');
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESEARCH_RESPONSE_BYTES) {
    throw new HostedMarketResearchError('TikOmni 返回内容过大。', 502, 'tikomni_response_too_large');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HostedMarketResearchError('TikOmni 返回格式异常。', 502, 'tikomni_response_invalid');
  }
}

async function fetchMarketEndpoint(research, platform, query, fetchImpl) {
  const endpoint = MARKET_ENDPOINTS[platform];
  const params = endpoint.params(query);
  const url = new URL(endpoint.path, research.baseUrl);
  const init = {
    method: endpoint.method,
    headers: {
      authorization: `Bearer ${research.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(research.timeoutMs),
  };
  if (endpoint.method === 'GET') {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  } else {
    init.body = JSON.stringify(params);
  }

  try {
    const response = await fetchImpl(url, init);
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      return {
        platform,
        query,
        endpointId: endpoint.endpointId,
        status: 'unavailable',
        code: 'tikomni_endpoint_error',
        reason: compactFailure(payload?.message || payload?.error?.message, `TikOmni HTTP ${response.status}`),
      };
    }
    return {
      platform,
      query,
      endpointId: endpoint.endpointId,
      status: 'available',
      payload,
    };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      platform,
      query,
      endpointId: endpoint.endpointId,
      status: 'unavailable',
      code: timedOut ? 'tikomni_platform_timeout' : 'tikomni_platform_request_failed',
      reason: timedOut ? 'TikOmni 请求超时。' : 'TikOmni 请求未能完成。',
    };
  }
}

function platformChecks(responses) {
  return Object.fromEntries(REQUIRED_MARKET_PLATFORMS.map((platform) => {
    const rows = responses.filter((item) => item.platform === platform);
    const failed = rows.find((item) => item.status !== 'available');
    return [platform, failed ? {
      status: 'unavailable',
      code: failed.code || 'tikomni_platform_unavailable',
      reason: failed.reason || 'TikOmni 平台返回不可用',
      queryCount: rows.length,
    } : {
      status: 'available',
      endpointIds: [...new Set(rows.map((item) => item.endpointId))],
      queryCount: rows.length,
    }];
  }));
}

export async function runHostedMarketResearch({ research, body, fetchImpl = fetch, now = () => new Date() }) {
  if (!research?.enabled) {
    throw new HostedMarketResearchError(research?.reason || '托管 TikOmni 研究尚未由管理员配置。', 503, 'research_unavailable');
  }
  const { requestId, queries } = validateRequest(body);
  const responses = await Promise.all(
    REQUIRED_MARKET_PLATFORMS.flatMap((platform) => queries.map((query) => fetchMarketEndpoint(research, platform, query, fetchImpl))),
  );
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + ENVELOPE_TTL_MS);
  const payload = {
    schema: RESEARCH_SCHEMA,
    requestId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    queries,
    requiredPlatforms: REQUIRED_MARKET_PLATFORMS,
    douyinResearchProxy: 'wechat_channels',
    platformChecks: platformChecks(responses),
    responses,
  };
  const signature = sign(null, hostedResearchSigningBytes(research.keyId, payload), research.privateKey).toString('base64url');
  return {
    envelope: {
      keyId: research.keyId,
      payload,
      signature,
    },
  };
}

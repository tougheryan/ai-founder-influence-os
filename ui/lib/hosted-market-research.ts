import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { callHostedGateway, HostedGatewayError } from './hosted-gateway';

const RESEARCH_SCHEMA = 'aifios.hosted-market-research.v1';
const SUPPORTED_PLATFORMS = ['wechat_mp', 'xiaohongshu', 'wechat_channels'] as const;

export class HostedMarketResearchError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = 'HostedMarketResearchError';
  }
}

type ResearchEnvelope = {
  keyId: string;
  payload: {
    schema: string;
    requestId: string;
    issuedAt: string;
    expiresAt: string;
    queries: string[];
    requiredPlatforms: string[];
    douyinResearchProxy?: string;
    platformChecks: Record<string, unknown>;
    responses: Array<Record<string, unknown>>;
  };
  signature: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, stableValue(source[key])]));
  }
  return value;
}

function plainText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validPublicKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,4096}$/.test(value);
}

function validKeyId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

function signingBytes(keyId: string, payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(stableValue({ keyId, payload })), 'utf8');
}

function exactQueries(value: unknown, expected: readonly string[]): value is string[] {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((query, index) => typeof query === 'string' && query === expected[index]);
}

function validDate(value: unknown): number {
  const timestamp = Date.parse(plainText(value));
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

export function verifyHostedMarketResearchEnvelope(
  value: unknown,
  { requestId, queries, platforms, publicKey, keyId = '', now = Date.now() }: {
    requestId: string;
    queries: readonly string[];
    platforms?: readonly string[];
    publicKey: string;
    keyId?: string;
    now?: number;
  },
): ResearchEnvelope {
  if (!validPublicKey(publicKey)) {
    throw new HostedMarketResearchError('此应用包未配置托管研究验签公钥。', 503);
  }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const envelope = record.envelope && typeof record.envelope === 'object'
    ? record.envelope as Record<string, unknown>
    : {};
  const payload = envelope.payload && typeof envelope.payload === 'object'
    ? envelope.payload as ResearchEnvelope['payload']
    : null;
  const envelopeKeyId = plainText(envelope.keyId);
  const signature = plainText(envelope.signature);
  if (!payload || !validKeyId(envelopeKeyId) || !/^[A-Za-z0-9_-]{40,4096}$/.test(signature)) {
    throw new HostedMarketResearchError('托管研究响应格式无效。');
  }
  if (keyId && envelopeKeyId !== keyId) {
    throw new HostedMarketResearchError('托管研究响应使用了未知的签名密钥。');
  }
  if (payload.schema !== RESEARCH_SCHEMA || payload.requestId !== requestId || !exactQueries(payload.queries, queries)) {
    throw new HostedMarketResearchError('托管研究响应与当前请求不匹配。');
  }
  const expectedPlatforms = platforms?.length ? [...platforms] : [...SUPPORTED_PLATFORMS];
  if (!expectedPlatforms.length
    || expectedPlatforms.some((platform) => !SUPPORTED_PLATFORMS.includes(platform as typeof SUPPORTED_PLATFORMS[number]))
    || JSON.stringify(payload.requiredPlatforms) !== JSON.stringify(expectedPlatforms)
    || !payload.platformChecks || typeof payload.platformChecks !== 'object'
    || !Array.isArray(payload.responses)) {
    throw new HostedMarketResearchError('托管研究响应缺少必要的平台研究契约。');
  }
  const issuedAt = validDate(payload.issuedAt);
  const expiresAt = validDate(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= now || issuedAt > now + 60_000 || expiresAt - issuedAt > 10 * 60_000) {
    throw new HostedMarketResearchError('托管研究响应已过期，请重新执行研究。');
  }
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    if (!verify(null, signingBytes(envelopeKeyId, payload), key, Buffer.from(signature, 'base64url'))) {
      throw new Error('invalid signature');
    }
  } catch {
    throw new HostedMarketResearchError('托管研究响应签名校验失败。');
  }
  return { keyId: envelopeKeyId, payload, signature };
}

export async function requestHostedMarketResearch({
  gatewayUrl,
  sessionToken,
  researchPublicKey,
  researchKeyId,
  queries,
  platforms,
}: {
  gatewayUrl: string;
  sessionToken: string;
  researchPublicKey: string;
  researchKeyId?: string;
  queries: string[];
  platforms?: string[];
}): Promise<ResearchEnvelope> {
  if (!sessionToken) throw new HostedMarketResearchError('请先输入邀请码并连接托管账户。', 401);
  const requestId = randomUUID();
  try {
    const response = await callHostedGateway(gatewayUrl, '/v1/research/market-signal', {
      method: 'POST',
      token: sessionToken,
      body: { requestId, queries, requiredPlatforms: platforms?.length ? platforms : [...SUPPORTED_PLATFORMS] },
    });
    return verifyHostedMarketResearchEnvelope(response, {
      requestId,
      queries,
      platforms,
      publicKey: researchPublicKey,
      keyId: researchKeyId,
    });
  } catch (error) {
    if (error instanceof HostedMarketResearchError) throw error;
    if (error instanceof HostedGatewayError) throw new HostedMarketResearchError(error.message, error.status);
    throw new HostedMarketResearchError('托管 TikOmni 研究暂时不可用，请稍后重试。');
  }
}

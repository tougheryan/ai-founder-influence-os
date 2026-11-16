import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HostedMarketResearchError, verifyHostedMarketResearchEnvelope } from './hosted-market-research';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, stableValue(source[key])]));
  }
  return value;
}

function signedEnvelope({ requestId, queries, expiresAt = Date.now() + 60_000 }: {
  requestId: string;
  queries: string[];
  expiresAt?: number;
}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = 'market-test';
  const payload = {
    schema: 'aifios.hosted-market-research.v1',
    requestId,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    queries,
    requiredPlatforms: ['wechat_mp', 'xiaohongshu', 'wechat_channels'],
    douyinResearchProxy: 'wechat_channels',
    platformChecks: {
      wechat_mp: { status: 'available' },
      xiaohongshu: { status: 'available' },
      wechat_channels: { status: 'available' },
    },
    responses: [] as Array<Record<string, unknown>>,
  };
  const bytes = Buffer.from(JSON.stringify(stableValue({ keyId, payload })), 'utf8');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    envelope: {
      keyId,
      payload,
      signature: sign(null, bytes, privateKey).toString('base64url'),
    },
  };
}

describe('hosted market research envelope', () => {
  const requestId = '4ee7c411-7924-4b18-b15f-59da5f2ffea0';
  const queries = ['企业出海 自媒体'];

  it('accepts a signed, nonce-bound response', () => {
    const signed = signedEnvelope({ requestId, queries });
    const result = verifyHostedMarketResearchEnvelope({ envelope: signed.envelope }, {
      requestId,
      queries,
      publicKey: signed.publicKey,
      keyId: 'market-test',
    });

    expect(result.payload.requestId).toBe(requestId);
  });

  it('rejects replayed request IDs and payload tampering', () => {
    const signed = signedEnvelope({ requestId, queries });
    expect(() => verifyHostedMarketResearchEnvelope({ envelope: signed.envelope }, {
      requestId: '49930bd3-bfe0-4619-8a16-e98215f7f9fa',
      queries,
      publicKey: signed.publicKey,
    })).toThrow(HostedMarketResearchError);

    signed.envelope.payload.responses.push({ platform: 'wechat_mp', query: queries[0], status: 'available' });
    expect(() => verifyHostedMarketResearchEnvelope({ envelope: signed.envelope }, {
      requestId,
      queries,
      publicKey: signed.publicKey,
    })).toThrow('签名校验失败');
  });

  it('rejects expired responses', () => {
    const signed = signedEnvelope({ requestId, queries, expiresAt: Date.now() - 1 });
    expect(() => verifyHostedMarketResearchEnvelope({ envelope: signed.envelope }, {
      requestId,
      queries,
      publicKey: signed.publicKey,
    })).toThrow('已过期');
  });
});

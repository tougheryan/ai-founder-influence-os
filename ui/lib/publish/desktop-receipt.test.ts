import { describe, expect, it } from 'vitest';
import {
  DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
  signDesktopPublicationReceiptForTest,
  verifyDesktopPublicationReceipt,
  type DesktopPublicationReceiptPayload,
} from './desktop-receipt';

const secret = 'desktop-publication-receipt-test-secret-123456';
const now = Date.parse('2026-07-15T12:00:00.000Z');

function payload(): DesktopPublicationReceiptPayload {
  return {
    schema: DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
    receipt_id: 'receipt_1234567890',
    issued_at: '2026-07-15T12:00:00.000Z',
    queue_path: 'materials/publication/drafts/demo/draft-queue.json',
    run_id: 'demo-run',
    job_id: 'draft_0123456789abcdef0123',
    payload_hash: 'a'.repeat(64),
    adapter: 'wechat_official_api',
    result: {
      status: 'draft_filled',
      authorizationState: 'authorized',
      externalReference: 'wechat-draft:media-id',
    },
  };
}

describe('desktop publication receipt', () => {
  it('accepts a fresh Electron-signed local draft result', () => {
    const signed = signDesktopPublicationReceiptForTest(payload(), secret);
    expect(verifyDesktopPublicationReceipt(signed, secret, now)).toMatchObject({
      job_id: 'draft_0123456789abcdef0123',
      adapter: 'wechat_official_api',
      result: { status: 'draft_filled' },
    });
  });

  it('rejects tampering, expiration, and secret-like result values', () => {
    const signed = signDesktopPublicationReceiptForTest(payload(), secret);
    expect(() => verifyDesktopPublicationReceipt({ ...signed, signature: '0'.repeat(64) }, secret, now)).toThrow('签名');

    const expired = payload();
    expired.issued_at = '2026-07-15T11:40:00.000Z';
    expect(() => verifyDesktopPublicationReceipt(signDesktopPublicationReceiptForTest(expired, secret), secret, now)).toThrow('过期');

    const unsafe = payload();
    unsafe.result.message = 'access_token=should-not-reach-a-queue';
    expect(() => verifyDesktopPublicationReceipt(signDesktopPublicationReceiptForTest(unsafe, secret), secret, now)).toThrow('格式错误');
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DESKTOP_PUBLICATION_RECEIPT_SCHEMA = 'aifios.desktop-publication-receipt.v1';

export type DesktopPublicationAdapter =
  | 'wechat_official_api'
  | 'authorized_browser'
  | 'mobile_bridge'
  | 'download';

export type DesktopPublicationResult = {
  status: 'draft_filled' | 'retryable_failure' | 'manual_intervention_required' | 'unknown_completion';
  authorizationState?: 'not_checked' | 'authorized' | 'not_authorized' | 'requires_human_action';
  code?: string;
  message?: string;
  externalReference?: string;
};

export type DesktopPublicationReceiptPayload = {
  schema: typeof DESKTOP_PUBLICATION_RECEIPT_SCHEMA;
  receipt_id: string;
  issued_at: string;
  queue_path: string;
  run_id: string;
  job_id: string;
  payload_hash: string;
  adapter: DesktopPublicationAdapter;
  result: DesktopPublicationResult;
};

export type SignedDesktopPublicationReceipt = {
  schema: typeof DESKTOP_PUBLICATION_RECEIPT_SCHEMA;
  payload: string;
  signature: string;
};

const RESULT_STATUSES = new Set<DesktopPublicationResult['status']>([
  'draft_filled',
  'retryable_failure',
  'manual_intervention_required',
  'unknown_completion',
]);
const ADAPTERS = new Set<DesktopPublicationAdapter>([
  'wechat_official_api',
  'authorized_browser',
  'mobile_bridge',
  'download',
]);
const AUTHORIZATION_STATES = new Set<NonNullable<DesktopPublicationResult['authorizationState']>>([
  'not_checked',
  'authorized',
  'not_authorized',
  'requires_human_action',
]);
const SECRET_VALUE = /(?:appsecret|access[_-]?token|authorization\s*:|bearer\s+|cookie=|api[_-]?key)/i;

function receiptError(message: string): Error {
  return new Error(`桌面发布回执无效：${message}`);
}

function safeText(value: unknown, label: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw receiptError(`${label}缺失。`);
    return undefined;
  }
  if (typeof value !== 'string') throw receiptError(`${label}格式错误。`);
  const text = value.trim();
  if (!text || Buffer.byteLength(text, 'utf8') > max || SECRET_VALUE.test(text)) {
    throw receiptError(`${label}格式错误。`);
  }
  return text;
}

function parseReceiptInput(value: unknown): SignedDesktopPublicationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw receiptError('回执格式错误。');
  const receipt = value as Record<string, unknown>;
  if (receipt.schema !== DESKTOP_PUBLICATION_RECEIPT_SCHEMA) throw receiptError('版本不受支持。');
  const payload = safeText(receipt.payload, 'payload', 24 * 1024, true);
  const signature = safeText(receipt.signature, 'signature', 128, true);
  if (!/^[A-Za-z0-9_-]+$/.test(payload!) || !/^[a-f0-9]{64}$/i.test(signature!)) {
    throw receiptError('签名格式错误。');
  }
  return { schema: DESKTOP_PUBLICATION_RECEIPT_SCHEMA, payload: payload!, signature: signature! };
}

function parsePayload(encoded: string): DesktopPublicationReceiptPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw receiptError('payload 无法解析。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw receiptError('payload 格式错误。');
  const value = parsed as Record<string, unknown>;
  if (value.schema !== DESKTOP_PUBLICATION_RECEIPT_SCHEMA) throw receiptError('payload 版本不受支持。');
  const receiptId = safeText(value.receipt_id, 'receipt_id', 128, true);
  const issuedAt = safeText(value.issued_at, 'issued_at', 64, true);
  const queuePath = safeText(value.queue_path, 'queue_path', 1024, true);
  const runId = safeText(value.run_id, 'run_id', 256, true);
  const jobId = safeText(value.job_id, 'job_id', 128, true);
  const payloadHash = safeText(value.payload_hash, 'payload_hash', 128, true);
  const adapter = safeText(value.adapter, 'adapter', 64, true) as DesktopPublicationAdapter;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(receiptId!)) throw receiptError('receipt_id 格式错误。');
  if (!/^materials\/publication\/drafts\/[A-Za-z0-9_\-\u4e00-\u9fff]+\/draft-queue\.json$/.test(queuePath!) || queuePath!.includes('..')) {
    throw receiptError('queue_path 不受支持。');
  }
  if (!/^draft_[a-f0-9]{20}$/.test(jobId!) || !/^[a-f0-9]{64}$/i.test(payloadHash!) || !ADAPTERS.has(adapter)) {
    throw receiptError('任务绑定信息格式错误。');
  }
  const resultValue = value.result;
  if (!resultValue || typeof resultValue !== 'object' || Array.isArray(resultValue)) throw receiptError('结果格式错误。');
  const result = resultValue as Record<string, unknown>;
  const status = safeText(result.status, 'result.status', 64, true) as DesktopPublicationResult['status'];
  const authorizationState = safeText(result.authorizationState, 'result.authorizationState', 64) as DesktopPublicationResult['authorizationState'];
  const code = safeText(result.code, 'result.code', 128);
  const message = safeText(result.message, 'result.message', 1024);
  const externalReference = safeText(result.externalReference, 'result.externalReference', 512);
  if (!RESULT_STATUSES.has(status) || (authorizationState && !AUTHORIZATION_STATES.has(authorizationState))) {
    throw receiptError('结果状态不受支持。');
  }
  return {
    schema: DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
    receipt_id: receiptId!,
    issued_at: issuedAt!,
    queue_path: queuePath!,
    run_id: runId!,
    job_id: jobId!,
    payload_hash: payloadHash!,
    adapter,
    result: {
      status,
      ...(authorizationState ? { authorizationState } : {}),
      ...(code ? { code } : {}),
      ...(message ? { message } : {}),
      ...(externalReference ? { externalReference } : {}),
    },
  };
}

/** Verifies an IPC receipt signed by the active Electron main process. */
export function verifyDesktopPublicationReceipt(
  input: unknown,
  secret: string | undefined,
  now = Date.now(),
): DesktopPublicationReceiptPayload {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw receiptError('当前服务不是受信任的桌面发布会话。');
  }
  const receipt = parseReceiptInput(input);
  const expected = createHmac('sha256', secret).update(receipt.payload).digest('hex');
  const actual = Buffer.from(receipt.signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) {
    throw receiptError('签名校验失败。');
  }
  const payload = parsePayload(receipt.payload);
  const issuedAt = new Date(payload.issued_at).getTime();
  if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000 || issuedAt < now - 10 * 60_000) {
    throw receiptError('回执已过期。');
  }
  return payload;
}

/** Test-only helper mirroring the Electron receipt signing envelope. */
export function signDesktopPublicationReceiptForTest(
  payload: DesktopPublicationReceiptPayload,
  secret: string,
): SignedDesktopPublicationReceipt {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return {
    schema: DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
    payload: encoded,
    signature: createHmac('sha256', secret).update(encoded).digest('hex'),
  };
}

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

export const DEVICE_PROOF_VERSION = '1';
export const DEVICE_PROOF_DOMAIN = 'AIFIOS-DEVICE-PROOF-V1';
export const DEVICE_PROOF_ALGORITHM = 'Ed25519';

const HEADER_VERSION = 'x-aifios-device-proof-version';
const HEADER_KEY_ID = 'x-aifios-device-key-id';
const HEADER_TIMESTAMP = 'x-aifios-device-timestamp';
const HEADER_NONCE = 'x-aifios-device-nonce';
const HEADER_SIGNATURE = 'x-aifios-device-signature';
const EMPTY_BODY = Buffer.alloc(0);

export class DeviceProofError extends Error {
  constructor(message, status = 401, code = 'invalid_device_proof') {
    super(message);
    this.name = 'DeviceProofError';
    this.status = status;
    this.code = code;
  }
}

function plainText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function exactHeader(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value) || typeof value !== 'string') return '';
  return value.trim();
}

function asBytes(value) {
  if (value === undefined || value === null) return EMPTY_BODY;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError('bodyBytes must be a Buffer, Uint8Array, string, or empty.');
}

function sha256Base64Url(value) {
  return createHash('sha256').update(asBytes(value)).digest('base64url');
}

function strictBase64Url(value, minLength, maxLength, field, code = 'invalid_device_key', status = 400) {
  const clean = plainText(value);
  if (clean.length < minLength || clean.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(clean)) {
    throw new DeviceProofError(`${field}格式不正确。`, status, code);
  }
  const decoded = Buffer.from(clean, 'base64url');
  if (decoded.toString('base64url') !== clean) {
    throw new DeviceProofError(`${field}格式不正确。`, status, code);
  }
  return decoded;
}

export function normalizePublicOrigin(value) {
  const raw = plainText(value);
  if (!raw) throw new Error('GATEWAY_PUBLIC_ORIGIN is required.');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('GATEWAY_PUBLIC_ORIGIN must be a valid URL origin.');
  }
  const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error('GATEWAY_PUBLIC_ORIGIN must use HTTPS (HTTP is allowed only for loopback development).');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('GATEWAY_PUBLIC_ORIGIN must contain only scheme, host, and optional port.');
  }
  return parsed.origin;
}

export function normalizeProofPath(value) {
  const path = typeof value === 'string' ? value : '';
  if (!path.startsWith('/') || path.length > 4096 || path.includes('?') || path.includes('#') || /[\r\n]/.test(path)) {
    throw new DeviceProofError('请求路径不能用于设备签名。', 400, 'invalid_device_proof_path');
  }
  return path;
}

export function deriveDeviceKeyId(publicKeySpki) {
  const der = strictBase64Url(publicKeySpki, 40, 256, '设备公钥');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new DeviceProofError('设备公钥格式不正确。', 400, 'invalid_device_key');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new DeviceProofError('设备公钥必须使用 Ed25519。', 400, 'invalid_device_key');
  }
  const canonicalDer = publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.from(canonicalDer).equals(der)) {
    throw new DeviceProofError('设备公钥必须使用规范 SPKI 编码。', 400, 'invalid_device_key');
  }
  return `ed25519:${sha256Base64Url(der)}`;
}

export function parseDeviceRegistration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeviceProofError('缺少设备公钥，请重新激活。', 400, 'missing_device_key');
  }
  if (value.algorithm !== DEVICE_PROOF_ALGORITHM) {
    throw new DeviceProofError('设备公钥算法不受支持。', 400, 'invalid_device_key');
  }
  const publicKeySpki = plainText(value.publicKeySpki);
  const derivedKeyId = deriveDeviceKeyId(publicKeySpki);
  const keyId = plainText(value.keyId);
  if (!keyId || keyId !== derivedKeyId) {
    throw new DeviceProofError('设备公钥标识与公钥不匹配。', 400, 'invalid_device_key');
  }
  return { algorithm: DEVICE_PROOF_ALGORITHM, keyId, publicKeySpki };
}

export function deviceProofSigningBytes({
  publicOrigin,
  keyId,
  timestamp,
  nonce,
  method,
  path,
  bodyBytes,
  token = '',
}) {
  const origin = normalizePublicOrigin(publicOrigin);
  const cleanKeyId = plainText(keyId);
  const cleanTimestamp = typeof timestamp === 'number' ? String(timestamp) : plainText(timestamp);
  const cleanNonce = plainText(nonce);
  const cleanMethod = plainText(method).toUpperCase();
  const cleanPath = normalizeProofPath(path);
  if (!/^ed25519:[A-Za-z0-9_-]{43}$/.test(cleanKeyId)) throw new TypeError('keyId is invalid.');
  if (!/^[1-9][0-9]{12,15}$/.test(cleanTimestamp) || !Number.isSafeInteger(Number(cleanTimestamp))) {
    throw new TypeError('timestamp must be Unix epoch milliseconds.');
  }
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(cleanNonce)) throw new TypeError('nonce is invalid.');
  if (!/^[A-Z]+$/.test(cleanMethod)) throw new TypeError('method is invalid.');
  return Buffer.from([
    DEVICE_PROOF_DOMAIN,
    origin,
    cleanKeyId,
    cleanTimestamp,
    cleanNonce,
    cleanMethod,
    cleanPath,
    sha256Base64Url(bodyBytes),
    sha256Base64Url(plainText(token)),
  ].join('\n'), 'utf8');
}

export function createDeviceProofHeaders({
  privateKey,
  publicOrigin,
  keyId,
  timestamp = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
  method,
  path,
  bodyBytes,
  token = '',
}) {
  const timestampText = String(timestamp);
  const signature = sign(null, deviceProofSigningBytes({
    publicOrigin,
    keyId,
    timestamp: timestampText,
    nonce,
    method,
    path,
    bodyBytes,
    token,
  }), privateKey).toString('base64url');
  return {
    [HEADER_VERSION]: DEVICE_PROOF_VERSION,
    [HEADER_KEY_ID]: keyId,
    [HEADER_TIMESTAMP]: timestampText,
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: signature,
  };
}

export function generateDeviceKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeySpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  return {
    privateKey,
    device: {
      algorithm: DEVICE_PROOF_ALGORITHM,
      keyId: deriveDeviceKeyId(publicKeySpki),
      publicKeySpki,
    },
  };
}

export function verifyDeviceProof({
  headers,
  publicOrigin,
  expectedDevice,
  method,
  path,
  bodyBytes,
  token = '',
  now = Date.now(),
  maxSkewMs = 5 * 60 * 1000,
}) {
  const version = exactHeader(headers, HEADER_VERSION);
  const keyId = exactHeader(headers, HEADER_KEY_ID);
  const timestampText = exactHeader(headers, HEADER_TIMESTAMP);
  const nonce = exactHeader(headers, HEADER_NONCE);
  const signatureText = exactHeader(headers, HEADER_SIGNATURE);
  if (!version || !keyId || !timestampText || !nonce || !signatureText) {
    throw new DeviceProofError('缺少设备签名，请重新激活。', 401, 'missing_device_proof');
  }
  if (version !== DEVICE_PROOF_VERSION) {
    throw new DeviceProofError('设备签名版本不受支持。', 401, 'unsupported_device_proof');
  }
  const device = parseDeviceRegistration(expectedDevice);
  if (keyId !== device.keyId) {
    throw new DeviceProofError('设备签名与当前授权不匹配。', 401, 'device_key_mismatch');
  }
  if (!/^[1-9][0-9]{12,15}$/.test(timestampText)) {
    throw new DeviceProofError('设备签名时间格式不正确。', 401, 'invalid_device_proof');
  }
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp)) {
    throw new DeviceProofError('设备签名时间格式不正确。', 401, 'invalid_device_proof');
  }
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(current)) throw new TypeError('now must be a date or epoch milliseconds.');
  if (timestamp < current - maxSkewMs) {
    throw new DeviceProofError('设备签名已过期，请检查系统时间后重试。', 401, 'expired_device_proof');
  }
  if (timestamp > current + maxSkewMs) {
    throw new DeviceProofError('设备签名时间超前，请检查系统时间后重试。', 401, 'future_device_proof');
  }
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) {
    throw new DeviceProofError('设备签名随机数格式不正确。', 401, 'invalid_device_proof');
  }
  const signature = strictBase64Url(signatureText, 86, 86, '设备签名', 'invalid_device_proof', 401);
  if (signature.length !== 64) {
    throw new DeviceProofError('设备签名格式不正确。', 401, 'invalid_device_proof');
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: Buffer.from(device.publicKeySpki, 'base64url'), format: 'der', type: 'spki' });
  } catch {
    throw new DeviceProofError('设备公钥格式不正确。', 401, 'invalid_device_key');
  }
  const signingBytes = deviceProofSigningBytes({
    publicOrigin,
    keyId,
    timestamp: timestampText,
    nonce,
    method,
    path,
    bodyBytes,
    token,
  });
  if (!verify(null, signingBytes, publicKey, signature)) {
    throw new DeviceProofError('设备签名验证失败。', 401, 'invalid_device_proof');
  }
  return {
    keyId,
    nonce,
    timestamp,
    expiresAt: new Date(timestamp + maxSkewMs).toISOString(),
  };
}

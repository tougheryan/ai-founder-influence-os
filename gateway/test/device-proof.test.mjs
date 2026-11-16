import assert from 'node:assert/strict';
import {
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import test from 'node:test';
import {
  createDeviceProofHeaders,
  deriveDeviceKeyId,
  deviceProofSigningBytes,
  normalizePublicOrigin,
  verifyDeviceProof,
} from '../src/device-proof.mjs';

const RFC8032_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(RFC8032_SEED, 'hex'),
  ]),
  format: 'der',
  type: 'pkcs8',
});
const PUBLIC_KEY_SPKI = createPublicKey(PRIVATE_KEY).export({ format: 'der', type: 'spki' }).toString('base64url');
const KEY_ID = 'ed25519:BuP9j9opu2CrWVV95h7bCuzbIxE0vjDnW0Vfjht5L6k';
const ORIGIN = 'https://gateway.example.com';
const TIMESTAMP = 1_786_900_000_123;
const NONCE = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY';
const BODY = Buffer.from('{"messages":[{"role":"user","content":"hello"}]}');
const TOKEN = 'session-token-test';
const DEVICE = { algorithm: 'Ed25519', keyId: KEY_ID, publicKeySpki: PUBLIC_KEY_SPKI };

function headers(overrides = {}) {
  return createDeviceProofHeaders({
    privateKey: PRIVATE_KEY,
    publicOrigin: ORIGIN,
    keyId: KEY_ID,
    timestamp: TIMESTAMP,
    nonce: NONCE,
    method: 'POST',
    path: '/v1/llm/chat',
    bodyBytes: BODY,
    token: TOKEN,
    ...overrides,
  });
}

test('device proof has a fixed cross-runtime canonical vector', () => {
  assert.equal(PUBLIC_KEY_SPKI, 'MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo');
  assert.equal(deriveDeviceKeyId(PUBLIC_KEY_SPKI), KEY_ID);
  assert.equal(deviceProofSigningBytes({
    publicOrigin: ORIGIN,
    keyId: KEY_ID,
    timestamp: TIMESTAMP,
    nonce: NONCE,
    method: 'POST',
    path: '/v1/llm/chat',
    bodyBytes: BODY,
    token: TOKEN,
  }).toString('utf8'), [
    'AIFIOS-DEVICE-PROOF-V1',
    ORIGIN,
    KEY_ID,
    String(TIMESTAMP),
    NONCE,
    'POST',
    '/v1/llm/chat',
    'hrXI_sFDwn4JiEfOhNj-jTO1VWtNblF-BH_hS9bcyqU',
    'hP0GLfS_9qnbwCmurfAv7zzxmxEoGKHe6LeCZzvLVIQ',
  ].join('\n'));
  assert.equal(
    headers()['x-aifios-device-signature'],
    'iIf2R5eY4QSf2aYg-0Iz3FFgiF3gMhbPw6AleR-k75XuFqqdFXYBKWzFq8Q-RkF7y9E83JP_KYKKFKSVV7PPAg',
  );
});

test('verification binds origin, key, timestamp, nonce, method, path, body, and token', () => {
  const proofHeaders = headers();
  const common = {
    headers: proofHeaders,
    publicOrigin: ORIGIN,
    expectedDevice: DEVICE,
    method: 'POST',
    path: '/v1/llm/chat',
    bodyBytes: BODY,
    token: TOKEN,
    now: TIMESTAMP,
    maxSkewMs: 300_000,
  };
  assert.equal(verifyDeviceProof(common).keyId, KEY_ID);

  for (const changes of [
    { publicOrigin: 'https://other.example.com' },
    { method: 'GET' },
    { path: '/v1/me' },
    { bodyBytes: Buffer.from('{}') },
    { token: 'stolen-other-token' },
  ]) {
    assert.throws(
      () => verifyDeviceProof({ ...common, ...changes }),
      (error) => error?.code === 'invalid_device_proof',
    );
  }
});

test('verification rejects expired, future, malformed, and wrong-key proofs', () => {
  const common = {
    headers: headers(),
    publicOrigin: ORIGIN,
    expectedDevice: DEVICE,
    method: 'POST',
    path: '/v1/llm/chat',
    bodyBytes: BODY,
    token: TOKEN,
    maxSkewMs: 300_000,
  };
  assert.throws(
    () => verifyDeviceProof({ ...common, now: TIMESTAMP + 300_001 }),
    (error) => error?.code === 'expired_device_proof',
  );
  assert.throws(
    () => verifyDeviceProof({ ...common, now: TIMESTAMP - 300_001 }),
    (error) => error?.code === 'future_device_proof',
  );
  assert.throws(
    () => verifyDeviceProof({
      ...common,
      now: TIMESTAMP,
      headers: { ...headers(), 'x-aifios-device-signature': 'not-base64url' },
    }),
    (error) => error?.code === 'invalid_device_proof',
  );
  assert.throws(
    () => verifyDeviceProof({
      ...common,
      now: TIMESTAMP,
      expectedDevice: { ...DEVICE, keyId: `ed25519:${'A'.repeat(43)}` },
    }),
    (error) => error?.code === 'invalid_device_key',
  );
});

test('public origin is HTTPS-only outside loopback and contains no path or credentials', () => {
  assert.equal(normalizePublicOrigin('https://gateway.example.com/'), 'https://gateway.example.com');
  assert.equal(normalizePublicOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const value of ['', 'http://gateway.example.com', 'https://u:p@gateway.example.com', 'https://gateway.example.com/api']) {
    assert.throws(() => normalizePublicOrigin(value));
  }
});


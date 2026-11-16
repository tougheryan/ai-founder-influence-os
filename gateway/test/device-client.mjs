import { randomBytes } from 'node:crypto';
import { createDeviceProofHeaders, generateDeviceKeyPair } from '../src/device-proof.mjs';

export const TEST_PUBLIC_ORIGIN = 'https://gateway.test';

export function newDevice() {
  return generateDeviceKeyPair();
}

export function signedRequestOptions({
  device,
  publicOrigin = TEST_PUBLIC_ORIGIN,
  method = 'GET',
  path,
  bodyBytes = Buffer.alloc(0),
  token = '',
  timestamp = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
  signingMethod = method,
  signingPath = path,
  signingBodyBytes = bodyBytes,
  signingToken = token,
  extraHeaders = {},
}) {
  return {
    method,
    headers: {
      ...(bodyBytes.length ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...createDeviceProofHeaders({
        privateKey: device.privateKey,
        publicOrigin,
        keyId: device.device.keyId,
        timestamp,
        nonce,
        method: signingMethod,
        path: signingPath,
        bodyBytes: signingBodyBytes,
        token: signingToken,
      }),
      ...extraHeaders,
    },
    ...(bodyBytes.length ? { body: bodyBytes } : {}),
  };
}

export function activationRequestOptions(code, device, overrides = {}) {
  const bodyBytes = Buffer.from(JSON.stringify({ code, device: device.device }), 'utf8');
  return signedRequestOptions({ device, method: 'POST', path: '/v1/activate', bodyBytes, ...overrides });
}

export async function activate(gatewayUrl, code, device, overrides = {}) {
  return fetch(`${gatewayUrl}/v1/activate`, activationRequestOptions(code, device, overrides));
}

export async function signedFetch(gatewayUrl, path, options) {
  return fetch(`${gatewayUrl}${path}`, signedRequestOptions({ path, ...options }));
}


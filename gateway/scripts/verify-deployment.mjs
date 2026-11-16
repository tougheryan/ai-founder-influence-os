#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import {
  createDeviceProofHeaders,
  generateDeviceKeyPair,
  normalizePublicOrigin,
} from '../src/device-proof.mjs';

const gatewayUrl = String(process.env.AIFIOS_GATEWAY_URL || '').replace(/\/$/, '');
const adminToken = String(process.env.GATEWAY_ADMIN_TOKEN || '');
const runModelSmoke = process.argv.includes('--model-smoke');

if (!gatewayUrl || !adminToken) {
  console.error('Set AIFIOS_GATEWAY_URL and GATEWAY_ADMIN_TOKEN before verification.');
  process.exit(1);
}

let publicOrigin;
try {
  publicOrigin = normalizePublicOrigin(gatewayUrl);
} catch (error) {
  console.error(`AIFIOS_GATEWAY_URL must be the exact public gateway origin: ${error.message}`);
  process.exit(1);
}

const primaryDevice = generateDeviceKeyPair();
const otherDevice = generateDeviceKeyPair();
let disposableInviteId = '';

async function adminRequest(path, options = {}) {
  const response = await fetch(`${gatewayUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      authorization: `Bearer ${adminToken}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `${path} returned ${response.status}`);
  return payload;
}

function signedOptions({ device, method = 'GET', path, body = Buffer.alloc(0), token = '', nonce }) {
  return {
    method,
    headers: {
      ...(body.length ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...createDeviceProofHeaders({
        privateKey: device.privateKey,
        publicOrigin,
        keyId: device.device.keyId,
        method,
        path,
        bodyBytes: body,
        token,
        nonce: nonce || randomBytes(24).toString('base64url'),
      }),
    },
    ...(body.length ? { body } : {}),
    signal: AbortSignal.timeout(path === '/v1/llm/chat' ? 60_000 : 20_000),
  };
}

function activationOptions(code, device) {
  const body = Buffer.from(JSON.stringify({ code, device: device.device }), 'utf8');
  return signedOptions({ device, method: 'POST', path: '/v1/activate', body });
}

async function errorPayload(response) {
  return response.json().catch(() => null);
}

try {
  const healthResponse = await fetch(`${gatewayUrl}/healthz`, { signal: AbortSignal.timeout(10_000) });
  const health = await healthResponse.json().catch(() => null);
  if (!healthResponse.ok) throw new Error(`/healthz returned ${healthResponse.status}`);
  if (health?.deviceProof?.version !== '1' || health?.deviceProof?.algorithm !== 'Ed25519') {
    throw new Error('/healthz does not advertise Ed25519 device proof v1');
  }

  const created = await adminRequest('/admin/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: `deploy-check-${Date.now()}`, quotaLimit: runModelSmoke ? 1 : 2 }),
  });
  disposableInviteId = created.invite.id;

  const activatedResponse = await fetch(`${gatewayUrl}/v1/activate`, activationOptions(created.code, primaryDevice));
  const activated = await errorPayload(activatedResponse);
  if (!activatedResponse.ok || !activated?.sessionToken) {
    throw new Error(activated?.error?.message || 'invite activation failed');
  }
  if (activated.account?.deviceKeyId !== primaryDevice.device.keyId) {
    throw new Error('activation did not bind the primary Ed25519 key');
  }

  const secondActivation = await fetch(`${gatewayUrl}/v1/activate`, activationOptions(created.code, otherDevice));
  const secondActivationPayload = await errorPayload(secondActivation);
  if (secondActivation.status !== 409 || secondActivationPayload?.error?.code !== 'invite_already_activated') {
    throw new Error('same authorization code was not rejected for a second key');
  }

  const account = await fetch(`${gatewayUrl}/v1/me`, signedOptions({
    device: primaryDevice,
    path: '/v1/me',
    token: activated.sessionToken,
  }));
  if (!account.ok) throw new Error('/v1/me did not accept the bound key and session');

  const stolenSession = await fetch(`${gatewayUrl}/v1/me`, signedOptions({
    device: otherDevice,
    path: '/v1/me',
    token: activated.sessionToken,
  }));
  const stolenPayload = await errorPayload(stolenSession);
  if (stolenSession.status !== 401 || stolenPayload?.error?.code !== 'device_key_mismatch') {
    throw new Error('a stolen bearer session was accepted with another private key');
  }

  const replayNonce = randomBytes(24).toString('base64url');
  const replayOptions = signedOptions({
    device: primaryDevice,
    path: '/v1/me',
    token: activated.sessionToken,
    nonce: replayNonce,
  });
  const replayFirst = await fetch(`${gatewayUrl}/v1/me`, replayOptions);
  if (!replayFirst.ok) throw new Error('fresh nonce was not accepted');
  const replaySecond = await fetch(`${gatewayUrl}/v1/me`, replayOptions);
  const replayPayload = await errorPayload(replaySecond);
  if (replaySecond.status !== 409 || replayPayload?.error?.code !== 'replayed_device_proof') {
    throw new Error('replayed signed request was not rejected');
  }

  if (runModelSmoke) {
    const body = Buffer.from(JSON.stringify({
      stream: false,
      messages: [{ role: 'user', content: 'Reply only with OK.' }],
      options: { maxTokens: 8, temperature: 0 },
    }), 'utf8');
    const model = await fetch(`${gatewayUrl}/v1/llm/chat`, signedOptions({
      device: primaryDevice,
      method: 'POST',
      path: '/v1/llm/chat',
      body,
      token: activated.sessionToken,
    }));
    if (!model.ok) throw new Error(`/v1/llm/chat returned ${model.status}`);
  }

  const invites = await adminRequest('/admin/invites');
  const publicInvite = invites.invites?.find((invite) => invite.id === created.invite.id);
  if (publicInvite?.deviceProofStatus !== 'bound' || publicInvite?.deviceKeyId !== primaryDevice.device.keyId) {
    throw new Error('admin invite state does not expose the bound device proof');
  }

  console.log(`PASS gateway deployment verification (${runModelSmoke ? 'with model smoke' : 'without model smoke'}; Ed25519 proof, key binding, and replay rejection enforced)`);
} catch (error) {
  console.error(`FAIL gateway deployment verification: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (disposableInviteId) {
    await adminRequest(`/admin/invites/${encodeURIComponent(disposableInviteId)}/revoke`, { method: 'POST' }).catch(() => {});
  }
}


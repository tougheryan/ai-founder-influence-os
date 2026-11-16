const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPublicKey, verify } = require('node:crypto');
const { loadOrCreateDeviceKey } = require('./device-key.cjs');
const { canonicalDeviceProof, startHostedGatewayProxy } = require('./hosted-gateway-proxy.cjs');

function storage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`),
    decryptString: (value) => value.toString().slice('protected:'.length),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aifios-hosted-proxy-'));
  const identity = loadOrCreateDeviceKey({
    filePath: path.join(root, 'device-id.json'),
    safeStorage: storage(),
    platform: 'darwin',
  });
  const received = [];
  const remote = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.push({ req, body });
    if (req.url === '/v1/llm/chat') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-private-proof': 'must-not-forward' });
      res.end('data: {"type":"text","content":"hello"}\n\nevent: done\ndata: {}\n\n');
      return;
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const remotePort = await listen(remote);
  const proxy = await startHostedGatewayProxy({
    remoteOrigin: `http://127.0.0.1:${remotePort}`,
    identity,
    allowInsecureForTests: true,
    now: () => 1_900_000_000_000,
    nonce: () => 'fixed_nonce_abcdefghijklmnopqrstuvwxyz',
  });
  try {
    await run({ identity, proxy, received });
  } finally {
    await proxy.close();
    await close(remote);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('activation is registered to the installation public key and signed over exact forwarded bytes', async () => fixture(async ({ identity, proxy, received }) => {
  const response = await fetch(`${proxy.url}/v1/activate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aifios-local-proxy-token': proxy.token,
    },
    body: JSON.stringify({ code: 'AIF-PAID-CODE' }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(received[0].body), {
    code: 'AIF-PAID-CODE',
    device: { algorithm: 'Ed25519', keyId: identity.keyId, publicKeySpki: identity.publicKeySpki },
  });
  const headers = received[0].req.headers;
  const canonical = canonicalDeviceProof({
    origin: proxy.remoteOrigin,
    keyId: identity.keyId,
    timestamp: headers['x-aifios-device-timestamp'],
    nonce: headers['x-aifios-device-nonce'],
    method: 'POST',
    pathname: '/v1/activate',
    body: received[0].body,
    token: '',
  });
  const publicKey = createPublicKey({ key: Buffer.from(identity.publicKeySpki, 'base64url'), type: 'spki', format: 'der' });
  assert.equal(headers['x-aifios-device-proof-version'], '1');
  assert.equal(verify(null, Buffer.from(canonical), publicKey, Buffer.from(headers['x-aifios-device-signature'], 'base64url')), true);
}));

test('the local proxy requires its private child-process token and enforces a fixed route allowlist', async () => fixture(async ({ proxy, received }) => {
  const unauthorized = await fetch(`${proxy.url}/v1/me`);
  const unknown = await fetch(`${proxy.url}/admin/invites`, {
    headers: { 'x-aifios-local-proxy-token': proxy.token },
  });

  assert.equal(unauthorized.status, 401);
  assert.equal(unknown.status, 404);
  assert.equal(received.length, 0);
}));

test('streams model bytes intact without returning proof material to Next', async () => fixture(async ({ proxy }) => {
  const response = await fetch(`${proxy.url}/v1/llm/chat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${'p'.repeat(43)}`,
      'content-type': 'application/json',
      'x-aifios-local-proxy-token': proxy.token,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: true }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(body, 'data: {"type":"text","content":"hello"}\n\nevent: done\ndata: {}\n\n');
  assert.equal(response.headers.get('x-private-proof'), null);
  assert.equal(response.headers.get('x-aifios-device-signature'), null);
}));

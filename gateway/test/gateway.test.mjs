import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer } from '../src/server.mjs';
import { hostedResearchSigningBytes } from '../src/market-research.mjs';
import {
  TEST_PUBLIC_ORIGIN,
  activate,
  activationRequestOptions,
  newDevice,
  signedFetch,
  signedRequestOptions,
} from './device-client.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function rawHttp(gatewayUrl, { method = 'GET', path, headers = [], body = '' }) {
  const target = new URL(gatewayUrl);
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(Number(target.port), target.hostname);
    const requestHeaders = [
      `${method} ${path} HTTP/1.1`,
      `Host: ${target.host}`,
      'Connection: close',
      ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []),
    ];
    for (let index = 0; index < headers.length; index += 2) {
      requestHeaders.push(`${headers[index]}: ${headers[index + 1]}`);
    }
    const requestBody = `${requestHeaders.join('\r\n')}\r\n\r\n${body}`;
    const chunks = [];
    socket.on('connect', () => socket.end(requestBody));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const response = Buffer.concat(chunks);
      const separator = response.indexOf(Buffer.from('\r\n\r\n'));
      const headerText = (separator >= 0 ? response.subarray(0, separator) : response).toString('utf8');
      let bodyBuffer = separator >= 0 ? response.subarray(separator + 4) : Buffer.alloc(0);
      if (headerText.toLowerCase().includes('transfer-encoding: chunked')) {
        const decoded = [];
        let offset = 0;
        while (offset < bodyBuffer.length) {
          const lineEnd = bodyBuffer.indexOf(Buffer.from('\r\n'), offset);
          if (lineEnd < 0) break;
          const size = Number.parseInt(bodyBuffer.subarray(offset, lineEnd).toString('ascii'), 16);
          if (!Number.isFinite(size) || size === 0) break;
          const start = lineEnd + 2;
          decoded.push(bodyBuffer.subarray(start, start + size));
          offset = start + size + 2;
        }
        bodyBuffer = Buffer.concat(decoded);
      }
      const status = Number.parseInt(headerText.match(/^HTTP\/\d\.\d\s+(\d+)/)?.[1] || '0', 10);
      resolve({ status, body: bodyBuffer.toString('utf8') });
    });
  });
}

function rawHeaderPairs(headers) {
  return Object.entries(headers).flatMap(([name, value]) => [name, String(value)]);
}

function config(dataDir, upstream, extra = {}) {
  return {
    bindHost: '127.0.0.1',
    port: 0,
    dataDir,
    publicOrigin: TEST_PUBLIC_ORIGIN,
    adminToken: 'admin-secret',
    tokenPepper: 'test-pepper',
    inviteDefaultQuota: 3,
    sessionTtlDays: 30,
    activationRateLimit: 100,
    activationRateWindowSeconds: 900,
    deviceProofMaxSkewSeconds: 300,
    upstream: upstream || {
      apiKind: 'openai-compatible',
      apiKey: 'owner-key',
      baseUrl: 'https://upstream.example.com/v1/',
      model: 'owner-model',
      maxTokens: 8000,
      temperature: 0.7,
    },
    ...extra,
  };
}

async function createInvite(gatewayUrl, body = {}) {
  const response = await fetch(`${gatewayUrl}/admin/invites`, {
    method: 'POST',
    headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('signed activation proxies a completion, tracks quota, and rejects a stolen session', async (t) => {
  const upstream = createServer(async (req, res) => {
    const raw = await readRequest(req);
    const payload = JSON.parse(raw);
    assert.equal(req.headers.authorization, 'Bearer owner-key');
    assert.equal(payload.model, 'owner-model');
    assert.equal(payload.stream, false);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'gateway ok' } }] }));
  });
  const upstreamUrl = await listen(upstream);
  const dataDir = await mkdtemp(join(tmpdir(), 'aifios-gateway-'));
  const { server } = await createGatewayServer({
    config: config(dataDir, {
      apiKind: 'openai-compatible',
      apiKey: 'owner-key',
      baseUrl: `${upstreamUrl}/v1/`,
      model: 'owner-model',
      maxTokens: 8000,
      temperature: 0.7,
    }),
  });
  const gatewayUrl = await listen(server);
  t.after(async () => {
    await close(server);
    await close(upstream);
    await rm(dataDir, { recursive: true, force: true });
  });

  const health = await (await fetch(`${gatewayUrl}/healthz`)).json();
  assert.deepEqual(health.deviceProof, { version: '1', algorithm: 'Ed25519' });
  const invite = await createInvite(gatewayUrl, { label: 'friend one', quotaLimit: 1 });
  assert.match(invite.code, /^AIF-/);
  assert.equal(invite.invite.deviceProofStatus, 'unbound');

  const device = newDevice();
  const activationResponse = await activate(gatewayUrl, invite.code, device);
  assert.equal(activationResponse.status, 201);
  const activation = await activationResponse.json();
  assert.ok(activation.sessionToken);
  assert.equal(activation.account.deviceKeyId, device.device.keyId);
  assert.equal(activation.quota.remaining, 1);

  const completionBody = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  }));
  const completionResponse = await signedFetch(gatewayUrl, '/v1/llm/chat', {
    device,
    method: 'POST',
    bodyBytes: completionBody,
    token: activation.sessionToken,
  });
  assert.equal(completionResponse.status, 200);
  assert.equal((await completionResponse.json()).content, 'gateway ok');

  const meResponse = await signedFetch(gatewayUrl, '/v1/me', { device, token: activation.sessionToken });
  assert.equal(meResponse.status, 200);
  assert.deepEqual((await meResponse.json()).quota, { limit: 1, used: 1, remaining: 0 });

  const exhausted = await signedFetch(gatewayUrl, '/v1/llm/chat', {
    device,
    method: 'POST',
    bodyBytes: Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'again' }], stream: false })),
    token: activation.sessionToken,
  });
  assert.equal(exhausted.status, 429);

  const thiefDevice = newDevice();
  const stolenSession = await signedFetch(gatewayUrl, '/v1/me', {
    device: thiefDevice,
    token: activation.sessionToken,
  });
  assert.equal(stolenSession.status, 401);
  assert.equal((await stolenSession.json()).error.code, 'device_key_mismatch');

  const noProof = await fetch(`${gatewayUrl}/v1/me`, {
    headers: { authorization: `Bearer ${activation.sessionToken}` },
  });
  assert.equal(noProof.status, 401);
  assert.equal((await noProof.json()).error.code, 'missing_device_proof');

  const persisted = await readFile(join(dataDir, 'ledger.json'), 'utf8');
  assert.equal(persisted.includes(invite.code), false);
  assert.equal(persisted.includes(activation.sessionToken), false);
  assert.equal(persisted.includes('owner-key'), false);
  assert.equal(persisted.includes(device.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')), false);
  assert.match(persisted, /"schema": "aifios.gateway-ledger.v2"/);
});

test('streaming requests require proof and revocation stops the bound key', async (t) => {
  const upstream = createServer(async (req, res) => {
    await readRequest(req);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const upstreamUrl = await listen(upstream);
  const dataDir = await mkdtemp(join(tmpdir(), 'aifios-gateway-'));
  const { server } = await createGatewayServer({
    config: config(dataDir, {
      apiKind: 'openai-compatible', apiKey: 'owner-key', baseUrl: `${upstreamUrl}/v1/`,
      model: 'owner-model', maxTokens: 8000, temperature: 0.7,
    }),
  });
  const gatewayUrl = await listen(server);
  t.after(async () => {
    await close(server);
    await close(upstream);
    await rm(dataDir, { recursive: true, force: true });
  });

  const invite = await createInvite(gatewayUrl);
  const device = newDevice();
  const activation = await (await activate(gatewayUrl, invite.code, device)).json();
  const streamBody = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: true }));
  const streamResponse = await signedFetch(gatewayUrl, '/v1/llm/chat', {
    device, method: 'POST', bodyBytes: streamBody, token: activation.sessionToken,
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.match(streamText, /"content":"hello "/);
  assert.match(streamText, /"content":"world"/);
  assert.match(streamText, /event: done/);

  const revoke = await fetch(`${gatewayUrl}/admin/invites/${invite.invite.id}/revoke`, {
    method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(revoke.status, 200);
  const stopped = await signedFetch(gatewayUrl, '/v1/me', { device, token: activation.sessionToken });
  assert.equal(stopped.status, 401);
  assert.equal((await stopped.json()).error.code, 'invalid_session');
});

test('hosted TikOmni research verifies proof, uses frozen endpoints, and signs its response', async (t) => {
  const received = [];
  const tikomni = createServer(async (req, res) => {
    const body = await readRequest(req);
    received.push({ url: req.url, method: req.method, body, authorization: req.headers.authorization });
    assert.equal(req.headers.authorization, 'Bearer owner-tikomni-token');
    const path = new URL(req.url, 'http://tikomni.local').pathname;
    assert.ok([
      '/api/u1/v1/wechat_search/v2/fetch_search',
      '/api/u1/v1/xiaohongshu/app_v2/search_notes',
      '/api/u1/v1/wechat_search/v2/fetch_search_videos',
    ].includes(path));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { items: [{ title: `sample ${path}`, desc: '公开样本' }] } }));
  });
  const tikomniUrl = await listen(tikomni);
  const dataDir = await mkdtemp(join(tmpdir(), 'aifios-gateway-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { server } = await createGatewayServer({
    config: config(dataDir, undefined, {
      research: {
        enabled: true,
        token: 'owner-tikomni-token',
        baseUrl: tikomniUrl,
        timeoutMs: 5_000,
        keyId: 'market-test',
        privateKey,
      },
    }),
  });
  const gatewayUrl = await listen(server);
  t.after(async () => {
    await close(server);
    await close(tikomni);
    await rm(dataDir, { recursive: true, force: true });
  });

  const invite = await createInvite(gatewayUrl, { quotaLimit: 1 });
  const device = newDevice();
  const activation = await (await activate(gatewayUrl, invite.code, device)).json();
  const requestId = '4ee7c411-7924-4b18-b15f-59da5f2ffea0';
  const body = Buffer.from(JSON.stringify({ requestId, queries: ['企业出海 自媒体'] }));
  const response = await signedFetch(gatewayUrl, '/v1/research/market-signal', {
    device, method: 'POST', bodyBytes: body, token: activation.sessionToken,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(received.length, 3);
  assert.equal(payload.envelope.payload.requestId, requestId);
  assert.deepEqual(payload.envelope.payload.requiredPlatforms, ['wechat_mp', 'xiaohongshu', 'wechat_channels']);
  assert.equal(payload.quota.requestsRemaining, 0);
  assert.ok(verify(
    null,
    hostedResearchSigningBytes(payload.envelope.keyId, payload.envelope.payload),
    publicKey,
    Buffer.from(payload.envelope.signature, 'base64url'),
  ));

  const persisted = await readFile(join(dataDir, 'ledger.json'), 'utf8');
  assert.match(persisted, /"kind": "market_research"/);
  assert.equal(persisted.includes('owner-tikomni-token'), false);
  assert.equal(persisted.includes('公开样本'), false);
});

test('tampering, stale clocks, concurrent replay, and replay after restart fail closed', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aifios-gateway-'));
  let active = await createGatewayServer({ config: config(dataDir) });
  let gatewayUrl = await listen(active.server);
  t.after(async () => {
    await close(active.server);
    await rm(dataDir, { recursive: true, force: true });
  });
  const invite = await createInvite(gatewayUrl, { quotaLimit: 20 });
  const device = newDevice();
  const activation = await (await activate(gatewayUrl, invite.code, device)).json();
  const validBody = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'signed' }], stream: false }));
  const tamperedBody = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'tampered' }], stream: false }));

  const tampered = await signedFetch(gatewayUrl, '/v1/llm/chat', {
    device,
    method: 'POST',
    bodyBytes: tamperedBody,
    signingBodyBytes: validBody,
    token: activation.sessionToken,
  });
  assert.equal(tampered.status, 401);
  assert.equal((await tampered.json()).error.code, 'invalid_device_proof');

  const wrongPath = await signedFetch(gatewayUrl, '/v1/llm/chat', {
    device,
    method: 'POST',
    bodyBytes: validBody,
    signingPath: '/v1/me',
    token: activation.sessionToken,
  });
  assert.equal(wrongPath.status, 401);
  assert.equal((await wrongPath.json()).error.code, 'invalid_device_proof');

  const wrongTokenHash = await signedFetch(gatewayUrl, '/v1/me', {
    device,
    token: activation.sessionToken,
    signingToken: 'A'.repeat(43),
  });
  assert.equal(wrongTokenHash.status, 401);
  assert.equal((await wrongTokenHash.json()).error.code, 'invalid_device_proof');

  const expired = await signedFetch(gatewayUrl, '/v1/me', {
    device,
    token: activation.sessionToken,
    timestamp: Date.now() - 300_001,
  });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, 'expired_device_proof');
  const future = await signedFetch(gatewayUrl, '/v1/me', {
    device,
    token: activation.sessionToken,
    timestamp: Date.now() + 301_000,
  });
  assert.equal(future.status, 401);
  assert.equal((await future.json()).error.code, 'future_device_proof');

  const concurrentOptions = signedRequestOptions({
    device,
    path: '/v1/me',
    token: activation.sessionToken,
    nonce: 'concurrent-replay-proof-nonce-01',
  });
  const concurrent = await Promise.all([
    fetch(`${gatewayUrl}/v1/me`, concurrentOptions),
    fetch(`${gatewayUrl}/v1/me`, concurrentOptions),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort((a, b) => a - b), [200, 409]);
  const replayPayload = await concurrent.find((response) => response.status === 409).json();
  assert.equal(replayPayload.error.code, 'replayed_device_proof');

  const exactTargetOptions = signedRequestOptions({
    device,
    path: '/v1/me',
    token: activation.sessionToken,
    nonce: 'raw-target-and-duplicate-proof-01',
  });
  const exactTargetHeaders = rawHeaderPairs(exactTargetOptions.headers);
  const queryTarget = await rawHttp(gatewayUrl, {
    path: '/v1/me?x=1',
    headers: exactTargetHeaders,
  });
  assert.equal(queryTarget.status, 400);
  const normalizedTarget = await rawHttp(gatewayUrl, {
    path: '/v1/x/../me',
    headers: exactTargetHeaders,
  });
  assert.equal(normalizedTarget.status, 400);
  assert.equal(JSON.parse(normalizedTarget.body).error.code, 'invalid_device_proof_path');

  const duplicateProof = await rawHttp(gatewayUrl, {
    path: '/v1/me',
    headers: [
      ...exactTargetHeaders,
      'x-aifios-device-nonce', exactTargetOptions.headers['x-aifios-device-nonce'],
    ],
  });
  assert.equal(duplicateProof.status, 401);
  assert.equal(JSON.parse(duplicateProof.body).error.code, 'invalid_device_proof');
  const duplicateAuthorization = await rawHttp(gatewayUrl, {
    path: '/v1/me',
    headers: [
      ...exactTargetHeaders,
      'authorization', `Bearer ${activation.sessionToken}`,
    ],
  });
  assert.equal(duplicateAuthorization.status, 401);
  assert.equal(JSON.parse(duplicateAuthorization.body).error.code, 'invalid_session');

  const restartOptions = signedRequestOptions({
    device,
    path: '/v1/me',
    token: activation.sessionToken,
    nonce: 'restart-persistent-replay-nonce-1',
  });
  assert.equal((await fetch(`${gatewayUrl}/v1/me`, restartOptions)).status, 200);
  await close(active.server);
  active = await createGatewayServer({ config: config(dataDir) });
  gatewayUrl = await listen(active.server);
  const afterRestart = await fetch(`${gatewayUrl}/v1/me`, restartOptions);
  assert.equal(afterRestart.status, 409);
  assert.equal((await afterRestart.json()).error.code, 'replayed_device_proof');
});

test('authorization code binds one key, renews on that key, and reissue moves unused quota', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aifios-gateway-'));
  const { server } = await createGatewayServer({ config: config(dataDir) });
  const gatewayUrl = await listen(server);
  t.after(async () => {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  });

  const created = await createInvite(gatewayUrl, { label: 'paid user', quotaLimit: 3 });
  const firstDevice = newDevice();
  const secondDevice = newDevice();
  const first = await (await activate(gatewayUrl, created.code, firstDevice)).json();

  const secondActivation = await activate(gatewayUrl, created.code, secondDevice);
  assert.equal(secondActivation.status, 409);
  assert.equal((await secondActivation.json()).error.code, 'invite_already_activated');

  const renewedResponse = await activate(gatewayUrl, created.code, firstDevice);
  assert.equal(renewedResponse.status, 201);
  const renewed = await renewedResponse.json();
  const oldSession = await signedFetch(gatewayUrl, '/v1/me', { device: firstDevice, token: first.sessionToken });
  assert.equal(oldSession.status, 401);
  assert.equal((await oldSession.json()).error.code, 'invalid_session');
  assert.equal((await signedFetch(gatewayUrl, '/v1/me', {
    device: firstDevice, token: renewed.sessionToken,
  })).status, 200);

  const reissuedResponse = await fetch(`${gatewayUrl}/admin/invites/${created.invite.id}/reissue`, {
    method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(reissuedResponse.status, 201);
  const reissued = await reissuedResponse.json();
  assert.notEqual(reissued.code, created.code);
  assert.equal(reissued.invite.requestsRemaining, 3);
  assert.equal(reissued.invite.deviceProofStatus, 'unbound');

  const reissuedOldSession = await signedFetch(gatewayUrl, '/v1/me', {
    device: firstDevice, token: renewed.sessionToken,
  });
  assert.equal(reissuedOldSession.status, 401);
  const oldCode = await fetch(`${gatewayUrl}/v1/activate`, activationRequestOptions(created.code, secondDevice));
  assert.equal(oldCode.status, 401);

  const replacement = await activate(gatewayUrl, reissued.code, secondDevice);
  assert.equal(replacement.status, 201);
  const replacementPayload = await replacement.json();
  assert.equal(replacementPayload.account.deviceKeyId, secondDevice.device.keyId);

  const list = await (await fetch(`${gatewayUrl}/admin/invites`, {
    headers: { authorization: 'Bearer admin-secret' },
  })).json();
  const replacementPublic = list.invites.find((invite) => invite.id === reissued.invite.id);
  assert.equal(replacementPublic.deviceBound, true);
  assert.equal(replacementPublic.deviceProofStatus, 'bound');
  assert.equal(replacementPublic.deviceKeyId, secondDevice.device.keyId);
});

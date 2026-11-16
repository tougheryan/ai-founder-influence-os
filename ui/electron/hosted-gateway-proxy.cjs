const { createHash, randomBytes, timingSafeEqual } = require('crypto');
const { createServer } = require('http');
const { Readable } = require('stream');
const { DEVICE_PROOF_VERSION, signCanonical } = require('./device-key.cjs');

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1_500_000;
const ALLOWED_REQUESTS = new Map([
  ['/v1/activate', 'POST'],
  ['/v1/me', 'GET'],
  ['/v1/llm/chat', 'POST'],
  ['/v1/research/market-signal', 'POST'],
]);

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function normalizeRemoteOrigin(value, allowInsecure = false) {
  const parsed = new URL(String(value || '').trim());
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Hosted gateway must be a credential-free origin.');
  }
  if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) {
    throw new Error('Hosted gateway must use HTTPS.');
  }
  return parsed.origin;
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function singleRawHeader(req, name) {
  const matches = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index] || '').toLowerCase() === name) {
      matches.push(String(req.rawHeaders[index + 1] || ''));
    }
  }
  return matches.length === 1 ? matches[0] : '';
}

function localAuthorized(req, proxyToken) {
  return safeEqual(singleRawHeader(req, 'x-aifios-local-proxy-token'), proxyToken);
}

async function readBody(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bearerToken(req) {
  const value = singleRawHeader(req, 'authorization');
  // The gateway issues exactly 32 random bytes encoded as 43 base64url
  // characters. Keep the child-process boundary as strict as the remote
  // gateway so malformed bearer values never reach the signing layer.
  const match = value.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match?.[1] || '';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function canonicalDeviceProof({ origin, keyId, timestamp, nonce, method, pathname, body, token }) {
  return [
    'AIFIOS-DEVICE-PROOF-V1',
    origin,
    keyId,
    String(timestamp),
    nonce,
    method.toUpperCase(),
    pathname,
    sha256(body),
    sha256(token),
  ].join('\n');
}

function deviceProofHeaders({ identity, origin, method, pathname, body, token, now, nonce }) {
  const timestamp = String(now());
  const requestNonce = nonce();
  const canonical = canonicalDeviceProof({
    origin,
    keyId: identity.keyId,
    timestamp,
    nonce: requestNonce,
    method,
    pathname,
    body,
    token,
  });
  return {
    'x-aifios-device-proof-version': DEVICE_PROOF_VERSION,
    'x-aifios-device-key-id': identity.keyId,
    'x-aifios-device-timestamp': timestamp,
    'x-aifios-device-nonce': requestNonce,
    'x-aifios-device-signature': signCanonical(identity, canonical),
  };
}

function activationBody(rawBody, identity) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Activation request must contain JSON.'), { status: 400 });
  }
  const code = typeof parsed?.code === 'string' ? parsed.code.trim() : '';
  if (!code || code.length > 256 || /[\r\n]/.test(code)) {
    throw Object.assign(new Error('Activation code is invalid.'), { status: 400 });
  }
  return Buffer.from(JSON.stringify({
    code,
    device: {
      algorithm: 'Ed25519',
      keyId: identity.keyId,
      publicKeySpki: identity.publicKeySpki,
    },
  }), 'utf8');
}

function forwardedHeaders(response) {
  const headers = {};
  for (const name of [
    'content-type',
    'cache-control',
    'x-content-type-options',
    'x-aifios-quota-limit',
    'x-aifios-quota-used',
    'x-aifios-quota-remaining',
    'x-accel-buffering',
  ]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function listen(server, host = HOST) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startHostedGatewayProxy({
  remoteOrigin,
  identity,
  fetchImpl = fetch,
  allowInsecureForTests = false,
  maxBodyBytes = MAX_BODY_BYTES,
  now = () => Date.now(),
  nonce = () => randomBytes(24).toString('base64url'),
} = {}) {
  if (!identity?.privateKey || !identity?.keyId || !identity?.publicKeySpki) {
    throw new Error('A valid device signing identity is required.');
  }
  const origin = normalizeRemoteOrigin(remoteOrigin, allowInsecureForTests);
  const proxyToken = randomBytes(32).toString('base64url');
  const server = createServer(async (req, res) => {
    try {
      if (!localAuthorized(req, proxyToken)) {
        return json(res, 401, { error: { code: 'local_proxy_unauthorized', message: 'Local gateway proxy authentication failed.' } });
      }
      const pathname = String(req.url || '');
      const method = String(req.method || 'GET').toUpperCase();
      if (ALLOWED_REQUESTS.get(pathname) !== method) {
        return json(res, 404, { error: { code: 'local_proxy_not_found', message: 'Gateway route is not available.' } });
      }

      let body = await readBody(req, maxBodyBytes);
      if (method === 'GET' && body.length) {
        return json(res, 400, { error: { code: 'unexpected_body', message: 'GET gateway routes do not accept a body.' } });
      }
      if (pathname === '/v1/activate') body = activationBody(body, identity);
      const token = bearerToken(req);
      if (pathname !== '/v1/activate' && !token) {
        return json(res, 401, { error: { code: 'missing_session', message: 'A valid hosted session is required.' } });
      }
      const proof = deviceProofHeaders({ identity, origin, method, pathname, body, token, now, nonce });
      const remoteResponse = await fetchImpl(`${origin}${pathname}`, {
        method,
        headers: {
          ...proof,
          ...(body.length ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body.length ? { body } : {}),
        redirect: 'error',
      });

      res.writeHead(remoteResponse.status, forwardedHeaders(remoteResponse));
      if (!remoteResponse.body) {
        res.end();
        return;
      }
      Readable.fromWeb(remoteResponse.body).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = Number.isInteger(error?.status) ? error.status : 502;
      json(res, status, {
        error: {
          code: status === 413 ? 'payload_too_large' : status === 400 ? 'invalid_request' : 'gateway_unavailable',
          message: status >= 500 ? 'Hosted gateway is unavailable.' : error.message,
        },
      });
    }
  });
  const address = await listen(server);
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Local hosted gateway proxy did not bind to TCP.');
  }
  return {
    url: `http://${HOST}:${address.port}`,
    token: proxyToken,
    remoteOrigin: origin,
    close: () => closeServer(server),
  };
}

module.exports = {
  ALLOWED_REQUESTS,
  canonicalDeviceProof,
  deviceProofHeaders,
  normalizeRemoteOrigin,
  startHostedGatewayProxy,
};

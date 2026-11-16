import test from 'node:test';
import assert from 'node:assert/strict';
import { FunctionResponse, createRuntime, requestFromEvent } from '../src/cloudbase-handler.mjs';

class FakeDb {
  state = null;

  collection() {
    return {
      doc: () => ({
        get: async () => ({ data: this.state ? structuredClone(this.state) : undefined }),
        set: async (value) => { this.state = structuredClone(value); },
      }),
    };
  }

  async runTransaction(callback) {
    const state = this.state ? structuredClone(this.state) : null;
    const transaction = {
      state,
      collection: () => ({
        doc: () => ({
          get: async () => ({ data: transaction.state ? structuredClone(transaction.state) : undefined }),
          set: async (value) => { transaction.state = structuredClone(value); },
        }),
      }),
    };
    const result = await callback(transaction);
    this.state = transaction.state;
    return result;
  }
}

test('CloudBase event adapter strips an API Gateway stage prefix and decodes request bodies', async () => {
  const previous = process.env.GATEWAY_PATH_PREFIX;
  process.env.GATEWAY_PATH_PREFIX = '/prod';
  try {
    const request = requestFromEvent({
      httpMethod: 'POST',
      path: '/prod/v1/activate',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"code":"AIF-test"}').toString('base64'),
      isBase64Encoded: true,
      requestContext: { sourceIp: '203.0.113.9' },
    });
    assert.equal(request.url, '/v1/activate');
    assert.equal(request.method, 'POST');
    assert.equal(request.socket.remoteAddress, '203.0.113.9');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), '{"code":"AIF-test"}');
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_PATH_PREFIX;
    else process.env.GATEWAY_PATH_PREFIX = previous;
  }
});

test('CloudBase response adapter collects JSON and streaming writes', () => {
  const response = new FunctionResponse();
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('data: one\\n\\n');
  response.end('data: done\\n\\n');
  assert.deepEqual(response.result(), {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: one\\n\\ndata: done\\n\\n',
    isBase64Encoded: false,
  });
});

test('CloudBase runtime wires the gateway handler without binding a local TCP port', async () => {
  const names = [
    'GATEWAY_PUBLIC_ORIGIN', 'GATEWAY_ADMIN_TOKEN', 'GATEWAY_TOKEN_PEPPER',
    'UPSTREAM_API_KEY', 'UPSTREAM_BASE_URL', 'UPSTREAM_MODEL',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    GATEWAY_PUBLIC_ORIGIN: 'https://license.example.cn',
    GATEWAY_ADMIN_TOKEN: 'admin-token',
    GATEWAY_TOKEN_PEPPER: 'pepper-token',
    UPSTREAM_API_KEY: 'upstream-key',
    UPSTREAM_BASE_URL: 'https://api.example.cn/v1',
    UPSTREAM_MODEL: 'model-name',
  });
  try {
    const { handler } = await createRuntime({
      sdkModule: { init: () => ({ database: () => new FakeDb() }) },
    });
    const response = new FunctionResponse();
    await handler(requestFromEvent({ httpMethod: 'GET', path: '/healthz' }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.result().body).ok, true);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

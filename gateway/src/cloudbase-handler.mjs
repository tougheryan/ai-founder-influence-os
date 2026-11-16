import { createGatewayHandler, readGatewayConfig } from './server.mjs';
import { CloudBaseGatewayStore } from './cloudbase-store.mjs';

const DEFAULT_COLLECTION = 'aifios_gateway_ledger';
const DEFAULT_DOCUMENT_ID = 'main';

let runtimePromise;

function plainText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function eventObject(event) {
  if (typeof event === 'string') {
    try {
      return JSON.parse(event);
    } catch {
      return {};
    }
  }
  return event && typeof event === 'object' ? event : {};
}

function eventHeaders(event) {
  const source = event.headers && typeof event.headers === 'object' ? event.headers : {};
  const headers = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') headers[String(key).toLowerCase()] = value;
  }
  return headers;
}

function rawHeaderPairs(event, headers) {
  if (Array.isArray(event.rawHeaders) && event.rawHeaders.length % 2 === 0) {
    return event.rawHeaders.map((value) => String(value ?? ''));
  }
  return Object.entries(headers).flatMap(([key, value]) => [key, value]);
}

function requestFromEvent(event) {
  const headers = eventHeaders(event);
  const encodedBody = plainText(event.body);
  let body = Buffer.alloc(0);
  if (encodedBody) {
    body = event.isBase64Encoded === true
      ? Buffer.from(encodedBody, 'base64')
      : Buffer.from(encodedBody, 'utf8');
  }
  const method = plainText(event.httpMethod)
    || plainText(event.requestContext?.http?.method)
    || 'GET';
  const rawUrl = plainText(event.rawPath)
    || plainText(event.path)
    || plainText(event.requestContext?.path)
    || '/';
  const configuredPrefix = plainText(process.env.GATEWAY_PATH_PREFIX).replace(/\/$/, '');
  const url = configuredPrefix && (rawUrl === configuredPrefix || rawUrl.startsWith(`${configuredPrefix}/`))
    ? rawUrl.slice(configuredPrefix.length) || '/'
    : rawUrl;
  const sourceIp = plainText(event.requestContext?.sourceIp)
    || plainText(event.requestContext?.clientIp)
    || 'cloudbase-function';
  return {
    method,
    url,
    headers,
    rawHeaders: rawHeaderPairs(event, headers),
    socket: { remoteAddress: sourceIp },
    async *[Symbol.asyncIterator]() {
      if (body.length) yield body;
    },
  };
}

class FunctionResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
    this.ended = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
  }

  write(chunk) {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.ended = true;
  }

  result() {
    return {
      statusCode: this.statusCode,
      headers: this.headers,
      body: Buffer.concat(this.chunks).toString('utf8'),
      isBase64Encoded: false,
    };
  }
}

export async function createRuntime({ sdkModule } = {}) {
  // Keep the SDK import lazy so the normal Docker gateway and its unit tests
  // do not need CloudBase credentials or the CloudBase dependency installed.
  const loadedSdk = sdkModule || await import('@cloudbase/node-sdk');
  const tcb = loadedSdk.default || loadedSdk;
  const app = tcb.init(process.env.TCB_ENV ? { env: process.env.TCB_ENV } : {});
  const config = readGatewayConfig();
  const store = new CloudBaseGatewayStore({
    db: app.database(),
    pepper: config.tokenPepper,
    collection: process.env.GATEWAY_CLOUDBASE_COLLECTION || DEFAULT_COLLECTION,
    documentId: process.env.GATEWAY_CLOUDBASE_DOCUMENT_ID || DEFAULT_DOCUMENT_ID,
  });
  return createGatewayHandler({ config, store });
}

async function runtime() {
  runtimePromise ||= createRuntime();
  return runtimePromise;
}

export async function main_handler(rawEvent) {
  try {
    const event = eventObject(rawEvent);
    const { handler } = await runtime();
    const response = new FunctionResponse();
    await handler(requestFromEvent(event), response);
    if (!response.ended) response.end();
    return response.result();
  } catch (error) {
    // Do not expose SDK errors or environment values through the public
    // function response. CloudBase logs retain the detailed stack for the
    // operator while callers receive a stable failure shape.
    return {
      statusCode: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
      body: JSON.stringify({
        error: { code: 'gateway_unavailable', message: '服务暂时不可用，请稍后重试。' },
      }),
      isBase64Encoded: false,
    };
  }
}

// Tencent Cloud Functions accepts either exported handler name depending on
// whether the function was created through the SCF or CloudBase console.
export const main = main_handler;

export { FunctionResponse, requestFromEvent };

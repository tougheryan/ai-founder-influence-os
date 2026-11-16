import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  httpGet: vi.fn(),
  httpsGet: vi.fn(),
  projectDir: `/tmp/aifios-benchmark-cover-route-${process.pid}`,
}));

vi.mock('node:dns/promises', () => ({ lookup: mocks.dnsLookup }));
vi.mock('node:http', () => ({ get: mocks.httpGet }));
vi.mock('node:https', () => ({ get: mocks.httpsGet }));
vi.mock('@/lib/project-root', () => ({
  PROJECT_DIR: mocks.projectDir,
  safeResolve: (base: string, target: string) => {
    const resolved = resolve(base, target);
    return resolved === resolve(base) || resolved.startsWith(`${resolve(base)}${sep}`) ? resolved : null;
  },
}));

import { GET } from './route';

type FakeRemoteResponse = EventEmitter & {
  statusCode: number;
  headers: Record<string, string | undefined>;
  resume: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function remoteResponse(statusCode: number, headers: Record<string, string | undefined>): FakeRemoteResponse {
  const response = new EventEmitter() as FakeRemoteResponse;
  response.statusCode = statusCode;
  response.headers = headers;
  response.resume = vi.fn();
  response.destroy = vi.fn();
  return response;
}

function remoteRequest() {
  const request = new EventEmitter() as EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  request.setTimeout = vi.fn();
  request.destroy = vi.fn();
  return request;
}

function requestFor(url: string): NextRequest {
  return new NextRequest(`http://localhost/api/benchmark-advisor/media?${new URLSearchParams({ url }).toString()}`);
}

function requestForPath(path: string): NextRequest {
  return new NextRequest(`http://localhost/api/benchmark-advisor/media?${new URLSearchParams({ path }).toString()}`);
}

function cachedCoverPath(extension = '.png', digest = 'a'.repeat(64)): string {
  return `materials/advisors/benchmark/client_alpha/media/20260804-010000-abcdef1234/benchmark_a1b2c3d4e5f6/${digest}${extension}`;
}

function singleVideoMediaPath(extension = '.jpg', digest = 'c'.repeat(64)): string {
  return `materials/advisors/benchmark/client_alpha/single-video/media/20260805-113000-abcdef1234/${digest}${extension}`;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);

function mockRemoteResponse(response: FakeRemoteResponse, chunks: Buffer[] = []): void {
  mocks.httpsGet.mockImplementation((_url: unknown, _options: unknown, callback: (value: FakeRemoteResponse) => void) => {
    const request = remoteRequest();
    queueMicrotask(() => {
      callback(response);
      for (const chunk of chunks) response.emit('data', chunk);
      response.emit('end');
    });
    return request;
  });
}

describe('/api/benchmark-advisor/media', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    await mkdir(mocks.projectDir, { recursive: true });
    mocks.dnsLookup.mockReset();
    mocks.httpGet.mockReset();
    mocks.httpsGet.mockReset();
    mocks.dnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('normalizes a trusted RedNote cover into a bounded private inline image response', async () => {
    const upstream = remoteResponse(200, {
      'content-type': 'image/webp; charset=binary',
      'content-disposition': 'attachment; filename=first-frame.webp',
      'content-length': '4',
    });
    mockRemoteResponse(upstream, [Buffer.from([1, 2, 3, 4])]);

    const response = await GET(requestFor('https://sns-i11.rednotecdn.com/cover/first-frame.webp?sign=fixture'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('cache-control')).toBe('private, max-age=900');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(mocks.dnsLookup).toHaveBeenCalledWith('sns-i11.rednotecdn.com', { all: true, verbatim: true });
    expect(mocks.httpsGet).toHaveBeenCalledTimes(1);
  });

  it('rejects localhost, IP-literal, and non-platform cover URLs before any network request', async () => {
    const requests = [
      'http://localhost/cover.jpg',
      'http://127.0.0.1/cover.jpg',
      'http://[::1]/cover.jpg',
      'https://example.com/cover.jpg',
    ];

    const responses = await Promise.all(requests.map((url) => GET(requestFor(url))));

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
    expect(mocks.httpGet).not.toHaveBeenCalled();
    expect(mocks.httpsGet).not.toHaveBeenCalled();
  });

  it('rejects a trusted hostname that resolves only to a private address', async () => {
    mocks.dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    const response = await GET(requestFor('https://sns-i11.rednotecdn.com/cover.webp'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: '这张封面图无法使用，请换一张公开可访问的图片。',
      code: 'benchmark_cover_not_allowed',
    });
    expect(mocks.httpsGet).not.toHaveBeenCalled();
  });

  it('does not follow upstream redirects', async () => {
    const upstream = remoteResponse(302, {
      location: 'https://example.com/private.jpg',
      'content-type': 'image/webp',
    });
    mockRemoteResponse(upstream);

    const response = await GET(requestFor('https://sns-i11.rednotecdn.com/cover.webp'));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: '这个图片地址无法直接读取，请换一个稳定的图片链接。',
      code: 'benchmark_cover_redirected',
    });
    expect(upstream.resume).toHaveBeenCalledTimes(1);
    expect(mocks.httpsGet).toHaveBeenCalledTimes(1);
  });

  it('rejects non-image responses and oversized cover declarations', async () => {
    const textResponse = remoteResponse(200, { 'content-type': 'text/html' });
    mockRemoteResponse(textResponse, [Buffer.from('<html>not an image</html>')]);
    const text = await GET(requestFor('https://sns-i11.rednotecdn.com/cover.webp'));

    expect(text.status).toBe(415);
    expect(textResponse.resume).toHaveBeenCalledTimes(1);

    mocks.httpsGet.mockReset();
    const tooLargeResponse = remoteResponse(200, {
      'content-type': 'image/webp',
      'content-length': String(8 * 1024 * 1024 + 1),
    });
    mockRemoteResponse(tooLargeResponse);
    const tooLarge = await GET(requestFor('https://sns-i11.rednotecdn.com/cover.webp'));

    expect(tooLarge.status).toBe(413);
    expect(tooLargeResponse.resume).toHaveBeenCalledTimes(1);
  });

  it('serves a collector-archived local cover inline without a remote fetch', async () => {
    const path = cachedCoverPath();
    const absolute = join(mocks.projectDir, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, PNG_BYTES);

    const response = await GET(requestForPath(path));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('cache-control')).toBe('private, max-age=900');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
    expect(mocks.httpGet).not.toHaveBeenCalled();
    expect(mocks.httpsGet).not.toHaveBeenCalled();
  });

  it('serves a collector-archived single-video first frame inline without treating it as an account cover', async () => {
    const path = singleVideoMediaPath();
    const absolute = join(mocks.projectDir, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, JPEG_BYTES);

    const response = await GET(requestForPath(path));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG_BYTES);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
    expect(mocks.httpGet).not.toHaveBeenCalled();
    expect(mocks.httpsGet).not.toHaveBeenCalled();
  });

  it('serves an archived single-video platform cover with a non-JPEG extension', async () => {
    const path = singleVideoMediaPath('.png', 'd'.repeat(64));
    const absolute = join(mocks.projectDir, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, PNG_BYTES);

    const response = await GET(requestForPath(path));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
    expect(mocks.httpGet).not.toHaveBeenCalled();
    expect(mocks.httpsGet).not.toHaveBeenCalled();
  });

  it('rejects traversal, non-media benchmark paths, unsupported extensions, and mixed sources', async () => {
    const traversal = await GET(requestForPath('materials/advisors/benchmark/client_alpha/media/snapshot/benchmark_a1b2c3d4e5f6/../../secret.png'));
    const outsideMedia = await GET(requestForPath('materials/advisors/benchmark/client_alpha/normalized/20260804-010000-abcdef1234.json'));
    const svg = await GET(requestForPath(cachedCoverPath('.svg')));
    const mixed = await GET(new NextRequest(`http://localhost/api/benchmark-advisor/media?${new URLSearchParams({
      path: cachedCoverPath(),
      url: 'https://sns-i11.rednotecdn.com/cover.webp',
    }).toString()}`));

    expect([traversal.status, outsideMedia.status, svg.status, mixed.status]).toEqual([400, 400, 400, 400]);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
  });

  it('does not serve a missing or type-spoofed local image', async () => {
    const missing = await GET(requestForPath(cachedCoverPath()));
    const spoofedPath = cachedCoverPath('.webp', 'b'.repeat(64));
    const spoofedAbsolute = join(mocks.projectDir, spoofedPath);
    await mkdir(dirname(spoofedAbsolute), { recursive: true });
    await writeFile(spoofedAbsolute, Buffer.from('<html>not an image</html>'));
    const spoofed = await GET(requestForPath(spoofedPath));

    expect(missing.status).toBe(404);
    expect(spoofed.status).toBe(415);
  });
});

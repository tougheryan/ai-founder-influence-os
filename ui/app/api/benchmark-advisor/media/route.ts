import { lookup as dnsLookup } from 'node:dns/promises';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { assertTextInput, InputLimitError, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { PROJECT_DIR, safeResolve } from '@/lib/project-root';
import { KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_COVER_BYTES = 8 * 1024 * 1024;
const COVER_TIMEOUT_MS = 12_000;
const PRIVATE_CACHE_CONTROL = 'private, max-age=900';
const BENCHMARK_MEDIA_ROOT = 'materials/advisors/benchmark';
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SNAPSHOT_ID_RE = /^[A-Za-z0-9_-]{12,128}$/;
const ACCOUNT_ID_RE = /^benchmark_[a-f0-9]{12,32}$/;
const SHA256_IMAGE_NAME_RE = /^[a-f0-9]{64}$/i;
const LOCAL_COVER_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

// These are platform-owned public image/CDN suffixes. Keeping this allowlist
// narrow makes the endpoint a cover normalizer, not a general web proxy.
const ALLOWED_COVER_HOST_SUFFIXES = [
  'xiaohongshu.com',
  'xhscdn.com',
  'xhscdn.net',
  'rednotecdn.com',
  'douyin.com',
  'douyinvod.com',
  'byteimg.com',
  'bytegoofy.com',
  'qq.com',
  'qpic.cn',
  'weixin.qq.com',
  'wx.qq.com',
] as const;

type PinnedAddress = { address: string; family: number };
type RuntimeLookupCallback = (
  error: Error | null,
  address?: string | PinnedAddress[],
  family?: number,
) => void;

type CoverPayload = {
  bytes: Uint8Array;
  contentType: string;
};

class CoverProxyInputError extends Error {}

class CoverProxyFetchError extends Error {
  constructor(message: string, readonly status: number = 502) {
    super(message);
  }
}

function normalizedHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value || '').trim();
}

function publicHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isAllowedCoverHost(hostname: string): boolean {
  return ALLOWED_COVER_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (!family) throw new CoverProxyInputError('封面地址无法安全解析。');
  if (family === 4) {
    const [first, second] = address.split('.').map(Number);
    const privateOrReserved = first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
    if (privateOrReserved) throw new CoverProxyInputError('封面地址不能访问本机或私有网络。');
    return;
  }

  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const decimalMappedIpv4 = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (decimalMappedIpv4) return assertPublicAddress(decimalMappedIpv4);
  const hextets = normalized.split(':');
  const marker = hextets.lastIndexOf('ffff');
  if (marker >= 0 && hextets.length - marker === 3) {
    const [high, low] = hextets.slice(-2);
    if (/^[0-9a-f]{1,4}$/.test(high) && /^[0-9a-f]{1,4}$/.test(low)) {
      const highNumber = Number.parseInt(high, 16);
      const lowNumber = Number.parseInt(low, 16);
      return assertPublicAddress([
        highNumber >> 8,
        highNumber & 0xff,
        lowNumber >> 8,
        lowNumber & 0xff,
      ].join('.'));
    }
  }
  if (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('::')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89abcdef]/.test(normalized)
    || normalized.startsWith('ff')
  ) {
    throw new CoverProxyInputError('封面地址不能访问本机或私有网络。');
  }
}

function assertCoverUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoverProxyInputError('封面地址格式不正确。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CoverProxyInputError('封面地址仅支持 HTTP 或 HTTPS。');
  }
  if (url.username || url.password) {
    throw new CoverProxyInputError('封面地址不能包含账号信息。');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new CoverProxyInputError('封面地址只能使用标准 Web 端口。');
  }
  const hostname = publicHost(url.hostname);
  if (!hostname || isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new CoverProxyInputError('封面地址不能访问本机、IP 或私有网络。');
  }
  if (!isAllowedCoverHost(hostname)) {
    throw new CoverProxyInputError('封面地址不属于已允许的平台图片域名。');
  }
  return url;
}

async function resolvePinnedPublicAddress(hostname: string): Promise<PinnedAddress> {
  let candidates: Array<{ address: string; family: number }>;
  try {
    candidates = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new CoverProxyFetchError('封面地址暂时无法解析。');
  }
  for (const candidate of candidates) {
    try {
      assertPublicAddress(candidate.address);
      return candidate;
    } catch (error) {
      if (!(error instanceof CoverProxyInputError)) throw error;
    }
  }
  throw new CoverProxyInputError('封面地址不能解析到本机或私有网络。');
}

function returnPinnedLookupAddress(
  options: { all?: boolean },
  callback: RuntimeLookupCallback,
  result: PinnedAddress,
): void {
  if (options.all) {
    callback(null, [result]);
    return;
  }
  callback(null, result.address, result.family);
}

function imageContentType(value: string | string[] | undefined): string {
  const mediaType = normalizedHeader(value).split(';', 1)[0]?.trim().toLowerCase() || '';
  // Covers are raster images. SVG can execute active content when opened as a
  // top-level document, so it is deliberately outside this proxy's contract.
  if (!mediaType.startsWith('image/') || mediaType === 'image/svg+xml') return '';
  return mediaType;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function parseCachedCoverPath(value: string): { relativePath: string; contentType: string } {
  const relativePath = assertTextInput(value, '本地封面路径', MAX_SHORT_TEXT_BYTES).trim();
  if (!relativePath || relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.includes('\x00')) {
    throw new CoverProxyInputError('本地封面路径格式不正确。');
  }
  const segments = relativePath.split('/');
  if (segments.length !== 8 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new CoverProxyInputError('本地封面路径格式不正确。');
  }
  const [materials, advisors, benchmark, projectId, segment4, segment5, segment6, fileName] = segments;
  if (materials !== 'materials' || advisors !== 'advisors' || benchmark !== 'benchmark' || !PROJECT_ID_RE.test(projectId)) {
    throw new CoverProxyInputError('本地封面路径不属于当前对标研究媒体库。');
  }
  const extension = extname(fileName).toLowerCase();
  const contentType = LOCAL_COVER_CONTENT_TYPES[extension];
  const digest = fileName.slice(0, -extension.length);
  if (!contentType || !SHA256_IMAGE_NAME_RE.test(digest)) {
    throw new CoverProxyInputError('本地封面文件类型或名称不受支持。');
  }
  const isAccountCover = segment4 === 'media' && SNAPSHOT_ID_RE.test(segment5) && ACCOUNT_ID_RE.test(segment6);
  // Single-video research can retain a platform-authored cover as well as an
  // extracted JPEG first frame. Both are immutable, locally validated image
  // files; restricting this branch to JPEG would make valid WebP/PNG covers
  // disappear after a successful archive.
  const isSingleVideoImage = segment4 === 'single-video' && segment5 === 'media' && SNAPSHOT_ID_RE.test(segment6);
  if (!isAccountCover && !isSingleVideoImage) {
    throw new CoverProxyInputError('本地封面路径不属于当前对标研究媒体库。');
  }
  return { relativePath, contentType };
}

function localCoverBytesMatchContentType(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === 'image/webp') return bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).equals(Buffer.from('RIFF')) && Buffer.from(bytes.subarray(8, 12)).equals(Buffer.from('WEBP'));
  if (contentType === 'image/gif') return bytes.length >= 6 && (Buffer.from(bytes.subarray(0, 6)).equals(Buffer.from('GIF87a')) || Buffer.from(bytes.subarray(0, 6)).equals(Buffer.from('GIF89a')));
  if (contentType === 'image/avif') {
    const prefix = Buffer.from(bytes.subarray(0, 32));
    return bytes.length >= 16 && prefix.subarray(4, 8).equals(Buffer.from('ftyp')) && (prefix.includes(Buffer.from('avif')) || prefix.includes(Buffer.from('avis')));
  }
  return false;
}

async function readCachedCover(value: string): Promise<CoverPayload> {
  const { relativePath, contentType } = parseCachedCoverPath(value);
  const rootPath = safeResolve(PROJECT_DIR, BENCHMARK_MEDIA_ROOT);
  const resolvedPath = safeResolve(PROJECT_DIR, relativePath);
  if (!rootPath || !resolvedPath || !isContainedPath(rootPath, resolvedPath)) {
    throw new CoverProxyInputError('本地封面路径不属于当前对标研究媒体库。');
  }
  let stats;
  let physicalRoot: string;
  let physicalPath: string;
  try {
    [stats, physicalRoot, physicalPath] = await Promise.all([lstat(resolvedPath), realpath(rootPath), realpath(resolvedPath)]);
  } catch {
    throw new CoverProxyFetchError('本地封面文件不存在。', 404);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || !isContainedPath(physicalRoot, physicalPath)) {
    throw new CoverProxyInputError('本地封面文件不安全。');
  }
  if (stats.size > MAX_COVER_BYTES) {
    throw new CoverProxyFetchError('本地封面图片过大，无法加载。', 413);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(physicalPath);
  } catch {
    throw new CoverProxyFetchError('本地封面文件无法读取。', 404);
  }
  if (bytes.byteLength > MAX_COVER_BYTES) {
    throw new CoverProxyFetchError('本地封面图片过大，无法加载。', 413);
  }
  if (!localCoverBytesMatchContentType(bytes, contentType)) {
    throw new CoverProxyFetchError('本地封面图片内容校验失败。', 415);
  }
  return { bytes, contentType };
}

async function fetchCover(url: URL): Promise<CoverPayload> {
  const pinnedAddress = await resolvePinnedPublicAddress(publicHost(url.hostname));
  const getter = url.protocol === 'https:' ? httpsGet : httpGet;
  return new Promise<CoverPayload>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const request = getter(url, {
      headers: {
        accept: 'image/avif,image/webp,image/apng,image/*;q=0.8,*/*;q=0.1',
        'accept-encoding': 'identity',
        'user-agent': 'EchoFounder benchmark cover proxy/1.0',
      },
      lookup: (_hostname, options, callback) => {
        returnPinnedLookupAddress(options, callback as unknown as RuntimeLookupCallback, pinnedAddress);
      },
    }, (response) => {
      const statusCode = response.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400) {
        response.resume();
        settle(() => reject(new CoverProxyFetchError('封面地址发生跳转，已拒绝加载。')));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        settle(() => reject(new CoverProxyFetchError(`封面图片暂时无法访问（${statusCode || '未知状态'}）。`)));
        return;
      }
      const contentType = imageContentType(response.headers['content-type']);
      if (!contentType) {
        response.resume();
        settle(() => reject(new CoverProxyFetchError('封面响应不是可安全显示的图片。', 415)));
        return;
      }
      const contentLength = Number(normalizedHeader(response.headers['content-length']));
      if (Number.isFinite(contentLength) && contentLength > MAX_COVER_BYTES) {
        response.resume();
        settle(() => reject(new CoverProxyFetchError('封面图片过大，无法加载。', 413)));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_COVER_BYTES) {
          response.destroy();
          settle(() => reject(new CoverProxyFetchError('封面图片过大，无法加载。', 413)));
          return;
        }
        chunks.push(bytes);
      });
      response.once('error', () => settle(() => reject(new CoverProxyFetchError('封面图片读取失败。'))));
      response.once('aborted', () => settle(() => reject(new CoverProxyFetchError('封面图片读取被中断。'))));
      response.once('end', () => settle(() => resolve({
        bytes: Buffer.concat(chunks),
        contentType,
      })));
    });
    request.once('error', () => settle(() => reject(new CoverProxyFetchError('封面图片暂时无法加载。'))));
    request.setTimeout(COVER_TIMEOUT_MS, () => {
      request.destroy();
      settle(() => reject(new CoverProxyFetchError('封面图片加载超时。')));
    });
  });
}

function inlineCoverResponse(cover: CoverPayload): NextResponse {
  const body = new Uint8Array(cover.bytes.byteLength);
  body.set(cover.bytes);
  return new NextResponse(body.buffer, {
    headers: {
      'Cache-Control': PRIVATE_CACHE_CONTROL,
      'Content-Disposition': 'inline',
      'Content-Length': String(cover.bytes.byteLength),
      'Content-Security-Policy': 'sandbox',
      'Content-Type': cover.contentType,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Same-origin proxy for the publicly collected benchmark-cover URL only.
 * It intentionally removes upstream Content-Disposition: attachment while
 * retaining a narrow host allowlist, DNS-pinned public network lookup, and a
 * bounded image-only response.
 */
export async function GET(req: NextRequest) {
  try {
    const rawPath = req.nextUrl.searchParams.get('path');
    const rawUrl = req.nextUrl.searchParams.get('url');
    if (rawPath !== null && rawUrl !== null) {
      throw new CoverProxyInputError('一次只能读取一个本地封面路径或公开封面地址。');
    }
    const cover = rawPath !== null
      ? await readCachedCover(rawPath)
      : await fetchCover(assertCoverUrl(assertTextInput(rawUrl, '封面地址', MAX_SHORT_TEXT_BYTES).trim()));
    return inlineCoverResponse(cover);
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof CoverProxyInputError
      ? 400
      : error instanceof CoverProxyFetchError
        ? error.status
        : 502;
    const cause = error instanceof CoverProxyInputError
      ? new KnownUserFacingError({
        error: '这张封面图无法使用，请换一张公开可访问的图片。',
        code: 'benchmark_cover_not_allowed',
      }, { status: 400, detail: error })
      : error instanceof CoverProxyFetchError
        ? new KnownUserFacingError(
          error.status === 404
            ? { error: '这张封面图已经找不到，请换一张。', code: 'benchmark_cover_not_found' }
            : error.status === 413
              ? { error: '图片文件太大，请换一张较小的图片。', code: 'benchmark_cover_too_large' }
              : error.status === 415
                ? { error: '这不是可用的图片文件，请换一张。', code: 'benchmark_cover_invalid' }
                : error.message.includes('跳转')
                  ? { error: '这个图片地址无法直接读取，请换一个稳定的图片链接。', code: 'benchmark_cover_redirected' }
                  : { error: '封面图片暂时无法加载，请稍后重试。', code: 'benchmark_cover_load_failed' },
          { status: error.status, detail: error },
        )
        : error;
    return userFacingErrorResponse(cause, {
      error: '封面图片暂时无法加载，请稍后重试。',
      code: 'benchmark_cover_load_failed',
      status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

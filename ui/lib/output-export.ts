import { createHash } from 'node:crypto';
import type { OutputDisclosure } from './output-disclosure';
import { disclosureNotice, markExportText } from './output-disclosure-format';

// Bound the additional allocations needed to assemble an uncompressed archive.
export const MAX_OUTPUT_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_NOTICE_BYTES = 256 * 1024;
const MAX_ZIP_VALUE = 0xffffffff;
const UTF8_FLAG = 0x0800;
const MAX_NAME_BYTES = 255;

export class OutputDownloadError extends Error {
  readonly status = 413;

  constructor(message: string, readonly code: 'file_too_large' | 'notice_too_large' | 'archive_too_large') {
    super(message);
    this.name = 'OutputDownloadError';
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function splitName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  // An arbitrary very long dotted suffix is part of the title, not a format.
  if (dot <= 0 || Buffer.byteLength(name.slice(dot), 'utf8') > 32) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function fitName(stem: string, tail: string): string {
  const name = stem + tail;
  if (Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES) return name;
  const marker = `…-${createHash('sha256').update(name).digest('hex').slice(0, 10)}`;
  const budget = MAX_NAME_BYTES - Buffer.byteLength(marker + tail, 'utf8');
  let prefix = '';
  let size = 0;
  for (const character of stem) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (size + characterBytes > budget) break;
    prefix += character;
    size += characterBytes;
  }
  return prefix + marker + tail;
}

function downloadName(fileName: string): string {
  const basename = fileName.replace(/\\/g, '/').split('/').pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/[. ]+$/, '');
  if (!basename) return '导出文件';
  // Replace lone surrogate code units in names; file contents remain untouched.
  const name = Buffer.from(basename, 'utf8').toString('utf8');
  const { stem, extension } = splitName(name);
  return fitName(stem, extension);
}

function statusSuffix(disclosure: OutputDisclosure): string {
  if (disclosure.status === 'internal_only') return '（仅供内部预览）';
  if (disclosure.status === 'unverified') return '（公开限制待核对）';
  if (disclosure.status === 'restricted_details') return '（含局部公开限制）';
  return '';
}

/** The ZIP contains exactly the original bytes and their separate use notice. */
function storedZip(entries: { name: string; bytes: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let localSize = 0;
  let centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.bytes.length;
    if (name.length > 0xffff || size > MAX_ZIP_VALUE || localSize + 30 + name.length + size > MAX_ZIP_VALUE) {
      throw new OutputDownloadError('导出文件超出压缩包支持的大小。', 'archive_too_large');
    }
    const checksum = crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(0x21, 12); // DOS date: 1980-01-01; deterministic exports.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, entry.bytes);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(UTF8_FLAG, 8);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(size, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(localSize, 42);
    central.push(directory, name);
    centralSize += directory.length + name.length;
    localSize += header.length + name.length + size;
  }
  if (entries.length > 0xffff || localSize + centralSize + 22 > MAX_ZIP_VALUE) {
    throw new OutputDownloadError('导出文件超出压缩包支持的大小。', 'archive_too_large');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([...local, ...central, end], localSize + centralSize + end.length);
}

export function prepareOutputDownload(
  buffer: Buffer,
  fileName: string,
  contentType: string,
  disclosure: OutputDisclosure,
): { body: Buffer; fileName: string; contentType: string } {
  if (buffer.length > MAX_OUTPUT_DOWNLOAD_BYTES) {
    throw new OutputDownloadError('单个导出文件超过 256MB，请拆分后重试。', 'file_too_large');
  }
  const name = downloadName(fileName);
  const { stem, extension: originalExtension } = splitName(name);
  const extension = originalExtension.toLowerCase();
  const suffix = statusSuffix(disclosure);
  const notice = disclosureNotice(disclosure);
  if (Buffer.byteLength(notice, 'utf8') > MAX_NOTICE_BYTES) {
    throw new OutputDownloadError('公开限制说明过长，请整理后重试。', 'notice_too_large');
  }
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const textMime = mime.startsWith('text/') || mime === 'application/xhtml+xml';
  if (textMime && ['.md', '.markdown', '.txt', '.html', '.htm'].includes(extension)) {
    let text: string | undefined;
    try {
      // Keep a UTF-8 BOM and refuse replacement-character decoding of other encodings.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
      if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) text = undefined;
    } catch { /* Preserve undecodable bytes in the archive below. */ }
    if (text !== undefined) {
      const marked = markExportText(text, extension, disclosure);
      return {
        body: Buffer.from(marked, 'utf8'),
        fileName: fitName(stem, suffix + originalExtension),
        contentType,
      };
    }
  }
  const instructions = Buffer.from([
    'Echo Founder · 导出使用说明',
    '',
    notice || '未识别整期限制不等于公开授权。对外使用前，请核对素材来源、作者授权与不能公开的细节。',
    '',
    `原文件：${name}`,
    '压缩包中的原文件保留原始字节；公开限制说明未嵌入图片、PDF 或其他原文件。',
    '请将原文件和本说明一起保留；交付给他人前，核对接收者是否有权查看原文件和限制原文。',
    '',
  ].join('\n'), 'utf8');
  const instructionsName = name === '使用说明.txt' ? '导出使用说明.txt' : '使用说明.txt';
  return {
    body: storedZip([{ name, bytes: buffer }, { name: instructionsName, bytes: instructions }]),
    fileName: fitName(stem, originalExtension + suffix + '.zip'),
    contentType: 'application/zip',
  };
}

/** A bounded, flat archive; callers supply already verified source bytes. */
export function prepareOutputBundle(
  entries: { name: string; bytes: Buffer }[],
  fileName: string,
  disclosure: OutputDisclosure,
  instructions: string,
): { body: Buffer; fileName: string; contentType: string } {
  const notice = disclosureNotice(disclosure);
  const readme = Buffer.from([
    'Echo Founder · 整套下载使用说明', '',
    notice || '未识别整期限制不等于公开授权。对外使用前，请核对素材来源、作者授权与不能公开的细节。',
    '', instructions, '',
    '图片保留原始字节，使用限制未嵌入图片。请将本说明一起保留；交付前核对接收者是否有权查看文件和限制原文。', '',
  ].join('\n'));
  if (readme.length > MAX_NOTICE_BYTES) throw new OutputDownloadError('使用说明过长，请整理后重试。', 'notice_too_large');
  const members = [...entries.map((entry) => ({ ...entry, name: downloadName(entry.name) })), { name: '使用说明.txt', bytes: readme }];
  if (new Set(members.map((entry) => entry.name)).size !== members.length) throw new Error('下载文件名称重复。');
  const bytes = members.reduce((sum, entry) => sum + entry.bytes.length + 76 + 2 * Buffer.byteLength(entry.name), 22);
  if (bytes > MAX_OUTPUT_DOWNLOAD_BYTES) throw new OutputDownloadError('整套文件超过 256MB，请分别下载。', 'archive_too_large');
  return { body: storedZip(members), fileName: fitName(splitName(downloadName(fileName)).stem, statusSuffix(disclosure) + '.zip'), contentType: 'application/zip' };
}

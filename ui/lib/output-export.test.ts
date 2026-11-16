import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { OutputDisclosure } from './output-disclosure';
import { MAX_OUTPUT_DOWNLOAD_BYTES, OutputDownloadError, prepareOutputDownload } from './output-export';

const internal: OutputDisclosure = { status: 'internal_only', restrictions: ['仅供内部验收，不对外发布。'] };

/** Exercise a separate implementation's CRC checks and filesystem extraction. */
function extractWithPython(zip: Buffer): { name: string; content: string; flags: number; compression: number }[] {
  return JSON.parse(execFileSync('python3', ['-c', `
import base64, io, json, pathlib, sys, tempfile, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    with tempfile.TemporaryDirectory(prefix="echo-output-export-test-") as directory:
        archive.extractall(directory)
        print(json.dumps([
            {"name": entry.filename,
             "content": base64.b64encode((pathlib.Path(directory) / entry.filename).read_bytes()).decode("ascii"),
             "flags": entry.flag_bits,
             "compression": entry.compress_type}
            for entry in archive.infolist()
        ]))
`], { input: zip, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
}

describe('output downloads with use restrictions', () => {
  it.each(['md', 'markdown', 'txt', 'html', 'htm'])('marks only the downloaded %s copy and retains its content type', (extension) => {
    const original = Buffer.from(extension.startsWith('ht') ? '<p>模拟正文。</p>' : '# 模拟正文\n最后一行。\n');
    const saved = Buffer.from(original);
    const result = prepareOutputDownload(original, `模拟文稿.${extension}`, 'text/plain; charset=utf-8', internal);
    expect(result.body.toString('utf8')).toContain('仅供内部预览');
    expect(result.body.toString('utf8')).toContain(saved.toString('utf8'));
    expect(result.fileName).toBe(`模拟文稿（仅供内部预览）.${extension}`);
    expect(result.contentType).toBe('text/plain; charset=utf-8');
    expect(original.equals(saved)).toBe(true);
  });

  it.each(['png', 'pdf', 'json', 'zip'])('round-trips all original %s bytes and a Chinese filename through Python zipfile', (extension) => {
    const original = Buffer.concat([Buffer.from([0, 255, 128, 13, 10, 1, 2, 3]), Buffer.from('模拟夹具，不是真实客户文件。')]);
    const before = Buffer.from(original);
    const result = prepareOutputDownload(original, `模拟图文·第一期.${extension}`, 'application/octet-stream', internal);
    expect(result.contentType).toBe('application/zip');
    expect(result.fileName).toBe(`模拟图文·第一期.${extension}（仅供内部预览）.zip`);
    const extracted = extractWithPython(result.body);
    expect(extracted.map((entry) => entry.name)).toEqual([`模拟图文·第一期.${extension}`, '使用说明.txt']);
    expect(Buffer.from(extracted[0].content, 'base64').equals(before)).toBe(true);
    expect(extracted.every((entry) => (entry.flags & 0x800) && entry.compression === 0)).toBe(true);
    const instructions = Buffer.from(extracted[1].content, 'base64').toString('utf8');
    expect(instructions).toContain('仅供内部预览');
    expect(instructions).toContain(internal.restrictions[0]);
    expect(instructions).toContain('未嵌入图片、PDF 或其他原文件');
    expect(original.equals(before)).toBe(true);
  });

  it.each([
    ['restricted_details', '不要公开客户姓名。', '含局部公开限制'],
    ['unverified', '', '公开限制待核对'],
    ['no_whole_draft_limit', '', '未识别整期限制不等于公开授权'],
  ] as const)('includes accurate %s instructions even when binary bytes cannot be marked', (status, restriction, notice) => {
    const disclosure: OutputDisclosure = { status, restrictions: restriction ? [restriction] : [] };
    const result = prepareOutputDownload(Buffer.from([0, 1, 2]), '模拟.pdf', 'application/pdf', disclosure);
    const extracted = extractWithPython(result.body);
    const instructions = Buffer.from(extracted[1].content, 'base64').toString('utf8');
    expect(instructions).toContain(notice);
    if (status === 'no_whole_draft_limit') expect(result.fileName).toBe('模拟.pdf.zip');
    if (restriction) expect(instructions).toContain(restriction);
  });

  it('keeps unrestricted UTF-8 text byte-for-byte, including its BOM and line endings', () => {
    const original = Buffer.from('\ufeff模拟正文\r\n结束。\r\n');
    const result = prepareOutputDownload(original, '原始.TXT', 'text/plain', { status: 'no_whole_draft_limit', restrictions: [] });
    expect(result.body.equals(original)).toBe(true);
    expect(result.fileName).toBe('原始.TXT');
  });

  it('archives undecodable text without corrupting its bytes or colliding with the readme name', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00]);
    const result = prepareOutputDownload(bytes, '使用说明.txt', 'text/plain', internal);
    const extracted = extractWithPython(result.body);
    expect(extracted.map((entry) => entry.name)).toEqual(['使用说明.txt', '导出使用说明.txt']);
    expect(Buffer.from(extracted[0].content, 'base64').equals(bytes)).toBe(true);
  });

  it('removes path traversal from ZIP member names before extraction', () => {
    const result = prepareOutputDownload(Buffer.from([42]), '../../模拟\\图片.png', 'image/png', internal);
    const extracted = extractWithPython(result.body);
    expect(extracted[0].name).toBe('图片.png');
    expect(Buffer.from(extracted[0].content, 'base64')).toEqual(Buffer.from([42]));
  });

  it.each(['internal_only', 'restricted_details', 'unverified', 'no_whole_draft_limit'] as const)(
    'keeps the marked %s text filename within 255 UTF-8 bytes without cutting a character', (status) => {
      const disclosure: OutputDisclosure = { status, restrictions: internal.restrictions };
      const filename = `${'模拟🎨'.repeat(23)}.MARKDOWN`;
      const original = Buffer.from('模拟正文\r\n最后一句。\r\n');
      const result = prepareOutputDownload(original, filename, 'text/markdown', disclosure);
      expect(Buffer.byteLength(result.fileName, 'utf8')).toBeLessThanOrEqual(255);
      expect(result.fileName).toMatch(/^模拟🎨/);
      expect(result.fileName).toMatch(/\.MARKDOWN$/);
      expect(result.fileName).not.toContain('\ufffd');
      expect(prepareOutputDownload(original, filename, 'text/markdown', disclosure).fileName).toBe(result.fileName);
      expect(result.body.toString('utf8')).toContain(original.toString('utf8'));
      if (status === 'internal_only') expect(result.fileName).toContain('（仅供内部预览）');
      if (status === 'unverified') expect(result.fileName).toContain('（公开限制待核对）');
      if (status === 'restricted_details') expect(result.fileName).toContain('（含局部公开限制）');
      if (status === 'no_whole_draft_limit') expect(result.body.equals(original)).toBe(true);
    },
  );

  it('retains a legal near-limit original ZIP member name while shortening the marked archive name', () => {
    const name = `${'稿'.repeat(83)}.png`;
    expect(Buffer.byteLength(name, 'utf8')).toBe(253);
    const bytes = Buffer.from([0, 255, 13, 10]);
    const result = prepareOutputDownload(bytes, name, 'image/png', internal);
    expect(Buffer.byteLength(result.fileName, 'utf8')).toBeLessThanOrEqual(255);
    expect(result.fileName).toMatch(/\.png（仅供内部预览）\.zip$/);
    const extracted = extractWithPython(result.body);
    expect(extracted[0].name).toBe(name);
    expect(Buffer.from(extracted[0].content, 'base64')).toEqual(bytes);
  });

  it('shortens oversized member names deterministically with distinct suffix hashes and intact extensions', () => {
    const prefix = '模拟长标题🎨'.repeat(25);
    const first = prepareOutputDownload(Buffer.from([0]), `${prefix}甲.PDF`, 'application/pdf', internal);
    const second = prepareOutputDownload(Buffer.from([0]), `${prefix}乙.PDF`, 'application/pdf', internal);
    const firstMember = extractWithPython(first.body)[0];
    const secondMember = extractWithPython(second.body)[0];
    expect(Buffer.byteLength(first.fileName, 'utf8')).toBeLessThanOrEqual(255);
    expect(Buffer.byteLength(firstMember.name, 'utf8')).toBeLessThanOrEqual(255);
    expect(firstMember.name).toMatch(/\.PDF$/);
    expect(firstMember.name).not.toContain('\ufffd');
    expect(firstMember.name).not.toBe(secondMember.name);
    expect(first.fileName).not.toBe(second.fileName);
    expect(prepareOutputDownload(Buffer.from([0]), `${prefix}甲.PDF`, 'application/pdf', internal).body.equals(first.body)).toBe(true);
  });

  it.each([
    [Buffer.from([65, 0, 66]), 'text/plain'],
    [Buffer.from([65, 7, 66]), 'text/plain'],
    [Buffer.from('%PDF-1.7\n模拟非文本文件'), 'application/pdf'],
  ])('never inserts a text notice into binary bytes disguised with a txt suffix', (bytes, mime) => {
    const saved = Buffer.from(bytes);
    const result = prepareOutputDownload(bytes, '模拟.txt', mime, internal);
    expect(result.contentType).toBe('application/zip');
    const extracted = extractWithPython(result.body);
    expect(Buffer.from(extracted[0].content, 'base64')).toEqual(saved);
    expect(bytes).toEqual(saved);
  });

  it('states that detailed restrictions are for recipients allowed to see the source', () => {
    const result = prepareOutputDownload(Buffer.from([0]), '模拟.png', 'image/png', {
      status: 'restricted_details', restrictions: ['模拟客户名称不得公开：甲公司。'],
    });
    const instructions = Buffer.from(extractWithPython(result.body)[1].content, 'base64').toString('utf8');
    expect(instructions).toContain('仅供作者及有权查看原素材的人核对');
    expect(instructions).toContain('本说明不会自动隐去这些细节');
    expect(instructions).toContain('核对接收者是否有权查看原文件和限制原文');
    expect(instructions).toContain('模拟客户名称不得公开：甲公司。');
  });

  it('reports oversized source data as a recoverable download error before inspecting bytes', () => {
    const oversized = Buffer.allocUnsafe(MAX_OUTPUT_DOWNLOAD_BYTES + 1);
    expect(() => prepareOutputDownload(oversized, '模拟.png', 'image/png', internal)).toThrow(OutputDownloadError);
    try {
      prepareOutputDownload(oversized, '模拟.png', 'image/png', internal);
      expect.fail('An oversized source must not be exported');
    } catch (error) {
      expect(error).toMatchObject({ name: 'OutputDownloadError', code: 'file_too_large', status: 413 });
    }
  });

  it('reports oversized disclosure metadata without constructing an archive', () => {
    const oversized = { ...internal, restrictions: ['限'.repeat(90_000)] };
    expect(() => prepareOutputDownload(Buffer.from([0]), '模拟.png', 'image/png', oversized)).toThrow('说明过长');
    try {
      prepareOutputDownload(Buffer.from([0]), '模拟.png', 'image/png', oversized);
      expect.fail('An oversized notice must not be exported');
    } catch (error) {
      expect(error).toMatchObject({ name: 'OutputDownloadError', code: 'notice_too_large', status: 413 });
    }
  });
});

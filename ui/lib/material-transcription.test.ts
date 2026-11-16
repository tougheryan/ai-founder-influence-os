import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractPdfMaterialText, isPdfMaterial } from './material-transcription';

const temporaryRoots: string[] = [];
const originalBinary = process.env.AIFIOS_MATERIAL_OCR_BINARY;

afterEach(async () => {
  if (originalBinary === undefined) delete process.env.AIFIOS_MATERIAL_OCR_BINARY;
  else process.env.AIFIOS_MATERIAL_OCR_BINARY = originalBinary;
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function installOcrFixture(output: string, exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), 'aifios-material-ocr-test-'));
  temporaryRoots.push(root);
  const binary = join(root, 'aifios-material-ocr');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' '${output.replace(/'/g, "'\\\"'\\\"'")}'`,
    `exit ${exitCode}`,
    '',
  ].join('\n');
  await writeFile(binary, script, 'utf8');
  await chmod(binary, 0o755);
  process.env.AIFIOS_MATERIAL_OCR_BINARY = binary;
}

describe('PDF material extraction', () => {
  it('recognizes PDF paths', () => {
    expect(isPdfMaterial('materials/intake/example.PDF')).toBe(true);
    expect(isPdfMaterial('materials/intake/example.docx')).toBe(false);
  });

  it('accepts a successful bundled OCR response as readable text', async () => {
    await installOcrFixture(JSON.stringify({
      ok: true,
      engine: 'macos-vision-ocr',
      pageCount: 2,
      processedPages: 2,
      text: '第 1 页\n扫描件中可用的中文正文与事实。',
      warnings: ['部分页面可能没有完整识别，请回看原文件确认。'],
    }));

    const result = await extractPdfMaterialText('/tmp/scanned.pdf');

    expect(result).toMatchObject({
      status: 'text_extracted',
      provider: 'macos-vision-ocr',
      pageCount: 2,
      processedPages: 2,
      text: '第 1 页\n扫描件中可用的中文正文与事实。',
      warnings: ['部分页面可能没有完整识别，请回看原文件确认。'],
    });
  });

  it('keeps a failed OCR response unreadable instead of inventing PDF content', async () => {
    await installOcrFixture('not-json');

    const result = await extractPdfMaterialText('/tmp/scanned.pdf');

    expect(result.status).toBe('needs_transcription');
    expect(result.text).toBe('');
    expect(result).toMatchObject({
      error: '这份 PDF 没有解析成功，其他素材不受影响。请换一个文件重试。',
      code: 'material_pdf_extraction_failed',
    });
    expect(result.debugId).toMatch(/^material_[a-f0-9]{16}$/);
  });

  it('does not project OCR warnings, stderr-like text, paths or credentials', async () => {
    await installOcrFixture(JSON.stringify({
      ok: true,
      engine: 'macos-vision-ocr',
      text: '这是一段足够长的可用正文。',
      warnings: ['failed at /Users/customer/private.pdf api_key=sk-super-secret-token-value'],
    }));

    const result = await extractPdfMaterialText('/tmp/scanned.pdf');
    const serialized = JSON.stringify(result);
    expect(result.warnings).toEqual(['部分页面可能没有完整识别，请回看原文件确认。']);
    expect(serialized).not.toContain('/Users/customer');
    expect(serialized).not.toContain('sk-super-secret');
  });
});

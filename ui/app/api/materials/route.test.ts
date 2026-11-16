import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-materials-route-${process.pid}`,
  pdfExtraction: null as null | {
    status: 'text_extracted' | 'needs_transcription';
    provider: 'pdfkit-text' | 'macos-vision-ocr' | 'missing';
    text: string;
    pageCount?: number;
    processedPages?: number;
    warnings: string[];
    error?: string;
  },
}));

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => {
    await mkdir(mocks.projectDir, { recursive: true });
  },
}));

vi.mock('@/lib/output-files', async () => {
  const fs = await import('node:fs/promises');
  const pathModule = await import('node:path');
  const safeResolve = (base: string, relativePath: string) => {
    const root = pathModule.resolve(base);
    const resolved = pathModule.resolve(root, relativePath);
    return resolved === root || resolved.startsWith(`${root}${pathModule.sep}`) ? resolved : null;
  };
  const fileAt = (relativePath: string) => {
    const resolved = safeResolve(mocks.projectDir, relativePath);
    if (!resolved) throw new Error('Invalid output path');
    return resolved;
  };

  return {
    BASE_DIR: mocks.projectDir,
    safeResolve,
    listMaterials: async () => [],
    listDirectory: async () => [],
    listPipelineFiles: async () => [],
    readOutputFile: async (relativePath: string) => fs.readFile(fileAt(relativePath), 'utf-8'),
    writeOutputFile: async (relativePath: string, content: string) => {
      const target = fileAt(relativePath);
      await fs.mkdir(pathModule.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
    },
    writeOutputBuffer: async (relativePath: string, content: Buffer) => {
      const target = fileAt(relativePath);
      await fs.mkdir(pathModule.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    },
  };
});

vi.mock('@/lib/material-transcription', () => ({
  isPdfMaterial: (path: string) => path.toLowerCase().endsWith('.pdf'),
  extractPdfMaterialText: async () => mocks.pdfExtraction || ({
    status: 'needs_transcription',
    provider: 'missing',
    text: '',
    warnings: [],
    error: 'PDF OCR unavailable in this test',
  }),
  isTranscribableMaterial: () => false,
  transcribeMaterialMedia: async () => ({
    status: 'needs_transcription',
    provider: 'missing',
    transcript: '',
    segments: [],
  }),
}));

import { GET, POST } from './route';

async function seed(relativePath: string, content: string | Buffer) {
  const target = path.join(mocks.projectDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function startIntake(pathname: string) {
  return POST(new NextRequest('http://localhost/api/materials?action=start-intake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: pathname }),
  }));
}

describe('/api/materials start-intake', () => {
  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
    await mkdir(mocks.projectDir, { recursive: true });
    mocks.pdfExtraction = null;
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('keeps a readable personal-library file as a provenance-bearing MaterialUpload', async () => {
    await seed('materials/library/imports/notes.txt', '客户反馈：先研究市场，再决定文章角度。');

    const response = await startIntake('materials/library/imports/notes.txt');

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      requestId: string;
      extractionStatus: string;
      materialFiles: Array<Record<string, unknown>>;
    };
    expect(payload.extractionStatus).toBe('text_extracted');
    expect(payload.materialFiles).toEqual([expect.objectContaining({
      name: 'notes.txt',
      sourcePath: 'materials/library/imports/notes.txt',
      extractionStatus: 'text_extracted',
      path: expect.stringMatching(/^materials\/extracted\//),
    })]);

    const storedResponse = await GET(new NextRequest(
      `http://localhost/api/materials?intakeRequest=${encodeURIComponent(payload.requestId)}`,
    ));
    expect(storedResponse.status).toBe(200);
    const stored = await storedResponse.json() as {
      rawMaterial: string;
      materialFiles: Array<Record<string, unknown>>;
    };
    expect(stored.rawMaterial).toContain('先研究市场');
    expect(stored.materialFiles[0]).toMatchObject({
      sourcePath: 'materials/library/imports/notes.txt',
      extractionStatus: 'text_extracted',
    });
  });

  it('turns a PDF OCR result into a readable provenance-bearing intake asset', async () => {
    mocks.pdfExtraction = {
      status: 'text_extracted',
      provider: 'macos-vision-ocr',
      text: '第 1 页\n这是从扫描 PDF 识别出的可用事实和案例。',
      pageCount: 2,
      processedPages: 2,
      warnings: [],
    };
    await seed('materials/library/imports/scanned-brief.pdf', Buffer.from('%PDF-scanned-binary'));

    const response = await startIntake('materials/library/imports/scanned-brief.pdf');

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      requestId: string;
      extractionStatus: string;
      extractedPath: string;
    };
    expect(payload.extractionStatus).toBe('text_extracted');
    expect(payload.extractedPath).toMatch(/^materials\/extracted\//);

    const storedResponse = await GET(new NextRequest(
      `http://localhost/api/materials?intakeRequest=${encodeURIComponent(payload.requestId)}`,
    ));
    const stored = await storedResponse.json() as { rawMaterial: string };
    expect(storedResponse.status).toBe(200);
    expect(stored.rawMaterial).toContain('macOS Vision');
    expect(stored.rawMaterial).toContain('扫描 PDF 识别出的可用事实');
  });

  it.each([
    ['PDF', 'opaque-brief.pdf', '%PDF-opaque-binary'],
    ['图片', 'opaque-cover.png', 'not-a-real-png'],
    ['Office 文件', 'opaque-deck.docx', 'not-a-real-docx'],
  ])('blocks an unreadable %s before it can become a rawMaterial intake request', async (_label, name, content) => {
    await seed(`materials/library/imports/${name}`, Buffer.from(content));

    const response = await startIntake(`materials/library/imports/${name}`);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: '这个附件还没有可用文字。请先补充文字稿或摘要。',
      code: 'material_text_required',
    });
    const requestsPath = path.join(mocks.projectDir, 'sessions/material-intake-requests');
    const requestFiles = await readdir(requestsPath).catch(() => [] as string[]);
    expect(requestFiles).toEqual([]);
  });

  it('recognizes needs_transcription from an existing extraction asset rather than its file name', async () => {
    await seed('materials/extracted/ordinary-name.md', [
      '---',
      'source_path: materials/library/imports/opaque-brief.pdf',
      'extraction_status: needs_transcription',
      '---',
      '',
      '# 素材解析资产',
      '当前文件需要 OCR。',
    ].join('\n'));

    const response = await startIntake('materials/extracted/ordinary-name.md');

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: '这个附件还没有可用文字。请先补充文字稿或摘要。',
      code: 'material_text_required',
    });
  });

  it('refuses legacy stored requests that marked an unreadable attachment as text input', async () => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    await seed(`sessions/material-intake-requests/${requestId}.json`, JSON.stringify({
      id: requestId,
      extractionStatus: 'needs_transcription',
      rawMaterial: '# 解析资产\n\n请补 OCR 后再使用。',
      materialFiles: [{
        name: 'opaque-brief.pdf',
        sourcePath: 'materials/library/imports/opaque-brief.pdf',
        path: 'materials/extracted/opaque-brief-extract.md',
        extractionStatus: 'needs_transcription',
      }],
    }));

    const response = await GET(new NextRequest(
      `http://localhost/api/materials?intakeRequest=${requestId}`,
    ));

    expect(response.status).toBe(422);
    const payload = await response.json() as { error?: string; rawMaterial?: string };
    expect(payload.error).toBe('这个附件还没有可用文字。请先补充文字稿或摘要。');
    expect(payload).toMatchObject({ code: 'material_text_required' });
    expect(payload.rawMaterial).toBeUndefined();
  });
});

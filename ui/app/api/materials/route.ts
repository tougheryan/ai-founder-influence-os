import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { access, readFile, stat } from 'fs/promises';
import { join, parse, relative } from 'path';
import { ensureProjectInitialized } from '@/lib/project-init';
import {
  BASE_DIR,
  listMaterials,
  listDirectory,
  listPipelineFiles,
  readOutputFile,
  safeResolve,
  writeOutputBuffer,
  writeOutputFile,
} from '@/lib/output-files';
import { assertOptionalTextInput, MAX_TEXT_ARTIFACT_BYTES } from '@/lib/input-limits';
import {
  extractPdfMaterialText,
  isPdfMaterial,
  isTranscribableMaterial,
  transcribeMaterialMedia,
  type MaterialPdfExtractionResult,
  type MaterialTranscriptionResult,
} from '@/lib/material-transcription';
import type { MaterialExtractionStatus, MaterialUpload } from '@/lib/material-analysis';
import {
  expectedUserFacingErrorResponse,
  KnownUserFacingError,
  userFacingErrorPayload,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';

const MAX_MATERIAL_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_BYTES = 256 * 1024;
const MATERIAL_EXTENSIONS = new Set([
  '.csv',
  '.doc',
  '.docx',
  '.aac',
  '.flac',
  '.heic',
  '.htm',
  '.html',
  '.jpeg',
  '.jpg',
  '.json',
  '.m4a',
  '.md',
  '.mp3',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.rtf',
  '.txt',
  '.wav',
  '.webp',
  '.xls',
  '.xlsx',
]);
const REMOVED_MEDIA_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);
const TEXT_PREVIEW_EXTENSIONS = new Set(['.csv', '.htm', '.html', '.json', '.md', '.rtf', '.txt']);
const MATERIAL_EXTRACTION_STATUSES = new Set<MaterialExtractionStatus>([
  'text_extracted',
  'audio_transcribed',
  'transcribing',
  'needs_transcription',
  'existing_extraction',
]);
const TRANSCRIPTION_JOB_DIR = 'materials/extracted/transcripts';
// In-process registry of background transcription runs, keyed by sourcePath.
// Survives a browser refresh (the server keeps running); the on-disk job file
// below lets a later poll or a restarted server recover the result.
const activeTranscriptions = new Map<string, Promise<void>>();

type TranscriptionJob = {
  status: 'running' | 'done' | 'failed';
  sourcePath: string;
  path?: string;
  extractionStatus?: MaterialExtractionStatus;
  content?: string;
  error?: string;
  code?: string;
  debugId?: string;
  updatedAt: string;
};

type MaterialExtractionResult = {
  ok: true;
  path: string;
  sourcePath: string;
  extractionStatus: MaterialExtractionStatus;
  previewable: true;
  content: string;
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const source = searchParams.get('source') || 'materials';
  const type = searchParams.get('type') || '';
  const stage = searchParams.get('stage') || '';
  const path = searchParams.get('path') || '';
  const download = searchParams.get('download') || '';
  const intakeRequest = searchParams.get('intakeRequest') || '';
  const transcriptionStatus = searchParams.get('transcriptionStatus') || '';

  try {
    await ensureProjectInitialized();
    if (intakeRequest) {
      return await materialIntakeRequestResponse(intakeRequest);
    }

    if (transcriptionStatus) {
      return NextResponse.json(await transcriptionStatusResponse(transcriptionStatus));
    }

    if (download) {
      return await materialDownloadResponse(download);
    }

    if (path) {
      assertMaterialPath(path);
      if (!isTextPreviewableMaterial(path)) {
        return NextResponse.json({
          path,
          previewable: false,
          downloadUrl: materialDownloadUrl(path),
          message: '该素材为附件类型，请下载后查看。',
        });
      }
      const content = await readOutputFile(path);
      return NextResponse.json({ content, path, previewable: true });
    }

    if (source === 'pipeline') {
      const items = await listPipelineFiles(stage || undefined);
      return NextResponse.json({ items });
    }

    const items = type ? await listDirectory(normalizeMaterialDirectory(type)) : await listMaterials();
    return NextResponse.json({ items });
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取失败';
    return userFacingErrorResponse(materialUserFacingCause(error, message), {
      error: '暂时无法读取素材，请重试。',
      code: 'materials_read_failed',
      status: materialErrorStatus(message),
    });
  }
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');

  try {
    await ensureProjectInitialized();
    if (action === 'create') {
      const body = (await req.json()) as {
        path?: string;
        name?: string;
        content?: string;
      };
      const directory = normalizeMaterialDirectory(body.path);
      const fileName = normalizeFileName(body.name, '未命名素材.md', true);
      const requestedContent = assertOptionalTextInput(body.content, '素材内容', MAX_TEXT_ARTIFACT_BYTES);
      const content = requestedContent?.trim()
        ? requestedContent
        : `# ${fileName.replace(/\.md$/i, '')}\n\n`;

      const relativePath = await nextAvailableMaterialPath(directory, fileName);
      assertMaterialPath(relativePath);
      await writeOutputFile(relativePath, content);

      return NextResponse.json({ ok: true, path: relativePath });
    }

    if (action === 'upload') {
      const formData = await req.formData();
      const directory = normalizeMaterialDirectory(formData.get('path'));
      const file = formData.get('file');

      if (!(file instanceof File)) {
        return expectedUserFacingErrorResponse({
          error: '请选择要导入的素材文件。',
          code: 'material_file_required',
          status: 400,
        });
      }

      const fileName = normalizeFileName(file.name, '导入素材.txt');
      assertMaterialUpload(file, fileName);
      const relativePath = await nextAvailableMaterialPath(directory, fileName);
      assertMaterialPath(relativePath);

      const arrayBuffer = await file.arrayBuffer();
      await writeOutputBuffer(relativePath, Buffer.from(arrayBuffer));

      return NextResponse.json({ ok: true, path: relativePath });
    }

    if (action === 'extract') {
      const body = (await req.json()) as { path?: unknown };
      if (typeof body.path !== 'string' || !body.path.trim()) {
        return expectedUserFacingErrorResponse({
          error: '请选择要整理的素材文件。',
          code: 'material_file_required',
          status: 400,
        });
      }

      const result = await extractMaterialAsset(body.path);
      return NextResponse.json(result);
    }

    if (action === 'start-intake') {
      const body = (await req.json()) as {
        path?: unknown;
        platforms?: unknown;
        scenario?: unknown;
        targetPlatform?: unknown;
        jobName?: unknown;
        research?: unknown;
      };
      if (typeof body.path !== 'string' || !body.path.trim()) {
        return expectedUserFacingErrorResponse({
          error: '请选择要用于本期创作的素材文件。',
          code: 'material_file_required',
          status: 400,
        });
      }

      const result = await startMaterialIntakeRequest(body);
      return NextResponse.json(result);
    }

    return expectedUserFacingErrorResponse({
      error: '这个素材操作暂不支持。',
      code: 'material_action_unsupported',
      status: 400,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存失败';
    return userFacingErrorResponse(materialUserFacingCause(error, message), {
      error: '暂时无法保存素材，请重试。',
      code: 'materials_save_failed',
      status: materialErrorStatus(message),
    });
  }
}

function materialUserFacingCause(error: unknown, message: string): unknown {
  if (message.includes('音频仍在转写中')) {
    return new KnownUserFacingError({
      error: '音频还在转成文字，请稍后再试。',
      code: 'material_transcription_in_progress',
    }, { status: 422, detail: error });
  }
  if (message.includes('尚未完成 OCR / 转写')) {
    return new KnownUserFacingError({
      error: '这个附件还没有可用文字。请先补充文字稿或摘要。',
      code: 'material_text_required',
    }, { status: 422, detail: error });
  }
  if (message.includes('缺少可验证的解析状态')) {
    return new KnownUserFacingError({
      error: '这个素材的信息不完整，请重新导入。',
      code: 'material_reimport_required',
    }, { status: 422, detail: error });
  }
  return error;
}

function materialErrorStatus(message: string) {
  if (message.includes('尚未完成 OCR / 转写') || message.includes('音频仍在转写中') || message.includes('缺少可验证的解析状态')) {
    return 422;
  }

  return message.includes('个人库目录')
    || message.includes('素材文件为空')
    || message.includes('素材文件过大')
    || message.includes('素材内容')
    || message.includes('请选择要解析的素材文件')
    || message.includes('请选择要进入生产线的素材文件')
    || message.includes('素材启动请求')
    || message.includes('只能下载素材文件')
    || message.includes('不支持的素材文件类型')
    || message.includes('历史媒体文件')
    ? 400
    : 500;
}

function normalizeMaterialDirectory(value: FormDataEntryValue | string | undefined | null) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'materials/hit-library';
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const directory = normalized.startsWith('materials/') || normalized === 'materials'
    ? normalized
    : `materials/${normalized}`;

  assertMaterialPath(directory);
  return directory;
}

function normalizeFileName(value: string | undefined | null, fallback: string, markdown = false) {
  const raw = value?.trim() || fallback;
  const segments = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  const lastSegment = segments.at(-1) || fallback;
  const cleaned = lastSegment
    .replace(/[<>:"|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, fallback);

  const fileName = cleaned || fallback;
  if (markdown && !/\.[a-z0-9]+$/i.test(fileName)) return `${fileName}.md`;
  return fileName;
}

function assertMaterialUpload(file: File, fileName: string) {
  if (file.size <= 0) {
    throw new Error('素材文件为空');
  }
  if (file.size > MAX_MATERIAL_UPLOAD_BYTES) {
    throw new Error('素材文件过大，请控制在 25MB 以内');
  }
  const ext = parse(fileName).ext.toLowerCase();
  if (!MATERIAL_EXTENSIONS.has(ext)) {
    throw new Error('不支持的素材文件类型');
  }
}

function assertMaterialPath(relativePath: string) {
  const safePath = safeResolve(BASE_DIR, relativePath);
  const materialBase = safeResolve(BASE_DIR, 'materials');
  const relation = safePath && materialBase ? relative(materialBase, safePath) : '..';

  if (!safePath || !materialBase || relation === '..' || relation.startsWith('../') || relativePath.split('/').includes('..')) {
    throw new Error('只能写入个人库目录');
  }
}

async function startMaterialIntakeRequest(body: {
  path?: unknown;
  platforms?: unknown;
  scenario?: unknown;
  targetPlatform?: unknown;
  jobName?: unknown;
  research?: unknown;
}) {
  const sourcePath = String(body.path || '').trim();
  assertMaterialPath(sourcePath);

  const safePath = safeResolve(BASE_DIR, sourcePath);
  if (!safePath) throw new Error('只能写入个人库目录');
  const info = await stat(safePath);
  if (!info.isFile()) throw new Error('只能下载素材文件');

  const isExistingExtraction = sourcePath.startsWith('materials/extracted/') && isTextPreviewableMaterial(sourcePath);
  const extraction: MaterialExtractionResult = isExistingExtraction
    ? existingMaterialExtraction(sourcePath, await readOutputFile(sourcePath))
    : await extractMaterialAsset(sourcePath);
  assertMaterialExtractionReadyForIntake(extraction.extractionStatus);

  // Keep the companion asset and its parsing state with the request. The
  // legacy text field remains only for already-readable sources; an opaque
  // attachment must never turn its own "please OCR me" notice into input text.
  const rawMaterial = extraction.content.slice(0, MAX_TEXT_ARTIFACT_BYTES);
  const materialFiles = [materialUploadForExtraction({
    sourcePath,
    extractedPath: extraction.path,
    extractionStatus: extraction.extractionStatus,
    size: info.size,
  })];
  const requestId = randomUUID();
  const sourceName = parse(sourcePath).name || 'material';
  const jobName = normalizeRunName(
    typeof body.jobName === 'string' && body.jobName.trim() ? body.jobName : sourceName,
  );
  const request = {
    id: requestId,
    createdAt: new Date().toISOString(),
    sourcePath,
    extractedPath: extraction.path,
    extractionStatus: extraction.extractionStatus,
    jobName,
    topic: sourceName,
    scenario: normalizeScenario(body.scenario),
    platforms: normalizePlatforms(body.platforms),
    targetPlatform: normalizeTargetPlatform(body.targetPlatform),
    research: typeof body.research === 'boolean' ? body.research : false,
    rawMaterial,
    materialFiles,
  };

  await writeOutputFile(`sessions/material-intake-requests/${requestId}.json`, JSON.stringify(request, null, 2));
  await writeOutputFile('sessions/material-intake-latest.json', JSON.stringify({ id: requestId, createdAt: request.createdAt }, null, 2));
  await writeOutputFile('sessions/material-intake-task.md', materialIntakeTaskCard(request));

  return {
    ok: true,
    requestId,
    sourcePath,
    extractedPath: extraction.path,
    extractionStatus: extraction.extractionStatus,
    materialFiles,
    jobName,
    nextUrl: `/production?materialRequest=${encodeURIComponent(requestId)}`,
  };
}

async function materialIntakeRequestResponse(requestId: string) {
  const safeRequestId = await resolveIntakeRequestId(requestId);
  const request = JSON.parse(await readOutputFile(`sessions/material-intake-requests/${safeRequestId}.json`)) as Record<string, unknown>;
  const extractionStatus = request.extractionStatus;
  if (!isMaterialExtractionStatus(extractionStatus)) {
    throw new Error('素材启动请求缺少可验证的解析状态，请重新从个人库导入。');
  }
  assertMaterialExtractionReadyForIntake(extractionStatus);
  return NextResponse.json(request);
}

async function resolveIntakeRequestId(value: string) {
  if (value === 'latest') {
    try {
      const latest = JSON.parse(await readOutputFile('sessions/material-intake-latest.json')) as { id?: unknown };
      const id = typeof latest.id === 'string' ? latest.id : '';
      assertIntakeRequestId(id);
      return id;
    } catch {
      throw new Error('素材启动请求不存在');
    }
  }
  assertIntakeRequestId(value);
  return value;
}

function assertIntakeRequestId(value: string) {
  if (!/^[a-f0-9-]{36}$/i.test(value)) {
    throw new Error('素材启动请求无效');
  }
}

function materialIntakeTaskCard(request: {
  id: string;
  sourcePath: string;
  extractedPath: string;
  extractionStatus: string | undefined;
  jobName: string;
  scenario: string;
  platforms: string[];
  targetPlatform: string;
}) {
  return [
    `# 素材进入生产线任务卡 · ${request.jobName}`,
    '',
    '## 1. 来源',
    `- 原始素材：${request.sourcePath}`,
    `- 解析资产：${request.extractedPath}`,
    `- 解析状态：${request.extractionStatus || 'unknown'}`,
    `- 请求 ID：${request.id}`,
    '',
    '## 2. 执行方式',
    '- 前端路径：打开 `/production`，系统会根据 `materialRequest` 自动预填解析素材，并从七阶段工作台开始本期生产。',
    '- 对应 skill：`content-intake`。',
    '- 生产原则：先完成素材理解报告，并通过 runtime validate，再进入立项。',
    '',
    '## 3. 质量边界',
    '- 如果解析资产标记为 `needs_transcription`，必须先补充转写/OCR/人工摘要。',
    '- 不允许把附件文件名、截图印象或未读 PDF 当成事实依据。',
    '- 后续成稿引用必须保留原始素材路径、解析资产路径和证据位置。',
    '',
  ].join('\n');
}

function normalizeRunName(value: string) {
  const cleaned = value
    .trim()
    .replace(/[<>:"|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  return cleaned || `material-${Date.now()}`;
}

function normalizeScenario(value: unknown) {
  const allowed = new Set(['auto', 'personal', 'interview', 'growth', 'business', 'global']);
  return typeof value === 'string' && allowed.has(value) ? value : 'auto';
}

function normalizeTargetPlatform(value: unknown) {
  const allowed = new Set(['all', 'wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments']);
  const normalized = value === 'xhs' ? 'xiaohongshu' : value;
  return typeof normalized === 'string' && allowed.has(normalized) ? normalized : 'all';
}

function normalizePlatforms(value: unknown) {
  const allowed = new Set(['wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments']);
  const items = Array.isArray(value) ? value : ['wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'];
  const platforms = items
    .map((item) => item === 'xhs' ? 'xiaohongshu' : item)
    .filter((item): item is string => typeof item === 'string' && allowed.has(item));
  return platforms.length ? platforms : ['wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'];
}

function isMaterialExtractionStatus(value: unknown): value is MaterialExtractionStatus {
  return typeof value === 'string' && MATERIAL_EXTRACTION_STATUSES.has(value as MaterialExtractionStatus);
}

function existingMaterialExtraction(sourcePath: string, content: string): MaterialExtractionResult {
  return {
    ok: true,
    path: sourcePath,
    sourcePath,
    extractionStatus: extractionStatusFromAsset(content),
    previewable: true,
    content,
  };
}

function extractionStatusFromAsset(content: string): MaterialExtractionStatus {
  // Generated extraction assets carry this in frontmatter. Scan the bounded
  // metadata header rather than infer readability from a mutable file name.
  const match = content.slice(0, 16 * 1024).match(/^extraction_status:\s*([^\s#]+)\s*$/m);
  return isMaterialExtractionStatus(match?.[1]) ? match[1] : 'existing_extraction';
}

function assertMaterialExtractionReadyForIntake(status: MaterialExtractionStatus) {
  if (status === 'transcribing') {
    throw new Error('音频仍在转写中，请等待转写完成后再进入本期内容。');
  }
  if (status === 'needs_transcription') {
    throw new Error('素材尚未完成 OCR / 转写，不能进入本期内容；请先补充逐字稿、OCR 文本或人工摘要。');
  }
}

function materialUploadForExtraction(input: {
  sourcePath: string;
  extractedPath: string;
  extractionStatus: MaterialExtractionStatus;
  size: number;
}): MaterialUpload {
  return {
    name: parse(input.sourcePath).base || '素材文件',
    size: input.size,
    sourcePath: input.sourcePath,
    path: input.extractedPath,
    extractionStatus: input.extractionStatus,
  };
}

async function extractMaterialAsset(relativePath: string): Promise<MaterialExtractionResult> {
  assertMaterialPath(relativePath);
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) throw new Error('只能写入个人库目录');

  if (REMOVED_MEDIA_EXTENSIONS.has(parse(relativePath).ext.toLowerCase())) {
    throw new Error('该历史媒体文件仅保留下载兼容，不再进入解析或生产流程。');
  }

  const info = await stat(safePath);
  if (!info.isFile()) {
    throw new Error('只能下载素材文件');
  }

  const sourceName = parse(relativePath).base || 'material';
  const sourceExt = parse(relativePath).ext.toLowerCase() || 'unknown';
  const createdAt = new Date().toISOString();
  const readable = isTextPreviewableMaterial(relativePath);
  const pdf = !readable && isPdfMaterial(relativePath);
  const transcribable = !readable && isTranscribableMaterial(relativePath);

  if (transcribable) {
    return extractAudioMaterialAsync(relativePath);
  }

  const pdfExtraction = pdf ? await extractPdfMaterialText(safePath) : undefined;
  const text = readable
    ? await readMaterialTextSnippet(relativePath)
    : pdfExtraction?.text || '';
  const extractionStatus: MaterialExtractionStatus = readable
    ? 'text_extracted'
    : pdfExtraction?.status || 'needs_transcription';
  const extractionContent = buildExtractionMarkdown({
    sourcePath: relativePath,
    sourceName,
    sourceExt,
    size: info.size,
    createdAt,
    readable,
    pdfExtraction,
    transcribable: false,
    extractionStatus,
    transcription: undefined,
    text,
  });
  const outputName = normalizeFileName(
    `${timestampForFile(createdAt)}-${sourceName.replace(/\.[a-z0-9]+$/i, '')}-extract.md`,
    'material-extract.md',
    true,
  );
  const outputPath = await nextAvailableMaterialPath('materials/extracted', outputName);
  await writeOutputFile(outputPath, extractionContent);

  return {
    ok: true,
    path: outputPath,
    sourcePath: relativePath,
    extractionStatus,
    previewable: true,
    content: extractionContent,
  };
}

/**
 * Audio transcription is deliberately detached from the extract HTTP response:
 * a long recording can take minutes, and a browser refresh must not cancel it.
 * The first call starts a background run and returns `transcribing`; a later
 * call (or the dedicated status endpoint) observes the durable job result.
 */
async function extractAudioMaterialAsync(relativePath: string): Promise<MaterialExtractionResult> {
  assertMaterialPath(relativePath);
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) throw new Error('只能写入个人库目录');

  const job = await readTranscriptionJob(relativePath);
  if (job?.status === 'done' && job.path && job.extractionStatus) {
    return {
      ok: true,
      path: job.path,
      sourcePath: relativePath,
      extractionStatus: job.extractionStatus,
      previewable: true,
      content: job.content || '',
    };
  }

  const transcribing: MaterialExtractionResult = {
    ok: true,
    path: relativePath,
    sourcePath: relativePath,
    extractionStatus: 'transcribing',
    previewable: true,
    content: '',
  };

  // A 'running' record is only authoritative while a live in-process run backs
  // it; a stale record left by a prior process is restarted below.
  if (activeTranscriptions.has(relativePath) && job?.status === 'running') return transcribing;

  const info = await stat(safePath);
  const sourceName = parse(relativePath).base || 'material';
  const sourceExt = parse(relativePath).ext.toLowerCase() || 'unknown';
  const createdAt = new Date().toISOString();
  const execution = runAudioTranscription({
    relativePath,
    safePath,
    sourceName,
    sourceExt,
    createdAt,
    size: info.size,
  }).catch(() => {
    // Failure is persisted on the job file; never turn it into an unhandled rejection.
  });
  activeTranscriptions.set(relativePath, execution);
  void execution.finally(() => {
    if (activeTranscriptions.get(relativePath) === execution) {
      activeTranscriptions.delete(relativePath);
    }
  });

  return transcribing;
}

async function runAudioTranscription(input: {
  relativePath: string;
  safePath: string;
  sourceName: string;
  sourceExt: string;
  createdAt: string;
  size: number;
}): Promise<void> {
  const transcriptDir = safeResolve(BASE_DIR, TRANSCRIPTION_JOB_DIR) || input.safePath;
  await writeTranscriptionJob(input.relativePath, {
    status: 'running',
    sourcePath: input.relativePath,
    updatedAt: new Date().toISOString(),
  });

  try {
    const transcription = await transcribeMaterialMedia(input.safePath, transcriptDir);
    const extractionStatus: MaterialExtractionStatus = transcription.status;
    const extractionContent = buildExtractionMarkdown({
      sourcePath: input.relativePath,
      sourceName: input.sourceName,
      sourceExt: input.sourceExt,
      size: input.size,
      createdAt: input.createdAt,
      readable: false,
      pdfExtraction: undefined,
      transcribable: true,
      extractionStatus,
      transcription,
      text: transcription.transcript,
    });
    const outputName = normalizeFileName(
      `${timestampForFile(input.createdAt)}-${input.sourceName.replace(/\.[a-z0-9]+$/i, '')}-extract.md`,
      'material-extract.md',
      true,
    );
    const outputPath = await nextAvailableMaterialPath('materials/extracted', outputName);
    await writeOutputFile(outputPath, extractionContent);

    await writeTranscriptionJob(input.relativePath, {
      status: 'done',
      sourcePath: input.relativePath,
      path: outputPath,
      extractionStatus,
      content: extractionContent,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const failure = userFacingErrorPayload(error, {
      error: '音频转写失败，请重试。',
      code: 'material_transcription_failed',
      context: 'material background transcription',
    });
    await writeTranscriptionJob(input.relativePath, {
      status: 'failed',
      sourcePath: input.relativePath,
      error: failure.error,
      code: failure.code,
      debugId: failure.debugId,
      updatedAt: new Date().toISOString(),
    });
  }
}

function transcriptionJobPath(relativePath: string): string {
  return join(TRANSCRIPTION_JOB_DIR, `${parse(relativePath).name}.transcription.json`);
}

async function readTranscriptionJob(relativePath: string): Promise<TranscriptionJob | null> {
  try {
    const job = JSON.parse(await readOutputFile(transcriptionJobPath(relativePath))) as TranscriptionJob;
    if (job?.status !== 'failed') {
      return job?.status === 'done' && typeof job.content === 'string'
        ? { ...job, content: sanitizeLegacyExtractionMarkdown(job.content) }
        : job;
    }
    // Old job files may contain raw subprocess stderr or provider exceptions.
    // Keep them readable without returning that historical diagnostic text.
    return {
      ...job,
      error: '音频转写失败，请检查转写配置后重试。',
      code: typeof job.code === 'string' && job.code ? job.code : 'material_transcription_failed',
      debugId: typeof job.debugId === 'string' && /^[a-z0-9_-]{6,80}$/i.test(job.debugId) ? job.debugId : undefined,
    };
  } catch {
    return null;
  }
}

function sanitizeLegacyExtractionMarkdown(content: string): string {
  return content
    .replace(/\nPDF 解析错误：\s*\n+```text\n[\s\S]*?\n```/g, '\n这份 PDF 没有解析成功。请换一个文件重试，其他素材不受影响。')
    .replace(/\n转写错误：\s*\n+```text\n[\s\S]*?\n```/g, '\n这段音频没有转写成功。请检查转写配置后重试，其他素材不受影响。');
}

async function writeTranscriptionJob(relativePath: string, job: TranscriptionJob): Promise<void> {
  await writeOutputFile(transcriptionJobPath(relativePath), JSON.stringify(job, null, 2));
}

async function transcriptionStatusResponse(relativePath: string) {
  assertMaterialPath(relativePath);
  const job = await readTranscriptionJob(relativePath);

  if (job?.status === 'done') {
    return {
      ok: true,
      status: 'done',
      sourcePath: relativePath,
      path: job.path,
      extractionStatus: job.extractionStatus,
    };
  }

  if (job?.status === 'failed') {
    return {
      ok: true,
      status: 'failed',
      sourcePath: relativePath,
      extractionStatus: 'needs_transcription',
      error: '音频转写失败，请检查转写配置后重试。',
      code: job.code || 'material_transcription_failed',
      ...(job.debugId ? { debugId: job.debugId } : {}),
    };
  }

  // 'running' or 'missing': make sure a live run backs the record. This starts
  // a job that never got written and restarts a stale 'running' left by a
  // previous process, without double-starting an already-live run.
  if (!activeTranscriptions.has(relativePath)) {
    await extractAudioMaterialAsync(relativePath);
  }

  return { ok: true, status: 'running', sourcePath: relativePath, extractionStatus: 'transcribing' };
}

async function readMaterialTextSnippet(relativePath: string) {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) throw new Error('只能写入个人库目录');
  const raw = await readFile(safePath);
  const sliced = raw.byteLength > MAX_EXTRACTED_TEXT_BYTES
    ? raw.subarray(0, MAX_EXTRACTED_TEXT_BYTES)
    : raw;
  return sliced.toString('utf-8').replace(/\u0000/g, '');
}

function buildExtractionMarkdown(input: {
  sourcePath: string;
  sourceName: string;
  sourceExt: string;
  size: number;
  createdAt: string;
  readable: boolean;
  pdfExtraction?: MaterialPdfExtractionResult;
  transcribable?: boolean;
  extractionStatus: string;
  transcription?: MaterialTranscriptionResult;
  text: string;
}) {
  const transcribed = input.extractionStatus === 'audio_transcribed';
  const pdfExtracted = input.extractionStatus === 'text_extracted' && Boolean(input.pdfExtraction);
  const canReadBody = input.readable || transcribed || pdfExtracted;
  const statusText = input.readable
    ? '已抽取文本摘录'
    : transcribed
      ? `已完成语音转写（${input.transcription?.provider || 'unknown'}）`
      : pdfExtracted
        ? input.pdfExtraction?.provider === 'pdfkit-text'
          ? '已读取 PDF 文字层'
          : '已完成 PDF OCR（macOS Vision）'
        : '待补充转写/OCR';
  const evidence = canReadBody ? evidenceLedger(input.text, input.sourcePath) : [
    '- 待补充：请上传逐字稿、OCR 文本或人工摘要后，再进入 content-intake。',
  ];
  const readableBody = canReadBody
    ? [
      input.readable
        ? '以下内容来自系统可读取文本摘录；长文件只保留前 256KB，正式成稿前仍需回看原始素材。'
        : transcribed
          ? '以下内容来自系统自动转写；正式成稿前仍需回听原始音频，尤其是人名、数字、品牌名和引用原话。'
          : '以下内容来自系统自动读取 PDF 文字层或 macOS Vision OCR；正式成稿前仍需回看原始页面，尤其是人名、数字、品牌名和引用原话。',
      '',
      '```text',
      escapeCodeFence(input.text.trim() || '（文本素材为空）'),
      '```',
    ].join('\n')
    : [
      input.pdfExtraction
        ? '系统已尝试读取 PDF 文字层并执行本机 OCR，仍未获得可用正文。系统不会根据文件名或上传动作伪造正文；请补充可读 PDF、OCR 文本或人工摘要。'
        : input.transcribable
          ? '当前音频文件自动转写失败，系统不会根据文件名或上传动作伪造正文。请配置本地 Whisper/OpenAI 音频转写，或补充人工逐字稿。'
          : '当前文件类型不能在本地 UI 中可靠抽取正文。系统不会伪造图片或 Office 附件内容；请先补充逐字稿、OCR 文本或人工摘要。',
      input.pdfExtraction?.error ? '\n这份 PDF 没有解析成功。请换一个文件重试，其他素材不受影响。' : '',
      input.transcription?.error ? '\n这段音频没有转写成功。请检查转写配置后重试，其他素材不受影响。' : '',
    ].filter(Boolean).join('\n');

  return [
    '---',
    `source_path: ${input.sourcePath}`,
    `source_name: ${input.sourceName}`,
    `source_ext: ${input.sourceExt}`,
    `source_size: ${input.size}`,
    `extraction_status: ${input.extractionStatus}`,
    input.pdfExtraction?.provider ? `pdf_extraction_provider: ${input.pdfExtraction.provider}` : '',
    input.pdfExtraction?.pageCount ? `pdf_page_count: ${input.pdfExtraction.pageCount}` : '',
    input.pdfExtraction?.processedPages ? `pdf_processed_pages: ${input.pdfExtraction.processedPages}` : '',
    input.transcription?.provider ? `transcription_provider: ${input.transcription.provider}` : '',
    `created_at: ${input.createdAt}`,
    '---',
    '',
    `# 素材解析资产 · ${input.sourceName}`,
    '',
    '## 1. 来源与边界',
    `- 原始素材：${input.sourcePath}`,
    `- 文件类型：${input.sourceExt}`,
    `- 文件大小：${input.size} bytes`,
    `- 解析状态：${statusText}`,
    '- 使用边界：本资产只作为 content-intake 的输入材料，不替代事实核验、授权确认和人工复核。',
    '',
    '## 2. 可读取正文',
    readableBody,
    '',
    '## 3. 证据台账',
    ...evidence,
    '',
    '## 4. 下游使用建议',
    '- 推荐下一步：把本解析资产作为素材输入交给 content-intake。',
    '- 写作引用时必须保留原始素材路径和证据编号，避免下游成稿出现不可追溯判断。',
    '- 如果进入公众号长文或小红书图文，请在 breakdown 中写明哪些证据必须使用、哪些信息禁止公开。',
    '',
    '## 5. 风险与待补充',
    ...(input.readable
      ? [
        '- 需要人工确认：文本是否完整、是否存在隐私信息、是否有上下文缺口。',
        '- 如果素材含硬数字、客户案例或原话引用，必须在 audit 阶段建立事实声明台账。',
      ]
      : transcribed
        ? [
          '- 需要人工确认：自动转写是否准确，尤其是人名、公司名、金额、时间和引用原话。',
          '- 如果素材含硬数字、客户案例或敏感信息，必须在 audit 阶段回听原始素材并建立事实声明台账。',
        ]
        : pdfExtracted
          ? [
            '- 需要人工确认：PDF 提取/OCR 是否准确，尤其是人名、公司名、金额、时间和引用原话。',
            ...(input.pdfExtraction?.warnings || []).map((warning) => `- 解析提示：${warning}`),
            '- 如果素材含硬数字、客户案例或敏感信息，必须在 audit 阶段回看原始页面并建立事实声明台账。',
          ]
        : [
        '- 阻断项：当前附件尚未转成可读文本，不应直接进入内容生成。',
        '- 需要补充：OCR 文本、访谈逐字稿、截图说明、授权状态和可公开范围。',
      ]),
    '',
  ].join('\n');
}

function evidenceLedger(text: string, sourcePath: string) {
  const rows = text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter((item) => item.line.length >= 8)
    .slice(0, 12);

  if (rows.length === 0) {
    return ['- E01：文本素材没有足够可摘录句子，请人工补充关键事实、观点和案例。'];
  }

  return rows.map((item, index) => {
    const id = String(index + 1).padStart(2, '0');
    const excerpt = item.line.length > 180 ? `${item.line.slice(0, 180)}...` : item.line;
    return `- E${id}：${excerpt}（来源：${sourcePath}，文本行 ${item.index}）`;
  });
}

function escapeCodeFence(value: string) {
  return value.replace(/```/g, '\\`\\`\\`');
}

function timestampForFile(value: string) {
  return value.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/[TZ]/g, '-').replace(/-$/, '');
}

function isTextPreviewableMaterial(relativePath: string) {
  const ext = parse(relativePath).ext.toLowerCase();
  return TEXT_PREVIEW_EXTENSIONS.has(ext);
}

function materialDownloadUrl(relativePath: string) {
  return `/api/materials?download=${encodeURIComponent(relativePath)}`;
}

async function materialDownloadResponse(relativePath: string) {
  assertMaterialPath(relativePath);
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) throw new Error('只能写入个人库目录');

  const info = await stat(safePath);
  if (!info.isFile()) {
    throw new Error('只能下载素材文件');
  }

  const content = await readFile(safePath);
  const fileName = parse(relativePath).base || 'material';
  const fallbackName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'material';
  const encodedName = encodeURIComponent(fileName);

  return new Response(content, {
    headers: {
      'Content-Type': materialContentType(relativePath),
      'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'no-store',
    },
  });
}

function materialContentType(relativePath: string) {
  const ext = parse(relativePath).ext.toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.doc') return 'application/msword';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ppt') return 'application/vnd.ms-powerpoint';
  if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (ext === '.xls') return 'application/vnd.ms-excel';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.md' || ext === '.txt' || ext === '.rtf') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function nextAvailableMaterialPath(directory: string, fileName: string) {
  let candidate = join(directory, fileName);
  assertMaterialPath(candidate);

  const { name, ext } = parse(fileName);
  let index = 2;

  while (await fileExists(candidate)) {
    candidate = join(directory, `${name}-${index}${ext}`);
    assertMaterialPath(candidate);
    index += 1;
  }

  return candidate;
}

async function fileExists(relativePath: string) {
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) return false;

  try {
    await access(safePath);
    return true;
  } catch {
    return false;
  }
}

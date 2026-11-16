import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { constants } from 'fs';
import { promisify } from 'util';
import { access, mkdir, readdir, readFile, stat } from 'fs/promises';
import { basename, parse } from 'path';
import { resolveServerLLMConfig } from './server-config';
import { runtimeJoin, skillPath } from './project-root';

const execFileAsync = promisify(execFile);
const OPENAI_OFFICIAL_BASE_URL = 'https://api.openai.com/v1';

function resolveOpenAITranscriptionRuntime(options: {
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
}) {
  const audioApiKey = process.env.OPENAI_AUDIO_API_KEY || process.env.AIFIOS_OPENAI_AUDIO_API_KEY || '';
  const audioBaseUrl = normalizeOpenAIBaseUrl(process.env.OPENAI_AUDIO_BASE_URL || process.env.AIFIOS_OPENAI_AUDIO_BASE_URL || '');
  const envApiKey = process.env.OPENAI_API_KEY || '';

  if (audioApiKey || envApiKey) {
    return {
      apiKey: audioApiKey || envApiKey,
      baseUrl: audioBaseUrl || OPENAI_OFFICIAL_BASE_URL,
      ready: true,
      message: '',
    };
  }

  if (String(options.provider || '').toLowerCase() === 'openai' && options.apiKey) {
    const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl);
    let isOfficial = false;
    try {
      isOfficial = Boolean(baseUrl) && new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com';
    } catch {
      isOfficial = false;
    }
    if (!baseUrl || isOfficial) {
      return { apiKey: options.apiKey, baseUrl: baseUrl || OPENAI_OFFICIAL_BASE_URL, ready: true, message: '' };
    }
  }

  return { apiKey: '', baseUrl: '', ready: false, message: '未检测到可用的 OpenAI 音频转写配置' };
}

export interface MaterialTranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface MaterialTranscriptionResult {
  status: 'audio_transcribed' | 'needs_transcription';
  provider: 'local-whisper' | 'openai' | 'missing';
  transcript: string;
  segments: MaterialTranscriptSegment[];
  error?: string;
  code?: string;
  debugId?: string;
}

export interface MaterialPdfExtractionResult {
  status: 'text_extracted' | 'needs_transcription';
  provider: 'pdfkit-text' | 'macos-vision-ocr' | 'missing';
  text: string;
  pageCount?: number;
  processedPages?: number;
  warnings: string[];
  error?: string;
  code?: string;
  debugId?: string;
}

const TRANSCRIBABLE_EXTENSIONS = new Set([
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.wav',
]);

const PDF_EXTENSIONS = new Set(['.pdf']);
const MAX_PDF_OCR_PAGES = 40;
const MAX_PDF_OCR_CHARACTERS = 80_000;
const PDF_OCR_TIMEOUT_MS = 120_000;
const PDF_OCR_MAX_BUFFER_BYTES = 512 * 1024;
// Local transcription can legitimately run for many minutes on long audio, but
// must never hang the caller forever. Bounded generously; override with
// AIFIOS_TRANSCRIPTION_TIMEOUT_MS when a deployment has known-slow hardware.
const LOCAL_TRANSCRIPTION_TIMEOUT_MS = Number(process.env.AIFIOS_TRANSCRIPTION_TIMEOUT_MS) || 30 * 60 * 1000;
const LOCAL_TRANSCRIPTION_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function isTranscribableMaterial(relativePath: string): boolean {
  return TRANSCRIBABLE_EXTENSIONS.has(parse(relativePath).ext.toLowerCase());
}

export function isPdfMaterial(relativePath: string): boolean {
  return PDF_EXTENSIONS.has(parse(relativePath).ext.toLowerCase());
}

/**
 * Reads a PDF's native text layer first, then falls back to macOS Vision OCR
 * for scanned pages. The executable is bundled with the desktop application,
 * so this deliberately never shells out to a developer-only OCR installation.
 */
export async function extractPdfMaterialText(sourcePath: string): Promise<MaterialPdfExtractionResult> {
  try {
    const binary = await resolvePdfOcrBinary();
    if (!binary) {
      throw new Error('未找到内置 macOS PDF OCR 组件');
    }

    const { stdout } = await execFileAsync(binary, [
      sourcePath,
      '--max-pages',
      String(MAX_PDF_OCR_PAGES),
      '--max-characters',
      String(MAX_PDF_OCR_CHARACTERS),
    ], {
      timeout: PDF_OCR_TIMEOUT_MS,
      maxBuffer: PDF_OCR_MAX_BUFFER_BYTES,
    });
    const payload = parsePdfOcrPayload(stdout);
    const text = normalizePdfText(payload.text);
    if (!isUsablePdfText(text)) {
      throw new Error('内置 PDF OCR 未返回足够可用的正文');
    }

    return {
      status: 'text_extracted',
      provider: payload.engine,
      text,
      pageCount: payload.pageCount,
      processedPages: payload.processedPages,
      warnings: payload.warnings,
    };
  } catch {
    const debugId = materialProcessingDebugId();
    return {
      status: 'needs_transcription',
      provider: 'missing',
      text: '',
      warnings: [],
      error: '这份 PDF 没有解析成功，其他素材不受影响。请换一个文件重试。',
      code: 'material_pdf_extraction_failed',
      debugId,
    };
  }
}

export async function transcribeMaterialMedia(
  sourcePath: string,
  outputDir: string,
): Promise<MaterialTranscriptionResult> {
  await mkdir(outputDir, { recursive: true });

  try {
    const segments = await transcribeWithLocalWhisper(sourcePath, outputDir);
    const normalized = normalizeSegments(segments);
    return {
      status: 'audio_transcribed',
      provider: 'local-whisper',
      transcript: segmentsToText(normalized),
      segments: normalized,
    };
  } catch {
    try {
      const config = await resolveServerLLMConfig(undefined);
      const transcriptionConfig = resolveOpenAITranscriptionRuntime({
        apiKey: config.apiKey,
        provider: config.provider,
        baseUrl: config.baseUrl,
      });

      if (!transcriptionConfig.ready || !transcriptionConfig.apiKey) {
        throw new Error(transcriptionConfig.message || '未检测到可用的 OpenAI 音频转写配置');
      }

      const segments = await transcribeWithOpenAI(sourcePath, {
        apiKey: transcriptionConfig.apiKey,
        baseUrl: transcriptionConfig.baseUrl,
      });
      const normalized = normalizeSegments(segments);
      return {
        status: 'audio_transcribed',
        provider: 'openai',
        transcript: segmentsToText(normalized),
        segments: normalized,
      };
    } catch {
      const debugId = materialProcessingDebugId();
      return {
        status: 'needs_transcription',
        provider: 'missing',
        transcript: '',
        segments: [],
        error: '这段音频没有转写成功，其他素材不受影响。请检查转写配置后重试。',
        code: 'material_audio_transcription_failed',
        debugId,
      };
    }
  }
}

async function transcribeWithLocalWhisper(sourcePath: string, outputDir: string): Promise<MaterialTranscriptSegment[]> {
  if (await commandAvailable('whisper')) {
    const before = await listFilesWithExtension(outputDir, '.srt');
    await execFileAsync('whisper', [
      sourcePath,
      '--model',
      'small',
      '--language',
      'zh',
      '--output_dir',
      outputDir,
      '--output_format',
      'srt',
    ], {
      timeout: LOCAL_TRANSCRIPTION_TIMEOUT_MS,
      maxBuffer: LOCAL_TRANSCRIPTION_MAX_BUFFER_BYTES,
    });
    const srtPath = await findWhisperSrt(sourcePath, outputDir, before);
    return parseSrt(await readFile(srtPath, 'utf-8'));
  }

  if (await commandAvailable('whisper-cpp')) {
    const outputBase = runtimeJoin(outputDir, `${basename(sourcePath).replace(/\.[^.]+$/, '')}-whisper-cpp`);
    await execFileAsync('whisper-cpp', [
      '-f',
      sourcePath,
      '-osrt',
      '-of',
      outputBase,
      '-m',
      runtimeJoin(process.env.HOME || '', '.ggml', 'ggml-small.bin'),
      '-l',
      'zh',
    ], {
      timeout: LOCAL_TRANSCRIPTION_TIMEOUT_MS,
      maxBuffer: LOCAL_TRANSCRIPTION_MAX_BUFFER_BYTES,
    });
    return parseSrt(await readFile(`${outputBase}.srt`, 'utf-8'));
  }

  if (await commandAvailable('whisperkit-cli')) {
    const reportPath = runtimeJoin(outputDir, `${basename(sourcePath).replace(/\.[^.]+$/, '')}-whisperkit.json`);
    await execFileAsync('whisperkit-cli', [
      'transcribe',
      '--audio-path',
      sourcePath,
      '--report',
      '--report-path',
      reportPath,
    ], {
      timeout: LOCAL_TRANSCRIPTION_TIMEOUT_MS,
      maxBuffer: LOCAL_TRANSCRIPTION_MAX_BUFFER_BYTES,
    });
    const report = JSON.parse(await readFile(reportPath, 'utf-8')) as { transcription?: string; text?: string };
    const text = String(report.transcription || report.text || '').trim();
    if (!text) throw new Error('WhisperKit 未返回可用文本');
    return [{ start: 0, end: 0, text }];
  }

  throw new Error('未找到本地 Whisper/whisper-cpp/whisperkit-cli');
}

async function transcribeWithOpenAI(
  sourcePath: string,
  options: { apiKey: string; baseUrl?: string },
): Promise<MaterialTranscriptSegment[]> {
  const root = normalizeOpenAIBaseUrl(options.baseUrl) || OPENAI_OFFICIAL_BASE_URL;
  const endpoint = new URL('audio/transcriptions', root.endsWith('/') ? root : `${root}/`);
  const buffer = await readFile(sourcePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mediaMimeType(sourcePath) }), basename(sourcePath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('language', 'zh');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text) as { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }> };
  const segments = Array.isArray(data.segments)
    ? data.segments.map((segment) => ({
      start: Number(segment.start) || 0,
      end: Number(segment.end) || 0,
      text: String(segment.text || '').trim(),
    }))
    : [];

  if (segments.some((segment) => segment.text)) return segments;
  if (String(data.text || '').trim()) return textToSegments(String(data.text));
  throw new Error('OpenAI Whisper 未返回可用文本');
}

function normalizeOpenAIBaseUrl(baseUrl?: string): string {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname
      .replace(/\/(?:chat\/completions|responses|audio\/transcriptions|audio\/translations)$/i, '')
      .replace(/\/+$/g, '');
    if (/^api\.openai\.com$/i.test(url.hostname) && !/\/v\d+(?:\/|$)/i.test(url.pathname)) {
      url.pathname = `${url.pathname}/v1`.replace(/\/+/g, '/');
    }
    return url.toString().replace(/\/$/g, '');
  } catch {
    return raw;
  }
}

type PdfOcrPayload = {
  ok: true;
  engine: 'pdfkit-text' | 'macos-vision-ocr';
  pageCount?: number;
  processedPages?: number;
  text: string;
  warnings: string[];
};

async function resolvePdfOcrBinary(): Promise<string> {
  const override = String(process.env.AIFIOS_MATERIAL_OCR_BINARY || '').trim();
  if (override) {
    try {
      await access(override, constants.X_OK);
      return override;
    } catch {
      return '';
    }
  }
  if (process.platform !== 'darwin') return '';

  const bundled = skillPath('content-runtime', 'bin', 'aifios-material-ocr');
  for (const candidate of [bundled]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known local runtime path.
    }
  }
  return '';
}

function parsePdfOcrPayload(raw: string): PdfOcrPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error('内置 PDF OCR 返回了无效结果');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('内置 PDF OCR 返回了无效结果');
  }
  const record = value as Record<string, unknown>;
  if (record.ok !== true) {
    throw new Error('内置 PDF OCR 未完成解析');
  }
  const engine = record.engine;
  if (engine !== 'pdfkit-text' && engine !== 'macos-vision-ocr') {
    throw new Error('内置 PDF OCR 返回了未知解析方式');
  }

  const text = typeof record.text === 'string' ? record.text : '';
  const warningCount = Array.isArray(record.warnings)
    ? record.warnings
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20)
      .length
    : 0;
  // OCR warnings are provider/subprocess output. Keep their existence, but
  // never project arbitrary text (paths, commands or credentials) into the UI
  // or generated material Markdown.
  const warnings = warningCount > 0
    ? ['部分页面可能没有完整识别，请回看原文件确认。']
    : [];
  const pageCount = positiveInteger(record.pageCount);
  const processedPages = positiveInteger(record.processedPages);

  return {
    ok: true,
    engine,
    text,
    warnings,
    ...(pageCount ? { pageCount } : {}),
    ...(processedPages ? { processedPages } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(result) && result > 0 ? result : undefined;
}

function normalizePdfText(value: string): string {
  const normalized = value
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  return normalized.length > MAX_PDF_OCR_CHARACTERS
    ? normalized.slice(0, MAX_PDF_OCR_CHARACTERS).trimEnd()
    : normalized;
}

function isUsablePdfText(value: string): boolean {
  return value.replace(/\s/g, '').length >= 8;
}

async function commandAvailable(name: string): Promise<boolean> {
  try {
    await execFileAsync('which', [name]);
    return true;
  } catch {
    return false;
  }
}

async function listFilesWithExtension(dir: string, extension: string): Promise<Set<string>> {
  try {
    return new Set(
      (await readdir(dir))
        .filter((entry) => entry.toLowerCase().endsWith(extension))
        .map((entry) => runtimeJoin(dir, entry)),
    );
  } catch {
    return new Set();
  }
}

async function findWhisperSrt(sourcePath: string, outputDir: string, before: Set<string>): Promise<string> {
  const expected = runtimeJoin(outputDir, basename(sourcePath).replace(/\.[^.]+$/, '.srt'));
  try {
    const info = await stat(expected);
    if (info.isFile()) return expected;
  } catch {
    // Scan newly generated files below.
  }

  const after = await listFilesWithExtension(outputDir, '.srt');
  const generated = [...after].filter((file) => !before.has(file));
  if (generated.length === 1) return generated[0];
  if (generated.length > 1) {
    const newest = await newestFile(generated);
    if (newest) return newest;
  }
  throw new Error('Whisper 已执行，但未找到生成的 SRT 文件');
}

async function newestFile(paths: string[]): Promise<string | undefined> {
  const rows = await Promise.all(paths.map(async (path) => {
    try {
      const info = await stat(path);
      return { path, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }));
  return rows
    .filter((row): row is { path: string; mtimeMs: number } => Boolean(row))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path;
}

function parseSrt(srtContent: string): MaterialTranscriptSegment[] {
  const segments: MaterialTranscriptSegment[] = [];
  for (const block of srtContent.trim().split(/\n\s*\n/)) {
    const lines = block.trim().split(/\r?\n/).filter(Boolean);
    const timeLine = lines.find((line) => line.includes('-->'));
    if (!timeLine) continue;
    const match = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!match) continue;
    segments.push({
      start: srtTimeToSeconds(match[1]),
      end: srtTimeToSeconds(match[2]),
      text: lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim(),
    });
  }
  return segments;
}

function srtTimeToSeconds(value: string): number {
  const [hours, minutes, secondsMs] = value.split(':');
  const [seconds, ms] = secondsMs.replace('.', ',').split(',');
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(ms) / 1000;
}

function textToSegments(text: string): MaterialTranscriptSegment[] {
  const chunks = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return (chunks.length ? chunks : [text.trim()]).map((chunk, index) => ({
    start: index * 3,
    end: (index + 1) * 3,
    text: chunk,
  }));
}

function normalizeSegments(segments: MaterialTranscriptSegment[]): MaterialTranscriptSegment[] {
  return segments
    .map((segment) => ({
      start: Math.max(0, Number(segment.start) || 0),
      end: Math.max(0, Number(segment.end) || 0),
      text: String(segment.text || '').trim(),
    }))
    .filter((segment) => segment.text)
    .map((segment, index, rows) => ({
      ...segment,
      end: segment.end > segment.start ? segment.end : rows[index + 1]?.start || segment.start + 3,
    }));
}

function segmentsToText(segments: MaterialTranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join('\n').trim();
}

function mediaMimeType(filePath: string): string {
  switch (parse(filePath).ext.toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.flac':
      return 'audio/flac';
    case '.aac':
      return 'audio/aac';
    default:
      return 'audio/mp4';
  }
}

function materialProcessingDebugId(): string {
  return `material_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths, safeResolve, toProjectRelativePath } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import { assertOptionalTextInput, InputLimitError, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

const execFileAsync = promisify(execFile);
const QUALITY_SCRIPT = contentRuntimeToolPath('quality_check.py');

const QUALITY_PLATFORM_ALIAS: Record<string, string> = {
  wechat: 'wechat',
  '公众号': 'wechat',
  xhs: 'xhs',
  xiaohongshu: 'xhs',
  '小红书': 'xhs',
};

const QUALITY_PLATFORM_STEP: Record<string, string> = {
  wechat: 'write',
  xhs: 'xhs',
};

const QUALITY_STEP_PREFIX: Record<string, string> = {
  write: 'pipeline/final/',
  xhs: 'pipeline/xhs/',
};

type QualityResult = {
  status?: string;
  gate_status?: string;
  delivery_audit_status?: string;
  platform?: string;
  platform_label?: string;
  score?: number;
  file?: string;
  report_path?: string;
  json_report_path?: string;
  run_id?: string;
  slug?: string;
  error?: string;
};

function toRelativePath(path: string | undefined | null): string {
  return toProjectRelativePath(path);
}

function normalizeResult(result: QualityResult): QualityResult {
  return {
    ...result,
    file: toRelativePath(result.file),
    report_path: toRelativePath(result.report_path),
    json_report_path: toRelativePath(result.json_report_path),
  };
}

function normalizeQualityPlatform(platform: string | undefined): string {
  const key = (platform || 'wechat').trim().toLowerCase();
  const normalized = QUALITY_PLATFORM_ALIAS[key];
  if (!normalized) throw new Error('未知质量验收平台，可用: wechat, xhs');
  return normalized;
}

function assertQualityStep(step: string | undefined, platform: string) {
  if (!step) return;
  const expectedStep = QUALITY_PLATFORM_STEP[platform];
  if (step !== expectedStep && step !== 'package') {
    throw new Error(`质量验收平台只能读取对应成稿步骤或全平台内容包，${platform} 不允许读取 ${step}`);
  }
}

function assertProjectFilePath(file: string | undefined, platform: string) {
  if (!file) return;
  const resolved = safeResolve(PROJECT_DIR, file);
  if (!resolved) {
    throw new Error('质量验收文件必须位于当前项目目录内');
  }
  const expectedPrefix = QUALITY_STEP_PREFIX[QUALITY_PLATFORM_STEP[platform]];
  const relativePath = toProjectRelativePath(resolved).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relativePath.startsWith(expectedPrefix) && !relativePath.startsWith('pipeline/package/')) {
    throw new Error('质量验收文件只能来自对应平台成稿目录或全平台内容包：pipeline/final、pipeline/xhs、pipeline/package');
  }
}

async function runQualityCheck(body: {
  platform?: string;
  file?: string;
  step?: string;
  slug?: string;
  minScore?: number;
}) {
  const args = [
    QUALITY_SCRIPT,
    '--project',
    PROJECT_DIR,
    '--platform',
    body.platform || 'wechat',
    '--min-score',
    String(body.minScore || 72),
  ];
  if (body.file) args.push('--file', body.file);
  if (body.step) args.push('--step', body.step);
  if (body.slug) args.push('--slug', body.slug);

  try {
    const { stdout, stderr } = await execFileAsync(runtimePythonBinary(), args, {
      cwd: PROJECT_DIR,
      maxBuffer: 1024 * 1024 * 12,
      timeout: 120000,
    });
    return { result: normalizeResult(JSON.parse(stdout) as QualityResult), stderr };
  } catch (error) {
    const maybe = error as { stdout?: string; stderr?: string; message?: string };
    if (maybe.stdout) {
      try {
        return { result: normalizeResult(JSON.parse(maybe.stdout) as QualityResult), stderr: maybe.stderr || '' };
      } catch {
        // fall through to error response
      }
    }
    if (maybe.stderr) {
      try {
        const payload = JSON.parse(maybe.stderr) as { error?: string };
        if (payload.error) {
          return {
            result: {
              status: 'blocked',
              gate_status: 'blocked',
              delivery_audit_status: 'blocked',
              platform: body.platform || 'wechat',
              error: payload.error,
            },
            stderr: maybe.stderr,
          };
        }
      } catch {
        // fall through to error response
      }
    }
    throw new Error(maybe.stderr || maybe.message || '质量验收失败');
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const platform = normalizeQualityPlatform(assertOptionalTextInput(rawBody.platform, '质量验收平台', MAX_SHORT_TEXT_BYTES));
    const body = {
      platform,
      file: assertOptionalTextInput(rawBody.file, '质量验收文件', MAX_SHORT_TEXT_BYTES),
      step: assertOptionalTextInput(rawBody.step, '质量验收步骤', MAX_SHORT_TEXT_BYTES),
      slug: assertOptionalTextInput(rawBody.slug, 'Slug', MAX_SHORT_TEXT_BYTES),
      minScore: typeof rawBody.minScore === 'number' ? rawBody.minScore : undefined,
    };
    assertQualityStep(body.step, platform);
    assertProjectFilePath(body.file, platform);
    const quality = await runQualityCheck(body);
    const result = quality.result.error
      ? { ...quality.result, error: '内容检查未通过，请根据检查项修改后再试。' }
      : quality.result;
    return NextResponse.json(redactLocalPaths({
      status: result.status || 'unknown',
      result,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '质量验收失败';
    const status = error instanceof InputLimitError || message.includes('项目目录内') || message.includes('成稿目录') || message.includes('质量验收平台') ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法完成内容检查，请重试。',
      code: 'content_quality_check_failed',
      status,
    });
  }
}

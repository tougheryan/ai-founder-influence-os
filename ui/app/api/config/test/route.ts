import { NextRequest, NextResponse } from 'next/server';
import { createLLMTextCompletion, getModel, validateLLMConfig } from '@/lib/llm-client';
import { resolveServerLLMConfig } from '@/lib/server-config';
import type { LLMConfig } from '@/lib/types';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';
import { beginModelConnectionRecord, finishModelConnectionRecord, readModelConnectionRecord } from '@/lib/model-connection-records';
import { ensureProjectInitialized } from '@/lib/project-init';

export async function GET() {
  try {
    await ensureProjectInitialized();
    return NextResponse.json(await readModelConnectionRecord(await resolveServerLLMConfig({})), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return userFacingErrorResponse(error, { error: '暂时无法读取上次连接测试记录。', code: 'model_connection_record_unavailable', status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let record: Awaited<ReturnType<typeof beginModelConnectionRecord>> | undefined;
  try {
    await ensureProjectInitialized();
    const config = await resolveServerLLMConfig((await req.json()) as Partial<LLMConfig>);
    const issues = validateLLMConfig(config);
    if (issues.length > 0) {
      const friendlyIssues = issues.map(friendlyModelSettingIssue);
      return expectedUserFacingErrorResponse({
        error: '模型设置不完整，请检查标出的项目。',
        code: 'model_settings_invalid',
        status: 400,
        extra: { ok: false, message: friendlyIssues.join(' '), issues: friendlyIssues },
      });
    }
    const model = getModel(config);

    const startedAt = Date.now();
    record = await beginModelConnectionRecord(config);
    const content = await createLLMTextCompletion(
      config,
      [
        {
          role: 'user',
          content: '请只回复 OK，用于测试 API 连接。',
        },
      ],
      {
        model,
        temperature: 0,
        maxTokens: 8,
        maxRetries: 0,
      }
    );
    if (!content.trim()) throw new Error('Model connection test returned no text');
    const receipt = await finishModelConnectionRecord(record, true).catch(() => null);

    return NextResponse.json({
      ok: true,
      model,
      latencyMs: Date.now() - startedAt,
      message: '本次短文本请求返回成功。',
      record: receipt,
      ...(receipt ? {} : { recordWarning: '连接成功，但测试记录未能保存；请先检查本机存储。' }),
    });
  } catch (error) {
    const receipt = record ? await finishModelConnectionRecord(record, false).catch(() => null) : null;
    return userFacingErrorResponse(error, {
      error: '模型连接失败，请检查模型服务、模型名称、服务地址和模型密钥。',
      code: 'model_connection_failed',
      status: 400,
      extra: { ok: false, record: receipt, requestStarted: Boolean(record) },
      legacyMessageField: 'message',
    });
  }
}

function friendlyModelSettingIssue(issue: string): string {
  return issue
    .replaceAll('Provider', '模型服务')
    .replaceAll('Model', '模型名称')
    .replaceAll('Base URL', '服务地址')
    .replaceAll('Temperature', '创意程度')
    .replaceAll('Max Tokens', '最大输出长度')
    .replaceAll('API Key', '模型密钥');
}

import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { readBrainFile, writeBrainFile } from '@/lib/brain-files';
import { assertTextInput, InputLimitError, MAX_BRAIN_CONTENT_BYTES } from '@/lib/input-limits';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';

export async function GET() {
  try {
    await ensureProjectInitialized();
    const [you, user, commands] = await Promise.all([
      readBrainFile('you').catch(() => ''),
      readBrainFile('user').catch(() => ''),
      readBrainFile('commands').catch(() => ''),
    ]);

    return NextResponse.json({ you, user, commands });
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取账号资料，请重试。',
      code: 'account_memory_read_failed',
      status: 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const { file, content } = await req.json();

    if (!['you', 'user', 'commands'].includes(file)) {
      return expectedUserFacingErrorResponse({
        error: '请选择要保存的账号资料。',
        code: 'account_memory_file_invalid',
        status: 400,
      });
    }

    const safeContent = assertTextInput(content, '记忆文件内容', MAX_BRAIN_CONTENT_BYTES);
    await writeBrainFile(file, safeContent);
    return NextResponse.json({ success: true });
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法保存账号资料，请重试。',
      code: 'account_memory_save_failed',
      status: error instanceof InputLimitError ? 400 : 500,
    });
  }
}

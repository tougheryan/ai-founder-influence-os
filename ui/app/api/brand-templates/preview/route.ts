import { NextResponse } from 'next/server';
import {
  Md2WechatThemePreviewError,
  readMd2WechatThemePreview,
} from '@/lib/md2wechat-themes';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    await ensureProjectInitialized();
    const payload = await request.json().catch(() => ({})) as { themeId?: unknown; confirmExternalCall?: unknown } | null;
    if (!payload || payload.confirmExternalCall !== true) {
      return NextResponse.json({
        error: '生成预览会请求外部排版服务，可能计费。请在费用说明旁点击生成示例预览。',
        code: 'md2wechat_preview_confirmation_required',
      }, { status: 400 });
    }
    if (typeof payload.themeId !== 'string' || !payload.themeId.trim()) {
      return NextResponse.json({
        error: '请选择一个 md2wechat 主题后再预览。',
        code: 'md2wechat_preview_theme_required',
      }, { status: 400 });
    }
    const preview = await readMd2WechatThemePreview(payload.themeId);
    return NextResponse.json(preview, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof Md2WechatThemePreviewError) {
      return NextResponse.json({
        error: error.message,
        code: 'md2wechat_preview_unavailable',
      }, { status: 422 });
    }
    return userFacingErrorResponse(error, {
      error: '排版预览没有生成成功，请重试。',
      code: 'md2wechat_preview_failed',
      status: 500,
    });
  }
}

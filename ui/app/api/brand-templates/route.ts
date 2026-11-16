import { NextResponse } from 'next/server';
import { readMd2WechatThemeCatalog } from '@/lib/md2wechat-themes';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

export async function GET() {
  try {
    await ensureProjectInitialized();
    const catalog = await readMd2WechatThemeCatalog();
    return NextResponse.json(catalog);
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取排版模板，请重试。',
      code: 'brand_templates_read_failed',
      status: 500,
    });
  }
}

export async function PUT() {
  return NextResponse.json({
    error: '排版主题由本机 md2wechat 目录管理，Echo Founder 不再维护另一套模板配置。',
    code: 'md2wechat_catalog_read_only',
  }, { status: 405, headers: { Allow: 'GET' } });
}

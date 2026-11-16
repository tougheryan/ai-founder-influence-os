import { NextResponse } from 'next/server';

/** Old clients receive a retirement response; no password or config is read. */
export async function POST() {
  return NextResponse.json({
    error: { code: 'product_password_retired', message: '当前本地版无需产品使用密码，直接进入工作台即可。' },
  }, { status: 410, headers: { 'cache-control': 'no-store' } });
}

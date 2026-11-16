import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';
import { expectedUserFacingErrorResponse } from '@/lib/user-facing-error';

const DESKTOP_CHALLENGE_HEADER = 'x-aifios-desktop-challenge';
const DESKTOP_PROOF_HEADER = 'x-aifios-desktop-proof';

export async function GET(request: Request) {
  const challenge = request.headers.get(DESKTOP_CHALLENGE_HEADER) || '';
  const secret = process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET || '';
  if (!challenge || challenge.length > 512 || !secret) {
    return expectedUserFacingErrorResponse({
      status: 403,
      error: '桌面服务验证失败。请重新打开应用。',
      code: 'desktop_auth_required',
      extra: { ok: false },
    });
  }

  const response = NextResponse.json({ ok: true, service: 'aifios-desktop' });
  response.headers.set(
    DESKTOP_PROOF_HEADER,
    createHmac('sha256', secret).update(challenge).digest('hex'),
  );
  return response;
}

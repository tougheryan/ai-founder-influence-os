import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  isHostedLicensePublicRequest,
  verifyHostedLicenseAccess,
} from '@/lib/hosted-license-access';

// Next 16 runs proxy.ts in the Node.js runtime. The paid desktop gate must
// read the package-bound bootstrap and local session, so middleware.ts (Edge)
// cannot provide this check safely in a packaged app.
export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (isHostedLicensePublicRequest(pathname, request.method)) return NextResponse.next();

  const decision = await verifyHostedLicenseAccess();
  if (decision.authorized) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        error: {
          code: 'device_activation_required',
          message: decision.message,
        },
      },
      {
        status: decision.status,
        headers: { 'cache-control': 'no-store' },
      },
    );
  }

  const activationUrl = new URL('/settings?firstRun=1', request.url);
  return NextResponse.redirect(activationUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};

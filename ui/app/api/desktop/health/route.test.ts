import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { GET } from './route';

describe('GET /api/desktop/health', () => {
  afterEach(() => {
    delete process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET;
  });

  it('does not expose a public unauthenticated health oracle', async () => {
    const response = await GET(new Request('http://127.0.0.1/api/desktop/health'));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: '桌面服务验证失败。请重新打开应用。',
      code: 'desktop_auth_required',
    });
  });

  it('proves the local service inherited the Electron process secret', async () => {
    process.env.AIFIOS_DESKTOP_SERVICE_AUTH_SECRET = 'desktop-service-secret';
    const challenge = 'fresh-random-challenge';
    const response = await GET(new Request('http://127.0.0.1/api/desktop/health', {
      headers: { 'x-aifios-desktop-challenge': challenge },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-aifios-desktop-proof')).toBe(
      createHmac('sha256', 'desktop-service-secret').update(challenge).digest('hex'),
    );
    expect(await response.json()).toEqual({ ok: true, service: 'aifios-desktop' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ render: vi.fn() }));

const preview = {
  themeId: 'wechat-native',
  html: '<!doctype html><html><body><section>预览</section></body></html>',
  renderer: 'md2wechat',
  exact: true,
};

vi.mock('@/lib/md2wechat-themes', () => ({
  Md2WechatThemePreviewError: class Md2WechatThemePreviewError extends Error {},
  readMd2WechatThemePreview: async () => { calls.render(); return preview; },
}));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));

import { POST } from './route';

describe('md2wechat theme preview API', () => {
  beforeEach(() => calls.render.mockClear());
  it.each([undefined, false, 'true', 1])('rejects an unconfirmed external call before the renderer: %s', async (confirmExternalCall) => {
    const response = await POST(new Request('http://localhost/api/brand-templates/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeId: 'wechat-native', confirmExternalCall }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'md2wechat_preview_confirmation_required' });
    expect(calls.render).not.toHaveBeenCalled();
  });
  it('renders an exact preview for one selected theme', async () => {
    const response = await POST(new Request('http://localhost/api/brand-templates/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ themeId: 'wechat-native', confirmExternalCall: true }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(preview);
  });

  it('requires an explicit theme', async () => {
    const response = await POST(new Request('http://localhost/api/brand-templates/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmExternalCall: true }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'md2wechat_preview_theme_required' });
  });
});

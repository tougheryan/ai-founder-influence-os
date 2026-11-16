import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  authorized: false,
  calls: 0,
}));

vi.mock('@/lib/hosted-license-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hosted-license-access')>()),
  verifyHostedLicenseAccess: async () => {
    mocks.calls += 1;
    return mocks.authorized
      ? { required: true, authorized: true }
      : { required: true, authorized: false, status: 401, message: 'activation required' };
  },
}));

import { config, proxy } from './proxy';
import {
  HOSTED_LICENSE_PUBLIC_REQUESTS,
  isHostedLicensePublicRequest,
} from './lib/hosted-license-access';
import {
  hostedRouteInventory,
  NEXT_ROUTE_HTTP_METHODS,
} from './lib/hosted-route-inventory';

const EXPECTED_PUBLIC_HOSTED_REQUESTS = [
  'GET /settings',
  'HEAD /settings',
  'GET /api/config',
  'GET /api/config/hosted/status',
  'POST /api/config/hosted/activate',
  'GET /api/desktop/health',
] as const;

const PUBLIC_HOSTED_REQUESTS = new Set<string>(EXPECTED_PUBLIC_HOSTED_REQUESTS);

async function responseFor(method: string, pathname: string) {
  return proxy(new NextRequest(`http://127.0.0.1:3210${pathname}`, { method }));
}

describe('hosted desktop global license proxy', () => {
  beforeEach(() => {
    mocks.authorized = false;
    mocks.calls = 0;
  });

  it.each([
    ['GET', '/settings?firstRun=1'],
    ['HEAD', '/settings'],
    ['GET', '/api/config'],
    ['POST', '/api/config/hosted/activate'],
    ['GET', '/api/config/hosted/status'],
    ['GET', '/api/desktop/health'],
  ])('keeps only activation bootstrap request public: %s %s', async (method, path) => {
    const response = await responseFor(method, path);

    expect(response.status).toBe(200);
    expect(mocks.calls).toBe(0);
  });

  it('keeps the public whitelist exact and auditable', () => {
    expect(HOSTED_LICENSE_PUBLIC_REQUESTS.map(({ method, pathname }) => `${method} ${pathname}`))
      .toEqual(EXPECTED_PUBLIC_HOSTED_REQUESTS);

    for (const request of EXPECTED_PUBLIC_HOSTED_REQUESTS) {
      const separator = request.indexOf(' ');
      expect(isHostedLicensePublicRequest(request.slice(separator + 1), request.slice(0, separator)), request).toBe(true);
    }

    const nearMisses = [
      ['get', '/settings'],
      ['GET', '/settings/'],
      ['GET', '/settings?firstRun=1'],
      ['POST', '/settings'],
      ['HEAD', '/api/config'],
      ['POST', '/api/config'],
      ['GET', '/api/config/hosted/activate'],
      ['POST', '/api/config/hosted/status'],
      ['POST', '/api/config/hosted/deactivate'],
      ['HEAD', '/api/desktop/health'],
      ['GET', '/api/desktop/health/not-a-route'],
    ] as const;
    for (const [method, pathname] of nearMisses) {
      expect(isHostedLicensePublicRequest(pathname, method), `${method} ${pathname}`).toBe(false);
    }
  });

  it('automatically redirects every method on every application page except the exact activation requests', async () => {
    const inventory = await hostedRouteInventory();
    expect(inventory.pageRoutes.map((route) => route.pathname)).toContain('/settings');

    for (const route of inventory.pageRoutes) {
      for (const method of NEXT_ROUTE_HTTP_METHODS) {
        const request = `${method} ${route.pathname}`;
        const isPublic = PUBLIC_HOSTED_REQUESTS.has(request);
        const response = await responseFor(method, route.pathname);
        expect(response.status, `${route.file} ${request}`).toBe(isPublic ? 200 : 307);
        expect(mocks.calls, `${route.file} ${request}`).toBe(isPublic ? 0 : 1);
        if (!isPublic) {
          const location = new URL(response.headers.get('location') || 'http://invalid');
          expect(location.pathname, `${route.file} ${request}`).toBe('/settings');
          expect(location.search, `${route.file} ${request}`).toBe('?firstRun=1');
        }
        mocks.calls = 0;
      }
    }
  }, 20_000);

  it('automatically rejects every method on every non-public API, including implicit HEAD and OPTIONS', async () => {
    const inventory = await hostedRouteInventory();
    expect(inventory.apiRoutes.map((route) => route.pathname)).toContain('/api/output/__aifios_catchall__/__aifios_path__');
    expect(inventory.apiRoutes.map((route) => route.pathname)).toContain('/api/production/tasks/__aifios_param__/retry');

    for (const route of inventory.apiRoutes) {
      for (const method of NEXT_ROUTE_HTTP_METHODS) {
        const request = `${method} ${route.pathname}`;
        const isPublic = PUBLIC_HOSTED_REQUESTS.has(request);
        const response = await responseFor(method, route.pathname);
        expect(response.status, `${route.file} ${request}`).toBe(isPublic ? 200 : 401);
        expect(mocks.calls, `${route.file} ${request}`).toBe(isPublic ? 0 : 1);
        if (!isPublic) {
          await expect(response.json()).resolves.toEqual({
            error: { code: 'device_activation_required', message: 'activation required' },
          });
        }
        mocks.calls = 0;
      }
    }
  }, 20_000);

  it('maps every public exception to its intended source route and exported method', async () => {
    const inventory = await hostedRouteInventory();
    const pages = new Set(inventory.pageRoutes.map((route) => route.pathname));
    const apiMethods = new Map(inventory.apiRoutes.map((route) => [route.pathname, new Set(route.methods)]));

    expect(pages.has('/settings')).toBe(true);
    for (const request of EXPECTED_PUBLIC_HOSTED_REQUESTS) {
      const separator = request.indexOf(' ');
      const method = request.slice(0, separator);
      const pathname = request.slice(separator + 1);
      if (pathname === '/settings') continue;
      expect(apiMethods.get(pathname)?.has(method), request).toBe(true);
    }
  }, 20_000);

  it('configures the Next proxy matcher to cover every inventoried page and API route', async () => {
    const inventory = await hostedRouteInventory();
    const matcher = config.matcher[0];
    const matcherPattern = new RegExp(`^${matcher}$`);

    for (const route of [...inventory.pageRoutes, ...inventory.apiRoutes]) {
      expect(matcherPattern.test(route.pathname), route.file).toBe(true);
    }
  }, 20_000);

  it('keeps the public whitelist exact by method and pathname', async () => {
    const deniedRequests = [
      ['GET', '/settings/'],
      ['POST', '/settings'],
      ['POST', '/api/config'],
      ['POST', '/api/config/hosted/status'],
      ['GET', '/api/config/hosted/activate'],
      ['POST', '/api/config/hosted/deactivate'],
      ['HEAD', '/api/desktop/health'],
      ['GET', '/api/desktop/health/not-a-route'],
    ] as const;

    for (const [method, pathname] of deniedRequests) {
      const response = await responseFor(method, pathname);
      const isApiRequest = pathname.startsWith('/api/');
      expect(response.status, `${method} ${pathname}`).toBe(isApiRequest ? 401 : 307);
      expect(mocks.calls, `${method} ${pathname}`).toBe(1);
      if (!isApiRequest) {
        const location = new URL(response.headers.get('location') || 'http://invalid');
        expect(location.pathname, `${method} ${pathname}`).toBe('/settings');
        expect(location.search, `${method} ${pathname}`).toBe('?firstRun=1');
      }
      mocks.calls = 0;
    }
  });

  it.each([
    '/',
    '/production',
    '/materials',
    '/benchmark-advisor',
    '/weekly-review',
    '/publication-desk',
  ])('redirects an unactivated direct page request: %s', async (path) => {
    const response = await proxy(new NextRequest(`http://127.0.0.1:3210${path}`));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') || 'http://invalid');
    expect(location.pathname).toBe('/settings');
    expect(location.search).toBe('?firstRun=1');
    expect(mocks.calls).toBe(1);
  });

  it.each([
    '/api/production/advance',
    '/api/materials',
    '/api/agent/invoke',
    '/api/output/private.png',
    '/api/status',
    '/api/config/test',
    '/api/settings/tikomni',
  ])('rejects an unactivated direct API request: %s', async (path) => {
    const response = await proxy(new NextRequest(`http://127.0.0.1:3210${path}`));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'device_activation_required', message: 'activation required' },
    });
    expect(mocks.calls).toBe(1);
  });

  it.each([
    ['POST', '/api/config'],
    ['POST', '/api/config/hosted/deactivate'],
    ['GET', '/api/config/hosted/activate'],
    ['POST', '/api/config/hosted/status'],
  ])('does not grant write or wrong-method access through the bootstrap whitelist: %s %s', async (method, path) => {
    const response = await proxy(new NextRequest(`http://127.0.0.1:3210${path}`, { method }));

    expect(response.status).toBe(401);
    expect(mocks.calls).toBe(1);
  });

  it('allows protected routes only after live authorization succeeds', async () => {
    mocks.authorized = true;

    const response = await proxy(new NextRequest('http://127.0.0.1:3210/production'));

    expect(response.status).toBe(200);
    expect(mocks.calls).toBe(1);
  });
});

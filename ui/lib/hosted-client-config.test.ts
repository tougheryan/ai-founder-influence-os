import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  filePayload: JSON.stringify({
    schema: 'aifios.hosted-client.v1',
    gatewayUrl: 'https://embedded.example.com',
    licenseMode: 'device-bound',
  }),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => mocks.filePayload),
}));

vi.mock('./project-root', () => ({
  INSTALL_ROOT: '/test/aifios',
  runtimeJoin: (...parts: string[]) => parts.join('/'),
}));

import { hostedLicenseRequired, readHostedClientBootstrap } from './hosted-client-config';

describe('hosted client license bootstrap', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.AIFIOS_DESKTOP_LICENSE_MODE;
    delete process.env.AIFIOS_HOSTED_GATEWAY_URL;
    delete process.env.AIFIOS_HOSTED_RESEARCH_PUBLIC_KEY;
    delete process.env.AIFIOS_HOSTED_RESEARCH_KEY_ID;
    mocks.filePayload = JSON.stringify({
      schema: 'aifios.hosted-client.v1',
      gatewayUrl: 'https://embedded.example.com',
      licenseMode: 'device-bound',
    });
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('ignores a parent-process gateway override in a paid desktop package', async () => {
    process.env.AIFIOS_DESKTOP_LICENSE_MODE = 'device-bound';
    process.env.AIFIOS_HOSTED_GATEWAY_URL = 'https://attacker.example.com';

    expect(hostedLicenseRequired()).toBe(true);
    await expect(readHostedClientBootstrap()).resolves.toMatchObject({
      gatewayUrl: 'https://embedded.example.com',
      licenseMode: 'device-bound',
    });
  });

  it('fails closed on an insecure embedded gateway in a paid package', async () => {
    process.env.AIFIOS_DESKTOP_LICENSE_MODE = 'device-bound';
    mocks.filePayload = JSON.stringify({
      schema: 'aifios.hosted-client.v1',
      gatewayUrl: 'http://gateway.example.com',
      licenseMode: 'device-bound',
    });

    await expect(readHostedClientBootstrap()).resolves.toBeNull();
  });

  it('still permits a development-only gateway override outside paid mode', async () => {
    process.env.AIFIOS_HOSTED_GATEWAY_URL = 'http://127.0.0.1:8787';

    await expect(readHostedClientBootstrap()).resolves.toMatchObject({
      gatewayUrl: 'http://127.0.0.1:8787',
    });
  });
});

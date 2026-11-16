import { readFile } from 'fs/promises';
import { INSTALL_ROOT, runtimeJoin } from './project-root';

export interface HostedClientBootstrap {
  gatewayUrl: string;
  licenseMode?: 'device-bound';
  researchPublicKey?: string;
  researchKeyId?: string;
}

function normalizeGatewayUrl(value: unknown, requireHttps = false): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (requireHttps && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function normalizeResearchPublicKey(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{40,4096}$/.test(raw) ? raw : '';
}

function normalizeResearchKeyId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._-]{1,80}$/.test(raw) ? raw : '';
}

export function hostedLicenseRequired(env = process.env): boolean {
  return env.AIFIOS_DESKTOP_LICENSE_MODE === 'device-bound';
}

export async function readHostedClientBootstrap(): Promise<HostedClientBootstrap | null> {
  const licenseRequired = hostedLicenseRequired();
  const fromEnvironment = licenseRequired ? '' : normalizeGatewayUrl(process.env.AIFIOS_HOSTED_GATEWAY_URL);
  if (fromEnvironment) {
    const researchPublicKey = normalizeResearchPublicKey(process.env.AIFIOS_HOSTED_RESEARCH_PUBLIC_KEY);
    const researchKeyId = normalizeResearchKeyId(process.env.AIFIOS_HOSTED_RESEARCH_KEY_ID);
    return {
      gatewayUrl: fromEnvironment,
      ...(researchPublicKey ? { researchPublicKey } : {}),
      ...(researchKeyId ? { researchKeyId } : {}),
    };
  }

  try {
    const file = runtimeJoin(INSTALL_ROOT, 'hosted-client.json');
    const parsed = JSON.parse(await readFile(/* turbopackIgnore: true */ file, 'utf8')) as {
      gatewayUrl?: unknown;
      licenseMode?: unknown;
      researchPublicKey?: unknown;
      researchKeyId?: unknown;
    };
    const gatewayUrl = normalizeGatewayUrl(parsed?.gatewayUrl, licenseRequired);
    const researchPublicKey = normalizeResearchPublicKey(parsed?.researchPublicKey);
    const researchKeyId = normalizeResearchKeyId(parsed?.researchKeyId);
    const licenseMode = parsed?.licenseMode === 'device-bound' ? 'device-bound' : undefined;
    if (licenseRequired && licenseMode !== 'device-bound') return null;
    return gatewayUrl ? {
      gatewayUrl,
      ...(licenseMode ? { licenseMode } : {}),
      ...(researchPublicKey ? { researchPublicKey } : {}),
      ...(researchKeyId ? { researchKeyId } : {}),
    } : null;
  } catch {
    return null;
  }
}

export function normalizeHostedGatewayUrl(value: unknown): string {
  return normalizeGatewayUrl(value);
}

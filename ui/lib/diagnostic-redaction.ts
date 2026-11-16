import { redactLocalPaths } from './project-root';


const SENSITIVE_FIELD_NAMES = new Set([
  'api_key',
  'access_token',
  'auth_token',
  'token',
  'refresh_token',
  'authorization',
  'cookie',
  'cookies',
  'password',
  'secret',
  'app_secret',
  'appsecret',
  'client_secret',
  'clientsecret',
  'credential',
  'credentials',
  'pairing_token',
  'private_key',
]);

function normalizedFieldName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isSensitiveFieldName(value: string): boolean {
  const normalized = normalizedFieldName(value);
  return SENSITIVE_FIELD_NAMES.has(normalized)
    || /(?:^|_)(?:token|secret|password|cookie|credential|private_key)$/.test(normalized);
}

export function secretRedactedString(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[secret redacted]')
    .replace(/\b([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g, '[secret redacted]')
    .replace(
      /((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer|basic)?\s*[^\s"',;]+/gi,
      '$1[secret redacted]',
    )
    .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[secret redacted]')
    .replace(
      /((?:(?:[a-z][a-z0-9]*[_-])*(?:token|secret|password|cookie|credential)|api[_-]?key|private[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi,
      '$1[secret redacted]',
    );
}

export function sanitizeSupportPayload<T>(value: T): T {
  const localPathRedacted = redactLocalPaths(value);
  if (typeof localPathRedacted === 'string') {
    return secretRedactedString(localPathRedacted) as T;
  }
  if (Array.isArray(localPathRedacted)) {
    return localPathRedacted.map((item) => sanitizeSupportPayload(item)) as T;
  }
  if (localPathRedacted && typeof localPathRedacted === 'object') {
    return Object.fromEntries(
      Object.entries(localPathRedacted).map(([key, item]) => [
        key,
        isSensitiveFieldName(key) ? '[secret redacted]' : sanitizeSupportPayload(item),
      ])
    ) as T;
  }
  return localPathRedacted;
}

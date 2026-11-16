/**
 * Browser-safe material-input identity helpers.
 *
 * The production workbench keeps the editable intake form in local storage,
 * while the analysed snapshot lives in a run-scoped server file.  This small
 * module gives both sides a stable identity for the *operator supplied*
 * input.  It intentionally excludes derived link titles/excerpts and other
 * server enrichment so a successful link parse does not look like a user
 * edit.
 */

export type MaterialInputFingerprintFile = {
  name?: unknown;
  size?: unknown;
  sourcePath?: unknown;
  path?: unknown;
  extractionStatus?: unknown;
  writingRequirements?: unknown;
};

export type MaterialInputFingerprintLink = string | {
  url?: unknown;
};

export type MaterialInputFingerprintInput = {
  rawMaterial?: unknown;
  files?: unknown;
  links?: unknown;
};

type CanonicalFile = {
  name: string;
  size?: number;
  sourcePath?: string;
  path?: string;
  extractionStatus?: string;
  writingRequirements?: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalFiles(value: unknown): CanonicalFile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const file = item as MaterialInputFingerprintFile;
    const name = asTrimmedString(file.name);
    if (!name) return [];
    const sourcePath = asTrimmedString(file.sourcePath);
    const path = asTrimmedString(file.path);
    const key = sourcePath || path || name;
    if (seen.has(key)) return [];
    seen.add(key);
    const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0
      ? Math.floor(file.size)
      : undefined;
    const extractionStatus = asTrimmedString(file.extractionStatus);
    return [{
      name,
      ...(size === undefined ? {} : { size }),
      ...(sourcePath ? { sourcePath } : {}),
      ...(path ? { path } : {}),
      ...(extractionStatus ? { extractionStatus } : {}),
      ...(file.writingRequirements === 'reference_only' ? { writingRequirements: 'reference_only' } : {}),
    }];
  });
}

function canonicalLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const url = typeof item === 'string'
      ? item.trim()
      : item && typeof item === 'object' && !Array.isArray(item)
        ? asTrimmedString((item as MaterialInputFingerprintLink & { url?: unknown }).url)
        : '';
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [url];
  });
}

/** Returns the canonical, non-sensitive payload used for fingerprinting. */
export function materialInputFingerprintPayload(input: MaterialInputFingerprintInput): string {
  return JSON.stringify({
    rawMaterial: asTrimmedString(input.rawMaterial),
    files: canonicalFiles(input.files),
    links: canonicalLinks(input.links),
  });
}

/**
 * Returns a SHA-256 fingerprint that is identical to the server-side value.
 * This is async because the browser's Web Crypto API is intentionally async.
 */
export async function createMaterialInputFingerprint(input: MaterialInputFingerprintInput): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('当前环境不支持素材快照校验。');
  const bytes = new TextEncoder().encode(materialInputFingerprintPayload(input));
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

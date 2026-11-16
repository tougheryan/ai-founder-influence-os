const encoder = new TextEncoder();

export const MAX_BRAIN_CONTENT_BYTES = 256 * 1024;
export const MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_SHORT_TEXT_BYTES = 8 * 1024;
export const MAX_AGENT_PAYLOAD_BYTES = 2 * 1024 * 1024;

export class InputLimitError extends Error {}

export function textByteLength(value: string): number {
  return encoder.encode(value).length;
}

export function assertTextInput(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') {
    throw new InputLimitError(`${label}必须是文本`);
  }
  const bytes = textByteLength(value);
  if (bytes > maxBytes) {
    throw new InputLimitError(`${label}过大，请控制在 ${Math.floor(maxBytes / 1024)}KB 以内`);
  }
  return value;
}

export function assertOptionalTextInput(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertTextInput(value, label, maxBytes);
}

export function assertJsonInputSize(value: unknown, label: string, maxBytes: number): void {
  const serialized = JSON.stringify(value ?? {});
  if (textByteLength(serialized) > maxBytes) {
    throw new InputLimitError(`${label}过大，请控制在 ${Math.floor(maxBytes / 1024)}KB 以内`);
  }
}

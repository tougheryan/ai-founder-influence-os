export type NativeXhsCopy = { title: string; body: string; question: string; tags: string; publishingBody: string; text: string };
export function readNativeXhsCopy(markdown: string): NativeXhsCopy;
export function nativeXhsCopyMatches(markdown: string, prepared: string, payload: { title?: string; metadata?: Record<string, string> }): boolean;
export const XHS_COPY_MISMATCH: string;
export function nativeFieldSpans(text: string, labels: string[]): Array<{ label: string; start: number; end: number; text: string }>;
export function readNativeField(text: string, labels: string[]): string;
export function nativePlatforms(value: string): Array<'wechat' | 'xhs' | 'shipinhao'>;

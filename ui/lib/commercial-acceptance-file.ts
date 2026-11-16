import { readFile, stat } from 'fs/promises';
import { describeAcceptance } from './commercial-acceptance-status';

const MAX_RECORD_BYTES = 2 * 1024 * 1024;

export async function readCommercialAcceptanceFile(path: string) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_RECORD_BYTES) return describeAcceptance(null, 'invalid');
    const bytes = await readFile(path);
    if (bytes.length > MAX_RECORD_BYTES) return describeAcceptance(null, 'invalid');
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return describeAcceptance(JSON.parse(text), 'read');
    } catch {
      return describeAcceptance(null, 'invalid');
    }
  } catch (error) {
    return describeAcceptance(null, (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }
}

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { PROJECT_DIR, safeResolve } from './project-root';
import type { MaterialIntakeAnalysis } from './material-analysis';

export type MaterialCorrectionRecord = {
  schema: 'echo.material-correction.v1'; run_id: string; id: string;
  previous_id: string; input_fingerprint: string; base_file_sha256: string;
  expected_fingerprint: string; created_at: string; analysis: MaterialIntakeAnalysis;
};
export type MaterialCorrectionPointer = { id: string; path: string; sha256: string };
export const correctionDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export async function readMaterialRecord(path: string): Promise<string> {
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('素材记录路径不正确。');
  for (let i = 1; i <= parts.length; i++) {
    const absolute = safeResolve(PROJECT_DIR, parts.slice(0, i).join('/'));
    if (!absolute) throw new Error('素材记录路径不正确。');
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || (i < parts.length ? !info.isDirectory() : !info.isFile())) throw new Error('素材记录不能经过符号链接。');
    if (i === parts.length && info.size > 1024 * 1024) throw new Error('素材记录过大。');
  }
  return readFile(safeResolve(PROJECT_DIR, path)!, 'utf8');
}

export function materialCorrectionPath(runId: string, id: string): string {
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId) || !/^correction_[a-f0-9]{32}$/.test(id)) throw new Error('素材修正编号不正确。');
  return `runs/${runId}/material-corrections/${id}.json`;
}

export async function readMaterialCorrection(runId: string, id: string, pointer?: MaterialCorrectionPointer): Promise<MaterialCorrectionRecord> {
  const path = materialCorrectionPath(runId, id);
  const raw = await readMaterialRecord(path);
  const record = JSON.parse(raw) as MaterialCorrectionRecord;
  if (record.schema !== 'echo.material-correction.v1' || record.run_id !== runId || record.id !== id
    || (pointer && (pointer.id !== id || pointer.path !== path || pointer.sha256 !== correctionDigest(raw)))) throw new Error('素材修正记录无法核对，请重新读取。');
  return record;
}

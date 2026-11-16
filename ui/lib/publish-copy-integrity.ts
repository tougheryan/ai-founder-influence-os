import 'server-only';
import { secureReadProjectFile } from '@/electron/publication-authority.cjs';
import { nativeXhsCopyMatches, XHS_COPY_MISMATCH } from '@/electron/native-xhs-copy.cjs';
import { PROJECT_DIR } from './project-root';
import type { DraftQueue } from './publish/draft-queue';

/** Verify the exact public text file, not a second rendering of the source package. */
export async function verifyNativeXhsQueueCopy(queue: DraftQueue): Promise<void> {
  if (!queue.target_platforms?.includes('xiaohongshu')) return;
  const jobs = queue.jobs.filter((job) => job.platform === 'xiaohongshu');
  if (jobs.length !== 1 || !jobs[0].payload.copy_path) throw new Error(XHS_COPY_MISMATCH);
  const job = jobs[0];
  const source = await secureReadProjectFile(PROJECT_DIR, queue.package_path, { maxBytes: 8 * 1024 * 1024 });
  const prepared = await secureReadProjectFile(PROJECT_DIR, job.payload.copy_path!, { maxBytes: 8 * 1024 * 1024 });
  if (source.sha256 !== queue.package_sha256 || prepared.sha256 !== job.content_hash
    || !nativeXhsCopyMatches(source.buffer.toString('utf8'), prepared.buffer.toString('utf8'), job.payload)) throw new Error(XHS_COPY_MISMATCH);
  for (const [path, hash] of [[queue.package_path, source.sha256], [job.payload.copy_path!, prepared.sha256]]) {
    if ((await secureReadProjectFile(PROJECT_DIR, path, { maxBytes: 8 * 1024 * 1024 })).sha256 !== hash) throw new Error(XHS_COPY_MISMATCH);
  }
}

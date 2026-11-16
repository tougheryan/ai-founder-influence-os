import type { ContentPlanStatus } from './content-plan';
import { writingBriefFromBlueprint, type WritingBrief } from './writing-brief';

export type ContentPlanComparison = {
  status: ContentPlanStatus;
  current: WritingBrief | null;
  source: WritingBrief | null;
  currentError: string;
  sourceError: string;
};

type Input = { runId: string; packagePath: string; blueprintPath: string };

/** Read the exact recorded plan versions. Never infer an old plan from file order. */
export async function readContentPlanComparison(
  input: Input,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ContentPlanComparison> {
  const response = await request(`/api/production/content-plan?runId=${encodeURIComponent(input.runId)}`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('暂时无法核对稿件版本，请重试。');
  const status: ContentPlanStatus = await response.json();
  if (status.package_path !== input.packagePath || status.blueprint_path !== input.blueprintPath) {
    throw new Error('正文或方案已更新，请刷新本期进度后再对照。');
  }

  async function readBrief(path: string | undefined, sha256: string | undefined): Promise<WritingBrief> {
    if (!path || !/^pipeline\/blueprint\/[^/\\\s]+\.md$/.test(path) || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('没有可核对的方案版本记录。');
    }
    const result = await request(`/api/output/${path.split('/').map(encodeURIComponent).join('/')}`, { signal, cache: 'no-store' });
    if (!result.ok) throw new Error('方案文件暂时无法读取。');
    const payload = await result.json();
    if (typeof payload.content !== 'string') throw new Error('方案文件暂时无法读取。');
    const bytes = new TextEncoder().encode(payload.content);
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== sha256) throw new Error('方案文件已变化，无法作为当时的版本展示。请刷新后再核对。');
    return writingBriefFromBlueprint(payload.content);
  }

  const currentRead = readBrief(status.blueprint_path, status.blueprint_sha256);
  const sameVersion = status.source_blueprint_path === status.blueprint_path && status.source_blueprint_sha256 === status.blueprint_sha256;
  const [current, source] = await Promise.allSettled([
    currentRead,
    sameVersion ? currentRead : readBrief(status.source_blueprint_path, status.source_blueprint_sha256),
  ]);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return {
    status,
    current: current.status === 'fulfilled' ? current.value : null,
    source: source.status === 'fulfilled' ? source.value : null,
    currentError: current.status === 'rejected' ? '当前方案未能通过版本核对，请刷新本期进度后重试。' : '',
    sourceError: source.status === 'rejected' ? '这稿使用的方案未能通过版本核对，无法可靠展示旧方案。已有正文仍可阅读。' : '',
  };
}

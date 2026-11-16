import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: {} as Record<string, unknown>,
  authorSource: {} as Record<string, unknown>,
}));
vi.mock('./runtime-writer', () => ({ verifyRuntimeAuthorSource: async () => mocks.authorSource }));

vi.mock('./runtime-run-resolver', () => ({
  runtimeRunById: async () => mocks.run,
}));

import { assertProductionTaskRunAuthority } from './production-task-authority';

function task(kind: 'topic-blueprint' | 'content-package' | 'visual-candidates' | 'draft-queue', request: Record<string, unknown>) {
  return { runId: 'run-a', kind, request, result: {} };
}

describe('production task runtime authority', () => {
  beforeEach(() => {
    mocks.authorSource = { author_evidence_path: 'runs/run-a/author-evidence/author_a.json', author_evidence_sha256: 'a'.repeat(64), topic: '当前主题' };
    mocks.run = {
      run_id: 'run-a',
      slug: 'slug-a',
      topic: '当前主题',
      steps: {
        intake: { latest: 'pipeline/intake/slug-a.md' },
        blueprint: { latest: 'pipeline/blueprint/slug-a.md' },
        package: { latest: 'pipeline/package/slug-a.md' },
      },
    };
  });

  it('rejects a resumed author task after its material source or topic was replaced', async () => {
    const subject = { runId: 'run-a', kind: 'author-blueprint' as const, request: { slug: 'slug-a', topic: '当前主题' }, result: { materialResearch: { intakePath: 'pipeline/intake/slug-a.md' }, topicBlueprint: { topic: '当前主题', runSlug: 'slug-a', authorSource: { ...mocks.authorSource } } } };
    await expect(assertProductionTaskRunAuthority(subject)).resolves.toMatchObject({ run_id: 'run-a' });
    mocks.authorSource.author_evidence_sha256 = 'b'.repeat(64);
    await expect(assertProductionTaskRunAuthority(subject)).rejects.toThrow('作者素材版本');
  });

  it('rejects a task for run A when its source artifact belongs to run B', async () => {
    await expect(assertProductionTaskRunAuthority(task('content-package', {
      slug: 'slug-a',
      topic: '当前主题',
      blueprintPath: 'pipeline/blueprint/slug-b.md',
    }))).rejects.toThrow('不属于任务绑定的当前 run');
  });

  it('rejects a cross-run slug even when the package path is current', async () => {
    await expect(assertProductionTaskRunAuthority(task('visual-candidates', {
      slug: 'slug-b',
      packagePath: 'pipeline/package/slug-a.md',
    }))).rejects.toThrow('任务 slug');
  });

  it('accepts a content task only when run, slug, topic, and latest blueprint all agree', async () => {
    await expect(assertProductionTaskRunAuthority(task('content-package', {
      slug: 'slug-a',
      topic: '当前主题',
      blueprintPath: 'pipeline/blueprint/slug-a.md',
    }))).resolves.toMatchObject({ run_id: 'run-a', slug: 'slug-a' });
  });

  it('rejects a recovered draft task whose saved queue points to another run', async () => {
    const subject = task('draft-queue', { packagePath: 'pipeline/package/slug-a.md' });
    subject.result = {
      draftQueue: {
        draftQueuePath: 'materials/publication/drafts/slug-a/draft-queue.json',
        draftQueue: { run_id: 'run-b', run_slug: 'slug-a', package_path: 'pipeline/package/slug-a.md' },
      },
    };
    await expect(assertProductionTaskRunAuthority(subject)).rejects.toThrow('草稿队列 run ID');
  });
});

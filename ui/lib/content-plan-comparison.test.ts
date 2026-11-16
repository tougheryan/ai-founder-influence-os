import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readContentPlanComparison } from './content-plan-comparison';

const source = '- 目标受众：小团队负责人\n- 核心观点：先记录问题\n- 内容结构：解释原因，再给方法\n- 结尾：提出一个问题';
const current = source.replace('提出一个问题', '只留一句陈述');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const input = { runId: 'run-one', packagePath: 'pipeline/package/article.md', blueprintPath: 'pipeline/blueprint/current.md' };
const status = {
  status: 'outdated', reason: '方案更新了，旧稿尚未同步', package_path: input.packagePath,
  blueprint_path: input.blueprintPath, blueprint_sha256: sha(current),
  source_blueprint_path: 'pipeline/blueprint/source.md', source_blueprint_sha256: sha(source),
};
function fixture(overrides = {}, files: Record<string, string> = {}) {
  const responses: Record<string, unknown> = {
    '/api/production/content-plan?runId=run-one': { ...status, ...overrides },
    '/api/output/pipeline/blueprint/current.md': { content: current },
    '/api/output/pipeline/blueprint/source.md': { content: source },
    ...Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content }])),
  };
  return vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(responses[String(url)] ?? { error: 'missing' }), { status: responses[String(url)] ? 200 : 404 }));
}

describe('read-only plan comparison', () => {
  it('compares the versions actually bound to the article using only GET requests', async () => {
    const request = fixture();
    const result = await readContentPlanComparison(input, undefined, request);
    expect(result.source?.ending).toBe('提出一个问题');
    expect(result.current?.ending).toBe('只留一句陈述');
    expect(result.source?.point).toBe(result.current?.point);
    expect(result.currentError || result.sourceError).toBe('');
    expect(request.mock.calls).toHaveLength(3);
    expect(request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });
  it('rejects a status from another article or a newly replaced current plan', async () => {
    for (const overrides of [{ package_path: 'pipeline/package/other.md' }, { blueprint_path: 'pipeline/blueprint/newer.md' }]) {
      const request = fixture(overrides);
      await expect(readContentPlanComparison(input, undefined, request)).rejects.toThrow('已更新');
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
  it('does not infer an unrecorded old plan and still displays the verified current plan', async () => {
    const request = fixture({ status: 'unknown', source_blueprint_path: undefined, source_blueprint_sha256: undefined });
    const result = await readContentPlanComparison(input, undefined, request);
    expect(result.source).toBeNull();
    expect(result.sourceError).toContain('未能通过版本核对');
    expect(result.current?.ending).toBe('只留一句陈述');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('does not display a source file modified in place as the historical plan', async () => {
    const request = fixture({}, { '/api/output/pipeline/blueprint/source.md': current });
    const result = await readContentPlanComparison(input, undefined, request);
    expect(result.source).toBeNull();
    expect(result.current).not.toBeNull();
  });
  it('does not display a changed current file or follow an unsafe source path', async () => {
    const request = fixture({ source_blueprint_path: '../settings.json' }, { '/api/output/pipeline/blueprint/current.md': source });
    const result = await readContentPlanComparison(input, undefined, request);
    expect(result.source).toBeNull();
    expect(result.current).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('reads a shared unchanged version once', async () => {
    const request = fixture({ status: 'current', source_blueprint_path: status.blueprint_path, source_blueprint_sha256: status.blueprint_sha256 });
    const result = await readContentPlanComparison(input, undefined, request);
    expect(result.source).toEqual(result.current);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects a result after navigating away even if the transport ignores abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readContentPlanComparison(input, controller.signal, fixture())).rejects.toMatchObject({ name: 'AbortError' });
  });
});

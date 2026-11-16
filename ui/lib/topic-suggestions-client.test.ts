import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSavedTopicSuggestions } from './topic-suggestions-client';

const binding = { runId: 'run-a', snapshotPath: 'runs/run-a/market-research/one/snapshot.json', snapshotSha256: 'a'.repeat(64) };
const suggestion = { id: 'one', title: '客户要求修改时，先确认交付范围', reason: '依据原文', audience: '服务团队负责人', materialEvidence: '原文：先确认交付范围' };
afterEach(() => vi.unstubAllGlobals());

describe('restoring material-bound topic suggestions', () => {
  it('reads only the bound saved snapshot and preserves source evidence and audience', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ suggestions: [suggestion] }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    expect(await readSavedTopicSuggestions(binding, controller.signal)).toEqual([{
      id: 'one', title: suggestion.title, rationale: suggestion.reason,
      audience: suggestion.audience, evidence: [suggestion.materialEvidence],
    }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/research/topic-suggestions');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ mode: 'retrieve', ...binding });
    expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it('rejects a response that arrives after leaving the task, even if transport ignored abort', async () => {
    let complete!: (value: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const pending = readSavedTopicSuggestions(binding, controller.signal);
    controller.abort();
    complete(Response.json({ suggestions: [suggestion] }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('never replaces a retrieval failure with a request to collect new data', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'private path or provider detail' }, { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(readSavedTopicSuggestions(binding, new AbortController().signal)).rejects.toThrow('不会重新采集');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('allows an empty recommendation set and rejects ambiguous or oversized sets', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json({ suggestions: [] }));
    expect(await readSavedTopicSuggestions(binding, new AbortController().signal)).toEqual([]);
    fetcher.mockResolvedValueOnce(Response.json({}));
    await expect(readSavedTopicSuggestions(binding, new AbortController().signal)).rejects.toThrow('无法读取');
    for (const suggestions of [[suggestion, suggestion], [{ title: 'missing id' }], Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}`, title: `title-${i}` }))]) {
      fetcher.mockResolvedValueOnce(Response.json({ suggestions }));
      await expect(readSavedTopicSuggestions(binding, new AbortController().signal)).rejects.toThrow('无法读取');
    }
  });
});

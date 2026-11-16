import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutcomeNote, ProductionOutcome, ProductionOutcomes as OutcomesResponse } from '@/lib/production-outcome-types';

// The repository uses node + React SSR, without a DOM test dependency. This
// runner invokes the real component handlers and effects; it deliberately does
// not emulate DOM events/layout or replace browser acceptance.
type Element = ReactElement<Record<string, unknown>>;
type Effect = { deps: readonly unknown[] | undefined; cleanup?: () => void };
let active: HookRunner | null = null;
class HookRunner {
  slots: unknown[] = [];
  cursor = 0;
  effects: Array<() => void> = [];
  tree: ReactNode;
  constructor(private component: () => ReactNode) {}
  render() {
    this.cursor = 0;
    const previous = active;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- The mocked hook dispatcher needs the current runner instance.
    active = this;
    try { this.tree = this.component(); } finally { active = previous; }
    this.effects.splice(0).forEach((effect) => effect());
    return this.tree;
  }
  state(initial: unknown) {
    const index = this.cursor++;
    if (!(index in this.slots)) this.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [this.slots[index], (update: unknown) => { this.slots[index] = typeof update === 'function' ? update(this.slots[index]) : update; }];
  }
  ref(initial: unknown) {
    const index = this.cursor++;
    if (!(index in this.slots)) this.slots[index] = { current: initial };
    return this.slots[index];
  }
  effect(create: () => void | (() => void), deps?: readonly unknown[]) {
    const index = this.cursor++;
    const previous = this.slots[index] as Effect | undefined;
    if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, at) => Object.is(value, previous.deps![at]))) return;
    const effect: Effect = { deps }; this.slots[index] = effect;
    this.effects.push(() => { previous?.cleanup?.(); effect.cleanup = create() || undefined; });
  }
  dispose() { this.slots.forEach((slot) => { if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as Effect).cleanup?.(); }); }
}
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return { ...react,
    useState: (value: unknown) => active ? active.state(value) : react.useState(value),
    useRef: (value: unknown) => active ? active.ref(value) : react.useRef(value),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => active ? active.effect(effect, deps) : react.useEffect(effect, deps),
    useCallback: <T,>(callback: T) => callback,
  };
});
import { OutcomeActions, OutcomeSummary, ProductionOutcomes } from './ProductionOutcomes';
import { OutputDownloadLink } from '@/components/OutputDownloadLink';

const INPUT_HASH = 'a'.repeat(64);
const emptyNote = (changes: Partial<OutcomeNote> = {}): OutcomeNote => ({ version: 0, minutesSpent: null, reusedPreviousWork: null, note: '', updatedAt: '', completions: [], ...changes });
const outcome = (changes: Partial<ProductionOutcome> = {}): ProductionOutcome => ({
  runId: 'run-a', title: '把需求说清楚', platforms: ['wechat'], updatedAt: '2026-09-20T08:00:00Z', snapshot: INPUT_HASH,
  content: { path: 'pipeline/package/example.md', sha256: 'b'.repeat(64) }, contentConfirmed: false,
  deliverables: { path: 'pipeline/draft/example.md', sha256: 'c'.repeat(64) }, deliverablesConfirmed: false,
  publicationRecords: 0, downloads: { count: 0, latestAt: '' }, note: emptyNote(), currentCompletion: null,
  modelCalls: 0, warnings: [], ...changes,
});
const response = (item: ProductionOutcome): OutcomesResponse => ({ items: [item], total: 1, offset: 0, limit: 20, unreadable: 0 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' && 'props' in node ? text((node as Element).props.children as ReactNode) : '';
}
function find(runner: HookRunner, predicate: (element: Element) => boolean): Element {
  const result = elements(runner.tree).find(predicate);
  if (!result) throw new Error('Expected component control was not rendered');
  return result;
}
function input(runner: HookRunner, label: string) { return find(runner, (element) => element.props['aria-label'] === label); }
function button(runner: HookRunner, label: string) { return find(runner, (element) => element.type === 'button' && text(element.props.children as ReactNode) === label); }
function change(runner: HookRunner, label: string, value: string) {
  (input(runner, label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); runner.render();
}
async function settle(runner: HookRunner) { await vi.runAllTimersAsync(); await Promise.resolve(); runner.render(); }
const hosts: HookRunner[] = [];
async function mountList(item: ProductionOutcome | ProductionOutcome[], fetch: ReturnType<typeof vi.fn>) {
  const items = Array.isArray(item) ? item : [item];
  fetch.mockResolvedValueOnce(json({ ...response(items[0]), items, total: items.length }));
  const list = new HookRunner(ProductionOutcomes); hosts.push(list); list.render(); await settle(list);
  const detail = (runId = items[0].runId) => {
    const readNode = () => find(list, (element) => typeof element.type === 'function' && element.type.name === 'OutcomeDetail' && (element.props.item as ProductionOutcome).runId === runId);
    // Parent updates supply new props to the same mounted detail. Tests below
    // separately check the React key to distinguish this from a full remount.
    const host = new HookRunner(() => { const node = readNode(); return (node.type as (props: Record<string, unknown>) => ReactNode)(node.props); });
    hosts.push(host); host.render(); return host;
  };
  return { list, detail };
}
function summaryItem(list: HookRunner, runId: string): ProductionOutcome {
  return find(list, (element) => element.type === OutcomeSummary && (element.props.item as ProductionOutcome).runId === runId).props.item as ProductionOutcome;
}
function rowKeys(list: HookRunner) { return elements(list.tree).filter((element) => element.type === 'article').map((element) => element.key); }
function recorded(detail: HookRunner) { (find(detail, (element) => element.type === OutputDownloadLink).props.onRecorded as () => void)(); }
async function submit(runner: HookRunner) {
  const preventDefault = vi.fn();
  (find(runner, (element) => element.type === 'form').props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce(); runner.render(); await settle(runner);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { hosts.splice(0).forEach((host) => host.dispose()); active = null; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('production outcomes distinguish evidence from an outcome claim', () => {
  it('applies the submitted search to the full list, resets the page and keeps controls on an empty result', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { list } = await mountList(outcome(), fetch);
    change(list, '搜索文章', ' 客户报价 ');
    change(list, '筛选文章状态', 'ready');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(json({ items: [], total: 0, offset: 0, limit: 20, unreadable: 0 }));
    await submit(list);
    const params = new URL(fetch.mock.calls.at(-1)![0], 'http://localhost').searchParams;
    expect(Object.fromEntries(params)).toEqual({ offset: '0', query: '客户报价', filter: 'ready' });
    expect(text(list.tree)).toContain('没有找到符合条件的文章');
    expect(text(list.tree)).not.toContain('还没有可核对的制作记录');
    expect(input(list, '搜索文章').props.value).toBe(' 客户报价 ');
    fetch.mockResolvedValueOnce(json(response(outcome())));
    (button(list, '清除搜索和筛选').props.onClick as () => void)(); list.render(); await settle(list);
    expect(input(list, '搜索文章').props.value).toBe('');
    expect(rowKeys(list)).toHaveLength(1);
  });

  it('ignores a late result from a replaced search and preserves input on failure', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { list } = await mountList(outcome(), fetch);
    let finishOld!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }));
    change(list, '搜索文章', '旧关键词');
    await submit(list);
    const oldSignal = fetch.mock.calls.at(-1)![1].signal as AbortSignal;
    fetch.mockResolvedValueOnce(json({ error: '读取失败，请重试。' }, 503));
    change(list, '搜索文章', '新关键词'); await submit(list);
    expect(oldSignal.aborted).toBe(true);
    finishOld(json(response(outcome({ title: '迟到的旧结果' })))); await settle(list);
    expect(rowKeys(list)).toHaveLength(0);
    expect(input(list, '搜索文章').props.value).toBe('新关键词');
    expect(text(list.tree)).toContain('读取失败');
    expect(text(list.tree)).not.toContain('没有找到符合条件');
  });

  it.each([
    { changes: { content: null, contentConfirmed: false, deliverables: null }, label: '继续这篇', stage: '1' },
    { changes: { contentConfirmed: false, deliverables: null }, label: '看稿与修改', stage: '3' },
    { changes: { contentConfirmed: true, deliverables: null }, label: '继续排版', stage: '4' },
    { changes: {}, label: '查看成品', stage: '5' },
  ])('offers $label outside the feedback disclosure and returns to the saved draft', ({ changes, label, stage }) => {
    const item = outcome({ ...changes, draftId: 'draft_saved_2' });
    const tree = OutcomeActions({ item });
    const html = renderToStaticMarkup(tree);
    expect(html).not.toContain('<details');
    const primary = elements(tree).find((element) => element.type === 'a' && text(element.props.children as ReactNode) === label)!;
    const url = new URL(String(primary.props.href), 'http://localhost');
    expect(url.searchParams.get('openDraft')).toBe('draft_saved_2');
    expect(url.searchParams.get('stage')).toBe(stage);
  });
  it('does not ask for deliverable review before any deliverable exists, and keeps the saved next action visible', async () => {
    const item = outcome({ content: null, deliverables: null, progress: { label: '等你完成模型连接', nextStep: '连接后回到这份草稿继续。' } });
    const html = renderToStaticMarkup(<OutcomeSummary item={item} />);
    expect(html).toContain('尚未生成成品');
    expect(html).not.toContain('成品待核对');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { list } = await mountList(item, fetch);
    expect(text(list.tree)).toContain('等你完成模型连接');
    expect(text(list.tree)).toContain('连接后回到这份草稿继续。');
  });
  it.each([
    [null, '暂时无法核对'], [{ count: 0, latestAt: '' }, '尚无下载操作记录'], [{ count: 3, latestAt: '2026-09-20T08:00:00Z' }, '已发起 3 次下载'],
  ] as const)('keeps unknown, zero and actual download clicks distinct: %j', (downloads, expected) => {
    const html = renderToStaticMarkup(<OutcomeSummary item={outcome({ downloads })} />);
    expect(html).toContain(expected); expect(html).not.toMatch(/下载成功|已落盘|本次制作已完成/);
  });

  it('offers completion only after current deliverables are confirmed, and sends the exact run/version on a click', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const contentConfirmed of [false, true]) {
      const { detail } = await mountList(outcome({ contentConfirmed }), fetch);
      expect(elements(detail().tree).some((element) => element.type === 'button' && text(element.props.children as ReactNode).includes('本次制作完成'))).toBe(false);
    }
    const { detail } = await mountList(outcome({ contentConfirmed: true, deliverablesConfirmed: true }), fetch);
    const confirmed = detail();
    fetch.mockResolvedValueOnce(json({ note: emptyNote({ version: 1 }) }));
    (button(confirmed, '本次制作完成，暂不发布').props.onClick as () => void)(); await settle(confirmed);
    const [, init] = fetch.mock.calls.at(-1)!;
    expect(JSON.parse(init.body)).toEqual({ runId: 'run-a', snapshot: INPUT_HASH, expectedVersion: 0, action: 'complete' });
    expect(text(confirmed.tree)).toContain('发布结果可以以后补');
  });

  it('refreshes only the downloaded run count without replacing other fields or remounting unsaved forms', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const first = outcome(); const second = outcome({ runId: 'run-b', title: '另一篇', downloads: { count: 7, latestAt: '' } });
    const mounted = await mountList([first, second], fetch); const current = mounted.detail(); const other = mounted.detail('run-b');
    change(current, '实际投入分钟：把需求说清楚', '27'); change(current, '使用感受：把需求说清楚', '尚未保存的感受');
    change(other, '实际投入分钟：另一篇', '13');
    const beforeKeys = rowKeys(mounted.list);
    fetch.mockResolvedValueOnce(json({ item: { ...first, downloads: { count: 1, latestAt: '2026-09-20T08:30:00Z' }, snapshot: 'd'.repeat(64), note: emptyNote({ version: 99, minutesSpent: 100 }) } }));
    recorded(current); await settle(mounted.list); current.render(); other.render();
    const requested = new URL(String(fetch.mock.calls.at(-1)![0]), 'http://localhost');
    expect(requested.searchParams.get('runId')).toBe('run-a'); expect(requested.searchParams.has('offset')).toBe(false);
    expect(summaryItem(mounted.list, 'run-a')).toEqual({ ...first, downloads: { count: 1, latestAt: '2026-09-20T08:30:00Z' } });
    expect(summaryItem(mounted.list, 'run-b')).toEqual(second); expect(rowKeys(mounted.list)).toEqual(beforeKeys);
    expect(input(current, '实际投入分钟：把需求说清楚').props.value).toBe('27');
    expect(input(current, '使用感受：把需求说清楚').props.value).toBe('尚未保存的感受');
    expect(input(other, '实际投入分钟：另一篇').props.value).toBe('13');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores another run returned for a download and preserves form input when the count read fails', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const first = outcome(); const second = outcome({ runId: 'run-b', title: '另一篇' });
    const mounted = await mountList([first, second], fetch); const current = mounted.detail();
    change(current, '实际投入分钟：把需求说清楚', '41'); change(current, '使用感受：把需求说清楚', '需要保留这段填写');
    const keys = rowKeys(mounted.list);
    for (const result of [
      () => fetch.mockResolvedValueOnce(json({ item: { ...second, downloads: { count: 99, latestAt: '' } } })),
      () => fetch.mockResolvedValueOnce(json({ error: '记录暂时不可读' }, 500)),
      () => fetch.mockRejectedValueOnce(new Error('network unavailable')),
    ]) {
      result(); recorded(current); await settle(mounted.list); current.render();
      expect(summaryItem(mounted.list, 'run-a')).toEqual(first); expect(summaryItem(mounted.list, 'run-b')).toEqual(second);
      expect(rowKeys(mounted.list)).toEqual(keys);
      expect(input(current, '实际投入分钟：把需求说清楚').props.value).toBe('41');
      expect(input(current, '使用感受：把需求说清楚').props.value).toBe('需要保留这段填写');
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('updates completion inline for the matching version while retaining both rows and unsaved effort', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const item = outcome({ contentConfirmed: true, deliverablesConfirmed: true });
    const otherItem = outcome({ runId: 'run-b', title: '另一篇' });
    const mounted = await mountList([item, otherItem], fetch); const current = mounted.detail(); const other = mounted.detail('run-b');
    change(current, '实际投入分钟：把需求说清楚', '23'); change(current, '复用情况：把需求说清楚', 'true'); change(current, '使用感受：把需求说清楚', '制作完成后仍要保存这段感受');
    change(other, '使用感受：另一篇', '另一篇的输入也保留');
    const keys = rowKeys(mounted.list);
    const completion = { id: 'completion_a', recordedAt: '2026-09-20T09:00:00Z', content: item.content!, deliverables: item.deliverables! };
    const saved = emptyNote({ version: 1, completions: [completion] });
    fetch.mockResolvedValueOnce(json({ note: saved }));
    (button(current, '本次制作完成，暂不发布').props.onClick as () => void)(); await settle(current);
    mounted.list.render(); current.render(); other.render();
    expect(rowKeys(mounted.list)).toEqual(keys); expect(fetch).toHaveBeenCalledTimes(2);
    expect(summaryItem(mounted.list, 'run-a').currentCompletion).toEqual(completion);
    expect(summaryItem(mounted.list, 'run-b')).toEqual(otherItem);
    expect(elements(current.tree).some((element) => element.type === 'button' && text(element.props.children as ReactNode) === '本次制作完成，暂不发布')).toBe(false);
    expect(input(current, '实际投入分钟：把需求说清楚').props.value).toBe('23');
    expect(input(current, '复用情况：把需求说清楚').props.value).toBe('true');
    expect(input(current, '使用感受：把需求说清楚').props.value).toBe('制作完成后仍要保存这段感受');
    expect(input(other, '使用感受：另一篇').props.value).toBe('另一篇的输入也保留');
    fetch.mockResolvedValueOnce(json({ note: { ...saved, version: 2, minutesSpent: 23 } })); await submit(current);
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toMatchObject({ action: 'save-note', expectedVersion: 1, minutesSpent: 23, reusedPreviousWork: true, note: '制作完成后仍要保存这段感受' });
  });

  it('does not call an old completion record proof that the current content version is complete', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const item = outcome({ contentConfirmed: true, deliverablesConfirmed: true });
    const mounted = await mountList(item, fetch); const current = mounted.detail();
    fetch.mockResolvedValueOnce(json({ note: emptyNote({ version: 1, completions: [{ id: 'old_version', recordedAt: '2026-09-20T09:00:00Z', content: { ...item.content!, sha256: 'e'.repeat(64) }, deliverables: item.deliverables! }] }) }));
    (button(current, '本次制作完成，暂不发布').props.onClick as () => void)(); await settle(current); mounted.list.render(); current.render();
    expect(summaryItem(mounted.list, 'run-a').currentCompletion).toBeNull();
    expect(button(current, '本次制作完成，暂不发布')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('saves explicitly entered zero and an empty value as different values and adopts the returned note version', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { detail } = await mountList(outcome(), fetch); const current = detail();
    change(current, '实际投入分钟：把需求说清楚', '0');
    fetch.mockResolvedValueOnce(json({ note: emptyNote({ version: 1, minutesSpent: 0 }) }));
    await submit(current);
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toMatchObject({ action: 'save-note', minutesSpent: 0, expectedVersion: 0 });
    expect(input(current, '实际投入分钟：把需求说清楚').props.value).toBe('0');
    change(current, '实际投入分钟：把需求说清楚', '');
    fetch.mockResolvedValueOnce(json({ note: emptyNote({ version: 2 }) })); await submit(current);
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toMatchObject({ minutesSpent: null, expectedVersion: 1 });
  });

  it('preserves edits after a 409 and reloads/reset inputs only after the explicit refresh control is used', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const mounted = await mountList(outcome(), fetch); const current = mounted.detail();
    change(current, '实际投入分钟：把需求说清楚', '27'); change(current, '复用情况：把需求说清楚', 'true'); change(current, '使用感受：把需求说清楚', '结尾还需要自己打磨');
    fetch.mockResolvedValueOnce(json({ error: '这份记录已更新，请重新读取后核对。', code: 'content_changed' }, 409)); await submit(current);
    expect(input(current, '实际投入分钟：把需求说清楚').props.value).toBe('27');
    expect(input(current, '复用情况：把需求说清楚').props.value).toBe('true');
    expect(input(current, '使用感受：把需求说清楚').props.value).toBe('结尾还需要自己打磨');
    expect(elements(current.tree).some((element) => element.props.role === 'alert')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const oldKey = find(mounted.list, (element) => element.type === 'article').key;
    fetch.mockResolvedValueOnce(json(response(outcome({ note: emptyNote({ version: 3, minutesSpent: 8, note: '另一窗口保存的记录' }) }))));
    (button(current, '重新读取记录（会重置未保存的填写）').props.onClick as () => void)();
    mounted.list.render(); await settle(mounted.list);
    expect(find(mounted.list, (element) => element.type === 'article').key).not.toBe(oldKey);
    current.dispose(); const refreshed = mounted.detail();
    expect(input(refreshed, '实际投入分钟：把需求说清楚').props.value).toBe('8');
    expect(input(refreshed, '使用感受：把需求说清楚').props.value).toBe('另一窗口保存的记录');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('binds every return link to its displayed run, including the details anchor and a run without content', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const content of [outcome().content, null]) {
      const { detail } = await mountList(outcome({ runId: '作者本期_2', content }), fetch);
      const links = [...elements(OutcomeActions({ item: outcome({ runId: '作者本期_2', content }) })), ...elements(detail().tree)].filter((element) => element.type === 'a');
      expect(links).toHaveLength(content ? 3 : 2);
      for (const link of links) {
        const url = new URL(String(link.props.href), 'http://localhost');
        expect(url.pathname).toBe('/production'); expect(url.searchParams.get('openDraft')).toBe('run:作者本期_2');
        expect(url.searchParams.get('stage')).toBe(text(link.props.children as ReactNode) === '查看成品' ? '5' : content ? '3' : '1');
      }
      expect(String(links.at(-1)?.props.href)).toContain('#current-service-calls');
    }
  });

  it('preserves the verified saved draft identity on every return link instead of falling back to its run', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { detail } = await mountList(outcome({ runId: 'run-a', draftId: 'draft_owned_snapshot_2', title: '作者保存的草稿名称' }), fetch);
    const current = detail();
    for (const link of elements(current.tree).filter((element) => element.type === 'a')) {
      const url = new URL(String(link.props.href), 'http://localhost');
      expect(url.searchParams.get('openDraft')).toBe('draft_owned_snapshot_2');
      expect(url.searchParams.get('openDraft')).not.toBe('run:run-a');
    }
    expect(input(current, '使用感受：作者保存的草稿名称')).toBeDefined();
    fetch.mockResolvedValueOnce(json({ note: emptyNote({ version: 1 }) })); await submit(current);
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body)).toMatchObject({ runId: 'run-a', snapshot: INPUT_HASH, action: 'save-note' });
  });

  it('keeps manual effort empty despite usage counts and does not infer cost or saved time', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { detail } = await mountList(outcome({ modelCalls: 97, downloads: { count: 8, latestAt: '' } }), fetch);
    const current = detail();
    expect(input(current, '实际投入分钟：把需求说清楚').props.value).toBe('');
    expect(input(current, '复用情况：把需求说清楚').props.value).toBe('');
    const content = text(current.tree);
    expect(content).toContain('97 次模型请求'); expect(content).toContain('没有记录不代表零费用');
    expect(content).not.toMatch(/[¥￥]\s*\d|节省\s*\d|省了\s*\d|费用[：:]\s*0/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

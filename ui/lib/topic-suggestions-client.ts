import type { TopicResearchBinding } from './topic-research';

export type TopicSuggestion = {
  id: string;
  title: string;
  rationale?: string;
  audience?: string;
  evidence?: readonly string[];
};

/** Reads or rebuilds local suggestions from an already collected snapshot. */
export async function readSavedTopicSuggestions(
  binding: TopicResearchBinding,
  signal: AbortSignal,
): Promise<TopicSuggestion[]> {
  signal.throwIfAborted();
  const response = await fetch('/api/research/topic-suggestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'retrieve', ...binding }),
    signal,
  });
  const payload = await response.json();
  signal.throwIfAborted();
  if (!response.ok) throw new Error('选题建议暂时没有读出。已采集的参考仍保留，可重新读取建议，不会重新采集。');
  if (!Array.isArray(payload.suggestions)) throw new Error('保存的选题建议暂时无法读取，请重新读取建议。');
  const rows: unknown[] = payload.suggestions;
  const suggestions = rows.flatMap((value): TopicSuggestion[] => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const text = (key: string) => typeof row[key] === 'string' ? row[key].trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(text('id')) || !text('title')) return [];
    return [{ id: text('id'), title: text('title'), rationale: text('reason'),
      audience: text('audience'), evidence: [text('materialEvidence')].filter(Boolean) }];
  });
  if (suggestions.length !== rows.length || suggestions.length > 3
    || new Set(suggestions.map((item) => item.id)).size !== suggestions.length
    || new Set(suggestions.map((item) => item.title)).size !== suggestions.length) {
    throw new Error('保存的选题建议暂时无法读取，请重新读取建议；已有参考和标题仍保留。');
  }
  return suggestions;
}

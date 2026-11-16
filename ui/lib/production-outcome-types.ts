export type OutcomeVersion = { path: string; sha256: string };
export const OUTCOME_FILTERS = [
  { value: 'all', label: '全部进度' },
  { value: 'content', label: '已有正文' },
  { value: 'ready', label: '成品已确认' },
  { value: 'published', label: '已有发布记录' },
] as const;
export type OutcomeFilter = typeof OUTCOME_FILTERS[number]['value'];
export type OutcomeCompletion = {
  id: string; recordedAt: string; content: OutcomeVersion; deliverables: OutcomeVersion;
};
export type OutcomeNote = {
  version: number; minutesSpent: number | null; reusedPreviousWork: boolean | null;
  note: string; updatedAt: string; completions: OutcomeCompletion[];
};
export type ProductionOutcome = {
  runId: string; draftId?: string; title: string; platforms: string[]; updatedAt: string;
  progress?: { label: string; nextStep: string };
  snapshot: string; content: OutcomeVersion | null; contentConfirmed: boolean;
  deliverables: OutcomeVersion | null; deliverablesConfirmed: boolean;
  publicationRecords: number | null;
  downloads: { count: number; latestAt: string } | null;
  note: OutcomeNote | null; currentCompletion: OutcomeCompletion | null;
  modelCalls: number | null; warnings: string[];
};
export type ProductionOutcomes = {
  items: ProductionOutcome[]; offset: number; total: number; limit: number; unreadable: number;
  searchWarning?: string;
};

export type LayoutCallRecord = {
  id: string;
  operation: 'theme-preview' | 'article-layout' | 'article-restyle';
  runSlug: string | null;
  revisionId: string | null;
  theme: string;
  startedAt: string;
  completedAt: string | null;
  status: 'started' | 'completed' | 'failed' | 'interrupted';
};

export type LayoutCallHistory = { runId: string | null; records: LayoutCallRecord[] };
export const LAYOUT_CALLS_CHANGED = 'echo-layout-calls-changed';

export const layoutCallLabel = (operation: LayoutCallRecord['operation']) => ({
  'theme-preview': '主题示例预览', 'article-layout': '制作文章排版', 'article-restyle': '给成稿换版',
})[operation];
export const layoutCallStatus = (status: LayoutCallRecord['status']) => ({
  started: '已记录请求，结果待确认', completed: '已取得排版文件', failed: '未取得可用排版', interrupted: '中断，结果未确认',
})[status];

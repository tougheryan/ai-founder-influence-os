export const MODEL_CONNECTION_PROGRESS = {
  label: '等你完成模型连接',
  nextStep: '连接写作服务后回到这份草稿继续，已保存的素材和题目保留。',
};

/** Preparation is useful progress even before a generation task can be created. */
export function materialPreparationProgress(input: {
  hasAnalysis: boolean;
  stale: boolean;
  writingMode?: string;
  topic?: string;
  modelSetupIssue?: string | null;
}): { label: string; nextStep: string } | undefined {
  if (input.stale) return { label: '素材有更改，待重新整理', nextStep: '重新整理素材，再核对题目和写作要求。' };
  if (!input.hasAnalysis) return;
  if (input.writingMode === 'author_material') {
    if (!input.topic?.trim()) return { label: '素材已整理，待填写题目', nextStep: '填写这篇想写的题目，再确认素材和写作要求。' };
    if (input.modelSetupIssue) return MODEL_CONNECTION_PROGRESS;
    return { label: '素材已整理，待确认', nextStep: '核对素材、题目和写作要求，再确认生成写作方案。' };
  }
  return { label: '素材已整理，待确认', nextStep: '核对素材和写作要求，选择平台后开始找方向。' };
}

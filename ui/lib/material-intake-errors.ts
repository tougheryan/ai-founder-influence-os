/** Fixed copy only: never persist a provider response or local validation dump. */
export const MATERIAL_INTAKE_FAILURES = {
  material_analysis_missing: '这期还没有保存素材整理结果。请回到素材页整理素材后继续。',
  material_analysis_stale: '素材修改后，原来的整理结果还没有更新。请重新整理素材并核对要求后继续。',
  material_source_unreadable: '本期有文件没有读出可用文字。请回到素材页查看读取情况，补充文字或移除该文件后继续。',
  material_direction_invalid: '本期写作方向没有保存完整。请重新整理素材后继续。',
  material_run_unavailable: '这份草稿已归档或不存在。请从草稿列表打开可继续编辑的稿件。',
  material_report_invalid: '系统整理的素材报告未通过完整性检查，原素材和上次结果已保留，本步骤没有调用模型或平台数据服务。请保留排查编号并联系支持，修复后再从这里继续。',
  material_report_language_blocked: '系统整理的素材报告含有未完成内容或不宜直接保存的信息，原素材和上次结果已保留。请核对素材读取结果；若无异常，请保留排查编号并联系支持。',
} as const;

export function materialIntakeFailureMessage(code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(MATERIAL_INTAKE_FAILURES, code)
    ? MATERIAL_INTAKE_FAILURES[code as keyof typeof MATERIAL_INTAKE_FAILURES]
    : undefined;
}

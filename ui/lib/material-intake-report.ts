import {
  MATERIAL_TYPE_CATALOG,
  materialOpinionCandidates,
  getMaterialWritingRequirements,
  type MaterialAnalysisContext,
  type MaterialSourceRead,
} from './material-analysis';
import { materialAuthorAudience } from './material-writing-requirements';

function firstUsable(values: readonly string[], fallback: string): string {
  return values.map((value) => value.trim()).find(Boolean) || fallback;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...` : normalized;
}

function readableSources(sources: readonly MaterialSourceRead[] | undefined): string {
  const labels = (sources || [])
    .filter((source) => source.status === 'read')
    .map((source) => {
      if (source.kind === 'text') return `粘贴文字素材：${source.label}`;
      if (source.kind === 'file') return `用户提供的文字素材（${source.label}）`;
      return `公开链接：${source.label}`;
    })
    .slice(0, 5);
  return labels.length ? labels.join('；') : '用户提供的文字素材或已解析来源';
}

function audienceFor(typeId: string): { primary: string; secondary: string } {
  switch (typeId) {
    case 'business-growth':
      return {
        primary: '需要解决相关业务问题或了解产品与服务的读者',
        secondary: '寻找可复用工作方法的业务从业者',
      };
    case 'interview-event':
      return {
        primary: '需要把高价值对话整理成专业内容的创始人',
        secondary: '关注行业判断和人物经验的业务负责人',
      };
    case 'personal-growth':
      return {
        primary: '正在经历职业转折并寻找可验证经验的专业人士',
        secondary: '关注长期成长方法的团队管理者',
      };
    case 'work-life-vlog':
      return {
        primary: '希望了解真实专业工作过程的潜在客户',
        secondary: '需要稳定积累选题素材的个人创作者',
      };
    case 'global-expression':
      return {
        primary: '正在评估跨境表达机会的中国企业负责人',
        secondary: '服务海外华人市场的品牌与增长负责人',
      };
    default:
      return {
        primary: '需要把专业经验转为可信内容的服务型创始人',
        secondary: '正在寻找可复用工作方法的专业从业者',
      };
  }
}

/**
 * Produces the small, evidence-preserving intake artifact required before live
 * market research. The detailed content-generation skills still use the LLM;
 * this boundary only records material facts that were already read and shown
 * to the operator, so beginning research never waits on a second hidden model
 * call.
 */
export function buildMaterialIntakeReport(context: MaterialAnalysisContext): string {
  const selection = context.selection || {
    materialTypeId: context.analysis.recommendedTypeId,
    structureId: context.analysis.recommendedStructureId,
  };
  const type = MATERIAL_TYPE_CATALOG.find((item) => item.id === selection.materialTypeId);
  const structure = type?.structures.find((item) => item.id === selection.structureId);
  if (!type || !structure) throw new Error('系统没有得到可用的素材判断，请重新整理素材。');

  const facts = context.analysis.facts.map((value) => compact(value, 260));
  const cases = context.analysis.cases.map((value) => compact(value, 260));
  const illustrations = context.analysis.illustrations || [];
  // These are bounded at intake. A short display summary must not remove a
  // disclosure restriction or a qualifying clause from the downstream record.
  const risks = context.analysis.risks.map((value) => value.trim());
  const summary = compact(context.analysis.summary, 520);
  const opinions = context.analysis.opinions ?? materialOpinionCandidates([
    context.input.rawMaterial,
    ...(context.analysis.sources || []).filter((source) => source.status === 'read').map((source) => source.excerpt || ''),
  ].join('\n'));
  const coreFact = firstUsable(facts, '当前尚未提供可单独核验的事实。');
  const coreOpinion = firstUsable(opinions, coreFact);
  const coreCase = firstUsable(cases, '当前无可追溯核心案例，不能将观察写成已验证结果。');
  const materialUse = opinions.length
    ? `可以围绕作者提出的「${compact(coreOpinion, 220)}」解释判断依据与适用条件；观点来自本期素材，尚不能据此宣称实际效果。`
    : facts.length || cases.length
      ? `可以围绕素材中的「${compact(firstUsable(facts, coreCase), 220)}」说明发生了什么、有哪些证据与仍待核验的细节；不把线索当作已验证结果。`
      : '当前没有可展开的作者观点、事实或案例；请补充一个想回答的问题及自己的判断，或一段可公开的经历后再确定写法。';
  const hasTraceableCase = cases.length > 0;
  const authorRequirements = getMaterialWritingRequirements(context);
  const authorAudience = materialAuthorAudience(authorRequirements);
  const readerAction = authorRequirements.find((value) => /结尾|希望读者|请读者|读者行动/.test(value));
  const suggestedAudience = audienceFor(type.id);
  const audience = {
    primary: authorAudience?.replace(/^(?:目标读者|目标受众)[：:是]\s*/, '') || `系统建议，待作者确认：${suggestedAudience.primary}`,
    secondary: `系统建议，待作者确认：${suggestedAudience.secondary}`,
  };
  const sourceList = readableSources(context.analysis.sources);
  const readableSourceCount = (context.analysis.sources || []).filter((source) => source.status === 'read').length;
  const visibilityScore = Math.min(10, 2 + Math.min(facts.length, 3) + (hasTraceableCase ? 2 : 0) + Math.min(readableSourceCount, 2));
  const visibilityReason = [
    `已提取 ${facts.length} 条可追溯事实`,
    hasTraceableCase ? `找到 ${cases.length} 条案例线索` : '还没有可追溯案例',
    `读取 ${readableSourceCount} 个来源`,
  ].join('，');
  const riskList = risks.length
    ? risks.map((risk) => `- ${risk}`).join('\n')
    : '- 当前未识别具体隐私字段；仍不得公开客户名称、个人身份、合同、报价或未授权业务细节。';
  const caseGap = hasTraceableCase
    ? '仍缺少可公开的过程、结果和授权信息，不能把该观察扩写为客户成功案例。'
    : '缺少核心案例、过程细节和可公开结果，后续只能作为观察型素材使用。';
  const usability = hasTraceableCase
    ? '可直接立项（成稿前仍需核验案例细节与公开授权）'
    : opinions.length ? '可继续写观点或方法；若采用案例表达，需要补素材' : '需要补素材';

  return [
    `# 素材理解报告 · ${compact(type.title, 48)}`,
    '',
    '## 0. 素材场景',
    `- 主场景：${type.title}`,
    `- 判断依据：${summary}`,
    `- 推荐优先平台：${type.platforms.join('、')}`,
    `- 素材来源：${sourceList}。`,
    '- 事实边界：以下内容仅来自本期用户提供的原文、解析文件或公开链接摘录；客户、团队和结果等未给出原始证据的内容只能按转述或待核验处理，不能写成已验证事实。',
    '',
    '## 0.1 内容策略画像',
    `- 素材为什么值得被看见：${materialUse}素材分类不证明经历或效果真实。`,
    `- 值得被看见指数：${visibilityScore}/10，原因：${visibilityReason}。`,
    `- 主受众：${audience.primary}`,
    `- 副受众：${audience.secondary}`,
    '- 用户可选主题候选：待公众号、小红书和视频号的同类内容检查完成后，基于当前素材边界生成不超过 3 条有素材依据的可选主题；检查前不把推断写成热门结论。',
    `- 核心判断句：${coreOpinion}`,
    `- 内容结构：${structure.title}。先界定素材中的真实问题，再说明可验证的方法，最后标注案例依据与下一步。`,
    '- 爆款参考范围：只查看同场景、同平台、同人群和同行为目标的公开内容写法；不复制标题、正文、封面、镜头或评论。',
    '- 禁止写法：泛泛的增长口号、未核验数字、将转述写成事实、未授权客户案例和直接硬广。',
    '',
    '## 0.2 作者本期要求',
    ...(context.input.files.some((file) => file.writingRequirements === 'reference_only') ? ['- 作者选择了只复用素材、另写新题目。标为仅作参考的文件中，旧题目、受众、字数、语气和结尾要求不作为本篇指令；其虚构或待核实性质与公开限制继续保留。'] : []),
    '- 以下原文中的受众、写作要求和读者行动优先于系统推荐；不得自动增加咨询、诊断、私信或购买引导。素材中的经历与效果仍需核验。',
    ...(authorRequirements.length ? authorRequirements.map((value) => `- 作者原文：${compact(value, 800)}`) : ['- 尚未单独提供，请沿用已确认的本期要求；没有要求时不编造商业承接。']),
    ...(illustrations.length ? [
      '',
      '## 0.3 示例与待核实描述',
      '- 下列摘录的来源性质须保留。不能改写成作者真实身份、客户经历或已验证结果；用于读者正文时须明确标为假设示例或待核实描述。第一人称要求不改变素材真实性。',
      ...illustrations.map((value) => `- ${value}`),
    ] : []),
    '',
    '## 1. 人物',
    '- 核心人物：只采用原素材明确提供的人物；未提供作者身份时不得补写职业、客户或经营经历。',
    '- 人物关系：未单独核实；提到客户问题不代表作者已经访谈或服务过具体客户。',
    '- 人物标签：未单独确认，不根据素材分类补写。',
    '',
    '## 2. 场景',
    '- 时间 / 地点 / 背景：只采用素材中已提供的信息；提交时间不等于事件发生时间。',
    `- 关键事件链：${summary}`,
    '- 可视化细节：当前未提供可公开的现场、人物或过程画面。',
    '- 缺失信息：客户行业、原始访谈、服务流程细节、验证动作和结果指标。',
    '',
    '## 3. 观点',
    `- 明确观点：${opinions.length ? opinions.join('；') : '尚未单独提供作者观点。'}`,
    `- 可用事实：${facts.join('；')}`,
    '- 隐含立场：未单独确认，不把系统的内容生产方法当成作者观点。',
    '- 可争议点：该判断是否适用于其他业务，需要更多可追溯案例验证。',
    '- 证据位置：来自本期用户提供的文字素材与已读取来源摘录；未提供的过程和结果均标为待核验。',
    '',
    '## 4. 情绪',
    '- 主情绪：未单独确认，不推断作者或客户的心理状态。',
    '- 情绪曲线：按原素材中的明确表达组织；没有情绪叙事时，可以直接写观点和方法。',
    '- 可共鸣点：待结合本期受众与具体问题确定，不自动套用内容获客焦虑。',
    '',
    '## 5. 案例',
    `- 核心案例：${coreCase}`,
    `- 支撑细节：${hasTraceableCase ? '该案例仅保留素材中的观察，尚未获得过程与结果证明。' : '当前无可追溯核心案例，不能补写具体成效。'}`,
    '- 可展开度：★★☆☆☆',
    `- 可信等级：${hasTraceableCase ? '一手观察 / 待核验' : '未提供案例，若补充案例仍需待核验'}`,
    '',
    '## 6. 商业意图',
    '- 产品 / 服务 / 品牌信息：只使用原始素材中明确提供并允许公开的信息；素材分类不能证明作者提供咨询、诊断或其他服务。',
    `- 目标受众：${audience.primary}`,
    `- 转化路径：${readerAction ? `按作者原文执行：${compact(readerAction, 800)}` : '本期尚未明确读者行动，待作者确认；不得自动增加咨询或购买引导。'}`,
    '',
    '## 7. 不可公开信息',
    '- 已识别风险：',
    riskList,
    '- 使用限制：继续写作不代表授权公开；整份内容标为仅供内部或不对外发布时，仅供内部预览。限制针对具体材料时，不得公开该部分。限制说明保留在内部核对记录，不复制进读者正文。',
    '- 隐私 / 商业机密 / 敏感关系：客户名称、联系人身份、原始访谈、服务报价、合同、内部流程与未经授权的结果均不可公开。',
    '- 处理建议：成稿中使用匿名角色和可验证范围；没有授权时删除可识别细节，不引用原话或未公开数据。',
    '',
    '## 9. 素材质量判断',
    '- 信息完整度：中；已有明确观察和方向，但缺少原始证据、过程和结果。',
    '- 可信度：中；用户提供的观察可作为一手素材入口，涉及客户与业务成效的部分仍需待核验。',
    `- 最值得深挖的点：${coreOpinion}`,
    `- 当前缺口：${caseGap}`,
    `- 下游可用性：${usability}。`,
  ].join('\n');
}

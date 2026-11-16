import { readSkillMd } from './skill-files';
import type { SkillDefinition, SkillParameter } from './types';

export type SkillParamValue = string | number | boolean | string[] | undefined;
export type SkillParamMap = Record<string, SkillParamValue>;
type Frontmatter = Record<string, string>;
const DRAFT_MATERIAL_CATEGORIES = 'pipeline/final,pipeline/xhs,pipeline/package';

export async function loadSkill(skillName: string): Promise<SkillDefinition> {
  const content = await readSkillMd(skillName);
  return parseSkillMd(content);
}

function parseSkillMd(content: string): SkillDefinition {
  // 解析 frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  let frontmatter: Frontmatter = {};
  let body = content;

  if (frontmatterMatch) {
    frontmatter = parseYaml(frontmatterMatch[1]);
    body = frontmatterMatch[2];
  }

  return {
    name: frontmatter.name || '',
    description: frontmatter.description || '',
    triggerWords: extractTriggerWords(frontmatter),
    systemPrompt: body,
    parameters: extractParameters(body, frontmatter.name || ''),
  };
}

function parseYaml(yaml: string): Frontmatter {
  const result: Frontmatter = {};
  const lines = yaml.split('\n');
  let currentKey = '';

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      currentKey = match[1];
      const value = match[2].trim();
      if (value === '|') {
        result[currentKey] = '';
      } else {
        result[currentKey] = value;
      }
    } else if (currentKey && line.startsWith('  ')) {
      result[currentKey] += (result[currentKey] ? '\n' : '') + line.trim();
    }
  }

  return result;
}

function extractTriggerWords(frontmatter: Frontmatter): string[] {
  const desc = frontmatter.description || frontmatter.trigger || '';
  const words: string[] = [];

  // 提取 `/command` 形式
  const slashMatches = desc.match(/\/\w+/g);
  if (slashMatches) words.push(...slashMatches);

  // 提取引号中的中文触发词
  const quoteMatches = desc.match(/「([^」]+)」/g);
  if (quoteMatches) {
    words.push(...quoteMatches.map((m: string) => m.slice(1, -1)));
  }

  return [...new Set(words)];
}

function extractParameters(body: string, skillName: string): SkillParameter[] {
  // 基于 skill 名称定义参数模板
  const templates: Record<string, SkillParameter[]> = {
    'content-intake': [
      { name: 'rawMaterial', type: 'textarea', label: '原始素材', required: true, placeholder: '粘贴文字、语音转文字、聊天记录、访谈稿等任意素材...' },
      { name: 'scenario', type: 'select', label: '素材场景', required: false, default: 'auto', options: ['auto', 'personal', 'interview', 'growth', 'business', 'global'] },
      { name: 'platforms', type: 'multi-select', label: '目标平台', required: false, default: ['wechat', 'xiaohongshu', 'shipinhao', 'douyin'], options: ['wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'] },
      { name: 'research', type: 'boolean', label: '补充背景调研', required: false, default: false },
    ],
    'content-validate': [
      { name: 'source', type: 'material', label: '素材理解报告', required: true, materialCategory: 'pipeline/intake' },
      { name: 'marketSignalPath', type: 'material', label: '爆款抓取与对标报告', required: true, materialCategory: 'materials/research' },
      { name: 'researchReportPath', type: 'material', label: '公开补证报告（可选）', required: false, materialCategory: 'materials/research' },
      { name: 'passagePlanPath', type: 'material', label: '低证据通行方案（可选）', required: false, materialCategory: 'materials/research' },
      { name: 'businessFirst', type: 'boolean', label: '商业优先', required: false, default: false },
      { name: 'allowLowEvidenceReframe', type: 'boolean', label: '允许低证据降级立项', required: false, default: false },
    ],
    'content-blueprint': [
      { name: 'validateReportPath', type: 'material', label: '立项报告', required: true, materialCategory: 'pipeline/validate' },
      { name: 'intakeReportPath', type: 'material', label: '素材理解报告', required: true, materialCategory: 'pipeline/intake' },
      { name: 'marketSignalPath', type: 'material', label: '爆款抓取与对标报告', required: false, materialCategory: 'materials/research' },
      { name: 'researchReportPath', type: 'material', label: '公开补证报告（可选）', required: false, materialCategory: 'materials/research' },
      { name: 'platforms', type: 'multi-select', label: '目标平台', required: false, default: ['wechat', 'xhs', 'shipinhao'], options: ['wechat', 'xhs', 'shipinhao'] },
    ],
    'content-angle': [
      { name: 'validateReportPath', type: 'material', label: '立项报告', required: true, materialCategory: 'pipeline/validate' },
      { name: 'researchReportPath', type: 'material', label: '公开补证报告（可选）', required: false, materialCategory: 'materials/research' },
      { name: 'source', type: 'textarea', label: '补充素材或说明', required: false, placeholder: '可选：补充本次角度生成需要注意的素材、平台或风险说明' },
      { name: 'intakeReportPath', type: 'material', label: '素材理解报告（可选）', required: false, materialCategory: 'pipeline/intake' },
      { name: 'platforms', type: 'multi-select', label: '目标平台', required: false, default: ['wechat'], options: ['wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'] },
      { name: 'count', type: 'number', label: '角度数量', required: false, default: 6 },
      { name: 'explorationMode', type: 'boolean', label: '预研模式', required: false, default: false },
    ],
    'content-breakdown': [
      { name: 'intakeReportPath', type: 'material', label: '素材理解报告', required: true, materialCategory: 'pipeline/intake' },
      { name: 'angleReportPath', type: 'material', label: '角度报告', required: true, materialCategory: 'pipeline/angles' },
      { name: 'targetPlatform', type: 'select', label: '目标平台', required: false, default: 'all', options: ['all', 'wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'] },
    ],
    'wechat-writer': [
      { name: 'topic', type: 'string', label: '选题/标题', required: true, placeholder: '例如：AI 创业者如何用内容撬动影响力' },
      { name: 'blueprintPath', type: 'material', label: '已确认的思想母版蓝图（优先）', required: false, materialCategory: 'pipeline/blueprint' },
      { name: 'material', type: 'textarea', label: '素材/要点', required: false, placeholder: '粘贴相关素材、链接、语音转文字、爆款参考...' },
      { name: 'wordCount', type: 'number', label: '目标字数', required: false, default: 3600 },
    ],
    'content-package': [
      { name: 'blueprintPath', type: 'material', label: '已确认的平台内容蓝图', required: true, materialCategory: 'pipeline/blueprint' },
      { name: 'topic', type: 'string', label: '选题', required: false, placeholder: '可选：本次内容包主题' },
      { name: 'platforms', type: 'multi-select', label: '发布平台', required: false, default: ['wechat', 'xhs', 'shipinhao'], options: ['wechat', 'xhs', 'shipinhao'] },
    ],
    'xhs-card': [
      { name: 'content', type: 'textarea', label: '内容/要点', required: true, placeholder: '粘贴拆解方案、文章摘要或小红书图文要点...' },
      { name: 'sourceContentPath', type: 'material', label: '源内容文件（可选）', required: false, materialCategory: 'pipeline/breakdown' },
      { name: 'stylePreference', type: 'select', label: '风格偏好', required: false, default: 'swiss', options: ['swiss', 'magazine'] },
    ],
    'content-visual': [
      { name: 'content', type: 'textarea', label: '内容/概念', required: true, placeholder: '粘贴文章段落、核心概念或全文' },
      { name: 'imageType', type: 'select', label: '图片类型', required: false, default: 'illustration', options: ['illustration', 'wechat-cover', 'xiaohongshu-cover', 'xiaohongshu-graphic'] },
      { name: 'stylePreference', type: 'select', label: '风格偏好', required: false, default: 'xiaohei', options: ['xiaohei', 'magazine', 'swiss'] },
    ],
    'content-audit': [
      { name: 'draft', type: 'textarea', label: '待审核内容', required: true, placeholder: '粘贴公众号文章或小红书图文...' },
      { name: 'draftPath', type: 'material', label: '或选择已生成的成稿文件', required: false, materialCategory: DRAFT_MATERIAL_CATEGORIES },
    ],
    'content-prelaunch': [
      { name: 'draftPath', type: 'material', label: '成稿文件', required: true, materialCategory: DRAFT_MATERIAL_CATEGORIES },
      { name: 'breakdownPath', type: 'material', label: '拆解方案（可选）', required: false, materialCategory: 'pipeline/breakdown' },
      { name: 'targetPlatform', type: 'select', label: '目标平台', required: false, default: 'wechat', options: ['wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'] },
    ],
    'content-compliance': [
      { name: 'draftPath', type: 'material', label: '成稿文件', required: true, materialCategory: DRAFT_MATERIAL_CATEGORIES },
      { name: 'targetPlatform', type: 'select', label: '目标平台', required: false, default: 'wechat', options: ['wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'] },
    ],
    'content-review': [
      { name: 'platformData', type: 'textarea', label: '平台数据/评论', required: true, placeholder: '粘贴阅读量、点赞、评论、转发数据或截图 OCR 文本...' },
      { name: 'publishRecordPath', type: 'material', label: '发布记录（可选）', required: false, materialCategory: 'pipeline/publish' },
      { name: 'originalArticlePath', type: 'material', label: '原文路径（可选）', required: false, materialCategory: DRAFT_MATERIAL_CATEGORIES },
    ],
    'self-archive': [
      { name: 'draftPath', type: 'material', label: '成稿文件', required: true, materialCategory: DRAFT_MATERIAL_CATEGORIES },
      { name: 'reviewReportPath', type: 'material', label: '数据复盘报告（可选）', required: false, materialCategory: 'pipeline/review' },
      { name: 'feedback', type: 'textarea', label: '补充反馈', required: false, placeholder: '用户对这次发文的额外反馈、观察或调整方向' },
    ],
    'content-twin': [
      { name: 'publishedContentPath', type: 'material', label: '最终发布版（写入记忆必选）', required: false, materialCategory: DRAFT_MATERIAL_CATEGORIES },
      { name: 'publishedContent', type: 'textarea', label: '补充观察说明（可选）', required: false, placeholder: '可补充平台反馈、评论区语气或需要重点观察的风格线索。只粘贴文本时请选择“只读观察”。' },
      { name: 'flags', type: 'multi-select', label: '观察模式', required: false, default: [], options: ['readonly', 'show-dna', 'list-patterns', 'evolution'] },
    ],
    'content-repurpose': [
      { name: 'sourceContentPath', type: 'material', label: '源内容文件', required: true, materialCategory: DRAFT_MATERIAL_CATEGORIES },
      { name: 'targetPlatform', type: 'select', label: '目标平台', required: false, default: 'all', options: ['all', 'wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'] },
    ],
    'content-hit-collect': [
      { name: 'keyword', type: 'string', label: '关键词', required: true, placeholder: '例如：AI 内容生产' },
      { name: 'platform', type: 'select', label: '平台', required: false, default: 'wechat', options: ['wechat', 'xiaohongshu', 'zhihu'] },
      { name: 'count', type: 'number', label: '数量', required: false, default: 5 },
    ],
    'content-formula-extract': [
      { name: 'source', type: 'select', label: '来源', required: false, default: 'latest', options: ['latest', 'file'] },
      { name: 'focus', type: 'select', label: '提炼重点', required: false, default: 'all', options: ['all', 'title', 'opening', 'structure', 'closing'] },
    ],
    'content-topic-generate': [
      { name: 'keyword', type: 'string', label: '领域关键词', required: true, placeholder: '例如：AI 创业' },
      { name: 'count', type: 'number', label: '选题数量', required: false, default: 8 },
    ],
    'wechat-title-maker': [
      { name: 'article', type: 'textarea', label: '文章内容', required: true, placeholder: '粘贴文章正文' },
    ],
    'humanizer-zh': [
      { name: 'text', type: 'textarea', label: '待润色文本', required: true, placeholder: '粘贴需要去除 AI 味的文本' },
    ],
    'content-multi-platform-plan': [
      { name: 'article', type: 'textarea', label: '公众号文章', required: true, placeholder: '粘贴公众号长文' },
    ],
    'aihot': [
      { name: 'type', type: 'select', label: '类型', required: false, default: 'daily', options: ['daily', 'latest'] },
    ],
    'hv-analysis': [
      { name: 'subject', type: 'string', label: '研究对象', required: true, placeholder: '产品/公司/概念/人物' },
    ],
  };

  return templates[skillName] || [
    { name: 'input', type: 'textarea', label: '输入内容', required: true, placeholder: '输入给 skill 的内容...' },
  ];
}

export function buildUserMessage(skillName: string, params: SkillParamMap): string {
  const asText = (value: SkillParamValue, fallback = ''): string => {
    if (value === undefined) return fallback;
    if (Array.isArray(value)) return value.join('、');
    return String(value);
  };

  const asTextList = (value: SkillParamValue): string[] => {
    return Array.isArray(value) ? value : [];
  };

  const platformLabel = (value: SkillParamValue): string => {
    const map: Record<string, string> = {
      wechat: '公众号',
      xiaohongshu: '小红书',
      shipinhao: '视频号',
      douyin: '抖音',
      moments: '朋友圈',
      zhihu: '知乎',
      all: '全部',
    };
    if (Array.isArray(value)) {
      return value.map((v) => map[v] || v).join('、');
    }
    if (typeof value !== 'string') return asText(value);
    return map[value] || value;
  };

  switch (skillName) {
    case 'content-intake': {
      const materialSourcePath = asText(params.materialSourcePath).trim();
      const extractedAssetPath = asText(params.extractedAssetPath).trim();
      const extractionStatus = asText(params.extractionStatus).trim();
      const handoffLines = [
        materialSourcePath ? `原始素材路径：${materialSourcePath}` : '',
        extractedAssetPath ? `解析资产路径：${extractedAssetPath}` : '',
        extractionStatus ? `解析状态：${extractionStatus}` : '',
      ].filter(Boolean);
      const evidenceGuard = extractionStatus === 'needs_transcription'
        ? [
          '附件尚未完成转写/OCR：本次素材理解必须把正文缺口列为阻断项，不得根据文件名、截图印象或未读附件推断事实。',
          '下游可用性只能写“需要补素材”或“只适合做灵感备忘”，并列出补充转写、OCR、授权和可公开范围清单。',
        ]
        : [
          '必须保留原始素材路径、解析资产路径和证据台账编号；观点、案例、情绪判断都要写明证据位置。',
          '如果解析资产只包含摘录，需在事实边界中说明“长文件已截取，正式发布前需回看原始素材”。',
        ];

      return [
        `素材场景：${params.scenario || '自动识别'}`,
        `目标平台：${platformLabel(params.platforms || ['wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'])}`,
        `补充背景调研：${params.research ? '是' : '否'}`,
        handoffLines.length ? '\n--- 素材接力来源 ---' : '',
        ...handoffLines,
        handoffLines.length ? '\n--- 素材理解硬约束 ---' : '',
        ...(handoffLines.length ? evidenceGuard : []),
        '',
        '--- Runtime 输出格式硬约束 ---',
        '本次调用写入内部 `intake` 报告，不是给操作者直接看的主题选择页。不要输出主题 A-J 清单、推荐主题、过程说明、写入命令或“已保存”。',
        '只输出可写回 runtime 的完整 Markdown 报告，标题必须为一级标题：`# 素材理解报告 · {标题}`。',
        '以下章节必须全部使用二级标题，标题文字与编号必须完全一致：',
        '## 0. 素材场景',
        '## 0.1 内容策略画像',
        '## 1. 人物',
        '## 2. 场景',
        '## 3. 观点',
        '## 4. 情绪',
        '## 5. 案例',
        '## 6. 商业意图',
        '## 7. 不可公开信息',
        '## 9. 素材质量判断',
        '不要用 `###`、`Phase`、自由标题或主题清单代替这些章节。主题建议只会在 TikOmni 研究完成后由界面生成。',
        '',
        '--- 原始素材 ---',
        params.rawMaterial,
      ].join('\n');
    }
    case 'content-validate':
      return [
        `本期已选主题：${params.topic || '未提供；不得自行改成素材中的其他主题。'}`,
        '必须围绕本期已选主题完成整份立项报告。报告标题可以精简措辞，但不得替换主题、改写成素材里的另一条观点，或重新选择方向。',
        `商业优先：${params.businessFirst ? '是' : '否'}`,
        '',
        '--- 输出格式硬约束 ---',
        '只输出可写回 runtime 的 Markdown 报告正文，不要输出“好的/收到/Phase/请稍候/写入命令/已保存”等过程性文字。',
        '报告标题必须是一级标题：`# 选题立项报告 · {标题}`。',
        '必需章节必须全部使用二级标题，且标题文字完全一致：',
        '## 0. 素材来源',
        '## 1. 立项决策',
        '## 2. HKR 质检',
        '## 3. 商业成立性判断',
        '## 4. 平台首发策略',
        '## 5. 素材补充清单',
        '## 6. 风险提示',
        '## 7. 下一步',
        '不要使用 `### 0. 素材来源`，不要使用 `Phase 1/Phase 2` 代替必需章节。',
        '`决策` 写“通过”，`是否允许进入下一步` 写“是（研究证据已通过）”；素材缺口、事实边界与承诺限制写入素材补充清单和风险提示。已选平台都没有研究证据时，本调用不会启动。',
        params.marketSignalPath ? `爆款抓取与对标报告路径：${params.marketSignalPath}` : '爆款抓取与对标报告路径缺失。不得开始立项或用推测替代报告。',
        '在 `## 0. 素材来源` 必须逐项声明：`公开样本对标报告`（原样填写本报告路径）、`公开样本状态：已完成`、`可验证样本数`（按本期已选平台分别记录）。某个平台证据不足时只降低该平台结论，不得伪造数据或用其他平台替代。',
        params.marketSignalPath ? '只吸收标题结构、开头钩子、叙事机制和评论需求；不得复制第三方标题、正文、封面或故事。' : '',
        params.researchReportPath ? `公开补证报告路径：${params.researchReportPath}` : '公开补证报告路径：未提供。',
        params.researchReportPath ? '公开补证只能补公开背景、行业事实和对标样本；不能替代一手客户案例、真实成交数据、ROI、未公开合作细节和授权。缺少一手数据时要保留边界，而不是把它写成已经验证的结果。' : '',
        params.passagePlanPath ? `低证据通行方案路径：${params.passagePlanPath}` : '',
        params.allowLowEvidenceReframe ? '允许低证据创作：是。将缺少案例、授权、ROI、成交、内部截图或合作细节的选题降级为行业观察、方法论清单、访谈观点整理、问题征集或公开对标拆解；不得写成客户结果证明。' : '',
        '',
        `素材理解报告路径：${params.source}`,
      ].filter(Boolean).join('\n');
    case 'content-blueprint':
      return [
        `本期已选主题：${params.topic || '未提供。'}`,
        '蓝图必须围绕本期已选主题展开；立项报告和素材报告只提供证据与边界，不得借此替换主题或重新选题。',
        `立项报告路径：${params.validateReportPath || '未提供。必须先完成 content-validate。'}`,
        `素材理解报告路径：${params.intakeReportPath || '未提供。'}`,
        params.marketSignalPath ? `爆款抓取与对标报告路径：${params.marketSignalPath}` : '爆款抓取与对标报告路径：未提供；不得虚构爆款样本或对标结论。',
        params.researchReportPath ? `公开补证报告路径：${params.researchReportPath}` : '',
        `本期平台：${platformLabel(params.platforms || ['wechat', 'xhs', 'shipinhao'])}`,
        '',
        '只输出可写回 runtime 的平台内容蓝图 Markdown，不要输出过程说明、占位符或写入命令。',
        '必须包含：上游约束、共享事实底稿、已选平台各自的独立蓝图、平台差异检查、人工确认清单。不要生成未选平台章节。',
        '公众号、小红书、视频号分别从自己的研究依据确定原生选题、入口和结构；共享事实不等于共享成稿，明确禁止母稿拆解与跨平台改写。',
        '若系统在本次调用中提供了 TikOmni 研究快照路径与 SHA-256，必须在 `## 0. 上游约束` 原样逐行保留；它们是选题与模板人工确认后冻结本期市场证据的唯一凭据。',
        '在 `## 6. 人工确认清单` 必须写 `确认状态：待作者确认`。用户提交本期平台、选题和排版不等于确认生成后的写作方案；作者核对并明确确认方案后才能进入正文，模型不得代为确认。',
        '对标只能作为市场证据，不能复制第三方标题、案例、观点、段落或表达；硬数字、客户信息和未授权素材必须保留事实边界。',
      ].filter(Boolean).join('\n');
    case 'content-angle':
      return [
        `目标平台：${platformLabel(params.platforms || ['wechat'])}`,
        `角度数量：${params.count || 6}`,
        params.validateReportPath
          ? `立项报告路径：${params.validateReportPath}`
          : '立项报告路径：未提供。必须先执行 content-validate，不能直接从 intake 或原始素材生成角度。',
        params.researchReportPath ? `公开补证报告路径：${params.researchReportPath}` : '',
        params.intakeReportPath ? `素材理解报告路径：${params.intakeReportPath}` : '',
        params.researchReportPath ? '公开补证只可作为背景语境、平台语境、公开事实来源；角度的核心素材证据仍应来自 intake/validate 的一手素材。' : '',
        params.explorationMode ? '预研模式：如果立项不是“通过”，可以输出“预研角度与补证路线”，但不得写入 pipeline/angles，也不得声称可进入 content-breakdown。' : '',
        '',
        params.source ? '--- 补充说明 ---\n' + params.source : '',
      ].filter(Boolean).join('\n');
    case 'content-breakdown':
      return [
        `目标平台：${platformLabel(params.targetPlatform || 'all')}`,
        '',
        `素材理解报告路径：${params.intakeReportPath}`,
        `角度报告路径：${params.angleReportPath}`,
      ].join('\n');
    case 'wechat-writer':
      return [
        `选题：${params.topic}`,
        params.blueprintPath
          ? `已确认的思想母版蓝图路径：${params.blueprintPath}`
          : '思想母版蓝图路径：未提供；仅在补写或旧稿兼容场景下继续，不能把未确认的蓝图当作写作依据。',
        '',
        `素材/要点：\n${params.material || '（无额外素材）'}`,
        `目标字数：${params.wordCount || 3600}。`,
        params.blueprintPath
          ? '必须以该已确认蓝图的核心判断、证据链、章节任务、商业收口和风险边界为唯一上游约束；不要把对标样本改写为自己的素材。'
          : '',
      ].filter(Boolean).join('\n\n');
    case 'content-package':
      return [
        `选题：${params.topic || '以已确认蓝图为准'}`,
        `本期平台：${platformLabel(params.platforms || ['wechat', 'xhs', 'shipinhao'])}`,
        `共享底稿与平台蓝图路径：${params.blueprintPath}`,
        '',
        '这是平台原生内容生产。只输出本期已选平台；各平台共享事实与边界，但必须从各自平台研究和蓝图独立生成，禁止从公众号成稿改写。',
        '生成前先在内部完成“初稿 → 平台审稿 → 定向修订”，只输出修订后的最终内容包，不输出审稿过程。',
        '公众号篇幅优先服从本篇已确认的作者要求（例如600字左右），未指定时才参考1,600-2,200字；不得为了默认篇幅补字。完整填写标题、标题备选、摘要、头图文案、排版提示、正文插图位置和评论区承接。标题必须有具体读者、场景或冲突；开头前 300 字建立现场、矛盾和继续阅读的收益；正文用可追溯事实推进判断、方法和行动，不用正确但空泛的段落凑字数。',
        '小红书交付封面三句话、恰好 P1-P8、发布正文和 3-6 个准确标签。P1 停止滑动，P2 建立问题/冲突/证据，P3-P6 每页推进一个观点或方法，P7 总结行动，P8 真实互动；不得把公众号正文平均切成八段。',
        '视频号交付一条 45-90 秒原生口播：前三秒钩子可独立成立；逐句口播符合自然说话节奏；镜头、字幕和 B-roll 与时间段对应；不得把文章变成朗读稿。',
        '三个平台的发布标题、开头、推进结构和结尾互动必须分别成立；不得出现“由公众号改写”“基于上文”“把文章拆成”等派生痕迹。',
        '不要输出抖音、朋友圈或未选择平台的内容，也不要为了凑固定数量生成多余稿件。',
        '不能新增一手素材中没有的事实、数据、客户或效果承诺；概念插图必须明确为非事实证据。',
        '输出前静默删除重复结论、套话、模型自述和无证据精确断言；事实不足时降低断言并明确边界，不能用修辞掩盖证据缺口。',
      ].filter(Boolean).join('\n');
    case 'xhs-card':
      return [
        '目标平台：小红书',
        `风格偏好：${params.stylePreference || 'swiss'}`,
        params.sourceContentPath ? `源内容路径：${params.sourceContentPath}` : '',
        '',
        '请先输出“小红书图文生产稿”，用于写回 pipeline/xhs/，不要直接生成图片。',
        '生产稿必须包含：封面三行文案、标题候选、6-8 张卡片结构、每页主文案、正文笔记、评论区承接、视觉转化说明、风险边界。',
        '',
        '--- 内容/要点 ---',
        params.content,
      ].filter(Boolean).join('\n');
    case 'content-visual':
      return [
        `图片类型：${params.imageType || 'illustration'}`,
        `风格偏好：${params.stylePreference || 'xiaohei'}`,
        '',
        '--- 内容 ---',
        params.content,
      ].join('\n');
    case 'content-audit':
      return [
        params.draftPath ? '硬约束：审核报告必须在“下一步”或检查对象中原样写入该成稿路径；不得改写成绝对路径、旧路径或其它 run 的路径。' : '',
        params.draftPath ? `待审核文件路径：${params.draftPath}` : `--- 待审核内容 ---\n${params.draft}`,
        params.prelaunchPath ? `发布前检查路径：${params.prelaunchPath}` : '',
        params.compliancePath ? `合规报告路径：${params.compliancePath}` : '',
        params.publishAssetsPath ? `发布资产包路径：${params.publishAssetsPath}` : '',
      ].filter(Boolean).join('\n');
    case 'content-prelaunch':
      return [
        '硬约束：输出的 `## 0. 检查对象` 与 `## 5.2 发布资产准备度检查` 必须原样写入下方成稿路径；不得改写成绝对路径、旧路径或其它 run 的路径。',
        `目标平台：${platformLabel(params.targetPlatform || 'wechat')}`,
        `成稿路径：${params.draftPath}`,
        params.breakdownPath ? `拆解方案路径：${params.breakdownPath}` : '',
        params.visualPlanPath ? `视觉计划路径：${params.visualPlanPath}` : '',
        params.publishAssetsPath ? `发布资产包路径：${params.publishAssetsPath}` : '',
      ].filter(Boolean).join('\n');
    case 'content-compliance':
      return [
        '硬约束：输出的 `## 0. 检查对象` 与 `## 6. 综合判断` 下一步命令必须原样写入下方成稿路径；不得改写成绝对路径、旧路径或其它 run 的路径。',
        `目标平台：${platformLabel(params.targetPlatform || 'wechat')}`,
        `成稿路径：${params.draftPath}`,
      ].join('\n');
    case 'content-review':
      return [
        params.publishRecordPath ? `发布记录路径：${params.publishRecordPath}` : '',
        params.originalArticlePath ? `原文路径：${params.originalArticlePath}` : '',
        '',
        '--- 平台数据/评论 ---',
        params.platformData,
      ].join('\n');
    case 'self-archive':
      return [
        `成稿路径：${params.draftPath}`,
        params.reviewReportPath ? `数据复盘报告路径：${params.reviewReportPath}` : '',
        '',
        '--- 补充反馈 ---',
        params.feedback || '（无）',
      ].join('\n');
    case 'content-twin':
      return [
        `观察模式：${asTextList(params.flags).join(', ') || '默认'}`,
        params.publishedContentPath ? `最终发布版路径：${params.publishedContentPath}` : '',
        '',
        '--- 已发布内容 ---',
        params.publishedContent,
      ].join('\n');
    case 'content-repurpose':
      return [
        `目标平台：${platformLabel(params.targetPlatform || 'all')}`,
        `源内容路径：${params.sourceContentPath}`,
      ].join('\n');
    case 'content-hit-collect':
      return `请采集关于「${params.keyword}」的爆款内容。平台：${platformLabel(params.platform || 'wechat')}，数量：${params.count || 5}。输出结构化爆款档案。`;
    case 'content-formula-extract':
      return `请从近期爆款中提炼内容公式。重点：${params.focus || 'all'}。`;
    case 'content-topic-generate':
      return `请基于爆款公式库和大脑层，生成 ${params.count || 8} 个关于「${params.keyword}」的候选选题。`;
    case 'wechat-title-maker':
      return `请为以下文章生成 5 个公众号爆款标题候选：\n\n${params.article}`;
    case 'humanizer-zh':
      return `请去除以下文本的 AI 味，使其更自然：\n\n${params.text}`;
    case 'content-multi-platform-plan':
      return `请为以下公众号文章规划小红书图文的改编角度：\n\n${params.article}`;
    case 'aihot':
      return `请查询 ${params.type === 'daily' ? '今日' : '最新'} AI 行业热点。`;
    case 'hv-analysis':
      return `请对「${params.subject}」进行横纵分析法深度研究。`;
    default:
      return JSON.stringify(params, null, 2);
  }
}

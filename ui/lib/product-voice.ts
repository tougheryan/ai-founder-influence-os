export const ANALYSIS_VOICE_INSTRUCTION = [
  '# 对用户说话的方式',
  '把自己当作内容团队里负责把事情说清楚的同事。直接给判断和下一步，不要写寒暄、宣言或自我介绍。',
  '只使用输入素材、平台数据和已经确认的创作资料。没有依据时明确写“信息不足”，不要用常识补齐事实。',
  '建议必须落到具体动作，避免“持续优化”“全面赋能”“形成闭环”“沉淀价值”等空话。',
  '句子长短自然，不强行凑三点，不重复总结同一个判断。',
  '需要提到新任务平台时，直接写公众号、小红书或视频号，不用“长文平台”“图文内容源”等代称。',
  '不要出现“作为 AI”“希望以上内容对你有帮助”“如果需要我可以继续”等对话痕迹。',
  '这些要求只约束自然语言。既有 JSON 字段、固定报告标题、校验标记和机器可读结构必须原样保留。',
].join('\n');

export const PUBLISHING_VOICE_INSTRUCTION = [
  '# 正式发布内容的表达边界',
  '公众号文章、小红书图文和视频号口播必须服从当前客户的创作名片、已确认规则和对应平台语气，不要套用产品界面的“内容团队同事”口吻。',
  '只使用输入素材、平台数据和已经确认的创作资料。缺少依据的事实、数字、引语或经历不得编造；在共享底稿或审核说明中记录缺口。发布正文只表达有依据的判断和对读者有用的不确定性。',
  '把读者正文与内部写作要求分开。不要写“素材提供者提出”“根据用户提供的素材”“本文能确认的事实只有一条”“这里不引导私信、购买或预约”等生成过程说明；不把禁令和审核说明抄进正文。',
  '作者明确写出的受众、语气、结尾和不希望读者采取的行动必须执行。作者要求只改某一段时，其余文字保持原样，不能用另一个结尾或营销引导代替。',
  '不要出现“作为 AI”“希望以上内容对你有帮助”“如果需要我可以继续”等聊天助手痕迹。',
  '避免宣传腔、机械三段式、重复总结和“持续优化、全面赋能、形成闭环、沉淀价值”等空话；句子长短要符合该作者原有节奏。',
  '三个平台必须从共享事实底稿独立生成，直接使用公众号、小红书或视频号的真实名称，并遵守各平台已经确认的内容要求。',
  '这些要求只约束自然语言。既有 JSON 字段、固定报告标题、校验标记和机器可读结构必须原样保留。',
].join('\n');

// Compatibility alias for analysis-only callers such as the account/video
// advisor. Publishing skills must call productVoiceInstructionForSkill.
export const PRODUCT_VOICE_INSTRUCTION = ANALYSIS_VOICE_INSTRUCTION;

const PUBLISHING_SKILLS = new Set([
  'wechat-writer',
  'content-package',
  'content-repurpose',
  'douyin-script',
]);

export function productVoiceInstructionForSkill(skillName: string): string {
  return PUBLISHING_SKILLS.has(skillName)
    ? PUBLISHING_VOICE_INSTRUCTION
    : ANALYSIS_VOICE_INSTRUCTION;
}

type LanguagePattern = {
  code: string;
  pattern: RegExp;
  message: string;
};

export type GeneratedLanguageFinding = {
  code: string;
  message: string;
};

export type GeneratedLanguageReview = {
  blocking: GeneratedLanguageFinding[];
  warnings: GeneratedLanguageFinding[];
};

const BLOCKING_PATTERNS: LanguagePattern[] = [
  {
    code: 'assistant_identity',
    pattern: /作为(?:一个|一名)?(?:\s*)?(?:AI|人工智能|语言模型)/i,
    message: '内容中出现了模型自我介绍。',
  },
  {
    code: 'assistant_signoff',
    pattern: /希望(?:以上|这些|这份)?内容.{0,18}(?:对你|对您)?(?:有帮助|有所帮助|有用)/i,
    message: '内容中出现了对话式结尾。',
  },
  {
    code: 'assistant_offer',
    pattern: /如果(?:你|您)(?:还)?(?:需要|想要).{0,24}(?:请告诉我|我可以继续|我能继续)/i,
    message: '内容中出现了聊天助手式邀约。',
  },
  {
    code: 'local_path',
    pattern: /(?:file:\/\/\/|\/(?:Users|home|root|private|var|tmp|Volumes|Applications|Library|System|opt|srv|workspace|app|mnt)\/[^\s`"'<>]+|[A-Za-z]:\\[^\s`"'<>]+)/,
    message: '内容中出现了本机路径。',
  },
  {
    code: 'secret_like_value',
    pattern: /(?:\bsk-[A-Za-z0-9_-]{8,}\b|(?:api[_ -]?key|access[_ -]?token|authorization|cookie|password|app[_ -]?secret|client[_ -]?secret|pairing[_ -]?token|token|secret|密钥|令牌|密码)\s*[:=：]\s*\S+)/i,
    message: '内容中出现了疑似密钥。',
  },
  {
    code: 'template_placeholder',
    pattern: /(?:\{\{[^{}]+\}\}|\$\{[^{}]+\}|\[(?:待补充|待填写|占位|placeholder)\]|<placeholder>|\b(?:TODO|TBD)\b)/i,
    message: '内容中还有未填写的模板占位符。',
  },
  {
    code: 'raw_exception',
    pattern: /(?:\n\s*at\s+|\b(?:TypeError|ReferenceError|SyntaxError|Unhandled|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\b)/i,
    message: '内容中出现了原始异常信息。',
  },
];

const WARNING_PATTERNS: LanguagePattern[] = [
  {
    code: 'formulaic_conclusion',
    pattern: /(?:综上所述|总而言之|由此可见)/,
    message: '结尾像模板总结，建议直接保留结论。',
  },
  {
    code: 'inflated_claim',
    pattern: /(?:标志着.{0,16}(?:关键|重要).{0,8}(?:时刻|转折)|不可磨灭的印记|不断演变的格局)/,
    message: '有一处结论被写得过大，建议改成具体事实。',
  },
  {
    code: 'negative_parallelism',
    pattern: /(?:不仅仅是|并非只是|不只是).{0,24}(?:更是|而是)/,
    message: '有一处否定式排比，建议直接说明判断。',
  },
  {
    code: 'mechanical_sequence',
    pattern: /首先[\s\S]{0,120}其次[\s\S]{0,120}(?:最后|再次)/,
    message: '段落像固定模板，建议按内容本身安排节奏。',
  },
  {
    code: 'unsupported_grand_claim',
    pattern: /(?:必将|彻底|全面).{0,16}(?:改变|颠覆|重塑).{0,12}(?:行业|所有人|世界)/,
    message: '有一处宏大结论缺少具体依据。',
  },
  {
    code: 'generic_platform_alias',
    pattern: /(?:长文平台|图文内容源|短视频内容源)/,
    message: '请直接写真实平台名称。',
  },
];

function findingsFor(text: string, patterns: LanguagePattern[]): GeneratedLanguageFinding[] {
  return patterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ code, message }) => ({ code, message }));
}

function repeatedSlopWarning(text: string): GeneratedLanguageFinding[] {
  const matches = text.match(/(?:赋能|沉淀|闭环|抓手|底层逻辑|全链路|关键洞察|持续优化)/g) || [];
  if (matches.length < 2) return [];
  return [{
    code: 'abstract_phrase_density',
    message: '抽象套话出现较多，建议换成具体动作或事实。',
  }];
}

function repeatedSentenceOpeningWarning(text: string): GeneratedLanguageFinding[] {
  const openings = (text.match(/[^。！？!?]+[。！？!?]?/g) || [])
    .map((sentence) => sentence.trim().replace(/^[\d一二三四五六七八九十]+[、.．]\s*/, '').slice(0, 4))
    .filter((opening) => opening.length >= 3);
  const counts = new Map<string, number>();
  for (const opening of openings) counts.set(opening, (counts.get(opening) || 0) + 1);
  if (![...counts.values()].some((count) => count >= 3)) return [];
  return [{
    code: 'repeated_sentence_opening',
    message: '多个句子用相同方式起头，建议调整节奏。',
  }];
}

export function inspectGeneratedLanguage(value: unknown, voiceValue?: unknown): GeneratedLanguageReview {
  const text = typeof value === 'string' ? value : '';
  const voiceText = voiceValue === undefined
    ? text
    : typeof voiceValue === 'string' ? voiceValue : '';
  return {
    blocking: findingsFor(text, BLOCKING_PATTERNS),
    warnings: [
      ...findingsFor(voiceText, WARNING_PATTERNS),
      ...repeatedSlopWarning(voiceText),
      ...repeatedSentenceOpeningWarning(voiceText),
    ],
  };
}

export type HumanizedCopyScore = {
  directness: number;
  naturalRhythm: number;
  credibility: number;
  authenticity: number;
  concision: number;
  total: number;
};

function boundedScore(deductions: number): number {
  return Math.max(0, 10 - deductions);
}

/** A deterministic 50-point guard for interface copy; it never calls a model. */
export function scoreHumanizedInterfaceCopy(lines: readonly string[]): HumanizedCopyScore {
  const text = lines.join('\n').trim();
  const sentences = text.match(/[^。！？!?\n]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) || [];
  const abstractCount = (text.match(/(?:赋能|沉淀|闭环|抓手|底层逻辑|全链路|智能洞察|机制蒸馏)/g) || []).length;
  const metaCount = (text.match(/(?:作为(?:一个|一名)?\s*(?:AI|人工智能)|希望以上内容|如果你需要我可以)/g) || []).length;
  const mechanicalCount = (text.match(/(?:首先|其次|再次|最后|综上所述|总而言之)/g) || []).length;
  const hypeCount = (text.match(/(?:行业领先|颠覆|革命性|完美|保证|必然|必将|彻底改变)/g) || []).length;
  const fakePlatformCount = (text.match(/(?:长文平台|图文内容源|短视频内容源)/g) || []).length;
  const longSentenceCount = sentences.filter((sentence) => sentence.length > 64).length;
  const repeatedLineCount = lines.length - new Set(lines.map((line) => line.trim()).filter(Boolean)).size;

  const directness = boundedScore(Math.min(10, abstractCount * 2 + metaCount * 3));
  const naturalRhythm = boundedScore(Math.min(10, mechanicalCount + (repeatedSentenceOpeningWarning(text).length ? 2 : 0)));
  const credibility = boundedScore(Math.min(10, hypeCount * 2));
  const authenticity = boundedScore(Math.min(10, fakePlatformCount * 3 + metaCount * 2));
  const concision = boundedScore(Math.min(10, longSentenceCount * 2 + Math.max(0, repeatedLineCount) * 2));
  return {
    directness,
    naturalRhythm,
    credibility,
    authenticity,
    concision,
    total: directness + naturalRhythm + credibility + authenticity + concision,
  };
}

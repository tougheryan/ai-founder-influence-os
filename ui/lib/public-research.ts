import { writeOutputFile } from './output-files';
import { buildBaoyuVisualLayer } from './baoyu-visual-layer';
import { inspectGeneratedLanguage, type GeneratedLanguageFinding } from './product-voice';
import { KnownUserFacingError } from './user-facing-error';

export type ResearchLanguageWarning = GeneratedLanguageFinding;

export function assertGeneratedResearchLanguage(
  markdown: string,
  action: { label: string; href: string } = { label: '重新生成', href: '/production' },
): ResearchLanguageWarning[] {
  const review = inspectGeneratedLanguage(markdown);
  if (review.blocking.length) {
    throw new KnownUserFacingError({
      error: '生成结果里还有未处理的占位内容或敏感信息，尚未保存。请重新生成。',
      code: 'research_language_blocked',
      action,
    }, { status: 422, detail: { blockingCodes: review.blocking.map((item) => item.code) } });
  }
  return review.warnings;
}

export type PublicResearchMode = 'broad' | 'precision';

export type PublicEvidenceKind =
  | 'official'
  | 'company_background'
  | 'industry_context'
  | 'benchmark_sample'
  | 'policy_or_data'
  | 'weak_reference';

export type PublicEvidenceSource = {
  query: string;
  title: string;
  url: string;
  snippet: string;
  evidenceType: PublicEvidenceKind;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  confidenceReasons: string[];
  matchedGaps: string[];
};

export type PublicEvidenceReport = {
  path: string;
  queries: string[];
  sources: PublicEvidenceSource[];
  status: 'pass' | 'review_required' | 'no_results';
  markdown: string;
  languageWarnings: ResearchLanguageWarning[];
};

type RawPublicEvidenceSource = Pick<PublicEvidenceSource, 'query' | 'title' | 'url' | 'snippet'>;

export type ExplorationAngleReport = {
  path: string;
  status: 'draft_only' | 'needs_first_party_evidence' | 'ready_for_revalidate';
  markdown: string;
  candidateCount: number;
  languageWarnings: ResearchLanguageWarning[];
};

export type LowEvidencePassagePlanReport = {
  path: string;
  status: 'reframe_possible' | 'manual_required';
  markdown: string;
  recommendedRoute: string;
  languageWarnings: ResearchLanguageWarning[];
};

export type RepairedValidateReport = {
  markdown: string;
  title: string;
  route: string;
  platform: string;
};

export type RepairedAngleReport = {
  markdown: string;
  title: string;
  platform: string;
  angleCount: number;
};

export type RepairedBreakdownReport = {
  markdown: string;
  title: string;
  selectedAngle: string;
  platform: string;
};

export type RepairedDraftStep = 'write' | 'xhs';

export type RepairedDraftReport = {
  markdown: string;
  title: string;
  step: RepairedDraftStep;
  platform: string;
};

export type RepairedVisualReport = {
  markdown: string;
  title: string;
  platform: string;
  assetCount: number;
};

const SEARCH_TIMEOUT_MS = 10000;
const MAX_QUERIES = 10;
const MAX_RESULTS_PER_QUERY = 4;
const PLATFORM_LABELS: Record<string, string> = {
  wechat: '公众号',
  weixin: '公众号',
  xhs: '小红书',
  xiaohongshu: '小红书',
  rednote: '小红书',
  shipinhao: '视频号',
  channels: '视频号',
  douyin: '抖音',
  tiktok: '抖音',
  moments: '朋友圈',
};

function platformLabel(value: string): string {
  return PLATFORM_LABELS[value.trim().toLowerCase()] || value;
}

const TRUSTED_HOST_PARTS = [
  'gov.cn',
  'edu.cn',
  'ac.cn',
  '36kr.com',
  'huxiu.com',
  'tmtpost.com',
  'iyiou.com',
  'cyzone.cn',
  'qcc.com',
  'tianyancha.com',
  'weixin.qq.com',
  'xiaohongshu.com',
];

function compactText(value: string, max = 1200): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function stripMarkdown(value: string): string {
  const reportStart = value.search(/^#\s+(?:素材理解|选题立项|角度生成|公开补证).+$/m);
  const body = reportStart >= 0 ? value.slice(reportStart) : value;
  return body
    .replace(/^---[\s\S]*?---/m, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_[\]()`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeSlug(value: string): string {
  return (value || 'public-evidence')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'public-evidence';
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)));
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDuckDuckGoUrl(value: string): string {
  const decoded = decodeHtml(value);
  try {
    const parsed = new URL(decoded, 'https://duckduckgo.com/');
    const redirected = parsed.searchParams.get('uddg');
    return redirected ? decodeURIComponent(redirected) : decoded;
  } catch {
    return decoded;
  }
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function sectionBody(content: string, heading: string): string {
  const lines = content.split('\n');
  const headingRe = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const start = lines.findIndex((line) => headingRe.test(line.trim()));
  if (start < 0) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

function extractTitle(content: string): string {
  const title = content.match(/^#\s+(.+)$/m)?.[1]
    || content.match(/选题[：:]\s*(.+)$/m)?.[1]
    || content.match(/主题[：:]\s*(.+)$/m)?.[1]
    || '';
  return compactText(title, 80);
}

function tokenizeEvidenceText(value: string): string[] {
  return unique(
    value
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && item.length <= 18),
    String,
  ).slice(0, 10);
}

function extractChineseEntities(content: string): string[] {
  const text = stripMarkdown(content);
  const candidates = new Set<string>();
  const blocked = ['所有公司', '所有提及', '公开发布', '公司名称', '公开信息', '目标公司', '身份是', '具备大厂', '希望将', '项目转向', '自媒体与'];
  const patterns = [
    /[\u4e00-\u9fa5A-Za-z0-9·]{2,24}(?:集团|公司|品牌|科技|智能|鞋业|蕲艾|经销商|代理商|出海|自媒体|AI\s*Agent|Agent|OS)/g,
    /(?:AI\s*Agent|企业\s*AI|企业服务|出海营销|海外自媒体|经销商渠道|实体企业转型)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/\s+/g, ' ').trim();
      if (
        value.length >= 2 &&
        value.length <= 30 &&
        !/^[AB][从与把将]/.test(value) &&
        !/[与和].*(?:AI\s*Agent|Agent)$/.test(value) &&
        !/(?:转向|提供|补全|处于|来自|作为|不能|输出|通过|判断|建议|缺乏|具有|用于|必须|严重|密集)/.test(value) &&
        !blocked.some((item) => value.includes(item))
      ) {
        candidates.add(value);
      }
    }
  }

  return Array.from(candidates).slice(0, 8);
}

function extractEvidenceGaps(content: string): string[] {
  const gapSections = [
    sectionBody(content, '5. 素材补充清单'),
    sectionBody(content, '6. 风险提示'),
    sectionBody(content, '5. 仍不能替代的部分'),
    sectionBody(content, '事实边界'),
    sectionBody(content, '证据缺口'),
  ].filter(Boolean);
  const source = gapSections.join('\n') || content;
  const blocked = ['如果通过', '如果有条件通过', '如果不通过', '进入', '下一步', '无', '暂无'];
  const candidates: string[] = [];

  for (const rawLine of source.split('\n')) {
    const line = rawLine
      .replace(/^[-*]\s*\[\s?\]\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/^\d+[.)、]\s*/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (
      line.length >= 6 &&
      line.length <= 120 &&
      !blocked.some((item) => line.includes(item)) &&
      /(?:补|缺|核实|验证|来源|授权|数据|案例|截图|事实|公开|对标|转化|成交|ROI|客户|证据)/i.test(line)
    ) {
      candidates.push(line);
    }
  }

  return unique(candidates, String).slice(0, 8);
}

function compactGapKeyword(gap: string): string {
  const tokens = tokenizeEvidenceText(gap).filter((token) => !/^(需要|补充|核实|验证|是否|提供|具体|相关|真实)$/.test(token));
  return tokens.slice(0, 4).join(' ') || compactText(gap, 32);
}

export function buildEvidenceQueries(input: {
  sourceContent: string;
  topic?: string;
  platforms?: string[];
  mode?: PublicResearchMode;
}): string[] {
  const mode = input.mode || 'precision';
  const title = input.topic?.trim() || extractTitle(input.sourceContent);
  const entities = extractChineseEntities(input.sourceContent);
  const gaps = extractEvidenceGaps(input.sourceContent);
  const platformLabels = (input.platforms || [])
    .map((platform) => platformLabel(platform))
    .join(' ');
  const baseTopic = title || entities.slice(0, 2).join(' ') || '创业 内容制作';
  const exactTitle = title ? `"${title}"` : '';
  const primaryEntity = entities[0] || baseTopic;

  const precisionQueries = [
    exactTitle ? `${exactTitle} 公开信息 来源` : '',
    ...entities.slice(0, 3).flatMap((entity) => [
      `"${entity}" 官网 关于我们`,
      `"${entity}" 新闻 采访 案例`,
    ]),
    ...gaps.slice(0, 3).map((gap) => `${baseTopic} ${compactGapKeyword(gap)} 公开资料 来源`),
    `${baseTopic} 行业报告 数据 趋势`,
    `${baseTopic} site:36kr.com OR site:huxiu.com OR site:tmtpost.com`,
    platformLabels ? `${baseTopic} ${platformLabels} 对标 标题 案例 评论` : '',
    `${primaryEntity} 企查查 天眼查 公司 背景`,
  ];

  const broadQueries = [
    title ? `${title} 公开信息` : '',
    ...entities.slice(0, 3).map((entity) => `${entity} 公开信息 公司 背景`),
    `${baseTopic} 行业数据 公开资料`,
    `${baseTopic} 案例 公开资料`,
    platformLabels ? `${baseTopic} ${platformLabels} 对标 爆款 案例` : '',
  ];

  return unique((mode === 'precision' ? precisionQueries : broadQueries).filter(Boolean), String).slice(0, MAX_QUERIES);
}

async function fetchWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 Echo-Founder/0.2.0-beta.2 research-assistant',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function classifyEvidenceType(source: RawPublicEvidenceSource): PublicEvidenceKind {
  const text = `${source.query} ${source.title} ${source.snippet}`.toLowerCase();
  const host = hostOf(source.url);
  if (/官网|官方|关于我们|公司简介/.test(text)) return 'official';
  if (/企查查|天眼查|公司|集团|品牌|业务|融资/.test(text)) return 'company_background';
  if (/对标|爆款|标题|封面|评论|公众号|小红书/.test(text)) return 'benchmark_sample';
  if (/政策|白皮书|报告|数据|统计|行业|趋势|研究/.test(text) || /gov\.cn|edu\.cn|ac\.cn/.test(host)) return 'policy_or_data';
  if (/36kr|huxiu|tmtpost|iyiou|cyzone/.test(host)) return 'industry_context';
  return 'weak_reference';
}

function enrichSource(
  source: RawPublicEvidenceSource,
  context: { sourceContent: string; topic?: string; gaps: string[]; entities: string[] },
): PublicEvidenceSource {
  const haystack = `${source.title} ${source.snippet} ${source.url}`.toLowerCase();
  const host = hostOf(source.url);
  let score = 20;
  const reasons: string[] = [];
  const matchedGaps = context.gaps.filter((gap) => {
    const tokens = tokenizeEvidenceText(gap);
    return tokens.length > 0 && tokens.some((token) => haystack.includes(token.toLowerCase()));
  }).slice(0, 3);

  if (TRUSTED_HOST_PARTS.some((part) => host.includes(part))) {
    score += 25;
    reasons.push('来源域名相对可信');
  }

  if (/官网|官方|关于我们|公司简介/.test(`${source.title} ${source.snippet}`)) {
    score += 20;
    reasons.push('疑似官方/公司背景来源');
  }

  const entityHits = context.entities.filter((entity) => haystack.includes(entity.toLowerCase()));
  if (entityHits.length > 0) {
    score += Math.min(25, entityHits.length * 10);
    reasons.push(`命中实体：${entityHits.slice(0, 2).join('、')}`);
  }

  const topicTokens = tokenizeEvidenceText(context.topic || extractTitle(context.sourceContent));
  const topicHits = topicTokens.filter((token) => haystack.includes(token.toLowerCase()));
  if (topicHits.length > 0) {
    score += Math.min(15, topicHits.length * 5);
    reasons.push('命中选题关键词');
  }

  if (matchedGaps.length > 0) {
    score += Math.min(25, matchedGaps.length * 12);
    reasons.push('命中素材缺口');
  }

  if (/zhihu\.com|sohu\.com|baijiahao|toutiao/.test(host)) {
    score -= 10;
    reasons.push('平台内容需二次核验');
  }

  const confidenceScore = Math.max(0, Math.min(100, score));
  return {
    ...source,
    evidenceType: classifyEvidenceType(source),
    confidenceScore,
    confidence: confidenceScore >= 70 ? 'high' : confidenceScore >= 45 ? 'medium' : 'low',
    confidenceReasons: reasons.length ? reasons : ['仅作为弱公开线索'],
    matchedGaps,
  };
}

async function searchPublicWeb(query: string): Promise<RawPublicEvidenceSource[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchWithTimeout(url);
  const results: RawPublicEvidenceSource[] = [];
  const resultRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>|<div[^>]+class="result__snippet"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/g;

  for (const match of html.matchAll(resultRe)) {
    const source = {
      query,
      title: stripTags(match[2]),
      url: decodeDuckDuckGoUrl(match[1]),
      snippet: stripTags(match[3]),
    };
    if (source.title && source.url) results.push(source);
    if (results.length >= MAX_RESULTS_PER_QUERY) break;
  }

  return results;
}

function sourceRows(sources: PublicEvidenceSource[]): string {
  if (!sources.length) return '| 查询 | 证据类型 | 可信度 | 标题 | 来源 | 摘要 |\n|---|---|---|---|---|---|\n| 无结果 | - | - | - | - | 本轮未收集到可用公开搜索结果。 |';
  return [
    '| 查询 | 证据类型 | 可信度 | 标题 | 来源 | 摘要 |',
    '|---|---|---|---|---|---|',
    ...sources.map((source) => `| ${source.query.replace(/\|/g, ' ')} | ${source.evidenceType} | ${source.confidence} ${source.confidenceScore} | ${source.title.replace(/\|/g, ' ')} | ${source.url} | ${source.snippet.replace(/\|/g, ' ')} |`),
  ].join('\n');
}

function evidenceMatrixRows(gaps: string[], sources: PublicEvidenceSource[]): string {
  if (!gaps.length) {
    return '| 缺口 | 命中情况 | 可用性 |\n|---|---|---|\n| 未识别到明确缺口 | - | 仅作为背景补证 |';
  }

  return [
    '| 缺口 | 命中情况 | 可用性 |',
    '|---|---|---|',
    ...gaps.map((gap) => {
      const matched = sources.filter((source) => source.matchedGaps.includes(gap));
      const highOrMedium = matched.filter((source) => source.confidence !== 'low');
      const usability = highOrMedium.length > 0
        ? '可作为公开背景/对标线索'
        : '仍需用户提供一手素材或人工核验';
      return `| ${gap.replace(/\|/g, ' ')} | ${matched.length ? `${matched.length} 条公开线索` : '暂无直接命中'} | ${usability} |`;
    }),
  ].join('\n');
}

export function buildPublicEvidenceMarkdown(input: {
  sourcePath: string;
  sourceContent: string;
  topic?: string;
  mode?: PublicResearchMode;
  queries: string[];
  sources: PublicEvidenceSource[];
}): { markdown: string; status: PublicEvidenceReport['status'] } {
  const strongSources = input.sources.filter((source) => source.confidence !== 'low');
  const status: PublicEvidenceReport['status'] = strongSources.length >= 4
    ? 'pass'
    : input.sources.length > 0
      ? 'review_required'
      : 'no_results';
  const sourceSummary = compactText(stripMarkdown(input.sourceContent), 900);
  const gaps = extractEvidenceGaps(input.sourceContent);
  const today = new Date().toISOString();

  const markdown = `# 公开补证报告 · ${input.topic?.trim() || extractTitle(input.sourceContent) || '未命名选题'}

## 0. 补证对象
- 上游文件：${input.sourcePath}
- 生成时间：${today}
- 补证状态：${status}
- 检索模式：${input.mode || 'precision'}
- 补证原则：只采集公开可见网页信息；不把搜索摘要当成一手业务数据；不替代客户授权、成交数据、ROI、未公开合作细节。

## 1. 上游摘要
${sourceSummary}

## 2. 检索问题
${input.queries.map((query) => `- ${query}`).join('\n') || '- 未生成有效查询'}

## 3. 公开来源摘录
${sourceRows(input.sources)}

## 4. 证据缺口命中矩阵
${evidenceMatrixRows(gaps, input.sources)}

## 5. 可以补足的部分
- 公司、品牌、行业、平台玩法等公开背景信息。
- 同主题内容的公开表达方式、标题机制、平台适配和对标方向。
- 已公开的政策、行业趋势、产品定义和通用案例。

## 6. 仍不能替代的部分
- 用户自己的真实成交、播放量、ROI、客户转化和项目结果。
- 未公开合作关系、合作条款、客户授权、聊天截图、内部报价。
- 涉及个人隐私、商业机密或争议对象的事实判断。

## 7. 给 content-validate 的使用说明
- 如果原本阻断项只是“公开背景不足 / 行业参照不足 / 对标样本不足”，可结合本报告重新判断。
- 如果原本阻断项是一手业务数据、客户案例授权、真实转化结果缺失，不能只靠公开资料改成通过。
- 可以把公开资料用于缩小表达边界：从“案例已证明”降级为“行业观察 + 待验证合作假设”。

## 8. 给 content-angle 的使用说明
- 角度生成只能引用本报告中的公开来源作为背景或平台语境。
- 素材证据仍应优先来自 intake/validate 中的一手素材。
- 风险点必须保留“公开资料未能证明的业务结果”。`;

  return { markdown, status };
}

export async function createPublicEvidenceReport(input: {
  sourcePath: string;
  sourceContent: string;
  slug: string;
  topic?: string;
  platforms?: string[];
  mode?: PublicResearchMode;
}): Promise<PublicEvidenceReport> {
  const mode = input.mode || 'precision';
  const queries = buildEvidenceQueries({
    sourceContent: input.sourceContent,
    topic: input.topic,
    platforms: input.platforms,
    mode,
  });
  const batches = await Promise.allSettled(queries.map((query) => searchPublicWeb(query)));
  const gaps = extractEvidenceGaps(input.sourceContent);
  const entities = extractChineseEntities(input.sourceContent);
  const sources = unique(
    batches.flatMap((batch) => batch.status === 'fulfilled' ? batch.value : []),
    (source) => source.url,
  )
    .map((source) => enrichSource(source, {
      sourceContent: input.sourceContent,
      topic: input.topic,
      gaps,
      entities,
    }))
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, 18);
  const { markdown, status } = buildPublicEvidenceMarkdown({
    sourcePath: input.sourcePath,
    sourceContent: input.sourceContent,
    topic: input.topic,
    mode,
    queries,
    sources,
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const path = `materials/research/${stamp}-${sanitizeSlug(input.slug)}-public-evidence.md`;
  const languageWarnings = assertGeneratedResearchLanguage(markdown, { label: '重新补充资料', href: '/production?stage=2' });
  await writeOutputFile(path, markdown);
  return { path, queries, sources, status, markdown, languageWarnings };
}

function sourceBulletList(content: string, max = 5): string[] {
  const rows = content
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.includes('---') && !line.includes('查询 |'))
    .slice(0, max);
  return rows.map((row) => {
    const cells = row.split('|').map((cell) => cell.trim()).filter(Boolean);
    const title = cells[3] || cells[1] || '公开线索';
    const url = cells[4] || cells[2] || '';
    return url ? `${title}（${url}）` : title;
  });
}

function detectValidateStatus(content: string): string {
  return content.match(/(?:决策|立项结论)(?:\*\*)?\s*[：:]\s*(有条件通过|不通过|通过)/)?.[1]
    || content.match(/有条件通过|不通过|通过/)?.[0]
    || '未识别';
}

function lineField(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.match(new RegExp(`^\\s*[-*]\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[：:]\\s*(.+?)\\s*$`, 'm'))?.[1]?.trim() || '';
}

function normalizePlatformLabel(value: string, platforms?: string[]): string {
  const raw = value || platforms?.[0] || 'wechat';
  if (/xhs|xiaohongshu|rednote|小红书/i.test(raw)) return '小红书';
  if (/shipinhao|channels|视频号/i.test(raw)) return '视频号';
  if (/douyin|tiktok|抖音/i.test(raw)) return '抖音';
  if (/moments|朋友圈/i.test(raw)) return '朋友圈';
  return '公众号';
}

function marketSignalSummary(content: string): {
  status: '已完成' | '样本不足' | '创作模式';
  sampleCount: number;
} {
  const declaredCount = lineField(content, '样本数量')
    || lineField(content, '可验证样本数')
    || lineField(content, '公开样本数');
  const parsedCount = declaredCount.match(/\d+/)?.[0];
  const sampleCount = parsedCount ? Number.parseInt(parsedCount, 10) : 0;
  const declaredStatus = lineField(content, '公开样本状态') || lineField(content, '公开样本对标状态');
  if (/创作模式|公开样本(?:暂不可用|不可用)|creator[\s_-]*mode/i.test(declaredStatus)) {
    return { status: '创作模式', sampleCount };
  }
  if (/样本不足|sample[\s_-]*insufficient|未取得(?:可验证)?公开样本/i.test(declaredStatus)) {
    return { status: '样本不足', sampleCount };
  }
  return sampleCount > 0
    ? { status: '已完成', sampleCount }
    : { status: '样本不足', sampleCount };
}

function visibleTitle(input: { topic?: string; sourceContent: string; passagePlanContent?: string }): string {
  const fromPlan = input.passagePlanContent?.match(/^#\s+低证据通行方案\s*·\s*(.+)$/m)?.[1]?.trim();
  return input.topic?.trim() || fromPlan || extractTitle(input.sourceContent) || '未命名选题';
}

function buildAngleCards(input: {
  topic: string;
  sourceContent: string;
  validateContent: string;
  researchContent: string;
  platforms?: string[];
}): string {
  const gaps = extractEvidenceGaps(`${input.validateContent}\n${input.sourceContent}`).slice(0, 6);
  const sources = sourceBulletList(input.researchContent, 6);
  const platforms = (input.platforms && input.platforms.length ? input.platforms : ['wechat'])
    .map((platform) => platformLabel(platform))
    .join(' / ');
  const topic = input.topic || extractTitle(input.sourceContent) || '当前选题';
  const gap = (index: number) => gaps[index % Math.max(gaps.length, 1)] || '补充一手案例、数据、授权或关键原话';
  const publicSource = (index: number) => sources[index % Math.max(sources.length, 1)] || '暂无高置信公开来源，需继续精搜或人工补充';

  const cards = [
    ['行业观察', `把“${topic}”降级为行业变化观察，先讲公开趋势，再回到用户自己的待验证判断。`],
    ['反差冲突', '从“看似能直接写案例”切到“为什么缺少一手证据反而暴露了真正问题”。'],
    ['方法论预告', '不讲确定成绩，只输出一套可验证的问题清单和判断标准。'],
    ['人物/访谈切口', '以访谈者的真实认知变化为主线，避开未经授权的客户结果。'],
    ['参考内容拆解', '比较同类内容的标题、开头和评论需求，先确认平台上的表达方向。'],
    ['补证招募', '把内容做成一次征集：邀请用户补案例、提问题、参与诊断。'],
  ];

  return cards.map(([name, hypothesis], index) => `### 预研角度 ${index + 1}：${name}
- **表达假设**：${hypothesis}
- **可暂用证据**：${publicSource(index)}
- **一手素材缺口**：${gap(index)}
- **适合平台**：${platforms}
- **下一步补证动作**：围绕该角度补 1 条可公开原话、1 个真实场景、1 个可核验结果或授权说明。
- **当前状态**：可以先讨论；资料补齐前不进入正式写作。`).join('\n\n');
}

export async function createExplorationAngleReport(input: {
  sourcePath: string;
  sourceContent: string;
  slug: string;
  topic?: string;
  platforms?: string[];
  validateReportPath?: string;
  validateContent?: string;
  researchReportPath?: string;
  researchContent?: string;
}): Promise<ExplorationAngleReport> {
  const topic = input.topic?.trim() || extractTitle(input.sourceContent) || '未命名选题';
  const validateContent = input.validateContent || '';
  const researchContent = input.researchContent || '';
  const decision = detectValidateStatus(validateContent);
  const gaps = extractEvidenceGaps(`${validateContent}\n${input.sourceContent}`);
  const sources = sourceBulletList(researchContent, 8);
  const candidateCount = 6;
  const firstPartyMissing = gaps.some((gap) => /客户|成交|ROI|授权|截图|转化|真实|内部|合作/.test(gap));
  const status: ExplorationAngleReport['status'] = firstPartyMissing
    ? 'needs_first_party_evidence'
    : decision === '有条件通过' && sources.length >= 3
      ? 'ready_for_revalidate'
      : 'draft_only';
  const sourceSummary = compactText(stripMarkdown(input.sourceContent), 700);
  const validateSummary = validateContent ? compactText(stripMarkdown(validateContent), 700) : '未提供选题检查结果。';
  const searchQueries = buildEvidenceQueries({
    sourceContent: `${input.sourceContent}\n${validateContent}`,
    topic,
    platforms: input.platforms,
    mode: 'precision',
  });
  const markdown = `# 预研角度与补证路线 · ${topic}

## 0. 状态边界
- 产物性质：预研草稿，不是正式 \`content-angle\` 角度报告。
- 当前选题结论：${decision}
- 当前状态：${status}
- 上游素材：${input.sourcePath}
- 选题检查结果：${input.validateReportPath || '未提供'}
- 公开补证报告：${input.researchReportPath || '未提供'}
- 推进规则：这份报告用于继续判断方向和补资料，不能直接跳到正式写作。

## 1. 上游摘要
${sourceSummary}

## 2. 选题暂未通过的原因
${validateSummary}

## 3. 证据缺口
${gaps.length ? gaps.map((gap) => `- ${gap}`).join('\n') : '- 未识别到明确缺口；建议人工确认事实边界、案例授权和商业承接。'}

## 4. 已有公开线索
${sources.length ? sources.map((source) => `- ${source}`).join('\n') : '- 暂无可用公开线索；建议先补充实体名、公司名、产品名、客户行业或平台关键词。'}

## 5. 可探索角度
${buildAngleCards({
    topic,
    sourceContent: input.sourceContent,
    validateContent,
    researchContent,
    platforms: input.platforms,
  })}

## 6. 高精度补证检索建议
${searchQueries.map((query) => `- ${query}`).join('\n')}

## 7. 如何继续
- 如果公开资料已能补足“行业背景 / 公司背景 / 平台参考”，请重新检查选题。
- 如果缺口是“客户授权 / 成交数据 / ROI / 内部截图 / 未公开合作”，必须先让用户补一手素材。
- 补齐后正式生成角度时，每个角度仍需写明素材证据、商业承接和风险边界。`;

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const path = `materials/research/${stamp}-${sanitizeSlug(input.slug)}-angle-exploration.md`;
  const languageWarnings = assertGeneratedResearchLanguage(markdown, { label: '重新生成备选角度', href: '/production?stage=2' });
  await writeOutputFile(path, markdown);
  return { path, status, markdown, candidateCount, languageWarnings };
}

function routeForLowEvidence(gaps: string[], platforms?: string[]): { route: string; platform: string; reason: string } {
  const joined = gaps.join(' ');
  const wantsXhs = platforms?.includes('xiaohongshu') || platforms?.includes('xhs');
  if (/授权|客户|成交|ROI|截图|内部|合作|转化/.test(joined)) {
    return {
      route: '行业观察 + 方法论清单',
      platform: wantsXhs ? 'xiaohongshu' : 'wechat',
      reason: '缺一手结果证据时，改写为观察和判断标准，避免把未核验案例写成证明。',
    };
  }
  if (/公开|对标|平台|评论|样本/.test(joined)) {
    return {
      route: '公开对标拆解',
      platform: wantsXhs ? 'xiaohongshu' : 'wechat',
    reason: '缺口集中在公开参考，可先比较同类内容的标题、开头和互动方式。',
    };
  }
  return {
    route: '访谈观点整理 + 问题征集',
    platform: wantsXhs ? 'xiaohongshu' : 'wechat',
    reason: '缺少硬证据时保留一手观点和问题意识，把商业目标降级为线索收集。',
  };
}

function claimRewriteRows(gaps: string[]): string {
  const defaultRows = [
    ['证明客户结果', '提出待验证的行业观察', '不能写成交、ROI、客户成功，只能写观察到的问题和判断标准'],
    ['具体品牌案例', '匿名场景或公开资料背景', '品牌名、人名、合作关系未授权时必须匿名化'],
    ['商业转化承诺', '邀请诊断/征集问题', '商业目标从成交降级为线索收集和需求验证'],
  ];
  const rows = gaps.slice(0, 5).map((gap) => {
    if (/ROI|成交|转化|客户|结果/.test(gap)) {
      return [gap, '删除结果证明，改成“可验证指标清单”', '不得暗示该结果已经发生'];
    }
    if (/授权|截图|内部|合作|品牌|人名/.test(gap)) {
      return [gap, '匿名化、区间化、只保留业务场景', '不得暴露未授权对象'];
    }
    if (/公开|对标|行业|平台/.test(gap)) {
      return [gap, '用公开来源作为背景，不作为用户成绩', '引用时标明公开来源和不确定性'];
    }
    return [gap, '改成待验证问题或采访提纲', '不写成既成事实'];
  });

  return [
    '| 原高风险表达 | 降级后表达 | 通行边界 |',
    '|---|---|---|',
    ...(rows.length ? rows : defaultRows).map((row) => `| ${row.map((cell) => cell.replace(/\|/g, ' ')).join(' | ')} |`),
  ].join('\n');
}

export async function createLowEvidencePassagePlanReport(input: {
  sourcePath: string;
  sourceContent: string;
  slug: string;
  topic?: string;
  platforms?: string[];
  validateReportPath?: string;
  validateContent?: string;
  researchReportPath?: string;
  researchContent?: string;
  explorationReportPath?: string;
  explorationContent?: string;
}): Promise<LowEvidencePassagePlanReport> {
  const topic = input.topic?.trim() || extractTitle(input.sourceContent) || '未命名选题';
  const validateContent = input.validateContent || '';
  const researchContent = input.researchContent || '';
  const explorationContent = input.explorationContent || '';
  const gaps = extractEvidenceGaps(`${validateContent}\n${explorationContent}\n${input.sourceContent}`);
  const firstPartyMissing = gaps.some((gap) => /客户|成交|ROI|授权|截图|转化|真实|内部|合作/.test(gap));
  const route = routeForLowEvidence(gaps, input.platforms);
  const publicSources = sourceBulletList(researchContent, 6);
  const status: LowEvidencePassagePlanReport['status'] = firstPartyMissing || publicSources.length > 0
    ? 'reframe_possible'
    : 'manual_required';
  const sourceSummary = compactText(stripMarkdown(input.sourceContent), 650);
  const validateSummary = validateContent ? compactText(stripMarkdown(validateContent), 650) : '未提供选题检查结果。';
  const markdown = `# 低证据通行方案 · ${topic}

## 0. 方案结论
- 方案状态：${status}
- 推荐低风险路线：${route.route}
- 推荐首发平台：${route.platform}
- 推荐理由：${route.reason}
- 上游素材：${input.sourcePath}
- 选题检查结果：${input.validateReportPath || '未提供'}
- 公开补证报告：${input.researchReportPath || '未提供'}
- 预研角度报告：${input.explorationReportPath || '未提供'}

## 1. 通行原则
- 不补硬证据时，不能继续走“案例证明 / 成果宣称 / 客户背书”路线。
- 可以改走“行业观察 / 方法论清单 / 访谈观点整理 / 问题征集 / 公开对标拆解”路线。
- 商业目标从“证明我能带来结果”降级为“建立认知信任、收集需求、邀请诊断、征集可公开案例”。
- 所有 ROI、成交、客户授权、内部截图、合作细节必须删除、匿名化或写成待验证问题。

## 2. 原始素材摘要
${sourceSummary}

## 3. 原选题暂未通过的原因
${validateSummary}

## 4. 不补素材时的改写边界
${claimRewriteRows(gaps)}

## 5. 可以继续使用的内容
- 一手观点、对谈中的判断、问题意识、方法框架。
- 已公开来源中的行业背景、平台语境、公司公开信息和对标样本。
- 未经验证的业务结果只能作为“待验证问题”，不能作为“已验证案例”。
${publicSources.length ? publicSources.map((source) => `- 公开线索：${source}`).join('\n') : '- 暂无可用公开线索，建议补充更明确的实体或行业关键词。'}

## 6. 重新检查选题时要说明什么
请带着这份方案重新检查选题：

- 选题类型改为：${route.route}
- 首发平台改为：${route.platform}
- 允许进入下一步的条件：HKR 至少两项达到 3 星以上，商业承接为诊断/征集/关注/资料领取，不承诺客户结果。
- 必须写入风险提示：本内容不证明具体客户成果；所有未授权案例均匿名化；公开资料只作为背景。
- 如果仍保留 ROI、客户转化、具体品牌合作、授权截图等硬证明口吻，则不得通过。

## 7. 给 content-angle 的约束
- 只能生成低证据角度：行业观察、方法论清单、访谈观点、问题征集、公开对标。
- 每个角度的“素材证据”必须标明来源类型：一手观点 / 公开背景 / 待验证假设。
- 不得生成案例纪实或客户证明型角度，除非用户后续补齐授权和结果证据。`;

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const path = `materials/research/${stamp}-${sanitizeSlug(input.slug)}-passage-plan.md`;
  const languageWarnings = assertGeneratedResearchLanguage(markdown, { label: '重新生成资料方案', href: '/production?stage=2' });
  await writeOutputFile(path, markdown);
  return { path, status, markdown, recommendedRoute: route.route, languageWarnings };
}

export function buildRepairedValidateMarkdown(input: {
  sourcePath: string;
  sourceContent: string;
  passagePlanPath: string;
  passagePlanContent: string;
  marketSignalPath: string;
  marketSignalContent: string;
  researchReportPath?: string;
  explorationReportPath?: string;
  topic?: string;
  platforms?: string[];
}): RepairedValidateReport {
  const title = visibleTitle({
    topic: input.topic,
    sourceContent: input.sourceContent,
    passagePlanContent: input.passagePlanContent,
  });
  const route = lineField(input.passagePlanContent, '推荐低风险路线') || '行业观察 + 方法论清单';
  const platform = normalizePlatformLabel(lineField(input.passagePlanContent, '推荐首发平台'), input.platforms);
  const routeReason = lineField(input.passagePlanContent, '推荐理由') || '原证明型选题缺少一手证据，降级为低承诺表达后可安全进入角度生成。';
  const sourceSummary = compactText(stripMarkdown(input.sourceContent), 260);
  const contentType = platform.includes('小红书')
    ? '图文清单 / 公开对标拆解'
    : '深度观察 / 方法论文章';
  const secondaryPlatform = platform.includes('小红书') ? '公众号' : '小红书';
  const marketSignal = marketSignalSummary(input.marketSignalContent);
  if (marketSignal.status !== '已完成' || marketSignal.sampleCount < 3) {
    throw new Error('TikOmni 三平台研究证据不足，不能通过低证据修复绕过选题门禁。');
  }
  const marketBoundary = `已经核对 ${marketSignal.sampleCount} 条公开内容，只参考标题入口、文章结构和互动方式。`;
  const markdown = `# 选题立项报告 · ${title}（低证据降级版）

## 0. 素材来源
- intake 报告路径：${input.sourcePath}
- 主场景：访谈 / 业务观察 / 资料不足时的低风险写法
- 核心人物/观点/案例：${sourceSummary}
- 修复依据：${input.passagePlanPath}
- 公开样本对标报告：${input.marketSignalPath}
- 公开样本状态：${marketSignal.status}
- 可验证样本数：${marketSignal.sampleCount}
- 公开补证报告：${input.researchReportPath || '未提供'}
- 预研角度报告：${input.explorationReportPath || '未提供'}

## 1. 立项决策
- **决策**：通过
- **决策理由**：原选题不再写成“案例证明 / 成果宣称 / 客户背书”，已改为“${route}”；${routeReason} ${marketBoundary}
- **置信度**：中
- **是否允许进入下一步**：是

## 2. HKR 质检
| 维度 | 评分 | 说明 |
|------|------|------|
| H (Happy/有趣) | ⭐⭐⭐⭐ | 由“缺证据为什么不能硬写”切入，保留反差和冲突感，适合做低风险讨论。 |
| K (Knowledge/有信息量) | ⭐⭐⭐⭐ | 可以整理公开背景、方法清单、判断标准和同类内容分析，不依赖未授权客户结果。 |
| R (Resonance/有共鸣) | ⭐⭐⭐⭐ | 能回应创业者、业务负责人和内容创作者“想写但资料不足”的共同困境。 |

## 3. 商业成立性判断
- 目标是否空转：否，目标是用低风险内容建立认知信任，并收集用户问题和可公开案例线索。
- 商业模式是否成立：是，以诊断、咨询、资料领取、问题征集或案例征集承接，不承诺具体客户结果。
- 是否有产品/服务承接：是，可承接为内容诊断、AI/增长咨询、方法清单领取或访谈案例征集。
- 转化路径是否清晰：是，内容阅读/互动 → 评论或私信提交问题 → 初步诊断/咨询 → 后续服务或案例共创。

## 4. 平台首发策略
- **推荐首发平台**：${platform}
- **理由**：${platform}适合先发布${contentType}，用低证据表达测试用户问题和需求强度。
- **次发平台**：${secondaryPlatform}
- **不建议平台**：暂不建议以客户证明、案例纪实或成果宣称方式首发。

## 5. 素材补充清单
${marketSignal.status !== '已完成'
    ? '- [ ] 补采集同人群、同场景的公开样本并重新检索对标报告；未补齐前不能声称已完成爆款对标。'
    : `- [x] 已绑定公开样本对标报告，当前可验证样本数为 ${marketSignal.sampleCount} 条。`}
- [x] 已将证明型内容降级为“${route}”。
- [x] 已删除或禁止使用 ROI、成交、客户转化、授权截图、内部报价、未公开合作细节等硬证明口吻。
- [x] 已把商业承接降级为诊断、咨询、资料领取、问题征集或案例征集。
- [x] 已限制下游只生成低证据角度，不进入客户证明型写作。

## 6. 风险提示
${marketSignal.status !== '已完成'
    ? '- 公开样本不足，不能把检索词、模型推测或第三方指标称为爆款依据或已完成公开对标。'
    : '- 公开样本只用于机制比较，不能复制第三方标题、正文、图卡、镜头或评论原句。'}
- 不能写成具体客户结果、已验证商业成果、ROI 提升或成交转化证明。
- 公开补证只可作为行业背景、平台语境和对标线索，不能写成用户自己的业务成绩。
- 未授权品牌、人名、合作关系和内部细节必须匿名化、区间化或删除。
- 下游角度生成只能围绕行业观察、方法论清单、访谈观点、问题征集和公开对标拆解。

## 7. 下一步
- 进入 \`/content-angle\`。
- 角度生成必须继承“低证据降级通过”边界，只允许生成行业观察、方法论清单、访谈观点整理、问题征集或公开对标拆解角度。
- 不得进入案例纪实、客户证明、成果宣称、ROI 证明型角度，除非用户后续补齐一手授权和结果证据。`;

  return { markdown, title, route, platform };
}

function validateTitle(content: string): string {
  return content.match(/^#\s+选题立项报告\s*·\s*(.+)$/m)?.[1]?.trim()
    || content.match(/^#\s+(.+)$/m)?.[1]?.trim()
    || '未命名选题';
}

function firstUsefulLine(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim())
    .find((line) => line.length >= 8) || '';
}

function extractAngleInputs(validateContent: string, sourceContent: string, researchContent: string, platforms?: string[]) {
  const title = validateTitle(validateContent).replace(/（低证据降级版）$/, '');
  const platform = normalizePlatformLabel(
    lineField(validateContent, '推荐首发平台') || lineField(validateContent, '首发平台'),
    platforms,
  );
  const sourceEvidence = lineField(validateContent, '核心人物/观点/案例')
    || firstUsefulLine(sectionBody(validateContent, '0. 素材来源'))
    || compactText(stripMarkdown(sourceContent), 180);
  const riskBoundary = firstUsefulLine(sectionBody(validateContent, '6. 风险提示'))
    || '不能写客户结果、ROI、成交转化、未授权品牌关系或内部合作细节。';
  const publicSource = sourceBulletList(researchContent, 1)[0] || '公开补证报告中的行业背景和平台语境';
  const lowEvidence = /低证据降级|行业观察|方法论清单|问题征集|公开对标/.test(validateContent);
  return { title, platform, sourceEvidence, riskBoundary, publicSource, lowEvidence };
}

function angleCardMarkdown(input: {
  index: number;
  name: string;
  positioning: string;
  audience: string;
  evidence: string;
  emotion: string;
  differentiation: string;
  commercial: string;
  platform: string;
  risk: string;
}): string {
  return `### 角度 ${input.index}：${input.name}
- **一句话定位**：${input.positioning}
- **目标用户**：${input.audience}
- **素材证据**：${input.evidence}
- **情绪曲线**：${input.emotion}
- **差异化**：${input.differentiation}
- **商业承接**：${input.commercial}
- **适合平台**：${input.platform}
- **风险点**：${input.risk}`;
}

export function buildRepairedAngleMarkdown(input: {
  sourceContent: string;
  validateReportPath: string;
  validateContent: string;
  researchReportPath?: string;
  researchContent?: string;
  topic?: string;
  platforms?: string[];
}): RepairedAngleReport {
  const parsed = extractAngleInputs(input.validateContent, input.sourceContent, input.researchContent || '', input.platforms);
  const title = input.topic?.trim() || parsed.title;
  const sharedEvidence = `一手素材：${compactText(parsed.sourceEvidence, 180)}；公开背景：${compactText(parsed.publicSource, 140)}。`;
  const risk = `沿用选题的风险边界：${compactText(parsed.riskBoundary, 120)}；不写客户结果、ROI、成交转化或未授权合作细节。`;
  const platform = parsed.platform;
  const platformFit = platform.includes('小红书')
    ? '小红书图文 / 公众号复用'
    : '公众号长文 / 小红书复用';
  const angles = parsed.lowEvidence
    ? [
        angleCardMarkdown({
          index: 1,
          name: '行业观察',
          positioning: `把“${title}”改写为行业观察，讨论实体经营者为什么需要先解决被看见，再谈 AI 放大。`,
          audience: '实体企业老板、增长负责人、AI 转型服务者、内容操盘手。',
          evidence: sharedEvidence,
          emotion: '从焦虑和卡点进入，再给出可讨论的判断框架。',
          differentiation: '不写客户成功证明，而是拆“低证据也能安全表达”的观察逻辑。',
          commercial: '引导用户提交自己的行业、产品和获客问题，进入诊断或咨询。',
          platform: platformFit,
          risk,
        }),
        angleCardMarkdown({
          index: 2,
          name: '方法论清单',
          positioning: '输出一套判断清单：什么样的实体产品适合先做内容测试，再考虑 AI Agent 放大。',
          audience: '正在做转型、出海、内容获客或企业 AI 的创业者。',
          evidence: sharedEvidence,
          emotion: '从“想做但不知道从哪下手”转向“先用清单判断能不能做”。',
          differentiation: '用问题清单替代结果承诺，降低事实风险同时保留信息密度。',
          commercial: '承接为资料领取、评论区提问、低门槛内容诊断。',
          platform: platformFit,
          risk,
        }),
        angleCardMarkdown({
          index: 3,
          name: '访谈观点整理',
          positioning: '整理对谈中的可公开观点，呈现“流量操盘手与 AI 创业者如何互相补位”。',
          audience: '关注个人 IP、企业服务、增长方法和 AI 落地的读者。',
          evidence: sharedEvidence,
          emotion: '从两类人的认知差异进入，形成互补和共识。',
          differentiation: '以观点和问题意识为中心，不依赖未授权品牌案例。',
          commercial: '邀请读者补充自己的转型问题，进入后续访谈或诊断。',
          platform: platformFit,
          risk,
        }),
        angleCardMarkdown({
          index: 4,
          name: '公开对标拆解',
          positioning: '用公开资料拆解同类话题怎么做标题、开头、评论需求和商业承接。',
          audience: '内容团队、创始人 IP 运营者、需要做增长内容的业务负责人。',
          evidence: sharedEvidence,
          emotion: '从“别人为什么能讲清楚”进入，再回到自己的表达边界。',
          differentiation: '把对标样本拆成可迁移结构，不照搬未经核验的事实。',
          commercial: '承接为对标诊断、内容拆解和选题陪跑。',
          platform: platformFit,
          risk,
        }),
      ]
    : [
        angleCardMarkdown({
          index: 1,
          name: '身份背书',
          positioning: `围绕“${title}”建立说话资格，先交代观察位置和经验边界。`,
          audience: '关注该主题的业务负责人、创业者和内容创作者。',
          evidence: sharedEvidence,
          emotion: '从真实观察进入，再给出专业判断。',
          differentiation: '强调证据边界和判断来源，避免空泛观点。',
          commercial: '自然承接为诊断、咨询或资料领取。',
          platform: platformFit,
          risk,
        }),
        angleCardMarkdown({
          index: 2,
          name: '反差冲突',
          positioning: '用常见误区和实际约束制造反差，解释为什么不能直接写成证明型内容。',
          audience: '需要做内容获客但缺少完整素材的创作者和企业主。',
          evidence: sharedEvidence,
          emotion: '先指出不适感，再给出解决路径。',
          differentiation: '把素材不足本身变成方法论入口。',
          commercial: '承接为选题诊断和素材补齐服务。',
          platform: platformFit,
          risk,
        }),
      ];
  const rows = angles.map((card, index) => {
    const name = card.match(/^###\s+角度\s+\d+：(.+)$/m)?.[1] || `角度${index + 1}`;
    return `| ${name} | 中 | ${platform} | 高 | 诊断/咨询/资料领取 | 中 | 中 |`;
  });
  const firstName = angles[0]?.match(/^###\s+角度\s+\d+：(.+)$/m)?.[1] || '行业观察';
  const markdown = `# 角度生成报告 · ${title}

## 0. 立项约束
- validate 报告路径：${input.validateReportPath}
- 立项结论：通过
- 首发平台：${platform}
- 必须使用的素材证据：${sharedEvidence}
- 不可触碰的风险边界：${risk}

## 推荐角度（按匹配度排序）

${angles.join('\n\n')}

## 角度对比表

| 角度 | 素材支撑 | 平台适配 | 传播潜力 | 商业承接 | 创作难度 | 风险 |
|---|---|---|---|---|---|---|
${rows.join('\n')}

## 建议
- 首选角度：${firstName}
- 组合策略：先用${firstName}建立低风险表达，再用方法论或对标拆解承接用户问题。
- 不建议使用的角度：客户证明、成果宣称、ROI 提升、未授权案例纪实。
- 进入 content-breakdown 的约束：必须沿用低证据边界，只拆行业观察、方法论清单、访谈观点、问题征集或公开对标，不得写成客户结果证明。`;

  return { markdown, title, platform, angleCount: angles.length };
}

function sectionBodyByPrefix(content: string, headingPrefix: string): string {
  const escaped = headingPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^##\\s*${escaped}`);
  const lines = content.split('\n');
  const start = lines.findIndex((line) => headingRe.test(line.trim()));
  if (start < 0) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

function firstAngleName(angleContent: string): string {
  return angleContent.match(/^###\s+角度\s+\d+[：:]\s*(.+?)\s*$/m)?.[1]?.trim() || '';
}

function extractBreakdownInputs(angleContent: string, sourceContent: string, targetPlatform?: string, platforms?: string[]) {
  const title = angleContent.match(/^#\s+角度生成报告\s*·\s*(.+)$/m)?.[1]?.trim()
    || extractTitle(angleContent)
    || extractTitle(sourceContent)
    || '未命名选题';
  const constraints = sectionBodyByPrefix(angleContent, '0. 立项约束');
  const suggestion = sectionBodyByPrefix(angleContent, '建议');
  const platform = normalizePlatformLabel(
    lineField(constraints, '首发平台') || targetPlatform || platforms?.[0] || 'wechat',
    platforms,
  );
  const angleName = lineField(suggestion, '首选角度') || firstAngleName(angleContent) || '行业观察';
  const selectedAngle = angleName.length >= 6 ? angleName : `${angleName}：低证据安全表达`;
  const evidence = lineField(constraints, '必须使用的素材证据')
    || lineField(constraints, '必用素材证据')
    || compactText(stripMarkdown(sourceContent), 240)
    || '上游素材中的可公开观点、访谈判断、业务场景和公开背景线索。';
  const risk = lineField(constraints, '不可触碰的风险边界')
    || lineField(constraints, '风险边界')
    || '不写客户结果、ROI、成交转化、未授权品牌关系、内部报价或合作细节。';
  const breakdownConstraint = lineField(suggestion, '进入 content-breakdown 的约束')
    || '沿用上游资料和风险边界，只生成可以直接写作的提纲，不把资料不足的内容写成既成事实。';
  return { title, platform, selectedAngle, evidence, risk, breakdownConstraint };
}

export function buildRepairedBreakdownMarkdown(input: {
  sourcePath?: string;
  sourceContent?: string;
  angleReportPath: string;
  angleContent: string;
  targetPlatform?: string;
  topic?: string;
  platforms?: string[];
}): RepairedBreakdownReport {
  const parsed = extractBreakdownInputs(
    input.angleContent,
    input.sourceContent || '',
    input.targetPlatform,
    input.platforms,
  );
  const title = input.topic?.trim() || parsed.title.replace(/（低证据降级版）$/, '');
  const primaryPlatform = parsed.platform;
  const selectedAngle = parsed.selectedAngle;
  const evidence = compactText(parsed.evidence, 360);
  const risk = compactText(parsed.risk, 260);
  const constraint = compactText(parsed.breakdownConstraint, 220);
  const evidenceShort = compactText(evidence, 90);
  const riskShort = compactText(risk, 90);

  const markdown = `# 内容拆解方案 · ${title}

## 0. 上游约束
- angle 报告路径：${input.angleReportPath}
- 选定角度：${selectedAngle}
- 首发平台：${primaryPlatform}
- 必须使用的素材证据：${evidence}
- 不可触碰的风险边界：${risk}
- 进入 breakdown 的约束：${constraint}

## 关键词矩阵

| 阵地 | 核心关键词 | 长尾关键词 | 标签 |
|---|---|---|---|
| 公众号 | ${title}、${selectedAngle}、低证据安全表达 | 实体经营 AI 获客、内容获客判断标准、客户证明边界 | #行业观察 #方法论 #AI经营 |
| 小红书 | ${title}、方法清单、避坑 | 实体老板怎么做内容、AI获客先看什么、别把缺证据写成案例 | #实体经营 #AI工具 #内容获客 |

## 爆款档案参考

- 参考 1：materials/hit-library/benchmark/待补采样本.md — 可借鉴点：先用反常识问题开场，再用清单降低理解成本。
- 参考 2：materials/hit-library/xhs/待补采样本.md — 可借鉴点：小红书适合把判断标准拆成可收藏卡片。
- 使用边界：以上是待补样本位，不声称已完成真实对标；成稿前可补采同题材样本增强标题和开头。

## 传播心理假设

- 来源：基于上游素材的写前推导，建议后续用 \`/dbs-spread\` 复核。
- 沉默解除：很多经营者和内容操盘手想借 AI 放大业务，但不敢公开承认自己缺少可公开证据、客户授权或稳定案例。
- 满足动机：读者需要信息价值和风险感，想知道“缺证据时还能不能表达、怎么表达才不翻车”。
- 立场框架：站在真实做业务、又不愿靠夸大结果获客的人一边，强调先把判断标准说清楚。
- 传播入口：创业者、实体老板、增长负责人、AI 服务商和内容团队会先被“证明口吻风险”吸引。
- 信念结构：确认“内容不是把未验证成果包装成事实”，挑战“只要有观点就能直接写案例”的惯性。
- 受众情绪底层：焦虑、急迫、怕错过 AI 机会，同时担心被质疑、被平台限流或伤害信任。
- 受众还想听什么：具体能写哪些句子、哪些证据必须补、不同平台怎么承接诊断或咨询。

## 标题方案

### 公众号
- 主标题：不是所有 AI 获客故事都能写成案例，缺证据时先做这套判断
- 副标题：从${selectedAngle}出发，把能公开表达的观点、证据和风险边界讲清楚

### 小红书
- 主标题：缺客户案例，也能做内容吗
- 备选标题：AI 获客别急着讲成功案例
- 封面三行文案：
  - 第一行：缺证据别硬写
  - 第二行：先用判断清单过一遍
  - 第三行：AI 获客内容避坑

## 开场钩子库

- 反常识型：越想证明自己有效，越不能在证据不足时写成客户成功案例。
- 痛点型：很多老板不是没有内容可写，是不知道哪些话一写就变成风险。
- 身份型：站在做真实业务的人角度，可信度比夸张结果更值钱。
- 场景型：你有一次访谈、一堆观点、几个行业判断，但没有授权截图和成交数据，这时该怎么写？

## 阵地适配建议

- 公众号：适合承载完整判断链，先写为什么证据不足不能硬证明，再给出${selectedAngle}的判断框架和素材边界。
- 小红书：适合拆成清单卡片，围绕“能写 / 不能写 / 需要补证”做收藏型图文，避免长篇证明口吻。

## 素材补充清单

基于选定角度和阵地策略，进入写作前还缺什么：

- [ ] 补 1 条可公开的用户痛点原话，用来增强开头可信度。
- [ ] 补 1 个匿名业务场景，说明这个问题发生在什么行业、什么角色、什么决策时刻。
- [ ] 补 1 组可公开事实或公开来源，支撑行业背景，不写成用户自己的成绩。
- [ ] 补产品/服务承接边界：诊断、咨询、资料领取或问题征集，避免结果承诺。
- [ ] 补视觉素材：小红书封面三行文案和清单卡片结构。

## 下一步执行指令

- 写公众号：\`/content-write\`，\`wechat-writer\` 读取最新 breakdown，重点使用素材证据“${evidenceShort}”，并遵守风险边界“${riskShort}”。
- 做小红书图文：\`/content-xhs\`，\`xhs-card\` 拆成“能写 / 不能写 / 要补证”的清单卡片。`;

  return { markdown, title, selectedAngle, platform: primaryPlatform };
}

function stripFrontmatter(value: string): string {
  return value.replace(/^---[\s\S]*?---\s*/, '').trim();
}

function stripDeliveryCheckBlocks(value: string): string {
  return value
    .replace(/<!--\s*AIFIOS-WRITE-CHECK\b[\s\S]*?-->/g, '')
    .trim();
}

function sanitizeRiskyVisibleText(value: string): string {
  return value
    .replace(/客户姓名|客户名|真实姓名/g, '合作方身份')
    .replace(/项目名/g, '项目身份')
    .replace(/聊天截图/g, '对话材料')
    .replace(/代码细节|源码/g, '实现细节')
    .replace(/保证\s*成交|100%\s*成交|必然成交|一定成交/g, '提升线索质量，但不承诺成交')
    .replace(/稳赚|躺赚|暴富/g, '需要持续验证')
    .replace(/全网最强|全网最|第一名|唯一|永久有效/g, '更稳妥')
    .trim();
}

function ensureMarkdownTitle(value: string, title: string): string {
  const body = value.trim();
  return /^#\s+\S+/m.test(body) ? body : `# ${title}\n\n${body}`;
}

function extractDraftRepairInputs(breakdownContent: string, draftContent: string, topic?: string, targetPlatform?: string) {
  const cleanBreakdown = stripFrontmatter(breakdownContent);
  const cleanDraft = sanitizeRiskyVisibleText(stripDeliveryCheckBlocks(stripFrontmatter(draftContent)));
  const title = topic?.trim()
    || cleanDraft.match(/^#\s+(.+)$/m)?.[1]?.trim()
    || cleanBreakdown.match(/^#\s+内容拆解方案\s*·\s*(.+)$/m)?.[1]?.trim()
    || extractTitle(cleanBreakdown)
    || '低证据安全表达';
  const upstream = sectionBodyByPrefix(cleanBreakdown, '0. 上游约束');
  const spread = sectionBodyByPrefix(cleanBreakdown, '传播心理假设');
  const selectedAngle = lineField(upstream, '选定角度') || '行业观察';
  const platform = normalizePlatformLabel(targetPlatform || lineField(upstream, '首发平台') || 'wechat');
  const evidence = lineField(upstream, '必须使用的素材证据')
    || lineField(upstream, '必用素材证据')
    || compactText(stripMarkdown(cleanBreakdown), 220);
  const risk = lineField(upstream, '不可触碰的风险边界')
    || lineField(upstream, '风险边界')
    || '不公开合作方身份、项目身份、对话材料和实现细节；不做固定结果承诺。';
  const emotion = lineField(spread, '受众情绪底层')
    || '焦虑、急迫、怕错过 AI 机会，同时希望获得安全感和掌控感';
  const nextNeed = lineField(spread, '受众还想听什么')
    || '还想听可直接使用的句式模板、证据清单、判断清单和下一篇案例拆解';
  const psychology = [
    '沉默解除：很多经营者不敢说自己想借 AI 放大业务，却缺少可公开证据和稳定案例',
    '满足动机：提供身份认同、信息价值和风险感，让读者知道缺证据时仍能安全表达',
    '有效立场：站在真实做业务但不夸大结果的人一边',
    '传播入口：评论区讨论、团队转发和私信诊断会围绕“我这种情况能不能写”展开',
    '信念结构：确认内容不能把未验证成果包装成事实，挑战只要有观点就能写成功案例的误区',
    `受众情绪底层：${emotion}`,
    `受众还想听什么：${nextNeed}`,
  ].join('；');
  return { cleanDraft, title, selectedAngle, platform, evidence, risk, emotion, nextNeed, psychology };
}

function repairedWriteMarkdown(input: {
  breakdownPath: string;
  breakdownContent: string;
  draftContent: string;
  topic?: string;
  targetPlatform?: string;
}): RepairedDraftReport {
  const parsed = extractDraftRepairInputs(input.breakdownContent, input.draftContent, input.topic, input.targetPlatform);
  const base = ensureMarkdownTitle(parsed.cleanDraft || `# ${parsed.title}\n\n这篇文章从“${parsed.selectedAngle}”切入，讨论缺少硬证明时如何把观点、安全边界和用户问题讲清楚。`, parsed.title);
  const evidenceContract = '上游访谈观点和业务场景；公开背景只作行业语境；低证据边界来自 breakdown';
  const markdown = `${base}

## 读者心理与风险边界补强

这篇内容真正要解除的沉默，不是替任何人证明“已经成功”，而是说清楚一个更真实的问题：很多经营者和内容操盘手都想借 AI 放大业务，但手里并不总是有可公开的结果数据、授权材料或完整案例。

读者的底层情绪通常是焦虑、急迫、怕错过 AI 机会，也怕自己讲过头之后被质疑。内容需要站在真实做业务的人一边，给出安全感和掌控感：能讲观察，能讲判断标准，能讲方法清单，但不能把未验证成果包装成事实。

读者还想听的是更具体的下一步：哪些句子能写，哪些证据必须补，哪些表达要删除，以及如果想继续推进，应该用什么清单检查自己的行业、产品、客户问题和证据状态。

本稿真正能使用的证据只有三类：上游访谈观点和业务场景；公开背景只作行业语境；低证据边界来自 breakdown。其他涉及结果、转化和合作关系的内容，只能作为待验证问题，不能写成已经发生的事实。

## 可公开表达边界

- 可以写：上游素材里的公开观点、行业观察、方法论清单、匿名业务场景和读者问题。
- 需要降级：结果证明、成交转化、ROI、合作关系和具体执行材料，只能写成待验证假设或判断清单。
- 必须处理：合作方身份、项目身份、对话材料和实现细节一律做匿名化、概括化处理。
- 商业收口：引导读者提交行业、产品、客户问题和当前证据状态，进入诊断或咨询，不做固定结果承诺。

<!-- AIFIOS-WRITE-CHECK
上游 brief - breakdown:${input.breakdownPath}；选定角度：${parsed.selectedAngle}；首发平台：${parsed.platform}
推荐风格 - 用户指定：无；系统推荐：低证据安全表达（置信度：中）；最终采用：低证据安全表达；理由：当前阻断来自传播心理缺项和风险边界，需要先稳住可信度。
写作任务卡 - 补齐可见正文中的读者心理、有效立场、后续需求和风险边界，不把缺证据内容写成案例证明。
证据台账 - ${compactText(parsed.evidence, 220)}
文章骨架 - 问题开场；行业观察；判断清单；风险边界；评论区诊断承接。
必用证据 - ${evidenceContract}
传播心理兑现 - ${parsed.psychology}
风险边界 - ${compactText(parsed.risk, 220)}；合作方身份、项目身份、对话材料和实现细节需匿名化；不写固定成交、ROI 或结果承诺。
商业收口 - 引导读者在评论区留下行业、产品、客户问题和当前证据状态，进入诊断或咨询。
质检结论 - review
-->`;

  return { markdown, title: parsed.title, step: 'write', platform: parsed.platform };
}

function repairedXhsMarkdown(input: {
  breakdownPath: string;
  breakdownContent: string;
  draftContent: string;
  topic?: string;
  targetPlatform?: string;
}): RepairedDraftReport {
  const parsed = extractDraftRepairInputs(input.breakdownContent, input.draftContent, input.topic, input.targetPlatform || 'xhs');
  const markdown = `# ${parsed.title}

## 封面三行文案
- 缺证据别硬写
- 先用判断清单
- AI 获客避坑

## 图文卡片结构
- 第 1 张：封面，缺证据时别把内容写成客户成功。
- 第 2 张：问题，很多人不是没素材，是素材不能支撑结果证明。
- 第 3 张：能写，行业观察、方法清单、匿名场景、公开背景。
- 第 4 张：不能写，固定成交、ROI、未经授权的合作关系和对话材料。
- 第 5 张：判断标准，先看证据、授权、商业承接和风险边界。
- 第 6 张：互动，留下你的行业、产品和客户问题，帮你判断适合写哪类内容。

## 正文笔记
很多实体老板和内容操盘手卡住，不是因为没有观点，而是因为手里的材料还不能支撑“成功案例”。

这时更安全的写法，是把内容降级成${parsed.selectedAngle}：先讲行业观察，再给判断清单，最后收集读者自己的问题。这样既能表达专业判断，也不会把未验证结果写成既成事实。

判断标准可以看三件事：第一，素材里有没有可公开证据；第二，合作方身份、对话材料和内部细节能不能匿名处理；第三，商业收口是不是诊断和咨询，而不是固定结果承诺。

## 评论区承接
评论区可以留下三个信息：你的业务类型、现在想写的客户问题、手里已有的证据状态。我会帮你判断更适合写行业观察、方法清单、访谈观点，还是公开对标拆解。

## 风险边界
- 不展示客户身份、项目身份、对话材料原图和内部执行细节。
- 不承诺固定成交、ROI 或具体转化结果。
- 公开资料只作为行业背景和平台语境，不写成自己的业务成绩。
- 涉及隐私、版权、截图授权和合作关系时，先匿名化再表达。`;

  return { markdown, title: parsed.title, step: 'xhs', platform: '小红书' };
}

export function buildRepairedDraftMarkdown(input: {
  draftStep: RepairedDraftStep;
  draftContent: string;
  breakdownPath: string;
  breakdownContent: string;
  topic?: string;
  targetPlatform?: string;
}): RepairedDraftReport {
  if (input.draftStep === 'xhs') return repairedXhsMarkdown(input);
  return repairedWriteMarkdown(input);
}

function visualSlugFromPath(path: string): string {
  const name = path.split('/').pop() || 'visual-plan';
  return sanitizeSlug(
    name
      .replace(/^\d{4}-\d{2}-\d{2}-\d{6}-\d+[-_]?/, '')
      .replace(/-(?:write|xhs|visual)\.md$/i, '')
      .replace(/\.md$/i, ''),
  );
}

function visualTitle(content: string, topic?: string): string {
  return topic?.trim()
    || stripFrontmatter(content).match(/^#\s+(.+)$/m)?.[1]?.trim()
    || extractTitle(content)
    || 'AI Founder Influence OS 内容选题';
}

function visualPlatformLabel(targetPlatform?: string, sourcePath?: string): string {
  if (/xhs|xiaohongshu|小红书/i.test(`${targetPlatform} ${sourcePath}`)) return '小红书图文 / 封面';
  return '微信公众号封面 / 正文 HTML';
}

export function buildRepairedVisualMarkdown(input: {
  sourcePath: string;
  sourceContent: string;
  visualContent?: string;
  topic?: string;
  targetPlatform?: string;
  imageType?: string;
}): RepairedVisualReport {
  const title = visualTitle(input.sourceContent || input.visualContent || '', input.topic);
  const slug = visualSlugFromPath(input.sourcePath || title);
  const platform = visualPlatformLabel(input.targetPlatform, input.sourcePath);
  const isXhs = /小红书|xhs/i.test(platform);
  const baoyuLayer = buildBaoyuVisualLayer({
    slug,
    platformLabel: platform,
    sourcePath: input.sourcePath,
    imageType: input.imageType,
  });
  const visualGoal = isXhs
    ? '把内容改成可收藏、可直接发布的小红书首页图、轮播卡、正文笔记和标签生产计划，突出清单化、移动端可读和低证据安全表达。'
    : '把公众号成稿转成封面、首图、正文配图和并行 HTML 排版候选，突出可信、克制、可读和低证据安全表达。';
  const sourceSummary = compactText(stripMarkdown(input.sourceContent || ''), 180);
  const assetTable = [
    '| 资产ID | Baoyu 设计层 | 执行工具 | 格式 | 尺寸/比例 | 核心文案/画面 | Prompt 文件 | 产物路径 |',
    '|---|---|---|---|---|---|---|---|',
    ...baoyuLayer.assets.map((asset) => `| ${asset.assetId} | ${asset.designLayer} | ${asset.executionTool} | ${asset.format} | ${asset.size} | ${asset.coreCopy} | ${asset.promptPath} | ${asset.outputPath} |`),
  ].join('\n');
  const productionNotes = baoyuLayer.assets.map((asset) => {
    return `- ${asset.assetId}：Baoyu 设计层 ${asset.designLayer}；执行工具 ${asset.executionTool}；格式 ${asset.format}；尺寸 ${asset.size}；Prompt 文件 ${asset.promptPath}；输出 ${asset.outputPath}；${asset.baoyuPreset}；生产说明：${asset.coreCopy}。${asset.baoyuSpec}`;
  }).join('\n');
  const manifestRows = [
    '| 资产ID | Baoyu 设计层 | 执行工具 | 源文件 | Prompt 文件 | 格式 | 尺寸/比例 | 输出文件 | 验收状态 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...baoyuLayer.assets.map((asset) => `| ${asset.assetId} | ${asset.designLayer} | ${asset.executionTool} | ${input.sourcePath} | ${asset.promptPath} | ${asset.format} | ${asset.size} | ${asset.outputPath} | planned：先写 prompt 文件，生成后检查尺寸、文字安全区、版权和隐私 |`),
  ].join('\n');
  const markdown = `# 视觉生产计划 · ${title}

## 0. 原文与视觉目标
- 原文路径：${input.sourcePath}
- 原文标题：${title}
- 目标平台：${platform}
- 内容类型：${isXhs ? '小红书图文 / 社交卡片' : '公众号封面 / 正文 HTML'}
- 视觉目标：${visualGoal}
- 上游摘要：${sourceSummary || '上游成稿已进入视觉生产阶段，视觉计划只承接公开表达、标题和风险边界。'}

## 1. 视觉系统
- 统一风格：${baoyuLayer.designSystem}
- 底层桥接规则：${baoyuLayer.bridgeRule}
- 配色：${baoyuLayer.palette}
- 字体/文字系统：${baoyuLayer.typography}
- 版式/构图：${baoyuLayer.layout}
- Prompt 纪律：${baoyuLayer.promptPolicy}
- 位图生成规则：${baoyuLayer.rasterPolicy}
- 禁用项：禁止真实客户 Logo、项目身份、对话材料截图、内部代码细节、ROI/成交承诺、全网最强等绝对化视觉暗示。

## 2. 视觉资产清单
${assetTable}

## 3. 资产生产说明
${productionNotes}

## 4. 验收清单
- 尺寸检查：21:9、1:1、3:4、16:9 按资产表逐项检查。
- 文字安全：移动端预览不裁切标题，关键字不贴边。
- 风格一致：统一使用墨黑、暖白、浅灰、暖橙、克制蓝，不混用高饱和渐变。
- 版权检查：不使用未授权 Logo、截图、肖像、平台水印和第三方素材。
- 隐私检查：客户、项目、对话材料、内部系统和代码细节全部匿名化。
- 平台规则：不出现固定成交、ROI 保证、唯一/最强/永久有效等绝对化承诺。

## 5. 下一步执行指令
- 读取视觉计划：\`python3 skills/content-runtime/scripts/content_runtime.py --project .aifios-demo read --step visual --latest\`
- 先写 Prompt 文件：按资产清单创建 \`pipeline/visual/${slug}/prompts/*.md\`，每个文件记录对应的 \`baoyu-cover-image\`、\`baoyu-xhs-images\`、\`baoyu-infographic\` 或 \`baoyu-article-illustrator\` 参数。
- 生成公众号 HTML：使用任务中已确认的 md2wechat API 主题生成一份完整排版；本机 md2wechat 不可用时自动使用单一基础排版回退。
- 生成卡片/封面：用 Baoyu 设计层确定风格和构图后，调用 \`xhs-card\` 或封面生成工具，按资产清单输出到 \`pipeline/visual/${slug}/\`。
- 生成小黑配图：用 \`baoyu-article-illustrator\` 先确定插图位置、类型和信息结构，再调用 \`ian-xiaohei-illustrations\` 生成 16:9 配图。
- 生成发布资产包：调用前端发布资产生成器，写入 \`pipeline/publish-assets/${slug}/\`，把公众号 HTML 候选和小红书复制稿汇总。
- 生成信息图或位图资产：如需要真实 PNG/JPG，优先走 Codex native imagegen；若显式选择 API 后端，再按 \`baoyu-image-gen\` 的 promptfile/batch 规则执行。
- 交付打包：\`make -C skills/content-runtime delivery-pack PROJECT=.aifios-demo RUN_ID=${slug}\`

## 6. 交付 Manifest
${manifestRows}

交付包命令：\`make -C skills/content-runtime delivery-pack PROJECT=.aifios-demo RUN_ID=${slug}\`。`;

  return { markdown, title, platform, assetCount: baoyuLayer.assets.length };
}

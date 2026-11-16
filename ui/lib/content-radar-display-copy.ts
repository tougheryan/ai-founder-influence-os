const LEGACY_RADAR_COPY: Array<[RegExp, string]> = [
  [/TikOmni\s+公开样本/gi, '平台数据中的参考内容'],
  [/TikOmni/gi, '平台数据'],
  [/内容机会深度报告/g, '选题分析报告'],
  [/内容机会报告/g, '选题分析报告'],
  [/机制蒸馏/g, '写法总结'],
  [/内容机制手册/g, '常用写法'],
  [/可迁移(?:的)?(?:内容)?机制/g, '值得尝试的写法'],
  [/样本语义推导/g, '根据参考内容判断'],
  [/样本饱和度/g, '同类内容集中度'],
  [/样本量/g, '参考内容数量'],
  [/公开样本/g, '参考内容'],
  [/代表样本/g, '代表内容'],
  [/本批样本/g, '这批参考内容'],
  [/样本/g, '参考内容'],
  [/机会分/g, '推荐分'],
  [/证据覆盖/g, '数据完整度'],
  [/可生产度/g, '素材准备度'],
  [/研究快照/g, '已保存的平台数据'],
  [/公开信息研究/g, '查看同类内容'],
  [/内容资产/g, '现有素材'],
  [/视觉资产/g, '配图'],
  [/内容蓝图/g, '文章提纲'],
  [/母稿/g, '公众号文章'],
  [/B-roll/gi, '补充画面'],
  [/CTA\s*图?/gi, '结尾图'],
  [/内容机制/g, '常用写法'],
  [/机制/g, '写法'],
  [/需求信号/g, '需求依据'],
  [/信号/g, '依据'],
  [/智能洞察/g, '分析结果'],
  [/洞察/g, '判断'],
  [/语义推导/g, '内容判断'],
  [/对标/g, '同类内容'],
  [/生产链/g, '制作步骤'],
  [/生产/g, '制作'],
  [/沉淀/g, '保存'],
  [/赋能/g, '帮助'],
];

const UNSAFE_GENERATED_COPY = new RegExp([
  'file:\\/\\/\\/',
  '\\/(?:Users|home|root|private|var|tmp|Volumes|Applications|Library|System|opt|srv|workspace|app|mnt)\\/',
  '[A-Za-z]:\\\\',
  '(?:^|[\\s("\'])\\.?\\/?(?:pipeline|runtime|runs|materials|artifacts?|snapshots?|schemas?)\\/[\\w./@-]+',
  '\\b(?:run(?:[_ -]?id)?|slug|hash|sha-?256|task(?:[_ -]?id)?|debug(?:[_ -]?id)?)\\s*[:=_-]?\\s*[A-Za-z0-9][A-Za-z0-9_-]{3,}\\b',
  '\\b(?:[a-f0-9]{24,}|[A-Za-z0-9_-]{40,})\\b',
  '(?:api[_ -]?key|access[_ -]?token|authorization|cookie|password|app[_ -]?secret|client[_ -]?secret|pairing[_ -]?token|密钥|令牌|密码)\\s*[:=]\\s*\\S+',
  '\\bsk-[A-Za-z0-9_-]{6,}\\b',
  '\\n\\s*at\\s+',
  '\\b(?:TypeError|ReferenceError|SyntaxError|Unhandled|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\\b',
].join('|'), 'i');

const SAFE_UNAVAILABLE_COPY = '这部分结果暂时无法显示。请更新选题后再看。';

function isRawJson(value: string): boolean {
  const text = value.trim();
  if (!((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Historical reports keep their original machine-readable data. This function
// only changes system-generated text at render time; source titles and user
// input must not pass through it.
export function contentRadarGeneratedDisplayText(value: string): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!source) return '';
  if (UNSAFE_GENERATED_COPY.test(source) || isRawJson(source)) return SAFE_UNAVAILABLE_COPY;

  return LEGACY_RADAR_COPY
    .reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), source)
    .replace(/从本批/g, '从这批')
    .replace(/提取\s*(\d+)\s*类/g, '归纳出 $1 种')
    .replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g, '$1');
}

export function contentRadarGeneratedDisplayList(values: string[]): string[] {
  return values.map(contentRadarGeneratedDisplayText);
}

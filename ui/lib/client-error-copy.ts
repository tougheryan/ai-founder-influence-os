type ErrorParts = {
  name: string;
  message: string;
  code: string;
};

const INTERNAL_ID_PATTERN = /\b(?:run|task|asset|revision|debug|request|trace)[_-]?(?:id[_-]?)?[A-Za-z0-9_-]{6,}\b/i;
const LABELED_TECH_VALUE_PATTERN = /\b(?:run(?:[_ -]?id)?|slug|hash|sha-?256|task(?:[_ -]?id)?|debug(?:[_ -]?id)?)\s*[:=_-]?\s*[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/i;
const LONG_DIGEST_PATTERN = /\b(?:[a-f0-9]{24,}|[A-Za-z0-9_-]{40,})\b/i;
const LOCAL_PATH_PATTERN = /(?:file:\/\/\/|\/(?:Users|home|root|private|var|tmp|Volumes|Applications|Library|System|opt|srv|workspace|app|mnt)\/|[A-Za-z]:\\)/i;
const RELATIVE_INTERNAL_PATH_PATTERN = /(?:^|[\s("'])\.?\/?(?:pipeline|runtime|runs|materials|artifacts?|snapshots?|schemas?)\/[\w./@-]+/i;
const GENERIC_RELATIVE_PATH_PATTERN = /(?:^|[\s("'])\.?\/?[\w.@-]+(?:\/[\w.@-]+){1,}/i;
const SECRET_VALUE_PATTERN = /(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|cookie|password|app[_ -]?secret|client[_ -]?secret|pairing[_ -]?token|token|密钥|令牌|密码)\s*[:=]\s*\S+/i;
const STANDALONE_SECRET_PATTERN = /(?:\bsk-[A-Za-z0-9_-]{6,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{6,})/i;
const STACK_OR_RAW_PATTERN = /(?:\n\s*at\s+|\b(?:TypeError|ReferenceError|SyntaxError|Unhandled|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|JSON)\b|<\/?(?:html|body)|[{}\[\]]\s*"?\w+"?\s*:)/i;
const RAW_EXCEPTION_LANGUAGE_PATTERN = /\b(?:failed?|error|exception|cannot|undefined|null|unexpected|unable|denied|not found|response|request|operation|property|payload|parse|aborted?)\b/i;

function readErrorParts(cause: unknown): ErrorParts {
  if (cause instanceof Error) {
    const record = cause as Error & { code?: unknown };
    return {
      name: cause.name || 'Error',
      message: cause.message || '',
      code: typeof record.code === 'string' ? record.code : '',
    };
  }
  if (typeof cause === 'string') return { name: 'Error', message: cause, code: '' };
  if (cause && typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    const message = [record.displayMessage, record.error, record.message]
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim())) || '';
    return {
      name: typeof record.name === 'string' ? record.name : 'Error',
      message,
      code: typeof record.code === 'string' ? record.code : '',
    };
  }
  return { name: 'Error', message: '', code: '' };
}

function naturalizeProductTerms(value: string): string {
  return value
    .replace(/TikOmni\s+(?:Token|API Key)/gi, '平台数据密钥')
    .replace(/TikOmni/gi, '平台数据服务')
    .replace(/API\s*Key/gi, '访问密钥')
    .replace(/pipeline\s+snapshot/gi, '制作记录')
    .replace(/pipeline/gi, '制作流程')
    .replace(/runtime/gi, '本机服务')
    .replace(/snapshot/gi, '已保存的平台数据')
    .replace(/artifacts?/gi, '生成内容')
    .replace(/schema/gi, '内容格式')
    .replace(/queue/gi, '发布清单')
    .replace(/\brun(?:[_ -]?id)?\b/gi, '本期记录')
    .replace(/\bslug\b/gi, '内容标识')
    .replace(/\b(?:sha-?256|hash)\b/gi, '内容校验信息')
    .replace(/内容包/g, '全部内容')
    .replace(/公众号母稿|母稿/g, '公众号文章')
    .replace(/视觉资产|视觉候选/g, '配图')
    .replace(/B-roll/gi, '补充画面')
    .replace(/CTA\s*图?/gi, '结尾图')
    .replace(/公开样本/g, '参考内容')
    .replace(/生产链/g, '制作流程')
    .replace(/生产/g, '制作')
    .replace(/沉淀/g, '保存')
    .replace(/\s+/g, ' ')
    .replace(/([\u4E00-\u9FFF])\s+(?=[\u4E00-\u9FFF])/g, '$1')
    .trim();
}

function sentences(value: string): string[] {
  return value
    .match(/[^。！？!?]+[。！？!?]?/g)?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function withPunctuation(value: string): string {
  const text = value.trim();
  if (!text) return '';
  return /[。！？!?]$/.test(text) ? text : `${text}。`;
}

function isActionSentence(value: string): boolean {
  return /(?:请|先|再试|重试|检查|打开|返回|重新|稍后|换一个|联系|完成|填写|选择|保存|登录|确认|刷新)/.test(value);
}

function limitToTwoSentences(value: string): string {
  return sentences(value).slice(0, 2).map(withPunctuation).join('');
}

function fallbackCopy(fallback: string): string {
  const normalized = naturalizeProductTerms(fallback);
  if (!/[\u3400-\u9fff]/.test(normalized)) return '暂时无法完成操作。请重试。';
  const parts = sentences(normalized).slice(0, 2);
  if (parts.length === 0) return '暂时无法完成操作。请重试。';
  if (parts.length === 1 && !isActionSentence(parts[0])) parts.push('请重试。');
  return parts.map(withPunctuation).join('');
}

function safeBusinessMessage(value: string): boolean {
  if (!value || value.length > 240 || !/[\u3400-\u9fff]/.test(value)) return false;
  if (LOCAL_PATH_PATTERN.test(value) || RELATIVE_INTERNAL_PATH_PATTERN.test(value) || GENERIC_RELATIVE_PATH_PATTERN.test(value)) return false;
  if (SECRET_VALUE_PATTERN.test(value) || STANDALONE_SECRET_PATTERN.test(value) || INTERNAL_ID_PATTERN.test(value) || LABELED_TECH_VALUE_PATTERN.test(value) || LONG_DIGEST_PATTERN.test(value)) return false;
  if (STACK_OR_RAW_PATTERN.test(value) || RAW_EXCEPTION_LANGUAGE_PATTERN.test(value) || /https?:\/\/\S+/i.test(value)) return false;
  return true;
}

function finishBusinessMessage(message: string, fallback: string): string {
  const normalized = naturalizeProductTerms(message);
  const parts = sentences(normalized).slice(0, 2);
  if (parts.length === 0) return fallbackCopy(fallback);
  if (!parts.some(isActionSentence)) {
    const fallbackAction = sentences(fallbackCopy(fallback)).find(isActionSentence) || '请重试。';
    if (parts.length === 1) parts.push(fallbackAction);
    else parts[1] = fallbackAction;
  }
  return parts.map(withPunctuation).join('');
}

/**
 * Converts server, fetch and desktop-bridge failures into copy that is safe to
 * render. Unknown exception details deliberately never reach the page.
 */
export function displayClientError(cause: unknown, fallback: string): string {
  const { name, message, code } = readErrorParts(cause);
  const signal = `${name} ${code} ${message}`.trim();

  if (/content_(?:package_incomplete|release_blocked)|已选平台.*内容.*完整|第\s*3\s*步.*(?:原生内容|完整生成)/i.test(signal)) {
    return '第 3 步没有完整生成已选平台的原生内容。请返回第 3 步重新生成，内容完整后再进入配图。';
  }

  if (/browser_session_required|not[_ -]?logged|login required|未登录|登录状态失效/i.test(signal)) {
    if (/小红书|xiaohongshu|xhs/i.test(signal)) return '还没有登录小红书。打开编辑器完成登录后再试。';
    if (/公众号|wechat|weixin/i.test(signal)) return '还没有登录公众号后台。打开编辑器完成登录后再试。';
    return '平台账号还没有登录。打开编辑器完成登录后再试。';
  }

  if (/(?:invalid|wrong|incorrect|无效|错误).{0,16}(?:invite|unlock|授权码|使用密码)|(?:invite|unlock|授权码|使用密码).{0,16}(?:invalid|wrong|incorrect|无效|错误)/i.test(signal)) {
    return /密码|unlock/i.test(signal)
      ? '使用密码不正确。请重新输入。'
      : '授权码无效。请检查后重试。';
  }

  if (/credentials?_invalid|credentials?_missing|(?:token|api[ _-]?key|密钥|凭证).{0,24}(?:missing|required|invalid|expired|缺少|未设置|无效|过期)|(?:missing|required|invalid|expired|缺少|未设置|无效|过期).{0,24}(?:token|api[ _-]?key|密钥|凭证)/i.test(signal)) {
    return /TikOmni|平台数据/i.test(signal)
      ? '平台数据连接失败。请到系统设置检查密钥后重试。'
      : '访问密钥缺失或无效。请到系统设置检查后重试。';
  }

  if (/keychain|safeStorage|钥匙串/i.test(signal)) {
    return '暂时无法使用 macOS 钥匙串。请重新保存密钥后再试。';
  }

  if (/network|fetch|timeout|timed out|econn|enet|socket|service_unavailable|网络|连接超时|服务不可用/i.test(signal)) {
    return '暂时无法连接服务。请检查网络后重试。';
  }

  if (/permission|forbidden|access_denied|eacces|没有权限|拒绝访问/i.test(signal)) {
    return '当前账号无法完成这项操作。请检查账号权限后重试。';
  }

  if (safeBusinessMessage(message)) return finishBusinessMessage(message, fallback);
  return fallbackCopy(fallback);
}

/** Returns only a hostname; query strings, fragments and embedded credentials are never shown. */
export function safeLinkDisplayName(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return '这个链接';
    return url.hostname.replace(/^www\./i, '').slice(0, 100) || '这个链接';
  } catch {
    return '这个链接';
  }
}

/** Keeps a user-selected basename while rejecting path-like or secret-like labels. */
export function safeFileDisplayName(value: string): string {
  const basename = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim() || '';
  if (!basename || SECRET_VALUE_PATTERN.test(basename) || LONG_DIGEST_PATTERN.test(basename)) return '这份文件';
  return basename.slice(0, 100);
}

export const __clientErrorCopyTestUtils = {
  naturalizeProductTerms,
  safeBusinessMessage,
  limitToTwoSentences,
};

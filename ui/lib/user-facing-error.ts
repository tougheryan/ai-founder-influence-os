import { NextResponse } from 'next/server';

export interface UserFacingErrorAction {
  label: string;
  href?: string;
}

export interface UserFacingError {
  error: string;
  code: string;
  action?: UserFacingErrorAction;
  debugId?: string;
}

export interface UserFacingErrorDefinition {
  error: string;
  code: string;
  action?: UserFacingErrorAction;
}

export interface UserFacingErrorOptions extends UserFacingErrorDefinition {
  status?: number;
  headers?: HeadersInit;
  context?: string;
  extra?: Record<string, unknown>;
  legacyMessageField?: string;
  logger?: (line: string) => void;
}

interface ExpectedErrorOptions extends UserFacingErrorDefinition {
  status: number;
  headers?: HeadersInit;
  extra?: Record<string, unknown>;
  legacyMessageField?: string;
}

const SECRET_FIELD = '(?:api[_-]?key|access[_-]?token|auth[_-]?token|pairing[_-]?token|token|authorization|cookie|password|private[_-]?key|app[_-]?secret|client[_-]?secret|secret)';

const KNOWN_ERROR_RULES: Array<{
  matches: (name: string, message: string) => boolean;
  definition: UserFacingErrorDefinition;
}> = [
  {
    matches: (name, message) => /input|validation|syntax|typeerror/i.test(name)
      || /invalid|malformed|格式|字段|参数|不能为空|不符合要求|超出.{0,8}(?:限制|上限)/i.test(message),
    definition: {
      error: '填写内容不符合要求，请检查后重试。',
      code: 'invalid_request',
    },
  },
  {
    matches: (name, message) => /writelock|conflict|stale/i.test(name)
      || /lock|concurrent|already in progress|正在写入|正在保存|已被更新|不是最新版本|冲突/i.test(message),
    definition: {
      error: '内容已发生变化，请刷新后重试。',
      code: 'content_changed',
    },
  },
  {
    matches: (name, message) => /notactive|notfound/i.test(name)
      || /\benoent\b|not found|does not exist|不存在|未找到|已删除/i.test(message),
    definition: {
      error: '所需内容不存在，可能已被移动或删除。',
      code: 'not_found',
    },
  },
  {
    matches: (_name, message) => /checksum|integrity|digest|hash mismatch|校验和|完整性校验|摘要不一致/i.test(message),
    definition: {
      error: '内容校验失败，请重新获取后再试。',
      code: 'integrity_check_failed',
    },
  },
  {
    matches: (name, message) => /unauthorized|forbidden|permission/i.test(name)
      || /unauthorized|forbidden|permission denied|无权|没有权限|拒绝访问/i.test(message),
    definition: {
      error: '当前账号没有执行此操作的权限。',
      code: 'access_denied',
    },
  },
  {
    matches: (_name, message) => /(?:token|api.?key|密钥|凭证|授权码).{0,24}(?:missing|required|invalid|expired|缺少|未设置|无效|过期)/i.test(message)
      || /(?:missing|required|invalid|expired|缺少|未设置|无效|过期).{0,24}(?:token|api.?key|密钥|凭证|授权码)/i.test(message),
    definition: {
      error: '访问密钥缺失或无效，请在设置中检查后重试。',
      code: 'credentials_invalid',
      action: { label: '打开设置', href: '/settings' },
    },
  },
  {
    matches: (name, message) => /timeout|network|fetch/i.test(name)
      || /econn|enet|fetch failed|network|socket|timed?\s*out|网络|连接超时|服务不可用/i.test(message),
    definition: {
      error: '暂时无法连接服务，请检查网络后重试。',
      code: 'service_unavailable',
    },
  },
  {
    matches: (_name, message) => /invalid\s+json|json\s+(?:parse|payload|response)|schema\s+(?:invalid|mismatch)|invalid\s+manifest|parse\s+(?:error|failed)|解析失败|数据结构不兼容|数据损坏/i.test(message),
    definition: {
      error: '内容格式不兼容，请重新生成或重新导入。',
      code: 'incompatible_data',
    },
  },
];

export class KnownUserFacingError extends Error {
  readonly definition: UserFacingErrorDefinition;
  readonly status: number;
  readonly detail?: unknown;

  constructor(definition: UserFacingErrorDefinition, options: { status?: number; detail?: unknown } = {}) {
    super(definition.error);
    this.name = 'KnownUserFacingError';
    this.definition = definition;
    this.status = options.status ?? 400;
    this.detail = options.detail;
  }
}

function errorParts(cause: unknown): { name: string; message: string } {
  if (cause instanceof Error) {
    const constructorName = cause.constructor?.name;
    const name = cause.name && cause.name !== 'Error'
      ? cause.name
      : constructorName && constructorName !== 'Error'
        ? constructorName
        : 'Error';
    return { name, message: cause.message || '' };
  }
  if (typeof cause === 'string') return { name: 'Error', message: cause };
  return { name: 'Error', message: '' };
}

function classifyKnownError(cause: unknown): UserFacingErrorDefinition | null {
  if (cause instanceof KnownUserFacingError) return cause.definition;
  const { name, message } = errorParts(cause);
  return KNOWN_ERROR_RULES.find((rule) => rule.matches(name, message))?.definition ?? null;
}

function createDebugId(): string {
  const value = globalThis.crypto?.randomUUID?.().replaceAll('-', '');
  if (value) return `err_${value.slice(0, 16)}`;
  return `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function redactSensitiveErrorDetail(value: unknown): string {
  let text: string;
  if (value instanceof KnownUserFacingError && value.detail !== undefined) {
    text = value.detail instanceof Error
      ? value.detail.stack || value.detail.message
      : safeStringify(value.detail);
  } else if (value instanceof Error) {
    text = value.stack || value.message || value.name;
  } else {
    text = safeStringify(value);
  }

  const secretField = new RegExp(`((?:${SECRET_FIELD})\\s*[:=]\\s*)[^\\s\"',;&]+`, 'gi');
  const jsonSecretField = new RegExp(`(\"${SECRET_FIELD}\"\\s*:\\s*\")[^\"\\r\\n]*(\")`, 'gi');
  const quotedSecretField = new RegExp(`('${SECRET_FIELD}'\\s*:\\s*')[^'\\r\\n]*(')`, 'gi');

  return text
    .replace(/file:\/\/\/[^\s"'<>]+/gi, '[local path]')
    .replace(/\/(?:Users|home|root|private|var|tmp|Volumes|Applications|Library|System|opt|srv|workspace|app|mnt)\/[^\s"'<>，。；;,)）\]}]+/g, '[local path]')
    .replace(/[A-Za-z]:\\[^\r\n"'<>]+/g, '[local path]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[secret redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, '[secret redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[secret redacted]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[digest redacted]')
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s"',;]+/gi, '$1[secret redacted]')
    .replace(/\b(?:bearer|basic)\s+[^\s"',;]+/gi, '[secret redacted]')
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, '$1[secret redacted]')
    .replace(jsonSecretField, '$1[secret redacted]$2')
    .replace(quotedSecretField, '$1[secret redacted]$2')
    .replace(secretField, '$1[secret redacted]')
    .slice(0, 8_000);
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, item) => {
      if (new RegExp(`^${SECRET_FIELD}$`, 'i').test(key)) return '[secret redacted]';
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

function logCaughtError(
  cause: unknown,
  debugId: string,
  context: string,
  logger: (line: string) => void,
): void {
  const detail = redactSensitiveErrorDetail(cause);
  logger(`[user-facing-error:${debugId}] ${context}: ${detail || 'No diagnostic detail available.'}`);
}

function responsePayload(
  definition: UserFacingErrorDefinition,
  extra?: Record<string, unknown>,
  legacyMessageField?: string,
  debugId?: string,
): Record<string, unknown> & UserFacingError {
  const payload: Record<string, unknown> & UserFacingError = {
    ...(extra ?? {}),
    error: definition.error,
    code: definition.code,
    ...(definition.action ? { action: definition.action } : {}),
    ...(debugId ? { debugId } : {}),
  };
  if (legacyMessageField && legacyMessageField !== 'error') {
    payload[legacyMessageField] = definition.error;
  }
  return payload;
}

export function expectedUserFacingErrorResponse(options: ExpectedErrorOptions): NextResponse {
  return NextResponse.json(
    responsePayload(options, options.extra, options.legacyMessageField),
    { status: options.status, headers: options.headers },
  );
}

export function userFacingErrorResponse(cause: unknown, options: UserFacingErrorOptions): NextResponse {
  const payload = userFacingErrorPayload(cause, options);

  return NextResponse.json(
    responsePayload(payload, options.extra, options.legacyMessageField, payload.debugId),
    {
      status: cause instanceof KnownUserFacingError ? cause.status : options.status ?? 500,
      headers: options.headers,
    },
  );
}

export function userFacingErrorPayload(cause: unknown, options: UserFacingErrorOptions): UserFacingError {
  const known = classifyKnownError(cause);
  const definition = known ?? {
    error: options.error,
    code: options.code,
    ...(options.action ? { action: options.action } : {}),
  };
  const debugId = createDebugId();
  const logger = options.logger ?? ((line: string) => console.error(line));
  logCaughtError(cause, debugId, options.context ?? options.code, logger);
  return { ...definition, debugId };
}

import { describe, expect, it, vi } from 'vitest';

import {
  KnownUserFacingError,
  expectedUserFacingErrorResponse,
  redactSensitiveErrorDetail,
  userFacingErrorResponse,
} from './user-facing-error';

describe('user-facing error boundary', () => {
  it('does not return an unknown exception message, path, token, stack, or raw JSON', async () => {
    const lines: string[] = [];
    const cause = new Error(
      'failed at /Users/alice/private/project.json token=secret-token {"password":"open-sesame"}',
    );
    cause.stack = `Error: ${cause.message}\n    at run (/Users/alice/private/route.ts:12:3)`;

    const response = userFacingErrorResponse(cause, {
      error: '暂时无法保存，请重试。',
      code: 'save_failed',
      status: 500,
      context: 'save test',
      logger: (line) => lines.push(line),
    });
    const body = await response.json();

    expect(body).toMatchObject({ error: '暂时无法保存，请重试。', code: 'save_failed' });
    expect(body.debugId).toMatch(/^err_[a-z0-9]+$/i);
    expect(JSON.stringify(body)).not.toMatch(/alice|project\.json|secret-token|open-sesame|route\.ts|\{"password"/i);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(body.debugId);
    expect(lines[0]).toContain('[local path]');
    expect(lines[0]).toContain('[secret redacted]');
    expect(lines[0]).not.toMatch(/alice|secret-token|open-sesame/i);
  });

  it('maps known error classes to stable user-facing codes without echoing details', async () => {
    class DraftInputError extends Error {}
    const response = userFacingErrorResponse(
      new DraftInputError('schema payload was invalid: {"token":"private"}'),
      {
        error: '草稿准备失败，请重试。',
        code: 'draft_failed',
        status: 400,
        logger: vi.fn(),
      },
    );

    await expect(response.json()).resolves.toMatchObject({
      error: '填写内容不符合要求，请检查后重试。',
      code: 'invalid_request',
    });
  });

  it('recognizes Error subclasses even when they keep the default Error name', async () => {
    class InputLimitError extends Error {}
    const response = userFacingErrorResponse(new InputLimitError('private domain-specific detail'), {
      error: '暂时无法处理请求。',
      code: 'request_failed',
      status: 400,
      logger: vi.fn(),
    });

    await expect(response.json()).resolves.toMatchObject({
      error: '填写内容不符合要求，请检查后重试。',
      code: 'invalid_request',
    });
  });

  it('preserves explicitly declared business errors and actions', async () => {
    const cause = new KnownUserFacingError(
      {
        error: '平台后台尚未登录。请先完成登录，再重试。',
        code: 'browser_session_required',
        action: { label: '打开平台后台' },
      },
      { status: 409, detail: new Error('browser profile /Users/alice/profile missing') },
    );
    const response = userFacingErrorResponse(cause, {
      error: '草稿准备失败，请重试。',
      code: 'draft_failed',
      logger: vi.fn(),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: '平台后台尚未登录。请先完成登录，再重试。',
      code: 'browser_session_required',
      action: { label: '打开平台后台' },
    });
  });

  it('supports safe compatibility fields without losing the standard envelope', async () => {
    const response = userFacingErrorResponse(new Error('private internal failure'), {
      error: '暂时无法读取确认状态，请重试。',
      code: 'approval_status_failed',
      status: 500,
      extra: { approved: false },
      legacyMessageField: 'reason',
      logger: vi.fn(),
    });

    await expect(response.json()).resolves.toMatchObject({
      approved: false,
      error: '暂时无法读取确认状态，请重试。',
      reason: '暂时无法读取确认状态，请重试。',
      code: 'approval_status_failed',
    });
  });

  it('builds expected error responses without a diagnostic identifier', async () => {
    const response = expectedUserFacingErrorResponse({
      error: '请先选择一篇作品。',
      code: 'work_required',
      status: 400,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: '请先选择一篇作品。',
      code: 'work_required',
    });
  });

  it('redacts authorization headers and Windows paths from diagnostics', () => {
    const detail = redactSensitiveErrorDetail(
      'Authorization: Bearer abc-secret C:\\Users\\alice\\project.json apiKey=sk-private-value',
    );
    expect(detail).not.toMatch(/abc-secret|alice|sk-private-value/i);
    expect(detail).toMatch(/\[secret redacted\]|\[local path\]/);
  });

  it('redacts deployment paths and standalone high-confidence tokens from diagnostics', () => {
    const detail = redactSensitiveErrorDetail(
      'failed at /workspace/private/config.json with ghp_abcdefghijklmnopqrstuvwxyz123456',
    );

    expect(detail).not.toMatch(/workspace|config\.json|ghp_/i);
    expect(detail).toContain('[local path]');
    expect(detail).toContain('[secret redacted]');
  });

  it('redacts content digests from diagnostic logs', () => {
    const digest = 'a'.repeat(64);
    const detail = redactSensitiveErrorDetail(`content hash=${digest}`);
    expect(detail).not.toContain(digest);
    expect(detail).toContain('[digest redacted]');
  });
});

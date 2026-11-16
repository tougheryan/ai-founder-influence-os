import { describe, expect, it } from 'vitest';

import { readUserFacingFailure, streamQualityWarning } from './useAgentStream';

describe('agent stream user-facing failures', () => {
  it('reads the compatible error field instead of showing raw JSON', async () => {
    const response = Response.json(
      {
        error: '平台数据连接失败。请到系统设置检查密钥后重试。',
        code: 'platform_data_connection_failed',
        debugId: 'err_example',
      },
      { status: 502 },
    );

    await expect(readUserFacingFailure(response)).resolves.toBe(
      '平台数据连接失败。请到系统设置检查密钥后重试。',
    );
  });

  it('does not echo a non-JSON server body', async () => {
    const response = new Response(
      'Error: failed at /Users/alice/private.ts token=secret',
      { status: 500 },
    );

    const message = await readUserFacingFailure(response);
    expect(message).toBe('暂时无法开始生成，请重试。');
    expect(message).not.toMatch(/alice|private|token|secret/i);
  });

  it('turns quality events into short review instructions without echoing raw issues', () => {
    expect(streamQualityWarning({ type: 'language_quality', status: 'review_required' })).toBe(
      '内容已经保存，但有几处表达偏模板化。发布前请再检查一次。',
    );
    expect(streamQualityWarning({ type: 'release_gate', status: 'review_required' })).toBe(
      '全部内容已经保存，但有几处需要你在发布前确认。',
    );
    expect(streamQualityWarning({ type: 'release_gate', status: 'pass' })).toBe('');
  });
});

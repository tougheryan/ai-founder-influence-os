import { describe, expect, it } from 'vitest';

import {
  displayClientError,
  safeFileDisplayName,
  safeLinkDisplayName,
} from './client-error-copy';

describe('client error copy boundary', () => {
  it('preserves safe Chinese business errors and keeps at most two sentences', () => {
    expect(displayClientError(
      new Error('还没有可复盘的发布记录。先保存至少一条发布结果。第三句不会展示。'),
      '暂时无法读取发布记录。请重试。',
    )).toBe('还没有可复盘的发布记录。先保存至少一条发布结果。');
  });

  it('naturalizes internal product terms without changing the underlying error', () => {
    expect(displayClientError(
      '内容包的 pipeline snapshot 不完整。请重新生成。',
      '本期内容不完整。请重新生成。',
    )).toBe('全部内容的制作记录不完整。请重新生成。');
  });

  it('maps network and credential failures without exposing raw details', () => {
    const network = displayClientError(
      new TypeError('Failed to fetch /Users/alice/private.json?token=secret'),
      '读取设置失败。请重试。',
    );
    const credential = displayClientError(
      new Error('TikOmni Token invalid: sk-private-secret'),
      '保存设置失败。请重试。',
    );

    expect(network).toBe('暂时无法连接服务。请检查网络后重试。');
    expect(credential).toBe('平台数据连接失败。请到系统设置检查密钥后重试。');
    expect(`${network}${credential}`).not.toMatch(/alice|private|secret|token/i);
  });

  it('uses the fallback for unknown exceptions, paths, hashes, stacks and raw JSON', () => {
    const causes = [
      new Error('boom at /Users/alice/project/route.ts'),
      new Error('revision hash 0123456789abcdef0123456789abcdef'),
      new Error('bad payload {"access_token":"secret"}'),
      new Error('TypeError: cannot read properties\n    at run (app.js:2:1)'),
      new Error('保存失败：operation aborted，密钥是 sk-private-secret'),
      new Error('文件读取失败：private/project.json'),
    ];

    for (const cause of causes) {
      expect(displayClientError(cause, '暂时无法读取内容。请重新打开后再试。'))
        .toBe('暂时无法读取内容。请重新打开后再试。');
    }
  });

  it('reads safe error envelopes but never stringifies unknown objects', () => {
    expect(displayClientError(
      { code: 'publish_failed', error: '草稿没有保存成功。请重新填入。', debugId: 'err_private' },
      '草稿没有保存成功。请重试。',
    )).toBe('草稿没有保存成功。请重新填入。');
    expect(displayClientError(
      { payload: { token: 'secret' } },
      '草稿没有保存成功。请重试。',
    )).toBe('草稿没有保存成功。请重试。');
  });

  it('shows only safe source labels for links and files', () => {
    expect(safeLinkDisplayName('https://user:password@example.com/post?id=secret#token')).toBe('example.com');
    expect(safeLinkDisplayName('not a url?token=secret')).toBe('这个链接');
    expect(safeFileDisplayName('/Users/alice/访谈记录.pdf')).toBe('访谈记录.pdf');
    expect(safeFileDisplayName('token=super-secret.txt')).toBe('这份文件');
  });
});

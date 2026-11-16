import { describe, expect, it } from 'vitest';
import {
  isTikOmniPlatformContentUrl,
  parseTikOmniContentLinkCollectorOutput,
  readTikOmniPlatformContent,
  tikomniContentLinkRunScope,
  type TikOmniContentLinkCollectorRunner,
} from './tikomni-content-link';

const input = {
  projectId: 'client_alpha',
  runId: 'run-20260724',
  url: 'https://mp.weixin.qq.com/s?__biz=fixture&mid=1',
};

function availablePayload(
  overrides: Record<string, unknown> = {},
  readInput = input,
) {
  const collectorRunId = tikomniContentLinkRunScope(readInput.runId);
  return {
    schema: 'aifios.content-link.v1',
    status: 'available',
    project_id: readInput.projectId,
    run_id: collectorRunId,
    platform: 'wechat_mp',
    content_kind: 'article',
    source_url: readInput.url,
    title: '一篇可读取的公众号文章',
    author: '公开作者',
    published_at: '2026-07-24T10:00:00Z',
    primary_text: '第一段正文。\n\n第二段正文，包含可用于本期素材理解的具体事实。',
    primary_text_source: 'article_body',
    metrics: { views: 12 },
    cover_image: '',
    missing_fields: [],
    raw_path: `sessions/content-link-reads/${readInput.projectId}/${collectorRunId}/raw/fixture.json`,
    normalized_path: `sessions/content-link-reads/${readInput.projectId}/${collectorRunId}/normalized/fixture.json`,
    reason: '',
    ...overrides,
  };
}

describe('TikOmni platform content links', () => {
  it('recognizes only the supported public platform content domains', () => {
    for (const url of [
      'https://mp.weixin.qq.com/s?__biz=fixture&mid=1',
      'https://weixin.qq.com/sph/AbCdEf',
      'https://channels.weixin.qq.com/finder-preview/pages/sph/AbCdEf',
      'https://finder.video.qq.com/AbCdEf',
      'https://v.douyin.com/AbCdEf/',
      'https://www.douyin.com/video/123456789',
      'https://www.xiaohongshu.com/explore/abcdef',
      'https://xhslink.com/AbCdEf',
      'https://xhsurl.com/AbCdEf',
    ]) {
      expect(isTikOmniPlatformContentUrl(url)).toBe(true);
    }

    for (const url of [
      'https://example.com/article',
      'https://weixin.qq.com/s/article',
      'https://mp.weixin.qq.com/home',
      'https://mp.weixin.qq.com.evil.example/s?__biz=fixture',
      'https://www.douyin.com/',
      'ftp://v.douyin.com/AbCdEf/',
      'https://user:secret@mp.weixin.qq.com/s?__biz=fixture',
    ]) {
      expect(isTikOmniPlatformContentUrl(url)).toBe(false);
    }
  });

  it('returns bounded display-safe content and passes a stable safe run scope to the collector', async () => {
    let receivedArgs: readonly string[] = [];
    const runner: TikOmniContentLinkCollectorRunner = async (args) => {
      receivedArgs = args;
      return { stdout: JSON.stringify(availablePayload()) };
    };

    await expect(readTikOmniPlatformContent(input, runner)).resolves.toEqual({
      title: '一篇可读取的公众号文章',
      excerpt: '第一段正文。 第二段正文，包含可用于本期素材理解的具体事实。',
      detail: '第一段正文。\n\n第二段正文，包含可用于本期素材理解的具体事实。',
      platform: 'wechat_mp',
      contentKind: 'article',
    });
    expect(receivedArgs).toContain('--project-id');
    expect(receivedArgs).toContain(input.projectId);
    expect(receivedArgs).toContain('--run-id');
    expect(receivedArgs).toContain(tikomniContentLinkRunScope(input.runId));
    expect(receivedArgs).not.toContain(input.runId);
    expect(receivedArgs).toContain('--source-url');
    expect(receivedArgs).toContain(input.url);
  });

  it('accepts material-compatible uppercase and Chinese run IDs through an ASCII collector scope', async () => {
    const historicalInput = {
      ...input,
      runId: '本期内容-Alpha_01',
    };
    const collectorRunId = tikomniContentLinkRunScope(historicalInput.runId);
    let receivedArgs: readonly string[] = [];
    const runner: TikOmniContentLinkCollectorRunner = async (args) => {
      receivedArgs = args;
      return { stdout: JSON.stringify(availablePayload({}, historicalInput)) };
    };

    await expect(readTikOmniPlatformContent(historicalInput, runner)).resolves.toMatchObject({
      title: '一篇可读取的公众号文章',
      platform: 'wechat_mp',
    });
    expect(collectorRunId).toMatch(/^content-link-[a-f0-9]{64}$/);
    expect(tikomniContentLinkRunScope(historicalInput.runId)).toBe(collectorRunId);
    expect(receivedArgs).toContain(collectorRunId);
    expect(receivedArgs).not.toContain(historicalInput.runId);
  });

  it('returns null only for normal, unsupported pages', async () => {
    const runner: TikOmniContentLinkCollectorRunner = async () => {
      throw new Error('normal pages should not invoke the collector');
    };
    await expect(readTikOmniPlatformContent({ ...input, url: 'https://example.com/article' }, runner)).resolves.toBeNull();
  });

  it('fails explicitly when TikOmni found a title but no readable primary text', async () => {
    const runner: TikOmniContentLinkCollectorRunner = async () => ({
      stdout: JSON.stringify(availablePayload({
        primary_text: '',
        missing_fields: ['primary_text'],
        raw_path: '',
        normalized_path: '',
      })),
    });
    await expect(readTikOmniPlatformContent(input, runner)).rejects.toThrow('没有可用正文');
  });

  it('accepts an incomplete capture when TikOmni still returned readable primary text', async () => {
    const runner: TikOmniContentLinkCollectorRunner = async () => ({
      stdout: JSON.stringify(availablePayload({
        status: 'incomplete',
        missing_fields: ['author', 'metrics', 'cover_image'],
      })),
    });
    await expect(readTikOmniPlatformContent(input, runner)).resolves.toMatchObject({
      title: '一篇可读取的公众号文章',
      detail: '第一段正文。\n\n第二段正文，包含可用于本期素材理解的具体事实。',
    });
  });

  it('distinguishes an unavailable platform interface from configuration or missing text', async () => {
    const runner: TikOmniContentLinkCollectorRunner = async () => ({
      stdout: JSON.stringify(availablePayload({ status: 'unavailable', reason: 'upstream endpoint timed out' })),
    });
    await expect(readTikOmniPlatformContent(input, runner)).rejects.toThrow('平台接口暂时不可用');
  });

  it('rejects collector responses from another project or another source URL', () => {
    expect(() => parseTikOmniContentLinkCollectorOutput(
      availablePayload({ project_id: 'client_beta' }),
      input,
    )).toThrow('不属于当前项目');

    expect(() => parseTikOmniContentLinkCollectorOutput(
      availablePayload({ source_url: 'https://mp.weixin.qq.com/s?__biz=other&mid=2' }),
      input,
    )).toThrow('与当前请求不一致');

    expect(() => parseTikOmniContentLinkCollectorOutput(
      availablePayload({ content_kind: 'video' }),
      input,
    )).toThrow('内容读取结果无效');

    expect(() => parseTikOmniContentLinkCollectorOutput(
      availablePayload({
        raw_path: `sessions/content-link-reads/client_alpha/${tikomniContentLinkRunScope(input.runId)}/normalized/fixture.json`,
        normalized_path: `sessions/content-link-reads/client_alpha/${tikomniContentLinkRunScope(input.runId)}/raw/fixture.json`,
      }),
      input,
    )).toThrow('内容读取结果无效');
  });

  it('reads structured JSON from CLI stderr without exposing a token', async () => {
    const runner: TikOmniContentLinkCollectorRunner = async () => {
      const error = Object.assign(new Error('collector exited non-zero'), {
        stderr: JSON.stringify({
          status: 'unavailable',
          reason: 'TikOmni Token 未配置: token=super-secret-value',
        }),
      });
      throw error;
    };

    try {
      await readTikOmniPlatformContent(input, runner);
      throw new Error('expected TikOmni read to fail');
    } catch (error) {
      expect(error).toHaveProperty('message');
      expect((error as Error).message).toContain('TikOmni 未配置或 Token 无效');
      expect((error as Error).message).not.toContain('super-secret-value');
    }
  });

  it('reads a structured nonzero stdout failure without exposing its token', async () => {
    const runner: TikOmniContentLinkCollectorRunner = async () => {
      const error = Object.assign(new Error('collector exited non-zero'), {
        stdout: JSON.stringify({
          status: 'blocked',
          reason: 'TikOmni Token 未配置: token=super-secret-value',
        }),
      });
      throw error;
    };

    await expect(readTikOmniPlatformContent(input, runner)).rejects.toThrow('TikOmni 未配置或 Token 无效');
  });
});

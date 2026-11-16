import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '@/lib/llm-client';
import { ModelAccountGuide } from './ModelAccountGuide';

const officialKeyHosts: Record<string, string> = {
  openai: 'platform.openai.com', deepseek: 'platform.deepseek.com',
  gemini: 'aistudio.google.com', anthropic: 'platform.claude.com',
  siliconflow: 'cloud.siliconflow.cn', dashscope: 'bailian.console.aliyun.com',
  moonshot: 'platform.kimi.com',
};

describe('account help follows the service that will receive the key', () => {
  it.each(Object.entries(PROVIDER_PRESETS))('provides the right console for the %s preset, including blank default URLs', (provider, preset) => {
    for (const baseUrl of [preset.baseUrl, undefined, '']) {
      const html = renderToStaticMarkup(<ModelAccountGuide provider={provider} baseUrl={baseUrl} />);
      const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => new URL(match[1]));
      expect(links).toHaveLength(2);
      expect(links[0].hostname).toBe(officialKeyHosts[provider]);
      expect(links.every((url) => url.protocol === 'https:')).toBe(true);
      expect(html).not.toMatch(/<details[^>]*\bopen[ =>]/);
    }
  });

  it.each([
    'https://proxy.example/v1',
    'https://api.deepseek.com.proxy.example/v1',
    'http://api.deepseek.com/v1',
    'https://api.deepseek.com:8443/v1',
    'https://api.deepseek.com/anthropic',
    'https://api.deepseek.com/v1?token=private-value',
    'https://api.deepseek.com/v1#private-value',
    'https://private-value@api.deepseek.com/v1',
    'not-a-url',
  ])('does not imply an official account will work with %s', (baseUrl) => {
    const html = renderToStaticMarkup(<ModelAccountGuide provider="deepseek" baseUrl={baseUrl} />);
    expect(html).toContain('自定义设置');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('private-value');
  });

  it('handles a region change and an unknown provider without sending users to the Beijing console or a fallback provider', () => {
    const region = renderToStaticMarkup(<ModelAccountGuide provider="dashscope" baseUrl="https://dashscope-intl.aliyuncs.com/compatible-mode/v1" />);
    const unknown = renderToStaticMarkup(<ModelAccountGuide provider="custom" baseUrl={PROVIDER_PRESETS.deepseek.baseUrl} />);
    const inherited = renderToStaticMarkup(<ModelAccountGuide provider="constructor" />);
    for (const html of [region, unknown, inherited]) {
      expect(html).toContain('自定义设置');
      expect(html).not.toContain('href=');
    }
  });

  it('accepts the official default port and a trailing slash without classifying them as another service', () => {
    const html = renderToStaticMarkup(<ModelAccountGuide provider="deepseek" baseUrl="https://api.deepseek.com:443/v1/" />);
    expect(html).toContain('href="https://platform.deepseek.com/api_keys"');
  });

  it('never asks hosted customers to buy a separate provider key', () => {
    expect(renderToStaticMarkup(<ModelAccountGuide provider="deepseek" connectionMode="hosted" />)).toBe('');
    expect(renderToStaticMarkup(<ModelAccountGuide provider="aifios-hosted" connectionMode="direct" />)).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { assertVisualRevisionClientShape, parseWechatLayout } from './visual-revision-request';

const binding = { theme: 'elegant-blue', source_package_sha256: 'a'.repeat(64) };
const refinement = {
  profile: 'title-spacing-v1', title_lines: ['AI 降低了上手门槛，', '专业门槛呢？'],
  heading_blocks: [{ block_index: 4, text_sha256: 'b'.repeat(64), segments: ['行业经验', '与 AI'] }],
};

describe('bounded WeChat layout request', () => {
  it('preserves exact text and accepts a theme-only or source-bound refinement', () => {
    expect(parseWechatLayout(binding)).toEqual(binding);
    const layout = { ...binding, refinement };
    expect(parseWechatLayout(layout)).toEqual(layout);
    expect(() => assertVisualRevisionClientShape({ slug: 'demo', request: '调整排版', wechatLayout: layout })).not.toThrow();
  });

  it.each([
    { ...binding, html: '<section>replacement</section>' },
    { ...binding, trusted: true },
    { ...binding, source_package_sha256: 'invalid' },
    { ...binding, theme: '../outside' },
    { ...binding, theme: 'a'.repeat(65) },
    { ...binding, refinement: { ...refinement, css: 'h1{color:red}' } },
    { ...binding, refinement: { ...refinement, profile: 'custom' } },
    { ...binding, refinement: { ...refinement, title_lines: ['<img src=x>'] } },
    { ...binding, refinement: { ...refinement, title_lines: ['a\nb'] } },
    { ...binding, refinement: { ...refinement, title_lines: ['a'.repeat(501)] } },
    { ...binding, refinement: { ...refinement, title_lines: ['a', 'b', 'c', 'd'] } },
    { ...binding, refinement: { ...refinement, heading_blocks: [{ ...refinement.heading_blocks[0], block_index: 10000 }] } },
    { ...binding, refinement: { ...refinement, heading_blocks: [{ ...refinement.heading_blocks[0], block_index: -1 }] } },
    { ...binding, refinement: { ...refinement, heading_blocks: [refinement.heading_blocks[0], refinement.heading_blocks[0]] } },
    { ...binding, refinement: { ...refinement, heading_blocks: Array.from({ length: 31 }, (_, block_index) => ({ ...refinement.heading_blocks[0], block_index })) } },
    { ...binding, refinement: { ...refinement, heading_blocks: [{ ...refinement.heading_blocks[0], segments: [''] }] } },
  ])('rejects unrestricted, malformed or oversized layout data (%#)', (layout) => {
    expect(() => parseWechatLayout(layout)).toThrow();
  });

  it('accepts the exact bounded maximum', () => {
    expect(parseWechatLayout({ ...binding, refinement: { ...refinement,
      title_lines: ['a'.repeat(500)], heading_blocks: [{ ...refinement.heading_blocks[0], block_index: 9999 }],
    } })?.refinement?.heading_blocks[0].block_index).toBe(9999);
  });
});

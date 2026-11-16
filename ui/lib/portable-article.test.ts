import { describe, expect, it, vi } from 'vitest';
import { parse, serialize } from 'parse5';
import { preparePortableArticle, portableArticleRoot, MAX_PORTABLE_IMAGE_BYTES } from './portable-article';
const path = 'pipeline/visual/my-article/publish/r001/wechat/wechat-article.html';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=', 'base64');
const render = (text: string, load = vi.fn(async () => png)) => preparePortableArticle(Buffer.from(text), path, load);

describe('portable article export', () => {
  it('embeds exact image bytes, keeps copy and styles, and makes repeated uses share one read', async () => {
    const load = vi.fn(async () => png);
    const source = '<!doctype html><html><head><style>p{color:#123456}</style></head><body><p>虚构示例：范围与预算</p><img alt="测试图" src="../inline/a.png"><img src="../inline/a.png" loading="lazy"><a href="https://example.org/source">引用</a></body></html>';
    const result = (await render(source, load)).toString();
    expect(result).toContain(`src="data:image/png;base64,${png.toString('base64')}"`);
    expect(result).toContain('虚构示例：范围与预算');
    expect(result).toContain('p{color:#123456}');
    expect(result).toContain('href="https://example.org/source"');
    expect(result).not.toContain('../inline');
    expect(result).toContain('loading="eager"');
    expect(result).toContain('Content-Security-Policy');
    expect(load).toHaveBeenCalledExactlyOnceWith('pipeline/visual/my-article/publish/r001/inline/a.png');
  });
  it('parses quoted attributes and HTML entities, leaving image-looking text untouched', async () => {
    const load = vi.fn(async () => png);
    const result = (await render('<p>&lt;img src="not-a-file"&gt;</p><!-- <img src="not-a-file"> --><img title="a>b" src="../inline/图%20片.png?one=1&amp;two=2">', load)).toString();
    expect(load).toHaveBeenCalledExactlyOnceWith('pipeline/visual/my-article/publish/r001/inline/图 片.png');
    expect(result).toContain('&lt;img src="not-a-file"&gt;');
  });
  it('carries local CSS background images and SVG image references into the file', async () => {
    const load = vi.fn(async () => png);
    const result = (await render('<style>section{background:url("../inline/a.png")}</style><section style="background-image:url(../inline/a.png)"></section><svg><image href="../inline/a.png" /></svg>', load)).toString();
    expect(result.match(/data:image\/png;base64/g)).toHaveLength(3);
    expect(load).toHaveBeenCalledOnce();
  });
  it('preserves valid embedded images without any file read', async () => {
    const load = vi.fn(async () => png);
    await render(`<img src="data:image/png;base64,${png.toString('base64')}">`, load);
    expect(load).not.toHaveBeenCalled();
  });
  it('keeps local SVG symbol references and refuses external symbols instead of losing them offline', async () => {
    expect((await render('<svg><defs><g id="icon"><path d="M0 0" /></g></defs><use href="#icon" /></svg>')).toString()).toContain('href="#icon"');
    await expect(render('<svg><use href="icons.svg#icon" /></svg>')).rejects.toThrow('外部文件');
  });
  it.each(['../../r002/inline/a.png', '../../../../other/publish/r001/a.png', '%2Fetc/private.png', '..%2f..%2fr002/a.png', '../inline/secret.json', '..\\secret.png', 'https://example.org/a.png', '//example.org/a.png', 'file:///tmp/a.png'])('refuses outside or unsupported resource %s without reading it', async (src) => {
    const load = vi.fn(async () => png);
    await expect(render(`<img src="${src}">`, load)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
  it.each(['<img>', '<img src="../a.png" srcset="other.png 2x">', '<link rel="stylesheet" href="remote.css">', '<style>@import "remote.css";</style>', '<style>x{background:url("../a.png" broken)}</style>', '<iframe src="remote.html"></iframe>'])('reports incomplete resources instead of claiming a complete file: %s', async (source) => {
    await expect(render(source)).rejects.toThrow();
  });
  it('drops scripts, base and refresh and blocks active attributes even on offline reopen', async () => {
    const result = (await render('<head><base href="https://example.org/"><meta http-equiv="refresh" content="0;url=https://example.org/"></head><body onload="alert(1)"><script>fetch("remote")</script><p>文章保留</p></body>')).toString();
    expect(result).not.toContain('<script');expect(result).not.toContain('<base');expect(result).not.toContain('onload');
    expect(result).not.toContain('refresh');expect(result).toContain('文章保留');
    expect(serialize(parse(result))).toContain("default-src 'none'");
  });
  it('propagates a missing image and bounds image data before serializing the export', async () => {
    await expect(render('<img src="../inline/a.png">', vi.fn(async () => { throw new Error('missing'); }))).rejects.toThrow('missing');
    await expect(render('<img src="../inline/a.png">', vi.fn(async () => Buffer.alloc(MAX_PORTABLE_IMAGE_BYTES + 1)))).rejects.toMatchObject({ status: 413 });
    await expect(render('<img src="../inline/a.png">', vi.fn(async () => Buffer.from('not an image')))).rejects.toThrow('无法识别的配图');
  });
  it('only transforms publishable article HTML, including the historical article location', () => {
    expect(portableArticleRoot(path)).toBe('pipeline/visual/my-article/publish/r001/');
    expect(portableArticleRoot('pipeline/visual/old/publish/wechat-article.html')).toBe('pipeline/visual/old/publish/');
    expect(portableArticleRoot('quality/report.html')).toBeNull();
  });
  it('bounds repeated image expansion before serializing an oversized document', async () => {
    const large = Buffer.alloc(1024 * 1024); png.copy(large);
    const load = vi.fn(async () => large);
    await expect(render('<img src="../inline/a.png">'.repeat(40), load)).rejects.toMatchObject({ status: 413 });
    expect(load).toHaveBeenCalledOnce();
  });
});

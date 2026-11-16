#!/usr/bin/env python3
"""Echo Founder MIT-licensed offline Markdown renderer.

The historical module path is retained for runtime compatibility. This public
implementation does not contain DBS prompts, templates, or stylesheets.
"""
from __future__ import annotations

import argparse
import html
import re
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif'
STYLE_SPECS = [
    ('minimal', '简洁阅读', '#276749', '#ffffff'),
    ('medium', '长文阅读', '#374151', '#ffffff'),
    ('wired', '重点提示', '#164e63', '#f8fafc'),
    ('verge', '深色强调', '#6b21a8', '#ffffff'),
    ('stripe', '清楚分节', '#1d4ed8', '#ffffff'),
    ('apple', '轻量留白', '#1f2937', '#ffffff'),
    ('ft', '温暖纸色', '#7c482d', '#fffaf3'),
    ('linear', '紧凑结构', '#4338ca', '#ffffff'),
    ('github', '技术笔记', '#334155', '#ffffff'),
    ('notion', '日常笔记', '#44403c', '#fffefc'),
    ('magazine', '观点杂志', '#9f1239', '#ffffff'),
    ('editorial', '编辑手记', '#475569', '#fffdf8'),
    ('newspaper', '新闻阅读', '#172554', '#ffffff'),
    ('course', '课程笔记', '#115e59', '#ffffff'),
    ('event', '活动记录', '#9a3412', '#ffffff'),
    ('publish_template', '公众号正文', '#276749', '#ffffff'),
]
ALL_ORDER = [item[0] for item in STYLE_SPECS]
PREVIEW_ORDER = ['minimal', 'medium', 'stripe', 'wired', 'ft', 'course']


def stylesheet(accent: str, background: str) -> str:
    return (
        f'body{{font-family:{FONT};color:#263238;background:{background};'
        'font-size:16px;line-height:1.9;max-width:720px;margin:auto;padding:24px;'
        'overflow-wrap:anywhere;box-sizing:border-box;}'
        'h1{font-size:27px;line-height:1.45;margin:12px 0 28px;}'
        f'h2{{font-size:21px;line-height:1.5;color:{accent};margin:38px 0 20px;}}'
        'h3,h4,h5,h6{font-size:18px;line-height:1.6;margin:26px 0 14px;}'
        'p{margin:0 0 20px;}ul,ol{padding-left:24px;}li{margin:8px 0;}'
        f'blockquote{{margin:24px 0;padding:8px 16px;border-left:3px solid {accent};background:#f5f7f8;}}'
        f'a{{color:{accent};text-decoration:underline;overflow-wrap:anywhere;}}'
        'code{font-family:monospace;font-size:.9em;background:#f1f5f9;padding:2px 4px;}'
        'pre{overflow:auto;background:#f1f5f9;padding:16px;white-space:pre-wrap;}'
        'pre code{padding:0;}img{max-width:100%;height:auto;}'
        'hr{border:0;border-top:1px solid #dbe3e8;margin:30px 0;}'
    )


STYLES = {key: (label, '公众号文章与内容笔记', stylesheet(accent, background))
          for key, label, accent, background in STYLE_SPECS}


def load_styles_from_markdown() -> dict:
    """Return the public renderer catalog; no external templates are loaded."""
    return dict(STYLES)


def safe_link(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        return parsed.scheme.lower() in {'http', 'https'} and bool(parsed.netloc) and not any(ord(c) < 32 for c in value)
    except ValueError:
        return False


TOKENS = re.compile(r'`([^`]+)`|(?<!!)\[([^\]\n]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)|\*\*(.+?)\*\*')


def inline_format(text: str) -> str:
    pieces, offset = [], 0
    for match in TOKENS.finditer(text):
        pieces.append(html.escape(text[offset:match.start()]))
        code, label, target, bold = match.groups()
        if code is not None:
            pieces.append('<code>' + html.escape(code) + '</code>')
        elif label is not None and safe_link(target):
            pieces.append('<a href="' + html.escape(target, quote=True) + '">' + inline_format(label) + '</a>')
        elif bold is not None:
            pieces.append('<strong>' + inline_format(bold) + '</strong>')
        else:
            pieces.append(html.escape(match.group(0)))
        offset = match.end()
    pieces.append(html.escape(text[offset:]))
    return ''.join(pieces)


def md_to_html(markdown: str) -> str:
    text = re.sub(r'<!--.*?-->', '', markdown.replace('\r\n', '\n'), flags=re.S)
    output, pending, code_lines = [], [], []
    kind, in_code = None, False

    def flush():
        nonlocal kind
        if pending:
            content = inline_format(' '.join(pending))
            tag = 'blockquote' if kind == 'quote' else 'p'
            output.append('<' + tag + '>' + content + '</' + tag + '>')
            pending.clear()
        kind = None

    for line in text.split('\n'):
        if line.startswith('```'):
            flush()
            if in_code:
                output.append('<pre><code>' + html.escape('\n'.join(code_lines)) + '</code></pre>')
                code_lines.clear()
            in_code = not in_code
            continue
        if in_code:
            code_lines.append(line)
            continue
        if not line.strip():
            flush()
            continue
        if re.fullmatch(r'\s*---\s*', line):
            flush()
            output.append('<hr>')
            continue
        heading = re.match(r'^(#{1,6})\s+(.+)$', line)
        bullet = re.match(r'^\s*[-*+]\s+(.+)$', line)
        if heading:
            flush()
            level = str(len(heading.group(1)))
            output.append('<h' + level + '>' + inline_format(heading.group(2)) + '</h' + level + '>')
        elif bullet:
            flush()
            output.append('<ul><li>' + inline_format(bullet.group(1)) + '</li></ul>')
        else:
            next_kind = 'quote' if line.startswith('>') else 'paragraph'
            if kind != next_kind:
                flush()
            kind = next_kind
            pending.append(line[1:].strip() if next_kind == 'quote' else line)
    flush()
    if in_code:
        output.append('<pre><code>' + html.escape('\n'.join(code_lines)) + '</code></pre>')
    return '\n'.join(output)


def build_html(title: str, body_html: str, css: str) -> str:
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>' + html.escape(title) + '</title><style>' + css + '</style></head>'
            '<body>' + body_html + '</body></html>')


def main() -> int:
    parser = argparse.ArgumentParser(description='Render local WeChat-compatible article previews.')
    parser.add_argument('--input', required=True)
    parser.add_argument('--output-dir')
    parser.add_argument('--mode', choices=['preview', 'all'], default='preview')
    parser.add_argument('--style')
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    source = Path(args.input)
    target = Path(args.output_dir) if args.output_dir else source.parent / '公众号HTML输出'
    target.mkdir(parents=True, exist_ok=True)
    catalog = load_styles_from_markdown()
    selected = [args.style] if args.style else (ALL_ORDER if args.mode == 'all' else PREVIEW_ORDER)
    if any(key not in catalog for key in selected):
        parser.error('Unknown style; choose one of: ' + ', '.join(ALL_ORDER))
    article = md_to_html(source.read_text(encoding='utf-8'))
    links = []
    for key in selected:
        label, _, css = catalog[key]
        name = source.stem + '_' + key + '.html'
        (target / name).write_text(build_html(source.stem, article, css), encoding='utf-8')
        links.append('<p><a href="' + html.escape(name, quote=True) + '">' + html.escape(label) + '</a></p>')
    index = target / 'index.html'
    index.write_text(build_html(source.stem, ''.join(links), catalog['minimal'][2]), encoding='utf-8')
    print(str(index))
    if args.open:
        webbrowser.open(index.resolve().as_uri())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

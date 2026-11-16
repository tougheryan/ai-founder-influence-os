"""Compare source Markdown with rendered article text, without rendering the source."""
from __future__ import annotations

import hashlib
import json
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

SCHEMA = "echo-founder.wechat-fidelity.v1"
TOKEN = re.compile(r"`([^`]+)`|(?<!!)\[([^\]\n]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)|\*\*(.+?)\*\*")
BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "div", "section", "article"}


def _normalize(text):
    return re.sub(r"\s+", " ", text).strip()


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _safe_url(target):
    try:
        parsed = urlsplit(target)
        return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc) and not any(ord(c) < 32 for c in target)
    except ValueError:
        return False


def _plain(text, links):
    result = []
    position = 0
    for match in TOKEN.finditer(text):
        result.append(text[position:match.start()])
        code, label, target, strong = match.groups()
        if code is not None:
            result.append(code)
        elif label is not None and _safe_url(target):
            label_text = _plain(label, [])
            result.append(label_text)
            links.append([_normalize(label_text), target])
        elif strong is not None:
            result.append(_plain(strong, links))
        else:
            result.append(match.group(0))
        position = match.end()
    return ''.join(result) + text[position:]


def _source_blocks(title, body):
    blocks, links, pending = [title.strip()], [], []
    code = False
    kind = None

    def flush():
        if pending:
            text = ' '.join(pending)
            blocks.append(_normalize(text if kind == 'code' else _plain(text, links)))
            pending.clear()

    text = re.sub(r"<!--.*?-->", "", body.replace('\r\n', '\n'), flags=re.S)
    for line in text.split('\n'):
        if line.startswith('```'):
            flush()
            code = not code
            kind = 'code' if code else None
        elif code:
            pending.append(line)
        elif not line.strip() or re.fullmatch(r'\s*---\s*', line):
            flush()
            kind = None
        elif re.match(r'^#{1,6}\s+', line) or re.match(r'^\s*[-*+]\s+', line):
            flush()
            blocks.append(_normalize(_plain(re.sub(r'^(?:#{1,6}|\s*[-*+])\s+', '', line), links)))
            kind = None
        else:
            next_kind = 'quote' if line.startswith('>') else 'paragraph'
            if next_kind != kind:
                flush()
            kind = next_kind
            pending.append(line[1:].strip() if next_kind == 'quote' else line)
    flush()
    return blocks, links


class ArticleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks, self.links, self.errors, self.pending = [], [], [], []
        self.ignored = []
        self.anchor = None
        self.figure = None
        self.figures = []

    def flush(self):
        text = _normalize(''.join(self.pending))
        if text:
            self.blocks.append(text)
        self.pending.clear()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"script", "iframe", "object", "embed"} or any(name.startswith('on') for name in attrs):
            self.errors.append('公众号 HTML 含可执行或不支持的内容。')
        if tag in {'head', 'script', 'style', 'template'}:
            self.ignored.append(tag)
        if self.ignored:
            return
        if tag == 'figure' and attrs.get('data-aifios-asset-id'):
            self.flush()
            if self.figure is not None:
                self.errors.append('公众号正文配图不能嵌套。')
            self.figure = [attrs['data-aifios-asset-id'], []]
        if tag in BLOCK_TAGS:
            self.flush()
        if tag == 'br':
            self.pending.append(' ')
        if tag == 'a':
            target = attrs.get('href') or ''
            if not _safe_url(target):
                self.errors.append('公众号引用地址不是安全的 HTTP/HTTPS 链接。')
            if self.anchor is not None:
                self.errors.append('公众号引用链接不能嵌套。')
            self.anchor = [[], target]

    def handle_endtag(self, tag):
        if self.ignored:
            if tag == self.ignored[-1]:
                self.ignored.pop()
            return
        if tag == 'figure' and self.figure is not None:
            self.figures.append([self.figure[0], _normalize(''.join(self.figure[1]))])
            self.figure = None
        if tag == 'a' and self.anchor is not None:
            self.links.append([_normalize(''.join(self.anchor[0])), self.anchor[1]])
            self.anchor = None
        if tag in BLOCK_TAGS:
            self.flush()

    def handle_data(self, data):
        if not self.ignored:
            if self.figure is not None:
                self.figure[1].append(data)
            else:
                self.pending.append(data)
            if self.anchor is not None:
                self.anchor[0].append(data)


def check_wechat_html(title: str, body: str, rendered: str, *, figure_captions: dict[str, str] | None = None) -> dict:
    expected, links = _source_blocks(title, body)
    parser = ArticleParser()
    parser.feed(rendered)
    parser.close()
    parser.flush()
    errors = list(dict.fromkeys(parser.errors))
    if expected != parser.blocks:
        errors.append('公众号排版文字、标点或段落顺序与原稿不一致。')
    if links != parser.links:
        errors.append('公众号排版引用文字、顺序或链接地址与原稿不一致。')
    expected_figures = sorted([[key, _normalize(value)] for key, value in (figure_captions or {}).items()])
    if sorted(parser.figures) != expected_figures or parser.figure is not None:
        errors.append('公众号正文配图说明与配方不一致。')
    return {
        'schema': SCHEMA, 'status': 'failed' if errors else 'pass', 'errors': errors,
        'block_count': len(expected), 'rendered_block_count': len(parser.blocks),
        'link_count': len(links), 'rendered_link_count': len(parser.links),
        'expected_text_sha256': _digest(expected), 'rendered_text_sha256': _digest(parser.blocks),
        'expected_links_sha256': _digest(links), 'rendered_links_sha256': _digest(parser.links),
    }


def verified_fidelity(output: dict) -> bool:
    proof = output.get('wechat_fidelity')
    if not isinstance(proof, dict) or proof.get('schema') != SCHEMA or proof.get('status') != 'pass' or proof.get('errors') != []:
        return False
    for key in ('text', 'links'):
        digest = proof.get(f'expected_{key}_sha256')
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest) or digest != proof.get(f'rendered_{key}_sha256'):
            return False
    return bool(
        proof.get('output_sha256') == output.get('sha256')
        and re.fullmatch(r'[0-9a-f]{64}', str(proof.get('source_package_sha256', '')))
        and isinstance(proof.get('block_count'), int) and proof['block_count'] > 0
        and proof['block_count'] == proof.get('rendered_block_count')
        and isinstance(proof.get('link_count'), int) and proof['link_count'] >= 0
        and proof['link_count'] == proof.get('rendered_link_count')
    )

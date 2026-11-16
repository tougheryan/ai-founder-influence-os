"""Bounded typography changes bound to an unchanged WeChat source package.

This module does no I/O. It accepts explicit source-block anchors, never a
replacement article, HTML fragment, CSS string, or a destination path.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import html
import re
from typing import Any

from wechat_fidelity import ArticleParser, BLOCK_TAGS, _normalize, _source_blocks, check_wechat_html


_SHA = re.compile(r"[0-9a-f]{64}\Z")
_THEME = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
_CONTROL_OR_HTML = re.compile(r"[<>\x00-\x1f\x7f]")
_PROFILE = "title-spacing-v1"
_VOID_TAGS = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"})
_STYLE_ATTRIBUTE = re.compile(r"(?<![\w:-])style\s*=\s*([\"'])(.*?)\1", re.I | re.S)


def _object_keys(value: Any, allowed: set[str], required: set[str], label: str) -> list[str]:
    if not isinstance(value, dict):
        return [f"{label} must be an object"]
    errors = []
    if set(value) - allowed:
        errors.append(f"{label} contains unsupported fields")
    if required - set(value):
        errors.append(f"{label} is missing required fields")
    return errors


def _text_segments(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 3:
        return [f"{label} must contain 1 to 3 text segments"]
    if any(not isinstance(part, str) or not part.strip() or len(part) > 500 or _CONTROL_OR_HTML.search(part) for part in value):
        return [f"{label} contains invalid text"]
    return []


def validate_wechat_layout(layout: Any) -> list[str]:
    """Validate only the declarative shape, without trusting source anchors."""
    errors = _object_keys(layout, {"theme", "source_package_sha256", "refinement"}, {"theme", "source_package_sha256"}, "wechat_layout")
    if not isinstance(layout, dict):
        return errors
    if not isinstance(layout.get("theme"), str) or not _THEME.fullmatch(layout["theme"]):
        errors.append("wechat_layout theme is invalid")
    if not isinstance(layout.get("source_package_sha256"), str) or not _SHA.fullmatch(layout["source_package_sha256"]):
        errors.append("wechat_layout source_package_sha256 is invalid")
    if "refinement" not in layout:
        return errors
    refinement = layout["refinement"]
    fields = {"profile", "title_lines", "heading_blocks"}
    errors.extend(_object_keys(refinement, fields, fields, "wechat_layout refinement"))
    if not isinstance(refinement, dict):
        return errors
    if refinement.get("profile") != _PROFILE:
        errors.append("wechat_layout refinement profile is unsupported")
    errors.extend(_text_segments(refinement.get("title_lines"), "title_lines"))
    headings = refinement.get("heading_blocks")
    if not isinstance(headings, list) or len(headings) > 30:
        errors.append("heading_blocks must be a list of at most 30 anchors")
        return errors
    indices = set()
    for heading in headings:
        fields = {"block_index", "text_sha256", "segments"}
        errors.extend(_object_keys(heading, fields, fields, "heading anchor"))
        if not isinstance(heading, dict):
            continue
        index = heading.get("block_index")
        if type(index) is not int or not 0 <= index <= 9999:
            errors.append("heading block_index must be a nonnegative integer at most 9999")
        elif index in indices:
            errors.append("heading block_index must be unique")
        else:
            indices.add(index)
        if not isinstance(heading.get("text_sha256"), str) or not _SHA.fullmatch(heading["text_sha256"]):
            errors.append("heading text_sha256 is invalid")
        errors.extend(_text_segments(heading.get("segments"), "heading segments"))
    return errors


def _eligible_source_lines(body: str) -> dict[int, tuple[int, int, str]]:
    """Map canonical body-block indices to explicit, one-line heading syntax.

    Prefix parsing uses the same block numbering as the independent fidelity
    checker. Comments are masked, retaining offsets. Fenced, indented, quoted,
    and list content never becomes an eligible heading.
    """
    shadow = re.sub(r"<!--.*?-->", lambda m: re.sub(r"[^\n]", " ", m[0]), body, flags=re.S)
    lines = shadow.splitlines(keepends=True)
    result: dict[int, tuple[int, int, str]] = {}
    fence: tuple[str, int] | None = None
    offset = 0
    for number, raw in enumerate(lines):
        line = raw.rstrip("\r\n")
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if marker:
            token, rest = marker.groups()
            if fence is None:
                fence = token[0], len(token)
            elif token[0] == fence[0] and len(token) >= fence[1] and not rest.strip():
                fence = None
            offset += len(raw)
            continue
        if fence is not None:
            offset += len(raw)
            continue
        explicit = re.fullmatch(r"#{1,6}\s+([^\r\n]+?)\s*", line)
        bold = re.fullmatch(r"\*\*([^*\r\n]+)\*\*[ \t]*", line)
        isolated = (number == 0 or not lines[number - 1].strip()) and (number == len(lines) - 1 or not lines[number + 1].strip())
        match = explicit or (bold if isolated else None)
        if match:
            value = match[1]
            # Replacing inline Markdown could discard references or emphasis.
            # Headings with those constructs require a separate reviewed path.
            if not re.search(r"[<>`\[\]*\\]", value):
                index = len(_source_blocks("", body[:offset])[0]) - 1
                result[index] = (offset, offset + len(line), _normalize(value))
        offset += len(raw)
    return result


def validate_refinement_source(title: str, body: str, layout: Any, source_package_sha256: str) -> list[str]:
    """Bind presentation-only parameters to the current source before rendering."""
    errors = validate_wechat_layout(layout)
    if errors:
        return errors
    if not isinstance(source_package_sha256, str) or not _SHA.fullmatch(source_package_sha256) or layout["source_package_sha256"] != source_package_sha256:
        errors.append("wechat_layout source package changed; review the layout again")
    if not isinstance(title, str) or not title.strip() or not isinstance(body, str):
        errors.append("wechat_layout requires a title and source body")
        return errors
    refinement = layout.get("refinement")
    if refinement is None:
        return errors
    if "".join(refinement["title_lines"]) != title.strip():
        errors.append("title_lines do not reproduce the source title")
    blocks = _source_blocks(title, body)[0][1:]
    eligible = _eligible_source_lines(body)
    for heading in refinement["heading_blocks"]:
        index = heading["block_index"]
        if index >= len(blocks):
            errors.append("heading anchor is outside the source body")
            continue
        text = blocks[index]
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != heading["text_sha256"]:
            errors.append("heading anchor text changed; review the layout again")
        if "".join(heading["segments"]) != text:
            errors.append("heading segments do not reproduce the source block")
        if index not in eligible or eligible[index][2] != text:
            errors.append("heading anchor must identify a standalone bold or Markdown heading; code, quotes, lists and ordinary paragraphs are not eligible")
    return errors


def _require_source(title: str, body: str, layout: Any, source_package_sha256: str) -> None:
    errors = validate_refinement_source(title, body, layout, source_package_sha256)
    if errors:
        raise ValueError("; ".join(dict.fromkeys(errors)))


def prepare_wechat_markdown(title: str, body: str, layout: dict[str, Any], source_package_sha256: str) -> str:
    """Promote only explicitly anchored headings in a renderer input copy."""
    _require_source(title, body, layout, source_package_sha256)
    refinement = layout.get("refinement")
    prepared = body
    if refinement:
        eligible = _eligible_source_lines(body)
        replacements = [eligible[item["block_index"]] for item in refinement["heading_blocks"]]
        for start, end, text in sorted(replacements, reverse=True):
            prepared = prepared[:start] + "## " + text + prepared[end:]
    if _source_blocks(title, prepared) != _source_blocks(title, body):
        raise ValueError("heading mapping changed article text or references")
    return f"# {title.strip()}\n\n{prepared.strip()}\n"


@dataclass
class _Node:
    tag: str
    start: int
    opening_end: int
    attrs: list[tuple[str, str | None]]
    parent: _Node | None
    closing_start: int = -1
    end: int = -1


class _LocatedArticleParser(ArticleParser):
    """Associate fidelity blocks with original byte-preserving HTML slices."""

    def __init__(self, rendered: str):
        super().__init__()
        self.rendered = rendered
        self.line_offsets = [0]
        self.line_offsets.extend(match.end() for match in re.finditer("\n", rendered))
        self.stack: list[_Node] = []
        self.nodes: list[_Node] = []
        self.block_nodes: list[_Node | None] = []

    def _source_offset(self) -> int:
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def flush(self):
        if _normalize("".join(self.pending)):
            self.block_nodes.append(next((node for node in reversed(self.stack) if node.tag in BLOCK_TAGS), None))
        super().flush()

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        if len({name for name, _ in attrs}) != len(attrs):
            raise ValueError("md2wechat HTML contains duplicate attributes")
        start = self._source_offset()
        node = _Node(tag, start, start + len(self.get_starttag_text()), attrs, self.stack[-1] if self.stack else None)
        self.nodes.append(node)
        if tag not in _VOID_TAGS:
            self.stack.append(node)
        else:
            node.closing_start = node.end = node.opening_end

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_TAGS:
            node = self.stack.pop()
            node.closing_start = node.end = node.opening_end

    def handle_endtag(self, tag):
        if tag in _VOID_TAGS or not self.stack or self.stack[-1].tag != tag:
            raise ValueError("md2wechat HTML structure does not match the expected article")
        super().handle_endtag(tag)
        node = self.stack.pop()
        node.closing_start = self._source_offset()
        end = self.rendered.find(">", node.closing_start)
        if end < 0:
            raise ValueError("md2wechat HTML contains an incomplete closing tag")
        node.end = end + 1

    def close(self):
        super().close()
        self.flush()
        if self.stack:
            raise ValueError("md2wechat HTML contains unclosed elements")


def _updated_opening(rendered: str, node: _Node, changes: dict[str, str]) -> str:
    opening = rendered[node.start:node.opening_end]
    matches = list(_STYLE_ATTRIBUTE.finditer(opening))
    if len(matches) != 1:
        raise ValueError("md2wechat heading/container styles are missing or ambiguous")
    match = matches[0]
    style = match[2]
    values: dict[str, str] = {}
    for declaration in style.split(";"):
        if not declaration.strip():
            continue
        if ":" not in declaration:
            raise ValueError("md2wechat returned an unsupported style declaration")
        key, value = declaration.strip().split(":", 1)
        if key in values:
            raise ValueError("md2wechat returned duplicate style declarations")
        values[key] = value.strip()
    values.update(changes)
    result = "; ".join(f"{key}: {value}" for key, value in values.items()) + ";"
    return opening[:match.start(2)] + result + opening[match.end(2):]


def _is_ancestor(ancestor: _Node, node: _Node | None) -> bool:
    while node is not None:
        if node is ancestor:
            return True
        node = node.parent
    return False


def refine_wechat_html(rendered: str, title: str, body: str, layout: dict[str, Any], source_package_sha256: str) -> str:
    """Apply the fixed profile to mapped headings, preserving all prose bytes."""
    _require_source(title, body, layout, source_package_sha256)
    fidelity = check_wechat_html(title, body, rendered)
    if fidelity["status"] != "pass":
        raise ValueError("md2wechat HTML does not preserve the source article")
    refinement = layout.get("refinement")
    if not refinement:
        return rendered
    parser = _LocatedArticleParser(rendered)
    parser.feed(rendered)
    parser.close()
    if not parser.block_nodes or parser.block_nodes[0] is None or parser.block_nodes[0].tag != "h1":
        raise ValueError("md2wechat title heading is missing")
    title_node = parser.block_nodes[0]
    containers = [node for node in parser.nodes if node.tag == "section" and all(_is_ancestor(node, block) for block in parser.block_nodes)]
    if not containers:
        raise ValueError("md2wechat article container is missing")
    container = containers[-1]
    patches: list[tuple[int, int, str]] = [
        (container.start, container.opening_end, _updated_opening(rendered, container, {"padding": "20px 16px 24px"}))
    ]

    def heading_patch(node: _Node, text: str, segments: list[str], main: bool):
        # A heading with links or nested markup needs review instead of having
        # its inline structure silently discarded by this typography profile.
        original_content = rendered[node.opening_end:node.closing_start]
        if "<" in original_content or html.unescape(original_content) != text:
            raise ValueError("md2wechat heading structure changed; review the layout again")
        changes = {"line-height": "1.45em", "letter-spacing": "0", "padding-bottom": "12px", "margin-bottom": "24px"} if main else {
            "font-size": "20px", "line-height": "1.5em", "margin-top": "32px", "margin-bottom": "18px"}
        opening = _updated_opening(rendered, node, changes)
        if main or len(segments) > 1:
            display = "block" if main else "inline-block"
            content = "".join(f'<span style="display:{display};white-space:nowrap;">{html.escape(part)}</span>' for part in segments)
        else:
            content = html.escape(segments[0])
        patches.append((node.start, node.end, opening + content + rendered[node.closing_start:node.end]))

    heading_patch(title_node, title.strip(), refinement["title_lines"], True)
    blocks = _source_blocks(title, body)[0]
    for heading in refinement["heading_blocks"]:
        index = heading["block_index"] + 1
        node = parser.block_nodes[index]
        if node is None or node.tag != "h2" or sum(other is node for other in parser.block_nodes) != 1:
            raise ValueError("md2wechat did not render the anchored section as one H2 heading")
        heading_patch(node, blocks[index], heading["segments"], False)

    refined = rendered
    ordered = sorted(patches)
    if any(left[1] > right[0] for left, right in zip(ordered, ordered[1:])):
        raise ValueError("md2wechat heading edits overlap")
    for start, end, replacement in reversed(ordered):
        refined = refined[:start] + replacement + refined[end:]
    if re.findall(r"<p\b.*?</p>", refined, re.S | re.I) != re.findall(r"<p\b.*?</p>", rendered, re.S | re.I):
        raise ValueError("typography refinement changed paragraph HTML")
    if check_wechat_html(title, body, refined)["status"] != "pass":
        raise ValueError("typography refinement changed source text or references")
    return refined

#!/usr/bin/env python3
from pathlib import Path
import json
import re
import html
from datetime import datetime
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Preformatted,
    PageBreak, ListFlowable, ListItem, Table, TableStyle
)

FONT = '/Library/Fonts/Arial Unicode.ttf'
MONO = '/System/Library/Fonts/SFNSMono.ttf'

pdfmetrics.registerFont(TTFont('ArialUnicode', FONT))
pdfmetrics.registerFont(TTFont('ArialUnicode-Bold', FONT))
pdfmetrics.registerFont(TTFont('Mono', MONO))

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name='Chinese', fontName='ArialUnicode', fontSize=10,
    leading=16, spaceAfter=6
))
styles.add(ParagraphStyle(
    name='ChineseBold', fontName='ArialUnicode-Bold', fontSize=10,
    leading=16, spaceAfter=6
))
styles.add(ParagraphStyle(
    name='MyH1', fontName='ArialUnicode-Bold', fontSize=20,
    leading=26, spaceAfter=14, textColor=colors.HexColor('#1a1a1a')
))
styles.add(ParagraphStyle(
    name='MyH2', fontName='ArialUnicode-Bold', fontSize=16,
    leading=22, spaceAfter=10, textColor=colors.HexColor('#2a2a2a')
))
styles.add(ParagraphStyle(
    name='MyH3', fontName='ArialUnicode-Bold', fontSize=13,
    leading=18, spaceAfter=8, textColor=colors.HexColor('#3a3a3a')
))
styles.add(ParagraphStyle(
    name='MyCode', fontName='Mono', fontSize=8, leading=11,
    leftIndent=0.5*cm, textColor=colors.HexColor('#333333')
))
styles.add(ParagraphStyle(
    name='MyBullet', fontName='ArialUnicode', fontSize=10,
    leading=16, leftIndent=0.6*cm, bulletIndent=0.2*cm, spaceAfter=4
))
styles.add(ParagraphStyle(
    name='CoverTitle', fontName='ArialUnicode-Bold', fontSize=28,
    leading=36, alignment=1, textColor=colors.HexColor('#1a1a1a')
))
styles.add(ParagraphStyle(
    name='CoverSubtitle', fontName='ArialUnicode', fontSize=16,
    leading=24, alignment=1, textColor=colors.HexColor('#555555')
))
styles.add(ParagraphStyle(
    name='CoverMeta', fontName='ArialUnicode', fontSize=11,
    leading=16, alignment=1, textColor=colors.HexColor('#777777')
))


def toc_style(level: int):
    return ParagraphStyle(
        f'TOCLevel{level}', fontName='ArialUnicode', fontSize=11,
        leading=18, leftIndent=(level - 1) * 0.5 * cm, spaceAfter=2
    )


def escape_inline(text: str) -> str:
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<i>\1</i>', text)
    text = re.sub(r'`(.+?)`', r'<font name="Mono">\1</font>', text)
    return text


def parse(md: str):
    lines = md.replace('\r\n', '\n').splitlines()
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r'^(#{1,6})\s+(.*)$', line)
        if m:
            level = len(m.group(1))
            title = html.escape(m.group(2).strip())
            title = escape_inline(title)
            style = {1: 'MyH1', 2: 'MyH2', 3: 'MyH3'}.get(level, 'MyH3')
            p = Paragraph(title, styles[style])
            p._toc_level = level
            p._toc_text = title
            out.append(p)
            i += 1
            continue
        if line.startswith('```'):
            lang = line[3:].strip()
            i += 1
            code_lines = []
            while i < len(lines) and not lines[i].startswith('```'):
                code_lines.append(lines[i])
                i += 1
            i += 1
            code = html.escape('\n'.join(code_lines))
            if lang:
                out.append(Paragraph(f'<font name="ArialUnicode-Bold" size="8">{lang}</font>', styles['ChineseBold']))
            out.append(Preformatted(code, styles['MyCode'], maxLineLength=100))
            out.append(Spacer(1, 0.2*cm))
            continue
        if re.match(r'^[-*]\s+', line):
            items = []
            while i < len(lines) and re.match(r'^[-*]\s+', lines[i]):
                txt = re.sub(r'^[-*]\s+', '', lines[i])
                items.append(Paragraph(escape_inline(html.escape(txt)), styles['MyBullet']))
                i += 1
            out.append(ListFlowable([ListItem(item) for item in items], bulletType='bullet', bulletFontName='ArialUnicode'))
            out.append(Spacer(1, 0.2*cm))
            continue
        if re.match(r'^\d+\.\s+', line):
            items = []
            while i < len(lines) and re.match(r'^\d+\.\s+', lines[i]):
                txt = re.sub(r'^\d+\.\s+', '', lines[i])
                items.append(Paragraph(escape_inline(html.escape(txt)), styles['MyBullet']))
                i += 1
            out.append(ListFlowable([ListItem(item) for item in items], bulletType='1'))
            out.append(Spacer(1, 0.2*cm))
            continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                rows.append(lines[i])
                i += 1
            out.append(Preformatted(html.escape('\n'.join(rows)), styles['MyCode']))
            out.append(Spacer(1, 0.2*cm))
            continue
        if line.strip() == '':
            i += 1
            continue
        para_lines = []
        while i < len(lines) and lines[i].strip() != '' and not lines[i].startswith('#') and not lines[i].startswith('```') and not re.match(r'^[-*\d]', lines[i]) and not lines[i].startswith('|'):
            para_lines.append(lines[i])
            i += 1
        para = ' '.join(para_lines)
        para = html.escape(para)
        para = escape_inline(para)
        out.append(Paragraph(para, styles['Chinese']))
    return out


class Pass1Doc(SimpleDocTemplate):
    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self.entries = []

    def afterFlowable(self, flowable):
        level = getattr(flowable, '_toc_level', None)
        if level is not None:
            text = getattr(flowable, '_toc_text', flowable.getPlainText())
            self.entries.append((level, text, self.page))


def draw_header_footer(canvas, doc):
    if doc.page > 2:
        canvas.setFont('ArialUnicode', 9)
        canvas.setFillColor(colors.HexColor('#777777'))
        # header
        canvas.drawRightString(A4[0] - 2*cm, A4[1] - 1.3*cm, 'AI Founder Influence OS · 使用手册')
        # footer
        canvas.drawCentredString(A4[0] / 2, 1.2 * cm, str(doc.page - 2))


def main():
    here = Path(__file__).parent
    root = here.parent
    md = (here / 'manual.md').read_text(encoding='utf-8')

    plugin_json = root / '.codex-plugin' / 'plugin.json'
    version = '0.1.0'
    if plugin_json.exists():
        version = json.loads(plugin_json.read_text(encoding='utf-8')).get('version', version)

    body1 = parse(md)

    # first pass
    pass1 = Pass1Doc(
        BytesIO(), pagesize=A4,
        rightMargin=2*cm, leftMargin=2*cm,
        topMargin=2*cm, bottomMargin=2*cm,
    )
    pass1.build(body1)
    page_offset = 2

    body2 = parse(md)

    story = []
    # cover
    story.append(Spacer(1, 6*cm))
    story.append(Paragraph('AI Founder Influence OS', styles['CoverTitle']))
    story.append(Spacer(1, 0.8*cm))
    story.append(Paragraph('使用手册', styles['CoverSubtitle']))
    story.append(Spacer(1, 3*cm))
    story.append(Paragraph(f'Version {version}', styles['CoverMeta']))
    story.append(Paragraph(datetime.now().strftime('%Y-%m-%d'), styles['CoverMeta']))
    story.append(PageBreak())

    # toc
    story.append(Paragraph('目录', styles['CoverTitle']))
    story.append(Spacer(1, 0.6*cm))
    rows = []
    page_style = ParagraphStyle('TOCPage', fontName='ArialUnicode-Bold', fontSize=11, alignment=2, leading=18)
    for level, text, page in pass1.entries:
        display = re.sub(r'<[^>]+>', '', text)
        rows.append([
            Paragraph(display, toc_style(level)),
            Paragraph(str(page + page_offset), page_style)
        ])
    toc_table = Table(rows, colWidths=[14*cm, 1.5*cm], hAlign='LEFT')
    toc_table.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('TOPPADDING', (0,0), (-1,-1), 2),
        ('LINEBELOW', (0,0), (-1,-1), 0.5, colors.HexColor('#eeeeee')),
    ]))
    story.append(toc_table)
    story.append(PageBreak())

    # body
    story.extend(body2)

    doc = SimpleDocTemplate(
        str(here / 'manual.pdf'),
        pagesize=A4,
        rightMargin=2*cm, leftMargin=2*cm,
        topMargin=2.2*cm, bottomMargin=2*cm,
    )
    doc.build(story, onFirstPage=draw_header_footer, onLaterPages=draw_header_footer)
    print('generated', here / 'manual.pdf')


if __name__ == '__main__':
    main()

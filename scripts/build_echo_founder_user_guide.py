from __future__ import annotations

import re
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "echo-founder-user-guide.md"
OUTPUT = ROOT / "docs" / "Echo-Founder-User-Guide.docx"
FIGURE_DIR = Path("/private/tmp/echo-founder-user-guide-anonymized")

# Keep the Latin family explicit while leaving East Asian fallback to the
# reader's installed CJK font. This is more portable across Word and office
# renderers than hard-coding an OS-specific CJK family name.
FONT = "STSong"
INK = "102A43"
TEXT = "243B53"
MUTED = "627D98"
ACCENT = "0F766E"
ACCENT_LIGHT = "E6FFFB"
BLUE = "075985"
LINE = "B8D8D4"
SOFT = "F4F7F9"
CAUTION = "875A00"

FIGURES = {
    "### 1. 完成系统设置": (
        "图 1  系统设置：连接、环境诊断与品牌模板入口",
        "05-settings-annotated.png",
        "先完成连接测试与环境诊断，再启用常用的品牌排版模板。",
    ),
    "### 2. 建立个人知识库": (
        "图 2  个人知识库：创作定位、已发布脚本与原始素材",
        "02-materials-library-annotated.png",
        "先沉淀真实样本和表达边界，再让系统基于这些内容给出建议。",
    ),
    "## 三、一次内容生产如何完成": (
        "图 3  本期内容生产：阶段导航、素材输入与确认入口",
        "01-production-workflow-annotated.png",
        "按阶段推进；每个“确认”或“采用”节点都由人工判断后再继续。",
    ),
    "### 1. 内容对标研究": (
        "图 4  内容对标研究：账号、时间范围与结构拆解区域",
        "03-benchmark-research-annotated.png",
        "研究公开样本的结构和表达方法，不复制原文、视觉或品牌标识。",
    ),
    "### 2. 交付包与视觉工作台": (
        "图 5  交付包与视觉工作台：审查、生成与视觉采用入口",
        "06-delivery-center-annotated.png",
        "完成质量验收和交付审查后，再生成可交付的内容包。",
    ),
    "### 3. 平台草稿与发布结果": (
        "图 6  平台草稿队列：草稿准备与人工发布回填区域",
        "07-publication-desk-annotated.png",
        "系统准备草稿；实际发送和发布凭证的回填均由人工完成。",
    ),
    "### 4. 发布数据复盘": (
        "图 7  发布数据复盘：汇总入口与指标状态区域",
        "04-weekly-review-annotated.png",
        "优先使用已确认的真实数据复盘，再把有效经验写入长期学习。",
    ),
}


def set_run_font(run, name=FONT, size=None, color=None, bold=None, italic=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn("w:ascii"), name)
    run._element.rPr.rFonts.set(qn("w:hAnsi"), name)
    if size is not None:
        run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)
    shd.set(qn("w:val"), "clear")


def set_cell_margins(cell, top=100, start=140, bottom=100, end=140):
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for side, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_cell_border(cell, color=LINE, size="6"):
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right"):
        tag = qn(f"w:{edge}")
        border = borders.find(tag)
        if border is None:
            border = OxmlElement(f"w:{edge}")
            borders.append(border)
        border.set(qn("w:val"), "single")
        border.set(qn("w:sz"), size)
        border.set(qn("w:color"), color)
        border.set(qn("w:space"), "0")


def set_table_widths(table, widths):
    table.autofit = False
    table_pr = table._tbl.tblPr
    tbl_w = table_pr.first_child_found_in("w:tblW")
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        table_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(sum(widths)))
    tbl_w.set(qn("w:type"), "dxa")
    tbl_layout = table_pr.first_child_found_in("w:tblLayout")
    if tbl_layout is None:
        tbl_layout = OxmlElement("w:tblLayout")
        table_pr.append(tbl_layout)
    tbl_layout.set(qn("w:type"), "fixed")
    grid = table._tbl.tblGrid
    for grid_col, width in zip(grid.gridCol_lst, widths):
        grid_col.set(qn("w:w"), str(width))
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_w = tc_pr.find(qn("w:tcW"))
            if tc_w is None:
                tc_w = OxmlElement("w:tcW")
                tc_pr.append(tc_w)
            tc_w.set(qn("w:w"), str(width))
            tc_w.set(qn("w:type"), "dxa")


def add_bottom_rule(paragraph, color=ACCENT, size="14"):
    p_pr = paragraph._p.get_or_add_pPr()
    p_bdr = p_pr.find(qn("w:pBdr"))
    if p_bdr is None:
        p_bdr = OxmlElement("w:pBdr")
        p_pr.append(p_bdr)
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), size)
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), color)
    p_bdr.append(bottom)


def add_page_field(paragraph):
    run = paragraph.add_run()
    fld_char = OxmlElement("w:fldChar")
    fld_char.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend([fld_char, instr, separate, text, end])


def add_inline_markup(paragraph, text, *, size=10.5, color=TEXT):
    parts = re.split(r"(\*\*.*?\*\*)", text)
    for part in parts:
        if not part:
            continue
        is_bold = part.startswith("**") and part.endswith("**")
        run = paragraph.add_run(part[2:-2] if is_bold else part)
        set_run_font(run, size=size, color=color, bold=is_bold)


def configure_styles(doc):
    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(TEXT)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25

    for name, size, color, before, after in (
        ("Heading 1", 16, INK, 18, 10),
        ("Heading 2", 13, BLUE, 14, 7),
        ("Heading 3", 11.5, INK, 10, 5),
    ):
        style = styles[name]
        style.font.name = FONT
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(color)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    for name in ("List Bullet", "List Number"):
        style = styles[name]
        style.font.name = FONT
        style.font.size = Pt(10.5)
        style.font.color.rgb = RGBColor.from_string(TEXT)
        style.paragraph_format.left_indent = Inches(0.375)
        style.paragraph_format.first_line_indent = Inches(-0.188)
        style.paragraph_format.space_after = Pt(4)
        style.paragraph_format.line_spacing = 1.25


def add_header_footer(doc):
    section = doc.sections[0]
    header = section.header
    header.is_linked_to_previous = False
    p = header.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_after = Pt(0)
    run = p.add_run("ECHO FOUNDER  |  用户使用说明书")
    set_run_font(run, size=8.5, color=MUTED, bold=True)
    add_bottom_rule(p, color=LINE, size="4")

    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    p.paragraph_format.space_before = Pt(0)
    run = p.add_run("Echo Founder · 用户使用说明书 · 第 ")
    set_run_font(run, size=8.5, color=MUTED)
    add_page_field(p)
    run = p.add_run(" 页")
    set_run_font(run, size=8.5, color=MUTED)


def add_cover(doc):
    doc.add_paragraph().paragraph_format.space_after = Pt(80)
    kicker = doc.add_paragraph()
    kicker.alignment = WD_ALIGN_PARAGRAPH.CENTER
    kicker.paragraph_format.space_after = Pt(16)
    run = kicker.add_run("ECHO FOUNDER")
    set_run_font(run, size=12, color=ACCENT, bold=True)

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_after = Pt(8)
    run = title.add_run("用户使用说明书")
    set_run_font(run, size=30, color=INK, bold=True)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle.paragraph_format.space_after = Pt(36)
    run = subtitle.add_run("从素材沉淀到内容复盘的一体化创作工作台")
    set_run_font(run, size=13, color=MUTED)

    rule = doc.add_paragraph()
    rule.alignment = WD_ALIGN_PARAGRAPH.CENTER
    rule.paragraph_format.space_after = Pt(26)
    add_bottom_rule(rule, color=ACCENT, size="18")

    table = doc.add_table(rows=3, cols=2)
    set_table_widths(table, [2200, 7160])
    metadata = [
        ("适用对象", "普通内容创作者"),
        ("覆盖范围", "知识库、内容生产、研究、交付、草稿、发布回填与数据复盘"),
        ("版本", "1.0 · 2026 年 8 月"),
    ]
    for row, (label, value) in zip(table.rows, metadata):
        row.cells[0].vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        row.cells[1].vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        for cell in row.cells:
            set_cell_margins(cell)
            set_cell_border(cell, color=LINE, size="4")
        set_cell_shading(row.cells[0], ACCENT_LIGHT)
        p = row.cells[0].paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        run = p.add_run(label)
        set_run_font(run, size=10, color=ACCENT, bold=True)
        p = row.cells[1].paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        run = p.add_run(value)
        set_run_font(run, size=10, color=TEXT)

    doc.add_paragraph().paragraph_format.space_after = Pt(38)
    note = doc.add_paragraph()
    note.alignment = WD_ALIGN_PARAGRAPH.CENTER
    note.paragraph_format.space_after = Pt(0)
    run = note.add_run("本手册采用通用内容渠道称呼，不包含第三方平台专有名称。")
    set_run_font(run, size=9.5, color=MUTED)
    doc.add_page_break()


def add_navigation(doc):
    heading = doc.add_paragraph(style="Heading 1")
    heading.add_run("阅读导航")
    intro = doc.add_paragraph()
    intro.paragraph_format.space_after = Pt(10)
    add_inline_markup(intro, "建议先完成“开始前的准备”，再按“本期内容生产”推进。每个需要确认的节点都保留人工判断。")

    table = doc.add_table(rows=1, cols=3)
    set_table_widths(table, [900, 3200, 5260])
    table.rows[0].cells[0].text = "章节"
    table.rows[0].cells[1].text = "你会完成的事"
    table.rows[0].cells[2].text = "首次使用建议"
    for cell in table.rows[0].cells:
        set_cell_shading(cell, SOFT)
        set_cell_margins(cell)
        set_cell_border(cell, color=LINE, size="4")
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(0)
        for run in p.runs:
            set_run_font(run, size=9.5, color=INK, bold=True)

    rows = [
        ("一", "了解工作台与使用边界", "先理解系统不会代替事实判断或实际发布。"),
        ("二", "连接工具并建立个人知识库", "完成连接测试、环境诊断、创作定位和素材沉淀。"),
        ("三", "完成一轮内容生产", "从本期素材出发，依次审阅研究、内容、视觉与草稿。"),
        ("四", "管理研究、交付、草稿与复盘", "把公开研究、交付审查、人工发布和数据回填串起来。"),
        ("五至七", "形成日常节奏并查看图示", "发布前检查，遇到问题回看相应操作区。"),
    ]
    for index, use, tip in rows:
        cells = table.add_row().cells
        for cell in cells:
            set_cell_margins(cell)
            set_cell_border(cell, color=LINE, size="4")
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        values = [index, use, tip]
        for cell, value in zip(cells, values):
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            run = p.add_run(value)
            set_run_font(run, size=9.5, color=TEXT, bold=(cell is cells[0]))

    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    callout = doc.add_table(rows=1, cols=1)
    set_table_widths(callout, [9360])
    cell = callout.cell(0, 0)
    set_cell_shading(cell, ACCENT_LIGHT)
    set_cell_margins(cell, top=150, start=180, bottom=150, end=180)
    set_cell_border(cell, color=LINE, size="4")
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(0)
    label = p.add_run("使用边界  ")
    set_run_font(label, size=10, color=ACCENT, bold=True)
    body = p.add_run("系统整理、生成、校验和归档内容；对事实、引用、视觉使用条件、真实发布结果和长期经验的确认仍由你负责。")
    set_run_font(body, size=10, color=TEXT)
    doc.add_page_break()


def add_figure_page(doc, title, filename, note):
    heading = doc.add_paragraph(style="Heading 2")
    heading.add_run(title)
    heading.paragraph_format.space_after = Pt(8)
    img = FIGURE_DIR / filename
    image_paragraph = doc.add_paragraph()
    image_paragraph.paragraph_format.keep_with_next = True
    run = image_paragraph.add_run()
    inline = run.add_picture(str(img), width=Inches(6.15))
    inline._inline.docPr.set("descr", title)
    caption = doc.add_paragraph()
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption.paragraph_format.keep_with_next = True
    caption.paragraph_format.space_before = Pt(4)
    caption.paragraph_format.space_after = Pt(8)
    run = caption.add_run(title)
    set_run_font(run, size=9.5, color=MUTED, italic=True)
    note_p = doc.add_paragraph()
    note_p.paragraph_format.space_after = Pt(0)
    label = note_p.add_run("操作提示  ")
    set_run_font(label, size=10, color=ACCENT, bold=True)
    note_run = note_p.add_run(note)
    set_run_font(note_run, size=10, color=TEXT)


def add_checkbox(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Inches(0.1)
    p.paragraph_format.first_line_indent = Inches(0)
    p.paragraph_format.space_after = Pt(4)
    box = p.add_run("☐  ")
    set_run_font(box, size=10.5, color=ACCENT)
    add_inline_markup(p, text, size=10.5)


def add_md_content(doc):
    lines = SOURCE.read_text(encoding="utf-8").splitlines()
    figure_used = set()
    skip_title = True
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if skip_title and line.startswith("# "):
            skip_title = False
            continue

        if line.startswith("## "):
            heading = doc.add_paragraph(style="Heading 1")
            run = heading.add_run(line[3:])
            set_run_font(run, size=16, color=INK, bold=True)
            if line in FIGURES and line not in figure_used:
                title, filename, note = FIGURES[line]
                add_figure_page(doc, title, filename, note)
                figure_used.add(line)
            continue

        if line.startswith("### "):
            heading = doc.add_paragraph(style="Heading 2")
            run = heading.add_run(line[4:])
            set_run_font(run, size=13, color=BLUE, bold=True)
            if line in FIGURES and line not in figure_used:
                add_figure_page(doc, *FIGURES[line])
                figure_used.add(line)
            continue

        if re.match(r"^- \[ \] ", line):
            add_checkbox(doc, line[6:])
            continue

        if line.startswith("- "):
            p = doc.add_paragraph(style="List Bullet")
            p.paragraph_format.space_after = Pt(4)
            add_inline_markup(p, line[2:])
            continue

        if re.match(r"^\d+\. ", line):
            # Markdown lists restart at 1 for each local procedure.  Word's
            # built-in List Number style keeps one global counter, which
            # makes later procedures look like they continue from an earlier
            # section.  Render the source number explicitly so each group
            # stays faithful to the guide and remains stable in LibreOffice.
            match = re.match(r"^(\d+)\. (.*)$", line)
            number, text = match.groups()
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(0.375)
            p.paragraph_format.first_line_indent = Inches(-0.188)
            p.paragraph_format.space_after = Pt(4)
            # A non-breaking space prevents Word/LibreOffice from treating
            # the literal marker as a new auto-numbered list when the file is
            # opened or edited, while retaining the same visible spacing.
            marker = p.add_run(f"{number}.\u00a0")
            set_run_font(marker, size=10.5, color=TEXT)
            add_inline_markup(p, text)
            continue

        if line.startswith("**") and line.endswith("**"):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(5)
            p.paragraph_format.space_after = Pt(2)
            run = p.add_run(line[2:-2])
            set_run_font(run, size=10.5, color=INK, bold=True)
            continue

        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(6)
        add_inline_markup(p, line)


def setup_document(doc):
    section = doc.sections[0]
    section.top_margin = Inches(1)
    section.bottom_margin = Inches(1)
    section.left_margin = Inches(1)
    section.right_margin = Inches(1)
    section.header_distance = Inches(0.492)
    section.footer_distance = Inches(0.492)
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    configure_styles(doc)
    add_header_footer(doc)
    doc.core_properties.title = "Echo Founder 用户使用说明书"
    doc.core_properties.subject = "面向普通内容创作者的产品使用说明书"
    doc.core_properties.author = "Echo Founder"
    doc.core_properties.keywords = "Echo Founder, 用户使用说明书, 内容创作"


def main():
    if not SOURCE.exists():
        raise FileNotFoundError(SOURCE)
    missing = [filename for _, filename, _ in FIGURES.values() if not (FIGURE_DIR / filename).exists()]
    if missing:
        raise FileNotFoundError(f"Missing annotated figures: {missing}")
    doc = Document()
    setup_document(doc)
    add_cover(doc)
    add_navigation(doc)
    add_md_content(doc)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    main()

from pathlib import Path
from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt

OUT = Path('/private/tmp/font-probe.docx')
fonts = [None, 'Arial Unicode MS', 'Heiti SC', 'PingFang SC', 'STSong', 'Songti SC', 'Hiragino Sans GB', 'Arial']
doc = Document()
for name in fonts:
    p = doc.add_paragraph()
    r = p.add_run(f'{name or "(default)"}：中文测试，Echo Founder 用户使用说明书')
    r.font.size = Pt(18)
    if name:
        r.font.name = name
        r._element.rPr.rFonts.set(qn('w:ascii'), name)
        r._element.rPr.rFonts.set(qn('w:hAnsi'), name)
        r._element.rPr.rFonts.set(qn('w:eastAsia'), name)
        r._element.rPr.rFonts.set(qn('w:hint'), 'eastAsia')
doc.save(OUT)
print(OUT)

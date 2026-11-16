"""Check native blueprint platform coverage; callers supply verified run evidence.

This is a structural check, never factual or editorial quality approval.
"""
from collections import Counter
import re

LABELS = {'wechat': '公众号', 'xhs': '小红书', 'shipinhao': '视频号'}
TITLES = {label + '独立蓝图': platform for platform, label in LABELS.items()}


def visible_lines(markdown):
    text = markdown.replace('\r\n', '\n').replace('\r', '\n').lstrip('\ufeff')
    text = re.sub(r'\A---\n[\s\S]*?\n---(?:\n|$)', '', text)
    text = re.sub(r'<!--[\s\S]*?(?:-->|$)', '', text)
    fence = None
    for line in text.splitlines():
        if fence:
            if re.fullmatch(r' {0,3}' + re.escape(fence[0]) + '{' + str(fence[1]) + r',}[ \t]*', line):
                fence = None
            continue
        opening = re.match(r' {0,3}(`{3,}|~{3,})', line)
        if opening:
            marks = opening[1]
            fence = (marks[0], len(marks))
            continue
        yield line


def check_platform_scope(markdown, verified_platforms):
    if (not isinstance(verified_platforms, (list, tuple)) or not verified_platforms
            or any(not isinstance(p, str) or p not in LABELS for p in verified_platforms)
            or len(set(verified_platforms)) != len(verified_platforms)):
        return {'scope_status': 'unverified', 'scope_matches': False,
                'issues': ['无法核对本期已确认的平台，请重新读取本期记录。'],
                'quality_verified': False}
    found = []
    unknown = []
    for line in visible_lines(markdown):
        match = re.match(r'^ {0,3}##[ \t]+(.+?)[ \t]*$', line)
        if not match:
            continue
        title = re.sub(r'[ \t]+#+$', '', match[1]).strip()
        title = re.sub(r'^\d+[.．、][ \t]*', '', title)
        if title in TITLES:
            found.append(TITLES[title])
        elif title.endswith('独立蓝图'):
            unknown.append(title)
    counts = Counter(found)
    extra = [p for p in LABELS if p in counts and p not in verified_platforms]
    missing = [p for p in verified_platforms if p not in counts]
    duplicates = [p for p in LABELS if counts[p] > 1]
    issues = []
    if extra:
        issues.append('方案包含本期未选平台：' + '、'.join(LABELS[p] for p in extra) + '。')
    if missing:
        issues.append('方案缺少本期已选平台：' + '、'.join(LABELS[p] for p in missing) + '。')
    if duplicates:
        issues.append('同一平台出现重复方案：' + '、'.join(LABELS[p] for p in duplicates) + '。')
    if unknown:
        issues.append('存在无法识别的平台方案：' + '、'.join(unknown) + '。')
    return {'scope_status': 'mismatch' if issues else 'matched', 'scope_matches': not issues,
            'expected': list(verified_platforms), 'found': found,
            'extra': extra, 'missing': missing, 'duplicates': duplicates,
            'unknown': unknown, 'issues': issues, 'quality_verified': False}

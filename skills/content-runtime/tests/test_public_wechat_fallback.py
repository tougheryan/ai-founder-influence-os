"""Regression checks for the independently implemented public HTML fallback."""
from pathlib import Path
import importlib.util
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'skills/content-runtime/scripts'))
from wechat_fidelity import check_wechat_html

spec = importlib.util.spec_from_file_location('echo_public_html', ROOT / 'skills/dbs-wechat-html/generate_preview.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def test_offline_fallback_preserves_quotes_lists_code_and_nested_url_punctuation():
    title = '排版保真'
    body = '''第一段保留标点。**加粗**和`代码`不能丢失。

## 参考来源

- 看[原文](https://example.test/reference(item))，再判断。
- 第二条。

> 同一条引用的第一行
> 和第二行。

```text
**这里保留原样**
print("hello")
```
'''
    rendered = renderer.build_html(title, renderer.md_to_html('# ' + title + '\n\n' + body), renderer.STYLES['minimal'][2])
    proof = check_wechat_html(title, body, rendered)
    assert proof['status'] == 'pass', proof
    assert '<a href="https://example.test/reference(item)">' in rendered


def test_untrusted_html_and_executable_links_stay_literal_text():
    body = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[链接](javascript:alert)'
    rendered = renderer.build_html('安全预览', renderer.md_to_html('# 安全预览\n\n' + body), renderer.STYLES['minimal'][2])
    assert '<script>' not in rendered
    assert '<img ' not in rendered
    assert '<a href="javascript:' not in rendered
    assert '&lt;script&gt;' in rendered
    assert check_wechat_html('安全预览', body, rendered)['status'] == 'pass'

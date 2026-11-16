from __future__ import annotations

import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(RUNTIME_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(RUNTIME_SCRIPTS))

from demo_data import DEMO_SAMPLES, platform_demo_samples  # noqa: E402


WRITER_ROOT = REPO_ROOT / "skills" / "wechat-writer"
HISTORICAL_OPTIONAL_FILES = {
    WRITER_ROOT / "style-changhuan.md",
    WRITER_ROOT / "references" / "style_examples.md",
}


def _text_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file() and path.suffix in {".md", ".py"})


def test_default_writer_runtime_has_no_preloaded_personal_identity() -> None:
    checked = [path for path in _text_files(WRITER_ROOT) if path not in HISTORICAL_OPTIONAL_FILES]
    assert checked
    for path in checked:
        text = path.read_text(encoding="utf-8")
        assert "常欢" not in text, path
        assert "changhuan" not in text.lower(), path

    skill = (WRITER_ROOT / "SKILL.md").read_text(encoding="utf-8")
    adaptive = (WRITER_ROOT / "style-adaptive.md").read_text(encoding="utf-8")
    for contract in (
        "brain/creative-library/profile.json",
        "brain/creative-library/rules.json",
        "不得回退到任何预置人物",
    ):
        assert contract in skill
    assert "创作名片未初始化" in adaptive
    assert "正文不输出作者行、账号名或固定尾注" in adaptive


def test_personal_style_sources_are_not_redistributed_in_public_source() -> None:
    writer = REPO_ROOT / "skills" / "wechat-writer"
    assert not (writer / "style-changhuan.md").exists()
    assert not (writer / "references" / "style_examples.md").exists()
    skill = (writer / "SKILL.md").read_text(encoding="utf-8")
    assert "创作名片" in skill
    assert "用户" in skill
    assert "未随公开源代码分发" in skill


def test_all_bundled_demo_text_is_identity_neutral() -> None:
    bodies = list(DEMO_SAMPLES.values())
    for platform in ("wechat", "xhs"):
        bodies.extend(platform_demo_samples(platform).values())
    combined = "\n".join(bodies)

    assert "常欢" not in combined
    assert "changhuan" not in combined.lower()
    assert not re.search(r"(?m)^\s*/?\s*作者\s*[：:]\s*\S+", combined)
    assert "demo 未配置创作名片；不署名" in combined


def test_customer_visible_runtime_copy_uses_echo_founder_brand() -> None:
    paths = [
        RUNTIME_SCRIPTS / "demo_data.py",
        RUNTIME_SCRIPTS / "visual_publish.py",
        RUNTIME_SCRIPTS / "delivery_pack.py",
        RUNTIME_SCRIPTS / "quality_check.py",
        RUNTIME_SCRIPTS / "delivery_audit.py",
    ]
    forbidden = (
        "AIFIOS 商业交付包",
        "AIFIOS 内部复核整理包",
        "AIFIOS 内容质量验收报告",
        "AIFIOS 交付前对抗审查报告",
        "请重新安装 AIFIOS",
        "Generate and review AIFIOS",
        "AIFIOS 示例判断",
        "展示 AIFIOS 如何",
    )
    combined = "\n".join(path.read_text(encoding="utf-8") for path in paths)
    for phrase in forbidden:
        assert phrase not in combined
    # Internal compatibility contracts deliberately retain their historic
    # names. This guards only customer-facing report/help/error copy.
    assert "AIFIOS-WRITE-CHECK" in combined
    assert "AIFIOS_NODE_BINARY" in combined


def test_packaged_manuals_describe_only_existing_publication_controls() -> None:
    setup = (REPO_ROOT / "docs" / "echo-founder-api-platform-setup.md").read_text(encoding="utf-8")
    installation = (REPO_ROOT / "docs" / "echo-founder-installation.md").read_text(encoding="utf-8")

    assert "本版设置页不提供独立的公众号连接测试或草稿测试按钮" in setup
    assert "点击「保存接口」" in setup
    assert "执行「填入草稿」" in setup
    assert "../quality/commercial-readiness-matrix.md" not in installation
    assert "随安装包单独提供的 `commercial-readiness-matrix.md`" in installation

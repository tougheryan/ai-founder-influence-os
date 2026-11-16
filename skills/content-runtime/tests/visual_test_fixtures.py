from __future__ import annotations

import hashlib
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
from content_runtime import ContentRuntime  # noqa: E402
from demo_data import DEMO_SAMPLES  # noqa: E402
import market_signal as market_signal_module  # noqa: E402
from visual_release import build_visual_selection_manifest  # noqa: E402


def _share_post(index: int) -> str:
    titles = ["别先写履历", "客户问题三步自检", "客户原话变开头"]
    title = titles[index - 1]
    rows = "\n".join(
        f"| P{page} | {title} {page} | 第 {page} 页用具体客户场景承接判断。 | 概念图解（非事实证据）：客户卡点与判断路径 | 标题加证据卡和关键词高亮 | 保持层级清楚并突出第 {page} 步 |"
        for page in range(1, 6)
    )
    return f"""### 图文 {index}：{title}
- 核心观点：客户先看见自己的问题，才会判断创始人是否值得继续了解。
- 适用平台：公众号、朋友圈、小红书
- 发布标题：{title}，让客户先看见自己的问题
- 封面字：{title}
- 分享文案：先写具体客户和真实卡点，再给一个低压力下一步，避免把内容写成空泛简历。
- 正文文案：先写具体客户和真实卡点，再给一个低压力下一步，避免把内容写成空泛简历。

#### 页卡脚本
| 页码 | 页面标题 | 页面正文 | 画面/配图建议 | 视觉层级 | 排版重点 |
|---|---|---|---|---|---|
{rows}

#### 平台适配
- 公众号：作为文章第二节后的判断卡，配文强调客户先判断问题而不是履历。
- 朋友圈：按 P1、P3、P5 发三张图，短文案只保留一个客户问题。
- 小红书：P1 做首图，正文保留具体场景和三步自检，评论区继续追问业务类型。

#### 平台发布稿
- 公众号文内标题：客户不是先看你是谁
- 公众号配文：放在文章第二节后，用一句问题承接读者的实际客户卡点。
- 朋友圈图序：P1、P3、P5，三张图按判断、方法、互动顺序发布。
- 朋友圈短文案：别急着介绍自己，先写客户正在卡住的问题。你现在最难说清的是客户、场景还是下一步？
- 小红书标题：{title}，让客户先看见自己的问题
- 小红书正文：很多创始人把第一篇写成履历，客户却还没看到自己的问题。先把客户是谁、卡在哪里、下一步怎么走写出来，再介绍你能做什么。
- 小红书标签：#内容表达 #客户问题 #创始人

#### 评论维护话术
- 置顶：留下业务类型和目标客户，我帮你判断第一句话。
- 首评：补充产品形态和当前开头。
- 追评：我会整理高频业务的改写示例。
- 高意向回复：先确认真实业务场景，不承诺结果。

- 平台风险边界：不诱导私信，不公开客户隐私，不承诺成交结果。
"""


def _short_video(index: int) -> str:
    title = "第一条内容别先写履历" if index == 1 else "客户为什么会划走你的第一篇内容"
    duration = "45-60 秒" if index == 1 else "90-120 秒"
    line_rows = (
        "| 0-3 秒 | 你第一条内容一上来就在介绍自己，客户通常已经划走了。 | 第一条别先写履历 | 正面近景，直视镜头 |\n"
        "| 4-15 秒 | 客户先判断的不是你有多厉害，而是你有没有说中他的处境。 | 先说中客户的问题 | 白板写出客户、场景、卡点 |\n"
        "| 16-35 秒 | 所以先写客户是谁、卡在哪里、下一步怎么走，再介绍你能提供什么。 | 客户、卡点、下一步 | 三张步骤卡依次出现 |\n"
        "| 36-60 秒 | 你现在最难写的是客户、场景还是下一步？把答案留在评论里。 | 先把问题写出来 | 回到正面，停顿收口 |"
        if index == 1
        else
        "| 0-3 秒 | 客户划走你的第一篇内容，往往不是因为你不专业。 | 划走不等于不专业 | 正面近景，直接开场 |\n"
        "| 4-25 秒 | 很多人把第一篇写成一份履历，但客户还没看见自己的问题。 | 客户先找自己 | 履历页和客户问题卡对照 |\n"
        "| 26-55 秒 | 他先判断你有没有理解自己的场景、卡点和代价，才会判断你是否专业。 | 场景、卡点、代价 | 白板逐项写出三个词 |\n"
        "| 56-90 秒 | 先把客户是谁、卡在哪里、下一步怎么走说清楚，能力介绍才有落点。 | 先问题，后履历 | 步骤卡与真实工作台 B-roll |\n"
        "| 91-120 秒 | 留下你的业务类型和目标客户，我用这个顺序帮你检查第一句话。 | 留下业务类型 | 正面收口，评论框出现 |"
    )
    return f"""### 短视频 {index}：{title}
- 适用平台：视频号、抖音、小红书
- 发布标题：{title}
- 封面字：别先写履历
- 3 秒钩子：客户划走你的第一篇内容，往往不是因为你不专业。
- 时长：{duration}

#### 分段口播稿
- 开场：客户划走你的第一篇内容，往往不是因为你不专业。
- 展开：很多人把第一篇写成履历，但客户还没看见自己的问题。
- 转折：客户先判断你是否理解他的场景、卡点和代价，才会判断你是否专业。
- 收口：留下你的业务类型和目标客户，用这个顺序检查第一句话。

#### 逐句口播稿
| 时间段 | 口播文案 | 屏幕字幕 | 对应画面 |
|---|---|---|---|
{line_rows}

#### 镜头清单
| 时间段 | 镜头/画面 | 口播/字幕 | 景别/动作 |
|---|---|---|---|
| 0-3 秒 | 正面口播 | 客户为什么会划走 | 近景，快速进入 |
| 4-25 秒 | 履历与客户问题对照卡 | 客户先找自己的问题 | 中景，手写关键词 |
| 26-45 秒 | 白板三步法 | 客户、卡点、下一步 | 插入 B-roll 和重点字幕 |
| 46-60 秒 | 正面收口 | 留下业务类型 | 近景，留出停顿 |

#### 字幕重点
- 客户先判断你有没有说中他的处境。
- 先写客户、卡点和下一步，再介绍自己。
- 留下业务类型和目标客户，检查第一句话。

#### B-roll 素材建议
- 白板上写出客户、场景、卡点三个词的过程。
- 已授权的工作笔记或匿名问题清单特写。
- 履历页与客户问题卡的左右对照动画。

#### 发布备注
- 视频号：标题和简介保留完整判断，封面使用正面近景加“别先写履历”。
- 抖音：前三秒先抛出“划走不是因为不专业”，再快速进入三步法。
- 小红书：封面保留主句，正文补上三步法和评论区问题。

#### 平台发布表单
- 视频号标题：{title}
- 视频号发布文案：第一条内容别急着介绍自己，先把客户是谁、卡在哪里、下一步怎么走说清楚。你最难写的是哪一步？
- 视频号话题：#内容表达 #客户问题
- 抖音标题：{title}
- 抖音发布文案：客户划走你的第一篇内容，可能不是因为你不专业，而是他还没看见自己的问题。
- 抖音话题：#内容创作 #客户洞察 #创始人表达
- 小红书视频标题：{title}
- 小红书视频正文：很多创始人第一条都在写履历，客户却只想先确认你是否理解他的处境。先写客户、卡点和下一步，再介绍自己。
- 小红书标签：#内容表达 #客户问题 #创始人
- 默认封面画面：正面近景，左侧留出“别先写履历”四个字，背景放白板关键词。

#### 评论维护话术
- 置顶：留下业务类型和目标客户，我帮你判断第一句话从哪里开始。
- 首评：补充产品形态和当前开头，方便按场景继续追问。
- 追评：我会整理高频业务的第一句话改写示例。
- 高意向回复：先确认真实业务场景和客户边界，不承诺结果。

#### 平台风险边界
- 隐私：不公开客户姓名、公司、聊天记录或未授权截图。
- 引流：不诱导私信领取资料，不要求读者留下联系方式。
- 承诺：不承诺成交、流量或固定内容效果。
"""


VALID_PACKAGE_BODY = """# 最终内容 · 视觉测试

## 1. 公众号母稿
- 发布标题：第一篇别急着介绍自己
- 标题备选：第一篇内容不是简历；客户先看你懂不懂问题；别把第一篇写成温柔版履历
- 封面字：别先写履历
- 封面/摘要建议：封面字用“别先写履历”；摘要强调客户先判断你是否理解他的处境，再判断你是否专业。
- 摘要：第一篇内容不是自我介绍，而是客户问题翻译器。客户先判断你是否理解他的处境，再判断你是否专业。写内容之前，先把客户是谁、卡在哪里、下一步怎么走说清楚。
- 公众号排版提示：开头短句留白，引用块使用重点卡片，评论区引导单独成段。
- 配图位建议：正文第一节后放履历与客户问题的对照图，第二节后放客户卡点证据图。

### 正文
#### 先别急着证明你是谁
很多创始人第一次写内容，会本能地把第一篇写成一份温柔版简历。但客户真正停下来的原因，不是履历多完整，而是他发现你说中了自己的处境。客户如果看不到真实问题，就会划走，你也失去一次建立信任的机会。

> 第一篇内容不是简历，客户先看你是否懂他的处境。

#### 把客户问题翻译成能点头的话
第一篇内容更像一个翻译器，把客户说不清的问题翻译成他能点头的句子。先写客户是谁，再写他卡在哪里，最后给一个低压力下一步。这样读者才会判断：这个人不是来推销自己，而是真的理解我的问题。

> 信任来自客户问题被说中，而不是创始人的能力被堆满。

### 评论区引导
- 置顶评论：留下业务类型和目标客户，我帮你判断第一句话应该从哪个问题开始。
- 首评方向：追问产品形态、目标客户和成交动作。
- 追评方向：整理高频业务类型，补充第一句话改写示例。

## 2. 短视频内容
""" + "\n".join(_short_video(index) for index in range(1, 3)) + """

## 3. 图文内容
""" + "\n".join(_share_post(index) for index in range(1, 4))


def write_acceptance_visual_publish(
    project: Path,
    runtime: ContentRuntime,
    slug: str,
    aesthetic_status: str = "pass",
    recipe_release: bool = True,
) -> dict:
    from visual_publish import _check_wechat_output, _render_html, parse_package_body

    package_path = project / "pipeline" / "package" / f"{slug}.md"
    package_path.parent.mkdir(parents=True, exist_ok=True)
    if not package_path.exists():
        package_path.write_text(VALID_PACKAGE_BODY, encoding="utf-8")
    article = parse_package_body(package_path.read_text(encoding="utf-8"))["wechat"]
    visual_root = project / "pipeline" / "visual" / slug
    publish_dir = visual_root / "publish" / "r001" if recipe_release else visual_root / "publish"
    outputs = [
        ("wechat-html", "wechat_html", "HTML", "wechat/wechat-article.html"),
        ("wechat-cover", "wechat_cover", "PNG", "wechat/wechat-cover-21x9.png"),
        ("wechat-share", "wechat_cover", "PNG", "wechat/wechat-share-1x1.png"),
        ("xhs-01-p1", "xhs_card", "PNG", "xhs/post-01/01-cover.png"),
        ("xhs-01-p2", "xhs_card", "PNG", "xhs/post-01/02-page.png"),
        ("xhs-01-p5", "xhs_card", "PNG", "xhs/post-01/05-cta.png"),
    ]
    index_outputs = []
    layouts = {"xhs-01-p1": "S01", "xhs-01-p2": "S08", "xhs-01-p5": "S12"}
    for output_id, kind, file_format, relative in outputs:
        target = publish_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if file_format == "HTML":
            _render_html(target, article["title"], article["body"])
        else:
            # Each synthetic visual stands in for a separately rendered asset.
            # Distinct bytes keep the fixture honest now that release quality
            # rejects duplicated cards and cover directions by content hash.
            target.write_bytes(f"acceptance-png:{output_id}".encode("utf-8"))
        payload = target.read_bytes()
        index_outputs.append({
            "id": output_id,
            "kind": kind,
            "provider": "test-provider",
            "renderer": "local",
            "source": f"pipeline/package/{slug}.md",
            "output": str(target.relative_to(project)),
            "format": file_format,
            "status": "generated",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "layout_recipe": layouts.get(output_id, "html"),
            "evidence_sources": [],
        })
        if kind == "wechat_html":
            index_outputs[-1]["wechat_fidelity"] = _check_wechat_output(
                project, {"source_package": f"pipeline/package/{slug}.md"}, index_outputs[-1],
            )
        if output_id == "xhs-01-p2":
            index_outputs[-1].update({
                "role": "evidence",
                "evidence_sources": ["materials/evidence.png"],
                "evidence_ratio": 0.5,
                "evidence_kind": "image",
                "evidence_detail_score": 0.35,
            })

    index = {
        "schema": "aifios.visual-publish.v1",
        "slug": slug,
        "source_package": f"pipeline/package/{slug}.md",
        "status": "generated",
        "aesthetic_status": aesthetic_status,
        "quality_tools": ["skills/xhs-card/validate-social-deck.mjs"],
        "platform_gap_checks": ["小红书 1080x1440", "公众号 2100x900 + 1080x1080"],
        "outputs": index_outputs,
        "errors": [],
    }
    index_path = publish_dir / "index.json"

    if recipe_release:
        recipe_dir = visual_root / "recipes"
        revisions_dir = visual_root / "revisions"
        recipe_dir.mkdir(parents=True, exist_ok=True)
        revisions_dir.mkdir(parents=True, exist_ok=True)
        recipe_rel = f"pipeline/visual/{slug}/recipes/r001.visual-recipe.json"
        recipe = {
            "schema": "aifios.visual-recipe.v1",
            "revision_id": "r001",
            "slug": slug,
            "source_package": f"pipeline/package/{slug}.md",
            "content_archetype": "concept",
            "evidence_mode": "data_first",
            "platforms": {
                "wechat": {"system": "swiss"},
                "xhs": {"system": "swiss", "page_recipes": ["S01", "S08", "S06", "S10", "S12"]},
            },
            "assets": [
                {
                    "id": item["id"],
                    "platform": "xhs" if item["kind"] == "xhs_card" else "wechat",
                    "role": "evidence" if item["id"] == "xhs-01-p2" else "supporting",
                    "layout_recipe": item["layout_recipe"],
                    "renderer": "xhs-card" if item["kind"] == "xhs_card" else "dbs-wechat-html",
                    "status": "planned",
                    **({"source": "materials/evidence.png"} if item["id"] == "xhs-01-p2" else {}),
                }
                for item in index_outputs
            ],
            "quality_policy": {"min_density": 0.62, "require_evidence_ratio": 0.4},
        }
        (project / recipe_rel).write_text(json.dumps(recipe, ensure_ascii=False), encoding="utf-8")
        index.update({
            "legacy": False,
            "recipe_path": recipe_rel,
            "revision_id": "r001",
            "quality_summary": {"status": "pass", "checks": {}, "errors": []},
            "revision_index_path": f"pipeline/visual/{slug}/revisions/r001.index.json",
            "render_quality_report": "\n".join(
                f"[PASS] {item['id']} · xhs"
                for item in index_outputs
                if item["kind"] == "xhs_card"
            ),
        })
        for output in index_outputs:
            output["recipe_path"] = recipe_rel
            output["revision_id"] = "r001"
        (revisions_dir / "r001.index.json").write_text(
            json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (visual_root / "selected-revision.json").write_text(
            json.dumps(build_visual_selection_manifest(project, slug, "r001"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    index_path = visual_root / "publish" / "index.json"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    rows = "\n".join(f"| {item['kind']} | {item['output']} | generated |" for item in index_outputs)
    return runtime.write(
        "visual",
        slug,
        "# 视觉发布产物 · acceptance\n\n"
        "## 0. 来源\n"
        f"- Package：pipeline/package/{slug}.md\n"
        f"- Slug：{slug}\n\n"
        "## 1. 已生成文件\n"
        "| 类型 | 文件 | 状态 |\n"
        "|---|---|---|\n"
        f"{rows}\n\n"
        "## 2. 生成索引\n"
        f"- index.json：{index_path.relative_to(project)}\n",
        source=f"visual-publish:pipeline/package/{slug}.md",
    )


def write_acceptance_complete_fixture(project: Path, slug: str = "acceptance-demo") -> ContentRuntime:
    runtime = ContentRuntime(project)
    runtime.init()
    created = runtime.create_run(topic=slug, platforms="公众号,小红书", run_id=slug)
    intake = runtime.write(
        "intake",
        slug,
        "企业出海和自媒体需要低成本样板。",
        source="test",
        run_id=created["run_id"],
    )

    def live_fetcher(platform: str, query: str) -> dict:
        return {
            "status": "available",
            "platform": platform,
            "endpoint_id": f"{platform}.fixture.search",
            "query_applied": True,
            "raw_payload": {"data": {"items": [{
                "title": f"{platform} {query}",
                "desc": "公开可验证样本。",
                "url": f"https://example.test/{platform}/{query}",
                "like_count": 20,
            }]}},
        }

    market = market_signal_module.fetch_market_signals(
        "企业出海和自媒体需要低成本样板。",
        ["wechat", "xhs"],
        project,
        live_fetcher=live_fetcher,
    )
    snapshot = market_signal_module.persist_market_snapshot(
        project=project,
        run_id=created["run_id"],
        topic=slug,
        source_path=intake["path"],
        result=market,
    )
    blueprint = runtime.write(
        "blueprint",
        slug,
        (
            "# 测试方案\n\n## 公众号独立蓝图\n公众号测试方案。\n\n## 小红书独立蓝图\n小红书测试方案。"
            + f"\n\n- 研究快照：{snapshot['manifest_path']}\n- 快照 SHA-256：{snapshot['snapshot_sha256']}\n"
        ),
        source="test",
        run_id=created["run_id"],
    )
    runtime.approve_artifact("topic_template", blueprint["path"], run_id=created["run_id"])
    runtime.write(
        "package",
        slug,
        VALID_PACKAGE_BODY,
        source="material:materials/source.md;theme:A 客户问题优先",
        run_id=created["run_id"],
    )
    write_acceptance_visual_publish(project, runtime, slug, recipe_release=True)
    return runtime

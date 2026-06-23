---
name: content-visual
description: AI FOUNDER INFLUENCE OS第五步：文章配图统一入口。根据平台/类型路由视觉需求：内容配图（小黑手绘）、公众号/小红书封面、社交媒体卡片。协调 ian-xiaohei-illustrations、xhs-card、wechat-publish-template 的视觉能力。
---

# content-visual · 文章配图

## 作用

把"配图"需求统一接入，自动判断要画什么、用什么风格、走哪个工具。

## 触发方式

- `/content-visual`
- `生成配图`、`文章配图`、`封面图`、`小黑配图`
- `小红书封面`、`公众号封面`

## 输入

如果用户未指定内容路径，优先通过 content-runtime 读取最新成稿：

```bash
# 公众号长文
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step write --latest

# 抖音口播稿
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step douyin --latest

# 小红书图文
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step xhs --latest
```

 - 文章段落 / 核心概念 / 完整文章，或用户粘贴的文案
 - 配图类型（可选）：内容配图、公众号封面、小红书封面、小红书图文、公众号头图+分享卡
 - 风格偏好（可选）：小黑手绘、杂志风、瑞士风

## 输出

根据类型分别输出：

1. **内容配图** → 调用小黑手绘风格，生成 16:9 配图 prompt / 图片
2. **公众号封面** → 调用 wechat-publish-template 封面能力，输出 21:9 头图 + 1:1 分享卡
3. **小红书封面/图文** → 调用 xhs-card，输出 3:4 图文集

产物统一归档到：

```
~/ai-content-system/pipeline/visual/{YYYY-MM-DD}-{slug}/

# visual 计划文件
~/ai-content-system/pipeline/visual/{YYYY-MM-DD}-{slug}-visual.md
```

**必须通过 content-runtime 写入**（计划文件）：

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step visual --slug {slug} \
  --content @/path/to/visual-plan-body.md \
  --source "write:{原文文件路径}"
```

配图计划通过 content-runtime 写入 `pipeline/visual/` 后，后续生成/调用工具可读取该计划：`read --step visual --latest`。

## 路由规则

| 用户说法 | 路由 |
|---|---|
| `给这篇文章配几张图` | 内容配图（小黑） |
| `公众号封面`、`头图` | wechat-publish-template 封面 |
| `小红书图文`、`做一套小红书` | xhs-card |
| `小红书封面`、`封面三行文案` | xhs-card（封面页） |
| `社交媒体卡片`、`轮播图` | xhs-card |


## 子 Skill 调用接口

content-visual 本身不生成图片，而是生成配图计划并路由到对应工具。调用约定如下：

### 小黑手绘（ian-xiaohei-illustrations）

```bash
# 调用示例
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py   --project ~/ai-content-system read --step visual --latest
# 读取计划中的「内容配图」prompt，再交给 ian-xiaohei-illustrations 生成 16:9 图片
```

### 公众号封面（wechat-publish-template）

```bash
# 输入参数
TITLE="Codex 像一个超人实习生"
SUBTITLE="写得快，但得有人把关"
# 产物：21:9 头图 + 1:1 分享卡 HTML
```

### 小红书封面/图文（xhs-card）

```bash
# 输入参数
TITLE="用 Codex 省下的 72 小时"
SUBTITLE="为什么我反而更忙了"
KEY_POINTS="["超人实习生","判断力更重要","程序员转型"]"
# 产物：3:4 图文集
```

所有产物统一归档到 `~/ai-content-system/pipeline/visual/{YYYY-MM-DD}-{slug}/`。

## 视觉风格协调原则

- 同一篇文章的视觉系统要统一：要么走 Editorial 杂志风，要么走 Swiss 网格风
- 小黑手绘适合内容配图，不适合封面主视觉
- 小红书/公众号封面优先用 xhs-card 的 Swiss/Editorial 系统
- 配色、字体、间距遵循各子 Skill 的规范，不跨风格混用

## 与其他 Skill 的关系

- 被调用：`wechat-writer`、`douyin-script`、`xhs-card`
- 调用：`ian-xiaohei-illustrations`（能力保留在 references/）、`xhs-card`、`wechat-publish-template`

## 输入/输出示例

### 示例 1：成稿 → 配图计划

**输入**
公众号长文《Codex 像一个超人实习生》。

**预期输出**
```markdown
# 配图计划 · Codex 像一个超人实习生

## 内容配图（小黑手绘）
- 场景：深夜办公室，人和 AI 实习生并排看屏幕
- 风格：小黑手绘，16:9

## 公众号封面
- 工具：wechat-publish-template
- 标题：Codex 像一个超人实习生
- 副标题：写得快，但得有人把关

## 小红书封面
- 工具：xhs-card
- 三行文案 + 高对比背景
```

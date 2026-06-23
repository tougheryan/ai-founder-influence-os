---
name: content-repurpose
description: AI FOUNDER INFLUENCE OS 跨平台改编。输入任一平台的成品内容（公众号/小红书/抖音），输出其他平台的改编方案，实现一鱼多吃。
---

# content-repurpose · 跨平台改编

## 作用

把一次创作变成多平台资产。不是简单复制粘贴，而是根据每个平台的用户习惯、内容形态、传播机制重新改编。

**核心原则**：同一选题，不同表达。

## 触发方式

- `/content-repurpose`
- `/一鱼多吃`、`改成小红书`、`改成抖音`、`改成公众号`
- `这个内容怎么改到其他平台`

## 输入

如果用户未指定原文路径，优先通过 content-runtime 读取最新成品内容：

```bash
# 公众号长文
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step write --latest

# 抖音口播稿
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step douyin --latest

# 小红书图文
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step xhs --latest
```

 - 任一平台的成品内容路径，或用户粘贴的文案
 - 可选：目标平台（wechat / xhs / douyin），默认输出除原文平台外的其他两个平台

## 输出

保存到：

```
~/ai-content-system/pipeline/platform-adapt/{YYYY-MM-DD}-{slug}-platform-adapt.md
```

**必须通过 content-runtime 写入**：

```bash
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step platform-adapt --slug {slug} \
  --content @/path/to/platform-adapt-body.md \
  --source "write:{原文文件路径}"
```

输出结构：

```markdown
# 跨平台改编方案 · {原标题}

## 0. 原文信息
- 原文平台：{}
- 原文路径：{}
- 核心选题：{}
- 核心观点：{}
- 目标人群：{}

## 1. 公众号改编（如原文不是公众号）

### 改编策略
- {策略说明}

### 标题方案
- 主标题：...
- 副标题：...

### 结构大纲
- 开头：...
- 主体：...
- 结尾：...

### 需要补充的素材
- ...

## 2. 小红书改编（如原文不是小红书）

### 改编策略
- {策略说明}

### 封面三行文案
- 第一行：...
- 第二行：...
- 第三行：...

### 6 张图文结构
1. {图 1 内容 + 文案}
2. {图 2 内容 + 文案}
3. {图 3 内容 + 文案}
4. {图 4 内容 + 文案}
5. {图 5 内容 + 文案}
6. {图 6 内容 + 文案}

### 需要补充的素材
- ...

## 3. 抖音改编（如原文不是抖音）

### 改编策略
- {策略说明}

### 口播标题
- ...

### 前 3 秒钩子
- ...

### 口播大纲（1000-1400 字）
- ...

### 需要补充的素材
- ...

## 4. 平台差异对照

| 维度 | 公众号 | 小红书 | 抖音 |
|---|---|---|---|
| 核心表达 | ... | ... | ... |
| 标题逻辑 | ... | ... | ... |
| 开头方式 | ... | ... | ... |
| 信息密度 | ... | ... | ... |
| 转化路径 | ... | ... | ... |
```

改编方案通过 content-runtime 写入 `pipeline/platform-adapt/` 后，下游写作 skill 可直接通过 `read --step platform-adapt --latest` 获取方案。

## 改编原则

### 公众号 → 小红书

- 把长文的 1-2 个核心观点抽出来
- 用「封面三行 + 6 张图」重新组织
- 每一页只讲一个点，多用 bullet/数字/emoji
- 保留金句和数据，删除叙事铺垫
- 标题用身份代入/结果承诺/数字锚定公式

### 公众号 → 抖音

- 把长文压缩成 1000-1400 字口播
- 前 3 秒必须出现冲突/反常识/痛点
- 每 4-5 秒一个新信息点
- 保留最强案例和数据，删除背景铺垫
- 结尾金句，不留 CTA（获客型）

### 小红书 → 公众号

- 把 6 张图的内容扩展成长文
- 补充背景、案例、论证
- 增加叙事节奏和个人视角
- 标题用陈述句，35-58 字

### 小红书 → 抖音

- 把图文改成口播
- 选择最有冲突感的 1 张图作为钩子
- 快速过其他要点
- 口语化，每段不超过 15 秒

### 抖音 → 公众号

- 把口播稿扩展成深度长文
- 补充细节、来源、反方观点
- 增加文化升维
- 标题从「钩子型」改为「陈述句型」

### 抖音 → 小红书

- 把口播稿拆成 6 张图
- 第一张图用抖音 hook 做封面
- 后面 5 张图对应口播的 5 个信息点
- 每张图配一句金句或数据

## 工作流程

1. **读取原文**：判断原文平台、内容类型、核心选题和观点
2. **提取核心资产**：
   - 核心观点
   - 金句
   - 数据/案例
   - 情绪点
   - 转化路径
3. **选择目标平台**：默认输出其他两个平台，或按用户指定
4. **按平台特性改编**：应用上述改编原则
5. **输出改编方案**：写入 `pipeline/platform-adapt/`
6. **给出下一步**：
   - 公众号：`/content-write {改编方案}`
   - 抖音：`/content-douyin {改编方案}`
   - 小红书：`/content-xhs {改编方案}`

## 质量原则

- 不丢失原文的核心观点和最有价值的案例
- 不简单地复制粘贴，必须根据平台重新组织
- 每个平台版本都要有自己独立的标题和开头
- 标注需要补充的素材，不编造不存在的内容

## 与其他 Skill 的关系

- **上游**：`wechat-writer`、`douyin-script`、`xhs-card`
- **下游**：`content-visual`（配图）、`content-prelaunch`（发布前检查）
- **读取**：`brain/market/formula-library.md`（平台公式库）

## 语言

- 用户用中文就用中文回复，用英文就用英文回复
- 中文回复遵循《中文文案排版指北》

## 输入/输出示例

### 示例 1：公众号成稿 → 跨平台改编

**输入**
公众号长文《Codex 像一个超人实习生》。

**预期输出**
```markdown
# 跨平台改编方案

## 抖音版
- 钩子：它一晚上写完的代码，我花了一早上改 bug
- 时长：60s
- CTA：评论区说说你被 AI 改变的工作方式

## 小红书版
- 封面：三行痛点文案
- 正文：6 页图文，突出「超人实习生」类比

## 微博/X 版
- 核心金句 + 文章链接
```

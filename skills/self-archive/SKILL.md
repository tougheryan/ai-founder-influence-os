---
name: self-archive
description: AI FOUNDER INFLUENCE OS第八步：自我沉淀。记录每次发文的选题、成稿、数据、用户反馈，沉淀个人风格库、案例库、禁区清单，形成可复用的创作资产。
---

# self-archive · 自我沉淀

## 作用

让每次创作都累积成资产。不是简单存档，而是把选题、表达、反馈结构化，变成下一次创作的起点。

## 触发方式

- `/content-archive`
- `归档沉淀`、`记录这次发文`、`更新我的风格库`
- `我写过哪些案例`、`我的禁区是什么`

## 输入

- 成稿路径；如果未指定，可通过 content-runtime 读取最新成稿：
  ```bash
  python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
    --project ~/ai-content-system read --step write --latest
  ```
- `content-review` 复盘报告路径（可选）；如果未指定，可读取最新 review：
  ```bash
  python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
    --project ~/ai-content-system read --step review --latest
  ```
- 用户补充反馈

## 输出

更新以下文件：

```
~/ai-content-system/brain/style-evolution.md
~/ai-content-system/brain/case-library.md
~/ai-content-system/brain/no-fly-zone.md
~/ai-content-system/brain/insights.md
```

单次归档记录保存到：

```
~/ai-content-system/pipeline/archive/{YYYY-MM-DD}-{slug}-archive.md
```

**归档记录必须通过 content-runtime 写入**：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step archive --slug {slug} \
  --content @/path/to/archive-body.md \
  --source "write:{成稿路径},review:{review路径}"
```

写入后必须运行 runtime 校验：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  validate --step archive --file pipeline/archive/{文件名}.md
```

`validate` 会额外执行资产沉淀质量审计，返回 `quality_status`、`quality_errors`、`quality_reviews` 和 `quality_checks`。

`brain/` 下各文件的更新由本 skill 直接维护。

## 单次归档记录结构

```markdown
# 自我归档 · {标题}

## 1. 选题资产
- 标题：...
- 角度：...
- 目标读者：...
- 命中原因：...

## 2. 成稿资产
- 公众号/小红书成稿：pipeline/final/... 或 pipeline/xhs/...
- 发布阵地：...
- 最终链接：...

## 3. 数据与反馈资产
- 数据表现：阅读/播放、互动、评论、转化...
- 评论反馈：...
- 用户问题：...

## 4. 风格资产更新
- 高频词：...
- 句式节奏：...
- 结构声纹：...
- 写入目标：brain/style-evolution.md

## 5. 案例库更新
- 核心案例：...
- 使用场景：...
- 数据表现：...
- 可复用场景：...
- 写入目标：brain/case-library.md

## 6. 禁区更新
- 新增禁区：...
- 原因：...
- 触发场景：...
- 写入目标：brain/no-fly-zone.md

## 7. 可复用模式
- 结构模式：...
- 迁移条件：...
- 下一次使用：...

## 8. 写入确认
- 已写入：brain/style-evolution.md
- 已写入：brain/case-library.md
- 已写入：brain/no-fly-zone.md
- 已写入：brain/insights.md

## 8.1 资产索引
| 资产文件 | 新增条目 | 来源证据 | 下游调用 |
|---|---|---|---|
| brain/style-evolution.md | ... | 成稿 / review / archive | wechat-writer / content-twin |
| brain/case-library.md | ... | 成稿 / 数据反馈 | content-angle / content-breakdown |
| brain/no-fly-zone.md | ... | audit / compliance / review | wechat-writer / content-breakdown |
| brain/insights.md | ... | review 用户问题 / 表现记录 | content-angle / content-review |
```

## 沉淀结构

### style-evolution.md

```markdown
# 风格演变

## 当前风格关键词
- ...

## 高频表达
- ...

## 节奏特征
- ...

## 近期变化
- 2026-XX-XX：...
```

### case-library.md

```markdown
# 个人案例库

| 日期 | 标题 | 核心案例 | 使用角度 | 数据表现 | 可复用场景 |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |
```

### no-fly-zone.md

```markdown
# 禁区清单

## 事实禁区
- ...

## 表达禁区
- ...

## 平台禁区
- ...

## 价值观禁区
- ...

## 更新记录
| 日期 | 来源 | 新增禁区 | 触发场景 |
|------|------|---------|---------|
| ... | ... | ... | ... |
```

## 沉淀原则

- 只沉淀经过验证的事实和反馈
- 风格描述要具体到词、句、结构
- 案例要标注使用场景和效果
- 禁区要写明原因，不是简单禁止

## 归档质量闸门

归档不是保存文件名，而是把一次创作转成长期可复用资产：

- 选题资产必须写明标题、角度、目标读者和命中原因。
- 成稿资产必须写明成稿路径、发布阵地和最终链接或未发布原因。
- 数据与反馈资产必须包含数字信号和用户评论/问题。
- 真实发布归档才能沉淀阅读、播放、评论、转化等数字表现；数据必须来自 `content-review` 的真实发布复盘。
- demo/未发布只能沉淀为流程样例或待验证观察：数据表现写“未真实发布，无真实数据”，评论反馈和用户问题必须标注“demo 预设 / 不作为真实发布反馈”。
- demo/未发布不能把模拟反馈写成真实案例库数据、真实用户画像或“新增有效洞察”；正式项目必须发布并复盘后再写入真实资产。
- 风格资产必须具体到词、句、结构或节奏，并写入 `brain/style-evolution.md`。
- 案例库更新必须包含使用场景、数据表现和可复用场景，并写入 `brain/case-library.md`。
- 禁区更新必须写明原因和触发场景，并写入 `brain/no-fly-zone.md`。
- 写入确认必须同时覆盖 `brain/style-evolution.md`、`brain/case-library.md`、`brain/no-fly-zone.md`、`brain/insights.md`。
- `## 8.1 资产索引` 必须列出每个 brain 文件的新增条目、来源证据和下游调用 skill，确保资产可被下一轮生产线复用。

质量状态含义：

| 状态 | 含义 | 后续动作 |
|---|---|---|
| `pass` | 四类 brain 资产都有明确沉淀，风格/案例/禁区可复用 | 可进入 `content-twin` |
| `review_required` | 资产基本完整，但迁移条件、成稿链接或某个写入目标需人工确认 | 可沉淀，但后续补齐 |
| `blocked` | 缺核心资产、缺数字反馈、缺写入确认或归档过于空泛 | 不进入孪生观察，先补归档 |

## 与其他 Skill 的关系

- 上游：`content-review`
- 被读取：`wechat-writer`（作为风格参考）、`content-angle`（作为角度参考）

## 输入/输出示例

### 示例 1：全部产物 → 归档沉淀

**输入**
一个选题从 intake 到 review 的全部文件。

**预期输出**
```markdown
# 自我归档 · Codex 像一个超人实习生

## 选题
Codex 像一个超人实习生

## 成稿
- 公众号：《Codex 像一个超人实习生》
- 小红书：图文卡片与评论区承接
- 小红书：6 页图文

## 关键反馈
- 评论高频词：真实、焦虑、实习生
- 数据亮点：分享率 1.9%

## 禁区补充
不要过度神化 Codex，需保留失败案例

## 可复用模式
「超人实习生」类比可迁移到其它 AI 工具选题
```

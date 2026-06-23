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
  python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
    --project ~/ai-content-system read --step write --latest
  ```
- `content-review` 复盘报告路径（可选）；如果未指定，可读取最新 review：
  ```bash
  python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
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
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step archive --slug {slug} \
  --content @/path/to/archive-body.md \
  --source "write:{成稿路径},review:{review路径}"
```

`brain/` 下各文件的更新由本 skill 直接维护。

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
- 抖音：口播稿 + 拍摄方案
- 小红书：6 页图文

## 关键反馈
- 评论高频词：真实、焦虑、实习生
- 数据亮点：分享率 1.9%

## 禁区补充
不要过度神化 Codex，需保留失败案例

## 可复用模式
「超人实习生」类比可迁移到其它 AI 工具选题
```

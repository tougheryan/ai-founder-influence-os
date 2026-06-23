---
name: content-breakdown
description: AI FOUNDER INFLUENCE OS第三步：内容拆解。基于 content-angle 选定的角度，输出关键词矩阵、爆款档案参考、公众号/小红书/抖音主副标题、开场 3 秒钩子、小红书封面三行文案。
---

# content-breakdown · 内容拆解

## 作用

把选定的角度变成可直接进入生产的拆解方案：不同平台怎么起标题、怎么钩人、怎么切关键词。

## 触发方式

- `/content-breakdown`
- `拆解内容`、`怎么写标题`、`生成钩子`
- `小红书标题怎么写`、`抖音前 3 秒怎么切`

## 输入

- `content-intake` 素材报告路径
- `content-angle` 角度报告路径（或用户直接指定的角度），优先读取 `content-validate` 立项报告中的「平台首发策略」和「素材补充清单」
- 如果用户未指定路径，优先通过 content-runtime 读取最新 angle 报告：
  ```bash
  python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
    --project ~/ai-content-system \
    read --step angle --latest
  ```
- 可选：目标平台

## 输出

保存到：

```
~/ai-content-system/pipeline/breakdown/{YYYY-MM-DD}-{slug}-breakdown.md
```

**必须通过 content-runtime 写入**：

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step breakdown --slug {slug} \
  --content @/path/to/breakdown-body.md \
  --source "angle:{angle文件路径}"
```

输出结构：

```markdown
# 内容拆解方案 · {标题}

## 关键词矩阵

| 平台 | 核心关键词 | 长尾关键词 | 标签 |
|---|---|---|---|
| 公众号 | ... | ... | ... |
| 小红书 | ... | ... | ... |
| 抖音 | ... | ... | ... |

## 爆款档案参考

- 参考 1：`materials/hit-library/...md` — 可借鉴点：...
- 参考 2：...

## 标题方案

### 公众号
- 主标题：...
- 副标题：...

### 小红书
- 主标题：...
- 封面三行文案：
  - 第一行：...
  - 第二行：...
  - 第三行：...

### 抖音
- 口播标题：...
- 前 3 秒钩子：...

## 开场钩子库

- 反常识型：...
- 痛点型：...
- 身份型：...
- 数据型：...

## 平台适配建议

- 公众号：...
- 小红书：...
- 抖音：...

## 素材补充清单

基于选定角度和平台策略，进入写作前还缺什么：

- [ ] {数据/事实}
- [ ] {具体案例/人物}
- [ ] {用户痛点原话}
- [ ] {产品/服务信息}
- [ ] {对标参考}
- [ ] {视觉素材}

> 如果 content-validate 已经输出过补充清单，这里应与之对齐并细化。

## 下一步执行指令

- 写公众号：`/content-write`，`wechat-writer` 通过 `read --step breakdown --latest` 读取最新拆解方案
- 写抖音口播：`/content-douyin`，`douyin-script` 通过 `read --step breakdown --latest` 读取最新拆解方案
- 做小红书图文：`/content-xhs`，`xhs-card` 通过 `read --step breakdown --latest` 读取最新拆解方案
```

## 标题生成原则

- 公众号：35-58 字，陈述句，无问号和感叹号，有具体场景/数字/年龄
- 小红书：18-30 字，封面三行文案要有钩子、利益点、情绪词
- 抖音：口语化，前 3 秒必须出现冲突/反常识/痛点

## 复用资产

- `content-formula-extract` 的标题/开头/结构/结尾公式库
- `wechat-title-maker` 的 5 大标题手法
- `ah-xhs-cover-title` 的 85 条封面公式库、8 钩子 × 6 赛道分类

## 与其他 Skill 的关系

- 上游：`content-intake`、`content-angle`
- 下游：`wechat-writer`、`douyin-script`、`xhs-card`

## 输出后的下一步

拆解方案通过 content-runtime 写入 `pipeline/breakdown/` 后，下游写作 skill 可直接通过 `read --step breakdown --latest` 获取最新方案，无需用户手动指定路径。

## 输入/输出示例

### 示例 1：选定角度 → 拆解方案

**输入**
content-angle 推荐角度：「实习生类比」。

**预期输出**
```markdown
# 内容拆解方案 · Codex 像一个超人实习生

## 关键词矩阵
- 核心词：Codex、AI 编程、实习生
- 情绪词：震撼、漏洞、接管、判断力
- 场景词：凌晨改 bug、代码审查、老工程师

## 标题方案
1. 《Codex 像一个超人实习生：写得快，但得有人把关》
2. 《我用 Codex 省下的 72 小时，花在了哪里》

## 开场钩子库
- "它一晚上写完的代码，我花了一早上改 bug。"
- "这不是替代，是空降了一个不会疲倦的实习生。"
```

---
name: content
description: AI FOUNDER INFLUENCE OS 总控入口。对话式判断用户意图，展示当前 OS 状态，路由到具体子 skill。
---

# content · AI FOUNDER INFLUENCE OS 总控入口

## 工程底座：content-runtime

`content` 总控入口以及所有子 skill 在执行前，优先调用 `content-runtime` 管理项目状态和文件：

```bash
# 1. 初始化/确认项目目录
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system init

# 2. 读取当前 session 状态
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system state

# 3. 列出最近 7 天的 pipeline 文件
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system list --days 7
```

子 skill 读取上游输出时，应使用 `read --step {上游} --latest`，而不是自己扫描文件系统。生成内容后，使用 `write --step {当前} --slug {slug} --content ...` 写入并自动更新 state。

完整命令文档见 `$HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/SKILL.md`。


## 作用

`content` 是 AI FOUNDER INFLUENCE OS 的统一入口。用户不需要记住所有子 skill 的触发词，只需要说「帮我做内容」「我要写公众号」「这个选题值不值得做」，由 `/content` 判断意图并路由。

## 触发方式

- `/content`
- `内容系统`、`帮我做内容`、`我要发内容`、`内容流水线`

## 工作模式

### 模式 1：意图判断

用户给出模糊指令时，展示当前 OS 状态并询问下一步：

```
## AI FOUNDER INFLUENCE OS · 当前状态

### 你刚才说
"{用户原话}"

### 我猜你想做
- A. 素材理解 / 选题立项
- B. 生成角度 / 拆解内容
- C. 写公众号 / 抖音 / 小红书
- D. 审核 / 合规检查
- E. 数据复盘 / 归档沉淀
- F. 数字孪生观察

### 建议下一步
{根据上下文给出最可能的建议}

请回复选项字母，或直接说你想做什么。
```

### 模式 2：直接路由

用户给出明确指令时，直接路由到对应子 skill：

| 用户意图 | 路由到 |
|---|---|
| 理解素材 / 分析这个 PDF | `content-intake` |
| 立项 / 这个值不值得写 | `content-validate` |
| 生成角度 / 有哪些角度 | `content-angle` |
| 拆解内容 / 怎么写标题 | `content-breakdown` |
| 写公众号 / 写文章 | `wechat-writer` |
| 写抖音口播 / 获客稿 | `douyin-script` |
| 做小红书图文 | `xhs-card` |
| 一鱼多吃 / 改成其他平台 | `content-repurpose` |
| 生成配图 / 封面 | `content-visual` |
| 发布前检查 | `content-prelaunch` |
| 合规检查 / 查违禁词 | `content-compliance` |
| 审核内容 | `content-audit` |
| 复盘数据 | `content-review` |
| 归档沉淀 | `self-archive` |
| 孪生观察 | `content-twin` |
| 商业诊断 / 选题诊断 / 标题公式 | `content-dbs-fusion` |
| 继续上次 | `dbs-restore` |

### 模式 3：状态展示

用户说「我现在在哪一步」「接下来干嘛」时，扫描 `pipeline/` 最近 7 天的文件，展示当前进度：

```
## 当前内容流水线进度

最近操作：
- 2026-06-21：content-intake → pipeline/intake/2026-06-21-xxx-intake.md
- 2026-06-21：content-angle → pipeline/angles/2026-06-21-xxx-angles.md
- 待完成：content-breakdown

建议下一步：
/content-breakdown ~/ai-content-system/pipeline/angles/2026-06-21-xxx-angles.md
```

## 上下文感知

`/content` 每次触发时优先读取：

1. `~/ai-content-system/MASTER_PLAYBOOK.md`
2. `~/ai-content-system/brain/commands.md`
3. `~/ai-content-system/sessions/` 下的最新状态文件
4. `~/ai-content-system/pipeline/` 最近 7 天的文件列表

基于以上信息判断用户最可能想做什么。

## 输出

- 如果是意图判断：给出选项和建议，等用户回复
- 如果是直接路由：调用对应 skill 并说明路由原因
- 如果是状态展示：给出当前进度和下一步建议

## 说话风格

1. 简洁，不要罗列所有 skill
2. 根据上下文给出最可能的 1-2 个建议
3. 让用户做最小选择，而不是开放提问

## 与其他 Skill 的关系

- **被所有子 skill 依赖**：`content` 是入口，但不替代子 skill 的具体工作
- **读取**：`MASTER_PLAYBOOK.md`、`commands.md`、pipeline 状态、sessions 状态

## 示例

```
用户：帮我写个公众号
→ 调用 wechat-writer

用户：这个选题值不值得做
→ 调用 content-validate

用户：我现在做到哪了
→ 扫描 pipeline，展示进度

用户：继续上次
→ 调用 dbs-restore
```

## 语言

- 用户用中文就用中文回复，用英文就用英文回复
- 中文回复遵循《中文文案排版指北》

## 输入/输出示例

### 示例 1：用户素材 → 总控路由

**输入**
"我昨晚用 Codex 改项目，感觉又兴奋又慌，想写点东西。"

**预期输出**
1. 调用 `content-intake` 生成素材理解报告
2. 调用 `content-validate` 判断选题是否成立
3. 通过 `content-flow` 推进后续步骤

---
name: content-runtime
description: AI FOUNDER INFLUENCE OS 的轻量状态与文件管理 runtime。统一初始化项目目录、读写 pipeline/brain/sessions、管理跨步骤状态、校验输出结构。被 content 及所有子 skill 调用。
---

# content-runtime · AI Founder Influence OS 状态与文件管理器

## 作用

`content-runtime` 是 AI Founder Influence OS 的工程底座。它不负责内容创意，只负责：

1. **项目初始化**：创建 `pipeline/`、`brain/`、`sessions/`、`assets/`、`materials/` 标准目录
2. **文件读写**：统一把每个步骤的输出写成带 YAML frontmatter 的 markdown
3. **状态管理**：维护 `sessions/latest.json`，记录当前步骤和每个步骤最新文件路径
4. **最近文件扫描**：按时间列出最近 N 天的 pipeline 文件
5. **结构校验**：检查某步骤输出是否包含必需的章节标题

所有 content 子 skill 在执行具体工作前，应该先调用本 runtime 完成 IO 和状态管理。

## 安装与位置

本 skill 无需 pip 安装，CLI 脚本路径固定：

```
$HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py
```

每个子 skill 可以通过绝对路径调用它。

## 命令

### 1. 初始化项目

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py   --project ~/ai-content-system init
```

会创建：

```
~/ai-content-system
├── pipeline/
│   ├── intake/
│   ├── validate/
│   ├── angles/
│   ├── breakdown/
│   ├── final/
│   ├── platform-adapt/
│   │   ├── wechat/
│   │   ├── xhs/
│   │   └── douyin/
│   ├── audit/
│   ├── visual/
│   ├── review/
│   ├── archive/
│   └── twin/
├── brain/
│   ├── insights.md
│   ├── style-evolution.md
│   ├── case-library.md
│   ├── no-fly-zone.md
│   └── twin/
│       ├── content-dna.md
│       ├── pattern-library.md
│       ├── voice-signature.md
│       ├── evolution-log.md
│       └── reader-profile.md
├── sessions/
│   └── latest.json
├── assets/
└── materials/
```

### 2. 写入步骤输出

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py   --project ~/ai-content-system   write --step intake --slug demo   --content "# 素材理解报告\n\n## 0. 素材场景\n..."   --source "用户口述"
```

`--content` 也可以指向文件：`--content @/path/to/content.md`

写入后会自动更新 `sessions/latest.json` 中 `intake` 对应的最新文件路径。

### 3. 读取步骤输出

读最新：

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py   --project ~/ai-content-system   read --step intake --latest
```

读指定文件：

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py   --project ~/ai-content-system   read --step intake --file pipeline/intake/2026-06-23-demo-intake.md
```

### 4. 列出最近文件

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py   --project ~/ai-content-system list --days 7
```

### 5. 读取 session state

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py   --project ~/ai-content-system state
```

### 6. 校验文件结构

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py   --project ~/ai-content-system   validate --step intake --file pipeline/intake/2026-06-23-demo-intake.md
```

`validate` 会优先加载 `schemas/{step}.schema.json` 做校验：检查 frontmatter 必填字段、`step` 枚举值，以及 body 中是否包含 schema 要求的章节标题正则。如果该步骤没有 schema 文件，则回退到内置 `REQUIRED_SECTIONS` 做简单子串检查。

### 7. 追加/读取 brain 文件

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  brain --file insights.md --content "本次投放数据表现..."

# 读取
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  brain --file insights.md --read
```

`--content` 也支持文件：`--content @/path/to/note.md`。

## 输出文件格式

每个 pipeline 文件必须是以下的 markdown 格式：

```markdown
---
step: intake
slug: demo
date: 2026-06-23
source: 用户口述
created_at: 2026-06-23T17:16:01
---

# 素材理解报告 · {标题}

## 0. 素材场景
...
```

frontmatter 由 runtime 自动写入，skill 只需提供正文。

## 给子 skill 的调用约定

每个子 skill 在执行时应该：

1. 先确定 `PROJECT` 路径（默认 `~/ai-content-system`，用户可指定）
2. 调用 `init` 确保目录存在
3. 调用 `state` 或 `list` 获取上下文
4. 调用 `read --step {上游} --latest` 读取上游输出
5. 生成内容后调用 `write --step {当前} --slug {slug} --content ... --source ...`
6. （可选）调用 `validate` 自检输出结构

## 流水线导演（一键推进）

除了直接调用 runtime，还可以用 `content-pipeline` 导演脚本查看状态、生成下一步任务卡：

```bash
# 查看当前流水线进度
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_pipeline.py \
  --project ~/ai-content-system status

# 生成下一步任务卡
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_pipeline.py \
  --project ~/ai-content-system next
```

任务卡会写入 `sessions/next-task.md`，包含推荐步骤、对应 Skill、上游摘要和写回命令。

也可以使用 Makefile 快捷入口：

```bash
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime status PROJECT=~/ai-content-system
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime next PROJECT=~/ai-content-system [SLUG=demo]
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime flow PROJECT=... INTAKE=/path/to/intake.md [SLUG=demo]
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime write PROJECT=... STEP=intake SLUG=demo FILE=output.md
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime brain PROJECT=... FILE=insights.md CONTENT="..."
```

也可以从 intake 素材直接启动 `flow`：

```bash
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime flow \
  PROJECT=~/ai-content-system INTAKE=/path/to/intake.md SLUG=demo
```

或直接调用 pipeline 导演：

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_pipeline.py \
  --project ~/ai-content-system flow --intake /path/to/intake.md --slug demo
```

`flow` 会先把 intake 写入 `pipeline/intake/`，然后定位当前未完成的步骤，并生成 `sessions/flow-task.md` 任务卡。


## 步骤填写模板

每个 pipeline 步骤都有对应的 markdown 模板，位于 `templates/` 目录：

```bash
templates/
├── intake.md
├── validate.md
├── angle.md
├── breakdown.md
├── write.md
├── douyin.md
├── xhs.md
├── visual.md
├── prelaunch.md
├── compliance.md
├── audit.md
├── review.md
├── archive.md
└── twin.md
```

`content-flow` / `next` / `guide` 生成的任务卡会自动引用对应模板路径。你可以复制模板、填充内容，再用 `write` 命令写回 runtime。

## 详细引导命令

如果不知道当前步骤该做什么，使用 `guide`：

```bash
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime guide PROJECT=~/ai-content-system [SLUG=demo]
```

`guide` 会输出当前步骤的：
- 这一步是做什么
- 输入/输出标准
- 需要调用的 Skill
- 具体写回命令
- 常见坑

## 支持步骤

`intake`、`validate`、`angle`、`breakdown`、`write`、`douyin`、`xhs`、`platform-adapt`、`visual`、`prelaunch`、`compliance`、`audit`、`publish`、`review`、`archive`、`twin`


## JSON Schema 校验

每个 pipeline 步骤都有对应的 JSON Schema，位于 `schemas/` 目录：

```bash
schemas/
├── common.json              # frontmatter 通用结构
├── intake.schema.json
├── validate.schema.json
├── angle.schema.json
├── breakdown.schema.json
├── write.schema.json
├── douyin.schema.json
├── xhs.schema.json
├── visual.schema.json
├── prelaunch.schema.json
├── compliance.schema.json
├── audit.schema.json
├── review.schema.json
├── archive.schema.json
└── twin.schema.json
```

`validate` 命令会检查 body 中是否包含该步骤必需的章节标题。
未来可在 `content_runtime.py` 中加载 schema 做更严格的 JSON 校验。

## 通用 Session Manager

content-runtime 提供通用会话状态管理器，统一处理 Context Boot、状态恢复、模块路由：

```bash
# Context Boot（首次完整，后续压缩）
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/session_manager.py   --project ~/ai-content-system boot [--force]

# 根据用户输入推荐 skill
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/session_manager.py   --project ~/ai-content-system route "帮我写获客稿"

# 更新 session state
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/session_manager.py   --project ~/ai-content-system update --section knowledge_log --content "新增观察..."

# 读取完整状态
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/session_manager.py   --project ~/ai-content-system state
```

状态文件保存在 `sessions/session-state.json`，结构包含：定位、选题追踪、稿子追踪、待处理、知识库日志、校准日志、临时观察、会话摘要。

Makefile 快捷入口：

```bash
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime session-boot PROJECT=~/ai-content-system [FORCE=1]
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime session-route PROJECT=... INPUT='帮我写获客稿'
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime session-update PROJECT=... SECTION=knowledge_log CONTENT='...'
make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime session-state PROJECT=...
```

## 与其他 skill 的关系

- 被 `content` 总控入口优先调用
- 被所有 content 子 skill 依赖，用于状态读写和文件管理
- 不替代任何子 skill 的创意/判断工作

## 输入/输出示例

### 示例 1：写入 intake 步骤

**输入**
```bash
python content_runtime.py --project ~/ai-content-system write   --step intake --slug codex   --content @intake.md --source "用户口述"
```

**预期输出**
```json
{
  "status": "written",
  "path": "pipeline/intake/2026-06-23-codex-intake.md"
}
```

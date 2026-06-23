# AI Founder Influence OS · 使用手册

## 1. 简介

AI Founder Influence OS 是一套面向 AI 创业者与个人 IP 构建者的内容生产与获客智能体。它把"素材理解 → 选题立项 → 角度生成 → 内容拆解 → 多平台成稿 → 配图 → 审核 → 发布 → 复盘 → 归档 → 数字孪生"整条流水线，用统一的轻量 runtime 管理起来。

本插件包含 19 个 skill：

- 工程底座：`content-runtime`
- 总控入口：`content`
- 流水线导演：`content-runtime/scripts/content_pipeline.py`
- 素材与决策：`content-intake`、`content-validate`、`content-angle`、`content-breakdown`
- 内容生产：`wechat-writer`、`douyin-script`、`xhs-card`
- 平台适配与视觉：`content-repurpose`、`content-visual`、`wechat-publish-template`
- 发布前检查：`content-prelaunch`、`content-compliance`、`content-audit`
- 数据与资产：`content-review`、`self-archive`、`content-twin`
- 商业诊断桥接：`content-dbs-fusion`

## 2. 安装

插件已注册到个人 marketplace：

```bash
codex plugin add ai-founder-influence-os@personal
```

安装前建议备份或移走 `~/.agents/skills/` 下的旧版同名 skill，避免冲突。

## 3. 快速开始

```bash
# 进入插件的 content-runtime
cd $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime

# 初始化项目
make init PROJECT=~/ai-content-system

# 准备 intake 素材文件，例如 my-material.md
make content-flow PROJECT=~/ai-content-system INTAKE=my-material.md SLUG=demo
```

`content-flow` 会自动：

1. 把 intake 素材写入 `pipeline/intake/`
2. 更新 `sessions/latest.json`
3. 找到当前未完成的步骤
4. 生成 `sessions/flow-task.md` 任务卡

按照任务卡的指引调用对应 skill，生成产物后再次运行同一命令即可推进到下一步。

## 4. 常用 Makefile 命令

```bash
make init PROJECT=~/ai-content-system
make status PROJECT=~/ai-content-system
make next PROJECT=~/ai-content-system [SLUG=demo]
make content-flow PROJECT=... INTAKE=/path/to/intake.md [SLUG=demo]
make write PROJECT=... STEP=intake SLUG=demo FILE=output.md [SOURCE=...]
make read PROJECT=... STEP=intake
make brain PROJECT=... FILE=insights.md CONTENT="..."
make validate-file PROJECT=... STEP=intake FILE=pipeline/intake/xxx.md
make session-boot PROJECT=... [FORCE=1]
make session-route PROJECT=... INPUT="帮我写获客稿"
make session-update PROJECT=... SECTION=knowledge_log CONTENT="..."
make test
```

## 5. Pipeline 步骤

完整流水线共 16 个步骤：

```
intake → validate → angle → breakdown
       → write / douyin / xhs (并行)
       → platform-adapt → visual
       → prelaunch / compliance (并行) → audit
       → publish → review → archive → twin
```

每个步骤的产物都通过 `content-runtime write` 写入 `pipeline/{step}/`，并更新 `sessions/latest.json`。

## 6. JSON Schema 校验

每个步骤都有对应的 schema 文件：

```bash
$HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/schemas/
├── common.json
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

`make validate-file` 或 `python content_runtime.py validate` 会优先加载 schema 校验 frontmatter 和 body 章节标题。

## 7. Session Manager

通用会话状态管理器负责 Context Boot、状态恢复和模块路由：

```bash
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/session_manager.py \
  --project ~/ai-content-system boot [--force]

python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/session_manager.py \
  --project ~/ai-content-system route "帮我写小红书图文"
```

状态保存在 `~/ai-content-system/sessions/session-state.json`，包含定位、选题追踪、稿子追踪、待处理、知识库日志、校准日志、临时观察、会话摘要。

## 8. 测试

插件内置测试套件：

```bash
cd $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime
make test
```

测试覆盖：schema 校验（valid/invalid）、write/read 往返、session route/boot。

## 9. 目录结构

```
~/ai-content-system
├── pipeline/          # 各步骤产物
├── brain/             # 风格、禁区、案例、数字孪生
├── sessions/          # latest.json、session-state.json、任务卡
├── assets/            # 图片、音视频素材
└── materials/         # 原始素材
```

## 10. 进阶：开发插件

插件源码位于 `~/plugins/ai-founder-influence-os/`。修改后运行：

```bash
cd $HOME/.codex/skills/.system/plugin-creator
python3 scripts/update_plugin_cachebuster.py \
  $HOME/plugins/ai-founder-influence-os

codex plugin add ai-founder-influence-os@personal
```

建议把插件目录纳入 Git 版本控制后再做团队分发。

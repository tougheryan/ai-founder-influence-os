# AI Founder Influence OS · Codex Plugin

AI 创业者内容生产与获客智能体插件。

## 安装

```bash
codex plugin add ai-founder-influence-os@personal
```

## 从 GitHub 安装

```bash
git clone https://github.com/tougheryan/ai-founder-influence-os.git
codex plugin add ./ai-founder-influence-os
```



安装前建议移走 `~/.agents/skills/` 下的旧版同名 skill。

## 快速开始

```bash
cd $HOME/plugins/ai-founder-influence-os/skills/content-runtime
make init PROJECT=~/ai-content-system
make content-flow PROJECT=~/ai-content-system INTAKE=my-material.md SLUG=demo
```

## 文档

- 使用手册：`docs/manual.md`
- PDF 版：`docs/manual.pdf`

## 测试

```bash
cd $HOME/plugins/ai-founder-influence-os/skills/content-runtime
make test
```

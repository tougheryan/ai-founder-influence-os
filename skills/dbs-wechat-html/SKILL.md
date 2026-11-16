---
name: dbs-wechat-html
description: Echo Founder 自有的本地公众号基础 HTML 排版器，历史路径仅为运行时兼容保留。
---

# Echo Founder 本地公众号排版

本目录是 Echo Founder 公开源码版的独立 MIT 实现，不是 dontbesilent/dbskill 的分发副本，不包含其提示词、CSS 或模板。

读取已经确认的 Markdown 和授权图片，保留文字、标点、段落、链接与图片位置，生成 HTML 后逐段核对并检查手机预览。

```bash
python3 skills/dbs-wechat-html/generate_preview.py --input article.md --style minimal --output-dir /tmp/echo-founder-preview
```

`--mode preview` 生成六种基础预览，`--mode all` 输出完整兼容样式目录；这些基础样式不请求模型、数据、排版或生图服务。完整 md2wechat 主题仍由用户自行安装并配置，按其单独条款使用。

保持历史模块名是为了旧项目与成品记录可读。不得将本地预览当作平台草稿或发布结果。

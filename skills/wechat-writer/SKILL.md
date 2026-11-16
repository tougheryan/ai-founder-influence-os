---
name: wechat-writer
description: |
  Echo Founder 公众号长文写作 Skill。以当前客户已确认的创作名片、创作规则与本次 run 授权素材为身份和文风真源，产出公众号长文。当用户需要撰写公众号文章、写稿子、续写文章、根据素材产出长文时使用。触发词包括但不限于：/content-write、写公众号、写文章、写稿子、帮我写、续写、扩写、公众号文章、长文、出稿、按我的风格写。不要用于小红书帖子、推特或朋友圈等短内容。
---

# wechat-writer · 公众号长文写作（客户身份真源 · 多风格系统）

> **身份安全边界**
> 这是一个面向不同客户的中立写作能力，不自带任何作者姓名、账号、履历、公司、一手经历或固定署名。

你正在为当前客户写一篇公众号长文。作者身份只能来自当前项目已确认的创作名片和本次 run 授权素材；两者都没有提供的信息必须保持空白或标记「待用户确认」。

执行写作前必须按以下顺序解析真源：

1. 当前用户在本次任务中的明确指令。
2. `brain/creative-library/profile.json` 中 `initialized: true` 的创作名片，以及 `brain/creative-library/rules.json` 中已启用的创作规则。
3. 当前 `run_id + slug` 的已授权素材、已确认 blueprint 和风险边界。
4. 由该客户自己的已发布内容、经人工确认后沉淀的 twin 风格记忆。twin 只能调整表达，不能新增或改写身份事实。

真源冲突时停止代入冲突字段，将质检结论标为 `review`，由用户确认。创作名片未初始化时，不得回退到任何预置人物。

## 使用说明

本 skill 的第一性原则：只读取公众号 lane 已通过立项且人工确认的独立蓝图，写成 3000-4000 字公众号原生长文。不要跳过 `content-blueprint`，也不得把公众号文章当作其他平台的改写源。

本 skill 由六个文件组成，执行写作任务前请按顺序读取：

1. [`core-rules.md`](core-rules.md) —— 核心价值观、用户定制约束、输入输出约定、AI 角色边界、文章原型、结构模板、四层自检体系
2. [`style-adaptive.md`](style-adaptive.md) —— 身份中立的自适应文风、证据与署名边界
3. [`references/style-matrix.md`](references/style-matrix.md) —— 可选择的多风格矩阵与自动推荐规则
4. [`references/longform-production.md`](references/longform-production.md) —— 公众号长文三段式生产法：写作任务卡、证据台账、文章骨架
5. [`references/motherpiece-template.md`](references/motherpiece-template.md) —— 公众号思想母版模板、标题两阶段、排版交接卡和 `AIFIOS-WRITE-CHECK`
6. [`examples.md`](examples.md) —— 输入/输出示例

## 输入输出约定

- 读取上游：`python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py --project ~/ai-content-system read --step blueprint --latest --slug {slug}`
- 写入成稿：`write --step write --slug {slug} --content @wechat-article.md --source "blueprint:{blueprint文件路径}"`
- 校验成稿：`validate --step write --file {write文件路径}`

`wechat-writer` 不是“把素材扩写成长文”，而是把公众号 lane 已经通过立项、吸收本平台公开样本且人工确认的蓝图，转成风格决策、传播心理兑现方案、写作任务卡、证据台账、文章骨架、标题方案和排版交接卡，再写成一篇有真实证据、有判断链、有风险边界、有商业收口的公众号信任资产。

风格选择规则：

- 用户明确指定风格时优先采用，但不得突破事实、授权和平台风险边界。
- 用户未指定风格时，必须按 `references/style-matrix.md` 自动推荐风格，并在写作任务卡中记录推荐理由。
- 可用 `python3 skills/wechat-writer/scripts/style_recommender.py --file {blueprint文件路径}` 生成第一版风格推荐；脚本输出只作为稳定路由，最终仍要按事实边界人工判断。
- 风格不是语气皮肤，而是决定证据优先级、结构节奏、读者关系和商业收口方式。
- 最终成稿的隐藏自检块必须包含 `推荐风格 - ...`。

如果没有 `content-blueprint` 输出，或 blueprint 不包含 `爆款拆解吸收`、核心判断、目标读者、证据链、章节任务、评论区互动预埋、风险边界和人工确认，不要直接写正文。先提示补齐 `/content-blueprint`。`爆款拆解吸收` 必须来自公开对标样本或 `content-hit-collector` 报告，不能在成稿阶段临时脑补。

`content-runtime` 的 `content_pipeline.py next/flow` 会在推荐本 skill 前自动执行 validate 和 blueprint 闸门。闸门阻断时，不要绕过它直接写稿；必须先回到 `content-validate` 或 `content-blueprint` 补齐决策、证据、风险边界和人工确认。闸门为 `review_required` 时可以继续写，但成稿隐藏块的 `质检结论` 应写 `review`，并在正文中保守处理缺失素材。

## 与其他 skill 的关系

- 上游：`content-blueprint`
- 下游：`content-package`、`content-visual`、`content-prelaunch`、`content-audit`
- 依赖：`content-runtime` 进行状态读写

## 参考资料

- 历史个人风格样本未随公开源代码分发。用户需要特定文风时，由用户提供其有权使用的参考素材；仅提取表达方法，不继承样本中的姓名、履历、公司、经历或署名。
- 完整的内容方法论，参考 `references/content_methodology.md`。

## 输入/输出示例

### 示例 1：blueprint → 公众号思想母版

**输入**
content-blueprint 思想母版蓝图（通过立项且人工确认）。

**预期输出**
公众号思想母版 markdown，带 frontmatter（step: write, slug, source），3000-4000 字，开头从读者处境切入，中间用证据链支撑核心判断，结尾完成商业收口，并保留 `AIFIOS-WRITE-CHECK` 隐藏自检块。

成稿正文末尾必须包含一个隐藏交付自检块，供 runtime、audit、prelaunch 追溯，不作为公众号可见正文：

```markdown
<!-- AIFIOS-WRITE-CHECK
上游 brief - pipeline/blueprint/...
身份真源 - 创作名片：未初始化 / brain/creative-library/profile.json@v{n}；当前 run 素材：...；署名：不署名 / 已确认
选题立项结论 - ...
母稿字数 - 3200-3800（兼容字段名），最终以正文有效中文内容估算；低于 3000 或高于 4000 必须重写
标题决策来源 - blueprint 标题假设：工作标题《AI 编程之后，创始人真正要学会的是审稿》；package 标题候选：主标题《Codex 像一个超人实习生》
推荐风格 - 用户指定：无；系统推荐：business-insight（置信度：中）；最终采用：business-insight；理由：...
写作任务卡 - ...
证据台账 - ...
文章骨架 - ...
必用证据 - ...
传播心理兑现 - 沉默解除：...；满足动机：...；有效立场：...；传播入口：...；信念结构：...；受众情绪底层：...；受众还想听什么：...
风险边界 - ...
商业收口 - ...
排版交接卡 - 封面字：AI 编程不是少写代码；摘要：一次 Codex 工作流实测后，我发现真正变贵的是人的审查能力；重点卡片：人工把关三层；引用：工具提效不等于责任消失；配图建议：工作流截图脱敏示意；CTA：留言你的工具使用场景；评论区首问：你现在最担心 AI 编程哪一步失控？
发布前待检查项 - ...
质检结论 - pass/review
-->
```

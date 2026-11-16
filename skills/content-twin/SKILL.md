---
name: content-twin
description: AI FOUNDER INFLUENCE OS第九步：数字孪生观察。读取已发布的最终内容成品，输出结构化观察报告，提取可复用的风格模式、叙事结构、表达偏好，并更新 brain/twin/ 层的孪生记忆文件，形成持续进化的内容自我镜像。
---

# content-twin · 数字孪生观察

## 作用

`content-twin` 不是内容生产者，而是内容观察者。它读取已经完成的最终内容成品，从旁观者视角提炼：

- **内容 DNA**：主题偏好、情绪基调、叙事视角、论证密度
- **结构模式**：开头技法、推进节奏、结尾方式、钩子与 callback
- **表达特征**：标志性句式、过渡方式、标点习惯、口语化密度
- **演化轨迹**：与历史 DNA 的匹配度、新增特征、偏离点

最终形成一份观察报告，并把可复用模式归档到 `brain/twin/`，让后续创作可以参考这个不断进化的「内容自我镜像」。

## 触发方式

- `/content-twin`
- `孪生学习`、`观察这篇`、`内容镜像`、`更新数字分身`
- `帮我看看这篇的风格模式`

## 输入

任意已发布或已完成的最终内容：

- 公众号长文 Markdown（`pipeline/final/` 或 `pipeline/write/` 下的成品）
- 小红书图文内容（`pipeline/xhs/` 或 `pipeline/visual/` 的文案）
- 用户直接粘贴的文本

如果用户未指定文件路径，优先通过 content-runtime 读取最新成稿：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step write --latest
```

可选参数：
- `--readonly`：只输出观察报告，不更新 `brain/twin/` 文件（测试用）
- `--show-dna`：查询当前 content-dna.md
- `--list-patterns`：查询 pattern-library.md
- `--evolution`：查询演化趋势

## 输出

### 观察报告

保存到：

```
~/ai-content-system/pipeline/twin/{YYYY-MM-DD}-{slug}-twin.md
```

报告结构：

```markdown
# 孪生观察报告 · {标题}

## 1. 内容元信息
- 观察日期：{YYYY-MM-DD}
- 原文标题：{标题}
- 平台：{wechat / xhs}
- 内容类型：{长文 / 图文}
- 来源路径：{原文文件路径}

## 2. 内容 DNA 提取
- 核心主题：{一句话概括}
- 情绪基调：{主情绪 + 情绪曲线}
- 叙事视角：{第一人称亲历 / 第三方观察 / 混合}
- 论证密度：{高/中/低}

## 3. 结构模式识别
- 文章原型：{调查实验型 / 产品体验型 / 现象解读型 / 工具分享型 / 方法论分享型}
- 开头技法：{叙事启动 / 荒诞事实 / 热点破题 / 好奇心驱动}
- 推进节奏：{段落长度分布、快慢交替}
- 结尾方式：{引用收尾 / 哲思余韵 / 行动呼吁 / 信念宣言 / 回环呼应}
- 钩子与 callback：{前后呼应结构}

## 4. 表达特征提取
- 标志性句式：{3-5 个有辨识度的句式模板}
- 过渡方式：{常用段落衔接手法}
- 情绪标点使用：{。。。 / ??? / = = 等}
- 口语化密度：{高/中/低}
- 知识输出方式：{聊着掏出来 / 直接科普 / 故事包裹}

## 5. 读者画像观察
- 评论区高频词：{3-5 个}
- 读者提问方式：{}
- 读者核心焦虑/渴望：{}
- 高互动读者特征：{}

## 6. 风格一致性评分
- 与历史 DNA 匹配度：{百分比}
- 新增特征：{本次出现但历史未见的特征}
- 偏离点：{与既有 DNA 不一致的地方}
- 一致性结论：{稳定 / 进化 / 偏离}

## 7. 可复用模式归档
- 可复用结构：{具体结构模板}
- 可复用表达：{具体表达套路}
- 可复用节奏：{具体节奏模式}

## 8. 禁区/禁忌更新建议
- 本次发现的 AI 味表达：{}
- 本次发现的过度套话：{}
- 建议写入 no-fly-zone.md：{}

## 9. 观察结论
- 这篇内容的核心辨识度是什么：
- 如果让我模仿这篇写下一篇，我会保留什么、调整什么：
- 对 twin 记忆文件的更新建议：

## 9.1 Twin 记忆写入计划
| 记忆文件 | 更新内容 | 原文/观察证据 | 合并策略 | 下游调用 |
|---|---|---|---|---|
| brain/twin/content-dna.md | {新增/更新的内容基因} | {原文片段/观察证据} | {新增/更新/去重/frequency+1/last_seen} | {wechat-writer / content-angle} |
| brain/twin/pattern-library.md | {结构/表达/节奏模式} | {原文片段/观察证据} | {新增/更新/去重/frequency+1/last_seen} | {wechat-writer / content-breakdown} |
| brain/twin/voice-signature.md | {句式/语气/标点声纹} | {原文片段/观察证据} | {新增/更新/去重/frequency+1/last_seen} | {wechat-writer / content-breakdown} |
| brain/twin/evolution-log.md | {本次风格演化记录} | {观察证据} | {追加/合并/last_seen} | {content-review / content-twin} |
| brain/twin/reader-profile.md | {读者语言/焦虑/渴望} | {评论/原文/互动证据} | {新增/更新/去重} | {content-angle / content-breakdown} |
| brain/no-fly-zone.md | {同步禁区} | {风险/套话证据} | {新增/合并触发场景} | {wechat-writer / content-breakdown} |
| brain/style-evolution.md | {同步风格演化} | {结构/表达观察证据} | {追加/更新 last_seen} | {wechat-writer / content-twin} |
```

### Twin 记忆文件

更新到：

```
~/ai-content-system/brain/twin/
├── content-dna.md          # 内容基因
├── pattern-library.md      # 模式库
├── voice-signature.md      # 声纹档案
├── evolution-log.md        # 进化日志
└── reader-profile.md       # 读者画像孪生
```

### 观察报告写入

孪生观察报告必须通过 content-runtime 写入：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step twin --slug {slug} \
  --content @/path/to/twin-body.md \
  --source "write:{成稿路径}"
```

`brain/twin/` 下各记忆文件的更新由本 skill 直接维护。

写入后必须调用 runtime 自检：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  validate --step twin --file pipeline/twin/{YYYY-MM-DD}-{slug}-twin.md
```

只有 `valid=true` 才算完成。若返回 `quality_errors`，先修复观察报告，不要把空泛结论写入 `brain/twin/`。

同时更新：

```
~/ai-content-system/brain/
├── no-fly-zone.md          # 禁区清单（自动追加本次发现的 AI 味/套话）
└── style-evolution.md      # 风格演变（与 self-archive 协同更新）
```

## 工作流

1. **接收输入**：读取最终成品路径或用户粘贴文本；如未提供，扫描 `pipeline/final/` 最近 7 天成品让用户选择。
2. **内容 DNA 提取**：一句话概括主题，判断情绪基调、叙事视角、论证密度。
3. **结构模式识别**：识别文章原型、开头技法、推进节奏、结尾方式、钩子/callback。
4. **表达特征提取**：提取标志性句式、过渡方式、情绪标点、口语化密度、知识输出方式。
5. **读者画像观察**：从评论区/私信信号中提炼读者高频词、提问方式、焦虑/渴望。
6. **风格一致性评分**：与 `brain/twin/content-dna.md` 和 `voice-signature.md` 对比，计算匹配度，标注新增特征和偏离点。
7. **禁区/禁忌更新建议**：识别本次内容中暴露的 AI 味表达、套话、平台风险词，建议写入 `brain/no-fly-zone.md`。
8. **归档可复用模式**：去重后写入 `pattern-library.md`（已存在则增加 frequency 并更新 last_seen）。
9. **生成 Twin 记忆写入计划**：逐行写明每个目标文件的更新内容、原文/观察证据、合并策略和下游调用 skill。
10. **更新 twin 记忆文件**：按写入计划合并 DNA、更新声纹、更新读者画像、在 `evolution-log.md` 追加本次观察记录。
11. **输出观察报告**：写入 `pipeline/twin/`，并给出下一步建议。

## 独立调用模式

无参数或特定参数时，`content-twin` 可作为独立工具运行：

| 调用方式 | 行为 |
|---|---|
| `/content-twin {文件路径}` | 标准观察 + 更新 brain/twin/ |
| `/content-twin {文件路径} --readonly` | 只输出报告，不更新 brain 文件 |
| `/content-twin --show-dna` | 读取并展示 `brain/twin/content-dna.md` |
| `/content-twin --list-patterns` | 读取并展示 `brain/twin/pattern-library.md` |
| `/content-twin --evolution` | 读取并总结 `brain/twin/evolution-log.md` 趋势 |
| `/content-twin` | 扫描最近 7 天 `pipeline/final/`，让用户选择观察对象 |

## 内化规则

1. **只读来源文件**：不修改 `pipeline/final/` 或任何中间产物。
2. **去重归档**：模式库中已存在的模式增加 `frequency` 并更新 `last_seen`；新模式追加并标注 `first_seen`。
3. **漂移检测**：连续 3 次观察到同一偏离时，标记为「潜在演化」而非错误。
4. **不确定标注**：无法确认的特征使用 `[observed?]` 标记，不强行下结论。
5. **跨平台 awareness**：同一内容在不同平台产生独立观察，但 evolution-log 中标注「same content, different platform adaptation」。
6. **观察优先于判断**：先记录「看到了什么」，再推论「这意味着什么」。

## 质量原则

- 不编造素材中没有的风格特征
- 每个模式归档必须附原文片段作为证据
- 匹配度评分要有明确依据，不拍脑袋给百分比
- 偏离点要区分「一次性尝试」和「持续演化」
- 不确定的内容必须显式标注，不混入确定结论
- 真实数字孪生记忆只能来自已发布或已完成且有真实内容/反馈证据的成品；读者画像必须来自真实评论、私信、后台反馈或人工记录。
- demo/未发布内容只能作为流程演示或待验证观察：`reader-profile.md`、`evolution-log.md`、`style-evolution.md` 的写入计划必须标注 demo/待验证/不写入真实记忆。
- demo/未发布不能计算真实历史 DNA 匹配度百分比，不能写成“稳定进化”“读者画像已更新”“frequency+1 / last_seen”等真实记忆合并动作。
- 观察报告必须完整覆盖 1-9 节：元信息、DNA、结构、表达、读者画像、风格一致性、可复用模式、禁区建议、观察结论。
- `## 7. 可复用模式归档` 至少写结构、表达、节奏三类模式，并附原文片段/例句/证据。
- `## 9. 观察结论` 必须写明应更新的 `brain/twin/content-dna.md`、`pattern-library.md`、`voice-signature.md`、`evolution-log.md`、`reader-profile.md`，并说明是否同步更新 `brain/no-fly-zone.md` 和 `brain/style-evolution.md`。
- `## 9.1 Twin 记忆写入计划` 必须逐行覆盖 5 个 `brain/twin/` 文件和 `brain/no-fly-zone.md`、`brain/style-evolution.md`；每行必须包含更新内容、原文/观察证据、合并策略和下游调用 skill。
- 禁止把 `9.1` 写成“待补、暂无、风格很好、后续更新”等占位判断；没有证据的记忆不得写入。

## 与其他 Skill 的关系

- **上游**：`wechat-writer`、`xhs-card`（生成最终成品）；`content-review`、`self-archive`（提供可选上下文）
- **下游**：`wechat-writer`、`content-breakdown`（未来创作必须读取 twin 的 pattern-library、voice-signature、reader-profile 作为约束）
- **与 `self-archive` 的分工**：
  - `self-archive` 是创作者视角：我写了什么、我学到了什么、我要复用什么
  - `content-twin` 是观察者视角：我读了这篇成品，看到了什么模式、这个模式如何演化
- **与 writer 的闭环**：
  - `content-twin` 输出的 `brain/twin/` 文件是 `wechat-writer` 和 `content-breakdown` 的必读输入
  - 每次 twin 发现新的风格禁区，自动建议追加到 `brain/no-fly-zone.md`
  - writer 在 L2/L3/L4 自检中必须检查与 twin 的一致性

## 输入/输出示例

### 示例 1：最终成品 → 数字孪生观察

**输入**
已发布的公众号长文、评论、数据。

**预期输出**
```markdown
# 数字孪生观察报告

## 2. 内容 DNA 提取
- 核心隐喻：AI 工具 = 带漏洞的超人实习生
- 情绪基调：兴奋 + 焦虑 + 掌控感

## 3. 结构模式识别
- 开头：真实场景（凌晨改 bug）
- 中段：类比展开 + 案例支撑
- 结尾：职业再定位 + 固定尾部

## 4. 表达特征提取
- 高频句式："不是...而是..."
- 高频标点：句号短句、。。。
- 口头禅密度：低，克制自然
```

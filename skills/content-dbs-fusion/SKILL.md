---
name: content-dbs-fusion
description: AI FOUNDER INFLUENCE OS 与 dbskill 的融合桥接。统一入口处理选题诊断、爆款标题、商业表达、关键决策、跨会话状态、诊断报告打包等需求。
---

# content-dbs-fusion · OS 与 dbskill 融合桥接

## 作用

`content-dbs-fusion` 是 AI FOUNDER INFLUENCE OS 和 dbskill 之间的融合层。

用户不需要分别记住 `/dbs-diagnosis`、`/dbs-xhs-title`、`/dbs-spread`、`/dbs-resonate`、`/dbs-wechat-html` 等命令，只需要说「诊断这个选题」「帮我起小红书标题」「这个商业表达对不对」「做公众号排版」，由本 skill 判断调用哪个 dbs skill，并把结果转成可追溯、可写回、可被下游使用的 OS 资产。

第一性原则：外部诊断只有写清楚 **调用来源、证据、结论、写回位置、下游动作**，才算进入 AIFIOS。否则只把它作为对话建议，不写入 pipeline。

## 触发方式

- `/content-dbs`
- `/dbs融合`、`诊断这个选题`、`帮我起标题`、`商业表达诊断`
- 「传播心理解码」「共鸣诊断」「公众号 HTML」「微信排版」

## 执行协议

1. 先确定 `PROJECT`，默认 `~/ai-content-system`。
2. 用 `content-runtime read/state/run` 找到当前 slug 和上游产物。
3. 根据任务选择最少必要 dbskill，不做无关串联。
4. 把 dbskill 输出整理成 `dbs-fusion` 融合报告。
5. 写入 runtime：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step dbs-fusion --slug {slug} \
  --content @dbs-fusion.md --source "content-dbs-fusion:{mode}"
```

6. 写入后必须校验：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  validate --step dbs-fusion --file pipeline/dbs-fusion/{file}.md
```

如果 `valid=false`，先返修融合报告，不要继续推进下游。

7. 校验通过后，可半自动写回下游：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/dbs_fusion_apply.py \
  --project ~/ai-content-system \
  --file pipeline/dbs-fusion/{file}.md
```

先预览不写入：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/dbs_fusion_apply.py \
  --project ~/ai-content-system \
  --file pipeline/dbs-fusion/{file}.md --dry-run
```

`apply` 不覆盖旧产物，会读取写回目标对应步骤的最新文件，生成一个新版本，并把来源标记为 `dbs-fusion-apply:{file}`。当前支持写回 `pipeline/`、`brain/`、`sessions/`；无法识别的目标会阻断并写出报告到 `quality/dbs-fusion-applies/`。

如果融合报告已经通过校验但还没有执行写回，`content-pipeline next/flow` 和 `session_manager work/cockpit` 会在进入写作、视觉、发布前检查、审核或发布前主动提示 `dbs-fusion-apply`。这条提醒用于防止下游绕过 `/dbs-spread`、`/dbs-resonate`、`/dbs-wechat-html` 等外部诊断结果；写回成功后提醒会自动消失。

重要约束：融合报告本身不能自称“已写回 / applied / done / pass”。融合报告只负责声明诊断结论与写回计划，完成状态必须来自 `dbs-fusion-apply` 执行报告和目标资产里的 `dbs-fusion apply` 写回标记。否则 runtime validate 会阻断，pipeline 也不会继续进入下游生产。

## 工作模式

### 模式 1：选题诊断

用户说「这个选题值不值得做」「我的商业模式能不能跑通」「这个内容能不能获客」。

路由流程：

```
/content-dbs 选题诊断 {素材/intake报告}
  ↓
1. /dbs-goal（如果目标空转）
  ↓
2. /dbs-diagnosis /问诊 或 /体检（判断商业成立性）
  ↓
3. /dbs-benchmark（找对标验证）
  ↓
4. /dbs-content（内容形式匹配 + 五维诊断）
  ↓
输出：带商业判断的选题诊断报告，写入 pipeline/validate/
```

### 模式 2：爆款标题

用户说「帮我起小红书标题」「这个标题怎么改」「公众号标题怎么写」。

路由流程：

```
/content-dbs 标题 {话题/行业/已有标题}
  ↓
如果是小红书 → /dbs-xhs-title
如果是公众号标题 → 用 dbs-content 的标题诊断原则 + wechat-writer 约束
  ↓
输出：带公式编号、原始爆款参照、心理触发器说明的标题方案
```

### 模式 3：商业表达诊断

用户说「这篇稿子能不能获客」「为什么转化不好」「商业表达够不够硬」。

路由流程：

```
/content-dbs 商业表达 {成稿}
  ↓
1. /dbs-content 五维诊断
2. /dbs-ai-check（AI 味检测）
3. /dbs-good-question（把"为什么没转化"写成可验证问题）
4. /dbs-deconstruct（拆清楚模糊概念）
  ↓
输出：商业表达诊断报告 + 修改建议
```

### 模式 4：关键决策记录

用户说「我决定做这个」「我在 A 和 B 之间选哪个」「帮我跟踪这个决策」。

路由到 `/dbs-decision`，并把决策摘要同步到 `brain/decisions.md`。

### 模式 5：跨会话续上

用户说「接着上次」「上次诊断到哪了」「把这次结论存下来」。

- 存档：`/dbs-save`
- 续上：`/dbs-restore`
- 打包报告：`/dbs-report`

### 模式 6：传播心理解码

用户说「这个内容为什么能火」「受众想听什么」「打中了什么情绪」。

路由到 `/dbs-spread`，并把沉默解除、满足动机、立场框架、传播入口、信念结构、受众情绪底层、受众还想听什么写回 `pipeline/breakdown/` 的 `## 传播心理假设`。

### 模式 7：成稿共鸣诊断

用户说「这个文稿有没有戳中人」「能不能发」「发布前看看共鸣」。

路由到 `/dbs-resonate`，并把共鸣判断、没打中的原因、返修动作写回 `pipeline/prelaunch/` 的 `## 5. 共鸣诊断`。

### 模式 8：公众号排版

用户说「生成公众号 HTML」「做微信排版」「做公众号版本」。

路由到 `/dbs-wechat-html`，并把 HTML 样式、源文件、输出目录、预览检查写回 `pipeline/visual/` 的交付 Manifest。

## 输出

根据模式输出到不同位置：

| 模式 | 输出路径 |
|---|---|
| 所有模式 | `~/ai-content-system/pipeline/dbs-fusion/{日期}-{slug}-dbs-fusion.md` |
| 选题诊断 | 结论再写回 `pipeline/validate/` |
| 爆款标题 | 标题方案再写回 `pipeline/breakdown/` |
| 商业表达诊断 | 返修建议再写回 `pipeline/audit/` 或 `pipeline/prelaunch/` |
| 传播心理解码 | 写回 `pipeline/breakdown/` |
| 成稿共鸣诊断 | 写回 `pipeline/prelaunch/` |
| 公众号排版 | 写回 `pipeline/visual/` |
| 关键决策 | `~/ai-content-system/brain/decisions.md` + `~/ai-content-system/sessions/` |
| 跨会话状态 | `~/ai-content-system/sessions/{project}.md` |

## 融合报告契约

每次写入 `dbs-fusion` 必须包含：

```markdown
# DBS 融合报告 · {主题}

## 0. 融合任务
- 模式：传播心理解码 / 共鸣诊断 / 公众号排版 / 选题诊断 / 爆款标题 / 商业表达诊断 / 关键决策
- 触发问题：用户原始问题
- 上游输入：pipeline/... 或用户素材
- 目标写回：pipeline/breakdown/...、pipeline/prelaunch/...、pipeline/visual/...、brain/... 或 sessions/...

## 1. 调用链
| skill | 目的 | 输入证据 | 输出摘要 | 状态 |
|---|---|---|---|---|
| /dbs-spread | 解码传播心理 | 对标样本/话题片段 | 沉默解除、满足动机、立场框架 | pass |

## 2. 关键结论
- 结论：一句能指导下游生产的判断。
- 置信度：高/中/低。
- 依据：来自哪些素材、样本或诊断项。

## 3. 证据与风险
| 类型 | 证据/来源 | 风险 | 处理方式 |
|---|---|---|---|
| 素材 | pipeline/intake/... | 客户信息不可公开 | 匿名化 |

## 4. 写回计划
| 写回位置 | 写回内容 | 下游调用 | 状态 |
|---|---|---|---|
| pipeline/breakdown/... `## 传播心理假设` | 传播心理七维 | content-breakdown / wechat-writer | 待写回 |

## 5. 下一步动作
- 执行 `/content-breakdown` / `/content-write` / `/content-prelaunch` 等明确动作。

## 6. 人工复核
- 需要复核的事实、授权、商业判断或平台风险。
```

## 与其他 Skill 的关系

- **上游**：所有 OS skill
- **可调用**：`dbs-goal`、`dbs-diagnosis`、`dbs-benchmark`、`dbs-content`、`dbs-xhs-title`、`dbs-ai-check`、`dbs-good-question`、`dbs-deconstruct`、`dbs-decision`、`dbs-save`、`dbs-restore`、`dbs-report`、`dbs-spread`、`dbs-resonate`、`dbs-wechat-html`
- **写入**：`pipeline/dbs-fusion/`、`pipeline/validate/`、`pipeline/breakdown/`、`pipeline/prelaunch/`、`pipeline/visual/`、`brain/decisions.md`、`brain/market/benchmark.md`、`brain/no-fly-zone.md`、`sessions/`

## 质量原则

- 不替代 dbskill 的具体判断，只做路由和结果整合
- 每次调用 dbs skill 后，先生成 `dbs-fusion` 融合报告
- 每条融合报告必须通过 runtime validate
- 只有通过 validate 的融合报告可以执行 `dbs_fusion_apply.py`
- 写回计划的状态只能写 `待写回`、`需要人工`、`review` 或 `blocked`；不能写 `已写回`、`applied`、`done`、`pass`
- 写回是否完成只以 `quality/dbs-fusion-applies/` 执行报告和目标资产写回标记为准
- 只保留必要调用链，避免为了显得完整而堆叠 skill
- 给用户明确的下一步：是回到 OS 生产流程，还是继续 dbs 诊断

## 语言

- 用户用中文就用中文回复，用英文就用英文回复
- 中文回复遵循《中文文案排版指北》

## 输入/输出示例

### 示例 1：商业问题 → 融合诊断

**输入**
"我想做个人 IP，但不知道能不能变现。"

**预期输出**
- 调用 `dbs-goal` 把"个人 IP"审计为可检查交付物
- 调用 `dbs-diagnosis` 判断商业模式成立性
- 如果通过，再进入 content 流水线生产内容

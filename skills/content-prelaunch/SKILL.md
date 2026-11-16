---
name: content-prelaunch
description: AI FOUNDER INFLUENCE OS 发布前统一检查。在 content-audit 之前，对成稿进行事实、风格、平台规则、商业闭环、文稿共鸣的一站式检查，输出发布前检查清单。成稿不确定是否戳中受众时接入 dbs-resonate。
---

# content-prelaunch · 发布前统一检查

## 作用

`content-prelaunch` 是发布前的「一站式检查台」。在 `content-audit` 之前，先把常见错误和遗漏过一遍，减少反复审核的次数。

它不负责深度事实核查（那是 `content-audit` 的工作），也不负责平台合规扫描（那是 `content-compliance` 的工作）。它负责的是：**在发布前把该看的都看一遍，给出清晰的通过/待修复清单。**

新增传播心理闸门：发布前必须做一次成稿共鸣诊断。优先调用 `/dbs-resonate`，检查核心机制、沉默解除、满足动机、立场框架、传播入口、信念结构和具体删改方向。它不预测流量，只判断文稿有没有打中人。

新增发布资产闸门：发布前必须核对正文、视觉资产/封面、公众号 HTML 排版、质量验收报告、合规报告和交付包。只要关键资产未生成、未复核或未打包，不能写“可以发布”，最多写“可进入 audit 但发布前需补齐资产”。

## 触发方式

- `/content-prelaunch`
- `/发布前检查`、`发布 checklist`、`检查一下能不能发`

## 输入

如果用户未指定发布资产包或蓝图路径，优先通过 content-runtime 读取最新 package、blueprint 和公众号母稿：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step package --latest --slug {slug}

python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step blueprint --latest --slug {slug}

python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step write --latest --slug {slug}
```

第一性原理约束：发布前检查只能检查当前 run 的最新成稿。若当前任务卡给出 `draftPath`，必须以该项目相对路径为唯一检查对象，并在 `## 0. 检查对象`、`## 5.2 发布资产准备度检查` 和 `## 7. 综合判断` 的下一步命令中原样写入。不得把路径改成绝对路径、旧文件路径、占位路径或其它 run 的路径。

如果是 legacy 旧链路，才读取最新 breakdown 做兼容核对：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step breakdown --latest --slug {slug}
```

- 成稿文件路径（优先 `pipeline/final/` 下的公众号思想母版；小红书使用 `pipeline/xhs/`）
- 优先：`content-package` 输出文件路径（用于核对标题、封面、图文资产和评论区互动钩子是否就绪）
- 优先：`content-blueprint` 输出文件路径（用于核对立项、核心判断、证据链和风险边界）
- Legacy optional：`content-breakdown` 输出文件路径（仅用于旧链路兼容）
- 可选：目标平台（wechat / xhs），默认根据文件路径判断

## 输出

保存到：

```
~/ai-content-system/pipeline/prelaunch/{YYYY-MM-DD}-{slug}-prelaunch.md
```

**必须通过 content-runtime 写入**：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step prelaunch --slug {slug} \
  --content @/path/to/prelaunch-body.md \
  --source "package:{package文件路径}"
```

输出结构：

```markdown
# 发布前检查清单 · {标题}

## 0. 检查对象
- 成稿路径：{...}
- 目标平台：{wechat / xhs}
- 内容类型：{长文 / 图文}

## 1. 事实层检查
| 检查项 | 状态 | 说明 |
|---|---|---|
| 数据可溯源 | ✅/⚠️/❌ | ... |
| 案例有来源 | ✅/⚠️/❌ | ... |
| 无假设性例子 | ✅/⚠️/❌ | ... |
| 无夸大表述 | ✅/⚠️/❌ | ... |

## 2. 风格层检查
| 检查项 | 状态 | 说明 |
|---|---|---|
| 无 AI 味高频词 | ✅/⚠️/❌ | ... |
| 无禁用标点 | ✅/⚠️/❌ | ... |
| 符合 twin 声纹 | ✅/⚠️/❌ | ... |
| 口语化密度适中 | ✅/⚠️/❌ | ... |

## 3. 平台规则层检查
| 检查项 | 状态 | 说明 |
|---|---|---|
| 标题/封面合规 | ✅/⚠️/❌ | ... |
| 引流路径清晰且不违规 | ✅/⚠️/❌ | ... |
| 无绝对化用语 | ✅/⚠️/❌ | ... |
| 图文格式符合平台习惯 | ✅/⚠️/❌ | ... |

## 4. 商业闭环检查
| 检查项 | 状态 | 说明 |
|---|---|---|
| 内容指向明确产品/服务 | ✅/⚠️/❌ | ... |
| 转化路径不断 | ✅/⚠️/❌ | ... |
| CTA（如有）自然不突兀 | ✅/⚠️/❌ | ... |
| 价值讲透，执行留白 | ✅/⚠️/❌ | ... |

## 5. 共鸣诊断
- 来源：`/dbs-resonate`
- 核心机制：...
- 沉默解除：...
- 满足动机：...
- 立场框架：...
- 传播入口：...
- 信念结构：...
- 具体改法：删掉...；缩短为支撑细节...；强化...；保持不动...；改完之后...

## 5.1 与 package / blueprint 方案一致性检查
| 检查项 | 状态 | 说明 |
|---|---|---|
| 标题与封面候选是否来自 package | ✅/⚠️/❌ | ... |
| 公众号母稿是否兑现 blueprint 核心判断 | ✅/⚠️/❌ | ... |
| 公众号与小红书发布资产是否齐备 | ✅/⚠️/❌ | ... |
| 评论区互动钩子是否可执行且合规 | ✅/⚠️/❌ | ... |

## 5.2 发布资产准备度检查
| 资产 | 状态 | 路径/报告 | 说明 |
|---|---|---|---|
| 成稿正文 | ✅/⚠️/❌ | pipeline/final/... | ... |
| 视觉资产/封面 | ✅/⚠️/❌ | pipeline/visual/{slug}/ | ... |
| HTML 排版 | ✅/⚠️/❌ | pipeline/visual/{slug}/公众号HTML输出/ | ... |
| 质量报告 | ✅/⚠️/❌ | quality/reports/... | ... |
| 合规报告 | ✅/⚠️/❌ | pipeline/compliance/... | ... |
| 交付包 | ✅/⚠️/❌ | deliveries/...zip | ... |

## 6. 待修复清单
- [ ] {问题 1：修复方式}
- [ ] {问题 2：修复方式}
- [ ] {问题 3：修复方式}

## 7. 综合判断
- **是否可以通过 content-audit**：{是 / 否，先修复再进入 audit}
- **风险等级**：{低 / 中 / 高}
- **下一步**：{/content-audit {成稿路径}}
```

写入后必须运行 runtime 校验：

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  validate --step prelaunch --file pipeline/prelaunch/{文件名}.md
```

`validate` 会额外执行发布前质量审计，返回 `quality_status`、`quality_errors`、`quality_reviews` 和 `quality_checks`。

### 发布前质量闸门

`content-prelaunch` 的清单不能只写“已检查”，必须能被机器和人工共同复核：

- `## 0. 检查对象` 必须写明成稿路径、目标平台、内容类型。
- 事实层、风格层、平台规则层、商业闭环层，每层至少 3 个检查项，并且每项有明确状态。
- 状态建议使用 `✅ / ⚠️ / ❌`，或 `PASS / review / blocked`。
- `## 5. 共鸣诊断` 必须包含 `/dbs-resonate` 的核心机制、五维共鸣诊断和具体改法；如果诊断发现“核心不明确/核心被稀释/立场漂移/沉默解除弱”，待修复清单必须保留未完成项。
- `## 5.2 发布资产准备度检查` 必须检查成稿正文、视觉资产/封面、HTML 排版、质量报告、合规报告和交付包；任一关键资产为 ❌、missing、未生成、未打包，则综合判断不能写“可以发布”。
- 发布资产准备度的 `✅ / PASS` 只能用于已经生成或已完成的具体文件、报告或交付包路径；如果只是 `quality/reports/`、`deliveries/` 这类裸目录，或“可生成 / 可打包 / 可复现 / 已列入交付”这类未来动作，必须降级为 `⚠️ / review`，并写清发布前补齐动作。
- 只要出现 `❌`、高风险、不能发、阻断、先修复，综合判断就不能写“可以进入 content-audit”。
- `## 6. 待修复清单` 如有未完成项 `- [ ]`，必须先修复；修复完成后改为 `- [x]` 并说明结果。
- `## 7. 综合判断` 必须写明是否可以进入 `content-audit`、风险等级和下一步命令。

质量状态含义：

| 状态 | 含义 | 后续动作 |
|---|---|---|
| `pass` | 检查对象清楚，四层检查完整，无未完成修复项，结论自洽 | 可进入 `content-audit` |
| `review_required` | 没有阻断项，但存在中风险、待复核或 breakdown 一致性不足 | 可进入 audit，但任务卡和最终交付要标记人工复核 |
| `blocked` | 缺检查对象、四层检查不足、存在高风险/未完成修复项，或结论自相矛盾 | 不进入 audit，先返修成稿或检查清单 |

发布前检查清单通过 content-runtime 写入 `pipeline/prelaunch/` 后，下游 `content-audit` 可直接通过 `read --step prelaunch --latest` 获取检查结果（可选）。

## 工作流程

### Phase 1：读取成稿

读取成稿文件，判断目标平台（`pipeline/xhs/` 为小红书，默认公众号）。

### Phase 2：四层检查

#### 事实层

- 所有数据是否标注来源
- 所有案例是否来自真实素材
- 无「我有一个朋友」「比如有一次」类假设
- 无夸大或无法验证的表述

#### 风格层

- 读取 `brain/no-fly-zone.md` 扫描禁用词/标点
- 读取 `brain/twin/voice-signature.md` 检查风格一致性
- 检查口语化密度是否适中（wechat-writer 要求 4-6 个不同口语词组）
- 检查是否有 AI 味高频词

#### 平台规则层

- 标题/封面是否符合平台规范
- 是否有违规引流话术
- 是否有绝对化用语（最、第一、顶级）
- 格式是否符合平台习惯（公众号段落与引用清晰，小红书封面三行与页卡结构完整）

#### 商业闭环层

- 内容是否指向明确产品/服务
- 转化路径是否清晰
- CTA 是否自然且不诱导违规互动
- 是否做到「价值讲透，执行留白」（针对获客型内容）

### Phase 3：与 package / blueprint 方案一致性检查

先调用或补写 `/dbs-resonate` 共鸣诊断，再核对 package 和 blueprint。

共鸣诊断必须包含：
- 核心机制是否明确
- 沉默解除是否有效
- 满足动机是什么
- 立场框架是否一致
- 传播入口是否清楚
- 信念结构是否能触发行动
- 具体改法：删掉、缩短、强化、保持不动

如果用户提供了 package / blueprint 文件，核对：
- 标题、封面字和 3 秒钩子是否来自 package 候选
- 正文是否兑现 blueprint 的核心判断、证据链和风险边界
- 公众号与小红书发布资产是否齐备
- 每个内容单元是否有评论区维护钩子
- legacy breakdown 的标题/钩子/关键词只作为兼容参考，不覆盖 package 决策

### Phase 4：发布资产准备度检查

核对当前 run 的关键资产：

- 成稿正文：对应平台成稿是否存在且通过本步骤前置检查。
- 视觉资产/封面：是否已有 `content-visual` 计划，且 `pipeline/visual/{slug}/` 下的关键资产或输出路径已明确。
- HTML 排版：公众号必须检查 `dbs-wechat-html` 输出目录；非公众号可标记不适用但说明原因。
- 质量报告：是否已经运行 `quality-check`，或明确发布前必须运行。
- 合规报告：是否已经运行 `content-compliance`，或明确进入合规检查后再发布。
- 交付包：是否已经运行 `delivery-pack`，或明确发布/交付前必须打包。

### Phase 5：输出检查清单

给出待修复清单和综合判断。

## 决策规则

| 条件 | 判断 |
|---|---|
| 四层检查全部通过 | **可以通过 audit** |
| 只有风格层小修（如替换 1-2 个词） | **可以通过 audit，但建议先修** |
| 事实层或商业闭环层有问题 | **不通过，先修复** |
| 平台规则层有高风险（违禁词/引流违规） | **不通过，先修复** |

## 与其他 Skill 的关系

- **上游**：`content-package`、`wechat-writer`、`content-blueprint`
- **下游**：`content-audit`（深度事实/风险审核）、`content-compliance`（平台合规扫描）
- **读取**：`brain/no-fly-zone.md`、`brain/twin/voice-signature.md`

## 质量原则

- 不替代 `content-audit` 的深度事实核查
- 不替代 `content-compliance` 的平台规则扫描
- 给出明确的待修复清单，每个问题都有具体修复方式
- 不确定的问题标为「待 audit 确认」，不强行判断

## 语言

- 用户用中文就用中文回复，用英文就用英文回复
- 中文回复遵循《中文文案排版指北》

## 输入/输出示例

### 示例 1：成稿 → 发布前检查清单

**输入**
公众号长文定稿。

**预期输出**
```markdown
# 发布前检查清单

## 1. 事实层检查
- [ ] Codex 功能描述与官方一致
- [ ] 数据不编造

## 2. 风格层检查
- [ ] 无 AI 口头禅（"说白了"等）
- [ ] 冒号/破折号/双引号已替换

## 3. 平台规则层检查
- [ ] 无违禁词
- [ ] 无诱导分享/私信

## 4. 商业闭环检查
- [ ] 结尾固定尾部保留
- [ ] 星标/转发引导自然
```

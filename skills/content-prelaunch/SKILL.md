---
name: content-prelaunch
description: AI FOUNDER INFLUENCE OS 发布前统一检查。在 content-audit 之前，对成稿进行事实、风格、平台规则、商业闭环的一站式检查，输出发布前检查清单。
---

# content-prelaunch · 发布前统一检查

## 作用

`content-prelaunch` 是发布前的「一站式检查台」。在 `content-audit` 之前，先把常见错误和遗漏过一遍，减少反复审核的次数。

它不负责深度事实核查（那是 `content-audit` 的工作），也不负责平台合规扫描（那是 `content-compliance` 的工作）。它负责的是：**在发布前把该看的都看一遍，给出清晰的通过/待修复清单。**

## 触发方式

- `/content-prelaunch`
- `/发布前检查`、`发布 checklist`、`检查一下能不能发`

## 输入

如果用户未指定成稿文件路径，优先通过 content-runtime 读取最新成稿：

```bash
# 公众号长文
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step write --latest

# 抖音口播稿
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step douyin --latest

# 小红书图文
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step xhs --latest
```

如果未指定 breakdown 文件路径，可通过 content-runtime 读取最新拆解方案：

```bash
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step breakdown --latest
```

 - 成稿文件路径（`pipeline/final/` 下的文件）
- 可选：`content-breakdown` 输出文件路径（用于核对标题/钩子/平台策略是否执行到位）
- 可选：目标平台（wechat / xhs / douyin），默认根据文件后缀或内容判断

## 输出

保存到：

```
~/ai-content-system/pipeline/prelaunch/{YYYY-MM-DD}-{slug}-prelaunch.md
```

**必须通过 content-runtime 写入**：

```bash
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step prelaunch --slug {slug} \
  --content @/path/to/prelaunch-body.md \
  --source "write:{成稿文件路径}"
```

输出结构：

```markdown
# 发布前检查清单 · {标题}

## 0. 检查对象
- 成稿路径：{...}
- 目标平台：{wechat / xhs / douyin}
- 内容类型：{长文 / 口播 / 图文}

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
| 图文/视频格式符合平台习惯 | ✅/⚠️/❌ | ... |

## 4. 商业闭环检查
| 检查项 | 状态 | 说明 |
|---|---|---|
| 内容指向明确产品/服务 | ✅/⚠️/❌ | ... |
| 转化路径不断 | ✅/⚠️/❌ | ... |
| CTA（如有）自然不突兀 | ✅/⚠️/❌ | ... |
| 价值讲透，执行留白 | ✅/⚠️/❌ | ... |

## 5. 与 breakdown 方案一致性检查
| 检查项 | 状态 | 说明 |
|---|---|---|
| 标题是否执行了 breakdown 方案 | ✅/⚠️/❌ | ... |
| 开头钩子是否执行 | ✅/⚠️/❌ | ... |
| 关键词是否覆盖 | ✅/⚠️/❌ | ... |
| 平台适配建议是否落实 | ✅/⚠️/❌ | ... |

## 6. 待修复清单
- [ ] {问题 1：修复方式}
- [ ] {问题 2：修复方式}
- [ ] {问题 3：修复方式}

## 7. 综合判断
- **是否可以通过 content-audit**：{是 / 否，先修复再进入 audit}
- **风险等级**：{低 / 中 / 高}
- **下一步**：{/content-audit {成稿路径}}
```

发布前检查清单通过 content-runtime 写入 `pipeline/prelaunch/` 后，下游 `content-audit` 可直接通过 `read --step prelaunch --latest` 获取检查结果（可选）。

## 工作流程

### Phase 1：读取成稿

读取成稿文件，判断目标平台（根据文件路径后缀 `-koubo.md` 为抖音，在 `visual/` 下为小红书，默认公众号）。

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
- 格式是否符合平台习惯（公众号不加小标题，小红书封面三行，抖音前 3 秒 hook）

#### 商业闭环层

- 内容是否指向明确产品/服务
- 转化路径是否清晰
- CTA 是否自然（抖音获客型口播应无 CTA）
- 是否做到「价值讲透，执行留白」（针对获客型内容）

### Phase 3：与 breakdown 方案一致性检查

如果用户提供了 breakdown 文件，核对：
- 标题是否按方案执行
- 开头钩子是否按方案执行
- 关键词矩阵是否覆盖
- 平台适配建议是否落实

### Phase 4：输出检查清单

给出待修复清单和综合判断。

## 决策规则

| 条件 | 判断 |
|---|---|
| 四层检查全部通过 | **可以通过 audit** |
| 只有风格层小修（如替换 1-2 个词） | **可以通过 audit，但建议先修** |
| 事实层或商业闭环层有问题 | **不通过，先修复** |
| 平台规则层有高风险（违禁词/引流违规） | **不通过，先修复** |

## 与其他 Skill 的关系

- **上游**：`wechat-writer`、`douyin-script`、`xhs-card`
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

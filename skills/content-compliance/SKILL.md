---
name: content-compliance
description: AI FOUNDER INFLUENCE OS 平台合规审核。扫描公众号/小红书/抖音成稿的平台规则风险、违禁词、广告法敏感词、版权风险，输出修改清单。
---

# content-compliance · 平台合规审核

## 作用

`content-compliance` 专门做平台规则扫描。与 `content-audit` 的可信审核分工：

- `content-audit`：事实、来源、隐私、平台风险（内容层面）
- `content-compliance`：平台规则、违禁词、广告法、版权（规则层面）

## 触发方式

- `/content-compliance`
- `/合规检查`、`查违禁词`、`平台规则检查`

## 输入

如果用户未指定成稿文件路径，优先通过 content-runtime 读取最新成稿：

```bash
# 公众号长文
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step write --latest

# 抖音口播稿
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step douyin --latest

# 小红书图文
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system read --step xhs --latest
```

 - 成稿文件路径
- 目标平台（wechat / xhs / douyin），默认根据文件路径判断

## 输出

保存到：

```
~/ai-content-system/pipeline/compliance/{YYYY-MM-DD}-{slug}-compliance.md
```

**必须通过 content-runtime 写入**：

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step compliance --slug {slug} \
  --content @/path/to/compliance-body.md \
  --source "write:{成稿文件路径}"
```

输出结构：

```markdown
# 平台合规报告 · {标题}

## 0. 检查对象
- 成稿路径：{}
- 目标平台：{}
- 内容类型：{}

## 1. 违禁词扫描

| 风险词 | 出现位置 | 风险等级 | 建议替换 |
|---|---|---|---|
| ... | ... | 高/中/低 | ... |

## 2. 广告法敏感词

| 敏感词 | 出现位置 | 问题 | 建议 |
|---|---|---|---|
| 最 | ... | 绝对化用语 | 改为「非常」「相当」 |
| 第一 | ... | 绝对化用语 | 删除或给出证明 |

## 3. 平台规则风险

| 检查项 | 状态 | 说明 |
|---|---|---|
| 引流方式合规 | ✅/⚠️/❌ | ... |
| 封面/标题合规 | ✅/⚠️/❌ | ... |
| 医疗/投资建议标注 | ✅/⚠️/❌ | ... |
| 版权图片/引用 | ✅/⚠️/❌ | ... |
| 政治/社会敏感 | ✅/⚠️/❌ | ... |

## 4. 版权风险

| 检查项 | 状态 | 说明 |
|---|---|---|
| 图片来源可确认 | ✅/⚠️/❌ | ... |
| 引用内容有出处 | ✅/⚠️/❌ | ... |
| 聊天记录/肖像授权 | ✅/⚠️/❌ | ... |

## 5. 修改清单

- [ ] {问题 1：具体修改方式}
- [ ] {问题 2：具体修改方式}
- [ ] {问题 3：具体修改方式}

## 6. 综合判断
- **风险等级**：{低 / 中 / 高}
- **是否可发布**：{是 / 否，先修改}
- **下一步**：{/content-audit {成稿路径}}
```

合规报告通过 content-runtime 写入 `pipeline/compliance/` 后，下游 `content-audit` 可直接通过 `read --step compliance --latest` 获取检查结果（可选）。

## 各平台检查清单

### 小红书

- [ ] 无直接留微信/手机号/二维码
- [ ] 无「最」「第一」「顶级」「唯一」等绝对化用语
- [ ] 医疗/健康/投资建议已标注「仅供参考」「不构成建议」
- [ ] 封面文字占比不超过 80%
- [ ] 标题 ≤ 20 字（含标点）
- [ ] 无诱导点赞/收藏/关注话术（如「点赞收藏不迷路」）
- [ ] 无虚假宣传（如「保证瘦」「包过」）

### 抖音

- [ ] 口播中无「加我微信」「私信我」「评论区扣 1」等诱导互动
- [ ] 无未经证实的社会事件评论
- [ ] 无低俗/争议/煽动性内容
- [ ] 无医疗/健康/投资建议未标注
- [ ] 无侵犯他人肖像权/名誉权内容
- [ ] 背景音乐/素材无版权风险

### 公众号

- [ ] 图片有合法来源或自制
- [ ] 引用数据/事实已标注来源
- [ ] 未经授权的聊天记录/肖像已打码或删除
- [ ] 无绝对化广告用语
- [ ] 无政治敏感/谣言内容
- [ ] 原创声明与实际一致

## 工作流程

1. **读取成稿**：判断目标平台和内容类型
2. **违禁词扫描**：扫描常见违禁词和广告法敏感词
3. **平台规则检查**：按平台清单逐项检查
4. **版权风险检查**：图片、引用、肖像、音乐
5. **输出合规报告**：写入 `pipeline/compliance/`
6. **给出修改清单**：每个问题都有具体修改建议

## 决策规则

| 风险等级 | 判断 |
|---|---|
| 无高风险项，中低风险 ≤ 3 处 | **可发布，建议先修** |
| 有高风险项（违禁词/引流违规/版权侵权） | **不可发布，必须修改** |
| 中低风险 > 3 处 | **建议修改后再发** |

## 与其他 Skill 的关系

- **上游**：`wechat-writer`、`douyin-script`、`xhs-card`
- **下游**：`content-audit`（深度可信审核）
- **并行**：`content-prelaunch`（发布前统一检查）

## 质量原则

- 不确定的问题标为「待确认」，不强行判断
- 每个风险都要给出具体修改建议
- 不替代法务/版权专业判断，高风险问题建议人工复核

## 语言

- 用户用中文就用中文回复，用英文就用英文回复
- 中文回复遵循《中文文案排版指北》

## 输入/输出示例

### 示例 1：成稿 → 合规风险报告

**输入**
公众号长文。

**预期输出**
```markdown
# 合规风险报告

## 1. 违禁词扫描
无命中

## 2. 广告法敏感词
- "最"字出现 1 次，建议弱化

## 3. 平台规则风险
- 无明显风险

## 4. 版权风险
- 引用的案例需确认可公开
```

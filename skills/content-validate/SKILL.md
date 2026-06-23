---
name: content-validate
description: AI FOUNDER INFLUENCE OS 新增步骤：选题立项。基于 content-intake 输出的素材报告，判断这个选题是否值得进入生产流程，输出立项决策、素材补充清单、平台首发策略。可调用 dbs-goal / dbs-diagnosis / dbs-content 做商业判断。
---

# content-validate · 选题立项

## 作用

`content-validate` 是内容生产流水线的「立项闸门」。在 `content-angle` 之前判断：**这个素材值得写成内容吗？如果写，首发哪个平台？**

核心目标：减少无效生产。不是所有素材都值得进入 angle → breakdown → writer 的全流程。

## 触发方式

- `/content-validate`
- `/立项`、`这个值不值得写`、`帮我判断一下这个选题`

## 输入

- `content-intake` 输出的素材报告路径；如果用户未指定路径，优先通过 content-runtime 读取最新 intake：
  ```bash
  python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
    --project ~/ai-content-system \
    read --step intake --latest
  ```
- 或直接提供素材（文字 / PDF / 链接 / 图片 / 语音转文字）

可选参数：
- `--strict`：严格模式，商业意图不清晰直接不通过
- `--business-first`：优先调用 dbs-diagnosis / dbs-goal 做商业判断

## 输出

保存到：

```
~/ai-content-system/pipeline/validate/{YYYY-MM-DD}-{slug}-validate.md
```

**必须通过 content-runtime 写入**：

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step validate --slug {slug} \
  --content @/path/to/validate-body.md \
  --source "intake:{intake文件路径}"
```

输出结构：

```markdown
# 选题立项报告 · {标题}

## 0. 素材来源
- intake 报告路径：{...}
- 主场景：{六类之一}
- 核心人物/观点/案例：{一句话概括}

## 1. 立项决策
- **决策**：{通过 / 有条件通过 / 不通过}
- **决策理由**：{一句话}
- **置信度**：{高 / 中 / 低}

## 2. HKR 质检
| 维度 | 评分 | 说明 |
|------|------|------|
| H (Happy/有趣) | ⭐⭐⭐⭐⭐ | ... |
| K (Knowledge/有信息量) | ⭐⭐⭐⭐⭐ | ... |
| R (Resonance/有共鸣) | ⭐⭐⭐⭐⭐ | ... |

## 3. 商业成立性判断
- 目标是否空转：{是/否，说明}
- 商业模式是否成立：{是/否/待验证，说明}
- 是否有产品/服务承接：{是/否}
- 转化路径是否清晰：{是/否}

## 4. 平台首发策略
- **推荐首发平台**：{wechat / xhs / douyin}
- **理由**：{}
- **次发平台**：{}
- **不建议平台**：{}

## 5. 素材补充清单
- [ ] {需要补充的具体素材 1}
- [ ] {需要补充的具体素材 2}
- [ ] {需要补充的具体素材 3}

## 6. 风险提示
- {风险 1}
- {风险 2}

## 7. 下一步
- 如果通过：进入 `/content-angle`，`content-angle` 可通过 `read --step validate --latest` 读取最新立项报告
- 如果有条件通过：先补充清单中的素材，再重新 `/content-validate`
- 如果不通过：说明原因，建议放弃或回到素材收集
- 如果涉及重要商业判断：建议用 `/dbs-decision` 记录决策，并用 `/dbs-save` 存档
```

## 工作流程

### Phase 1：读取素材

1. 如果用户指定了 intake 报告路径，直接读取。
2. 如果用户未指定路径，调用 content-runtime 读取最新 intake：
   ```bash
   python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
     --project ~/ai-content-system \
     read --step intake --latest
   ```
3. 如果用户直接提供素材，则按素材处理。

### Phase 2：HKR 质检

用 wechat-writer 的 HKR 框架评估选题质量：

- **H (Happy)**：足够有趣、有悬念吗？标题和开头能让人好奇想点开吗？
- **K (Knowledge)**：有信息量吗？看完能学到新东西吗？
- **R (Resonance)**：能戳中情绪吗？让人"对对对我也这么想"？

评分标准：
- 5 星：极强
- 4 星：明显
- 3 星：一般
- 2 星：较弱
- 1 星：几乎没有

S 级选题三项兼备（均 ≥ 4 星）。及格选题至少占两项（均 ≥ 3 星）。
如果只占一项或一项都没有，决策为「不通过」或「有条件通过」。

### Phase 3：商业成立性判断

检查以下问题：

1. **目标是否空转**：用户想用这个内容达到什么目标？目标是可检查的吗？
   - 如果空转（如"我想做有影响力的内容"），调用 `/dbs-goal` 审计
2. **商业模式是否成立**：这个选题指向的产品/服务是什么？有人愿意为此付费吗？
   - 如果不清晰，调用 `/dbs-diagnosis` 体检模式或问诊模式
3. **转化路径是否清晰**：内容 → 咨询/关注/购买 的链路是否说得清？
   - 如果不清晰，调用 `/dbs-content` 做内容形式匹配

### Phase 4：平台首发策略

根据素材特点和目标平台，给出首发建议：

| 素材特点 | 推荐首发 | 理由 |
|---|---|---|
| 深度分析、长逻辑链、有独特洞察 | 公众号 | 能承载完整论证，沉淀专业信任 |
| 视觉化强、清单/教程/方法论 | 小红书 | 搜索流量长尾，保存率高 |
| 观点冲突强、个人表达有张力 | 抖音 | 算法推荐友好，传播效率高 |
| 热点破题、时效性强 | 抖音/小红书 | 短期流量窗口 |
| 案例纪实、人物故事 | 公众号/小红书 | 故事需要空间，也能图文呈现 |

### Phase 5：素材补充清单

根据判断，列出进入生产前还缺什么：

- 关键数据/事实
- 具体案例/人物
- 用户痛点原话
- 产品/服务信息
- 对标参考
- 视觉素材

### Phase 6：输出报告并给出下一步

调用 content-runtime 写入 validate 报告：

```bash
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step validate --slug {slug} \
  --content @/tmp/validate-body.md \
  --source "intake:{intake文件路径}"
```

写入后 `sessions/latest.json` 中的 `validate` 字段会自动更新。

## 决策规则

| 条件 | 决策 |
|---|---|
| HKR 三项均 ≥ 4 星 + 商业成立 + 素材充足 | **通过** |
| HKR 两项 ≥ 3 星 + 商业基本成立 + 缺少量素材 | **有条件通过** |
| HKR 只有一项达标 或 商业不成立 或 素材严重不足 | **不通过** |
| 目标严重空转 | **不通过**，建议先用 `/dbs-goal` |
| 商业模式完全不成立 | **不通过**，建议先用 `/dbs-diagnosis` |

## 与其他 Skill 的关系

- **上游**：`content-intake`
- **下游**：`content-angle`
- **可调用**：`dbs-goal`、`dbs-diagnosis`、`dbs-content`
- **被读取**：`wechat-writer`（HKR 框架）、`content-breakdown`（平台策略）

## 质量原则

- 不因为素材「看起来不错」就通过，必须有明确的传播理由和商业理由
- 每个「不通过」都要给出具体原因和改进方向
- 每个「有条件通过」都要有清晰的补充清单
- 平台首发策略要基于素材特点，而不是默认公众号首发

## 语言

- 用户用中文就用中文回复，用英文就用英文回复
- 中文回复遵循《中文文案排版指北》

## 输入/输出示例

### 示例 1：素材报告 → 立项决策

**输入**
content-intake 输出的素材理解报告（核心：AI 编程助手的真实冲击）。

**预期输出**
```markdown
# 选题立项决策 · AI 编程助手的真实冲击

## 1. 立项决策
通过

## 3. 商业成立性判断
- 目标读者：关注 AI 的程序员、技术管理者
- 变现路径：专业信任 → 付费社群/课程/咨询
- 风险：容易写成情绪焦虑文，需落到真实判断框架

## 4. 平台首发策略
公众号首发，3 天后拆成小红书图文与抖音口播
```

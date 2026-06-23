---
name: content-angle
description: AI FOUNDER INFLUENCE OS第二步：角度生成。基于 content-intake 输出的素材报告，生成身份背书、反差冲突、方法论、案例纪实、情绪共鸣、叙事结构等候选角度，输出带评估的角度清单。
---

# content-angle · 角度生成

## 作用

把素材理解报告变成可执行的内容角度。每个角度都要回答：我是谁、我在对谁说、我凭什么说、读者为什么要在意。

## 触发方式

- `/content-angle`
- `生成角度`、`有哪些角度`、`这个素材怎么切`
- `从哪个角度讲最有传播力`

## 输入

- `content-validate` 输出的立项报告路径，或 `content-intake` 输出的素材报告路径，或用户直接提供的素材
- 如果用户未指定路径，优先通过 content-runtime 读取最新 validate 报告：
  ```bash
  python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
    --project ~/ai-content-system \
    read --step validate --latest
  ```

如果用户提供了 validate 报告，优先读取其中的「素材补充清单」和「平台首发策略」，作为角度生成的约束。

可选参数：
- `platforms`：wechat / xhs / douyin，默认全部
- `count`：生成角度数量，默认 6

## 输出

保存到：

```
~/ai-content-system/pipeline/angles/{YYYY-MM-DD}-{slug}-angles.md
```

**必须通过 content-runtime 写入**：

```bash
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step angle --slug {slug} \
  --content @/path/to/angle-body.md \
  --source "validate:{validate文件路径}"
```

输出结构：

```markdown
# 角度生成报告 · {标题}

## 推荐角度（按匹配度排序）

### 角度 1：身份背书
- **一句话定位**：...
- **目标用户**：...
- **情绪曲线**：...
- **差异化**：...
- **适合平台**：...
- **风险点**：...

### 角度 2：反差冲突
...

### 角度 3：方法论
...

### 角度 4：案例纪实
...

### 角度 5：情绪共鸣
...

### 角度 6：叙事结构
...

## 角度对比表

| 角度 | 平台适配 | 传播潜力 | 创作难度 | 风险 |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

## 建议
- 首选角度：...
- 组合策略：...
```

## 六类角度定义

1. **身份背书**：我为什么配聊这个话题？经历、身份、资源、成绩
2. **反差冲突**：打破常识、制造认知落差、揭示被忽视的矛盾
3. **方法论**：可执行步骤、工具清单、避坑指南
4. **案例纪实**：真实事件还原、一手观察、深度访谈
5. **情绪共鸣**：戳中特定人群的共同情绪、困境、渴望
6. **叙事结构**：英雄之旅、调查实验、对比实验、时间线叙事

## 评估维度

- **平台适配**：该角度在公众号/小红书/抖音上的天然优势
- **传播潜力**：话题热度 × 情绪强度 × 信息差
- **创作难度**：素材支撑度 × 个人表达成本
- **风险**：隐私、争议、事实可靠性

## 与其他 Skill 的关系

- 上游：`content-intake`、`content-validate`
- 下游：`content-breakdown`

## 输出后的下一步

角度报告通过 content-runtime 写入 `pipeline/angles/` 后，默认建议：

> 下一步：`/content-breakdown`
>
> `content-breakdown` 可通过 `read --step angle --latest` 自动读取最新角度报告。

## 输入/输出示例

### 示例 1：立项后的素材 → 角度清单

**输入**
素材报告 + 立项决策（通过）。

**预期输出**
```markdown
# 角度清单 · AI 编程助手的真实冲击

## 推荐角度
1. 「护城河焦虑」：为什么越老练的程序员越不慌
2. 「实习生类比」：Codex 不是替代者，是带漏洞的超人实习生
3. 「职业再定位」：从写代码的人变成审代码的人

## 角度对比表
| 角度 | 情绪强度 | 专业度 | 获客力 | 建议 |
|------|---------|--------|--------|------|
| 护城河焦虑 | 高 | 中 | 中 | 容易泛泛 |
| 实习生类比 | 中 | 高 | 高 | 首推 |
| 职业再定位 | 中 | 高 | 中 | 次推 |

## 建议
首选「实习生类比」：既有真实体感，又能给出可迁移的判断框架。
```

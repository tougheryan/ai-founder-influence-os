---
name: content-dbs-fusion
description: AI FOUNDER INFLUENCE OS 与 dbskill 的融合桥接。统一入口处理选题诊断、爆款标题、商业表达、关键决策、跨会话状态、诊断报告打包等需求。
---

# content-dbs-fusion · OS 与 dbskill 融合桥接

## 作用

`content-dbs-fusion` 是 AI FOUNDER INFLUENCE OS 和 dbskill 之间的「融合层」。

用户不需要分别记住 `/dbs-diagnosis`、`/dbs-xhs-title`、`/dbs-content` 等命令，只需要说「诊断这个选题」「帮我起小红书标题」「这个商业表达对不对」，由 `/content-dbs-fusion` 判断调用哪个 dbs skill，并把结果写回 OS 的知识库。

## 触发方式

- `/content-dbs`
- `/dbs融合`、`诊断这个选题`、`帮我起标题`、`商业表达诊断`

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

用户说「帮我起小红书标题」「这个标题怎么改」「抖音开头怎么写」。

路由流程：

```
/content-dbs 标题 {话题/行业/已有标题}
  ↓
如果是小红书 → /dbs-xhs-title
如果是抖音开头 → /dbs-hook
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

## 输出

根据模式输出到不同位置：

| 模式 | 输出路径 |
|---|---|
| 选题诊断 | `~/ai-content-system/pipeline/validate/{日期}-{slug}-dbs-diagnosis.md` |
| 爆款标题 | 直接返回标题方案（可追加到 pipeline/breakdown/） |
| 商业表达诊断 | `~/ai-content-system/pipeline/audit/{日期}-{slug}-dbs-expression.md` |
| 关键决策 | `~/ai-content-system/brain/decisions.md` + `~/ai-content-system/sessions/` |
| 跨会话状态 | `~/ai-content-system/sessions/{project}.md` |

## 与其他 Skill 的关系

- **上游**：所有 OS skill
- **可调用**：`dbs-goal`、`dbs-diagnosis`、`dbs-benchmark`、`dbs-content`、`dbs-xhs-title`、`dbs-hook`、`dbs-ai-check`、`dbs-good-question`、`dbs-deconstruct`、`dbs-decision`、`dbs-save`、`dbs-restore`、`dbs-report`、`dbs-slowisfast`、`dbs-learning`
- **写入**：`brain/decisions.md`、`brain/market/benchmark.md`、`brain/no-fly-zone.md`、`sessions/`

## 质量原则

- 不替代 dbskill 的具体判断，只做路由和结果整合
- 每次调用 dbs skill 后，把关键结论写回 OS 知识库
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

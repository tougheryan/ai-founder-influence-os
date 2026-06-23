---
name: content-audit
description: AI FOUNDER INFLUENCE OS第六步：可信审核。对公众号/口播/小红书成稿进行来源追溯、事实校验、隐私提醒、平台风险识别和修改建议，并内置 humanizer-zh 润色。
---

# content-audit · 可信审核

## 作用

发布前的最后一道闸门。不是挑刺，而是帮作者避开事实、隐私、平台规则三类风险，同时把 AI 味压到最低。

## 触发方式

- `/content-audit`
- `审核内容`、`检查一下这篇文章`、`有没有风险`
- `去 AI 味`、`润色一下`

## 输入

成稿内容：公众号长文、抖音口播稿、小红书图文文案，或文件路径。

如果用户未指定文件路径，优先通过 content-runtime 读取最新成稿：

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

## 输出

保存到：

```
~/ai-content-system/pipeline/audit/{YYYY-MM-DD}-{slug}-audit.md
```

**必须通过 content-runtime 写入**：

```bash
python $HOME/.agents/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step audit --slug {slug} \
  --content @/path/to/audit-body.md \
  --source "write:{成稿文件路径}"
```

输出结构：

```markdown
# 内容审核报告 · {标题}

## 1. 来源追溯

| 事实/数据 | 原文位置 | 来源标注 | 状态 |
|---|---|---|---|
| ... | ... | ... | ✅ 已标注 / ⚠️ 待核实 / ❌ 无来源 |

## 2. 事实校验

- 待核实项：...
- 存疑项：...
- 建议替换表述：...

## 3. 隐私提醒

- 不可公开的人物/公司信息：...
- 建议处理方式：...

## 4. 平台风险

- 违禁词/敏感词：...
- 广告合规：...
- 医疗/金融/教育等特殊领域风险：...

## 5. 修改建议（按优先级）

### P0 必须改
- ...

### P1 建议改
- ...

### P2 可优化
- ...

## 6. humanizer 润色摘要

- 检测到的 AI 味模式：...
- 已调整：...

## 7. 总体结论

- 是否可发布：...
- 遗留风险：...
```

## 审核维度

1. **来源追溯**：每个数据、事实、引用是否有明确来源
2. **事实校验**：标出无法验证或可能过时的信息
3. **隐私提醒**：人物隐私、商业机密、敏感关系
4. **平台风险**：违禁词、广告法、行业特殊规定
5. **修改建议**：具体修改点 + 优先级
6. **去 AI 味润色**：内置 humanizer-zh 规则

## 质量原则

- 不通过就明确说不能发
- 所有建议都要有具体位置
- 不替用户做价值判断，只标风险
- 润色后保留作者原意

## 与其他 Skill 的关系

- 上游：`wechat-writer`、`douyin-script`、`xhs-card`
- 复用：`humanizer-zh` 的 24 条 AI 味检测规则
- 下游：`content-review`（发布后的数据复盘）

## 输出后的下一步

审核报告通过 content-runtime 写入 `pipeline/audit/` 后，如果内容通过审核，可进入发布；发布后使用 `/content-review` 复盘，`content-review` 可通过 `read --step audit --latest` 读取审核记录（可选）。

## 输入/输出示例

### 示例 1：成稿 → 可信审核报告

**输入**
公众号长文与 breakdown 来源。

**预期输出**
```markdown
# 可信审核报告

## 1. 来源追溯
- 核心体验：用户一手素材
- 类比来源：原创

## 2. 事实校验
- Codex 为真实产品
- "72 小时节省"需有具体场景支撑

## 5. 修改建议
- 补充一次失败案例，避免过度美化
```

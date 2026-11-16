---
name: content
description: Echo Founder 内容生产总控入口。判断用户意图，管理当前任务，并按用户选择的平台路由原生内容生产。
---

# content · Echo Founder 内容生产总控

## 产品原则

Echo Founder 从一条真实素材出发，但不从一篇“公众号母稿”派生所有平台内容。新任务只支持三个可选发布平台：

- `wechat`：微信公众号
- `xhs`：小红书
- `shipinhao`：视频号

用户可以选择任意一个、任意组合或全部平台。平台选择必须在公开样本研究之前确认；系统只研究、生成、审核和交付已选择的平台。

共享的是事实、人物、案例、证据、商业目标与不可公开边界；不共享标题、开头、正文结构、平台话术和视觉模板。每个平台必须根据本平台的公开样本、阅读场景和发布形态独立生产原生内容。

## 标准七阶段

1. **素材**：理解真实来源，提取事实、观点、场景、证据和隐私边界。
2. **选题**：确认平台选择；对每个已选平台分别收集公开样本、判断可借鉴机制并完成立项。
3. **内容**：建立共享事实底座，再为每个已选平台分别生成原生内容。
4. **视觉**：只处理微信公众号和小红书；仅选视频号时自动跳过。
5. **审核**：按平台分别检查事实、表达、合规、商业闭环和发布完整性。
6. **发布**：只为已选平台建立草稿与发布任务，真实发布结果逐平台回填。
7. **复盘**：逐平台分析表现与评论，再将有效规律写回共享知识资产。

这七阶段是用户可见流程。`intake`、`validate`、`blueprint`、`package`、`prelaunch`、`compliance`、`audit` 等是内部质量门，不应变成让用户理解系统实现的额外负担。

## 平台交付契约

### 微信公众号

- 一篇可直接发布的完整长文
- 标题、摘要、正文、引用与评论引导
- 完整微信排版视觉
- 头图与正文插图

### 小红书

- 一篇独立的小红书图文内容，而非公众号摘要
- P1-P8 共 8 张图文卡片的逐页文案
- 可直接用于封面的三句话
- 发布正文与结尾标签

### 视频号

- 一条独立的口播执行稿
- 开场钩子、逐段口播、镜头/B-roll、字幕重点与发布文案
- 不进入静态视觉生产，不生成封面或图卡

禁止把未选择的平台塞入交付；禁止固定产出“一篇文章 + 两条视频 + 三组图文”；禁止让公众号正文成为小红书或视频号的强制上游。

## TikOmni 公开样本门

每个已选平台单独研究、单独判定：

- 样本必须带可核验公开链接。
- 阅读、点赞、收藏、评论等缺失指标显示为“未知”，不能写成 `0`。
- 样本分为“已验证爆款”“高潜样本”“相关参考”，不能把相关结果统一叫爆款。
- 排序规则必须平台化，不能用一套互动量公式覆盖三个平台。
- 某个平台失败时，只阻断或移除该平台生产线；已经取得合格样本的平台可以继续。不得用另一平台样本代替。

系统不承诺“必爆”。它只允许借鉴标题入口、开头钩子、叙事机制、需求信号与评论结构，不复制第三方标题、正文、封面、镜头或评论表达。

## 运行时底座

所有子 skill 在执行前使用 `content-runtime` 管理任务状态和文件：

```bash
RUNTIME="python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py --project ~/ai-content-system"

$RUNTIME init
$RUNTIME run-create --topic "{主题}" --platforms "公众号,小红书"
$RUNTIME state
$RUNTIME read --step intake --latest --slug {slug}
$RUNTIME write --step package --slug {slug} --content @/path/to/package.md --source "blueprint:{path}"
```

读取上游时优先使用 `read --step {上游} --latest --slug {slug}`，不要自行扫描目录。写入必须绑定当前 run 与 slug。完整命令见 `skills/content-runtime/SKILL.md`。

## 意图路由

| 用户意图 | 路由 |
|---|---|
| 输入素材并生成内容 | `content-intake` → 平台选择 → 公开样本研究 → `content-validate` → `content-blueprint` → `content-package` |
| 爆款收集 / 对标分析 | `content-hit-collector`；必须保留样本等级与指标未知状态 |
| 理解素材 | `content-intake` |
| 选题是否值得做 | `content-validate` |
| 内容蓝图 | `content-blueprint` |
| 生成平台原生成稿 | `content-package` |
| 公众号完整视觉 | `content-visual` 的微信分支 |
| 小红书图文卡片 | `content-visual` 的小红书分支 |
| 发布前检查 | `content-prelaunch` → `content-compliance` → `content-audit` |
| 发布数据回流 | `content-performance-collector` |
| 收获总结 / 复盘 | `content-review` |
| 归档沉淀 | `self-archive` / `content-twin` |

`wechat-writer` 与 `content-repurpose` 可以处理用户明确提出的单次旧稿改编，但不属于新任务的默认生产主链。

## 对话方式

- 用户指令模糊时，只展示当前任务、当前阶段、已选平台和下一项最小动作。
- 目标平台未确定时，先让用户勾选平台；不要擅自全选。
- 出现样本不足、事实风险、隐私风险或平台失败时，说明具体影响的平台和可继续的路径。
- 用户询问状态时，展示七阶段进度，不逐项倾倒内部文件名。
- 中文回复遵循自然、简洁、可执行的表达。

## 旧任务兼容

旧版任务中出现 `douyin`、`moments`、`write`、“母稿”或固定一稿五发资产时，只读展示并允许完成旧任务，不重写历史文件。任何新建任务必须使用 v2 平台选择与独立生产契约。

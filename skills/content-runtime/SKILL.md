---
name: content-runtime
description: Echo Founder 轻量运行时。管理按平台选择的内容任务、独立生产线、质量门和交付文件。
---

# content-runtime

## 范围

运行时管理一条真实素材的多平台原生内容生产。新任务支持 `wechat`、`xhs`、`shipinhao`，并允许任意非空子集。它负责项目初始化、run 生命周期、平台选择、步骤状态、文件归属、质量校验和交付审计；不替代写作、视觉、拍摄或真人发布。

共享素材不等于共享文稿。运行时只允许各平台共享事实底座、证据、人物与风险边界；每个平台的研究结果、内容包、审核、发布结果和复盘必须保持独立可追溯。

## v2 标准路径

`intake -> validate -> blueprint -> package -> visual(条件执行) -> prelaunch -> compliance -> audit -> publish -> performance -> review -> archive -> twin`

上式为平台研究路径。用户明确选择“按我的题目写”时，采用 `intake -> author-source-select（版本核验） -> blueprint -> package`，之后使用同样的交付检查；`author-source-select` 是本地依据操作，不是新内容步骤。默认生产止于 audit 后的 `draft_information` 人工确认，publish 与周度复盘由实际事件另行触发。

作者素材模式必须先保存当前素材整理上下文、底稿、题目与平台，再通过 `author-source-context/select/verify` 建立并核验不可变记录。只传 `research_mode`、研究失败或缺少样本都不能启用该路径。题目、素材或平台变化时重新确认，旧文件保留。方案须包含当前记录的绑定行并明确未进行平台研究，H2 确认后才可写正文。不得生成样本数量、热度或市场验证结论。CLI next/flow 与页面使用同一依据；继续 flow 不重复导入 intake。

- `intake`：保存真实素材与共享事实底座。
- 平台选择：必须在确认写作依据前锁定；更改后研究模式重新研究受影响平台，作者模式重新确认素材依据。
- `market-signal`：只研究已选平台，各平台独立返回证据与状态。
- `validate`：结合共享素材和各平台样本决定是否立项。
- `blueprint`：输出共享事实约束和每个平台的独立内容蓝图。
- `package`：只输出已选平台的原生成稿。
- `visual`：选择微信或小红书时执行；仅选视频号时跳过。
- 后续审核、发布、表现与复盘均按平台记录。

新任务不包含 `write` 母稿步骤，也不固定生成全平台内容。

## 市场研究契约

平台研究模式的 TikOmni 质量门只要求当前已选平台；作者模式不运行此研究门禁，也不声称已取得研究证据：

- 每个平台至少有一条带公开链接、可独立核验的合格样本。
- 指标缺失保留 `unknown`，不得转换为零。
- 样本必须区分 verified hit、potential 与 related reference。
- 平台失败互不连坐：成功平台可继续；失败平台保持阻断或由用户取消选择。
- 未取得本平台证据的生产线不得借用其他平台样本继续。
- 快照必须绑定当前 run、slug、intake 摘要与已选平台。

## 常用命令

```bash
RUNTIME="python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py --project ~/ai-content-system"

$RUNTIME init
$RUNTIME run-create --topic "{主题}" --platforms "公众号,小红书"
$RUNTIME run-visual-preferences-set --run-id {run-id} --mode stable --direction-count 2 --provider-policy auto
$RUNTIME state
$RUNTIME read --step package --latest --slug {slug}
$RUNTIME write --step package --slug {slug} --content @/path/to/package.md --source "blueprint:{path}"
$RUNTIME validate --step package --file /path/to/package.md
```

`run-create` 接受 `公众号/wechat`、`小红书/xhs`、`视频号/shipinhao` 及已有中文别名。未知平台值不能创建新分支。

## 文件与状态约束

- 所有新文件必须归属当前 run 与 slug。
- 可写内容限于 runtime 管理的 `pipeline/`、`materials/`、`brain/`、`sessions/` 和 `runs/`。
- run schema v2 记录 `selected_platforms`、共享素材摘要和各平台 lane 状态。
- run schema v2 同时记录 `visual_preferences`；新任务固定使用 `stable`，方向数固定为 2，provider 策略固定为 `auto`。
- `pipeline/package/` 保存已选平台的最终内容；不得包含未选择的平台段落。
- `pipeline/visual/{slug}/` 只保存微信或小红书的可交付视觉。
- 发布记录必须绑定同一 run 的最终内容；公开平台 URL 必须为真实 `http(s)` 链接。
- 表现数据、复盘和学习继续沿用相同 run/slug/platform，防止跨任务混写。

## 内容与视觉质量门

- 微信：完整长文、摘要、正文、引用、评论引导与发布提示。
- 小红书：独立正文、封面三句话、P1-P8 逐页图卡文案、结尾标签。
- 视频号：独立口播、镜头/B-roll、字幕重点与发布文案；不要求静态视觉。
- 真实人物、数字、客户信息和案例必须可追溯或匿名化。
- `visual` 只有在已选平台包含 `wechat` 或 `xhs` 时进入草稿审批队列。
- `stable` 视觉只执行本地排版与已有素材渲染，不调用 AI 生图，不接受重新生成插画或不可落地的配色修订。
- 公众号排版修订明确指定主题时，由服务端与运行时核对本机 md2wechat 的可用 API 主题目录；未知、不可用或歧义主题不得静默替换。未指定主题的通用换版仍可在原候选中轮换。正文绑定的有限标题与间距参数写入新配方，原内容包与旧修订保留；生成后重新通过 HTML 保真与视觉质量门。
- 发布队列只创建已选平台的发布件；平台结果与错误不得合并覆盖。

## 旧任务兼容

旧 schema 中的 `douyin`、`moments`、`write`、`xhs` 独立步骤、固定发布资产及历史待审视觉继续只读可见，运行时不得继续生成、晋级、迁移或重写其历史文件。v2 新任务一律遵循三平台可选子集、`stable` 视觉和独立 lane 契约。

## 验证

```bash
make test
make runtime-contracts
make content-loop-check
make delivery-audit PROJECT=~/ai-content-system AUTO_PACK=1
```

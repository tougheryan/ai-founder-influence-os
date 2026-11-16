# Baoyu 底层视觉设计层

## 第一性原理

视觉生产不是先问“好不好看”，而是先拆成三层：

1. **AIFI-OS 契约层**：负责原文追溯、资产清单、输出路径、Manifest、质量门和交付状态。
2. **Baoyu 设计层**：负责风格、版式、色彩、文字密度、prompt 文件纪律和 raster 生成约束。
3. **执行工具层**：负责真实落盘，继续使用 `xhs-card`、`ian-xiaohei-illustrations`、`dbs-wechat-html`。

## 路由映射

| 资产类型 | Baoyu 设计层 | AIFI-OS 执行工具 | 说明 |
|---|---|---|---|
| 公众号头图 / 分享卡 | `baoyu-cover-image` | `xhs-card` | Baoyu 定义 type、palette、rendering、text、mood、font；执行层输出主方案和备选方案的 21:9 + 1:1 成对首图。 |
| 小红书封面 / 图文卡片 | `baoyu-xhs-images` | `xhs-card` | Baoyu 定义 style、layout、palette、preset、卡片序列一致性；执行层按反常识/方法/案例三种观点结构输出 3 组 P1-P5 PNG。 |
| 信息图 / 结构图 / 证据等级图 | `baoyu-infographic` | `xhs-card` | Baoyu 定义 21 种 layout 和 22 种 style；执行层按平台落成卡片。 |
| 正文插图 | `baoyu-article-illustrator` / `baoyu-infographic` | `ian-xiaohei-illustrations` / `xhs-card` | Baoyu 判断插图位置、类型、密度；执行层为每张图保留正文小标题锚点、语义 brief 和证据边界。 |
| 短视频封面 | `baoyu-cover-image` / `baoyu-xhs-images` | `xhs-card` | 用口播 3 秒钩子生成 9:16 封面，配套镜头、字幕和 B-roll 的平台交付清单。 |
| 位图生成后端 | `baoyu-image-gen` 或 Codex native `imagegen` | 生成 PNG/JPG | 只有配方明确选择概念 raster 时调用，生成后进入文字与非证据边界复核。 |

## 硬规则

- 每个 AI raster 图片资产必须先写独立 prompt 文件，再调用生成工具；HTML/CSS 版式渲染的文字卡和数据图记录对应 recipe、源码和 PNG 输出。
- 自动发布链路直接生成实际 HTML/PNG；只有后端缺失、素材不足或用户明确要求生产单时才输出计划状态。
- 需要 AI 位图时必须使用真实 raster 后端，不能用 SVG、HTML、canvas 冒充 AI 生图；来源数据图可以保留 SVG 源文件并同时交付 PNG。
- 生成图中文字错误时，改 prompt 后重生成；不能用脚本在位图上涂改、覆盖或补字。
- Baoyu 的确认门适用于概念 raster；自动流水线可按已选配方生成本地 HTML/PNG 和可用 raster，但不能把概念图伪装成事实证据。
- 不公开真实客户 Logo、项目身份、对话材料截图、内部代码细节、ROI/成交承诺。

# AIFIOS Golden Cases

这些样本用于内容质量验收，不参与 runtime 状态。

## 使用方式

每个平台保留 3 个样本：

- `wechat/`: 公众号长文验收样本
- `xhs/`: 小红书图文/卡片验收样本

验收时对照：

1. 是否匹配目标阵地的表达结构。
2. 是否有明确目标用户和痛点。
3. 是否有可信判断，不编造硬数字。
4. 是否有商业闭环，但不过度销售。
5. 是否能沉淀到 `brain/` 或 `materials/hit-library/` 复用。

## 自动检查

```bash
make quality-check PROJECT=~/ai-content-system PLATFORM=wechat SLUG=demo
make quality-check PROJECT=~/ai-content-system PLATFORM=xhs FILE=/path/to/xhs.md
```

自动检查会生成 `quality/reports/`，用于交付前第一道门槛。它只负责暴露结构风险、商业闭环缺失、硬数字风险和夸大表达风险；正式商业交付仍需要人工通读。

# 真实付费生图验收

Echo Founder 的内部发布验收直接连接六组账户、十条付费模型路由。普通用户不需要重复这套实验室配置：一个通过内部验收的付费账户即可使用 AI 增强，两个账户可形成跨服务主备，第三个账户只作为高级选项。`baoyu-image-gen` 仅用于旧 `visual-recipe.v1` 兼容，不能计入十路由、预算或发布验收。

## 普通用户运行策略

- 0 个账户：稳定排版可正常完成交付，AI 增强不可选。
- 1 个账户：使用该服务在冻结 benchmark 中评分最高的正式路由；明确失败时回退稳定排版。
- 2 个账户：第一个为主服务，第二个为跨服务备用；只有明确失败才切换，超时或结果不明时停止核账。
- 3 个账户：第三个仅供高级用户使用；运行时最多激活三个账户。
- 默认预算为单次 5 元、单任务 20 元、月度 100 元提醒。第一次付费前必须由用户确认；运行时账本与内部 100 元 benchmark 账本完全分离。

以下六账户、十路由步骤是内部发布候选验收，不是普通用户的首次使用门槛。

## 前置条件

1. 在桌面 App 设置页配置 OpenRouter、Replicate、火山方舟、阿里云百炼、智谱和 MiniMax。百炼同时需要 Workspace ID 与区域。
2. 六组状态必须全部为已配置。密钥只进入 macOS 钥匙串；状态接口不会返回密钥。
3. 操作者从各服务官方目录核对正式、非 preview/beta 模型 ID，并给每条路由冻结单次调用人民币上限。
4. benchmark 总预算硬上限为 100 元；结果不明的调用禁止自动重付费。

## 冻结 benchmark

先检查服务进程是否收到六组凭据：

```bash
python3 skills/content-runtime/scripts/image_provider_benchmark.py status
```

初始化时，OpenRouter 的四条路由从官方图像模型目录自动解析。其余路由使用重复的 `--pin route_id=model_id=官方证据URL`；十条路由都必须使用 `--estimate route_id=人民币上限`。示例：

```bash
python3 skills/content-runtime/scripts/image_provider_benchmark.py init \
  --output "$AIFIOS_DESKTOP_USER_DATA_DIR/image-benchmarks/current.json" \
  --usd-cny 7.20 \
  --pin replicate_nano_banana=owner/model=https://replicate.com/owner/model \
  --estimate openrouter_openai_image=1.50 \
  --estimate replicate_nano_banana=1.50
```

实际执行时必须补全十条 `--estimate` 和六条非 OpenRouter `--pin`。任何模型或费用上限缺失，manifest 都保持 `blocked`。

## 付费操作与评分

所有请求先写 `echo-founder.paid-image-operation.v1` 操作记录，再访问服务。命令必须指定冻结 manifest、route、轮次、提示词、画幅和费用上限：

```bash
python3 skills/content-runtime/scripts/paid_image_gateway.py \
  --manifest "$AIFIOS_DESKTOP_USER_DATA_DIR/image-benchmarks/current.json" \
  --route-id openrouter_openai_image \
  --phase round_1 \
  --prompt-file /absolute/path/to/prompt.md \
  --output /absolute/path/to/sample.png \
  --aspect-ratio 16:9 \
  --estimated-cost-cny 1.50 \
  --operation-key round1-openrouter-wechat
```

盲评 JSON 使用审美、平台适配、一致性、提示遵循、语义匹配、延迟和成本七个维度。评分后运行：

```bash
python3 skills/content-runtime/scripts/image_provider_benchmark.py score \
  --manifest "$AIFIOS_DESKTOP_USER_DATA_DIR/image-benchmarks/current.json" \
  --evaluations /absolute/path/to/blind-evaluations.json
```

前三名均不低于 75 分、第一名不低于 85 分，并且不存在意外文字、数字、Logo、水印、损坏或身份漂移时，manifest 才会冻结主备路由。AI 增强视觉进入发布资产前仍需逐图人工确认。

## 故障边界

- 明确失败：允许使用 5 元重试预算切换冻结备用路由。
- 超时、断网或结果不明：停止，不自动切换；先人工核账。
- 未配置、未冻结或未达标：新任务回退稳定排版。
- 稳定排版不访问任何生图服务，仍可完成公众号 HTML 与小红书 P1–P8。

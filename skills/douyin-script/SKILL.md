---
name: douyin-script
description: AIFI-OS optional short-video lead-generation script skill. Turns an approved content blueprint or legacy breakdown into editable Douyin/WeChat Channels spoken-script candidates, a recommended script, shot guidance, subtitle emphasis, comment handoff, and risk boundaries. It does not render video, publish to a platform, or promise leads.
---

# douyin-script · 获客口播脚本

## 作用

将一份已经成立的内容判断，改写成可拍摄、可测试的短视频获客口播。它交付的是脚本包，不是成片：包含 30-45 秒候选脚本、推荐口播稿、镜头和字幕建议，以及评论区承接与风险边界。

## 触发方式

- `/content-douyin`
- `/douyin-lead-gen`
- `/获客口播`
- `帮我写获客口播`、`给我 5 个短视频脚本角度`、`把这篇文章拆成抖音口播`

## 边界

- 只生成可编辑的文字脚本与拍摄建议；不生成 MP4，不做视频渲染、剪辑、字幕烧录或媒体质检。
- 不接入 UI、自动发布、抖音数据采集或效果预测。
- 不为了“获客”夸大结果、制造虚假焦虑，或承诺私信、成交、播放量和咨询量。

## 输入

优先读取同一 `slug` 的、已确认的 `content-blueprint`；旧内容可读取 `content-breakdown` 作为兼容输入。输入必须能说明：

- 核心判断与目标读者
- 必用事实、案例或可公开的具体场景
- 商业承接动作与不可触碰的风险边界

读取示例：

```bash
RUNTIME="python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py --project ~/ai-content-system"

$RUNTIME read --step blueprint --latest --slug {slug}
$RUNTIME read --step breakdown --latest --slug {slug}
```

如果没有可用上游，不要自由编造案例或客户数据。先要求补充素材、立项结论或蓝图。

## 输出

输出文件必须使用以下结构：

```markdown
# 获客口播：{主题}

## 0. 上游约束
- 核心判断：{来自蓝图或 breakdown 的判断}
- 必用证据：{公开、授权或概念边界明确的素材}
- 目标读者：{具体人群与场景}

## 1. 发布与定位
- 发布标题：{标题}
- 封面字：{封面主句}
- 3 秒钩子：{开场第一句}
- 建议时长：30-45 秒

## 2. 30-45 秒候选脚本
### 候选 1：{角度}
{口播稿}

### 候选 2：{角度}
{口播稿}

### 候选 3：{角度}
{口播稿}

## 3. 推荐口播稿
{一条可直接录制的分段口播稿。}

## 4. 拍摄与字幕
- 镜头：{镜头 / B-roll 建议}
- 字幕重点：{需要强调的句子}
- 画面证据：{素材来源；没有事实素材时标明“概念画面，非事实证据”}

## 5. 评论承接与风险边界
- 评论承接：{低承诺提问或回应}
- 风险边界：{不夸大、不泄露、不保证结果}
```

## 写回与校验

```bash
python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  write --step douyin --slug {slug} --content @/path/to/douyin-script.md \
  --source "blueprint:{blueprint文件路径}"

python3 $AIFIOS_HOME/skills/content-runtime/scripts/content_runtime.py \
  --project ~/ai-content-system \
  validate --step douyin --file pipeline/douyin/{filename}.md
```

`douyin` 是一个可手动调用的脚本产物步骤，不会被主 pipeline 自动调度，也不会把项目的发布范围扩展为短视频生产或抖音发布。

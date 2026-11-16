# 微信公众号官方 API 数据回流设置

## 1. 开通条件

- 公众号后台已启用开发者能力。
- 当前机器公网出口 IP 已加入微信公众平台 IP 白名单。
- 本地环境已设置：

```bash
export AIFIOS_WECHAT_OFFICIAL_APP_ID="wx..."
export AIFIOS_WECHAT_OFFICIAL_APP_SECRET="..."
```

## 2. 第一次采集

```bash
make performance-collect-wechat-api PROJECT=~/ai-content-system \
  SLUG=article-slug \
  ARTICLE_ID=ARTICLE_ID \
  MSG_DATA_ID=MSG_DATA_ID \
  PUBLISHED_AT=2026-07-10 \
  COMMENT_LIMIT=50
```

## 3. 字段边界

自动采集优先写入：

- `reads`：图文阅读次数；
- `readers`：图文阅读人数；
- `shares`：分享转发次数；
- `collects`：收藏次数；
- `comments`：本次官方留言接口返回的有效留言样本数。

以下字段不自动伪造：

- `exposures`：官方图文统计接口未稳定提供完整曝光口径；
- `likes`：本阶段不从非官方页面推断；
- `wows`：本阶段不从非官方页面推断；
- `leads`：需要业务侧表单、私信或人工补充。

## 4. 输出位置

```text
materials/performance/raw/
materials/performance/wechat-official-account/
materials/performance/review-inputs/
pipeline/performance/
```

## 5. 常见失败

- `Missing AIFIOS_WECHAT_OFFICIAL_APP_ID`：环境变量未设置。
- `api unauthorized`：公众号未开通对应接口权限。
- `invalid ip`：当前公网 IP 不在微信公众平台白名单。
- `datacube_total_missing_or_unmatched`：官方统计接口暂未返回该文章数据，常见于发布时间过近或数据量过低。
- `msg_data_id_missing_comments_skipped`：未提供留言接口所需的消息数据 ID，只采集图文统计。

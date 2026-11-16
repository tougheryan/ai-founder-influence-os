---
name: content-performance-collector
description: AIFIOS 发布后表现数据回流。记录公众号和小红书的授权数据，为复盘提供可追溯输入。
---

# content-performance-collector

## 范围

采集用户自有账号、客户授权导出或人工录入的公众号和小红书表现数据。每条数据都必须绑定对应的 `slug`、发布记录和来源。

## 写入约定

```text
materials/performance/
├── raw/
├── wechat-official-account/
└── xhs/
```

## 输入要求

- 发布链接与发布时间
- 平台、内容标题、run/slug
- 阅读、互动、收藏、评论、转发、转化等可得指标
- 数据来源、采集时间和授权说明

## 输出

输出原始快照、归一化指标、评论样本和 `content-review` 输入包。缺少发布记录或来源证据时，保留数据但标记为不可用于结论。

## 原则

- 不伪造平台数据，不将估算值写成真实表现。
- 不跨 run 混合数据。
- 可复核模式只在每周复盘完成且人工确认后，由 `weekly_learning.py` 沉淀到本机长期学习。

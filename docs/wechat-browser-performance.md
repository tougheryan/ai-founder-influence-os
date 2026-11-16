# 微信公众号登录态浏览器数据回流

当微信公众号官方 API 返回 `48001 api unauthorized`，但你可以在公众号后台看到文章数据时，使用本模式。

## 1. 安装浏览器依赖

```bash
cd /Users/example/Documents/AIFI-OS
make browser-hit-install
make browser-hit-doctor
```

## 2. 登录后全自动采集

### 2.1 采集所有已发布文章

用于你刚才说的目标：除了登录，其他全部自动化。

```bash
make performance-collect-wechat-browser PROJECT=~/ai-content-system \
  SLUG=wechat-all-20260710 \
  ALL_PUBLISHED=1 \
  CAPTURE_CONTENT=1 \
  MAX_ARTICLES=50
```

执行后：

1. Chromium 打开后，你手动登录 `mp.weixin.qq.com`。
2. 系统自动等待登录完成。
3. 系统自动进入可见的已发表/内容列表。
4. 系统逐篇点击数据/统计入口。
5. 若启用 `CAPTURE_CONTENT=1`，系统会打开每篇公开文章链接，采集正文、段落、小标题，并生成确定性内容分析。
6. 每篇文章分别写入 performance 数据。

如果微信公众号后台的发表记录页直接展示文章行和数字，而没有单独的数据按钮，系统会直接读取发表记录列表：标题、公开链接、日期和可见数字都会写入。当前列表模式会把文章行第一列可见数字写成 `reads`，其余数字保留在 `visible_list_metrics`，不强行伪造点赞、评论等未标明口径的字段。

如果后台首页无法自动进入已发表列表，可以传一个列表页 URL：

```bash
make performance-collect-wechat-browser PROJECT=~/ai-content-system \
  SLUG=wechat-all-20260710 \
  URL="https://mp.weixin.qq.com/..." \
  ALL_PUBLISHED=1 \
  MAX_ARTICLES=50 \
  MAX_PAGES=5
```

`SLUG` 会作为批量前缀，每篇文章自动生成 `wechat-all-20260710-001`、`wechat-all-20260710-002` 这样的独立 slug。

正文采集会额外写入：

```text
materials/performance/article-captures/
```

并把 `article_content`、`content_analysis` 和 `article_capture_path` 写入 raw、归一化数据和 review 输入包。当前内容分析使用稳定 v2 schema，不调用外部 AI，固定输出：

- 综合诊断和优先优化项；
- 开头、结构、证据深度、读者价值、转化设计、标题正文匹配的评分卡；
- 每项优化建议的优先级、问题、证据、建议动作、改写方向和预期效果；
- 下一篇选题机会和修订 brief。

### 2.2 采集单篇文章

```bash
make performance-collect-wechat-browser PROJECT=~/ai-content-system \
  SLUG=article-slug \
  TITLE="公众号文章标题" \
  AUTO_AFTER_LOGIN=1
```

可选：

```bash
make performance-collect-wechat-browser PROJECT=~/ai-content-system \
  SLUG=article-slug \
  TITLE="公众号文章标题" \
  PUBLISH_URL="https://mp.weixin.qq.com/s/..." \
  PUBLISHED_AT=2026-07-10 \
  AUTO_AFTER_LOGIN=1 \
  PROFILE=~/.aifios-browser-profiles/wechat-mp-performance
```

这个模式的目标是：人只负责登录授权，系统自动等待登录完成、按文章标题定位已发布作品、点击数据/统计/分析入口、读取当前授权可见的数据并写回。

如果公众号后台停在了特殊页面，或者微信后台改版导致菜单定位失败，可以追加 `URL=...`，让浏览器从“已发表/发表记录/统计列表”页面开始自动找文章：

```bash
make performance-collect-wechat-browser PROJECT=~/ai-content-system \
  SLUG=article-slug \
  TITLE="公众号文章标题" \
  URL="https://mp.weixin.qq.com/..." \
  AUTO_AFTER_LOGIN=1
```

## 3. 浏览器里怎么操作

1. Chromium 打开后，手动登录 `mp.weixin.qq.com`。
2. 登录成功后不要关浏览器，系统会自动继续。
3. 系统会尝试打开目标文章的数据页并采集。

采集器只读取当前页面可见文字，不绕过登录、不破解接口、不抓取无权限数据。

如需使用旧的手动定位模式，不传 `AUTO_AFTER_LOGIN=1` 即可：你手动进入目标文章统计页，再回到终端按 Enter。

## 4. 输出位置

浏览器原始整理：

```text
materials/performance/browser-captures/
materials/performance/browser-inputs/
materials/performance/article-captures/
```

标准数据回流：

```text
materials/performance/raw/
materials/performance/wechat-official-account/
materials/performance/review-inputs/
pipeline/performance/
```

## 5. 检查结果

```bash
python3 scripts/aifios.py --project ~/ai-content-system read \
  --step performance \
  --slug article-slug
```

也可以看归一化 JSON：

```bash
python3 -m json.tool ~/ai-content-system/materials/performance/wechat-official-account/article-slug.json
```

## 6. 常见问题

- `Playwright dependency is not installed.`：先运行 `make browser-hit-install`。
- 页面没有识别到数据：自动模式下先传精确 `TITLE`；若后台改版，再传 `URL` 指向已发表或统计列表页。
- 标题识别不对：重新运行并传 `TITLE="..."`。
- 链接识别不到：重新运行并传 `PUBLISH_URL="https://mp.weixin.qq.com/s/..."`。
- 数据不全：微信后台不同页面字段不同；采集器只记录可见字段，不会伪造缺失指标。
- 正文未采集：确认命令里加了 `CAPTURE_CONTENT=1`，并且发表记录里能看到公开文章链接。

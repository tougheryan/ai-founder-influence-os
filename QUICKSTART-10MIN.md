# Echo Founder 工程 Quickstart

本说明面向源码运行。桌面安装用户请使用 [安装与首次启动](docs/echo-founder-installation.md)。当前版本与可交付边界以根目录 `VERSION`、`RELEASE.md` 为准。

The active runtime is Codex-native local code and does not require Superpowers. `docs/superpowers/` is historical material, not an operating entry point.

## 1. 定义第一次要完成的事

先选一个平台，用一份本人已授权的访谈、笔记或案例，完成一份愿意署名发布的内容。例如：一份业务笔记 → 一篇公众号文章与完整 HTML。首轮不要求三个平台全做。

公众号交付原生长文与排版；小红书交付一套 P1–P8 图文与发布文案；视频号交付口播、镜头、字幕重点和发布文案，不生成成片。多选时，各平台共享事实、分别组织内容；按自己的题目写不做平台研究，需要找方向时只研究所选平台，不使用公众号母稿改写其他平台。

## 2. 准备运行环境

```bash
cd /path/to/AIFI-OS
make test
make doctor
make init PROJECT=/private/tmp/echo-founder-trial
make onboard \
  PROJECT=/private/tmp/echo-founder-trial \
  PLATFORMS="公众号" \
  OFFER="内容诊断" \
  TARGET="服务型创始人" \
  PRODUCT="内容获客服务"
make ui PROJECT=/private/tmp/echo-founder-trial PORT=3000
```

试用目录与真实项目分开。长期使用时换成自己的持久项目目录并建立备份；临时目录不适合保管长期素材。不需要提前运行 `run-create`：工作台整理素材时会建立本期任务。

## 3. 检查配置

打开 `http://127.0.0.1:3000/production?stage=1`，展开“连接与费用说明”。

- 模型：到“系统设置”→“连接写作服务”保存服务商、模型与密钥，并测试连接。保存不调用模型；测试会发一次可能计费的短文本请求，成功不代表余额或长文质量已验收。
- 按我的题目写：不需要 TikOmni；确认本期素材、题目和平台后准备写作方案。
- 帮我找方向：再配置 TikOmni 凭据和本机连接组件。关键词研究不强制填写公众号 GHID，定向账号追踪才按需填写。
- 费用：模型与平台研究可能产生对应服务费用；已保存配置不代表余额、权限或实时连接已验证。
- 排版：公众号通过本机 md2wechat 请求外部排版 API，需要该服务账号并可能计费，失败时回退内置排版；小红书本地渲染，不要求生图账户。查看主题目录不会生成预览，主动生成或重试示例预览也可能产生排版费用。

没有模型时仍能先整理本机文字素材。生成前应完成模型连接，避免在选题后才被配置问题阻断。配置后回到工作台点击“重新检查配置”。

## 4. 完成一次生产

1. 粘贴素材或添加文件、链接，点击“整理素材”。核对事实、案例和不能公开的内容；没有案例可以写观点或方法，不补造经历。
2. 只勾选本期需要的平台。已有题目时选“按我的题目写”，核对或填写题目并点击“确认素材，按这个题目写”。新稿尚未选择方式时，粘贴素材中唯一明确的作者题目会在整理后自动带入；手动选择与旧稿保留。需要公开参考时选“帮我找方向”，再“确认底稿并开始找选题”。研究只针对已选平台；缺指标样本不等于爆款。某个平台失败时，可继续成功平台，或补充设置后重试。
3. 按自己的题目写时，核对本期素材和题目依据；研究路径还需查看参考、选择或修改题目。包含公众号时选择排版样式，再核对并确认写作方案。
4. 核对各平台成稿，修改事实和表达后重新确认。下游使用已确认的最新版本。
5. 确认公众号完整排版或小红书 P1–P8；只选视频号时自动跳过排版步骤。
6. 检查发布成品。可将草稿填入已授权编辑器；也可打开排版文章、复制文案、使用图片或执行稿手动发布。
7. 由本人在平台公开发送，回到工作台登记真实链接或可验证凭证。不要把“已填入草稿”当成“已发布”。

工作台共有六个必做阶段和一个可选复盘阶段；只选视频号时少一个排版阶段。按页面实际进度继续，不要求固定五个平台或旧版 `1+2+3` 组合。

## 5. 中断、失败与修改

刷新页面后，检查恢复的素材、平台选择、标题和任务进度，不要重复新建同一任务。缺模型时先完成写作服务配置，再回到原稿继续；只有研究路径需要处理 TikOmni 配置或研究失败。按自己的题目写不会在交付时追加研究要求，单平台任务也不需要补做其他平台。结果不明确的外部操作先使用“恢复已有结果”；重新执行可能再次产生费用。不能把历史操作误标成未调用。

素材或成稿变化会使相关旧审批和下游产物失效，应重新核对后再发布。平台登录或草稿填充失败不代表本地成品消失，可使用成品中的文件和文案继续人工交付。

## 6. 复盘与验收

发布后按需补充真实指标并确认复盘结论。缺数据不补零、不生成经营效果承诺。选题对标顾问是可选能力，不阻断第一篇内容。

验收记录应包含：输入、采用的成品、人工修改时间、是否实际发布、求助次数和失败恢复情况。自动化测试、模拟客户体验和真实客户付费/续费分别记录，不相互替代。

完整规则见 [内容生产流程](docs/content-production-loop.md)、[商业交付 SOP](docs/commercial-delivery-sop.md) 和 [发布要求](RELEASE.md)。

## 7. 无账号时先看离线演示

```bash
# 必须使用专门的临时演示目录：make demo 会清空该目录。
make demo PLATFORM=all DEMO_PROJECT=/private/tmp/echo-founder-offline-demo
python3 scripts/demo.py --project /private/tmp/echo-founder-offline-demo/wechat --platform wechat --verify
python3 scripts/demo.py --project /private/tmp/echo-founder-offline-demo/xhs --platform xhs --verify
python3 scripts/demo.py --project /private/tmp/echo-founder-offline-demo/shipinhao --platform shipinhao --verify
```

也可将 `PLATFORM` 换成 `wechat`、`xhs` 或 `shipinhao`，在一个空目录创建单平台演示。省略 `PLATFORM` 的 `full` 模式只保留为旧版兼容测试，不是当前产品生产流程。

演示使用手写虚构材料，从创建时明确选择作者素材路径。程序通过现有接口模拟方案和正文确认，在项目的 `演示说明.md` 与 `demo-provenance.json` 中记录自动化性质；即使底层确认记录包含 `human_review`，也不代表真人确认。公众号保留篇幅复核提示并使用内置基础排版，小红书恰好八页，视频号提供执行稿且不创建图片任务。不会调用模型、TikOmni、外部 md2wechat API 或平台发布接口；首次安装渲染依赖仍需网络。

读取各项目的 `pipeline/package/` 可查看内容；公众号和小红书的实际文件位于 `pipeline/visual/<run-id>/publish/<revision>/`。`--verify` 只读核对当前来源、确认摘要、平台范围、图片文字与排版、所选版本完整性。

当前 CLI `delivery` 按已选平台核对文件及来源确认；旧任务保留五平台契约。上述演示必须保持 `internal_review_only`、`formal_delivery=false`、`zip_path=null`，只生成供本地检查的目录；不能将这个状态称为正式交付通过。当前生产请按前述 `/production` 工作台流程操作。`quickstart-smoke` 和 `smoke-release` 会核对这些具体边界，不将虚构演示计为客户、真人或付费验收。

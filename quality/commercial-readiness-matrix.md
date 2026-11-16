# Echo Founder 0.2.0-beta.2 商业交付矩阵

机器可读真源：[`commercial-readiness-matrix.json`](commercial-readiness-matrix.json)，schema 为 `echo-founder.commercial-capability-matrix.v1`。矩阵逐项登记所有 Next 页面、API Route Handler、Electron 运行桥、内容运行时脚本和关键项目数据契约；新增入口必须同步登记，不能只更新本文摘要。

## 状态口径

| 状态 | 含义 |
| --- | --- |
| `pass` | 真实本地链路具备实现并纳入自动化门禁 |
| `degraded` | 主能力可用，但需要人工接管、外部授权或存在明确降级路径 |
| `blocked` | 缺少外部凭据、真实账号证据、签名条件或其他交付前置条件 |
| `demo_only` | 仅显式演示或非本期本地自配交付面使用 |
| `retired` | 保留兼容入口，不再维护独立正式状态 |

## 正式页面

| 页面 | 状态 | 商业边界 |
| --- | --- | --- |
| `/` | `pass` | Echo Founder 欢迎页 |
| `/production` | `degraded` | 七阶段统一工作台；真实模型、TikOmni 与平台账号仍需验收 |
| `/materials` | `pass` | 素材库与创作档案真源，承接原 `/brain` 能力 |
| `/content-radar` | `blocked` | 需要可用 TikOmni Token 与本期已选平台的真实响应 |
| `/benchmark-advisor` | `blocked` | 需要 TikOmni 与公开账号证据 |
| `/publication-desk` | `degraded` | 可管理草稿与人工发布凭证；平台登录、验证码及风控转人工 |
| `/weekly-review` | `degraded` | 只对已确认发布和真实指标生成可确认学习 |
| `/settings` | `pass` | 本机配置、凭据状态、连接与项目管理入口 |

兼容入口 `/pipeline`、`/delivery`、`/brain`、`/twin` 分别重定向至 `/production?stage=1`、`/production?stage=4`、`/materials`、`/weekly-review`，状态为 `retired`。`/case` 与 `/closing` 仅在 `AIFIOS_ENABLE_DEMO_SURFACES=1` 时渲染，正常安装包不展示静态案例或宣传面。

## API、桌面桥与运行时

- 本地素材、创作档案、run/审批、质量、产物读取、发布结果登记和诊断 API 归为 `pass`；其中所有写操作仍须通过项目路径约束与写锁。
- 草稿、写作方案、正文中断存档与本期研究状态接口已纳入清单；研究状态只读取明确选中的任务，并核对其冻结存档，不代表当前外部连接成功。定向改稿接口因真实模型效果仍待验收，归为 `degraded`；模型测试保存本次请求结果和对应设置，不能代替生成质量或余额验收。
- 本期模型请求记录接口与 `echo.service-call.v1` 契约归为 `degraded`：写作与模型改稿可保存服务返回用量并按草稿读取；不含历史补账、完整数据采集/生图/独立对标费用，也不代表服务商实际扣费。绑定本期的写作关闭隐式重试，未知结果由作者核对后决定是否再次执行。
- 本期下载操作记录与制作成果接口归为 `degraded`：按当前稿件版本核对下载请求、确认稿、成品及作者自报的人工投入和复用；下载请求不证明文件已落盘，制作完成不等于发布，也不能据此推算节省时间、真实费用或续费。完整客户交付仍待验收。
- 模型连接、TikOmni 研究、内容雷达和对标研究归为 `blocked`，因为源码存在不能替代真实凭据与实时响应验收。
- 平台排版、草稿填充、发布台和周复盘归为 `degraded`：新任务固定使用 `stable`，公众号优先使用本机 `md2wechat` 并可自动回退到内置排版，小红书只使用本地卡片渲染器；外部编辑器登录、验证码、风控和指标完整性仍必须由人处理。生图账户设置 API 只作旧实验兼容，状态为 `retired`。
- Electron 凭据库、项目备份、安全日志、服务重启、启动恢复、主进程与 preload 归为 `pass`；发布 IPC 在任何平台副作用前由主进程从真实队列和 `runs/<run_id>.json` 安全重建任务，验证素材边界、冻结 TikOmni 证据、选题/内容/视觉/草稿人工审批及全部内容与素材 SHA-256。浏览器上传只使用同一安全文件描述符已验证字节生成的主进程私有快照，启动时会归零清理崩溃残留。每次外呼先写 `in_flight` 事务，结果持久化后才签名；崩溃恢复为不可重试的 `unknown_completion`，可重试状态也必须等待服务器队列 `attempt_count` 落账，避免并发重复外呼。平台发布桥因外部登录、验证码和风控仍为 `degraded`；托管授权相关桥不属于本地自配交付，标为 `demo_only`。
- 内容运行时质量、内容包、交付审计和状态机脚本归为 `pass`；TikOmni、公众号后台与浏览器采集脚本在未配置真实账号时为 `blocked`；平台排版脚本因外部 `md2wechat`、本地回退和人工确认边界归为 `degraded`。新任务不提供 AI 生图选项，不读取生图账户，也不调用付费图片生成服务。

## 数据闭环

闭环以同一 `run_id + slug` 连接：

`runs/<run_id>.json` → `pipeline/<step>/<slug>.md` → `pipeline/visual/<slug>/selected-assets.json` → `materials/publication/drafts/<slug>/draft-queue.json` → `materials/publication/desktop-transactions/<run_id>/<job_id>.json` → `materials/publication/ledger/<slug>/publication-ledger.json` → `materials/performance/review-inputs/<slug>.json` → `materials/weekly-review/<YYYY-Www>/learning-record.json`

发布主进程权威契约为 `echo-founder.publication-authority.v1`，持久事务为 `echo-founder.publication-transaction.v1`。内部兼容 schema 仍保留 `aifios.*` 前缀，属于工程/历史数据标识，不是外部产品品牌。备份使用 `<backup-name>.aifios-backup/manifest.json` 与对应 `data/` 数据树，schema 为 `aifios.project-backup.v1`；项目 schema 迁移前的自动备份位于 Echo Founder 用户数据目录下的 `project-backups/`。备份保留可对账的发布事务 JSON，但排除瞬态或旧版本残留 `.lock`；所有备份都不包含 API Key、Cookie、钥匙串数据、缓存、日志或构建产物。

桌面客户包只保留运行所需脚本、正式 core/optional 技能、Next 运行时、内置依赖与 Echo Founder 客户手册；内部交接文档、测试、已退休技能、构建说明、真实项目数据和构建机绝对路径由打包门禁阻断。App 必须使用 `EchoFounder.icns`，交付 manifest 只记录相对产物名或可移植路径。Package manifest 记录冻结 baseline SHA、当前 Git SHA、明确的 `dirty` 布尔值、完整 shipped runtime tree SHA-256 与真实随包依赖/许可证 inventory；DMG manifest 再绑定 package manifest 摘要、挂载后 runtime tree 与独立 `.dmg.sha256` 校验文件。自动化内测允许如实记录 `dirty=true`，正式商业门禁要求 clean source。DMG staging 仅允许当前 App、Applications 链接和中英文安装说明，旧版本 App 或其他构建产物会阻断打包。

打包 App 与 DMG 的 `open` 烟测均使用隔离 HOME、运行时动态端口和不含 Node/Python/Homebrew 的空 PATH；启动父环境先由 `env -i` 清空，传给 LaunchServices 的键不含任何 `AIFIOS_*`。这项检查用于证明首次安装会创建 `~/Echo Founder` 和品牌一致的 userData，并只使用安装包内置运行时。

## 当前商业阻断

- 2026-10-12，第18–20项经用户批准后已经实施。当前源码已应用 Next.js／eslint-config-next 16.3.8、fast-uri 3.1.8、sharp 0.35.5、source-map-js 1.2.2；当轮生产依赖审计返回0条告警，最终网页1930项、桌面模块216项检查通过。此前“升级未应用／第19项待批准”的状态已失效。见[实施与检查记录](../outputs/approved-18-20-20261012/18-20实施与内部包验收.md)。审计通过只描述当时结果，不替代真实账号或商业验收。

- 同轮 `0.2.0-beta.2` 内部 DMG 已完成12项桌面短流程、原生窗口恢复检查及30分钟持续运行：1802.8秒、60轮、481次探测、0次失败，退出后端口关闭；使用后 App 目录摘要仍一致。见[最终证据](../outputs/approved-18-20-20261012/final-delivery-proof.json)及[持续运行报告](../outputs/approved-18-20-20261012/desktop-check-reports/desktop-packaged-soak-2026-10-12-165248.json)。对应文件为 `dist/internal-20261012/Echo-Founder-0.2.0-beta.2-internal-20261012-mac-arm64.dmg`，SHA-256 为 `f3581f93e09366d64b0483f41e5724bc2921fbf3c4a34d7cba34994927876d92`。这是本机自动化内部检查，没有证明另一台干净 Mac、真人客户采用或付费成立。

- 第18–20项当时的 `quickstart-smoke`／`smoke-release` 因旧演示不满足当前来源确认规则而失败，历史报告保留。第21项将源码 CLI 的显式单平台演示改为当前三平台原生内容和虚构作者素材，记录自动化确认性质；新增视频号并验证七种选择组合。新的烟测核对来源、审批摘要、所选排版完整性和内部交付边界，实际执行结果单独记录在 `outputs/approved-21-22-20261012/`，不追改旧报告。

- 第23项将当前 CLI `delivery` 对齐已选平台、来源与确认记录；旧任务继续使用五平台契约。原生离线演示使用虚构素材和自动化确认，仍必须返回 `internal_review_only`，不能产生正式 ZIP。当前 `/production` 的文件成品与旧 CLI 正式交付包不能混为一谈。离线样稿不是模型生成或真人验收，公众号篇幅复核提示仍保留。运行时可保存待修改草稿；演示自动确认会先用当前内容包结构检查拒绝缺页，不把“保存成功”当作结构验收。

- 明确的整期内部使用限制已接入工作台、服务端执行和桌面发送入口；源码中的复制与下载已按文件所属任务附用途说明；内部、局部与未知限制，以及下载错误与复制状态切换已完成独立组件复验。图片用原文件加说明的 ZIP 承接，原图无水印；模糊措辞、具体内容是否已脱敏、真实平台编辑器与客户安装包仍需验收。本地模拟验证不代表真实平台或已安装桌面通过。桌面发送已按所选平台分别核对平台研究或作者素材记录，保留旧队列的独立完整契约；源码交叉验证与本地替身平台请求不代表真实平台草稿或完整客户交付已验收。

- 自动化门禁和真实账号验收必须分开记录。当前固定 `stable`、`md2wechat` 与本地卡片候选尚无经评审的正式商业验收 schema；自动化测试、内部验收或历史证据通过都不得描述为正式商业验收通过。未来的正式验收仍须绑定干净源码、冻结 DMG、真实账号证据和独立 QA 信任锚。
- 固定排版的内部自验使用 `echo-founder.internal-release-acceptance.v2`，可初始化九组空白观察记录，核对真实模型与费用、作者和研究路径、三平台成品、草稿、安装和恢复，并绑定同一 DMG 与 manifest。它始终输出 `commercial_ready=false`。正式命令现明确拒绝用历史 v3 或内部记录给当前候选放行；新的正式契约仍待独立评审，不能靠改 schema 名称解除。
- 当前没有 Apple Developer ID 签名与公证，只能交付内部 ad-hoc 签名测试版，首次打开可能需要 Finder 中按住 Control 选择“打开”。
- 第24项将原生小红书的排版路线与逐页证据要求分开：“方法、流程、步骤”不再单独触发数据图片要求。普通建议可本地排版；事实、研究、客户成果仍需对应来源，无法判断的断言进入复核。第23–24项新增的实际渲染、七种平台组合及目录／ZIP完整性验证记录在 `outputs/approved-23-24-20261015/`；均为自动化检查，不计为客户验收。
- `echo-founder.real-account-acceptance.v3`、配套证据和 `scripts/real_account_acceptance.py` 绑定的是旧付费生图设计，仅保留历史验证与审计语义。即使旧 v3 记录完整或已签名，也不能用于宣称当前候选已通过商业验收。
- 公开或扩大分发前，必须人工复核 TikOmni connector 授权/服务条款与 xhs-card AGPL 的源码提供、修改和网络使用义务；每个 App 的 shipped dependency inventory 会保留这些 review boundaries。
- 本期仅承诺 macOS 13+ Apple Silicon；不承诺 Intel Mac、Windows、自动公开发送、平台审核结果或经营结果。

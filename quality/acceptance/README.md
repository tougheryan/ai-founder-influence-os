# Echo Founder 验收证据

## 当前门禁状态

- 当前固定排版内部候选使用 `echo-founder.internal-release-acceptance.v2`。允许产品负责人本人验收，但始终输出 `commercial_ready=false`；保持 `non_commercial=true`、ad-hoc 签名、未公证、未公开发送。v1 生图内部记录返回 `legacy_read_only`，不能给当前流程放行。
- `echo-founder.real-account-acceptance.v3` 对应旧付费 AI 生图设计。它继续保留独立 QA、公钥和冻结产物的历史验证语义，但不能用于给当前“md2wechat 微信排版 + 本地小红书卡片”候选签发新的商业通过结论。
- 当前排版优先候选只允许内部验收；正式商业交付要等新的验收 schema 明确替代 v3，并重新执行三类真实内容与平台草稿验收。
- v2 真实账号记录保留为只读历史；正式门禁会返回 `legacy_read_only`，不会把它认作 v3 通过。

## 当前固定排版内部验收

先建立一个新的独立目录；已有目录不会覆盖：

```bash
python3 scripts/internal_release_acceptance.py --init quality/acceptance/stable-internal-current
```

命令创建 `internal-release-acceptance.json`、九份空白观察记录、`expected-facts.json` 和 `candidate/` 目录。所有观察结果均为 `pending`、事实字段均为 `null`；初始化成功只表示工作区已建立。

| 观察记录 | 实际需要核对的内容 |
| --- | --- |
| `clean_install` | 从绑定的 DMG 安装，无开发工具链启动，首次项目创建 |
| `model_and_cost` | 真实模型生成、服务用量与实际费用对账、重启后凭据状态、渲染进程不取得原始密钥 |
| `author_material_path` | 授权素材、无 TikOmni 的作者题目路径、素材变化后重新确认、旧稿重启恢复 |
| `tikomni_research` | 三平台实时研究、至少 45 条人工样本且各平台至少 15 条、无效证据不误报、已验证爆款精度 |
| `platform_native_production` | 三类真实内容的三个平台独立生成、作者修改采用、复制与下载对应确认版本 |
| `stable_layout` | 新任务固定 stable、不读生图账号且生图请求为零、完整微信 HTML 与已有授权图片、本地回退、小红书八张、视频号不创建静态图、人工采用 |
| `platform_drafts` | 三个平台各三条真实草稿、当前内容摘要匹配、没有公开发送 |
| `fault_and_backup_recovery` | 网络、凭据、登录、验证码、服务退出、重启、跨任务写入与备份恢复 |
| `frozen_dmg_runtime` | 验收期间未重建、单实例、最小环境、至少 30 分钟 soak |

执行并观察对应动作后，才填写观察时间、同一审核人编号、具体过程与结果。未知或失败不能改填通过。`expected-facts.json` 仅解释预期结果，不是证据；应按实际观察填写事实字段。

将同一个冻结内部候选的 DMG、package manifest 和 DMG manifest 放入 `candidate/`，在主记录填写它们的相对路径及 SHA-256。观察记录均绑定这个 DMG 的 SHA-256。每次观察文件更改后，主记录的对应文件摘要需要重新计算。使用 `shasum -a 256 <文件>` 核对，不填写 API Key、Cookie 或客户隐私原文。

主记录中的 `status=pass` 和 `accepted_at` 只能在全部观察完成后填写。然后运行：

```bash
python3 scripts/internal_release_acceptance.py \
  --acceptance quality/acceptance/stable-internal-current/internal-release-acceptance.json
```

检查器核对记录结构、事实预期、审核人、时间、文件摘要及 DMG 与 manifest 绑定，拒绝旧流程、重复项、缺失项、路径越界、符号链接、硬链接、版本错误和文件读取时变化。内部候选可以如实保留 `dirty=true`，但这不改变正式发布要求。该工具核对自验记录的一致性，不独立证明真实动作发生；即便 `status=pass`，仍为内部候选，不能替代独立 QA 或正式商业验收。

当前正式商业入口使用独立的版本资格检查：历史真实账号 v2/v3 记录返回 `legacy_read_only`，内部记录返回 `internal_only`；自行声明的 v4 或其他未知 schema 不被采用。新的正式契约完成独立评审前，总体状态保持 `blocked`，自动化全部通过也不会改变这一结论。

## 历史 v3 验收范围

真实账号验收必须绑定同一冻结 DMG，并包含：

1. 六组钥匙串账户与十条真实付费生图路由；不得用 Codex 登录、模拟服务或免费本地模型补足。
2. 人民币 100 元硬预算内的 10 进 3、主备冻结和一次相同资产故障切换。
3. 公众号、小红书、视频号不少于 45 条人工标注 TikOmni 样本；未来时间、零指标和缺指标误报为 0，可验证爆款精度不低于 90%。
4. 方法论、人物故事、研究分析三次真实生产；每次三个平台从共享事实底稿独立选题与生成。
5. 公众号完整 HTML、头图与正文插图；小红书恰好 P1–P8；视频号不创建静态视觉任务。
6. 三类内容各写入三个真实平台草稿，共 9 条，不点击公开发布。
7. 单平台/单图失败隔离、局部重试、重启恢复、单实例、服务恢复、备份恢复和 soak。

## 证据规则

每项正式主证据使用 `echo-founder.acceptance-evidence.v3`，引用一个 `echo-founder.acceptance-domain-artifact.v1` 领域产物。故障场景使用 `echo-founder.fault-evidence.v3`。所有路径必须相对验收目录，禁止绝对路径、`..`、符号链接、硬链接、重复路径、密钥、Cookie、客户隐私原文和本机私有路径。

付费生图证据至少绑定 benchmark ID、route ID、冻结模型 ID、operation ID、请求摘要、估算/实际费用、输出 SHA-256 与人工审核状态。TikOmni 证据至少绑定 `echo-founder.tikomni-hit-score.v5`、原始公开指标、分项得分和人工标签。

真实账号验收开始后不得重打 DMG。任何代码修改都必须重新构建，并重新执行三类完整验收。

## v3 验收工作区

`scripts/real_account_acceptance.py` 负责建立冻结绑定、收集运行时真实产物、生成证据信封，并输出供独立 QA 签名的规范字节。它不会根据人工勾选制造通过证据：`capture` 只接受与当前 `run_id + slug` 一致、由指定 producer 生成且满足强制事实断言的领域产物。

从干净提交构建并冻结候选 DMG 后初始化：

```bash
python3 scripts/real_account_acceptance.py init \
  --workspace "/absolute/path/to/real-account-current" \
  --workspace-id acceptance-workspace-001 \
  --run-id acceptance-run-001 \
  --slug acceptance-topic \
  --machine-id acceptance-machine-001 \
  --confirm-clean-machine \
  --confirm-no-preinstalled-toolchain
```

采集一项真实主证据：

```bash
python3 scripts/real_account_acceptance.py capture \
  --workspace "/absolute/path/to/real-account-current" \
  --kind material-import \
  --artifact "/absolute/path/to/material-import-domain-artifact.json" \
  --observation "独立 QA 已观察授权素材导入、成功文件保留与失败文件隔离。"
```

故障场景使用同一个 `capture` 命令并指定 `--scenario`。随时运行 `status` 查看缺失证据；源码、可信 QA 登记表、App、DMG 或 manifest 的 SHA-256 发生变化时，状态会变为 `invalidated`。

历史流程的全部 12 项主证据和 7 个故障场景通过后，可用 `finalize` 归档。第一次执行生成 `acceptance-to-sign.bin`；独立 QA 在受控环境中对该文件签名，再使用同一组参数加 `--signature <签名文件>` 完成历史记录。收集器最终显示 `historical_record_complete`，同时明确 `current_release_eligible=false`、`commercial_ready=false`；这份记录不能使当前 `make commercial-readiness-full` 通过。

桌面 App 默认读取 `<Echo Founder userData>/acceptance/real-account-current/`。开发或专用验收机可通过绝对路径环境变量 `AIFIOS_REAL_ACCOUNT_ACCEPTANCE_WORKSPACE` 指定活动工作区；该变量只保存目录位置，不包含密钥。

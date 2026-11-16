# Echo Founder 版本真源

## 当前版本

仓库根目录 [`VERSION`](../VERSION) 是判断产品版本的唯一真源，当前值为 `0.2.0-beta.2`。npm 元数据、发布脚本、质量矩阵和交付文档仍保留必要的版本镜像，但必须通过自动检查与它一致。

执行下面的命令，可以同时看到产品版本、当前源码分支与提交、工作区是否有未提交改动，以及本机 `dist/` 中最新安装包的性质：

```bash
make version
```

执行 `make version-check` 会检查 npm 元数据、发布脚本、质量矩阵和当前交付文档是否与 `VERSION` 一致。该检查也属于 `make test` 和 `make runtime-contracts`。

## 四种容易混淆的“版本”

| 类型 | 当前判断依据 | 含义 |
|---|---|---|
| 产品版本 | `VERSION` | 对外描述功能与兼容性的版本，当前为 `0.2.0-beta.2` |
| 源码版本 | Git 分支、提交 SHA、dirty 状态 | 精确说明安装包来自哪份代码；dirty 构建只能作为内部快照 |
| 安装包快照 | DMG manifest 的 `created_at` 与 `package_manifest.source_control` | 同一产品版本可以有多次内部构建，日期更新不代表正式发布 |
| 数据协议版本 | `aifios.*.v1`、`*.v4` 等 schema | 只用于数据兼容，不是产品版本，不能据此判断新旧安装包 |

`dist/friend-release-*`、`AIFIOS-0.1.*` 和 `Echo-Founder-0.1.*` 都是历史安装包。保留它们用于回溯，不作为当前安装入口。

## “最新”判定顺序

1. 先看 `VERSION`，确定当前产品线。
2. 再看 Git SHA 与 dirty 状态，确定源码是否可复现。
3. 再看同版本 manifest 的构建时间，而不是只看文件夹名称。
4. 正式交付还必须满足 `RELEASE.md` 和商业交付矩阵；`dirty=true`、文件名含 `internal` 或仅仅构建时间更新，都不等于正式发布。

## 升级版本

1. 修改 `VERSION`。
2. 同步 `ui/package.json` 与 `ui/package-lock.json`，并更新发布说明、质量矩阵和当前交付文档。
3. 执行 `make version-check`，按错误清单消除所有漂移。
4. 再执行完整发布门禁并生成新的 DMG；不要覆盖已经验收过的安装包。

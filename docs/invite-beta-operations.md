# 付费托管版与本地自配版发布手册

## 当前边界

本次版本是独立运行的本地桌面应用。每位使用者在自己的 Mac 上填写模型 API Key；需要公开样本研究时，再填写自己的 TikOmni 凭证。模型请求、研究请求、内容、项目与生成结果不会经过 AIFIOS 的统一网关。

上述是 `local-self-config` 本地自配包的边界。对外收费或按使用次数提供服务时，应改发 `hosted-license` 托管包：用户输入本人唯一授权码，首次激活绑定一台设备；同一设备可用原码恢复会话，其他设备不能使用。模型 Key、TikOmni Token、管理员 Token 只放在网关服务器。授权码、会话和设备绑定必须由网关校验，不能只在 Electron 本地判断。

安装包包含 Electron、Node、Python 与内容生产运行时。使用者不需要安装开发环境，也不需要邀请码、管理员账户或服务器地址。

## 发布顺序

1. 本地自配内测使用 `make desktop-package`；该命令不会嵌入网关地址、邀请码或任何 owner 凭证。
2. 收费分发必须使用 `make desktop-package-hosted DESKTOP_HOSTED_GATEWAY_URL=https://真实网关域名`，再使用 `make desktop-dmg-hosted`。后者会拒绝把 `local-self-config` App 制成付费 DMG。
3. 使用 `make desktop-packaged-smoke`、`make desktop-dmg-hosted` 与 `make desktop-dmg-hosted-verify` 验证最终安装包。
4. 本地自配 DMG 只发给需要自行配置 API 的内测者；付费托管 DMG 与 `docs/friend-demo-install.md` 一起发给购买者，授权码通过付款后的短信、微信或其他私密渠道单独发送。
5. 正式向外分享前完成 Apple Developer ID 签名、公证和 Gatekeeper 验证。

托管收费包改用 `make desktop-package-hosted` 构建，并在空的用户数据目录运行 `make desktop-packaged-hosted-smoke`。这个门禁会验证安装包内只有公开 HTTPS 网关地址、未激活时保持在托管授权模式、也不能通过本地 API Key 配置绕过授权。

## 日常运营

用户自行管理模型账号、TikOmni 账号和相应消耗。AIFIOS 当前的商业交付以软件使用权、版本更新或支持服务为主，不按统一网关的调用次数计费。

模型服务商、模型名称、最大输出和温度均由用户在本机设置页决定。提供安装说明与推荐配置即可，不应收集、索取或代填用户的 API Key。

托管版运营时，管理员通过网关命令创建、追加额度、撤销或补发授权码，并为每位购买者生成独立邀请码。邀请码只展示一次，可由付款系统通过短信、微信或人工私密发送；不要把管理员令牌、网关 `.env` 或服务端数据目录发给用户。用户更换电脑时使用 `invite:reissue <invite-id>`：旧设备会立即失效，新授权码继承未使用额度。当前实现按“接受的模型请求/研究请求”扣减额度，后续可在支付系统中把套餐映射到额度和到期时间。

当前网关的授权账本是受权限保护的持久化 JSON 文件，不能直接放进没有持久化磁盘的腾讯云函数实例。腾讯云正式部署应选择带持久化卷的容器/轻量云服务器，或先把账本改为 CloudBase 数据库事务；只有 API 网关和云函数而没有持久化数据库时，不能安全地发出付费托管包。

## 不能跳过的上线检查

- DMG 不包含模型 API Key、TikOmni 凭证、管理员令牌、邀请码、网关地址或签名私钥。
- 本机设置中的密钥不得出现在截图、诊断包、项目导出包或支持工单中。
- 用户设置完成后，必须通过模型连接测试；需要公开样本研究时，再验证研究连接。
- 正式向外分享前完成 Apple Developer ID 签名、公证和 Gatekeeper 验证；当前历史 DMG 不可作为对外内测包。

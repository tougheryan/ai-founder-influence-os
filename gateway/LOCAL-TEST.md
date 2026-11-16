# 本地内测授权（无需域名 / 无需 ICP 备案）

本地内测只验证 gateway 的授权功能（发码 → 激活 → 一机一码 → 防偷 session → 防重放），
不需要真实 HTTPS 域名，也不需要 Docker/Caddy。直接跑一个 loopback HTTP 服务即可。

> 代码里 `device-proof.mjs` 的 `normalizePublicOrigin()` 明确允许
> `127.0.0.1` / `localhost` 的 HTTP（仅限本地开发）。

## 前置条件

- Node.js >= 20.9（`node --version`）
- 已安装依赖（`npm ci`，仓库已有 `node_modules` 可跳过）

## 1. 配置 `gateway/.env`

```bash
cd gateway
cp .env.example .env
```

改 `.env` 里这 3 个字段，其余保持默认：

```bash
GATEWAY_PUBLIC_ORIGIN=http://127.0.0.1:8787
GATEWAY_ADMIN_TOKEN=<下面命令生成>
GATEWAY_TOKEN_PEPPER=<下面命令再生成一个不同的>
```

生成随机值（跑两次，取不同的两个）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> 说明：解耦后 gateway 只做授权，`/v1/llm/chat`（代付模型）不会被 device-bound
> 客户端调用，所以 `UPSTREAM_*` 字段随便填即可；但它们必须非空，否则
> `readGatewayConfig()` 会拒绝启动——`.env.example` 的默认值已经非空，不用动。

## 2. 启动

```bash
node --env-file=.env src/server.mjs
```

看到 `AIFIOS gateway listening on 127.0.0.1:8787` 即成功。

> 注意：本地直接跑要用 `--env-file=.env`，因为 server 没有 dotenv、
> `npm start` 不会自动读 `.env`；只有 `docker compose up` 才会通过 `env_file` 自动加载 `.env`。

## 3. 发一个真实授权码

```bash
export AIFIOS_GATEWAY_URL=http://127.0.0.1:8787
export GATEWAY_ADMIN_TOKEN=<你 .env 里的 token>

npm run invite -- invite:create --label "测试用户" --quota 50
# 输出：授权码: AIF-XXXX（只显示这一次，复制保存）
```

常用管理命令（`admin.mjs`）：

```bash
npm run invite -- invite:list                          # 列出所有授权码及状态
npm run invite -- invite:quota <invite-id> 100         # 追加额度
npm run invite -- invite:reissue <invite-id>           # 换机：旧码立即失效，新码只带剩余额度
npm run invite -- invite:revoke <invite-id>            # 吊销
```

## 4. 端到端验证「一人一机一码」

```bash
npm run verify:deployment
```

脚本会自动跑完整验证，每一条必须通过才 `PASS`：

| 验证点 | 对应诉求 |
|--------|---------|
| 用码激活 → 绑定 Ed25519 公钥 | 一码一机 |
| 同一码在第二台设备激活 → 409 拒绝 | 一码只认一台机 |
| 绑定的 key 调 `/v1/me` → 通过 | 已授权可用 |
| 偷来的 session + 另一把私钥 → 401 拒绝 | 分享 session 也没用 |
| 重放同一个签名请求 → 409 拒绝 | 防重放 |
| 管理后台状态 → `deviceProofStatus: bound` | 绑定状态落账 |

输出 `PASS gateway deployment verification (...)` 即验证通过。

## 边界说明

- 本地内测验证的是 **gateway 授权功能**。
- 「激活后配 key → 模型直连用户自己的上游」发生在打包后的 app 里，gateway 侧测不到；
  需打包 device-bound 的 app，或用 dev 模式注入
  `AIFIOS_DESKTOP_LICENSE_MODE=device-bound` 手动走一遍（`hosted-client-config.ts` 读这个环境变量）。
- 代码单测已覆盖模型直连路由：`cd ui && npx vitest run`（419 绿）。

## 回到生产部署

本地通过后，正式上线只需把 `.env` 改回生产值 + 用真实 HTTPS 域名重新打包：

```bash
# gateway/.env
GATEWAY_PUBLIC_ORIGIN=https://你的备案域名
UPSTREAM_*  # 若未来启用代付才需要真实值

# 打包（desktop_package.py 会拒绝占位/非 HTTPS 域名）
python3 scripts/desktop_package.py \
  --app-name "Echo Founder" \
  --arch universal \
  --hosted-gateway-url https://你的备案域名
```

生产部署与 Apple 签名公证见 `gateway/README.md` 与 `docs/`。

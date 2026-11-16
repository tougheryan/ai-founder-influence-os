# 生产部署清单（正式付费分发）

本地内测见 `LOCAL-TEST.md`。本文是正式上线步骤，前置条件是**域名 ICP 备案已通过**。

## 打包模式（先分清要打哪种）

| | 演示版（纯 local） | 演示版 + 打开密钥 | 付费版（device-bound） |
|---|---|---|---|
| 打包命令 | 不传授权参数 | `--demo-unlock-codes "DEMO-AAA,DEMO-BBB"` | `--hosted-gateway-url https://你的域名` |
| 授权门 | 无，装好直接配 key | 有（本地解锁码，输入才进） | 有（激活码，真一人一机一码） |
| 需要 gateway | 否 | 否 | 是（需 ICP 备案 + 服务器） |
| 防分享 | 无 | 假（码可复制，两台机器都能进） | 真（一码一机，换机要 reissue） |
| 用途 | 自测 / 内部看功能 | 给客户演示「有激活环节」 | 正式收费分发 |

- **自己 / 内部看功能** → 打纯演示版。
- **给客户演示、让对方看到「输入解锁码才能进」** → 打演示版 + 打开密钥，现在就能做，不等备案。
- **要开始收费** → 打付费版，按下面第 1~6 步走（需 ICP 备案 + 服务器 + Apple 公证）。

```bash
# 纯演示版（无任何授权门）
python3 scripts/desktop_package.py --app-name "Echo Founder" --arch universal

# 演示版 + 打开密钥（本地解锁码，看起来有激活环节，但码可复制、非真防分享）
python3 scripts/desktop_package.py --app-name "Echo Founder" --arch universal \
  --demo-unlock-codes "DEMO-AAA,DEMO-BBB"

# 付费版（真一人一机一码，域名备案 + gateway 上线后才能打）
python3 scripts/desktop_package.py --app-name "Echo Founder" --arch universal \
  --hosted-gateway-url https://你的备案域名.com
```

> ⚠️ 前两种是 local 演示版，发出去的 app 别人能直接用或复制解锁码，只用于演示/内测，别当付费版分发。

## 前置条件

1. 一台可公网访问的服务器（阿里云/腾讯云等，1C2G 足够——gateway 只做授权，不跑模型）。
2. 域名 ICP 备案通过，且 DNS A/AAAA 记录指向服务器 IP。
3. 服务器已装 Docker + Docker Compose。

## 1. 写生产 `gateway/.env`

```bash
cd gateway
cp .env.example .env
```

改 `.env` 里这些字段（其余保持默认即可）：

```bash
# ── 必填：域名（两者必须一致，且与打包时 --hosted-gateway-url 一致）──
GATEWAY_DOMAIN=你的备案域名.com
GATEWAY_PUBLIC_ORIGIN=https://你的备案域名.com

# ── 必填：随机 token（生成两次，取不同值）──
GATEWAY_ADMIN_TOKEN=<随机>
GATEWAY_TOKEN_PEPPER=<随机>

# ── 解耦后可选：以下 UPSTREAM_* / TIKOMNI_* 都不再被 device-bound 客户端调用 ──
# 只有当未来想重新启用「代付模型」时才需要填真实值；现在可留占位。
UPSTREAM_API_KEY=placeholder
UPSTREAM_BASE_URL=https://api.deepseek.com/v1
UPSTREAM_MODEL=deepseek-v4-flash
TIKOMNI_API_KEY=
GATEWAY_RESEARCH_SIGNING_PRIVATE_KEY_BASE64=
```

生成随机值：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

> ⚠️ 安全：`.env` 只放在服务器上，**不要进 git**（`.gitignore` 已排除）。
> `GATEWAY_ADMIN_TOKEN`、`GATEWAY_TOKEN_PEPPER`、`UPSTREAM_*` 泄露即意味着
> 别人能发码 / 伪造校验，务必只在服务器持有。

## 2. 启动（Docker Compose + Caddy 自动 HTTPS）

```bash
docker compose up -d --build
docker compose ps          # gateway 与 caddy 都应为 running
```

Caddy 会自动申请/续期 HTTPS 证书。首次证书签发需 1-2 分钟，等证书生效后再验证。

## 3. 验证部署（自动跑「一人一机一码」全流程）

```bash
export AIFIOS_GATEWAY_URL=https://你的备案域名.com
export GATEWAY_ADMIN_TOKEN=<你 .env 里的 token>

npm run verify:deployment
```

输出 `PASS gateway deployment verification (...)` 即部署成功。它会创建一次性码、验证
激活绑定、第二台拒绝、偷 session 拒绝、nonce 重放拒绝，然后自动撤销测试码。

## 4. 发第一个真实授权码

```bash
npm run invite -- invite:create --label "第一位付费用户" --quota 100
```

把输出的 `AIF-XXX` 码通过私聊/邮件发给用户。**码只显示这一次**，服务端只存哈希。

## 5. 用真实域名重新打包桌面 App

回到仓库根目录：

```bash
python3 scripts/desktop_package.py \
  --app-name "Echo Founder" \
  --arch universal \
  --hosted-gateway-url https://你的备案域名.com
```

打包脚本会拒绝占位域名 / 非 HTTPS 域名。之后 `scripts/desktop_dmg.py build` 生成 DMG。

## 6. Apple 签名 + 公证（正式外发前必须）

当前是 ad-hoc 签名、未公证，用户会被 Gatekeeper 拦截。正式外发需要：
- Apple Developer ID 证书（Developer ID Application）
- `codesign --deep --force --sign "Developer ID Application: ..." AIFIOS.app`
- `notarytool submit` 公证 + `stapler staple`

这是独立于 gateway 的一步，做一次之后每次打包复用即可。

## 解耦后的运维要点

- gateway **只做授权**：流量极小（每台已激活设备每请求一次 `/v1/me` 校验 + 首次激活）。
  1C2G 足够，成本可忽略。
- **不代付模型**：用户在自己的 App 里配模型 key 直连上游，你没有任何模型账单风险。
- 用户换机：`npm run invite -- invite:reissue <invite-id>`（旧码立即失效，新码只带剩余额度）。
- 用户退费/违规：`npm run invite -- invite:revoke <invite-id>`（立即吊销，所有 session 失效）。

## 备份

```bash
docker compose exec -T \
  -e GATEWAY_BACKUP_DIR=/var/lib/aifios-gateway/backups \
  gateway node scripts/backup-ledger.mjs
docker compose cp gateway:/var/lib/aifios-gateway/backups ./backups
```

ledger 只存哈希（授权码哈希、session 哈希、nonce 哈希、公钥 keyId），不存明文码、不存
用户 key、不存提示词。备份好 `gateway_data` 卷即可，恢复见 `README.md`。

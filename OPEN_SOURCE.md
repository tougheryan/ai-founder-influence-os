# 公开源码范围与第三方授权

Echo Founder 的原创界面、Electron 壳、本地内容运行时、可选网关、测试与文档以根目录 MIT 许可证公开。第三方代码保留原许可证，不能将根目录 MIT 理解为对所有随附组件重新授权。

| 路径 | 来源与许可证 |
| --- | --- |
| `skills/xhs-card/` | [op7418/guizang-social-card-skill](https://github.com/op7418/guizang-social-card-skill)，AGPL-3.0-only，原文见该目录 LICENSE；保留完整组件源码和修改说明。 |
| `skills/baoyu-diagram/`、`skills/baoyu-comic/` | [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills)，MIT，保留原作者版权声明。 |
| `skills/wechat-writer/` 的上游部分 | [KKKKhazix/khazix-skills](https://github.com/KKKKhazix/khazix-skills)，MIT，原声明保存在该目录 LICENSE；Echo Founder 增加了身份隔离和平台内容约束。 |
| npm 依赖 | 按各自的 LICENSE/NOTICE 使用，由 lockfile 固定版本；本仓库不提交 node_modules。 |

## 不包含的内容

- API Key、Cookie、凭据库、浏览器登录状态及私人素材、项目、发布数据。
- 本机生成的报告、构建缓存、安装包或未经公开验收的 App。
- DBS 提示词和样式文件、未核实再分发授权的可选风格包、历史个人风格样本与内部试用记录。
- TikOmni 服务、账号、返回数据，以及来源尚未完成核对的本机连接器快照。官方 SDK 声明 MIT，但本机快照与该发布版本有三处文件差异。按自有题目写作不依赖这部分；研究功能需要使用者自行取得服务与连接器授权。

`skills/dbs-wechat-html/` 的路径为兼容旧项目保留，公开版内为 Echo Founder 新编写的 MIT 基础排版器，不包含 DBS 上游的实现或模板。可选的 DBS 工具应从[原作者仓库](https://github.com/dontbesilent2025/dbskill)单独获取并遵守其当前条款，核心创作流程不要求安装它。

本次公开的是源码开发版。已有历史 Git 提交和早期插件资料仍可用于追溯；第三方历史内容不因本次 MIT 声明而获得新的授权。当前公开版不代表已完成桌面安装包签名、公证或真实账号商业验收。

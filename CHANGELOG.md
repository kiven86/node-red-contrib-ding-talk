# 更新日志

本文件既是版本变更记录，也是「传到 npm / GitHub 的发布清单」。
每次发版：先改这里的版本段，再照「上传步骤」执行。

---

## 版本对照

| 版本 | 日期 | 内容 |
|---|---|---|
| **2.1.1** | 2026-11-14 | 待发布。卡片回调直连刷新、ID 速查、文本/图片发送补全，仓库私有信息清理 |
| 2.1.0 | 2026-11-13 | 新增文本/图片发送节点、ID 速查台账 |
| 2.0.0 | 2026-11-13 | 整体重写：Stream 长连接 + 互动卡片全链路 |
| 1.0.4 | 2025-06-25 | 初版，仅 webhook 发文本、Stream 收文本 |

---

## 2.1.1

### 一句话

从 1.0.4 的「只能发文本」，变成一套完整的钉钉机器人节点组：收消息、发卡片、收按钮回调、原地刷新卡片、发文本/图片，全程出站长连接，不需要公网 IP。

### 新增

- **钉钉连接**（配置节点）——凭证与唯一的 Stream 连接，所有节点共用；断线按 1s→2s→4s… 指数退避重连，上限 60s 带抖动
- **接收消息**——群内 @机器人、单聊；永不空应答（否则钉钉 60s 后重推，流程会跑两遍），并对 messageId 做 5 分钟去重
- **接收卡片回调**——先应答再送下游；ack 默认不带 `cardData`，避免覆盖卡片变量
- **发送卡片 / 更新卡片**——投递互动卡片、按 `outTrackId` 原地刷新变量
- **更新卡片**支持直接接「接收卡片回调」——把按钮动作写进指定变量（可配 `agree=✅ 已通过` 这样的文案映射），不用中间加 function
- **发送文本 / 发送图片**（OpenAPI）——群发与单聊；图片支持本地路径、内网 URL、data URI、base64、Buffer，非公网源自动「下载→上传」换 mediaId
- **ID 速查**——自动攒 `conversationId` 与 `userid`，内置网页 `GET /dingtalk/ids`，带搜索和复制按钮；发送节点的群 ID 输入框支持自动补全
- 9 个节点的图标、帮助文本、状态灯（连上即绿灯并显示累计回调数）

### 修复

- 重连不再固定 1s 死循环，改为指数退避 + 抖动
- 接收消息的输出保留完整会话上下文（`conversationId`、`senderStaffId`、`sessionWebhook`），不再只剩 `payload`
- 状态判断不再依赖 `registered`（钉钉空闲时不发这个帧，节点会永远黄灯）
- 私网图片 URL 不再「返回成功但群里裂图」——自动转上传
- base64 图片按文件头识别，不再按长度阈值误判
- 「更新卡片」直连回调时报 `msg.payload 不是合法 JSON`，改为按动作回写或给出可读的修复指引

### 破坏性变更（相对 1.0.4）

- **凭证位置变了**：从每个节点里填，改为统一的「钉钉连接」配置节点。旧 flow 里的接收节点需要重新选连接
- **运行环境**：Node-RED ≥ 3.0，Node.js ≥ 18（用到原生 `fetch`）
- `dingTalk-send`（webhook 发文本）**保持完全兼容**，旧 flow 不用改

### 从 1.0.4 升级

1. 节点管理里更新到 2.1.1（或 `npm install node-red-contrib-ding-talk@latest`）
2. 新建一个「钉钉连接」配置节点，填 Client ID / Client Secret / Robot Code（Robot Code 通常等于 Client ID）
3. 旧的 webhook 发送节点原样保留，不用动
4. 如果旧 flow 里配过机器人接收，删掉重配，改用新的「接收消息」节点

### 仓库卫生（本次整理）

- 移除了所有内网痕迹：NAS 路径、`192.168.x.x`、容器名、真实群 ID 与卡片模板 ID
- 测试脚本的凭证改为从 `.env` 或环境变量读，仓库内**没有任何硬编码密钥**
- 新增 `.env.example`（`.env` 本身在 `.gitignore` 里，不会进库也不随 npm 包发布）
- 一次性调试脚本归入 `test/probes/`，`test/` 只留可离线跑的回归测试

---

## 发布前检查清单

| 检查项 | 命令 / 位置 |
|---|---|
| npm 登录的是 `kiven86` | `npm whoami` |
| 版本号大于已发布的 1.0.4 | `package.json` → `version` |
| 离线测试全绿 | `npm test`（另有 `send-test` / `card-update-test` / `id-book-test`） |
| 打包清单正确，不含 `test/` 与 `.env` | `npm pack --dry-run` |
| 仓库里没有凭证 | `git grep -nE "clientSecret\|/volume\|192\.168\."` |
| GitHub 已推送并打了 tag | `git push --tags` |

预期打包含 **29 个文件、约 48 kB**：`lib/`、`nodes/`、`examples/`、`README.md`、`LICENSE`、`package.json`。

---

## 上传步骤

### 1. 先推 GitHub

```bash
cd node-red-contrib-ding-talk
git add -A
git commit -m "release: 2.1.1"
git tag -a v2.1.1 -m "2.1.1"
git push origin main --tags
```

先推 GitHub 再发 npm：`package.json` 里的 `repository` 会写进包元数据，npm 页面直接显示源码链接。反过来发，链接会指向还不存在的仓库。

### 2. 再发 npm

```bash
npm test                    # 最后一遍
npm pack --dry-run          # 看清单
npm publish                 # 开了 2FA 会要验证码：npm publish --otp=123456
```

### 3. 刷新 Node-RED 插件库

包已在库里（`flows.nodered.org/node/node-red-contrib-ding-talk`），不需要重新提交：

1. 登录 https://flows.nodered.org
2. 打开包页面，底部点 **request refresh**

库是人工/定时处理的，通常几小时到一天。这期间 `npm install` 已经能装到新版本，只是库页面显示旧号。

---

## 发布后验证

```bash
npm view node-red-contrib-ding-talk version    # 应为 2.1.1
```

- npm 页面能看到 Repository 链接、README 徽章
- Node-RED 面板「节点管理 → 安装」搜 `ding-talk`，9 个节点齐全
- 老用户升级：节点管理 → 可更新 → 点 update

---

## 回滚

超过 72 小时的版本**不能删除**（npm 规定，且可能已被依赖）。出问题时的正确做法：

```bash
# 标记某版本有问题，安装时给出警告
npm deprecate node-red-contrib-ding-talk@2.1.1 "此版本存在 xxx 问题，请用 2.1.0"

# 然后尽快发 2.1.2 修复
```

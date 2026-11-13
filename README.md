# node-red-contrib-ding-talk

[![npm version](https://img.shields.io/npm/v/node-red-contrib-ding-talk.svg)](https://www.npmjs.com/package/node-red-contrib-ding-talk)
[![npm downloads](https://img.shields.io/npm/dm/node-red-contrib-ding-talk.svg)](https://www.npmjs.com/package/node-red-contrib-ding-talk)
[![license](https://img.shields.io/npm/l/node-red-contrib-ding-talk.svg)](LICENSE)

钉钉机器人在 Node-RED 里的完整节点组：**Stream 长连接收消息 + 互动卡片发送 + 按钮回调 + 卡片原地刷新**。
全程出站长连接，**不需要公网 IP、不需要证书、不需要内网穿透**。

v2.0.0 相对 v1.0.4 是重写：v1 只能通过 webhook 发文本、通过 Stream 收文本，卡片这条链路完全没有。

---

## 节点一览

| 节点 | 类型名 | 作用 |
|---|---|---|
| 钉钉连接 | `dingtalk-robot` | **配置节点**：凭证 + 唯一的 Stream 连接 |
| 接收消息 | `dingtalk-receive` | 收群内 @机器人 / 单聊 |
| 接收卡片回调 | `dingtalk-card-receive` | 收互动卡片按钮点击 |
| 发送卡片 | `dingtalk-card-send` | 把互动卡片投递到群 |
| 更新卡片 | `dingtalk-card-update` | 原地刷新已发出的卡片 |
| 发送文本 | `dingtalk-send-text` | **OpenAPI** 发文本 / Markdown 到群或单聊 |
| 发送图片 | `dingtalk-send-image` | **OpenAPI** 发图片，本地文件自动上传换 mediaId |
| ID 速查 | `dingtalk-id-book` | 自动攒群 ID / userid，网页里搜、点一下复制 |
| 发送文本（webhook） | `dingTalk-send` | 群自定义机器人 webhook 发文本（与 v1 完全兼容） |

> 两个「发送文本」的区别：`dingtalk-send-text` 需要「钉钉连接」配置，能发到机器人所在的**任意**群和单聊，也能 @ 人；
> `dingTalk-send`（webhook）只认一个 token，只能发到绑定的那一个群。新流程优先用前者。

---

## 安装

**从 npm 安装（推荐）**——在「节点管理 → 安装」里搜 `ding-talk`，或者：

```bash
cd ~/.node-red
npm install node-red-contrib-ding-talk
```

**从源码安装**（改了代码、想马上生效时）：

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-ding-talk
```

Docker 部署时这两条命令要在容器内执行，`~/.node-red` 对应镜像里的 `/data`；
装完重启 Node-RED。

> 依赖只有 `ws`，Node-RED 官方镜像已自带。Node 版本需 ≥ 18（用到原生 `fetch`）。

---

## 首次配置

在钉钉开放平台（<https://open-dev.dingtalk.com>）准备：

1. **创建应用** → 企业内部应用 → 机器人
2. 「凭证与基础信息」取 **Client ID**（AppKey）、**Client Secret**（AppSecret）
3. 「机器人」页把**消息接收模式设为 Stream 模式**（这一步不做，长连上收不到任何消息）
4. 「权限管理」勾选：机器人接收消息、互动卡片相关权限
5. **发布上线**（企业内部应用也要走一次发布，否则权限不生效）
6. 把机器人**拉进目标群**（发卡片不会自动进群）

然后在 Node-RED 里拖一个「钉钉连接」配置节点，填入凭证和 Robot Code。

### 卡片模板

卡片模板在开放平台「卡片平台」创建，节点只引用模板 ID（形如 `xxxx.schema`）。

模板里定义的变量名，就是代码里传的 `cardParamMap` 的 key。例如模板有两个变量 `title`、`status`，则：

```js
msg.cardParamMap = { title: '统计数据', status: '待确认' };
```

按钮需要开启**回调**（不是跳转链接），并给按钮的 `value` 填业务参数，例如 `{"action":"confirm","id":"123"}`，
点击后能在 `msg.dingtalk.params` 里原样拿到。

---

## 怎么找 conversationId 和 userid

这两个是配节点时唯一需要手填的东西，也是最烦的地方。先说结论：**都只能靠「会话事件」拿，钉钉没有任何控制台能查。**

### conversationId（形如 `cidXXXXXX==`）

- 群里**唯一来源**是有人 @ 机器人 或 单聊机器人时推送的消息体，字段 `conversationId`
- 开放平台的「应用详情」「机器人配置」里都看不到
- 群自定义机器人的 webhook URL 里那个 `access_token` **不是** conversationId，两者不能互转

一个群只要有人 @ 一次，这个 ID 就永久固定，抄下来存着就行。

### userid（就是 `senderStaffId`，不是手机号、不是昵称）

| 途径 | 拿到什么 | 前提 |
|---|---|---|
| 对方 @ 机器人 / 单聊机器人 | `senderStaffId` = 他的 userid | 无，最省事 |
| 「接收消息」节点输出的 `msg.dingtalk.senderStaffId` | 同上 | 同上 |
| 通讯录 API `POST /topapi/v2/user/getbymobile` | 传手机号 → 返回 `userid` | 应用需勾「通讯录个人信息读权限」 |
| 通讯录 API `POST /topapi/v2/user/list` | 传 `dept_id` → 返回该部门所有人 | 需「通讯录部门信息读权限」 |
| 钉钉管理后台 → 通讯录 → 成员详情 | 页面上能看图标的 userid | 管理员账号 |

外部联系人、非本企业成员可能没有 `staffId`，只能靠手机号或 openId 走别的接口。

### 本包的做法：自动记账 + 网页速查

「接收消息」节点默认勾选**自动记录 ID**，每收到一条消息就把
「群名 ↔ conversationId」「昵称 ↔ userid」写进 `userDir/dingtalk-ids.json`。然后：

- 浏览器打开 `http://<nas>:1880/dingtalk/ids` —— 带搜索框、每行有复制按钮
- 「发送文本 / 发送图片 / 发送卡片」的群 ID、接收人输入框会**自动补全**（下拉里显示群名/昵称）
- 也支持在 flow 里查：`msg.payload = "运维"` 送进「ID 速查」节点，输出 `{ conversations, users }`

不需要这功能就取消勾选，不会写任何文件。

---

## 典型流程

```
[接收消息] → [组装变量] → [发送卡片]
                                ↓ 用户点按钮
[接收卡片回调] → [干活] → [更新卡片]
```

导入 `examples/basic-flow.json` 可以直接看到这套骨架。

**「接收消息」→「发送卡片」的关键衔接**：前者输出的 `msg.dingtalk.conversationId` 就是后者需要的群 ID，
「发送卡片」节点会自动从 `msg.conversationId` / `msg.dingtalk.conversationId` 取，不用手工填群 ID。

---

## 各节点输入输出

### 接收消息 `dingtalk-receive`

输出：

| 字段 | 说明 |
|---|---|
| `msg.payload` | 消息文本（已 trim） |
| `msg.dingtalk.conversationId` | 群会话 ID，发卡片要用 |
| `msg.dingtalk.conversationType` | `1` 单聊、`2` 群聊 |
| `msg.dingtalk.senderNick` / `senderStaffId` | 发送人 |
| `msg.dingtalk.sessionWebhook` | 临时回复地址，2 小时内有效 |
| `msg.dingtalk.raw` | 钉钉原始消息体 |

自动回复可用 `{{content}}` `{{senderNick}}` `{{conversationId}}` 占位符，**默认关闭**。
需要回富文本时关掉自动回复，用 `sessionWebhook` 自己 POST。

### 发送卡片 `dingtalk-card-send`

输入（按优先级）：

| 字段 | 说明 |
|---|---|
| `msg.cardParamMap` | 卡片变量（优先） |
| `msg.payload` | 对象或 JSON 字符串，作为卡片变量 |
| `msg.conversationId` | 目标群；也认 `msg.dingtalk.conversationId` |
| `msg.outTrackId` | 可选，不传则自动生成 |
| `msg.cardTemplateId` | 可选，覆盖节点里配的模板 |

输出：`msg.outTrackId`、`msg.dingtalk.result`。

### 接收卡片回调 `dingtalk-card-receive`

输出：

| 字段 | 说明 |
|---|---|
| `msg.payload` | 按钮的 `actionId`（或 `params.action`） |
| `msg.outTrackId` | 卡片实例 ID，接「更新卡片」用 |
| `msg.dingtalk.userId` | 点击人 |
| `msg.dingtalk.actionIds` | 所有被点的按钮 ID |
| `msg.dingtalk.params` | 按钮 `value` 里的业务参数 |
| `msg.dingtalk.raw` | 原始回调体 |

### 更新卡片 `dingtalk-card-update`

输入 `msg.outTrackId` + `msg.payload`/`msg.cardParamMap`，输出 `msg.dingtalk.updateResult`。

### 发送文本 `dingtalk-send-text`

| 输入 | 说明 |
|---|---|
| `msg.payload` | 文本内容，对象会自动 JSON 化 |
| `msg.conversationId` | 群 ID，接「接收消息」的输出最省事 |
| `msg.userIds` | 单聊接收人 userid，数组或逗号字符串 |
| `msg.title` | Markdown 在会话列表里的摘要，留空自动取首行 |
| `msg.atUserIds` / `msg.atAll` | @ 指定人 / @所有人 |

输出 `msg.dingtalk = { ok, target, msgKey, result }`。

目标判定顺序：`msg.conversationId` > `msg.userIds` > 节点配置。节点里的「发送到」设成 `auto` 即可，
两者都存在时优先发群——**想强制单聊就把「发送到」改成「单聊」**。

### 发送图片 `dingtalk-send-image`

`msg.payload` 支持五种形态，节点自己认出是哪种：

| 形态 | 例子 | 处理方式 |
|---|---|---|
| 本地绝对路径 | `/data/chart.png` | 读文件 → 上传 → mediaId |
| http(s) URL | `https://example.com/a.png` | 公网直传；内网自动下载后上传 |
| data URI | `data:image/png;base64,...` | 解码 → 上传 |
| 纯 base64 | `iVBORw0KG...` | 解出来能识别成图片才认 |
| Buffer | 上游 HTTP 请求节点的 `arrayBuffer` | 直接上传 |

输出 `msg.dingtalk = { ok, target, mediaId, photoURL, source, result }`，
`source` 会告诉你走的是哪条路（`本地→上传` / `URL直传` / `内网URL→上传`）。

**为什么本地图片必须先上传**：钉钉图片消息（`msgKey=sampleImageMsg`）的 `photoURL` 只接受
「公网可访问的完整 URL」或「上传后拿到的 mediaId」。塞一个本地路径进去，钉钉会原样当 URL 去取，
结果是群里一张裂图或不显示——而且**接口返回 success**，很容易以为发成功了。

同理，**内网 URL 也不行**：`http://192.168.1.10/a.png` 钉钉服务器根本访问不到。
`urlMode=auto` 会自动识别私网地址并改成「下载→上传」，公网地址才直传。

### ID 速查 `dingtalk-id-book`

两种用法，同一个节点：

| 模式 | 接法 | 行为 |
|---|---|---|
| `record`（默认） | 「接收消息」→ 本节点 → 下游 | 记录 ID，`msg` 原样透传，不影响原链路 |
| `query` | inject 一个关键词 | 模糊查台账，输出结果不记录 |

输入（`query` 模式）：`msg.payload` 传关键词字符串，空格分词表示「都要命中」；
`msg.payload = { action: "clear" }` 清空台账。

输出：`msg.payload = { conversations: [...], users: [...] }`，`msg.text` 是给人看的纯文本清单。

HTTP 端点（挂在 Node-RED 的 httpNode 上）：

| 路径 | 作用 |
|---|---|
| `GET /dingtalk/ids` | 网页版速查，带搜索和复制按钮 |
| `GET /dingtalk/ids.json?q=关键词` | 同样的数据，JSON |
| `POST /dingtalk/ids/clear` | 清空 |

数据存 `userDir/dingtalk-ids.json`（写入有 800ms 防抖，1 秒内连收多条消息只写一次盘），
最多保留 2000 条，超出按最近使用时间淘汰。`userDir` 就是 Node-RED 的用户目录
（通常是 `~/.node-red`，Docker 官方镜像里是 `/data`）。

---

## 设计上的几个决定（都是踩坑换来的）

### 1. 连接只建一次

钉钉对同一个 Client ID 的回调是**抢占消费**：多条连接并存时，同一条回调只投给其中一条，且不保证固定。
所以 `DWClient` 只在「钉钉连接」配置节点里创建一次，所有业务节点向它注册 topic，共用一条 WebSocket。

**不要给同一套凭证建两个配置节点，也不要在另一台机器上跑同一份凭证。**

### 2. 回调先应答，再送下游

钉钉等不到应答会在约 60 秒后重推同一条消息。
所以「接收卡片回调」节点在收到当刻就 ack，然后才 `node.send()`——即使下游流程要跑几分钟，也不会重复触发。

同时按 `messageId` 做了 5 分钟去重，网络抖动导致的重推不会让流程跑两遍。

### 3. ack 默认不回写 cardData

应答里带 `cardData` 时，钉钉会拿它**覆盖**卡片变量；只传一部分就会把其余字段清空。
所以默认只回 `{ outTrackId }`，卡片保持原样。要改卡片请用「更新卡片」节点显式更新。

（如果确实想在点击瞬间就改文案，勾选「点击后立即回写卡片」并填 JSON 模板。）

### 4. 重连有指数退避

1s → 2s → 4s … 上限 60s，带 ±50% 抖动。
v1 的实现里 `reconnectInterval` 恒为 1000 且从不递增，断线后会每秒重连一次无限循环。

### 5. 心跳 8 秒

WebSocket ping/pong，与官方 SDK 一致。
上一轮连接连续 ping 不通会主动 `terminate()` 触发重连——**没有应用层心跳时，服务端会静默失效而 TCP 仍是 ESTABLISHED**，
表现为「连接看着好好的，但按钮点了没反应」。

---

## 排错

| 现象 | 原因 |
|---|---|
| 节点显示「已连接，等待订阅生效」一直不变 | 开放平台没把消息接收模式设为 **Stream**，或应用没发布上线 |
| 点按钮完全没反应 | 卡片模板的按钮没开回调；或按钮配成了跳转链接 |
| 同一个按钮被处理两次 | 应答没发出去（Stream 断开时会发生），看日志有没有「回调应答发送失败」 |
| 提示「缺少 Robot Code」 | 发卡片到群必须带 robotCode，在连接配置里填 |
| 卡片发出去了但变量是空的 | `cardParamMap` 的 key 和模板变量名对不上 |
| 两个群用同一个 outTrackId | 钉钉按 outTrackId 幂等，第二个群不会刷新；每个群要各自生成 |

开连接配置里的「输出 Stream 调试日志」可以看到握手、订阅、心跳、断线重连全过程。

---

## 与 v1.0.4 的差异

| | v1.0.4 | v2.0.0 |
|---|---|---|
| 收消息 | ✅ | ✅ 额外输出 conversationId 等完整字段 |
| 发文本（webhook） | ✅ | ✅ 行为不变 |
| 发互动卡片 | ❌ | ✅ |
| 卡片按钮回调 | ❌ | ✅ |
| 更新卡片 | ❌ | ✅ |
| 每节点一条连接 | 是（会抢回调） | 否，全局一条 |
| 重连退避 | 无（每秒重连） | 指数退避 + 抖动 |
| 回调去重 | 无 | messageId 5 分钟窗口 |
| secret 存储 | 明文在 flows.json | credentials 加密存储 |

老 flow 里的「钉钉通知」节点（`dingTalk-send`）不需要改动，升级后照常用。

## 实测记录（2026-11-13，真实应用 + 真实群验证）

以下内容不是文档抄来的，是用真实凭证跑出来的，可直接对照排错。

### 1. 回调里的 data 是双层字符串

`msg.data` 是 **JSON 字符串**，里面的 `content` 还是 **JSON 字符串**，要解析两层才拿到按钮参数：

```json
{
  "type": "actionCallback",
  "userId": "020958414332327253",
  "outTrackId": "e2e-mwf3tpy9",
  "spaceId": "cidnnlpy…==",
  "content": "{\"cardPrivateData\":{\"actionIds\":[\"agree\"],\"params\":{\"action\":\"agree\"}}}"
}
```

节点已处理，`msg.payload` 直接就是 `agree` / `reject`。自己写代码解析时漏掉第二层，会得到一堆 `undefined`。

### 2. 按钮参数在 `params`，不在 `actionParamList`

实测这张模板回的是 `params: { action: "agree" }`。代码里两种形态都兼容了（`actionParamList` 会合并进 `params`）。

### 3. REGISTERED 帧基本收不到，别拿它判断死活

用生产 AppKey 做对照：空闲 20 秒 **零帧**，`registered` 始终 false，而生产按钮正常。

所以判断订阅是否生效只有一条可靠证据——**收到过回调**。节点状态已按此显示（`已连接 · 已收 N 条`）。

### 4. 三种消息都要应答，否则 60 秒后重推

- 卡片回调：应答 `{ outTrackId }`，**不要**带 `cardData`（会覆盖卡片变量）
- 机器人消息：没配自动回复时也要回空包 `{}`，否则同一条消息会重推、流程跑两遍
- 实测应答后 6 次点击产生 6 条独立 messageId，无重推

### 5. 机器人消息拿到的关键字段

```json
{
  "conversationId": "cidJRgL2…",     // 发卡片到这个会话要用它
  "conversationType": "1",           // 1 单聊，2 群聊
  "senderStaffId": "020958…",        // 操作人 userid，做白名单用这个
  "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=…"
}
```

`sessionWebhook` 2 小时内有效，回复快问快答比走 OpenAPI 省事；过期就得用「发送卡片/文本」节点。

### 6. robotCode 填错的表现

`invalidParameter.robotCode.notExsit`。注意这个报错发生在**发消息/发卡片**时，Stream 连接阶段完全正常，很容易误判成权限问题。机器人应用的 robotCode 通常**等于 AppKey**。

---

## 版本与许可

变更记录见 [CHANGELOG.md](CHANGELOG.md)。本项目使用 MIT 许可，见 [LICENSE](LICENSE)。

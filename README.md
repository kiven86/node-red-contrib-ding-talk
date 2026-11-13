# node-red-contrib-ding-talk

[![npm version](https://img.shields.io/npm/v/node-red-contrib-ding-talk.svg)](https://www.npmjs.com/package/node-red-contrib-ding-talk)
[![license](https://img.shields.io/npm/l/node-red-contrib-ding-talk.svg)](LICENSE)

钉钉机器人的 Node-RED 节点组。支持通过 Stream 长连接接收群消息与卡片回调、发送和原地更新互动卡片、发送文本与图片。

只建立出站 WebSocket 连接，不需要公网 IP、域名或证书。

## 节点

| 节点 | 类型名 | 说明 |
|---|---|---|
| 钉钉连接 | `dingtalk-robot` | 配置节点，保存凭证并维护唯一的长连接 |
| 接收消息 | `dingtalk-receive` | 接收群内 @机器人 和单聊消息 |
| 接收卡片回调 | `dingtalk-card-receive` | 接收互动卡片的按钮点击 |
| 发送卡片 | `dingtalk-card-send` | 向群投递互动卡片 |
| 更新卡片 | `dingtalk-card-update` | 更新已发出卡片的变量 |
| 发送文本 | `dingtalk-send-text` | 通过 OpenAPI 发送文本或 Markdown，支持群聊与单聊 |
| 发送图片 | `dingtalk-send-image` | 通过 OpenAPI 发送图片，本地文件自动上传 |
| ID 速查 | `dingtalk-id-book` | 记录群 ID 与 userid，提供网页查询 |
| 发送文本（webhook） | `dingTalk-send` | 群自定义机器人 webhook 发文本，与旧版本兼容 |

`dingtalk-send-text` 使用「钉钉连接」的凭证，可以发到机器人所在的任意群和单聊，也能 @ 人。
`dingTalk-send` 只使用一个固定 webhook token，只能发到绑定的那个群。新流程建议用前者。

## 安装

环境要求：Node-RED 3.0 及以上，Node.js 18 及以上。依赖只有 `ws`，Node-RED 官方镜像已包含。

从 npm 安装：

```bash
cd ~/.node-red
npm install node-red-contrib-ding-talk
```

从本地源码安装：

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-ding-talk
```

Docker 部署时在容器内执行，`~/.node-red` 对应镜像中的 `/data`。安装完成后重启 Node-RED。

## 配置

在钉钉开放平台（<https://open-dev.dingtalk.com>）完成以下准备：

1. 创建企业内部应用，添加机器人能力
2. 在「凭证与基础信息」获取 Client ID（AppKey）和 Client Secret（AppSecret）
3. 在「机器人」页面把消息接收模式设为 Stream 模式
4. 在「权限管理」勾选机器人接收消息、互动卡片相关权限
5. 发布应用，企业内部应用也需要发布后权限才生效
6. 把机器人加入目标群

然后在 Node-RED 中拖入「钉钉连接」节点，填写：

| 字段 | 说明 |
|---|---|
| Client ID | 应用的 AppKey |
| Client Secret | 应用的 AppSecret |
| Robot Code | 机器人编码，通常与 Client ID 相同 |
| 输出 Stream 调试日志 | 排错时开启，可看到握手、订阅、心跳与重连过程 |

同一套凭证只能有一个连接。多个配置节点或跨机器使用同一份凭证会导致回调被随机分流。

## 卡片模板

卡片模板在开放平台「卡片平台」创建，节点只引用模板 ID（形如 `xxxx.schema`）。

模板中定义的变量名即 `cardParamMap` 的 key。例如模板定义了 `title` 和 `status` 两个变量：

```js
msg.cardParamMap = { title: '统计数据', status: '待确认' };
```

按钮需要开启回调（不是跳转链接），并在按钮的 `value` 中填写业务参数，例如 `{"action":"confirm","id":"123"}`。
点击后这些参数会出现在 `msg.dingtalk.params` 中。

钉钉不校验变量名。名称写错或漏传不会报错，对应位置渲染为空。

## conversationId 与 userid

这两个值无法在开放平台控制台查询，只能从会话事件中获取。

### conversationId

格式为 `cidXXXXXX==`，来源是机器人收到的消息中的 `conversationId` 字段，即群里有人 @机器人 或有人单聊机器人时。

应用详情和机器人配置页面都不提供这个值。群自定义机器人 webhook URL 中的 `access_token` 与它无关，不能互相转换。

一个群被 @ 过一次后，该 ID 固定不变。

### userid

即消息中的 `senderStaffId`，不是手机号，也不是昵称。

| 途径 | 结果 | 前提 |
|---|---|---|
| 对方 @机器人 或单聊机器人 | `senderStaffId` 即其 userid | 无 |
| 「接收消息」节点输出的 `msg.dingtalk.senderStaffId` | 同上 | 同上 |
| `POST /topapi/v2/user/getbymobile` | 手机号 → userid | 通讯录个人信息读权限 |
| `POST /topapi/v2/user/list` | 部门 ID → 该部门成员 | 通讯录部门信息读权限 |
| 钉钉管理后台 → 通讯录 → 成员详情 | 页面显示 userid | 管理员账号 |

外部联系人和非本企业成员可能没有 `staffId`，需要通过手机号或 openId 使用其他接口。

### 自动记录

「接收消息」节点默认勾选「自动记录 ID」，每收到一条消息就把「群名 ↔ conversationId」「昵称 ↔ userid」写入 `userDir/dingtalk-ids.json`。

- 浏览器打开 `http://<node-red 地址>:1880/dingtalk/ids` 可搜索并复制
- 「发送文本」「发送图片」「发送卡片」的群 ID 与接收人输入框支持自动补全
- 取消勾选后不写入任何文件

## 节点参考

### 接收消息 dingtalk-receive

输出：

| 字段 | 说明 |
|---|---|
| `msg.payload` | 消息文本 |
| `msg.dingtalk.conversationId` | 会话 ID，发送卡片时使用 |
| `msg.dingtalk.conversationType` | `1` 单聊，`2` 群聊 |
| `msg.dingtalk.senderNick` / `senderStaffId` | 发送人昵称与 userid |
| `msg.dingtalk.sessionWebhook` | 临时回复地址，2 小时内有效 |
| `msg.dingtalk.raw` | 钉钉原始消息体 |

自动回复支持 `{{content}}`、`{{senderNick}}`、`{{conversationId}}` 占位符，默认关闭。需要回复富文本时关闭自动回复，改用 `sessionWebhook` 自行请求。

### 发送卡片 dingtalk-card-send

输入，按优先级取值：

| 字段 | 说明 |
|---|---|
| `msg.cardParamMap` | 卡片变量 |
| `msg.payload` | 对象或 JSON 字符串，作为卡片变量 |
| `msg.conversationId` | 目标群，也识别 `msg.dingtalk.conversationId` |
| `msg.outTrackId` | 可选，不传则自动生成 |
| `msg.cardTemplateId` | 可选，覆盖节点中配置的模板 |

输出 `msg.outTrackId` 与 `msg.dingtalk.result`。

### 接收卡片回调 dingtalk-card-receive

输出：

| 字段 | 说明 |
|---|---|
| `msg.payload` | 按钮的 `actionId` 或 `params.action` |
| `msg.outTrackId` | 卡片实例 ID，供「更新卡片」使用 |
| `msg.dingtalk.userId` | 点击人 userid |
| `msg.dingtalk.actionIds` | 所有被点击的按钮 ID |
| `msg.dingtalk.params` | 按钮 `value` 中的业务参数 |
| `msg.dingtalk.raw` | 原始回调体 |

同一 `messageId` 在 5 分钟内只处理一次。

勾选「点击后立即回写卡片」可在应答中直接更新卡片变量，填写 JSON 模板即可，例如：

```json
{"status":"处理中","operator":"{{userId}}"}
```

可用占位符：`{{outTrackId}}`、`{{actionId}}`、`{{actionParam}}`、`{{userId}}`，以及按钮 `value` 中的任意字段。

### 更新卡片 dingtalk-card-update

输入 `msg.outTrackId`，以及 `msg.payload` 或 `msg.cardParamMap`，输出 `msg.dingtalk.updateResult`。

可直接连接「接收卡片回调」节点。此时 `msg.payload` 是按钮动作字符串，需要在节点中填写「动作写入变量」指定写入的变量名，并可用「动作文案」把动作转换为显示文本，例如 `agree=已通过,reject=已驳回`。

### 发送文本 dingtalk-send-text

| 输入 | 说明 |
|---|---|
| `msg.payload` | 文本内容，对象会转为 JSON |
| `msg.conversationId` | 群 ID |
| `msg.userIds` | 单聊接收人 userid，数组或逗号分隔字符串 |
| `msg.title` | Markdown 在会话列表中的摘要，留空取首行 |
| `msg.atUserIds` / `msg.atAll` | @ 指定人或 @所有人 |

输出 `msg.dingtalk = { ok, target, msgKey, result }`。

目标判定顺序为 `msg.conversationId` > `msg.userIds` > 节点配置。节点中的「发送到」设为 `auto` 即可；两者同时存在时优先发群，需要强制单聊时把「发送到」改为「单聊」。

### 发送图片 dingtalk-send-image

`msg.payload` 支持五种形式，节点自动识别：

| 形式 | 示例 | 处理方式 |
|---|---|---|
| 本地绝对路径 | `/data/chart.png` | 读取文件 → 上传 → mediaId |
| http(s) URL | `https://example.com/a.png` | 公网地址直接传递；内网地址先下载再上传 |
| data URI | `data:image/png;base64,...` | 解码 → 上传 |
| base64 字符串 | `iVBORw0KG...` | 识别为图片格式后上传 |
| Buffer | 上游 HTTP 请求节点的 `arrayBuffer` | 直接上传 |

输出 `msg.dingtalk = { ok, target, mediaId, photoURL, source, result }`，`source` 表示实际使用的路径：`本地→上传`、`URL直传` 或 `内网URL→上传`。

钉钉图片消息的 `photoURL` 只接受公网可访问的 URL 或上传后得到的 mediaId。传入本地路径或内网地址（如 `http://192.168.1.10/a.png`）时接口仍返回成功，但消息中显示为裂图。

### ID 速查 dingtalk-id-book

| 模式 | 接法 | 行为 |
|---|---|---|
| `record`（默认） | 「接收消息」→ 本节点 → 下游 | 记录 ID，消息原样透传 |
| `query` | inject 一个关键词 | 模糊查询，不记录 |

`query` 模式下 `msg.payload` 传关键词字符串，空格分词表示需全部命中；`msg.payload = { action: "clear" }` 清空记录。

输出 `msg.payload = { conversations, users }`，`msg.text` 为纯文本清单。

HTTP 端点：

| 路径 | 作用 |
|---|---|
| `GET /dingtalk/ids` | 网页查询，支持搜索与复制 |
| `GET /dingtalk/ids.json?q=关键词` | JSON 格式 |
| `POST /dingtalk/ids/clear` | 清空 |

数据保存在 `userDir/dingtalk-ids.json`，写入有 800ms 防抖，最多保留 2000 条，超出后按最近使用时间淘汰。

## 示例流程

```
[接收消息] → [组装变量] → [发送卡片]
                             ↓ 用户点击按钮
[接收卡片回调] → [处理业务] → [更新卡片]
```

`examples/basic-flow.json` 提供上述骨架，`examples/card-interaction.json` 提供按钮回调与卡片更新的完整连线。

「接收消息」输出的 `msg.dingtalk.conversationId` 可直接作为「发送卡片」的目标群，节点会自动读取 `msg.conversationId` 或 `msg.dingtalk.conversationId`。

## 已知行为

- 回调需要在收到时立即应答，否则钉钉约 60 秒后重推同一消息。接收类节点已内置应答与去重
- 卡片应答中携带 `cardData` 会覆盖卡片变量，只传部分字段会导致其余字段清空。节点默认只回 `outTrackId`
- 钉钉按 `outTrackId` 幂等，同一个 `outTrackId` 发往两个群时第二个群不会更新，每个群需各自生成
- 连接状态以是否收到过回调为准。钉钉在空闲时不发送 REGISTERED 帧，`registered` 字段不可作为判断依据
- 断线重连采用 1s 至 60s 的指数退避，带随机抖动

## 常见问题

| 现象 | 排查方向 |
|---|---|
| 节点显示未连接或一直等待订阅 | 消息接收模式是否设为 Stream，应用是否已发布上线 |
| 点击按钮无反应 | 卡片模板的按钮是否开启回调，是否误配为跳转链接 |
| 同一按钮被执行两次 | 检查日志中是否有应答发送失败，通常是 Stream 曾断开 |
| 提示缺少 Robot Code | 向群发送卡片必须提供 robotCode，在连接配置中填写 |
| 卡片发出后变量为空 | `cardParamMap` 的 key 与模板变量名不一致 |
| 提示 `invalidParameter.robotCode.notExsit` | Robot Code 填写错误，该错误发生在发送阶段，连接阶段仍正常 |

## 许可

MIT，见 [LICENSE](LICENSE)。版本变更见 [CHANGELOG.md](CHANGELOG.md)。

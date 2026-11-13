# 联调脚本

需要真实钉钉凭证，不在 `npm test` 的自动回归范围内。凭证从仓库根目录的 `.env` 读取，
字段见根目录 `.env.example`；也可以按脚本注释直接传凭证文件路径。

运行时要在仓库根目录执行，例如：

```
node test/probes/cred-check.js
```

| 脚本 | 用途 | 什么时候用 |
|---|---|---|
| `cred-check.js` | 依次验证 accessToken、机器人信息、群列表、发消息四关 | 首次配置后确认凭证和权限是否齐全 |
| `watch-callback.js` | 连上 Stream，把收到的每条回调解析后打印 | 点了卡片按钮没反应，确认回调有没有推下来 |
| `raw-frames.js` | 把 Stream 网关下发的原始帧原样打印 | 怀疑服务端没下发，或客户端解析漏了字段 |
| `probe-card-template.js` | 查询卡片模板的变量定义 | 不确定模板里变量名，需要 `Card.Template.ReadWrite.All` 权限 |
| `live-send-test.js` | 真实发送单聊/群聊的文本与图片 | 验证发送链路，会真的发出消息 |
| `e2e-harness.js` | 桩 RED 环境加载节点，走一遍真实回调 | 改动节点代码后做端到端验证 |

共同约定：

- 都会打印结果摘要，不打印凭证原文
- `live-send-test.js`、`watch-callback.js`、`e2e-harness.js` 会在群里产生真实消息，测试完需要撤回
- 凭证只放 `.env`，该文件已在 `.gitignore` 中

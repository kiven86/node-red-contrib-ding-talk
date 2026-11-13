'use strict';

/**
 * 官方 SDK 对照测试：用同一套新凭证，看官方实现能否收到 REGISTERED。
 * 目的是区分「我们自己客户端的问题」与「钉钉侧应用配置的问题」。
 *
 * 用法：node test/probes/official-check.js 凭证文件
 */

const fs = require('node:fs');

let DWClient;
let TOPIC_ROBOT;
let TOPIC_CARD;
try {
  ({ DWClient, TOPIC_ROBOT, TOPIC_CARD } = require('dingtalk-stream'));
} catch {
  console.error('需要官方 SDK 做对照：npm install --no-save dingtalk-stream');
  process.exit(2);
}

const cred = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const client = new DWClient({
  clientId: cred.clientId,
  clientSecret: cred.clientSecret,
  keepAlive: true,
  debug: true,
});

client.registerCallbackListener(TOPIC_ROBOT, (res) => {
  console.log('[回调] 机器人消息', res.headers && res.headers.messageId);
  client.socketCallBackResponse(res.headers.messageId, { status: 'SUCCESS' });
});
client.registerCallbackListener(TOPIC_CARD, (res) => {
  console.log('[回调] 卡片按钮', res.headers && res.headers.messageId);
  client.socketCallBackResponse(res.headers.messageId, { status: 'SUCCESS' });
});

const t0 = Date.now();
const tick = setInterval(() => {
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] connected=${client.connected} registered=${client.registered}`
  );
}, 5000);

(async () => {
  try {
    await client.connect();
    console.log('connect() 返回，connected =', client.connected);
  } catch (err) {
    console.log('connect 失败：', err.message);
  }

  // 观察 30 秒
  await new Promise((r) => setTimeout(r, 30000));

  console.log('\n=== 官方 SDK 结论 ===');
  console.log('connected  =', client.connected);
  console.log('registered =', client.registered);
  console.log('订阅       =', JSON.stringify(client.config && client.config.subscriptions));

  clearInterval(tick);
  try {
    client.disconnect();
  } catch {
    /* 忽略 */
  }
  process.exit(0);
})();

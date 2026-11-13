'use strict';

/**
 * 回调监听器：连上新 AppKey 的 Stream，把收到的每条回调解出来打印。
 * 用于「现在去群里 @ 一下 / 回复机器人私聊」这种人工配合的验证。
 *
 * 用法：node test/probes/watch-callback.js 凭证文件 [秒数]
 */

const fs = require('node:fs');
const { DWClient } = require('../../lib/client');
const { TOPIC } = require('../../lib/constants');

const cred = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const seconds = Number(process.argv[3] || 600);

const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;

const client = new DWClient({
  clientId: cred.clientId,
  clientSecret: cred.clientSecret,
  keepAlive: true,
});

client.addSubscription('CALLBACK', TOPIC.ROBOT);
client.addSubscription('CALLBACK', TOPIC.CARD);

client.on('connected', () => console.log(`${ts()} 已连接 Stream，等待回调…`));
client.on('disconnected', (e) => console.log(`${ts()} 连接断开 code=${e.code}`));
client.on('reconnecting', (e) => console.log(`${ts()} 将在 ${e.delay}ms 后重连`));
client.on('reconnected', () => console.log(`${ts()} 已重连`));
client.on('error', (err) => console.log(`${ts()} 错误: ${err.message}`));

client.on('callback', (msg) => {
  const h = msg.headers || {};
  const d = msg.data || {};
  console.log(`\n${ts()} ===== 收到回调 =====`);
  console.log(`  topic       ${h.topic}`);
  console.log(`  messageId   ${h.messageId}`);
  console.log(`  contentType ${h.contentType}`);
  console.log(`  data        ${JSON.stringify(d).slice(0, 1500)}`);

  // 机器人消息：把关键字段单独拎出来
  if (h.topic === TOPIC.ROBOT) {
    console.log(`  conversationId ${d.conversationId}`);
    console.log(`  conversationType ${d.conversationType}`);
    console.log(`  senderStaffId ${d.senderStaffId}`);
    console.log(`  senderNick ${d.senderNick}`);
    console.log(`  msgtype ${d.msgtype}`);
    if (d.text) console.log(`  text ${d.text.content}`);
  }

  // 卡片回调：按钮参数在这里
  if (h.topic === TOPIC.CARD) {
    const p = d.cardPrivateData || {};
    console.log(`  outTrackId ${p.outTrackId || d.outTrackId}`);
    console.log(`  userId ${d.userId}`);
    console.log(`  actionParamList ${JSON.stringify(p.actionParamList || [])}`);
  }

  // 先应答，避免钉钉 60 秒后重推
  const ack =
    h.topic === TOPIC.CARD
      ? { outTrackId: (d.cardPrivateData && d.cardPrivateData.outTrackId) || d.outTrackId }
      : { status: 'SUCCESS' };
  client.socketCallBackResponse(h.messageId, ack);
  console.log(`  -> 已应答 ${JSON.stringify(ack).slice(0, 120)}`);
});

(async () => {
  try {
    await client.connect();
  } catch (err) {
    console.log('连接失败：' + err.message);
    process.exit(1);
  }

  setTimeout(() => {
    console.log(`\n${ts()} 监听结束（${seconds}s）`);
    client.disconnect();
    setTimeout(() => process.exit(0), 300);
  }, seconds * 1000);
})();

'use strict';

/**
 * 端到端验证台：用真实的节点代码（nodes/*.js）+ 真实 Stream 连接，
 * 只把 Node-RED 运行时替换成桩，验证「回调 → 节点解析 → node.send 输出」整条链路。
 *
 * 会往群里投一张新测试卡片，然后等按钮点击 / 私聊回复。
 *
 * 用法：node test/probes/e2e-harness.js 凭证文件 [秒数]
 */

const fs = require('node:fs');
const EventEmitter = require('node:events');
const { DWClient } = require('../../lib/client');
const { TOPIC } = require('../../lib/constants');
const openapi = require('../../lib/openapi');

const cred = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const seconds = Number(process.argv[3] || 600);

/* ---------------- 从 .env 取模板与群 ---------------- */
const env = require('../load-env')();

/* ---------------- Node-RED 运行时桩 ---------------- */
const types = {};
const outputs = [];

function makeNode(node, config) {
  Object.setPrototypeOf(node, EventEmitter.prototype);
  EventEmitter.call(node);
  node.id = 'test-' + Math.random().toString(36).slice(2, 7);
  node.name = (config && config.name) || '';
  node.status = (s) => console.log(`  [status] ${JSON.stringify(s)}`);
  node.log = (...a) => console.log('  [log]', ...a);
  node.warn = (...a) => console.log('  [warn]', ...a);
  node.error = (...a) => console.log('  [error]', ...a);
  node.debug = (...a) => {
    if (process.env.DEBUG === '1') console.log('  [debug]', ...a);
  };
  node.send = (out) => {
    outputs.push(out);
    console.log('\n  >>> node.send 输出 >>>');
    console.log(
      JSON.stringify(
        {
          payload: out && out.payload,
          topic: out && out.topic,
          dingtalk: out && out.dingtalk,
        },
        null,
        2
      )
    );
    console.log('  <<< 输出结束 <<<\n');
  };
}

const cfgNode = new EventEmitter();
Object.assign(cfgNode, {
  clientId: cred.clientId,
  clientSecret: cred.clientSecret,
  robotCode: cred.robotCode,
  streamStats: () => client.stats(),
  getAccessToken: (force) => openapi.getAccessToken(cred.clientId, cred.clientSecret, force),
});

const handlers = new Map();
cfgNode.registerHandler = (topic, fn) => {
  if (!handlers.has(topic)) handlers.set(topic, new Set());
  handlers.get(topic).add(fn);
};
cfgNode.unregisterHandler = (topic, fn) => {
  const s = handlers.get(topic);
  if (s) s.delete(fn);
};
cfgNode.ackCallback = (messageId, value) => client.socketCallBackResponse(messageId, value);

const RED = {
  nodes: {
    createNode: makeNode,
    getNode: (id) => (id === 'cfg1' ? cfgNode : null),
    registerType: (name, ctor) => {
      types[name] = ctor;
    },
  },
};

require('../../nodes/card-receive')(RED);
require('../../nodes/receive')(RED);

/* ---------------- 真实连接 ---------------- */
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;

const client = new DWClient({
  clientId: cred.clientId,
  clientSecret: cred.clientSecret,
  keepAlive: true,
});

client.addSubscription('CALLBACK', TOPIC.CARD);
client.addSubscription('CALLBACK', TOPIC.ROBOT);

client.on('connected', () => console.log(`${ts()} Stream 已连接`));
client.on('disconnected', (e) => console.log(`${ts()} 断开 code=${e.code}`));
client.on('reconnecting', (e) => console.log(`${ts()} ${e.delay}ms 后重连`));
client.on('reconnected', () => console.log(`${ts()} 已重连`));
client.on('error', (e) => console.log(`${ts()} 错误 ${e.message}`));

// 与 config 节点里完全一致的分发逻辑
client.on('callback', (msg) => {
  const topic = msg.headers && msg.headers.topic;
  console.log(`\n${ts()} ===== 原始回调 ${topic} =====`);
  const set = handlers.get(topic);
  if (!set || !set.size) {
    console.log('  没有节点订阅该 topic');
    return;
  }
  for (const fn of set) fn(msg);
});

(async () => {
  await client.connect();

  // 装载节点实例
  new types['dingtalk-card-receive']({ config: 'cfg1' });
  new types['dingtalk-receive']({ config: 'cfg1' });
  console.log(`${ts()} 节点已装载：${Object.keys(types).join(', ')}`);

  // 投一张新卡片
  const outTrackId = 'e2e-' + Date.now().toString(36);
  try {
    await openapi.createAndDeliverCard({
      clientId: cred.clientId,
      clientSecret: cred.clientSecret,
      cardTemplateId: env.CARD_TEMPLATE_ID,
      outTrackId,
      openConversationId: env.OPEN_CONVERSATION_ID,
      robotCode: cred.robotCode,
      title: '【E2E 测试】点按钮验证回调',
      cardParamMap: {
        cardTitle: '【E2E 测试】请点下面任意按钮',
        deviceName: 'Node-RED 端到端验证',
        mac: '00:00:00:00:00:00',
        ip: '127.0.0.1',
        connectTime: new Date().toLocaleString('zh-CN'),
        decisionTime: '',
        status: '等待点击…',
      },
    });
    console.log(`${ts()} 测试卡片已投递 outTrackId=${outTrackId}`);
  } catch (err) {
    console.log(`${ts()} 投卡失败：${err.message}`);
  }

  console.log(`${ts()} 等待回调中（${seconds}s）…`);

  setTimeout(() => {
    console.log(`\n${ts()} ===== 监听结束，共收到 ${outputs.length} 条节点输出 =====`);
    client.disconnect();
    setTimeout(() => process.exit(0), 300);
  }, seconds * 1000);
})().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});

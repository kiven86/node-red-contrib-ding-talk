'use strict';

/**
 * Stream 客户端的离线验收测试。
 * 用假的 ws / fetch 驱动，不连钉钉、不消耗真实凭证。
 * 覆盖的是这次改造的四个关键点：连接、订阅生效、回调分发、应答帧格式。
 */

const assert = require('node:assert');
const EventEmitter = require('node:events');

/* ---------- 1. mock ws ---------- */
const wsPath = require.resolve('ws');
const instances = [];

class FakeWS extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.sent = [];
    instances.push(this);
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  ping() {}
  close() {
    this.emit('close', 1000, 'normal');
  }
  terminate() {
    this.emit('close', 1006, 'terminate');
  }
  fireOpen() {
    this.emit('open');
  }
  fireMessage(obj) {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
}
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWS };

/* ---------- 2. mock fetch ---------- */
let endpointOk = true;
global.fetch = async (url) => {
  if (String(url).includes('/gateway/connections/open')) {
    if (!endpointOk) {
      return { ok: false, status: 500, text: async () => '{"code":"InvalidAuthentication","message":"bad"}' };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ endpoint: 'wss://gw.test/connect', ticket: 'TICKET-1' }),
    };
  }
  return { ok: true, status: 200, text: async () => '{}' };
};

const { DWClient } = require('../lib/client');
const { TOPIC } = require('../lib/constants');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(['PASS', name, '']);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
}

async function main() {
  /* --- 订阅去重 --- */
  const c = new DWClient({ clientId: 'id', clientSecret: 'sec', debug: false });
  c.addSubscription('CALLBACK', TOPIC.CARD);
  c.addSubscription('CALLBACK', TOPIC.CARD);
  check('同 type+topic 不重复添加', () => {
    assert.strictEqual(c.subscriptions.filter((s) => s.topic === TOPIC.CARD).length, 1);
  });

  /* --- 连接 --- */
  const callbacks = [];
  c.on('callback', (m) => callbacks.push(m));

  const p = c.connect();
  await new Promise((r) => setTimeout(r, 30)); // 等 _getEndpoint 完成
  check('已创建 WebSocket', () => assert.strictEqual(instances.length, 1));
  const ws = instances[0];
  check('wss 地址带 ticket', () => assert.ok(ws.url.includes('ticket=TICKET-1')));

  ws.fireOpen();
  await p;
  check('open 后 connected=true', () => assert.strictEqual(c.connected, true));

  /* --- 订阅生效 --- */
  ws.fireMessage({ type: 'SYSTEM', headers: { topic: 'CONNECTED' } });
  check('收到 CONNECTED 仍算未生效', () => assert.strictEqual(c.registered, false));
  ws.fireMessage({ type: 'SYSTEM', headers: { topic: 'REGISTERED' } });
  check('收到 REGISTERED 后 registered=true', () => assert.strictEqual(c.registered, true));

  /* --- 回调分发 --- */
  const cardFrame = {
    type: 'CALLBACK',
    headers: { topic: TOPIC.CARD, messageId: 'msg-1', contentType: 'application/json' },
    data: JSON.stringify({
      outTrackId: 'nr-abc',
      userId: 'u123',
      content: JSON.stringify({ cardPrivateData: { actionIds: ['confirm'], params: { action: 'confirm' } } }),
    }),
  };
  ws.fireMessage(cardFrame);
  check('卡片回调被分发', () => assert.strictEqual(callbacks.length, 1));
  check('回调保留 messageId 与 topic', () => {
    assert.strictEqual(callbacks[0].headers.messageId, 'msg-1');
    assert.strictEqual(callbacks[0].headers.topic, TOPIC.CARD);
  });

  /* --- 应答帧 --- */
  c.socketCallBackResponse('msg-1', { outTrackId: 'nr-abc' });
  const ack = ws.sent[ws.sent.length - 1];
  check('应答帧 code=200', () => assert.strictEqual(ack.code, 200));
  check('应答帧带回 messageId', () => assert.strictEqual(ack.headers.messageId, 'msg-1'));
  check('应答 data 是 JSON 字符串', () => {
    assert.deepStrictEqual(JSON.parse(ack.data), { outTrackId: 'nr-abc' });
  });

  /* --- 空 messageId 不应发送 --- */
  const before = ws.sent.length;
  const r = c.socketCallBackResponse('', { a: 1 });
  check('空 messageId 不发帧', () => {
    assert.strictEqual(r, false);
    assert.strictEqual(ws.sent.length, before);
  });

  /* --- 主动断开后不再重连 --- */
  c.disconnect();
  check('disconnect 后 connected=false', () => assert.strictEqual(c.connected, false));
  check('disconnect 后无重连定时器', () => assert.strictEqual(c.reconnectTimer, null));

  /* --- 网关拒绝时 connect 必须 reject（v1 这里是静默成功） --- */
  endpointOk = false;
  const c2 = new DWClient({ clientId: 'id2', clientSecret: 'sec2' });
  let rejected = false;
  try {
    await c2.connect();
  } catch (err) {
    rejected = /Stream 网关拒绝/.test(err.message);
  }
  check('网关失败时 connect 抛错', () => assert.strictEqual(rejected, true));

  /* --- 退避上限 --- */
  const c3 = new DWClient({ clientId: 'id3', clientSecret: 'sec3' });
  c3.backoff = 60000;
  c3._scheduleReconnect(1006, 'test');
  check('退避不超过 60s', () => assert.ok(c3.backoff <= 60000));
  c3.disconnect();

  /* --- 输出 --- */
  console.log('');
  let failed = 0;
  for (const [st, name, msg] of results) {
    if (st === 'FAIL') failed++;
    console.log(`${st === 'PASS' ? '  ✅' : '  ❌'} ${name}${msg ? ` — ${msg}` : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试脚本异常：', err);
  process.exit(2);
});

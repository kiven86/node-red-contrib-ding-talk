'use strict';

/**
 * 原始帧抓包：直接连 Stream 网关，把收到的每一个帧原样打印。
 * 用来判断「服务端根本没有下发」还是「我们解析漏了」。
 *
 * 用法：node test/raw-frames.js /tmp/dt-cred.json [秒数]
 */

const fs = require('node:fs');
const WebSocket = require('ws');

const cred = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const seconds = Number(process.argv[3] || 45);

const GATEWAY = 'https://api.dingtalk.com/v1.0/gateway/connections/open';

(async () => {
  const body = {
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
    ua: 'raw-probe/1.0',
    subscriptions: [
      { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' },
      { type: 'CALLBACK', topic: '/v1.0/card/instances/callback' },
    ],
  };

  const t0 = Date.now();
  const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  console.log(`${ts()} 网关 HTTP ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!data.endpoint || !data.ticket) process.exit(1);

  const url = `${data.endpoint}?ticket=${encodeURIComponent(data.ticket)}`;
  const ws = new WebSocket(url);

  const frameCount = { total: 0, system: 0, callback: 0, event: 0 };

  ws.on('open', () => console.log(`${ts()} socket open`));
  ws.on('pong', () => console.log(`${ts()} pong`));

  ws.on('message', (raw) => {
    frameCount.total++;
    const str = String(raw);
    let m = null;
    try {
      m = JSON.parse(str);
    } catch {
      console.log(`${ts()} 非 JSON 帧: ${str.slice(0, 200)}`);
      return;
    }
    const type = m.type || '(无 type)';
    const topic = m.headers && m.headers.topic;
    if (type === 'SYSTEM') frameCount.system++;
    else if (type === 'CALLBACK') frameCount.callback++;
    else if (type === 'EVENT') frameCount.event++;

    console.log(`${ts()} ${type} topic=${topic} len=${str.length}`);

    // 服务端 ping 要按协议回 200，否则会被判定掉线
    if (type === 'SYSTEM' && topic === 'ping') {
      ws.send(
        JSON.stringify({ code: 200, headers: m.headers, message: 'OK', data: m.data })
      );
      console.log(`${ts()}   -> 已回 ping`);
    }
  });

  ws.on('error', (err) => console.log(`${ts()} socket error: ${err.message}`));
  ws.on('close', (code, reason) =>
    console.log(`${ts()} socket close code=${code} reason=${String(reason || '')}`)
  );

  setTimeout(() => {
    console.log('\n=== 帧统计 ===');
    console.log(JSON.stringify(frameCount));
    console.log(`${seconds} 秒内收到 ${frameCount.total} 个帧`);
    if (frameCount.total === 0) {
      console.log('一个帧都没收到 —— 连接是通的但没有下行数据，');
      console.log('说明钉钉侧没有把这条连接纳入订阅（应用配置或权限问题）。');
    }
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
    process.exit(0);
  }, seconds * 1000);
})();

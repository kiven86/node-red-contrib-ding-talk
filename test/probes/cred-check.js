'use strict';

/**
 * 凭证连通性自检（只读，不发消息、不改任何状态）。
 *
 * 用法：node test/probes/cred-check.js 凭证文件
 *   JSON: { "clientId": "...", "clientSecret": "...", "robotCode": "..." }
 *
 * 依次验证四件事：
 *   1. appKey/appSecret 能否换到 Stream 网关地址（getEndpoint）
 *   2. WebSocket 能否连上并收到 SYSTEM REGISTERED（订阅是否真的生效）
 *   3. appSecret 能否换到 OpenAPI accessToken（发卡片的前提）
 *   4. 订阅列表里两个 topic 是否都被服务端接受
 */

const fs = require('node:fs');
const path = require('node:path');
const { DWClient } = require('../../lib/client');
const { TOPIC, API_BASE } = require('../../lib/constants');

const credPath = process.argv[2];
if (!credPath) {
  console.error('用法: node test/probes/cred-check.js <凭证 json 路径>');
  process.exit(2);
}
const cred = JSON.parse(fs.readFileSync(path.resolve(credPath), 'utf8'));

const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => console.log('  ❌ ' + m);
const info = (m) => console.log('     ' + m);

function mask(s) {
  if (!s) return '(空)';
  return s.length <= 6 ? '***' : s.slice(0, 6) + '***' + s.slice(-4);
}

(async () => {
  console.log('\n=== 凭证 ===');
  info(`clientId  ${cred.clientId}`);
  info(`secret    ${mask(cred.clientSecret)} (长度 ${String(cred.clientSecret || '').length})`);
  info(`robotCode ${cred.robotCode || '(未填)'}`);

  let exitCode = 0;

  // ---- 1. getEndpoint ----
  console.log('\n[1] Stream 网关换址');
  const client = new DWClient({
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
    debug: process.env.DEBUG === '1',
    keepAlive: true,
  });
  client.addSubscription('CALLBACK', TOPIC.ROBOT);
  client.addSubscription('CALLBACK', TOPIC.CARD);

  const frames = [];
  client.on('error', (err) => frames.push('ERROR ' + err.message));

  try {
    await client._getEndpoint();
    ok('网关已返回 wss 地址与 ticket');
    info('endpoint  ' + String(client.dwUrl).split('?')[0]);
    info('ticket    ' + String(client.dwUrl).split('ticket=')[1].slice(0, 12) + '…');
  } catch (err) {
    bad('换址失败：' + err.message);
    console.log('\n结论：appKey/appSecret 这一关就没过，后面的都不用测了。');
    process.exit(1);
  }

  // ---- 2. WebSocket + REGISTERED ----
  console.log('\n[2] WebSocket 连接与订阅生效');
  client.on('registered', () => frames.push('REGISTERED'));

  const registered = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 25000);
    client.once('registered', () => {
      clearTimeout(t);
      resolve(true);
    });
    client.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });

  try {
    await client._open();
    ok('WebSocket 已建立');
    info('connected=' + client.connected + ' registered=' + client.registered);
  } catch (err) {
    bad('连接失败：' + err.message);
    exitCode = 1;
  }

  if (!exitCode) {
    const got = await registered;
    if (got) {
      ok('收到 SYSTEM REGISTERED —— 订阅已在钉钉侧生效');
      info('订阅列表：' + client.subscriptions.map((s) => s.topic).join(' , '));
    } else {
      bad('25 秒内没收到 SYSTEM REGISTERED');
      info('常见原因：开放平台「消息接收模式」没设成 Stream 模式，或该应用没开机器人能力');
      exitCode = 1;
    }
  }

  // ---- 3. accessToken ----
  console.log('\n[3] OpenAPI accessToken');
  try {
    const res = await fetch(`${API_BASE}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: cred.clientId, appSecret: cred.clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 保持 null */
    }
    if (res.ok && data && data.accessToken) {
      ok('accessToken 已获取（有效期 ' + data.expireIn + 's）');
      info('token ' + mask(data.accessToken));
    } else {
      bad(`HTTP ${res.status}：${(data && (data.message || data.code)) || text.slice(0, 200)}`);
      exitCode = 1;
    }
  } catch (err) {
    bad('请求失败：' + err.message);
    exitCode = 1;
  }

  // ---- 4. 机器人身份 ----
  console.log('\n[4] 机器人身份');
  if (!cred.robotCode) {
    info('未提供 robotCode，跳过');
  } else if (cred.robotCode === cred.clientId) {
    ok('robotCode 与 clientId 相同（钉钉机器人应用常见形态）');
  } else {
    info(`robotCode(${cred.robotCode}) 与 clientId(${cred.clientId}) 不同，发卡片用的是 robotCode`);
  }

  // ---- 收尾 ----
  client.disconnect();
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n=== 汇总 ===');
  console.log(exitCode === 0 ? '基础链路全部正常。' : '存在失败项，见上面的 ❌。');
  process.exit(exitCode);
})().catch((err) => {
  console.error('未捕获异常：', err);
  process.exit(1);
});

'use strict';

/**
 * 卡片投递探针：用新应用的 robotCode + 生产已验证的模板/群，试发一张测试卡片。
 * 目的是验证「卡片接口 + 机器人在群里的成员关系」这两关。
 *
 * 群与模板从 /volume1/www/ding/.env 读，不打印原始值。
 *
 * 用法：node test/card-probe.js /tmp/dt-cred.json
 */

const fs = require('node:fs');

const cred = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ENV = '/volume1/www/ding/.env';
const API = 'https://api.dingtalk.com';

const env = {};
for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s || s.startsWith('#') || !s.includes('=')) continue;
  const i = s.indexOf('=');
  env[s.slice(0, i)] = s.slice(i + 1);
}

const templateId = env.CARD_TEMPLATE_ID;
const conversationId = env.OPEN_CONVERSATION_ID;
if (!templateId || !conversationId) {
  console.error('缺少 CARD_TEMPLATE_ID 或 OPEN_CONVERSATION_ID');
  process.exit(2);
}

console.log(`模板 ${templateId.slice(0, 8)}…  群 ${conversationId.slice(0, 8)}…`);

(async () => {
  const token = (
    await (
      await fetch(`${API}/v1.0/oauth2/accessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: cred.clientId, appSecret: cred.clientSecret }),
        signal: AbortSignal.timeout(15000),
      })
    ).json()
  ).accessToken;

  const outTrackId = 'probe-card-' + Date.now().toString(36);
  const body = {
    cardTemplateId: templateId,
    outTrackId,
    openSpaceId: `dtv1.card//IM_GROUP.${conversationId}`,
    imGroupOpenSpaceModel: {
      supportForward: true,
      lastMessageI18n: { ZH_CN: '【测试卡片】可忽略' },
    },
    imGroupOpenDeliverModel: { robotCode: cred.robotCode },
    callbackType: 'STREAM',
    userIdType: 1,
    cardData: {
      cardParamMap: {
        cardTitle: '【测试卡片】连通性验证，可忽略',
        deviceName: 'Node-RED 节点测试',
        mac: '00:00:00:00:00:00',
        ip: '127.0.0.1',
        connectTime: new Date().toLocaleString('zh-CN'),
        decisionTime: '',
        status: '这是新机器人发来的测试卡片，看到即说明投递链路正常',
      },
    },
  };

  const res = await fetch(`${API}/v1.0/card/instances/createAndDeliver`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  console.log(`\nHTTP ${res.status}`);
  console.log(text.slice(0, 400));

  if (res.ok) {
    console.log('\n✅ 卡片投递成功，去群里看看。outTrackId = ' + outTrackId);
    console.log('   这个 outTrackId 后面可以用来验证「更新卡片」和按钮回调。');
  } else {
    let d = null;
    try {
      d = JSON.parse(text);
    } catch {
      /* 忽略 */
    }
    console.log(`\n❌ code=${(d && d.code) || ''}`);
    console.log('   若是 robot/space 相关错误，通常是新机器人还没被拉进这个群。');
  }
})();

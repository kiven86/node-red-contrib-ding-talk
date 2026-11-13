'use strict';

/** 卡片原地更新探针：PUT /v1.0/card/instances 改 probe 卡片的文案。
 *  用法：node test/update-probe.js /tmp/dt-cred.json <outTrackId>
 */

const fs = require('node:fs');

const cred = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outTrackId = process.argv[3];
if (!outTrackId) {
  console.error('用法: node test/update-probe.js <凭证json> <outTrackId>');
  process.exit(2);
}

const API = 'https://api.dingtalk.com';

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

  const res = await fetch(`${API}/v1.0/card/instances`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token,
    },
    body: JSON.stringify({
      outTrackId,
      cardData: {
        cardParamMap: {
          status: '✅ 更新成功——卡片已原地刷新（' + new Date().toLocaleTimeString('zh-CN') + '）',
          decisionTime: new Date().toLocaleString('zh-CN'),
        },
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 300));
  console.log(res.ok ? '\n✅ 更新成功，群里那张测试卡片的状态行应该已经变了。' : '\n❌ 更新失败');
})();

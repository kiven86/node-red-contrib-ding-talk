'use strict';

/**
 * robotCode 有效性验证：用「机器人单聊发消息」接口试两个候选值。
 * 只有真实存在且已上线的 robotCode 才会成功。
 *
 * 用法：node test/probe-oto.js /tmp/dt-cred.json <staffId>
 */

const fs = require('node:fs');

const cred = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const staffId = process.argv[3];
if (!staffId) {
  console.error('用法: node test/probe-oto.js <凭证json> <staffId>');
  process.exit(2);
}

const API = 'https://api.dingtalk.com';

(async () => {
  const tokRes = await fetch(`${API}/v1.0/oauth2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: cred.clientId, appSecret: cred.clientSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const token = (await tokRes.json()).accessToken;

  const candidates = [...new Set([cred.robotCode, cred.clientId].filter(Boolean))];

  for (const rc of candidates) {
    const body = {
      robotCode: rc,
      userIds: [staffId],
      msgKey: 'sampleText',
      msgParam: JSON.stringify({
        content: `【连通性测试】Node-RED 钉钉节点，robotCode=${rc}。收到说明机器人可用。`,
      }),
    };

    const res = await fetch(`${API}/v1.0/robot/oToMessages/batchSend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 忽略 */
    }

    console.log(`\nrobotCode = ${rc}`);
    console.log(`  HTTP ${res.status}`);
    console.log(`  返回 ${text.slice(0, 300)}`);

    if (res.ok) {
      const ids = (data && (data.processQueryKey || data.invalidStaffIdList)) || null;
      console.log('  ✅ 发送成功 —— 这个 robotCode 有效且机器人已上线');
      if (ids) console.log('  详情 ' + JSON.stringify(ids));
    } else {
      const code = (data && data.code) || '';
      console.log(`  ❌ 失败 code=${code}`);
    }
  }
})();

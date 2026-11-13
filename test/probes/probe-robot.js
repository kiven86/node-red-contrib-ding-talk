'use strict';

/**
 * 参数有效性探针：用必然失败的参数调卡片投递接口，
 * 通过错误信息判断「robotCode 是否存在」「卡片模板是否存在」「会话是否存在」。
 *
 * 不会真的发出任何卡片（参数是假的，接口必然报错）。
 *
 * 用法：node test/probes/probe-robot.js 凭证文件
 */

const fs = require('node:fs');

const cred = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const API = 'https://api.dingtalk.com';

let token = '';

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
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
  return { status: res.status, data, text };
}

function show(label, r) {
  const code = (r.data && (r.data.code || r.data.errcode)) || '';
  const msg = (r.data && (r.data.message || r.data.errmsg)) || r.text.slice(0, 200);
  console.log(`  ${label}`);
  console.log(`    HTTP ${r.status}  code=${code}`);
  console.log(`    msg=${String(msg).slice(0, 200)}`);
  return { code: String(code), msg: String(msg) };
}

(async () => {
  const tokRes = await fetch(`${API}/v1.0/oauth2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: cred.clientId, appSecret: cred.clientSecret }),
    signal: AbortSignal.timeout(15000),
  });
  token = (await tokRes.json()).accessToken;
  console.log('accessToken 已获取\n');

  const fake = 'cidFAKECONVERSATION0000000000000000000==';

  console.log('=== 1. 用报告里的 robotCode 投一张不存在的卡片 ===');
  const variants = [cred.robotCode, cred.clientId].filter(Boolean);
  for (const rc of [...new Set(variants)]) {
    const res = await post('/v1.0/card/instances/createAndDeliver', {
      cardTemplateId: 'probe-template.schema',
      outTrackId: 'probe-' + Date.now().toString(36),
      openSpaceId: `dtv1.card//IM_GROUP.${fake}`,
      imGroupOpenDeliverModel: { robotCode: rc },
      callbackType: 'STREAM',
      cardData: { cardParamMap: {} },
    });
    show(`robotCode=${rc}`, res);
    console.log('');
  }

  console.log('=== 2. robotCode 换成完全不合法的值（基线对照）===');
  {
    const res = await post('/v1.0/card/instances/createAndDeliver', {
      cardTemplateId: 'probe-template.schema',
      outTrackId: 'probe-' + Date.now().toString(36),
      openSpaceId: `dtv1.card//IM_GROUP.${fake}`,
      imGroupOpenDeliverModel: { robotCode: 'not-a-real-robot-code' },
      callbackType: 'STREAM',
      cardData: { cardParamMap: {} },
    });
    show('robotCode=not-a-real-robot-code', res);
  }
})();

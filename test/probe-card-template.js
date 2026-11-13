'use strict';

/**
 * 探查卡片模板：确认群里那张卡片的按钮到底配没配回调参数。
 *
 * 用法：node test/probe-card-template.js [模板ID]
 * 凭证按 test/cred-check.js 的约定读取（tmp/dt-cred.json 或环境变量）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const openapi = require('../lib/openapi');

const TEMPLATE = process.argv[2] || 'df165631-b57c-4379-91b6-a121bbb14696.schema';

function readCred() {
  if (process.env.DT_CLIENT_ID && process.env.DT_CLIENT_SECRET) {
    return { clientId: process.env.DT_CLIENT_ID, clientSecret: process.env.DT_CLIENT_SECRET };
  }
  const candidates = [
    path.join(os.tmpdir(), 'dt-cred.json'),
    path.resolve(__dirname, '../../dt-cred.json'),
    path.resolve(__dirname, '../dt-cred.json'),
  ];
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.clientId && j.clientSecret) return j;
    } catch {
      /* 下一个 */
    }
  }
  throw new Error('找不到凭证：设置 DT_CLIENT_ID / DT_CLIENT_SECRET，或放 dt-cred.json');
}

function req(method, url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        timeout: 15000,
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('超时')));
    r.end();
  });
}

(async () => {
  const cred = readCred();
  const token = await openapi.getAccessToken(cred.clientId, cred.clientSecret);
  console.log(`token ok：${String(token).slice(0, 8)}…\n`);

  const tries = [
    `https://api.dingtalk.com/v1.0/card/templates?maxResults=20`,
    `https://api.dingtalk.com/v1.0/card/templates/${encodeURIComponent(TEMPLATE)}`,
    `https://api.dingtalk.com/v1.0/card/templates/${encodeURIComponent(TEMPLATE.replace(/\.schema$/, ''))}`,
  ];

  for (const url of tries) {
    try {
      const r = await req('GET', url, token);
      console.log(`=== ${url.replace('https://api.dingtalk.com', '')} → ${r.status}`);
      console.log(r.body.slice(0, 1500));
      console.log('');
    } catch (err) {
      console.log(`=== ${url} → 失败：${err.message}\n`);
    }
  }
})().catch((err) => {
  console.error('出错：', err.message);
  process.exit(1);
});

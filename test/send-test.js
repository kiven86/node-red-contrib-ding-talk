'use strict';

/**
 * 离线单元测试：不连钉钉、不耗额度。
 * 用假 fetch 拦截请求，校验「我们发出去的报文到底长什么样」。
 *
 *   node test/send-test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const openapi = require(path.join(root, 'lib/openapi'));
const { resolveSource, download } = require(path.join(root, 'lib/image-source'));

// 1x1 透明 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
// 最小 JPEG 头（够 sniff 用）
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)]);

/* ---------------- 假 fetch ---------------- */

const calls = [];
let uploadReply = { errcode: 0, errmsg: 'ok', media_id: '@lAtestMediaId' };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts.body;
  calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body });

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  if (u.includes('/v1.0/oauth2/accessToken')) {
    return json({ accessToken: 'fake-token', expireIn: 7200 });
  }
  if (u.includes('/v1.0/robot/groupMessages/send')) {
    return json({ processQueryKey: 'pqk-group' });
  }
  if (u.includes('/v1.0/robot/oToMessages/batchSend')) {
    return json({ processQueryKey: 'pqk-single' });
  }
  if (u.includes('/media/upload')) {
    return json(uploadReply);
  }
  if (u.startsWith('http') && !u.includes('dingtalk')) {
    // 给 download() 用的假图片
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  return json({ code: 'NotFound' }, 404);
};

function lastCall(match) {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].url.includes(match)) return calls[i];
  return null;
}

let pass = 0;
let fail = 0;
function t(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      pass++;
    } catch (err) {
      console.log(`  ❌ ${name}\n       ${err.message}`);
      fail++;
    }
  })();
}

(async () => {
  console.log('\n[1] 图片类型识别');
  await t('PNG / JPEG / GIF 能认出来', () => {
    assert.equal(openapi.sniffImage(PNG).mime, 'image/png');
    assert.equal(openapi.sniffImage(JPG).mime, 'image/jpeg');
    assert.equal(openapi.sniffImage(GIF).mime, 'image/gif');
  });
  await t('非图片返回 null（不会被当成图片上传）', () => {
    assert.equal(openapi.sniffImage(Buffer.from('<html>login</html>')), null);
    assert.equal(openapi.sniffImage(Buffer.alloc(3)), null);
  });

  console.log('\n[2] 内网 URL 判定');
  await t('私网地址识别为内网', () => {
    assert.equal(openapi.isPrivateUrl('http://192.168.60.88/a.png'), true);
    assert.equal(openapi.isPrivateUrl('http://10.0.0.5/a.png'), true);
    assert.equal(openapi.isPrivateUrl('http://172.16.3.2/a.png'), true);
    assert.equal(openapi.isPrivateUrl('http://localhost:1880/a.png'), true);
  });
  await t('公网域名不算内网', () => {
    assert.equal(openapi.isPrivateUrl('https://ikuai.work/a.png'), false);
    assert.equal(openapi.isPrivateUrl('https://example.com/a.png'), false);
    assert.equal(openapi.isPrivateUrl('不是URL'), false);
  });

  console.log('\n[3] 群消息报文');
  await t('msgParam 必须是 JSON 字符串，不是对象', async () => {
    await openapi.sendGroupMessage({
      clientId: 'k',
      clientSecret: 's',
      robotCode: 'robot1',
      openConversationId: 'cidAAA==',
      msgKey: 'sampleText',
      msgParam: { content: '你好' },
    });
    const c = lastCall('groupMessages/send');
    assert.ok(c, '没发出请求');
    const body = JSON.parse(c.body);
    assert.equal(typeof body.msgParam, 'string', 'msgParam 应该是字符串');
    assert.deepEqual(JSON.parse(body.msgParam), { content: '你好' });
    assert.equal(body.msgKey, 'sampleText');
    assert.equal(body.robotCode, 'robot1');
    assert.equal(body.openConversationId, 'cidAAA==');
    assert.equal(c.headers['x-acs-dingtalk-access-token'], 'fake-token');
  });

  await t('缺 openConversationId 直接报错，不发请求', async () => {
    const before = calls.length;
    await assert.rejects(
      openapi.sendGroupMessage({
        clientId: 'k',
        clientSecret: 's',
        robotCode: 'r',
        openConversationId: '',
        msgKey: 'sampleText',
        msgParam: { content: 'x' },
      }),
      /缺少必填参数/
    );
    assert.equal(calls.length, before);
  });

  console.log('\n[4] 单聊报文');
  await t('userIds 传数组，单个值自动包成数组', async () => {
    await openapi.sendSingleMessage({
      clientId: 'k',
      clientSecret: 's',
      robotCode: 'r',
      userIds: 'user001',
      msgKey: 'sampleText',
      msgParam: { content: 'hi' },
    });
    const body = JSON.parse(lastCall('oToMessages/batchSend').body);
    assert.deepEqual(body.userIds, ['user001']);
  });
  await t('userIds 超过 20 个拒绝', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `u${i}`);
    await assert.rejects(
      openapi.sendSingleMessage({
        clientId: 'k',
        clientSecret: 's',
        robotCode: 'r',
        userIds: many,
        msgKey: 'sampleText',
        msgParam: { content: 'x' },
      }),
      /最多 20 个/
    );
  });
  await t('userIds 为空拒绝', async () => {
    await assert.rejects(
      openapi.sendSingleMessage({
        clientId: 'k',
        clientSecret: 's',
        robotCode: 'r',
        userIds: [],
        msgKey: 'sampleText',
        msgParam: {},
      }),
      /缺少 userIds/
    );
  });

  console.log('\n[5] 媒体上传');
  await t('multipart 结构正确且带 PNG 文件头', async () => {
    const r = await openapi.uploadMedia({
      clientId: 'k',
      clientSecret: 's',
      buffer: PNG,
      filename: 'chart.png',
    });
    assert.equal(r.mediaId, '@lAtestMediaId');
    const c = lastCall('media/upload');
    assert.ok(c.url.includes('type=image'), 'URL 应带 type=image');
    assert.ok(c.url.includes('access_token=fake-token'), 'URL 应带 access_token');
    assert.match(c.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    const raw = c.body.toString('latin1');
    assert.ok(raw.includes('name="media"'), '字段名应为 media');
    assert.ok(raw.includes('filename="chart.png"'), '应带原始文件名');
    assert.ok(raw.includes('Content-Type: image/png'), '应按文件头判断成 png');
    assert.ok(c.body.includes(PNG), '文件内容应原样嵌入');
  });

  await t('超过 20MB 提前拦截', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1);
    await assert.rejects(
      openapi.uploadMedia({ clientId: 'k', clientSecret: 's', buffer: big }),
      /超过 20MB/
    );
  });

  await t('上传返回 errcode≠0 时抛出可读错误', async () => {
    uploadReply = { errcode: 40006, errmsg: 'media size error' };
    await assert.rejects(
      openapi.uploadMedia({ clientId: 'k', clientSecret: 's', buffer: PNG }),
      /40006 media size error/
    );
    uploadReply = { errcode: 0, errmsg: 'ok', media_id: '@lAtestMediaId' };
  });

  console.log('\n[6] 图片来源解析');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-img-'));
  const tmpFile = path.join(tmpDir, 'shot.png');
  fs.writeFileSync(tmpFile, PNG);

  await t('本地路径 → buffer，并带文件名', async () => {
    const s = await resolveSource(tmpFile);
    assert.equal(s.kind, 'buffer');
    assert.equal(s.label, 'shot.png');
    assert.ok(Buffer.compare(s.buffer, PNG) === 0);
  });
  await t('本地文件不存在时报明确错误', async () => {
    await assert.rejects(resolveSource(path.join(tmpDir, 'nope.png')), /本地图片不存在/);
  });
  await t('http URL → url（不下载）', async () => {
    const s = await resolveSource('https://example.com/a.png');
    assert.equal(s.kind, 'url');
  });
  await t('data URI → buffer', async () => {
    const s = await resolveSource(`data:image/png;base64,${PNG_B64}`);
    assert.equal(s.kind, 'buffer');
    assert.equal(s.buffer.length, PNG.length);
  });
  await t('纯 base64 → buffer', async () => {
    const s = await resolveSource(PNG_B64);
    assert.equal(s.kind, 'buffer');
  });
  await t('Buffer 直接透传', async () => {
    const s = await resolveSource(PNG);
    assert.equal(s.kind, 'buffer');
  });
  await t('无法识别的内容报错而不是瞎猜', async () => {
    await assert.rejects(resolveSource('随便一句话'), /无法识别的图片来源/);
    await assert.rejects(resolveSource(''), /图片来源为空/);
  });
  await t('download 拿到的不是图片时拒绝', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>请登录</html>', { status: 200 });
    await assert.rejects(download('http://192.168.60.1/a.png'), /不是图片/);
    globalThis.fetch = realFetch;
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n[7] 图片消息报文');
  await t('sampleImageMsg 的 photoURL 用 mediaId', async () => {
    await openapi.sendGroupMessage({
      clientId: 'k',
      clientSecret: 's',
      robotCode: 'r',
      openConversationId: 'cidAAA==',
      msgKey: openapi.MSG_KEY.IMAGE,
      msgParam: { photoURL: '@lAtestMediaId' },
    });
    const body = JSON.parse(lastCall('groupMessages/send').body);
    assert.equal(body.msgKey, 'sampleImageMsg');
    assert.equal(JSON.parse(body.msgParam).photoURL, '@lAtestMediaId');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

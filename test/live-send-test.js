'use strict';

/**
 * 真实发送测试（会真的发钉钉消息）。
 *
 *   node test/live-send-test.js <cred.json> <userid> [groupId]
 *
 * 只给 userid 时全部发单聊，不打扰群；
 * 再给一个群 ID（cid 开头）时，额外验证群发文本与群发图片。
 *
 * 验证：accessToken → 文本 / markdown / 本地图片上传 → 图片消息
 */

const fs = require('node:fs');
const path = require('node:path');
const openapi = require(path.join(__dirname, '..', 'lib/openapi'));

(async () => {
  const credPath = process.argv[2];
  const userId = process.argv[3];
  if (!credPath || !userId) {
    console.error('用法: node test/live-send-test.js <cred.json> <userid>');
    process.exit(1);
  }

  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const base = {
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
    robotCode: cred.robotCode,
    userIds: [userId],
  };

  let fail = 0;
  const step = async (name, fn) => {
    try {
      const r = await fn();
      console.log(`  ✅ ${name}  →  ${JSON.stringify(r).slice(0, 120)}`);
    } catch (err) {
      console.log(`  ❌ ${name}  →  ${err.message}`);
      fail++;
    }
  };

  console.log('\n[1] 文本消息（单聊）');
  await step('sampleText', () =>
    openapi.sendSingleMessage({
      ...base,
      msgKey: openapi.MSG_KEY.TEXT,
      msgParam: { content: '【Node-RED】发送文本节点验证 ✅\n如果你看到这条，说明 OpenAPI 通道正常。' },
    })
  );

  console.log('\n[2] Markdown 消息（单聊）');
  await step('sampleMarkdown', () =>
    openapi.sendSingleMessage({
      ...base,
      msgKey: openapi.MSG_KEY.MARKDOWN,
      msgParam: {
        title: '功能验证',
        text: '### 发送文本节点\n- 支持纯文本与 Markdown\n- 可发群也可单聊\n- 支持 @ 指定人',
      },
    })
  );

  console.log('\n[3] 图片消息（本地文件 → 上传 → 发送）');
  const imgPath = path.join(__dirname, 'demo.png');
  const buf = fs.readFileSync(imgPath);
  let mediaId = '';
  await step(`上传 ${path.basename(imgPath)} (${(buf.length / 1024).toFixed(1)}KB)`, async () => {
    const up = await openapi.uploadMedia({
      clientId: cred.clientId,
      clientSecret: cred.clientSecret,
      buffer: buf,
      filename: 'demo.png',
    });
    mediaId = up.mediaId;
    return { mediaId, mime: up.mime, size: up.size };
  });

  if (mediaId) {
    await step('sampleImageMsg', () =>
      openapi.sendSingleMessage({
        ...base,
        msgKey: openapi.MSG_KEY.IMAGE,
        msgParam: { photoURL: mediaId },
      })
    );
  } else {
    console.log('  ⚠️ 上传失败，跳过图片发送');
    fail++;
  }

  // ---- 群发（传了群 ID 才跑）----
  const groupId = process.argv[4];
  if (groupId) {
    const groupBase = {
      clientId: cred.clientId,
      clientSecret: cred.clientSecret,
      robotCode: cred.robotCode,
      openConversationId: groupId,
    };

    console.log(`\n[4] 群发文本 → ${groupId}`);
    await step('groupMessages/send sampleText', () =>
      openapi.sendGroupMessage({
        ...groupBase,
        msgKey: openapi.MSG_KEY.TEXT,
        msgParam: { content: '【Node-RED】群发文本验证 ✅ 可忽略这条消息。' },
      })
    );

    if (mediaId) {
      console.log('\n[5] 群发图片（复用上一步的 mediaId）');
      await step('groupMessages/send sampleImageMsg', () =>
        openapi.sendGroupMessage({
          ...groupBase,
          msgKey: openapi.MSG_KEY.IMAGE,
          msgParam: { photoURL: mediaId },
        })
      );
    }
  } else {
    console.log('\n（未传群 ID，跳过群发测试）');
  }

  console.log(`\n结果：${fail === 0 ? '全部成功' : fail + ' 项失败'}\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

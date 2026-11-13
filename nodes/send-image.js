'use strict';

/**
 * dingtalk-send-image —— 用机器人身份发图片消息。
 *
 * 关键点：钉钉的图片消息（msgKey=sampleImageMsg）只接受 photoURL，
 * 而 photoURL 要么是**公网可访问的完整 URL**，要么是**上传后拿到的 mediaId**。
 * 所以本地文件必须先走 /media/upload 换 mediaId，不能直接塞路径。
 *
 * 输入（msg.payload 五选一）：
 *   1. 本地绝对路径   /data/chart.png
 *   2. http(s) URL    公网直传；内网地址自动下载后上传
 *   3. data URI       data:image/png;base64,xxxx
 *   4. 纯 base64 字符串
 *   5. Buffer
 *   msg.filename      可选，上传时的文件名
 *   msg.conversationId / msg.userIds  目标，同「发送文本」
 *
 * 输出：
 *   msg.dingtalk = { ok, target, msgKey, mediaId?, photoURL, source, result }
 */

const openapi = require('../lib/openapi');
const { resolveSource, download } = require('../lib/image-source');

/** 缺目标时的补充提示：这两个 ID 在钉钉控制台查不到，只能靠会话事件攒 */
const TIP = '；ID 可在「ID 速查」页复制，或让群里的人 @ 一次机器人';

function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v)
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = function (RED) {
  function DingTalkSendImageNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.config = RED.nodes.getNode(config.config);

    if (!node.config) {
      node.error('未选择钉钉连接配置');
      node.status({ fill: 'red', shape: 'ring', text: '缺少配置' });
      return;
    }

    node.on('input', async function (msg, send, done) {
      send = send || node.send;

      try {
        const cfg = node.config;
        const robotCode = config.robotCode || cfg.robotCode || '';
        if (!robotCode) throw new Error('缺少 Robot Code：在「钉钉连接」配置里填');

        // ---- 目标 ----
        const conversationId =
          msg.conversationId ||
          msg.openConversationId ||
          (msg.dingtalk && msg.dingtalk.conversationId) ||
          config.conversationId ||
          '';
        const userIds = toArray(msg.userIds || msg.userId).length
          ? toArray(msg.userIds || msg.userId)
          : toArray(config.userIds);

        let target = config.target || 'auto';
        if (target === 'auto') target = conversationId ? 'group' : userIds.length ? 'single' : '';
        if (target === 'group' && !conversationId) {
          throw new Error(
            '群发缺少 conversationId：接「接收消息」节点的输出，或填节点配置，或设 msg.conversationId' + TIP
          );
        }
        if (target === 'single' && !userIds.length) {
          throw new Error('单聊缺少接收人：请设置 msg.userIds 或节点配置里的 userid' + TIP);
        }
        if (!target) throw new Error('无法确定发送目标：既没有 conversationId 也没有 userIds' + TIP);

        // ---- 图片 ----
        node.status({ fill: 'blue', shape: 'dot', text: '解析图片' });
        const src = await resolveSource(msg.payload, msg.filename);

        let photoURL;
        let mediaId = '';
        let source = '';

        if (src.kind === 'url') {
          const mode = config.urlMode || 'auto';
          const isPrivate = openapi.isPrivateUrl(src.url);
          const needUpload = mode === 'upload' || (mode === 'auto' && isPrivate);

          if (needUpload) {
            node.status({ fill: 'blue', shape: 'dot', text: '下载并上传' });
            const buf = await download(src.url);
            const up = await openapi.uploadMedia({
              clientId: cfg.clientId,
              clientSecret: cfg.clientSecret,
              buffer: buf,
              filename: msg.filename || 'remote',
            });
            mediaId = up.mediaId;
            photoURL = mediaId;
            source = isPrivate ? '内网URL→上传' : 'URL→下载上传';
          } else {
            photoURL = src.url;
            source = 'URL直传';
          }
        } else {
          node.status({ fill: 'blue', shape: 'dot', text: '上传中' });
          const up = await openapi.uploadMedia({
            clientId: cfg.clientId,
            clientSecret: cfg.clientSecret,
            buffer: src.buffer,
            filename: msg.filename || src.label,
          });
          mediaId = up.mediaId;
          photoURL = mediaId;
          source = '本地→上传';
        }

        if (!photoURL) throw new Error('没有可用的 photoURL');

        // ---- 发送 ----
        const msgKey = openapi.MSG_KEY.IMAGE;
        const msgParam = { photoURL };

        node.status({ fill: 'blue', shape: 'dot', text: target === 'group' ? '发图中' : '单聊发图' });

        const result =
          target === 'group'
            ? await openapi.sendGroupMessage({
                clientId: cfg.clientId,
                clientSecret: cfg.clientSecret,
                robotCode,
                openConversationId: conversationId,
                msgKey,
                msgParam,
              })
            : await openapi.sendSingleMessage({
                clientId: cfg.clientId,
                clientSecret: cfg.clientSecret,
                robotCode,
                userIds,
                msgKey,
                msgParam,
              });

        msg.dingtalk = Object.assign({}, msg.dingtalk, {
          ok: true,
          target,
          msgKey,
          mediaId: mediaId || undefined,
          photoURL,
          source,
          conversationId: target === 'group' ? conversationId : undefined,
          userIds: target === 'single' ? userIds : undefined,
          result,
        });

        node.status({
          fill: 'green',
          shape: 'dot',
          text: target === 'group' ? '已发图到群' : `已发图 ${userIds.length} 人`,
        });
        setTimeout(() => node.status({}), 3000);

        send(msg);
        if (done) done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: '发送失败' });
        if (done) done(err);
        else node.error(err, msg);
      }
    });
  }

  RED.nodes.registerType('dingtalk-send-image', DingTalkSendImageNode);
};

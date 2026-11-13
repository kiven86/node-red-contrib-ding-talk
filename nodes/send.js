'use strict';

/**
 * dingTalk-send —— 通过群自定义机器人 webhook 发文本。
 *
 * 这是唯一一个不需要 Stream 连接的节点：群自定义机器人是「只发不收」，
 * 没有回调能力，也无法接收卡片点击。要交互请用卡片节点。
 *
 * 保持 1.0.4 的字段与行为不变（现有 flow 里的「钉钉通知」节点依赖 token/secret）。
 */

const crypto = require('node:crypto');

module.exports = function (RED) {
  function DingTalkSendNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async function (msg, send, done) {
      send = send || node.send;

      const secret = config.secret || '';
      const token = config.token || '';
      if (!token) {
        const err = new Error('缺少 webhook access_token');
        if (done) done(err);
        else node.error(err, msg);
        return;
      }

      const content =
        typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload || '');

      try {
        let url = `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}`;

        // 安全设置选了「加签」才需要 timestamp + sign
        if (secret) {
          const timestamp = Date.now();
          const stringToSign = `${timestamp}\n${secret}`;
          const sign = crypto
            .createHmac('sha256', secret)
            .update(stringToSign)
            .digest('base64');
          url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
        }

        const body = {
          msgtype: 'text',
          text: { content },
        };
        // 支持 at 指定人：msg.atMobiles = ['138...'] / msg.atAll = true
        if (Array.isArray(msg.atMobiles) && msg.atMobiles.length) {
          body.at = { atMobiles: msg.atMobiles, isAtAll: false };
        } else if (msg.atAll) {
          body.at = { isAtAll: true };
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || (data.errcode && data.errcode !== 0)) {
          throw new Error(`HTTP ${res.status} ${data.errmsg || ''}`);
        }

        msg.dingTalkResponse = data;
        node.status({ fill: 'green', shape: 'dot', text: '发送成功' });
        setTimeout(() => node.status({}), 3000);
        send(msg);
        if (done) done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: '发送失败' });
        if (done) done(err);
        else node.error('发送钉钉失败: ' + err.message, msg);
      }
    });
  }

  RED.nodes.registerType('dingTalk-send', DingTalkSendNode);
};

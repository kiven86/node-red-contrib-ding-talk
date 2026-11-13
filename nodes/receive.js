'use strict';

/**
 * dingtalk-receive —— 接收群内 @机器人 / 单聊消息。
 *
 * 相比 1.0.4 的变化：
 *   1. 输出完整消息体到 msg.dingtalk，重点是 conversationId（发卡片到该群要用它）
 *   2. 自动回复改为可配置，默认关闭（原版写死回「已收到，机器人测试成功！🤖」）
 *   3. 连接交给 config 节点统一管理，不再每个节点各建一条 Stream
 *   4. msg.payload 仍然是纯文本，老 flow 不用改
 */

const { TOPIC } = require('../lib/constants');
const idBook = require('../lib/id-book');

/** messageId 去重窗口：钉钉没收到应答会重推，不写流程就会跑两遍 */
const DEDUP_TTL = 5 * 60 * 1000;
const DEDUP_MAX = 500;
const seen = new Map();

function dedup(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  if (seen.size > DEDUP_MAX) {
    for (const [k, t] of seen) if (now - t > DEDUP_TTL) seen.delete(k);
  }
  const hit = seen.get(messageId);
  if (hit && now - hit < DEDUP_TTL) return true;
  seen.set(messageId, now);
  return false;
}

module.exports = function (RED) {
  try {
    idBook.init(RED.settings && RED.settings.userDir);
  } catch (err) {
    RED.log.warn(`[dingtalk-receive] ID 台账初始化失败：${err.message}`);
  }

  function DingTalkReceiveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.config = RED.nodes.getNode(config.config);

    if (!node.config) {
      node.error('未选择钉钉连接配置');
      node.status({ fill: 'red', shape: 'ring', text: '缺少配置' });
      return;
    }

    const onlyAt = config.onlyAt !== false;
    const replyTemplate = String(config.reply || '');
    // 默认开启：每收到一条消息就把 conversationId / userid 记进台账，配节点时直接抄
    const recordIds = config.recordIds !== false;

    function render(tpl, ctx) {
      return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k) =>
        ctx[k] === undefined || ctx[k] === null ? '' : String(ctx[k])
      );
    }

    function onMessage(msg) {
      let body;
      try {
        body = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
      } catch (err) {
        node.warn(`消息解析失败：${err.message}`);
        return;
      }

      const messageId = msg.headers && msg.headers.messageId;

      // 同一条消息重推时不再跑第二遍
      if (dedup(messageId)) {
        node.debug(`重复推送的消息已忽略：${messageId}`);
        return;
      }

      const text = (body.text && body.text.content) || '';
      // 群里 @机器人 时，文本前面会带一个空格
      const cleanText = String(text).trim();

      if (onlyAt && body.conversationType === '2' && body.isInAtList === false) {
        node.debug('群里没有 @ 机器人，已忽略');
        return;
      }

      const ctx = {
        content: cleanText,
        senderNick: body.senderNick || '',
        senderStaffId: body.senderStaffId || body.senderId || '',
        conversationId: body.conversationId || '',
      };

      // 顺手把 ID 记进台账：以后配「发送文本 / 发送卡片」不用再翻 debug
      if (recordIds) {
        try {
          idBook.record({
            conversationId: body.conversationId,
            conversationTitle: body.conversationTitle,
            conversationType: body.conversationType,
            senderStaffId: body.senderStaffId,
            senderNick: body.senderNick,
            source: node.name || '接收消息',
          });
        } catch (err) {
          node.debug(`记录 ID 失败：${err.message}`);
        }
      }

      // 必须先应答再往下游送：下游可能耗时，但钉钉只等这一下。
      // 注意：没有配自动回复时也要回一个空包，否则钉钉 60 秒后会重推同一条消息，
      // 流程就会执行两遍（这是 1.0.4 没有处理、实测会踩的问题）。
      if (messageId && node.config.ackCallback) {
        let ackValue = {};
        if (replyTemplate) {
          const replyText = render(replyTemplate, ctx);
          if (replyText) ackValue = { content: replyText };
        }
        const ok = node.config.ackCallback(messageId, ackValue);
        if (!ok) node.warn('应答发送失败（Stream 可能已断开）');
      }

      const out = {
        payload: cleanText,
        topic: msg.headers ? msg.headers.topic : TOPIC.ROBOT,
        dingtalk: {
          messageId,
          conversationId: body.conversationId || '',
          conversationTitle: body.conversationTitle || '',
          // '1' 单聊，'2' 群聊
          conversationType: body.conversationType || '',
          senderNick: body.senderNick || '',
          senderStaffId: body.senderStaffId || '',
          senderId: body.senderId || '',
          senderCorpId: body.senderCorpId || '',
          robotCode: body.robotCode || '',
          msgtype: body.msgtype || '',
          text: cleanText,
          isInAtList: body.isInAtList,
          atUsers: body.atUsers || [],
          createAt: body.createAt || 0,
          // 临时会话 webhook，可直接 POST {msgtype:'text',text:{content}} 回复，2 小时内有效
          sessionWebhook: body.sessionWebhook || '',
          sessionWebhookExpiredTime: body.sessionWebhookExpiredTime || 0,
          raw: body,
        },
      };

      node.status({
        fill: 'green',
        shape: 'dot',
        text: `${ctx.senderNick || '有人'}：${cleanText.slice(0, 16)}`,
      });
      setTimeout(() => node.status({}), 4000);

      node.send(out);
    }

    node.config.registerHandler(TOPIC.ROBOT, onMessage);

    const onStatus = (s) => {
      if (!s.connected) {
        node.status({
          fill: s.reconnecting ? 'yellow' : 'red',
          shape: 'ring',
          text: s.reconnecting ? '重连中' : '未连接',
        });
      } else {
        // 不再用 registered 做判据：钉钉在新网关上基本不下发 REGISTERED 帧，
        // 拿它判断会永远停在黄灯。真正能证明订阅生效的是「收到过回调」。
        node.status({
          fill: 'green',
          shape: 'dot',
          text: s.callbacks ? `已连接 · 已收 ${s.callbacks} 条` : '已连接',
        });
      }
    };
    node.config.on('dt-status', onStatus);

    node.on('close', function () {
      node.config.removeListener('dt-status', onStatus);
      if (node.config.unregisterHandler) {
        node.config.unregisterHandler(TOPIC.ROBOT, onMessage);
      }
    });
  }

  RED.nodes.registerType('dingtalk-receive', DingTalkReceiveNode);
};

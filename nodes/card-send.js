'use strict';

/**
 * dingtalk-card-send —— 把互动卡片投递到群。
 *
 * 输入可以是：
 *   msg.payload            = { 变量名: 值 }   直接当 cardParamMap
 *   msg.payload            = JSON 字符串       同上，自动 parse
 *   msg.cardParamMap       = { ... }           优先级高于 payload
 *   msg.conversationId     = 'cidXXX=='        群 ID（也认 msg.dingtalk.conversationId）
 *   msg.outTrackId         = 'xxx'             可选，不传自动生成
 *   msg.cardTemplateId     = 'xxx.schema'      可选，覆盖节点配置
 *   msg.cardTitle          = '标题'            可选，会话列表里的摘要
 *
 * 输出：msg.outTrackId + msg.dingtalk.result
 */

const openapi = require('../lib/openapi');

/** 缺目标时的补充提示：这两个 ID 在钉钉控制台查不到，只能靠会话事件攒 */
const TIP = '；ID 可在「ID 速查」页复制，或让群里的人 @ 一次机器人';

module.exports = function (RED) {
  function DingTalkCardSendNode(config) {
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

        // ---- 卡片变量 ----
        let cardParamMap = msg.cardParamMap;
        if (!cardParamMap) {
          const p = msg.payload;
          if (p && typeof p === 'object') cardParamMap = p;
          else if (typeof p === 'string' && p.trim()) {
            try {
              cardParamMap = JSON.parse(p);
            } catch {
              throw new Error('msg.payload 不是合法 JSON，无法作为卡片变量');
            }
          }
        }
        if (!cardParamMap || typeof cardParamMap !== 'object') {
          throw new Error('缺少卡片变量：请设置 msg.payload 对象或 msg.cardParamMap');
        }

        // ---- 群 ID ----
        const conversationId =
          msg.conversationId ||
          msg.openConversationId ||
          (msg.dingtalk && msg.dingtalk.conversationId) ||
          config.openConversationId ||
          '';

        const cardTemplateId = msg.cardTemplateId || config.cardTemplateId || '';
        const outTrackId = msg.outTrackId || openapi.newOutTrackId(config.outTrackPrefix || 'nr');
        const title = msg.cardTitle || config.title || '';

        const robotCode = config.robotCode || cfg.robotCode || '';
        if (!robotCode) throw new Error('缺少 Robot Code：在「钉钉连接」配置里填');
        if (!conversationId) {
          throw new Error(
            '缺少群 ID：接「接收消息」节点的输出，或在节点里选一个' + TIP
          );
        }

        node.status({ fill: 'blue', shape: 'dot', text: '发送中' });

        const result = await openapi.createAndDeliverCard({
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          cardTemplateId,
          outTrackId,
          openConversationId: conversationId,
          robotCode,
          cardParamMap,
          title,
        });

        msg.outTrackId = outTrackId;
        msg.dingtalk = Object.assign({}, msg.dingtalk, {
          ok: true,
          outTrackId,
          result,
        });

        node.status({ fill: 'green', shape: 'dot', text: `已发送 ${outTrackId.slice(-6)}` });
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

  RED.nodes.registerType('dingtalk-card-send', DingTalkCardSendNode);
};

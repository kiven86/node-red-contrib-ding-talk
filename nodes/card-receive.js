'use strict';

/**
 * dingtalk-card-receive —— 接收互动卡片的按钮回调。
 *
 * 两个关键点，都是踩过坑才定下来的：
 *
 * 1. **先 ack，再送下游**。钉钉对回调有等待窗口，不回或回慢了会重推同一条消息
 *    （官方 SDK 注释写的是 60 秒）。Node-RED 的下游流程可能是异步的，
 *    所以 ack 必须在收到当刻发出去，不能等流程跑完。
 *
 * 2. **默认不回 cardData**。ack 里如果带 cards/paramMap，钉钉会拿它覆盖卡片变量，
 *    传了不完整的 map 就会把卡片上的字段清空。所以默认只回 outTrackId 让卡片保持原样，
 *    要改卡片请用「更新卡片」节点显式更新，或在本节点开启自动更新并给出模板。
 *
 * 另外加了 messageId 去重：同一条回调重推时不会让流程跑两遍。
 */

const { TOPIC } = require('../lib/constants');

/** messageId 去重窗口（毫秒），钉钉重推窗口是 60s，这里留足余量 */
const DEDUP_TTL = 5 * 60 * 1000;
const DEDUP_MAX = 500;

const seen = new Map(); // messageId -> 时间戳

function dedup(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  // 顺手清理，避免长期运行内存增长
  if (seen.size > DEDUP_MAX) {
    for (const [k, t] of seen) {
      if (now - t > DEDUP_TTL) seen.delete(k);
    }
  }
  const hit = seen.get(messageId);
  if (hit && now - hit < DEDUP_TTL) return true;
  seen.set(messageId, now);
  return false;
}

module.exports = function (RED) {
  function DingTalkCardReceiveNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.config = RED.nodes.getNode(config.config);

    if (!node.config) {
      node.error('未选择钉钉连接配置');
      node.status({ fill: 'red', shape: 'ring', text: '缺少配置' });
      return;
    }
    if (typeof node.config.registerHandler !== 'function') {
      node.error('钉钉连接配置不可用（检查 Client ID / Secret）');
      node.status({ fill: 'red', shape: 'ring', text: '配置无效' });
      return;
    }

    const autoUpdate = config.autoUpdate === true;
    const paramTemplate = String(config.cardParamTemplate || '').trim();

    /** 用回调里的字段替换 {{xxx}} 占位符 */
    function render(tpl, ctx) {
      return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (m, key) => {
        const parts = key.split('.');
        let v = ctx;
        for (const p of parts) v = v === undefined || v === null ? undefined : v[p];
        return v === undefined || v === null ? '' : String(v);
      });
    }

    function buildAckContext(body, parsed) {
      const cardPrivateData = (parsed && parsed.cardPrivateData) || {};
      // 两种按钮参数形态都要认：
      //   1. params: { action: 'agree' }               —— 模板里直接写变量
      //   2. actionParamList: [{ key, value }]         —— 卡片平台「按钮参数」列表
      // 实测生产模板走的是第 1 种，第 2 种作为兼容兜底合并进 params。
      const params = Object.assign({}, cardPrivateData.params || {});
      if (Array.isArray(cardPrivateData.actionParamList)) {
        for (const item of cardPrivateData.actionParamList) {
          if (!item) continue;
          const k = item.key !== undefined ? item.key : item.name;
          if (k !== undefined) params[k] = item.value;
        }
      }
      const actionIds = Array.isArray(cardPrivateData.actionIds)
        ? cardPrivateData.actionIds.map(String)
        : [];
      return {
        outTrackId: String(body.outTrackId || ''),
        userId: String(body.userId || ''),
        corpId: String(body.corpId || ''),
        actionId: actionIds[0] || '',
        actionIds: actionIds.join(','),
        actionParam: params.action === undefined ? '' : String(params.action),
        param: params,
        params,
        // params 里的键也直接暴露，方便模板写 {{action}} 而不是 {{params.action}}
        ...params,
      };
    }

    function onCallback(msg) {
      const messageId = msg.headers && msg.headers.messageId;

      if (dedup(messageId)) {
        node.debug(`重复推送的回调已忽略：${messageId}`);
        return;
      }

      let body = {};
      try {
        body = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data || {};
      } catch (err) {
        node.warn(`卡片回调解析失败：${err.message}`);
      }

      let parsed = {};
      try {
        parsed = body.content
          ? typeof body.content === 'string'
            ? JSON.parse(body.content)
            : body.content
          : {};
      } catch {
        parsed = {};
      }

      const ctx = buildAckContext(body, parsed);
      const outTrackId = ctx.outTrackId;

      /* ---------- 1. 立刻应答 ---------- */
      let ackNote = '';
      if (typeof node.config.ackCallback === 'function') {
        let ackValue = { outTrackId };

        if (autoUpdate && paramTemplate) {
          try {
            const rendered = render(paramTemplate, ctx);
            const cardParamMap = JSON.parse(rendered);
            ackValue = {
              outTrackId,
              cardOptions: { updateCardDataByKey: true },
              cardData: { cardParamMap },
            };
            ackNote = '，已回写卡片';
          } catch (err) {
            node.warn(`自动更新模板不是合法 JSON，已跳过回写：${err.message}`);
          }
        }

        const ok = node.config.ackCallback(messageId, ackValue);
        if (!ok) node.warn('回调应答发送失败（Stream 可能已断开）');
      }

      /* ---------- 2. 送下游 ---------- */
      const out = {
        payload: ctx.actionId || ctx.actionParam || '',
        outTrackId,
        topic: msg.headers ? msg.headers.topic : TOPIC.CARD,
        dingtalk: {
          messageId,
          outTrackId,
          userId: ctx.userId,
          corpId: ctx.corpId,
          actionIds: ctx.actionIds ? ctx.actionIds.split(',') : [],
          actionId: ctx.actionId,
          actionParam: ctx.actionParam,
          params: ctx.params,
          cardPrivateData: parsed.cardPrivateData || {},
          // 原始体，排查时能直接看到钉钉到底给了什么
          raw: body,
        },
      };

      node.status({
        fill: 'blue',
        shape: 'dot',
        text: `${ctx.actionId || ctx.actionParam || '点击'}${ackNote}`,
      });
      setTimeout(() => node.status({}), 4000);

      node.send(out);
    }

    node.config.registerHandler(TOPIC.CARD, onCallback);

    const onStatus = (s) => {
      if (!s.connected) {
        node.status({
          fill: s.reconnecting ? 'yellow' : 'red',
          shape: 'ring',
          text: s.reconnecting ? '重连中' : '未连接',
        });
      } else {
        // 同 receive.js：registered 不可靠，用「是否收到过回调」判断
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
        node.config.unregisterHandler(TOPIC.CARD, onCallback);
      }
    });
  }

  RED.nodes.registerType('dingtalk-card-receive', DingTalkCardReceiveNode);
};

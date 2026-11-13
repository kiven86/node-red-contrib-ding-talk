'use strict';

/**
 * dingtalk-card-update —— 原地刷新已投递的卡片变量。
 *
 * 输入：
 *   msg.outTrackId    必填（「接收卡片回调」节点已经输出好了）
 *   msg.payload       = { 变量名: 值 } 或 JSON 字符串
 *   msg.cardParamMap  同上，优先级更高
 *
 * 两种接线方式：
 *   1. 接「接收卡片回调」直连 —— 此时 payload 是按钮动作字符串（如 agree），
 *      在节点里填「按钮动作写入变量」（如 status）即可，不必中间加 function
 *   2. 前面有 function 组装好对象 —— 直接用 payload
 *
 * 输出：msg.dingtalk.updateResult
 */

const openapi = require('../lib/openapi');

/** "agree=已通过,reject=已驳回" → { agree:'已通过', reject:'已驳回' } */
function parseLabels(str) {
  const map = {};
  String(str || '')
    .split(/[,，\n]+/)
    .forEach((pair) => {
      const i = pair.indexOf('=');
      if (i <= 0) return;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (k) map[k] = v;
    });
  return map;
}

module.exports = function (RED) {
  function DingTalkCardUpdateNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.config = RED.nodes.getNode(config.config);

    if (!node.config) {
      node.error('未选择钉钉连接配置');
      node.status({ fill: 'red', shape: 'ring', text: '缺少配置' });
      return;
    }

    // 直连回调节点时的兜底：把按钮动作写进这个变量
    const actionVar = String(config.actionVar || '').trim();
    const labels = parseLabels(config.actionLabels);

    node.on('input', async function (msg, send, done) {
      send = send || node.send;

      try {
        const cfg = node.config;
        const outTrackId = msg.outTrackId || (msg.dingtalk && msg.dingtalk.outTrackId) || '';
        if (!outTrackId) throw new Error('缺少 msg.outTrackId');

        let cardParamMap = msg.cardParamMap;

        if (!cardParamMap) {
          const p = msg.payload;
          if (p && typeof p === 'object') {
            cardParamMap = p;
          } else if (typeof p === 'string' && p.trim()) {
            const s = p.trim();
            if (s.startsWith('{') || s.startsWith('[')) {
              try {
                cardParamMap = JSON.parse(s);
              } catch (err) {
                throw new Error(`msg.payload 看着像 JSON 但解析失败：${err.message}`);
              }
            } else if (actionVar) {
              // 典型的「接收卡片回调」直连：payload 是 actionId / actionParam
              const d = msg.dingtalk || {};
              const raw = d.actionParam || d.actionId || s;
              cardParamMap = { [actionVar]: labels[raw] || raw };
            } else {
              throw new Error(
                `msg.payload 是字符串「${s.slice(0, 20)}」，不是卡片变量对象。` +
                  '如果上游接的是「接收卡片回调」，请在中间加一个 function 组装 {变量名: 值}，' +
                  '或在本节点填「按钮动作写入变量」直接回显动作。'
              );
            }
          }
        }

        if (!cardParamMap || typeof cardParamMap !== 'object') {
          throw new Error(
            '缺少卡片变量：请设置 msg.payload 对象、msg.cardParamMap，或在「按钮动作写入变量」里填一个变量名'
          );
        }

        node.status({ fill: 'blue', shape: 'dot', text: '更新中' });

        const raw = await openapi.updateCard({
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          outTrackId,
          cardParamMap,
        });
        // PUT /v1.0/card/instances 成功时可能返回空体
        const bad = raw && raw.success === false;
        if (bad) throw new Error(JSON.stringify(raw).slice(0, 300));

        msg.dingtalk = Object.assign({}, msg.dingtalk, {
          updateOk: true,
          outTrackId,
          updateResult: raw || {},
        });

        node.status({ fill: 'green', shape: 'dot', text: `已更新 ${outTrackId.slice(-6)}` });
        setTimeout(() => node.status({}), 3000);

        send(msg);
        if (done) done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: '更新失败' });
        if (done) done(err);
        else node.error(err, msg);
      }
    });
  }

  RED.nodes.registerType('dingtalk-card-update', DingTalkCardUpdateNode);
};

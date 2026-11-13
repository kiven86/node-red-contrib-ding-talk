'use strict';

/**
 * dingtalk-send-text —— 用机器人身份发文本 / Markdown 消息。
 *
 * 和 dingTalk-send（群自定义机器人 webhook）的区别：
 *   - 这个走 OpenAPI，需要「钉钉连接」配置，能发到**任意**机器人所在的群和单聊
 *   - webhook 那个只能发到绑定的那一个群，且「只发不收」
 *
 * 目标自动判定：
 *   有 conversationId → 群发；否则有 userIds → 单聊。也可强制指定。
 *
 * 输入：
 *   msg.payload            文本内容（对象会 JSON.stringify）
 *   msg.conversationId     群 ID（也认 msg.openConversationId / msg.dingtalk.conversationId）
 *   msg.userIds / msg.userId   单聊接收人 userid
 *   msg.title / msg.subject    Markdown 的首屏摘要
 *   msg.atUserIds          要 @ 的 userid 数组（配 msg.atAll 用 true 表示 @所有人）
 *
 * 输出：
 *   msg.dingtalk = { ok, target, msgKey, result }
 */

const openapi = require('../lib/openapi');

/** 缺目标时的补充提示：这两个 ID 在钉钉控制台查不到，只能靠会话事件攒 */
const TIP = '；ID 可在「ID 速查」页复制，或让群里的人 @ 一次机器人';

/** 从 Markdown 正文里抠一行摘要，给会话列表显示用 */
function summarize(text, fallback = '消息') {
  const line = String(text || '')
    .split('\n')
    .map((s) => s.replace(/^[#>\-*\s]+/, '').replace(/[*_`~]/g, '').trim())
    .find((s) => s.length > 0);
  if (!line) return fallback;
  const flat = line.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim() || fallback;
  return flat.length > 30 ? `${flat.slice(0, 30)}…` : flat;
}

function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v)
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = function (RED) {
  function DingTalkSendTextNode(config) {
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

        // ---- 内容 ----
        const mode = config.mode === 'markdown' ? 'markdown' : 'text';
        let content = msg.payload;
        if (content !== null && typeof content === 'object') {
          content = JSON.stringify(content);
        }
        content = content === undefined || content === null ? '' : String(content);
        if (!content.trim()) {
          throw new Error('消息内容为空：请设置 msg.payload 或节点默认内容');
        }
        if (content.length > 20000) {
          throw new Error(`消息过长（${content.length} 字），钉钉上限约 20000 字`);
        }

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
          throw new Error('群发缺少 conversationId：接「接收消息」节点的输出，或填节点配置，或设 msg.conversationId' + TIP);
        }
        if (target === 'single' && !userIds.length) {
          throw new Error('单聊缺少接收人：请设置 msg.userIds 或节点配置里的 userid' + TIP);
        }
        if (!target) {
          throw new Error('无法确定发送目标：既没有 conversationId 也没有 userIds' + TIP);
        }

        // ---- 组装 msgParam ----
        let msgKey;
        let msgParam;

        if (mode === 'markdown') {
          msgKey = openapi.MSG_KEY.MARKDOWN;
          msgParam = {
            title: msg.title || msg.subject || config.title || summarize(content),
            text: content,
          };
        } else {
          msgKey = openapi.MSG_KEY.TEXT;
          msgParam = { content };
        }

        // @ 人：text 与 markdown 都支持 atUserIds / atAll
        const atUserIds = toArray(msg.atUserIds).length
          ? toArray(msg.atUserIds)
          : toArray(config.atUserIds);
        const atAll = msg.atAll === true || (msg.atAll === undefined && config.atAll === true);
        if (atAll) {
          msgParam.atAll = true;
          msgParam.atUserIds = atUserIds; // @所有人 时顺手带上指定人，钉钉会都提醒
          // 群 @所有人 需要正文里没有额外要求，但 @指定人 必须正文里出现 @昵称 才会高亮，
          // 这里不强改用户内容，只把参数传过去
        } else if (atUserIds.length) {
          msgParam.atUserIds = atUserIds;
        }

        node.status({ fill: 'blue', shape: 'dot', text: target === 'group' ? '群发中' : '单聊中' });

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
          conversationId: target === 'group' ? conversationId : undefined,
          userIds: target === 'single' ? userIds : undefined,
          result,
        });

        node.status({
          fill: 'green',
          shape: 'dot',
          text: target === 'group' ? '已发到群' : `已发 ${userIds.length} 人`,
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

  RED.nodes.registerType('dingtalk-send-text', DingTalkSendTextNode);
};

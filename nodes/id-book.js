'use strict';

/**
 * dingtalk-id-book —— 钉钉 ID 速查。
 *
 * 两个用法，同一个节点：
 *   1. 接管「接收消息」的输出：自动把群名 ↔ conversationId、昵称 ↔ userid 记下来，原样透传
 *   2. 单独 inject 一个关键词：模糊查已记录的 ID
 *
 * 另外注册一个网页 http://<nas>:1880/dingtalk/ids ，点开就是带搜索和复制按钮的表格。
 */

const idBook = require('../lib/id-book');
const page = require('../lib/id-book-page');

const HOME_PATH = '/dingtalk/ids';

function mountHttp(RED) {
  const app = RED.httpNode;
  if (!app || typeof app.get !== 'function') return false;
  if (RED._dingtalkIdBookMounted) return true;
  RED._dingtalkIdBookMounted = true;

  app.get(HOME_PATH, (req, res) => {
    try {
      res.type('html').send(page.render(idBook.find(req.query.q || '')));
    } catch (err) {
      res.status(500).type('text').send(`渲染失败：${err.message}`);
    }
  });

  app.get(`${HOME_PATH}.json`, (req, res) => {
    res.json(idBook.find(req.query.q || ''));
  });

  app.post(`${HOME_PATH}/clear`, (req, res) => {
    idBook.clear();
    res.json({ ok: true });
  });

  return true;
}

module.exports = function (RED) {
  try {
    idBook.init(RED.settings && RED.settings.userDir);
  } catch (err) {
    RED.log.warn(`[dingtalk-id-book] 初始化失败：${err.message}`);
  }
  mountHttp(RED);

  function DingTalkIdBookNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const auto = config.mode !== 'query';

    function summarize(r) {
      const c = r.conversation;
      const u = r.user;
      if (c && u) return `${c.title || c.id} ｜ ${u.nick || u.id}`;
      if (c) return c.title || c.id;
      if (u) return `${u.nick || '某人'} ${u.id}`;
      return '';
    }

    node.on('input', function (msg, send, done) {
      send = send || node.send;
      try {
        // 带会话信息的消息 → 登记并透传，不改变原有链路
        const hasContext =
          msg.dingtalk && (msg.dingtalk.conversationId || msg.dingtalk.senderStaffId || msg.dingtalk.userId);
        const wantsQuery =
          typeof msg.payload === 'string' ||
          (msg.payload && typeof msg.payload === 'object' && typeof msg.payload.query === 'string');

        if (auto && hasContext && !wantsQuery) {
          const r = idBook.fromMessage(msg);
          if (r && (r.conversation || r.user)) {
            node.status({ fill: 'green', shape: 'dot', text: `已记录 ${summarize(r)}`.slice(0, 24) });
            setTimeout(() => node.status({}), 2500);
          }
          send(msg);
          if (done) done();
          return;
        }

        // 查询模式
        let q = '';
        if (typeof msg.payload === 'string') q = msg.payload;
        else if (msg.payload && typeof msg.payload.query === 'string') q = msg.payload.query;

        if (msg.payload && msg.payload.action === 'clear') {
          idBook.clear();
          msg.payload = { ok: true, cleared: true };
          node.status({ fill: 'yellow', shape: 'dot', text: '已清空' });
          send(msg);
          if (done) done();
          return;
        }

        const result = q ? idBook.find(q) : idBook.list();
        const n = (result.conversations || []).length + (result.users || []).length;

        msg.dingtalk = Object.assign({}, msg.dingtalk, { ids: result });
        msg.payload = result;
        msg.text =
          n === 0
            ? q
              ? `没有匹配「${q}」的 ID`
              : '台账还是空的'
            : [
                ...(result.conversations || []).map((c) => `群 ${c.title || '(未命名)'}：${c.id}`),
                ...(result.users || []).map((u) => `人 ${u.nick || '(未知)'}：${u.id}`),
              ].join('\n');

        node.status({ fill: n ? 'blue' : 'grey', shape: 'dot', text: n ? `命中 ${n} 条` : '无记录' });
        setTimeout(() => node.status({}), 3000);

        send(msg);
        if (done) done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: '出错' });
        if (done) done(err);
        else node.error(err, msg);
      }
    });

    node.on('close', function () {
      idBook.flush();
    });
  }

  RED.nodes.registerType('dingtalk-id-book', DingTalkIdBookNode);
};

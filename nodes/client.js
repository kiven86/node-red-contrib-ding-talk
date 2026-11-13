'use strict';

/**
 * dingtalk-robot —— 凭证与连接配置节点（config node）。
 *
 * 这里是这次改造最关键的一处：DWClient 只在这里创建一次。
 * 原版把 DWClient 建在「接收消息」in 节点里，如果 flow 里同时有
 * 「收机器人消息」和「收卡片回调」两个节点，就会建两条 Stream 连接，
 * 而钉钉对同一个 clientId 是抢占消费 —— 回调随机落到其中一条，
 * 表现就是一半的点击「没反应」。
 *
 * 现在所有业务节点都向这个 config 节点 registerHandler(topic, fn)，
 * 由它统一维护一条连接、一份订阅列表、一套重连逻辑。
 */

const { DWClient } = require('../lib/client');
const { TOPIC } = require('../lib/constants');
const openapi = require('../lib/openapi');

module.exports = function (RED) {
  function DingTalkRobotNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;

    this.name = n.name;
    this.clientId = n.clientId;
    // 新 flow 用 credentials 存；老 flow（1.0.4）把 secret 写在节点属性里，两条都认
    this.clientSecret =
      (this.credentials && this.credentials.clientSecret) || n.clientSecret || '';
    this.robotCode = n.robotCode || '';
    this.debug = n.debug === true || n.debug === 'true';

    if (!this.clientId || !this.clientSecret) {
      node.error('钉钉配置缺少 clientId 或 clientSecret');
      return;
    }

    /** topic -> Set<handler> */
    const handlers = new Map();
    let client = null;
    let connectTimer = null;
    let starting = false;
    /** 累计收到的回调条数：这是「订阅真的生效」唯一可靠的证据 */
    let callbackCount = 0;

    function emitStatus(extra) {
      node.emit('dt-status', Object.assign(
        {
          connected: Boolean(client && client.connected),
          registered: Boolean(client && client.registered),
          callbacks: callbackCount,
          reconnecting: Boolean(client && client.reconnecting),
          subscriptions: client ? client.stats().subscriptions : [...handlers.keys()],
          error: '',
        },
        extra || {}
      ));
    }

    function createClient() {
      const c = new DWClient({
        clientId: node.clientId,
        clientSecret: node.clientSecret,
        debug: node.debug,
        keepAlive: true,
      });

      c.on('connected', () => {
        node.log('Stream 已连接');
        emitStatus();
      });

      c.on('registered', () => {
        node.log(`订阅已生效：${c.stats().subscriptions.join(', ')}`);
        emitStatus();
      });

      c.on('disconnected', ({ code }) => {
        node.warn(`Stream 断开（code=${code}），将自动重连`);
        emitStatus();
      });

      c.on('reconnecting', ({ delay }) => {
        node.debug(`${delay}ms 后重连`);
        emitStatus();
      });

      c.on('reconnected', () => {
        node.log('Stream 已重连');
        emitStatus();
      });

      c.on('reconnect-failed', (err) => {
        emitStatus({ error: err.message });
      });

      c.on('error', (err) => {
        node.error(`Stream 错误：${err.message}`);
        emitStatus({ error: err.message });
      });

      // 所有 CALLBACK 帧的统一入口，按 topic 分发
      c.on('callback', (msg) => {
        const topic = msg.headers && msg.headers.topic;
        callbackCount++;
        emitStatus();
        const set = handlers.get(topic);
        if (!set || !set.size) {
          node.debug(`收到无人订阅的 topic：${topic}`);
          return;
        }
        for (const fn of set) {
          try {
            fn(msg);
          } catch (err) {
            node.error(`处理 ${topic} 回调出错：${err.message}`);
          }
        }
      });

      return c;
    }

    async function start() {
      if (starting || node.closed) return;
      starting = true;
      try {
        if (!client) client = createClient();
        // 把已注册的 topic 全部同步进订阅表，onEndpoint 时一并上报
        for (const topic of handlers.keys()) client.addSubscription('CALLBACK', topic);
        await client.connect();
        emitStatus();
      } catch (err) {
        node.error(`Stream 连接失败：${err.message}`);
        emitStatus({ error: err.message });
      } finally {
        starting = false;
      }
    }

    /**
     * 等一小会儿再连：deploy 时各业务节点是陆续 createNode 的，
     * 立刻连接会导致后注册的 topic 没赶上 getEndpoint 上报，白连一次。
     */
    function scheduleConnect(delay = 300) {
      if (connectTimer) return;
      connectTimer = setTimeout(() => {
        connectTimer = null;
        start();
      }, delay);
    }

    /** 业务节点注册回调 */
    node.registerHandler = (topic, fn) => {
      if (!topic || typeof fn !== 'function') return;
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic).add(fn);

      if (client && client.connected && !client.hasSubscription('CALLBACK', topic)) {
        // 已连上才新增的 topic：钉钉侧不知道，必须重连一次才生效
        node.warn(`新增订阅 ${topic}，需要重连一次使其生效`);
        client.disconnect();
        client = null;
      }
      scheduleConnect();
    };

    node.unregisterHandler = (topic, fn) => {
      const set = handlers.get(topic);
      if (set) set.delete(fn);
    };

    /** 卡片节点用：拿 accessToken */
    node.getAccessToken = (force) =>
      openapi.getAccessToken(node.clientId, node.clientSecret, force);

    /** 给状态查询 / 调试用 */
    node.streamStats = () => (client ? client.stats() : null);

    /** 卡片回调应答：必须在收到后尽快调用 */
    node.ackCallback = (messageId, value) => {
      if (!client) return false;
      return client.socketCallBackResponse(messageId, value);
    };

    node.on('close', function (done) {
      node.closed = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (client) {
        client.disconnect();
        client = null;
      }
      handlers.clear();
      done();
    });

    scheduleConnect();
  }

  RED.nodes.registerType('dingtalk-robot', DingTalkRobotNode, {
    credentials: {
      clientSecret: { type: 'password' },
    },
  });

  // 给编辑器「测试连接」按钮用：验证凭证能否换到 accessToken
  RED.httpAdmin.post(
    '/dingtalk-robot/:id/verify',
    RED.auth.needsPermission('flows.write'),
    async function (req, res) {
      const cfg = RED.nodes.getNode(req.params.id);
      if (!cfg) return res.status(404).json({ ok: false, error: '节点不存在' });
      try {
        const token = await openapi.getAccessToken(cfg.clientId, cfg.clientSecret, true);
        res.json({
          ok: true,
          tokenTail: `${token.slice(0, 6)}…${token.slice(-4)}`,
          stream: cfg.streamStats(),
        });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    }
  );

  // 露出常量，方便 html 里的下拉/提示复用
  DingTalkRobotNode.TOPIC = TOPIC;
};

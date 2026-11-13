'use strict';

/**
 * 钉钉 Stream 客户端。
 *
 * 基于 1.0.4 的 DWClient 重写，修的三个问题：
 *   1. 断线重连没有退避 —— 原版 reconnectInterval 恒为 1000，断线后每秒重连一次无限循环。
 *      现改为 1s→2s→4s…上限 60s，并加 ±50% 抖动，避免多实例同时打同一个网关。
 *   2. connect() 永远 resolve —— 原版 _connect 在 new WebSocket 后立刻 resolve，
 *      连不上也返回成功，上层拿不到任何错误。现改为等 open / error / 超时。
 *   3. 订阅 topic 只能在构造时指定 —— 现支持运行时 addSubscription()，
 *      便于 config 节点攒齐所有下游节点的 topic 后一次性上报。
 *
 * 下行帧三类：
 *   SYSTEM   连接/订阅状态（CONNECTED、REGISTERED、KEEPALIVE、ping、disconnect）
 *   EVENT    全事件推（subscriptions 里 type=EVENT 时）
 *   CALLBACK 订阅式回调（机器人消息、卡片按钮）→ 统一 emit('callback', msg)
 */

const EventEmitter = require('node:events');
const WebSocket = require('ws');
const {
  GATEWAY_URL,
  HEARTBEAT_MS,
  BACKOFF_MIN,
  BACKOFF_MAX,
  CONNECT_TIMEOUT_MS,
} = require('./constants');

class DWClient extends EventEmitter {
  constructor(opts = {}) {
    super();

    if (!opts.clientId || !opts.clientSecret) {
      throw new Error('DWClient: clientId 和 clientSecret 都必须提供');
    }

    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.ua = opts.ua || 'node-red-contrib-ding-talk/2.0.0';
    this.debug = Boolean(opts.debug);
    this.keepAlive = opts.keepAlive !== false; // 默认开，原版默认关是坑
    this.sslOpts = opts.sslOpts || { rejectUnauthorized: true };

    /** @type {Array<{type: string, topic: string}>} */
    this.subscriptions = [];
    for (const s of opts.subscriptions || []) this.addSubscription(s.type, s.topic);

    this.socket = null;
    this.connected = false;
    this.registered = false;
    this.userDisconnect = false;
    this.reconnecting = false;

    this.backoff = BACKOFF_MIN;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.isAlive = false;
    this.dwUrl = '';
    this.lastError = null;
    this.connectedAt = 0;
  }

  log(...args) {
    if (this.debug) console.log('[dingtalk-stream]', ...args);
  }

  /**
   * 追加一个订阅。已有同 type+topic 则忽略。
   * 注意：subscriptions 只在 getEndpoint() 时上报给钉钉，
   * 连上之后再 add 不会生效，必须等下次重连（config 节点负责这一点）。
   */
  addSubscription(type, topic) {
    if (!type || !topic) return this;
    const dup = this.subscriptions.some((s) => s.type === type && s.topic === topic);
    if (!dup) this.subscriptions.push({ type, topic });
    return this;
  }

  hasSubscription(type, topic) {
    return this.subscriptions.some((s) => s.type === type && s.topic === topic);
  }

  /** 建立连接：先换 wss 地址，再开 socket */
  async connect() {
    if (this.connected) {
      this.log('已连接，跳过 connect');
      return this;
    }
    await this._getEndpoint();
    await this._open();
    return this;
  }

  async _getEndpoint() {
    const body = {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      ua: this.ua,
      subscriptions: this.subscriptions,
    };
    this.log('getEndpoint', JSON.stringify(body));

    let res;
    try {
      res = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`获取 Stream 网关地址失败：${err.message}`);
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Stream 网关返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }

    if (!res.ok || !data.endpoint || !data.ticket) {
      const code = data && (data.code || data.message);
      throw new Error(`Stream 网关拒绝（HTTP ${res.status}）${code || text.slice(0, 200)}`);
    }

    this.dwUrl = `${data.endpoint}?ticket=${encodeURIComponent(data.ticket)}`;
    this.log('wss endpoint 已获取');
    return this;
  }

  _open() {
    return new Promise((resolve, reject) => {
      this.userDisconnect = false;
      let settled = false;

      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(this);
      };

      const timer = setTimeout(
        () => settle(new Error(`WebSocket 连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`)),
        CONNECT_TIMEOUT_MS
      );

      let ws;
      try {
        ws = new WebSocket(this.dwUrl, this.sslOpts);
      } catch (err) {
        settle(err);
        return;
      }
      this.socket = ws;

      ws.on('open', () => {
        this.connected = true;
        this.connectedAt = Date.now();
        this.backoff = BACKOFF_MIN; // 连上就把退避重置
        this.lastError = null;
        this._startHeartbeat();
        this.emit('connected');
        this.log('WebSocket 已连接');
        settle();
      });

      ws.on('pong', () => {
        this.isAlive = true;
        this.log('CLIENT-SIDE HEARTBEAT');
      });

      ws.on('message', (data) => {
        this._onDownstream(data);
      });

      ws.on('close', (code, reason) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.registered = false;
        this._stopHeartbeat();
        if (wasConnected) this.emit('disconnected', { code, reason: String(reason || '') });
        if (!this.userDisconnect) this._scheduleReconnect(code, reason);
      });

      ws.on('error', (err) => {
        this.lastError = err;
        this.log('SOCKET ERROR', err.message);
        // 没有 error 监听者时 EventEmitter 会抛异常，必须判一下
        if (this.listenerCount('error') > 0) this.emit('error', err);
        settle(err);
      });
    });
  }

  _scheduleReconnect(code, reason) {
    if (this.reconnectTimer) return;

    const delay = Math.min(BACKOFF_MAX, Math.round(this.backoff * (0.5 + Math.random())));
    this.reconnecting = true;
    this.log(`将在 ${delay}ms 后重连（code=${code} ${reason || ''}）`);
    this.emit('reconnecting', { delay, code });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // 指数退避：下次再失败就等更久
      this.backoff = Math.min(BACKOFF_MAX, this.backoff * 2);
      if (this.userDisconnect) return;
      try {
        await this.connect();
        this.reconnecting = false;
        this.emit('reconnected');
      } catch (err) {
        this.lastError = err;
        this.log('重连失败', err.message);
        this.emit('reconnect-failed', err);
        this._scheduleReconnect(-1, err.message);
      }
    }, delay);
  }

  _startHeartbeat() {
    if (!this.keepAlive) return;
    this._stopHeartbeat();
    this.isAlive = true;
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket) return;
      if (this.isAlive === false) {
        // 上一轮 ping 没有 pong：链路已经死了，主动 terminate 触发 close → 重连
        this.log('心跳超时，强制断开');
        try {
          this.socket.terminate();
        } catch {
          /* 忽略 */
        }
        return;
      }
      this.isAlive = false;
      try {
        this.socket.ping('', true);
      } catch {
        /* 忽略 */
      }
    }, HEARTBEAT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  disconnect() {
    this.userDisconnect = true;
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* 忽略 */
      }
      this.socket = null;
    }
    this.connected = false;
    this.registered = false;
    this.log('已主动断开');
  }

  _onDownstream(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      this.log('收到非 JSON 帧，忽略');
      return;
    }
    const type = msg.type;
    const topic = msg.headers && msg.headers.topic;

    if (type === 'SYSTEM') {
      switch (topic) {
        case 'CONNECTED':
          this.log('SYSTEM CONNECTED');
          break;
        case 'REGISTERED':
          this.registered = true;
          this.reconnecting = false;
          this.emit('registered');
          this.log('SYSTEM REGISTERED，订阅已生效');
          break;
        case 'disconnect':
          this.log('SYSTEM disconnect');
          break;
        case 'KEEPALIVE':
          this.isAlive = true;
          break;
        case 'ping':
          // 服务端主动 ping：照原协议回一个同 messageId 的 200
          this._raw({ code: 200, headers: msg.headers, message: 'OK', data: msg.data });
          break;
        default:
          break;
      }
      return;
    }

    if (type === 'EVENT') {
      this.emit('event', msg);
      const ack = { status: 'SUCCESS' };
      this._raw({
        code: 200,
        headers: { contentType: 'application/json', messageId: msg.headers && msg.headers.messageId },
        message: 'OK',
        data: JSON.stringify(ack),
      });
      return;
    }

    if (type === 'CALLBACK') {
      // 统一从 'callback' 出口，业务侧不必关心具体 topic 名。
      // 注意：这里不自动应答——卡片回调要回什么取决于业务，由节点决定。
      this.emit('callback', msg);
      return;
    }

    this.log('未知帧类型', type);
  }

  _raw(obj) {
    if (!this.socket) return false;
    try {
      this.socket.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      this.log('发送失败', err.message);
      return false;
    }
  }

  /**
   * 回调应答。必须在收到回调后尽快调用，否则钉钉 60 秒后会重推同一条消息。
   * @param {string} messageId 下游帧里的 headers.messageId
   * @param {object} value 应答体，卡片回调需要 { outTrackId, ... }
   */
  socketCallBackResponse(messageId, value) {
    if (!messageId) {
      this.log('socketCallBackResponse: messageId 为空，已忽略');
      return false;
    }
    return this._raw({
      code: 200,
      headers: { contentType: 'application/json', messageId },
      message: 'OK',
      data: JSON.stringify(value === undefined ? {} : value),
    });
  }

  /** 供 node.status() 用的摘要 */
  stats() {
    return {
      connected: this.connected,
      registered: this.registered,
      reconnecting: this.reconnecting,
      backoff: this.backoff,
      connectedAt: this.connectedAt,
      subscriptions: this.subscriptions.map((s) => s.topic),
      lastError: this.lastError ? this.lastError.message : '',
    };
  }
}

module.exports = { DWClient };

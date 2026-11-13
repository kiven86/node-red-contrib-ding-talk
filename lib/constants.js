'use strict';

/** Stream 网关：换取 wss 地址与 ticket */
const GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open';

/** 新版 OpenAPI 基址（卡片、accessToken 都走这里） */
const API_BASE = 'https://api.dingtalk.com';

/**
 * Stream 订阅的 topic。
 * 注意：这些是「下行订阅标识」，和 OpenAPI 的 HTTP 路径不同（一个是收，一个是发）。
 */
const TOPIC = {
  /** 机器人收到的消息（群里 @、单聊） */
  ROBOT: '/v1.0/im/bot/messages/get',
  /** 互动卡片按钮回调 */
  CARD: '/v1.0/card/instances/callback',
  /** AI 助理 / graph 调用 */
  AI_GRAPH: '/v1.0/graph/api/invoke',
};

/** 应用层心跳间隔，与官方 SDK 一致 */
const HEARTBEAT_MS = 8000;

/** 重连退避区间（毫秒） */
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 60000;

/** WebSocket 建连超时 */
const CONNECT_TIMEOUT_MS = 15000;

module.exports = {
  GATEWAY_URL,
  API_BASE,
  TOPIC,
  HEARTBEAT_MS,
  BACKOFF_MIN,
  BACKOFF_MAX,
  CONNECT_TIMEOUT_MS,
};

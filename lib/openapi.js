'use strict';

/**
 * 钉钉 OpenAPI 薄封装（卡片相关）。
 *
 * 只做三件事，所以不引 @alicloud/dingtalk（那个包 61MB、632 个文件，太重）：
 *   1. accessToken 获取与缓存（按 clientId 分桶，提前 5 分钟过期）
 *   2. createAndDeliver —— 建卡片实例并投递到群
 *   3. updateCard —— 原地刷新已投递的卡片
 *
 * 字段结构照搬已经在生产跑了两个月的 wifi-approval.js，不是拼凑的。
 */

const { API_BASE } = require('./constants');

/** clientId -> { value, expiresAt } */
const tokenCache = new Map();

/**
 * 取 accessToken。缓存命中直接返回，否则走 v1.0/oauth2/accessToken。
 * @param {string} clientId AppKey
 * @param {string} clientSecret AppSecret
 * @param {boolean} force 强制刷新（遇到 401 时用）
 */
async function getAccessToken(clientId, clientSecret, force = false) {
  const hit = tokenCache.get(clientId);
  if (!force && hit && Date.now() < hit.expiresAt) return hit.value;

  let res;
  try {
    res = await fetch(`${API_BASE}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`获取 accessToken 网络失败：${err.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`获取 accessToken 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }

  if (!res.ok || !data.accessToken) {
    throw new Error(
      `获取 accessToken 失败（HTTP ${res.status}）：${data.message || data.code || text.slice(0, 200)}`
    );
  }

  const ttl = (Number(data.expireIn) || 7200) - 300; // 提前 5 分钟
  tokenCache.set(clientId, { value: data.accessToken, expiresAt: Date.now() + ttl * 1000 });
  return data.accessToken;
}

/** 清掉缓存，凭证改了或 401 时用 */
function clearToken(clientId) {
  if (clientId) tokenCache.delete(clientId);
  else tokenCache.clear();
}

async function callApi(method, path, token, body, retried = false) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`${method} ${path} 网络失败：${err.message}`);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  // token 过期：刷新后重试一次
  if (res.status === 401 && !retried) {
    throw new Error(`__RETRY_TOKEN__${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const detail = (data && (data.message || data.code)) || text.slice(0, 300);
    throw new Error(`${method} ${path} → HTTP ${res.status}：${detail}`);
  }
  return data;
}

/**
 * 创建卡片实例并投递到群。
 * @param {object} p
 * @param {string} p.clientId
 * @param {string} p.clientSecret
 * @param {string} p.cardTemplateId 卡片模板 ID，形如 xxx.schema
 * @param {string} p.outTrackId 卡片实例唯一 ID（幂等键，重复用不会覆盖）
 * @param {string} p.openConversationId 群会话 ID，形如 cidXXX==
 * @param {string} p.robotCode 机器人 Code（投递到群必须）
 * @param {object} p.cardParamMap 卡片变量，key 必须与模板中的变量名一致
 * @param {string} [p.title] 会话列表里的摘要文案
 * @param {number} [p.userIdType] 1=userid
 */
async function createAndDeliverCard(p) {
  const {
    clientId,
    clientSecret,
    cardTemplateId,
    outTrackId,
    openConversationId,
    robotCode,
    cardParamMap,
    title,
    userIdType = 1,
  } = p;

  const missing = Object.entries({
    cardTemplateId,
    outTrackId,
    openConversationId,
    robotCode,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`缺少必填参数：${missing.join('、')}`);

  const body = {
    cardTemplateId,
    outTrackId,
    openSpaceId: `dtv1.card//IM_GROUP.${openConversationId}`,
    imGroupOpenSpaceModel: {
      supportForward: true,
      lastMessageI18n: { ZH_CN: title || '新卡片消息' },
    },
    imGroupOpenDeliverModel: { robotCode },
    // 必须 STREAM，否则按钮点击会走 HTTP 回调（需要公网）
    callbackType: 'STREAM',
    userIdType,
    cardData: { cardParamMap: cardParamMap || {} },
  };

  const run = async (forceToken) => {
    const token = await getAccessToken(clientId, clientSecret, forceToken);
    return callApi('POST', '/v1.0/card/instances/createAndDeliver', token, body);
  };

  try {
    return await run(false);
  } catch (err) {
    if (String(err.message).startsWith('__RETRY_TOKEN__')) {
      clearToken(clientId);
      return run(true);
    }
    throw err;
  }
}

/**
 * 原地刷新卡片变量。
 * @param {object} p
 * @param {string} p.outTrackId
 * @param {object} p.cardParamMap 只传要改的变量也行，钉钉按 key 合并
 */
async function updateCard(p) {
  const { clientId, clientSecret, outTrackId, cardParamMap } = p;
  if (!outTrackId) throw new Error('updateCard: outTrackId 不能为空');

  const body = { outTrackId, cardData: { cardParamMap: cardParamMap || {} } };

  const run = async (forceToken) => {
    const token = await getAccessToken(clientId, clientSecret, forceToken);
    return callApi('PUT', '/v1.0/card/instances', token, body);
  };

  try {
    return await run(false);
  } catch (err) {
    if (String(err.message).startsWith('__RETRY_TOKEN__')) {
      clearToken(clientId);
      return run(true);
    }
    throw err;
  }
}

/**
 * 生成 outTrackId。
 * 钉钉要求全局唯一，且同一个 outTrackId 重复 create 不会覆盖内容，
 * 所以每次新建都必须换一个。
 */
function newOutTrackId(prefix = 'nr') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/* ==================== 机器人发消息 ==================== */

/**
 * 机器人消息的消息模板 Key。
 * 接口方式支持 text/markdown/image/link/actionCard，**不支持** feedCard/语音/文件。
 * 注意 msgParam 是 JSON **字符串**，不是对象——传对象会报参数错误。
 */
const MSG_KEY = {
  TEXT: 'sampleText',
  MARKDOWN: 'sampleMarkdown',
  IMAGE: 'sampleImageMsg',
  LINK: 'sampleLink',
  ACTION_CARD: 'sampleActionCard',
};

/**
 * 带 token 重试的通用调用：401 时清缓存重取一次。
 * 抽出来是给新加的接口用，卡片那两个老接口保持原样不动。
 */
async function runWithToken(clientId, clientSecret, fn) {
  try {
    return await fn(await getAccessToken(clientId, clientSecret, false));
  } catch (err) {
    if (String(err.message).startsWith('__RETRY_TOKEN__')) {
      clearToken(clientId);
      return fn(await getAccessToken(clientId, clientSecret, true));
    }
    throw err;
  }
}

/**
 * 机器人发群消息。
 * @param {object} p
 * @param {string} p.openConversationId 群会话 ID（cidXXX==）
 * @param {string} p.msgKey MSG_KEY 之一
 * @param {object} p.msgParam 模板参数，内部会 JSON.stringify
 */
async function sendGroupMessage(p) {
  const { clientId, clientSecret, robotCode, openConversationId, msgKey, msgParam } = p;

  const missing = Object.entries({ robotCode, openConversationId, msgKey })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`缺少必填参数：${missing.join('、')}`);

  const body = {
    robotCode,
    openConversationId,
    msgKey,
    msgParam: typeof msgParam === 'string' ? msgParam : JSON.stringify(msgParam || {}),
  };

  return runWithToken(clientId, clientSecret, (token) =>
    callApi('POST', '/v1.0/robot/groupMessages/send', token, body)
  );
}

/**
 * 机器人发单聊消息（人与机器人会话）。
 * @param {object} p
 * @param {string[]} p.userIds 员工 userid 列表，最多 20 个
 */
async function sendSingleMessage(p) {
  const { clientId, clientSecret, robotCode, userIds, msgKey, msgParam } = p;

  const list = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String);
  if (!list.length) throw new Error('缺少 userIds（单聊必须指定接收人 userid）');
  if (list.length > 20) throw new Error(`userIds 最多 20 个，当前 ${list.length} 个`);
  if (!msgKey) throw new Error('缺少 msgKey');

  const body = {
    robotCode,
    userIds: list,
    msgKey,
    msgParam: typeof msgParam === 'string' ? msgParam : JSON.stringify(msgParam || {}),
  };

  return runWithToken(clientId, clientSecret, (token) =>
    callApi('POST', '/v1.0/robot/oToMessages/batchSend', token, body)
  );
}

/* ==================== 媒体上传 ==================== */

/** 按文件头判断图片类型，比看扩展名靠谱（微信/截图工具经常存错后缀） */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (buf.slice(0, 2).toString('latin1') === 'BM') {
    return { mime: 'image/bmp', ext: 'bmp' };
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/**
 * 上传媒体文件，拿到 mediaId。
 *
 * 走的是老网关 oapi.dingtalk.com（新域名没有对应接口），access_token 放 query。
 * 手工拼 multipart 而不是用 FormData：Node 18 的全局 FormData 还是实验性的，
 * 而这里只有「一个文件字段」这一种形态，手拼反而更稳、零依赖。
 *
 * @param {object} p
 * @param {Buffer} p.buffer
 * @param {string} [p.filename]
 * @param {string} [p.type] media 类型，图片固定 image
 */
async function uploadMedia(p) {
  const { clientId, clientSecret, buffer, filename, type = 'image' } = p;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('uploadMedia: 文件内容为空');

  // 图片上限 20MB，超了接口直接拒，提前拦一下给出可读的错误
  const MAX = 20 * 1024 * 1024;
  if (buffer.length > MAX) {
    throw new Error(`文件 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限`);
  }

  const sniff = sniffImage(buffer);
  const mime = sniff ? sniff.mime : 'application/octet-stream';
  const ext = sniff ? sniff.ext : 'bin';
  const name = filename || `upload.${ext}`;

  const boundary = `----nrding${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${name}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    'latin1'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1');
  const body = Buffer.concat([head, buffer, tail]);

  const doUpload = async (token) => {
    let res;
    try {
      res = await fetch(
        `https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
          signal: AbortSignal.timeout(60000), // 图片可能几 MB，给足时间
        }
      );
    } catch (err) {
      throw new Error(`上传媒体网络失败：${err.message}`);
    }

    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    // 老网关 token 失效返回的是 errcode 40014 / 88，不是 HTTP 401
    if (data && (data.errcode === 40014 || data.errcode === 88 || data.errcode === 40001)) {
      throw new Error(`__RETRY_TOKEN__${text.slice(0, 200)}`);
    }
    if (!res.ok || !data || data.errcode !== 0 || !data.media_id) {
      const detail = data ? `${data.errcode} ${data.errmsg || ''}` : text.slice(0, 200);
      throw new Error(`上传媒体失败（HTTP ${res.status}）：${detail}`);
    }
    return { mediaId: data.media_id, mime, size: buffer.length, type };
  };

  return runWithToken(clientId, clientSecret, doUpload);
}

/** 判断是不是内网地址——内网 URL 钉钉服务器取不到，必须先下载再上传 */
function isPrivateUrl(raw) {
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.local') || host.endsWith('.lan')) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

module.exports = {
  getAccessToken,
  clearToken,
  createAndDeliverCard,
  updateCard,
  newOutTrackId,
  MSG_KEY,
  sendGroupMessage,
  sendSingleMessage,
  uploadMedia,
  sniffImage,
  isPrivateUrl,
};

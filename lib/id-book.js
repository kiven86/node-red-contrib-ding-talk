'use strict';

/**
 * ID 台账 —— 把「见过的」conversationId / userid 攒起来，方便以后复制粘贴。
 *
 * 为什么需要它：
 *   conversationId（cidXXX==）在钉钉任何控制台都查不到，只能从会话事件里拿；
 *   userid 也不是手机号、不是昵称。每次要从 debug 日志里手工翻，很折磨。
 *   所以干脆收到消息就自动记一笔：群名 ↔ cid、昵称 ↔ userid，落在 userDir 下的
 *   dingtalk-ids.json 里，重启不丢，配节点时直接抄。
 */

const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 2000;
const SAVE_DEBOUNCE = 800;

let store = { conversations: {}, users: {}, updatedAt: 0 };
let filePath = '';
let saveTimer = null;
let ready = false;
let lastMtime = 0;
/** 有未落盘改动时不回读文件，否则会把刚记的覆盖掉 */
let dirty = false;

/** 只收标量，避免把对象塞进来变成 "[object Object]" */
function str(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return '';
  const s = String(v).trim();
  return s === '[object Object]' ? '' : s;
}

function init(dir) {
  if (ready) return;
  ready = true;
  if (dir) {
    filePath = path.join(dir, 'dingtalk-ids.json');
    load();
  }
}

function load() {
  if (!filePath) return store;
  try {
    const st = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      store.conversations = obj.conversations || {};
      store.users = obj.users || {};
      store.updatedAt = obj.updatedAt || 0;
    }
    lastMtime = st.mtimeMs;
  } catch (err) {
    // 首次运行没有文件是正常的
    if (err.code !== 'ENOENT') {
      console.warn(`[dingtalk-id-book] 读取台账失败：${err.message}`);
    }
  }
  return store;
}

/** 文件被外部改过（手工编辑、清空）就回读一次，免得内存一直是旧的 */
function sync() {
  if (!filePath || dirty) return;
  try {
    if (fs.statSync(filePath).mtimeMs !== lastMtime) load();
  } catch {
    /* 文件不在了也无所谓，内存里的继续用 */
  }
}

function flush() {
  if (!filePath) return;
  try {
    store.updatedAt = Date.now();
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, filePath);
    dirty = false;
    lastMtime = fs.statSync(filePath).mtimeMs;
  } catch (err) {
    console.warn(`[dingtalk-id-book] 写入台账失败：${err.message}`);
  }
}

function scheduleSave() {
  if (!filePath || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, SAVE_DEBOUNCE);
  if (saveTimer.unref) saveTimer.unref();
}

/** 条目太多时按末次出现时间淘汰，防止文件无限长大 */
function prune(map) {
  const keys = Object.keys(map);
  if (keys.length <= MAX_ITEMS) return;
  keys
    .sort((a, b) => (map[a].lastSeen || 0) - (map[b].lastSeen || 0))
    .slice(0, keys.length - MAX_ITEMS)
    .forEach((k) => delete map[k]);
}

let recorded = 0;

/**
 * 登记一条。entry 兼容多种来源的字段名：
 *   conversationId / openConversationId / cid
 *   conversationTitle / title / groupName
 *   userId / senderStaffId / staffId / userid
 *   nick / senderNick / userName
 */
function record(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const now = Date.now();
  const out = { conversation: null, user: null };

  const cid = str(entry.conversationId || entry.openConversationId || entry.cid);
  if (cid) {
    const prev =
      store.conversations[cid] ||
      { id: cid, title: '', type: '', source: '', count: 0, firstSeen: now };
    prev.title = str(entry.conversationTitle || entry.title || entry.groupName) || prev.title;
    prev.type = str(entry.conversationType) || prev.type;
    prev.source = str(entry.source) || prev.source;
    prev.count = (prev.count || 0) + 1;
    prev.lastSeen = now;
    store.conversations[cid] = prev;
    out.conversation = prev;
  }

  const uid = str(entry.userId || entry.senderStaffId || entry.staffId || entry.userid);
  if (uid) {
    const prev = store.users[uid] || { id: uid, nick: '', source: '', count: 0, firstSeen: now };
    prev.nick = str(entry.nick || entry.senderNick || entry.userName) || prev.nick;
    prev.source = str(entry.source) || prev.source;
    prev.count = (prev.count || 0) + 1;
    prev.lastSeen = now;
    store.users[uid] = prev;
    out.user = prev;
  }

  if (out.conversation || out.user) {
    recorded += 1;
    dirty = true;
    prune(store.conversations);
    prune(store.users);
    scheduleSave();
  }
  return out;
}

/** 从一条「接收消息」节点的输出里榨取可登记信息 */
function fromMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const d = (msg.dingtalk && typeof msg.dingtalk === 'object' ? msg.dingtalk : null) || msg;
  return record({
    conversationId: d.conversationId || msg.conversationId,
    conversationTitle: d.conversationTitle || d.title,
    conversationType: d.conversationType,
    senderStaffId: d.senderStaffId || d.userId || msg.userId || msg.userIds,
    senderNick: d.senderNick || d.nick,
    source: d.source || '',
  });
}

function toList(map) {
  return Object.values(map).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

function list() {
  sync();
  return {
    conversations: toList(store.conversations),
    users: toList(store.users),
    updatedAt: store.updatedAt,
    total: Object.keys(store.conversations).length + Object.keys(store.users).length,
  };
}

/** 模糊匹配：ID、群名、昵称都参与，支持多个关键词（都命中才返回） */
function find(query) {
  sync();
  const terms = String(query || '')
    .toLowerCase()
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!terms.length) return list();

  const hit = (item) => {
    const hay = `${item.id || ''} ${item.title || ''} ${item.nick || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  return {
    conversations: toList(store.conversations).filter(hit),
    users: toList(store.users).filter(hit),
    updatedAt: store.updatedAt,
  };
}

function clear() {
  store = { conversations: {}, users: {}, updatedAt: 0 };
  flush();
}

module.exports = {
  init,
  load,
  flush,
  record,
  fromMessage,
  list,
  find,
  clear,
  stats: () => ({ recorded, conversations: Object.keys(store.conversations).length, users: Object.keys(store.users).length }),
  get filePath() {
    return filePath;
  },
};

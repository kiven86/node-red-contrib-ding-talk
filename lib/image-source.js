'use strict';

/**
 * 图片来源归一化。
 *
 * 钉钉图片消息只认 photoURL（公网 URL 或 mediaId），所以调用方需要先知道
 * 手上的东西到底是「已经能直接用的 URL」还是「必须上传的二进制」。
 * 这个模块只解决这一件事，不碰钉钉 API。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { sniffImage } = require('./openapi');

const MAX_BYTES = 20 * 1024 * 1024;

/** 兼容老版本 Node 没有 AbortSignal.timeout 的情况 */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  if (t.unref) t.unref();
  return ac.signal;
}

/**
 * 把 payload 归一化成 { kind: 'buffer'|'url', buffer?, url?, label }
 */
async function resolveSource(payload, filename) {
  if (Buffer.isBuffer(payload)) {
    return { kind: 'buffer', buffer: payload, label: filename || 'buffer' };
  }

  if (typeof payload !== 'string' || !payload.trim()) {
    throw new Error('图片来源为空：msg.payload 需要本地路径 / URL / base64 / Buffer');
  }
  const raw = payload.trim();

  // data URI
  const m = raw.match(/^data:([\w/+.-]+);base64,(.+)$/s);
  if (m) {
    return { kind: 'buffer', buffer: Buffer.from(m[2], 'base64'), label: filename || 'inline.png' };
  }

  // http(s)
  if (/^https?:\/\//i.test(raw)) {
    return { kind: 'url', url: raw, label: raw };
  }

  // 本地文件（绝对路径 / file:// / ~ 开头 / 带图片扩展名）
  const p = raw.startsWith('file://') ? raw.slice(7) : raw;
  const looksPath =
    path.isAbsolute(p) || p.startsWith('~') || /\.(png|jpe?g|gif|bmp|webp)$/i.test(p);

  if (looksPath) {
    const abs = p.startsWith('~') ? path.join(process.env.HOME || '/root', p.slice(1)) : p;
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`本地图片不存在：${abs}`);
    }
    if (!stat.isFile()) throw new Error(`不是文件：${abs}`);
    if (stat.size > MAX_BYTES) {
      throw new Error(`图片 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限`);
    }
    return { kind: 'buffer', buffer: await fs.readFile(abs), label: path.basename(abs) };
  }

  // 兜底：纯 base64。不按长度猜（小图 base64 也可能不到 100 字符），
  // 而是解出来看文件头——能识别成图片才认，避免把普通文本误当图片。
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length >= 16) {
    const buf = Buffer.from(raw.replace(/\s/g, ''), 'base64');
    if (sniffImage(buf)) return { kind: 'buffer', buffer: buf, label: filename || 'base64.png' };
  }

  throw new Error(
    `无法识别的图片来源：${raw.slice(0, 80)}（支持本地路径 / http(s) URL / base64 / Buffer）`
  );
}

/** 下载远程图片，顺带校验「下回来的真是图片」——内网地址常返回登录页 HTML */
async function download(url) {
  let res;
  try {
    res = await fetch(url, { signal: timeoutSignal(30000) });
  } catch (err) {
    throw new Error(`下载图片失败：${err.message}`);
  }
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);

  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) {
    throw new Error(`远程图片 ${(len / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`远程图片 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限`);
  }
  if (!sniffImage(buf)) {
    throw new Error('下载到的内容不是图片（可能是登录页或错误页），检查 URL 是否需要鉴权');
  }
  return buf;
}

module.exports = { resolveSource, download, timeoutSignal, MAX_BYTES };

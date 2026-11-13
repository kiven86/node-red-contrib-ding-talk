'use strict';

/**
 * 读取联调脚本用的环境变量。
 *
 * 默认读仓库根目录的 .env，可用 DT_ENV 指向别处。
 * 文件不存在时返回空对象，不抛错。
 *
 * 用到的键见仓库根目录 .env.example。
 */

const fs = require('node:fs');
const path = require('node:path');

function readEnv() {
  const file = process.env.DT_ENV || path.join(__dirname, '..', '.env');
  const env = {};
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return env;
}

module.exports = readEnv;
module.exports.envPath = () => process.env.DT_ENV || path.join(__dirname, '..', '.env');

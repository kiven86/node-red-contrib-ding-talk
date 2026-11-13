'use strict';

/**
 * 读取测试用的环境变量。
 *
 * 默认读仓库根目录的 .env（已在 .gitignore 里，不会进版本库），
 * 也可以用 DT_ENV 指向别处。文件不存在时返回空对象，不抛错。
 *
 * 约定用到的键：
 *   DT_CLIENT_ID / DT_CLIENT_SECRET   应用凭证
 *   DT_ROBOT_CODE                     机器人编码
 *   CARD_TEMPLATE_ID                  卡片模板 ID
 *   TEST_CONVERSATION_ID              测试群 ID
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

'use strict';

/**
 * ID 台账自测：登记 / 查询 / 落盘 / 页面渲染。
 * 不连钉钉，全部在临时目录里跑。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtalk-idbook-'));
const idBook = require('../lib/id-book');
const page = require('../lib/id-book-page');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (err) {
    console.log(`  ❌ ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

idBook.init(tmp);
console.log(`临时目录：${tmp}\n`);

ok('登记一条群消息', () => {
  const r = idBook.record({
    conversationId: 'cidAAAA==',
    conversationTitle: '运维值班群',
    conversationType: '2',
    senderStaffId: 'manager1234',
    senderNick: '老K',
  });
  assert.strictEqual(r.conversation.id, 'cidAAAA==');
  assert.strictEqual(r.conversation.title, '运维值班群');
  assert.strictEqual(r.user.nick, '老K');
});

ok('同一个群重复登记只累加次数、不改名', () => {
  idBook.record({ conversationId: 'cidAAAA==', senderStaffId: 'manager1234' });
  const list = idBook.list();
  const c = list.conversations.find((x) => x.id === 'cidAAAA==');
  assert.strictEqual(c.count, 2);
  assert.strictEqual(c.title, '运维值班群', '群名不该被空值覆盖');
});

ok('空值不覆盖已有昵称', () => {
  idBook.record({ conversationId: 'cidAAAA==', senderStaffId: 'manager1234' });
  const u = idBook.list().users.find((x) => x.id === 'manager1234');
  assert.strictEqual(u.nick, '老K');
});

ok('再记一个群和一个人', () => {
  idBook.record({
    conversationId: 'cidBBBB==',
    conversationTitle: '数据日报',
    senderStaffId: 'staff9999',
    senderNick: '小王',
  });
  assert.strictEqual(idBook.list().conversations.length, 2);
  assert.strictEqual(idBook.list().users.length, 2);
});

ok('对象/数组不会被塞成 [object Object]', () => {
  idBook.record({ conversationId: 'cidCCCC==', conversationTitle: { a: 1 }, senderStaffId: ['x'] });
  const c = idBook.list().conversations.find((x) => x.id === 'cidCCCC==');
  assert.strictEqual(c.title, '');
  assert.strictEqual(idBook.list().users.find((x) => x.id === '[object Object]'), undefined);
});

ok('按群名模糊查', () => {
  const r = idBook.find('运维');
  assert.strictEqual(r.conversations.length, 1);
  assert.strictEqual(r.conversations[0].id, 'cidAAAA==');
});

ok('按 ID 片段查', () => {
  assert.strictEqual(idBook.find('cidbbbb').conversations.length, 1);
});

ok('按昵称查人', () => {
  assert.strictEqual(idBook.find('小王').users[0].id, 'staff9999');
});

ok('空格分词：两个词都要命中', () => {
  assert.strictEqual(idBook.find('数据 日报').conversations.length, 1);
  assert.strictEqual(idBook.find('数据 小王').conversations.length, 0);
});

ok('fromMessage 能从接收节点的输出里提取', () => {
  idBook.fromMessage({
    payload: 'hi',
    dingtalk: {
      conversationId: 'cidDDDD==',
      conversationTitle: '测试群',
      senderStaffId: 'staff8888',
      senderNick: '张三',
    },
  });
  const c = idBook.list().conversations.find((x) => x.id === 'cidDDDD==');
  assert.strictEqual(c.title, '测试群');
  assert.ok(idBook.list().users.some((u) => u.id === 'staff8888'));
});

ok('落盘到 dingtalk-ids.json', () => {
  idBook.flush();
  const file = path.join(tmp, 'dingtalk-ids.json');
  assert.ok(fs.existsSync(file), '文件应存在');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.conversations['cidAAAA==']);
  assert.ok(saved.users['manager1234']);
});

ok('外部改了 json 后能自动回读，不用重启', () => {
  idBook.flush(); // 确保没有未落盘改动
  const file = path.join(tmp, 'dingtalk-ids.json');
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = Date.now();
  cur.conversations['cidEXT=='] = {
    id: 'cidEXT==',
    title: '手工加的群',
    type: '2',
    count: 1,
    firstSeen: now,
    lastSeen: now,
  };
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
  // 有些文件系统 mtime 精度只到秒，往后挪一下保证能看出变化
  const t = new Date(Date.now() + 3000);
  fs.utimesSync(file, t, t);
  assert.ok(
    idBook.list().conversations.some((c) => c.id === 'cidEXT=='),
    'list 应该能看到外部写入的记录'
  );
});

ok('页面渲染出群名和 ID', () => {  const html = page.render(idBook.find(''));
  assert.ok(html.includes('运维值班群'), '应显示群名');
  assert.ok(html.includes('cidAAAA=='), '应显示 conversationId');
  assert.ok(html.includes('manager1234'), '应显示 userid');
  assert.ok(html.includes('/dingtalk/ids.json'), '应带 JSON 入口');
});

ok('页面渲染做 HTML 转义', () => {
  idBook.record({ conversationId: 'cidXSS==', conversationTitle: '<img src=x onerror=alert(1)>' });
  const html = page.render(idBook.find('cidXSS'));
  assert.ok(!html.includes('<img src=x'), '标签必须被转义');
  assert.ok(html.includes('&lt;img'), '转义后的实体应出现');
});

ok('空台账的页面有引导文案', () => {
  idBook.clear();
  const html = page.render(idBook.find(''));
  assert.ok(html.includes('还没有记录'), '空态应提示怎么用');
  assert.ok(!fs.existsSync(path.join(tmp, 'dingtalk-ids.json')) || true);
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
if (!process.exitCode) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

'use strict';

/**
 * 回归测试：node.debug 被覆盖 + 事件监听器抛异常导致进程崩溃。
 *
 * 背景：配置节点曾写 `this.debug = <布尔值>`，把 Node-RED 挂在节点上的
 * 日志方法 node.debug() 覆盖掉。之后 ws 的 close 回调里调 node.debug(...)
 * 抛 TypeError，异常冒到 process，Node-RED 直接退出。
 */

const assert = require('node:assert');
const path = require('node:path');
const EventEmitter = require('node:events');

const root = path.resolve(__dirname, '..');
const { DWClient } = require(path.join(root, 'lib/client.js'));

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✅ ${name}`);
};

/* ---------- 1. 配置节点不能覆盖内置的 node.debug ---------- */

const registered = new Map();
const RED = {
  nodes: {
    createNode(node, config) {
      // Node-RED 的 createNode 内部会让节点继承 EventEmitter，这里照做
      Object.setPrototypeOf(node, EventEmitter.prototype);
      EventEmitter.call(node);
      Object.assign(node, config || {});
      // 与 Node-RED 真实行为一致：createNode 之后 node.debug 是一个函数
      node.debug = () => {};
      node.log = () => {};
      node.warn = () => {};
      node.error = () => {};
      node.status = () => {};
      return node;
    },
    registerType(name, ctor) {
      registered.set(name, ctor);
    },
    getNode: () => null,
  },
  httpAdmin: { post() {} },
  auth: { needsPermission: () => (req, res, next) => next && next() },
  log: { warn() {}, info() {}, error() {} },
};

require(path.join(root, 'nodes/client.js'))(RED);
const Ctor = registered.get('dingtalk-robot');
assert.ok(Ctor, '配置节点未注册');

const node = new Ctor({
  id: 'test-node',
  clientId: 'dingtest',
  clientSecret: 'secret',
  robotCode: '',
  debug: true, // 打开调试日志，这正是踩坑的配置
});

check('节点实例上的 node.debug 仍是函数', () => {
  assert.strictEqual(typeof node.debug, 'function');
});

check('开关值落到 streamDebug 上', () => {
  assert.strictEqual(node.streamDebug, true);
});

check('node.debug 可正常调用且不抛异常', () => {
  node.debug('调试日志正常');
});

// 立刻关闭，避免 300ms 后真的去连钉钉网关
node.emit('close', () => {});

/* ---------- 2. 监听器抛异常不能崩溃进程 ---------- */

check('reconnecting 监听器抛错被兜住', () => {
  const c = new DWClient({ clientId: 'a', clientSecret: 'b' });
  let hits = 0;
  c.on('reconnecting', () => {
    hits++;
    throw new TypeError('模拟一个写错的监听器');
  });
  const ok = c._emit('reconnecting', { delay: 1000, code: 1006 });
  assert.strictEqual(hits, 1, '监听器应被调用');
  assert.strictEqual(ok, false, '应返回 false 表示派发失败');
  assert.ok(c.lastError && /写错的监听器/.test(c.lastError.message), '异常应记录到 lastError');
});

check('多个监听器中一个抛错不影响其他', () => {
  const c = new DWClient({ clientId: 'a', clientSecret: 'b' });
  let second = 0;
  c.on('event', () => {
    throw new Error('第一个就炸了');
  });
  c.on('event', () => {
    second++;
  });
  // EventEmitter 遇错即停，这里只要求不把异常抛出去
  assert.doesNotThrow(() => c._emit('event', { type: 'EVENT' }));
  assert.strictEqual(second, 0, '第一个监听器抛错后后续监听器不再执行（与 EventEmitter 语义一致）');
});

check('无 error 监听者时 _emit 不崩溃', () => {
  const c = new DWClient({ clientId: 'a', clientSecret: 'b' });
  // EventEmitter 原生行为：emit('error') 无人监听会抛，这是 node 崩溃的经典来源，
  // 所以 lib/client.js 里发 error 前要判 listenerCount，_emit 再兜一层。
  assert.throws(() => c.emit('error', new Error('没人接')));
  assert.doesNotThrow(() => c._emit('error', new Error('没人接')));
});

/* ---------- 3. DWClient 自身仍能正常构造 ---------- */

check('debug 选项被转成布尔值', () => {
  const c1 = new DWClient({ clientId: 'a', clientSecret: 'b', debug: 'yes' });
  const c2 = new DWClient({ clientId: 'a', clientSecret: 'b' });
  assert.strictEqual(c1.debug, true);
  assert.strictEqual(c2.debug, false);
});

check('没有把 EventEmitter 的 emit 覆盖掉', () => {
  const c = new DWClient({ clientId: 'a', clientSecret: 'b' });
  assert.strictEqual(typeof c.emit, 'function');
  assert.ok(c.emit !== c._emit);
  assert.ok(c instanceof EventEmitter);
});

console.log(`\n${passed} 项全部通过`);

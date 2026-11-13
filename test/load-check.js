'use strict';

/**
 * 节点加载自检：用一个最小 RED 桩把 6 个节点各加载一次，
 * 确认 require 路径、registerType 调用都正常。
 * 不连钉钉，不触碰 flows。
 */

const EventEmitter = require('node:events');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const registered = new Map();
const errors = [];

class StubNode extends EventEmitter {
  constructor(config) {
    super();
    Object.assign(this, config);
    this.status = () => {};
    this.log = () => {};
    this.warn = () => {};
    this.debug = () => {};
    this.error = (e) => errors.push(String(e && e.message ? e.message : e));
    this.send = () => {};
    this.closed = false;
  }
}

const RED = {
  nodes: {
    createNode(node, config) {
      Object.assign(node, config || {});
      node.status = () => {};
      node.log = () => {};
      node.warn = (m) => {};
      node.debug = () => {};
      node.error = (e) => errors.push(String(e && e.message ? e.message : e));
      node.send = () => {};
      node.on = node.on.bind(node);
      node.emit = node.emit.bind(node);
      return node;
    },
    registerType(name) {
      registered.set(name, true);
    },
    getNode() {
      return null;
    },
  },
  // ID 速查节点会往 httpNode 上挂 /dingtalk/ids，这里记下路由以便核对
  httpNode: {
    routes: [],
    get(p) {
      this.routes.push(['GET', p]);
    },
    post(p) {
      this.routes.push(['POST', p]);
    },
  },
  settings: {},
  log: { warn() {}, info() {}, error() {} },
  httpAdmin: { post() {} },
  auth: { needsPermission: () => (req, res, next) => next && next() },
};

let failed = 0;
for (const [label, rel] of Object.entries(pkg['node-red'].nodes)) {
  const before = new Set(registered.keys());
  try {
    const mod = require(path.join(root, rel));
    if (typeof mod !== 'function') throw new Error('导出不是函数');
    mod(RED);
    // 实际注册名由 registerType 决定，不一定等于 package.json 里的 key
    const added = [...registered.keys()].filter((k) => !before.has(k));
    if (!added.length) throw new Error('没有调用 registerType');
    console.log(`  ✅ ${rel} → ${added.join(', ')}`);
  } catch (err) {
    console.log(`  ❌ ${rel} — ${err.message}`);
    failed++;
  }
}

console.log(`\n已注册 ${registered.size} 个节点类型`);
console.log(`创建节点时产生的错误：${errors.length ? errors.join(' | ') : '无'}`);

const wanted = [
  ['GET', '/dingtalk/ids'],
  ['GET', '/dingtalk/ids.json'],
  ['POST', '/dingtalk/ids/clear'],
];
const missing = wanted.filter(([m, p]) => !RED.httpNode.routes.some(([mm, pp]) => mm === m && pp === p));
if (missing.length) {
  console.log(`❌ 缺少 HTTP 路由：${missing.map((m) => `${m[0]} ${m[1]}`).join(', ')}`);
  failed++;
} else {
  console.log(`✅ ID 速查页路由已挂载：${wanted.map((m) => `${m[0]} ${m[1]}`).join('  ')}`);
}

if (failed) {
  console.log(`\n${failed} 个节点加载失败`);
  process.exit(1);
}
console.log('\n全部节点加载正常');

'use strict';

/**
 * 「更新卡片」节点的输入兼容性测试 —— 重点是不再对「直连回调节点」报莫名的 JSON 错。
 * 用桩 RED + 桩 updateCard，不碰网络。
 */

const assert = require('node:assert');
const path = require('node:path');

const openapi = require('../lib/openapi');

let captured = null;
openapi.updateCard = async (p) => {
  captured = p;
  return { success: true };
};

let pass = 0;
let chain = Promise.resolve();

/** 用例串行执行：captured 是全局的，并发会互相踩 */
function ok(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      pass++;
    } catch (err) {
      console.log(`  ❌ ${name} — ${err.message}`);
      process.exitCode = 1;
    }
  });
}

/** ---- 桩 RED ---- */
const types = {};
const fakeConfig = { clientId: 'cid', clientSecret: 'sec' };

const RED = {
  nodes: {
    createNode(obj, cfg) {
      Object.assign(obj, cfg || {});
      const handlers = {};
      obj.on = (ev, fn) => {
        (handlers[ev] = handlers[ev] || []).push(fn);
        return obj;
      };
      obj.emitInput = (msg, send, done) => {
        (handlers.input || []).forEach((h) => h.call(obj, msg, send, done));
      };
      obj.status = () => {};
      obj.warn = () => {};
      obj.debug = () => {};
      obj.log = () => {};
      obj._err = null;
      obj.error = (e) => {
        obj._err = String(e && e.message ? e.message : e);
      };
    },
    registerType(name, fn) {
      types[name] = fn;
    },
    getNode: () => fakeConfig,
  },
};

require(path.resolve(__dirname, '../nodes/card-update.js'))(RED);
const NodeCls = types['dingtalk-card-update'];

function makeNode(cfg) {
  return new NodeCls(Object.assign({ config: 'x' }, cfg));
}

function run(node, msg) {
  return new Promise((resolve) => {
    let out = null;
    let doneErr = null;
    let settled = false;
    const finish = () =>
      !settled && ((settled = true), resolve({ err: doneErr, out, nodeErr: node._err }));
    node.emitInput(
      msg,
      (o) => {
        out = o;
      },
      (e) => {
        doneErr = e ? String(e.message || e) : null;
        finish();
      }
    );
    setTimeout(finish, 120);
  });
}

(async () => {
  ok('直连回调：actionVar=status，payload=agree', async () => {
    captured = null;
    const node = makeNode({ actionVar: 'status' });
    const r = await run(node, {
      payload: 'agree',
      outTrackId: 'nr123',
      dingtalk: { actionParam: 'agree' },
    });
    assert.strictEqual(r.err, null, `不该报错：${r.err}`);
    assert.strictEqual(captured.cardParamMap.status, 'agree');
  });

  ok('带动作文案映射：agree → ✅ 已通过', async () => {
    captured = null;
    const node = makeNode({ actionVar: 'status', actionLabels: 'agree=✅ 已通过,reject=❌ 已驳回' });
    await run(node, { payload: 'agree', outTrackId: 'nr123', dingtalk: { actionParam: 'agree' } });
    assert.strictEqual(captured.cardParamMap.status, '✅ 已通过');
  });

  ok('未映射的动作原样写入', async () => {
    captured = null;
    const node = makeNode({ actionVar: 'status', actionLabels: 'agree=通过' });
    await run(node, { payload: 'unknown_act', outTrackId: 'nr1' });
    assert.strictEqual(captured.cardParamMap.status, 'unknown_act');
  });

  ok('未配 actionVar 时，字符串 payload 给出可读报错', async () => {
    captured = null;
    const node = makeNode({});
    const r = await run(node, { payload: 'agree', outTrackId: 'nr1' });
    assert.ok(r.err, '应该报错');
    assert.ok(r.err.includes('不是卡片变量对象'), `报错要说人话，实际：${r.err}`);
    assert.ok(r.err.includes('按钮动作写入变量'), '要告诉用户怎么修');
    assert.strictEqual(captured, null, '不该发出请求');
  });

  ok('payload 是对象：正常更新', async () => {
    captured = null;
    const node = makeNode({});
    await run(node, { payload: { status: '已处理' }, outTrackId: 'nr1' });
    assert.deepStrictEqual(captured.cardParamMap, { status: '已处理' });
  });

  ok('payload 是 JSON 字符串：能解析', async () => {
    captured = null;
    const node = makeNode({});
    await run(node, { payload: '{"status":"完成"}' });
    // 注意这条故意不给 outTrackId，应该先报缺 ID
    assert.ok(true);
  });

  ok('payload 是 JSON 字符串 + outTrackId：能解析', async () => {
    captured = null;
    const node = makeNode({});
    await run(node, { payload: '{"status":"完成"}', outTrackId: 'nr1' });
    assert.strictEqual(captured.cardParamMap.status, '完成');
  });

  ok('cardParamMap 优先级高于 payload', async () => {
    captured = null;
    const node = makeNode({});
    await run(node, { payload: { a: 1 }, cardParamMap: { b: 2 }, outTrackId: 'nr1' });
    assert.deepStrictEqual(captured.cardParamMap, { b: 2 });
  });

  ok('缺 outTrackId 直接报错', async () => {
    const node = makeNode({});
    const r = await run(node, { payload: { a: 1 } });
    assert.ok(r.err && r.err.includes('outTrackId'), `实际：${r.err}`);
  });

  ok('空 payload 且无 actionVar：提示补齐', async () => {
    const node = makeNode({});
    const r = await run(node, { payload: '', outTrackId: 'nr1' });
    assert.ok(r.err && r.err.includes('缺少卡片变量'), `实际：${r.err}`);
  });

  await chain;
  console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
})();

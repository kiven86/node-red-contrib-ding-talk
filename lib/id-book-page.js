'use strict';

/** 生成 ID 速查页面的 HTML。纯静态 + 前端过滤，不依赖任何 CDN。 */

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ago(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  return `${Math.floor(d / 86400e3)} 天前`;
}

function render(data) {
  const conversations = data.conversations || [];
  const users = data.users || [];

  const convRows = conversations
    .map(
      (c) => `<tr data-k="${esc(`${c.id} ${c.title || ''}`.toLowerCase())}">
      <td class="t">${esc(c.title) || '<span class="muted">（未命名）</span>'}</td>
      <td class="id"><code>${esc(c.id)}</code></td>
      <td class="c">${c.type === '1' ? '单聊' : c.type === '2' ? '群聊' : '—'}</td>
      <td class="c">${c.count || 0}</td>
      <td class="c muted">${ago(c.lastSeen)}</td>
      <td class="c"><button class="cp" data-v="${esc(c.id)}">复制</button></td>
    </tr>`
    )
    .join('');

  const userRows = users
    .map(
      (u) => `<tr data-k="${esc(`${u.id} ${u.nick || ''}`.toLowerCase())}">
      <td class="t">${esc(u.nick) || '<span class="muted">（未知）</span>'}</td>
      <td class="id"><code>${esc(u.id)}</code></td>
      <td class="c">${u.count || 0}</td>
      <td class="c muted">${ago(u.lastSeen)}</td>
      <td class="c"><button class="cp" data-v="${esc(u.id)}">复制</button></td>
    </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>钉钉 ID 速查</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 60px;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #1f2328;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  h1 { font-size: 20px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  .meta { color: #6e7781; font-size: 12px; }
  .hint { color: #6e7781; font-size: 12.5px; margin: 6px 0 18px; }
  .bar { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  input[type=search] {
    flex: 1 1 260px; min-width: 200px; padding: 9px 12px; font-size: 14px;
    border: 1px solid #d0d7de; border-radius: 8px; background: #fff; color: inherit; outline: none;
  }
  input[type=search]:focus { border-color: #5aa9e6; box-shadow: 0 0 0 3px rgba(90,169,230,.18); }
  button {
    padding: 8px 14px; font-size: 13px; border-radius: 8px; cursor: pointer;
    border: 1px solid #d0d7de; background: #fff; color: inherit;
  }
  button:hover { background: #eef1f4; }
  a.btn { padding: 8px 14px; font-size: 13px; border-radius: 8px; text-decoration: none;
    border: 1px solid #d0d7de; background: #fff; color: inherit; }
  section { margin-bottom: 30px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  h2 .n { font-weight: 400; color: #6e7781; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden;
    box-shadow: 0 1px 2px rgba(1,4,9,.06), 0 0 0 1px rgba(1,4,9,.05); }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid #eaeef2; vertical-align: middle; }
  th { font-size: 12px; font-weight: 600; color: #6e7781; background: #fafbfc; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  td.t { font-weight: 500; }
  td.c { text-align: center; white-space: nowrap; }
  td.id code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; background: #f2f4f7; padding: 2px 6px; border-radius: 5px; word-break: break-all; }
  .muted { color: #8c959f; font-weight: 400; }
  .cp { padding: 3px 9px; font-size: 12px; border-radius: 6px; }
  .cp.ok { border-color: #2da44e; color: #2da44e; }
  .empty { padding: 26px; text-align: center; color: #8c959f; background: #fff; border-radius: 10px;
    box-shadow: 0 1px 2px rgba(1,4,9,.06), 0 0 0 1px rgba(1,4,9,.05); }
  .empty code { background: #f2f4f7; padding: 2px 6px; border-radius: 5px; font-size: 12px; }
  footer { margin-top: 34px; color: #8c959f; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    input[type=search], button, a.btn { background: #161b22; border-color: #30363d; }
    button:hover { background: #21262d; }
    table { background: #161b22; box-shadow: 0 0 0 1px #30363d; }
    th { background: #1c2128; color: #8b949e; }
    th, td { border-bottom-color: #21262d; }
    td.id code, .empty code { background: #21262d; }
    .empty { background: #161b22; box-shadow: 0 0 0 1px #30363d; }
    .hint, .meta, .muted { color: #8b949e; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>钉钉 ID 速查</h1>
    <span class="meta">共 ${conversations.length} 个会话 / ${users.length} 个人</span>
  </header>
  <p class="hint">
    看到谁在群里 @ 机器人、或谁单聊机器人，这里就会自动多一行。<b>群 ID</b> 填到「发送文本 / 发送卡片」的群 ID 栏，
    <b>userid</b> 填到接收人栏。两者在钉钉控制台都查不到，只能这样攒。
  </p>

  <div class="bar">
    <input type="search" id="q" placeholder="搜索群名 / 昵称 / ID（支持空格分词）" autocomplete="off">
    <a class="btn" href="/dingtalk/ids.json" target="_blank">JSON</a>
    <button id="clear">清空台账</button>
  </div>

  <section>
    <h2>会话 <span class="n">conversationId</span></h2>
    ${
      conversations.length
        ? `<table id="t-conv">
      <thead><tr><th>群名 / 备注</th><th>conversationId</th><th>类型</th><th>次数</th><th>最近</th><th></th></tr></thead>
      <tbody>${convRows}</tbody>
    </table>`
        : `<div class="empty">还没有记录。把「接收消息」节点连到「ID 速查」节点，然后在群里 <code>@机器人</code> 随便说句话。</div>`
    }
  </section>

  <section>
    <h2>人员 <span class="n">userid / staffId</span></h2>
    ${
      users.length
        ? `<table id="t-user">
      <thead><tr><th>昵称</th><th>userid</th><th>次数</th><th>最近</th><th></th></tr></thead>
      <tbody>${userRows}</tbody>
    </table>`
        : `<div class="empty">还没有记录。同一个人在群里 <code>@机器人</code>，或私聊机器人一句话，userid 就进来了。</div>`
    }
  </section>

  <footer>数据落在 Node-RED userDir 的 <code>dingtalk-ids.json</code>，刷新页面即是最新；最多保留 2000 条。</footer>
</div>
<script>
(function () {
  var q = document.getElementById('q');

  function filter() {
    var terms = q.value.toLowerCase().split(/[\\s,，]+/).filter(Boolean);
    document.querySelectorAll('tbody tr').forEach(function (tr) {
      var k = tr.getAttribute('data-k') || '';
      var ok = terms.every(function (t) { return k.indexOf(t) !== -1; });
      tr.style.display = ok ? '' : 'none';
    });
  }
  q.addEventListener('input', filter);

  document.addEventListener('click', function (e) {
    var b = e.target.closest('.cp');
    if (!b) return;
    var v = b.getAttribute('data-v');
    var done = function () {
      var old = b.textContent;
      b.textContent = '已复制';
      b.classList.add('ok');
      setTimeout(function () { b.textContent = old; b.classList.remove('ok'); }, 1200);
    };
    if (navigator.clipboard && location.protocol === 'https:') {
      navigator.clipboard.writeText(v).then(done, fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = v; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (err) {}
      document.body.removeChild(ta);
    }
  });

  document.getElementById('clear').addEventListener('click', function () {
    if (!confirm('确定清空所有已记录的 ID？')) return;
    fetch('/dingtalk/ids/clear', { method: 'POST' }).then(function () { location.reload(); });
  });
})();
</script>
</body>
</html>`;
}

module.exports = { render };

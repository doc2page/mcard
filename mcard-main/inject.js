/*
 * inject.js — 运行在 MAIN world（与页面同一个 JS 上下文）
 *
 * 职责：
 *   拦截 window.fetch 与 XMLHttpRequest，捕获 msgsearch 接口的
 *   【请求体】与【响应体】，给每次请求分配单调递增的 reqId，通过 window.postMessage
 *   转发给 content.js（ISOLATED world）。
 *   （market/list 与 member/profile 已改为 background 通过 mtFetch 直连 api.m-team.cc，
 *    不再经此处拦截。）
 *
 * 关键点：
 *   - 由 manifest 的 content_scripts(world:MAIN, run_at:document_start) 声明式注入，
 *     时机早于页面首个请求，因此不会漏掉早期请求。
 *   - 不需要 web_accessible_resources，也不需要动态插入 <script>。
 *   - 必须用 resp.clone() 再异步读取，避免消费原始 body 导致页面报错。
 *   - 原样返回 fetch/XHR 的结果，对页面完全无感。
 */
(() => {
  if (window.__mtmInjected) return;
  window.__mtmInjected = true;

  const ENDPOINTS = [
    // msgsearch：message 页(/message/-2)加载即请求，返回「卡片掉落」等系统消息；用于历史掉落概率统计
    // （orderbook 端点已于 v0.2.5 购买改 buy 直连后移除——detail tab 链路不再存在）
    { key: 'msgsearch', path: '/api/msg/search', type: 'MSG_SEARCH' },
  ];
  const matchEndpoint = (url) => {
    for (const e of ENDPOINTS) if (url.indexOf(e.path) !== -1) return e;
    return null;
  };
  let seq = 0;

  // 发消息给 content.js（ISOLATED）。event.source===window 用于 content 侧校验来源。
  const post = (msg) => {
    try {
      window.postMessage(Object.assign({ source: 'mtm-inject' }, msg), '*');
    } catch (e) {
      /* 忽略，绝不影响页面 */
    }
  };

  // 请求体可能是 JSON 字符串 / FormData / URLSearchParams / 对象，尽力解析
  const safeParse = (x) => {
    if (x == null) return null;
    if (typeof x === 'string') {
      try { return JSON.parse(x); } catch (e) {
        // 可能是 form-urlencoded：a=1&b=2
        try {
          const params = {};
          new URLSearchParams(x).forEach((v, k) => { params[k] = v; });
          return Object.keys(params).length ? params : { _raw: x.slice(0, 500) };
        } catch (e2) { return { _raw: x.slice(0, 500) }; }
      }
    }
    // FormData
    if (typeof FormData !== 'undefined' && x instanceof FormData) {
      const o = {};
      x.forEach((v, k) => { o[k] = v; });
      return o;
    }
    return x;
  };

  // ---------- hook fetch ----------
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
    } catch (e) {}

    const ep = matchEndpoint(url);
    if (ep) {
      const reqId = ++seq;
      const t0 = performance.now();
      let method = 'GET';
      let body = null;
      try {
        method = (init && init.method) || (typeof input === 'object' && input && input.method) || 'GET';
        body = init && init.body;
      } catch (e) {}

      const p = _fetch.apply(this, arguments);
      p.then((resp) => {
        try {
          const clone = resp.clone();
          clone.text().then((txt) => {
            console.log('[MTEAM] fetch captured', ep.key, reqId, resp.status);
            post({
              type: ep.type,
              endpoint: ep.key,
              reqId,
              request: { url, method, body: safeParse(body) },
              response: safeParse(txt),
              latency: performance.now() - t0,
              channel: 'fetch',
            });
          }).catch(() => {});
        } catch (e) {}
      }).catch(() => {});
      return p;
    }
    return _fetch.apply(this, arguments);
  };

  // ---------- hook XMLHttpRequest ----------
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__mtm = { method, url, reqId: ++seq, t0: performance.now(), body: null };
    } catch (e) {}
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const ep = this.__mtm && this.__mtm.url ? matchEndpoint(this.__mtm.url) : null;
      if (this.__mtm && ep) {
        this.__mtm.body = body;
        this.addEventListener('load', () => {
          try {
            console.log('[MTEAM] xhr captured', ep.key, this.__mtm.reqId, this.status);
            post({
              type: ep.type,
              endpoint: ep.key,
              reqId: this.__mtm.reqId,
              request: { url: this.__mtm.url, method: this.__mtm.method, body: safeParse(this.__mtm.body) },
              response: safeParse(this.responseText),
              latency: performance.now() - this.__mtm.t0,
              channel: 'xhr',
            });
          } catch (e) {}
        });
      }
    } catch (e) {}
    return _send.apply(this, arguments);
  };

  // 响应 content 的 PING：无论两者谁先注入，content 都能拿到 INJECT_READY
  // （本脚本若先于 content 注入，主动发的 INJECT_READY 会被丢失，靠 PING 补救）
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d && d.source === 'mtm-content' && d.type === 'PING') {
      post({ type: 'INJECT_READY' });
    }
  });

  console.log('[MTEAM] inject success');
  post({ type: 'INJECT_READY' });
})();

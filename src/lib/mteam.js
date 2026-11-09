// src/lib/mteam.js
import { API_OPTS } from './shared.js';
import { ProxyAgent } from 'undici';   // 仅用 ProxyAgent；fetch 走全局（内置 undici 认 duck-typed dispatcher，测试 mock 全局 fetch 亦不受影响）

export function createMteam({ getApiKey, getApiBase, setApiBase, getProxy }) {
  // 代理 dispatcher：config.proxy（面板可配，空=直连）→ undici ProxyAgent；按 URL 缓存复用（每次 new 会泄漏连接池），切换时关闭旧池
  let _agent = null, _agentUrl = '';
  async function _dispatcher() {
    let p = '';
    try { p = (await getProxy()) || ''; } catch (e) { p = ''; }
    if (!p) {
      if (_agent) { const old = _agent; _agent = null; _agentUrl = ''; old.close().catch(() => {}); }
      return undefined;
    }
    if (_agentUrl !== p || !_agent) {
      if (_agent) _agent.close().catch(() => {});
      _agent = new ProxyAgent(p);
      _agentUrl = p;
    }
    return _agent;
  }

  async function _mtFetchOnce(base, path, body, dispatcher) {
    const token = await getApiKey();
    if (!token) throw new Error('NO_API_KEY');
    const res = await fetch('https://' + base + path, {
      method: 'POST',
      headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      ...(dispatcher ? { dispatcher } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 || String(json.code) === '401') throw new Error('API_KEY_INVALID');
    return json;
  }

  async function mtFetch(path, body) {
    const cur = (await getApiBase()) || 'api.m-team.cc';
    const dispatcher = await _dispatcher();
    try {
      return await _mtFetchOnce(cur, path, body, dispatcher);
    } catch (e) {
      if (e && e.message === 'API_KEY_INVALID') throw e;
      const other = API_OPTS.find((b) => b !== cur) || 'api.m-team.io';
      const r = await _mtFetchOnce(other, path, body, dispatcher);
      await setApiBase(other);
      return r;
    }
  }

  async function verifyApiKey(key) {
    let netFail = 0;
    const dispatcher = await _dispatcher();
    for (const base of API_OPTS) {
      try {
        const res = await fetch('https://' + base + '/api/member/profile', {
          method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: '{}',
          ...(dispatcher ? { dispatcher } : {}),
        });
        const json = await res.json().catch(() => ({}));
        if (String(json.code) === '0') return { ok: true, apiBase: base };
      } catch (e) { netFail++; }
    }
    return { ok: false, reason: netFail >= API_OPTS.length ? 'network' : 'invalid' };
  }

  return { mtFetch, verifyApiKey };
}

// src/lib/mteam.js
import { API_OPTS } from './shared.js';

export function createMteam({ getApiKey, getApiBase, setApiBase }) {
  async function _mtFetchOnce(base, path, body) {
    const token = await getApiKey();
    if (!token) throw new Error('NO_API_KEY');
    const res = await fetch('https://' + base + path, {
      method: 'POST',
      headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 || String(json.code) === '401') throw new Error('API_KEY_INVALID');
    return json;
  }

  async function mtFetch(path, body) {
    const cur = (await getApiBase()) || 'api.m-team.cc';
    try {
      return await _mtFetchOnce(cur, path, body);
    } catch (e) {
      if (e && e.message === 'API_KEY_INVALID') throw e;
      const other = API_OPTS.find((b) => b !== cur) || 'api.m-team.io';
      const r = await _mtFetchOnce(other, path, body);
      await setApiBase(other);
      return r;
    }
  }

  async function verifyApiKey(key) {
    let netFail = 0;
    for (const base of API_OPTS) {
      try {
        const res = await fetch('https://' + base + '/api/member/profile', {
          method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: '{}',
        });
        const json = await res.json().catch(() => ({}));
        if (String(json.code) === '0') return { ok: true, apiBase: base };
      } catch (e) { netFail++; }
    }
    return { ok: false, reason: netFail >= API_OPTS.length ? 'network' : 'invalid' };
  }

  return { mtFetch, verifyApiKey };
}

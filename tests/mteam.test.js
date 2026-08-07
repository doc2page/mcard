import test from 'node:test';
import assert from 'node:assert/strict';
import { createMteam } from '../src/lib/mteam.js';

function mockFetch(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

test('mtFetch 401 抛 API_KEY_INVALID', async () => {
  const restore = mockFetch(async () => ({ status: 401, json: async () => ({ code: '401' }) }));
  const mt = createMteam({
    getApiKey: async () => 'k', getApiBase: async () => 'api.m-team.cc', setApiBase: async () => {},
  });
  await assert.rejects(() => mt.mtFetch('/x', {}), { message: 'API_KEY_INVALID' });
  restore();
});

test('mtFetch code 0 正常返回', async () => {
  const restore = mockFetch(async () => ({ status: 200, json: async () => ({ code: '0', data: 1 }) }));
  const mt = createMteam({ getApiKey: async () => 'k', getApiBase: async () => 'api.m-team.cc', setApiBase: async () => {} });
  const r = await mt.mtFetch('/x', {});
  assert.equal(r.data, 1);
  restore();
});

test('mtFetch 网络 fail 自动切另一 base 并落盘', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    if (calls === 1) throw new Error('network down');
    return { status: 200, json: async () => ({ code: '0' }) };
  });
  let savedBase = null;
  const mt = createMteam({ getApiKey: async () => 'k', getApiBase: async () => 'api.m-team.cc', setApiBase: async (b) => { savedBase = b; } });
  const r = await mt.mtFetch('/x', {});
  assert.equal(r.code, '0');
  assert.equal(savedBase, 'api.m-team.io');
  restore();
});

test('mtFetch 401 不回退（两站同令牌）', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls++; return { status: 401, json: async () => ({ code: '401' }) }; });
  const mt = createMteam({ getApiKey: async () => 'k', getApiBase: async () => 'api.m-team.cc', setApiBase: async () => {} });
  await assert.rejects(() => mt.mtFetch('/x', {}));
  assert.equal(calls, 1);
  restore();
});

test('getApiKey 未配置抛 NO_API_KEY', async () => {
  const restore = mockFetch(async () => ({ status: 200, json: async () => ({ code: '0' }) }));
  const mt = createMteam({ getApiKey: async () => '', getApiBase: async () => 'api.m-team.cc', setApiBase: async () => {} });
  await assert.rejects(() => mt.mtFetch('/x', {}), { message: 'NO_API_KEY' });
  restore();
});

test('verifyApiKey code 0 返回 ok + base', async () => {
  const restore = mockFetch(async (url) => ({
    status: 200,
    json: async () => ({ code: url.includes('.cc') ? '0' : '401' }),
  }));
  const mt = createMteam({ getApiKey: async () => '', getApiBase: async () => '', setApiBase: async () => {} });
  const v = await mt.verifyApiKey('goodkey');
  assert.equal(v.ok, true);
  assert.equal(v.apiBase, 'api.m-team.cc');
  restore();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createState } from '../src/state.js';
import { createApiRouter } from '../src/routes/api.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function req(server, method, path, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : {} }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function setup(verify, collector) {
  const state = createState({ store: fakeStore() });
  const app = express(); app.use(express.json());
  app.use(createApiRouter({ state, collector: collector || {}, trader: {}, mteam: { verifyApiKey: verify } }));
  return { state, server: app.listen(0) };
}

test('GET /api/state 返回完整状态且不泄露 apiKey', async () => {
  const { server } = setup(async () => ({ ok: true }));
  try {
    const r = await req(server, 'GET', '/api/state');
    assert.equal(r.status, 200);
    assert.ok(r.json.config);
    assert.equal(r.json.config.apiKey, '');
  } finally { server.close(); }
});

test('POST /api/config 验证并落库 apiKey', async () => {
  const { state, server } = setup(async () => ({ ok: true, apiBase: 'api.m-team.cc' }));
  try {
    const r = await req(server, 'POST', '/api/config', { apiKey: 'goodkey', webBase: 'kp.m-team.cc' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(state.getState().config.apiKey, 'goodkey');
    assert.equal(state.getState().config.apiBase, 'api.m-team.cc');
  } finally { server.close(); }
});

test('POST /api/config 无效 key 返回 invalid 且不落库', async () => {
  const { state, server } = setup(async () => ({ ok: false, reason: 'invalid' }));
  try {
    const r = await req(server, 'POST', '/api/config', { apiKey: 'bad' });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, 'invalid');
    assert.equal(state.getState().config.apiKey, '');
  } finally { server.close(); }
});

test('POST /api/collect 路由到 collector', async () => {
  let called = null;
  const collector = { triggerRefreshRound: async () => { called = 'market'; return { ok: true }; }, ensureMyTrades: async () => ({}), ensureMyOrders: async () => ({}), ensureInventoryData: async () => ({}), ensureDropStats: async () => ({}), ensureMarketData: async () => ({}) };
  const { server } = setup(async () => ({ ok: true }), collector);
  try {
    await req(server, 'POST', '/api/collect', { type: 'market' });
    assert.equal(called, 'market');
  } finally { server.close(); }
});

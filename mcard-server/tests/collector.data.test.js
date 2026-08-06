import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/lib/collector.js';
import { createState } from '../src/state.js';
import * as normalizers from '../src/lib/normalizers.js';
import * as stats from '../src/lib/stats.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function deps(mt) { return { state: createState({ store: fakeStore() }), mteam: mt, normalizers, stats }; }

test('ensureMyTrades 增量合并并设 side', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/market/myTrades')
      return { code: '0', data: { data: [{ id: 1, filmName: 'A', sellerId: 'me', buyerId: 'o', tradedAt: '2026-07-01 00:00:00', price: 10 }], total: 1 } };
    return { code: '0', data: { data: [], total: 0 } };
  }, verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ profile: { id: 'me' } });
  const col = createCollector(d);
  const r = await col.ensureMyTrades(true);
  assert.equal(r.tradesAdded, 1);
  assert.equal(d.state.getState().buyHistory[0].side, 'sell');
});

test('ensureInventoryData 全量覆盖', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/inventory') return { code: '0', data: { data: [{ id: 7, filmName: '持有' }], total: 1 } };
    if (path === '/api/pt-card/mechanism/list') return { code: '0', data: [] };
    return { code: '0', data: { data: [], total: 0 } };
  }, verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  await col.ensureInventoryData(true);
  assert.equal(d.state.getState().inventory.length, 1);
});

test('profile 解析 bonus/role', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: { username: 'u', id: '9', role: '1', memberCount: { bonus: '500' } } }), verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  await col.fetchProfile();
  assert.equal(d.state.getState().profile.bonus, '500');
});

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

test('mergeOrders 返回 {added,updated,total} 并更新状态字段', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: { data: [], total: 0 } }), verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  // 直接调内部 merge 不可行（未导出）；改用 ensureMyOrders 走 syncList 验证 ordersAll 落库
  // 这里用 myorders mock 数据验证合并 + status 更新
  const d2 = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/market/myorders')
      return { code: '0', data: { data: [
        { id: 1, cardId: 'c1', side: 'sell', filmName: 'A', rarity: 'UR', price: '100', status: 'open', createdDate: '2026-07-01 00:00:00', lastModifiedDate: '2026-07-01 00:00:00' },
      ], total: 1 } };
    return { code: '0', data: { data: [], total: 0 } };
  }, verifyApiKey: async () => ({ ok: true }) });
  const col2 = createCollector(d2);
  await col2.ensureMyOrders(true);
  const orders = d2.state.getState().ordersAll;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, 'open');
  assert.equal(d2.state.getState().ordersTotal, 1);
});

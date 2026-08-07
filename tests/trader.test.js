import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrader } from '../src/lib/trader.js';
import { createState } from '../src/state.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function fakeCollector() {
  return { triggerRefreshRound: async () => ({ ok: true }), ensureInventoryData: async () => ({}), ensureMyOrders: async () => ({}) };
}
function deps(mt) { return { state: createState({ store: fakeStore() }), mteam: mt, collector: fakeCollector() }; }

test('buyCard 无预算拒绝', async () => {
  const tr = createTrader(deps({ mtFetch: async () => ({ code: '0', data: {} }), verifyApiKey: async () => ({ ok: true }) }));
  const r = await tr.buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'budget_not_set');
});

test('buyCard 预算不足拒绝', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: {} }), verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 100, spent: 0 } }, profile: { bonus: '30' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 50 });
  assert.equal(r.reason, 'budget_insufficient');
});

test('buyCard 成交扣预算池', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: { status: 'filled', trade: { price: 80 } } }), verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 1000, spent: 0 } }, profile: { bonus: '500' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 80 });
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
  assert.equal(d.state.getState().config.budget.spent, 80);
});

test('buyCard 未成交 open → cancel', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/market/buy') return { code: '0', data: { status: 'open', orderId: 99 } };
    if (path === '/api/pt-card/market/cancel') return { code: '0' };
    return { code: '0' };
  }, verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 1000, spent: 0 } }, profile: { bonus: '500' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 80 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unfilled');
  assert.equal(r.cancelFailed, false);
});

test('sellCard 普通卡传 cardId', async () => {
  let sentBody = null;
  const d = deps({ mtFetch: async (path, body) => { if (path === '/api/pt-card/market/sell') sentBody = body; return { code: '0', data: {} }; }, verifyApiKey: async () => ({ ok: true }) });
  const r = await createTrader(d).sellCard({ cardId: '7', netPrice: 100 });
  assert.equal(r.ok, true);
  assert.equal(sentBody.cardId, 7);
});

test('cancelOrder 成功', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0' }), verifyApiKey: async () => ({ ok: true }) });
  const r = await createTrader(d).cancelOrder({ orderId: 5 });
  assert.equal(r.ok, true);
});

test('buyCard 超阈值拒绝 over_threshold', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: {} }), verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 1000, spent: 0 } }, profile: { bonus: '500' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 80, maxPrice: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'over_threshold');
  assert.equal(r.limit, 50);
});

test('buyCard 无效价格拒绝（NaN）', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: {} }), verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 1000, spent: 0 } }, profile: { bonus: '500' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: NaN });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'buy_failed');
});

test('buyCard open 且 cancel 失败 → cancelFailed:true 并留痕', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/market/buy') return { code: '0', data: { status: 'open', orderId: 99 } };
    if (path === '/api/pt-card/market/cancel') return { code: '1' }; // cancel 失败
    return { code: '0' };
  }, verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 1000, spent: 0 } }, profile: { bonus: '500' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 80 });
  assert.equal(r.reason, 'unfilled');
  assert.equal(r.cancelFailed, true);
  assert.equal(d.state.getState().cancelFailedOrders.length, 1);
});

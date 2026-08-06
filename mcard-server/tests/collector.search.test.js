import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/lib/collector.js';
import { createState } from '../src/state.js';
import * as normalizers from '../src/lib/normalizers.js';
import * as stats from '../src/lib/stats.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function deps(mt) { return { state: createState({ store: fakeStore() }), mteam: mt, normalizers, stats }; }

test('searchMarket 多 tag 合并去重', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/market/search')
      return { code: '0', data: { data: [{ cardId: '1', filmName: 'A', rarity: 'UR' }, { cardId: '2', filmName: 'B', rarity: 'SR' }] } };
    return { code: '0', data: { data: [] } };
  }, verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  const r = await col.searchMarket(['浪浪山', '深海']);
  assert.equal(r.items.length, 2);
});

test('queryOrderbook 取最高买价', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: { asks: [{ price: 100 }], bids: [{ price: 80 }, { price: 60 }] } }), verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  const r = await col.queryOrderbook('film1', 'normal', 'UR');
  assert.equal(r.ok, true);
  assert.equal(r.bid, 80);
});

test('setConfig 嵌套合并不丢字段', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0' }), verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  await col.setConfig({ budget: { total: 500 } });
  const cfg = d.state.getState().config;
  assert.equal(cfg.budget.total, 500);
  assert.ok(Array.isArray(cfg.rarities));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/lib/collector.js';
import { createState } from '../src/state.js';
import * as normalizers from '../src/lib/normalizers.js';
import * as stats from '../src/lib/stats.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function deps(mt) { return { state: createState({ store: fakeStore() }), mteam: mt, normalizers, stats }; }

test('ensureDropStats 走 feed 增量并算 summary', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/feed')
      return { code: '0', data: { data: [{ id: 'c1', createdDate: '2026-07-05 00:00:00', rarity: 'UR', title: 'SPARK' }], total: 1 } };
    return { code: '0', data: { data: [], total: 0 } };
  }, verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  const r = await col.ensureDropStats();
  assert.equal(r.dropsAdded, 1);
  const ds = d.state.getState().dropStats;
  assert.equal(ds.feedCards.length, 1);
  assert.ok(ds.summary);
  assert.ok(ds.lastFeedAt > 0);
});

test('feed 游标：只收 lastMsgDate 之后', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/feed')
      return { code: '0', data: { data: [
        { id: 'old', createdDate: '2026-07-05 00:00:00', rarity: 'N' },
        { id: 'new', createdDate: '2026-07-15 00:00:00', rarity: 'UR', title: 'SPARK' },
      ], total: 2 } };
    return { code: '0', data: { data: [], total: 0 } };
  }, verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ dropStats: { since: '2026-07-01 00:00:00', lastMsgDate: '2026-07-10 00:00:00', messages: [], feedCards: [], lastFeedAt: 0, summary: null } });
  const col = createCollector(d);
  await col.ensureDropStats();
  assert.equal(d.state.getState().dropStats.feedCards.length, 1);
});

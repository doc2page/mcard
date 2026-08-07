import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/lib/collector.js';
import { createState } from '../src/state.js';
import * as normalizers from '../src/lib/normalizers.js';
import * as stats from '../src/lib/stats.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function fakeMteam(listData) {
  return {
    mtFetch: async (path) => {
      if (path === '/api/pt-card/market/list') return { code: '0', data: { data: listData || [] } };
      if (path === '/api/member/profile') return { code: '0', data: { username: 'u', memberCount: {} } };
      if (path === '/api/tracker/mybonus') return { code: '0', data: { formulaParams: { finalBs: 0 } } };
      return { code: '0', data: {} };
    },
    verifyApiKey: async () => ({ ok: true, apiBase: 'api.m-team.cc' }),
  };
}
const deps = (mt) => ({ state: createState({ store: fakeStore() }), mteam: mt, normalizers, stats });

test('startRound 采集各稀有度并入桶', async () => {
  const d = deps(fakeMteam([{ filmName: '卡', lowestAsk: 10, variant: {} }]));
  const col = createCollector(d);
  await col.startRound(await d.state.getState(), 'refresh', ['UR', 'SSR'], 10);
  const s = d.state.getState();
  assert.ok(s.buckets.UR);
  assert.equal(s.buckets.UR.count, 1);
  assert.equal(s.isRoundRunning, false);
});

test('triggerRefreshRound manual 节流 8s', async () => {
  const d = deps(fakeMteam([]));
  const col = createCollector(d);
  await col.triggerRefreshRound('manual');
  const r = await col.triggerRefreshRound('manual');
  assert.equal(r.throttled, true);
});

test('startRound 循环中途抛错仍解锁 isRoundRunning（finally 兜底）', async () => {
  // 复现根因：循环内、内层 try 外的代码（state.update/randSleep）抛错时，旧版 onRoundDone 永不执行 → 锁卡死
  const d = deps(fakeMteam([{ filmName: '卡', lowestAsk: 10, variant: {} }]));
  const col = createCollector(d);
  const realUpdate = d.state.update.bind(d.state);
  let n = 0;
  d.state.update = async (patch) => {
    n += 1;
    if (n === 3) throw new Error('boom');  // 第 3 次 update = 循环首轮 currentRarity 更新（内层 try 外）
    return realUpdate(patch);
  };
  await assert.rejects(col.startRound(await d.state.getState(), 'refresh', ['UR', 'SSR'], 10), /boom/);
  assert.equal(d.state.getState().isRoundRunning, false, '抛错后 isRoundRunning 必须被 finally 复位');
});

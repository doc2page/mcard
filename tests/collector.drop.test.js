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

const _dropMt = { mtFetch: async () => ({ code: '0', data: {} }), verifyApiKey: async () => ({ ok: true }) };

test('importDropMessages 解析粘贴 JSON 合并进 messages 并重算 summary', async () => {
  const d = deps(_dropMt);
  const col = createCollector(d);
  const json = JSON.stringify({ code: '0', data: { data: [
    { id: 'm1', createdDate: '2026-07-01 10:00:00', context: '你獲得了 1 張新卡片！\n1. R《WALL·E》『TORCHBEARER』' },
    { id: 'm2', createdDate: '2026-07-02 11:00:00', context: '你獲得了 1 張新卡片！\n1. SSR《Foo》『SPARK』' },
  ] } });
  const r = await col.importDropMessages(json);
  assert.equal(r.ok, true);
  assert.equal(r.imported, 2);
  const ds = d.state.getState().dropStats;
  assert.equal(ds.messages.length, 2);
  assert.equal(ds.lastMsgDate, '2026-07-02 11:00:00');   // feed 游标 = messages 最新
  assert.equal(ds.since, '2026-07-01 10:00:00');          // since 回退到最早
  assert.ok(ds.summary && ds.summary.totalCards >= 2);
});

test('importDropMessages 按 id 去重 + 跳过非掉卡 message', async () => {
  const d = deps(_dropMt);
  const col = createCollector(d);
  const json = JSON.stringify({ data: { data: [
    { id: 'm1', createdDate: '2026-07-01 10:00:00', context: '1. R《A》『SPARK』' },
    { id: 'm1', createdDate: '2026-07-01 10:00:00', context: '1. R《A》『SPARK』' },  // 重复 id
    { id: 'm2', createdDate: '2026-07-02 10:00:00', context: '系統通知：本週排名更新' }, // 非掉卡
  ] } });
  const r = await col.importDropMessages(json);
  assert.equal(r.imported, 1);
  assert.equal(r.skipped, 2);
  assert.equal(d.state.getState().dropStats.messages.length, 1);
});

test('importDropMessages 重复粘贴幂等（只导入一次）', async () => {
  const d = deps(_dropMt);
  const col = createCollector(d);
  const json = JSON.stringify({ data: { data: [
    { id: 'm1', createdDate: '2026-07-01 10:00:00', context: '1. R《A》『SPARK』' },
  ] } });
  await col.importDropMessages(json);
  const r2 = await col.importDropMessages(json);
  assert.equal(r2.imported, 0);
  assert.equal(d.state.getState().dropStats.messages.length, 1);
});

test('importDropMessages 容忍裸数组 / 无效 JSON / 空内容', async () => {
  const col = createCollector(deps(_dropMt));
  // 裸数组
  const r1 = await col.importDropMessages(JSON.stringify([{ id: 'x1', createdDate: '2026-07-01 10:00:00', context: '1. N《B》『EMBER』' }]));
  assert.equal(r1.imported, 1);
  // 无效 JSON / 空 / 无消息
  const col2 = createCollector(deps(_dropMt));
  assert.equal((await col2.importDropMessages('not json{')).reason, 'invalid_json');
  assert.equal((await col2.importDropMessages('   ')).reason, 'empty');
  assert.equal((await col2.importDropMessages(JSON.stringify({ foo: 1 }))).reason, 'no_messages');
});

test('since 取 messages+feedCards 最早（feed 刷新不覆盖导入的更早起点）', async () => {
  // 复现根因：导入 messages(7-01) 后再跑 feed(7-26)，since 不应被 feed 覆盖回 7-26
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/feed') return { code: '0', data: { data: [{ id: 'f1', createdDate: '2026-07-26 00:00:00', rarity: 'N' }], total: 1 } };
    return { code: '0', data: {} };
  }, verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ dropStats: { since: '2026-07-01 00:00:00', lastMsgDate: '2026-07-20 00:00:00',
    messages: [{ id: 'm1', createdDate: '2026-07-01 00:00:00', context: '1. N《A》『SPARK』' }], feedCards: [], lastFeedAt: 0, summary: null } });
  const col = createCollector(d);
  await col.ensureDropStats();   // feed 增量
  const ds = d.state.getState().dropStats;
  assert.equal(ds.since, '2026-07-01 00:00:00', 'since 应取 messages 7-01（最早），不被 feed 7-26 覆盖');
  assert.equal(ds.summary.rangeStart, '2026-07-01', '图表起点对齐 7-01');
});

test('导入 messages 剔除 feedCards 重叠（避免双源重复计算）', async () => {
  // 复现根因：feedCards 已有近期增量，导入的全量 messages 与之时间重叠 → 应剔除重叠，summary 不双算
  const d = deps(_dropMt);
  await d.state.update({ dropStats: { since: '2026-07-26 00:00:00', lastMsgDate: '', messages: [],
    feedCards: [
      { cardId: 'f1', createdDate: '2026-08-01 00:00:00', rarity: 'N', title: 'SPARK' },
      { cardId: 'f2', createdDate: '2026-08-07 00:00:00', rarity: 'R', title: 'TORCHBEARER' },
    ], lastFeedAt: 0, summary: null } });
  const col = createCollector(d);
  const json = JSON.stringify({ data: { data: [
    { id: 'm1', createdDate: '2026-07-01 00:00:00', context: '1. N《A》『SPARK』' },
    { id: 'm2', createdDate: '2026-08-01 00:00:00', context: '1. N《B》『SPARK』' },
    { id: 'm3', createdDate: '2026-08-07 00:00:00', context: '1. R《C》『TORCHBEARER』' },
  ] } });
  const r = await col.importDropMessages(json);
  assert.equal(r.imported, 3);
  const ds = d.state.getState().dropStats;
  assert.equal(ds.feedCards.length, 0, 'feedCards 与 messages 时间重叠，应被剔除');
  assert.equal(ds.summary.totalCards, 3, '只算 messages，不双算 feedCards');
});

test('importDropMessages 返回分页信息（提示翻页）', async () => {
  const col = createCollector(deps(_dropMt));
  const json = JSON.stringify({ data: { pageNumber: '1', pageSize: '100', total: '31', totalPages: '2', data: [
    { id: 'm1', createdDate: '2026-07-01 00:00:00', context: '1. N《A》『SPARK』' },
  ] } });
  const r = await col.importDropMessages(json);
  assert.equal(r.ok, true);
  assert.deepEqual(r.page, { totalPages: 2, total: 31, pageNumber: 1, pageSize: 100 });
});

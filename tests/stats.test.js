import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDropContext, computeDropSummary, computeCardLogSummary } from '../src/lib/stats.js';

test('parseDropContext 多张列表', () => {
  const ctx = "1. UR《浪浪山》『SPARK』\n2. SSR《深海》『EMBER』";
  assert.deepEqual(parseDropContext(ctx), [
    { rarity: 'UR', filmName: '浪浪山', title: 'SPARK' },
    { rarity: 'SSR', filmName: '深海', title: 'EMBER' },
  ]);
});
test('computeDropSummary 聚合稀有度与张数', () => {
  const msgs = [{ createdDate: '2026-07-02 10:00:00', context: "1. UR《片》『SPARK』" }];
  const s = computeDropSummary(msgs, [], '2026-07-01 00:00:00', '2026-07-03');
  assert.equal(s.totalCards, 1);
  assert.equal(s.rarityCount.UR, 1);
  assert.equal(s.dropDays, 1);
});
test('computeCardLogSummary 仅统计 paid=true', () => {
  const logs = [{ paid: true, bonus: '10000' }, { paid: false, bonus: '9999' }, { paid: true, bonus: '30000' }];
  const s = computeCardLogSummary(logs);
  assert.equal(s.count, 2);
  assert.equal(s.max, 30000);
});

test('computeDropSummary dailyFull 含当天（since 带时分不裁当天）', () => {
  // since 带时分（最早掉卡 02:45:56），today=8-08 且当天有掉落 → dailyFull 必须含 8-08
  const msgs = [{ createdDate: '2026-08-08 02:37:00', context: '1. N《A》『SPARK』' }];
  const s = computeDropSummary(msgs, [], '2026-07-01 02:45:56', '2026-08-08');
  const last = s.dailyFull[s.dailyFull.length - 1];
  assert.equal(last.date, '2026-08-08', '最后一天应是当天');
  assert.equal(last.count, 1);
  assert.equal(s.totalDays, 39, '7-01~8-08 共 39 天');
});

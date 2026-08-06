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

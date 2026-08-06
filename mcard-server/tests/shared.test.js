import test from 'node:test';
import assert from 'node:assert/strict';
import { isMechCard, parseMtTime, computeUsable, deepMerge, shuffle, buildDetailUrl } from '../src/lib/shared.js';

test('isMechCard 识别 provenance/filmId', () => {
  assert.equal(isMechCard({ variant: { provenance: 'mech' } }), true);
  assert.equal(isMechCard({ variant: { filmId: 'mech:mana_voucher' } }), true);
  assert.equal(isMechCard({ variant: { filmId: '123', provenance: 'normal' } }), false);
});
test('parseMtTime 解析本地时间', () => {
  const ms = parseMtTime('2026-07-24 19:55:36');
  assert.equal(typeof ms, 'number');
  assert.ok(!Number.isNaN(ms));
  assert.ok(Number.isNaN(parseMtTime('')));
});
test('computeUsable = min(预算剩余, 余额)', () => {
  const u = computeUsable({ config: { budget: { total: 500, spent: 100 } }, profile: { bonus: '300' } });
  assert.equal(u.usable, 300);
});
test('deepMerge 嵌套合并，数组覆盖', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 9 } }), { a: { b: 9, c: 2 }, d: 3 });
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
});
test('shuffle 保持元素集合不变', () => {
  const s = shuffle([1, 2, 3, 4, 5]);
  assert.deepEqual(s.slice().sort(), [1, 2, 3, 4, 5]);
});
test('buildDetailUrl 含 filmId/rarity/provenance', () => {
  const u = buildDetailUrl({ variant: { filmId: 'f1', rarity: 'UR', provenance: 'normal' } }, 'kp.m-team.cc');
  assert.ok(u.includes('filmId=f1') && u.includes('rarity=UR'));
});

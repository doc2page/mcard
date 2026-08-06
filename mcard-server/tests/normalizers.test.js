import test from 'node:test';
import assert from 'node:assert/strict';
import { slim, normalizeInventory, normalizeMechanism, mapSearchItem } from '../src/lib/normalizers.js';

test('slim 只保留展示字段', () => {
  const s = slim({ variant: { filmId: 'f' }, filmName: '片', lowestAsk: 100, spark7d: 'x' });
  assert.equal(s.filmName, '片');
  assert.equal(s.lowestAsk, 100);
  assert.equal(s.spark7d, undefined);
});
test('normalizeInventory 映射 cardId/数值转字符串', () => {
  const n = normalizeInventory({ id: 5, filmName: '片', torrentId: 7 });
  assert.equal(n.cardId, '5');
  assert.equal(n.torrentId, '7');
});
test('normalizeMechanism 标记 isMech/isUsed', () => {
  const n = normalizeMechanism({ id: 1, type: 'mana_voucher', usedAt: '2026-07-01' });
  assert.equal(n.isMech, true);
  assert.equal(n.isUsed, true);
  assert.equal(n.filmId, 'mech:mana_voucher');
});
test('mapSearchItem 用 price 作 lowestAsk', () => {
  const m = mapSearchItem({ filmId: 'f', rarity: 'UR', price: 50 });
  assert.equal(m.lowestAsk, 50);
  assert.equal(m.variant.rarity, 'UR');
});

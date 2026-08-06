import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../public/dispatch.js';

test('GET_STATE → GET /api/state', () => {
  assert.deepEqual(dispatch({ type: 'GET_STATE' }), { method: 'GET', path: '/api/state' });
});
test('GET_ORDERBOOK → GET /api/orderbook?...', () => {
  const d = dispatch({ type: 'GET_ORDERBOOK', filmId: 'f', provenance: 'normal', rarity: 'UR' });
  assert.equal(d.method, 'GET');
  assert.ok(d.path.startsWith('/api/orderbook?'));
  assert.ok(d.path.includes('filmId=f') && d.path.includes('rarity=UR'));
});
test('REFRESH_NOW/LOAD_* → POST /api/collect', () => {
  assert.deepEqual(dispatch({ type: 'REFRESH_NOW' }), { method: 'POST', path: '/api/collect', body: { type: 'market' } });
  assert.deepEqual(dispatch({ type: 'LOAD_TRADES' }), { method: 'POST', path: '/api/collect', body: { type: 'trades' } });
  assert.deepEqual(dispatch({ type: 'LOAD_DROP_STATS' }), { method: 'POST', path: '/api/collect', body: { type: 'drops' } });
  assert.deepEqual(dispatch({ type: 'LOAD_MARKET_DATA' }), { method: 'POST', path: '/api/collect', body: { type: 'marketStats' } });
});
test('SEARCH_MARKET → POST /api/search', () => {
  assert.deepEqual(dispatch({ type: 'SEARCH_MARKET', tags: ['a'], pageSize: 50 }),
    { method: 'POST', path: '/api/search', body: { tags: ['a'], pageSize: 50 } });
});
test('BUY/SELL/CANCEL → POST /api/trade', () => {
  assert.deepEqual(dispatch({ type: 'BUY_CARD', variant: { filmId: 'f' }, expectPrice: 80, maxPrice: 100 }),
    { method: 'POST', path: '/api/trade', body: { action: 'buy', variant: { filmId: 'f' }, expectPrice: 80, maxPrice: 100, skipRefresh: undefined } });
  assert.deepEqual(dispatch({ type: 'SELL_CARD', cardId: '7', isMech: false, netPrice: 100 }),
    { method: 'POST', path: '/api/trade', body: { action: 'sell', cardId: '7', isMech: false, netPrice: 100, skipRefresh: undefined } });
  assert.deepEqual(dispatch({ type: 'CANCEL_ORDER', orderId: 5 }),
    { method: 'POST', path: '/api/trade', body: { action: 'cancel', orderId: 5, skipRefresh: undefined } });
});
test('SET_CONFIG → POST /api/setconfig (body 为 partial config)', () => {
  assert.deepEqual(dispatch({ type: 'SET_CONFIG', config: { viewMode: 'group' } }),
    { method: 'POST', path: '/api/setconfig', body: { viewMode: 'group' } });
});
test('SAVE_API_KEY → POST /api/config', () => {
  assert.deepEqual(dispatch({ type: 'SAVE_API_KEY', key: 'k', webBase: 'kp.m-team.cc' }),
    { method: 'POST', path: '/api/config', body: { apiKey: 'k', webBase: 'kp.m-team.cc' } });
});
test('SET_WEB_BASE → POST /api/setconfig {webBase}', () => {
  assert.deepEqual(dispatch({ type: 'SET_WEB_BASE', webBase: 'zp.m-team.io' }),
    { method: 'POST', path: '/api/setconfig', body: { webBase: 'zp.m-team.io' } });
});
test('未知 type → null', () => {
  assert.equal(dispatch({ type: 'NOPE' }), null);
});

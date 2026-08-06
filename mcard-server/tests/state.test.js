import test from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/state.js';

function fakeStore() {
  let saved = null;
  return {
    loadState: () => saved,
    saveState: (s) => { saved = s; },
  };
}

test('getState 返回深拷贝，修改不影响内部', () => {
  const st = createState({ store: fakeStore() });
  const s1 = st.getState();
  s1.profile = { mutated: true };
  assert.equal(st.getState().profile, null);
});

test('update 顶层浅合并', async () => {
  const st = createState({ store: fakeStore() });
  await st.update({ buckets: { UR: { items: [] } } });
  assert.ok(st.getState().buckets.UR);
  assert.equal(st.getState().stats.total, 0);
});

test('update config 走 deepMerge（不丢其它 config 字段）', async () => {
  const st = createState({ store: fakeStore() });
  await st.update({ config: { apiKey: 'k' } });
  await st.update({ config: { apiBase: 'api.m-team.cc' } });
  const cfg = st.getState().config;
  assert.equal(cfg.apiKey, 'k');
  assert.equal(cfg.apiBase, 'api.m-team.cc');
  assert.ok(Array.isArray(cfg.rarities));
});

test('update 广播 patch 给订阅者', async () => {
  const st = createState({ store: fakeStore() });
  let received = null;
  st.subscribe((evt) => { received = evt; });
  await st.update({ profile: { id: 9 } });
  assert.deepEqual(received.patch.profile, { id: 9 });
});

test('启动从 store 加载已存 state', () => {
  const store = fakeStore();
  store.saveState({ profile: { id: 5 }, config: {} });
  const st = createState({ store });
  assert.equal(st.getState().profile.id, 5);
});

test('启动无存档时用 DEFAULT_STATE 初始化', () => {
  const st = createState({ store: fakeStore() });
  assert.ok(Array.isArray(st.getState().config.rarities));
  assert.equal(st.getState().isRoundRunning, false);
});

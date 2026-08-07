import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcard-'));
  return { dir, path: path.join(dir, 't.db') };
}

test('saveState/loadState 往返', () => {
  const { path: p } = tmpDb();
  const store = openStore(p);
  store.saveState({ config: { apiKey: 'k', apiBase: 'api.m-team.cc' }, profile: { id: 1 } });
  const loaded = store.loadState();
  assert.equal(loaded.config.apiKey, 'k');
  assert.equal(loaded.profile.id, 1);
  store.close();
});

test('loadState 空库返回 null', () => {
  const { path: p } = tmpDb();
  const store = openStore(p);
  assert.equal(store.loadState(), null);
  store.close();
});

test('不同实例读同一文件得到已存数据', () => {
  const { path: p } = tmpDb();
  const s1 = openStore(p);
  s1.saveState({ x: 1 });
  s1.close();
  const s2 = openStore(p);
  assert.equal(s2.loadState().x, 1);
  s2.close();
});

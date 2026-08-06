# MCard 容器化 Plan 1：后端核心 + API + SSE 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `mcard-main/background.js` 的采集/交易/统计逻辑迁移为一个 Node.js + Express + SQLite 后端，通过 HTTP API + SSE 暴露全部功能，可用 curl 独立验证。

**Architecture:** 单 Node 进程常驻。`state.js` 持内存态（对齐 background 的 `DEFAULT_STATE`）+ 订阅广播；`store.js` 用 SQLite 持久化（重启恢复）；`mteam.js` 封装 `mtFetch`（双 base 切换 + 401）；`collector.js`/`trader.js` 是从 background.js 迁移的业务逻辑，仅把 `getAll/set` 换成 `state.getState/update`、`getApiKey/_readApiBase/_writeApiBase` 换成注入的配置读写。Express 提供 REST + SSE。

**Tech Stack:** Node.js 20+（全局 fetch）、Express 4、better-sqlite3、`node:test`（零依赖测试）。

---

## 迁移约定（重要）

本计划是「从现有扩展迁移」，不是从零写。为避免把上千行已存在源码抄进文档：

- **「原样搬迁」型步骤**：标注来源 `background.js:行号`，列出精确改造点，给出**完整测试代码**。工程师照改造点把源码搬入目标文件即可，源码原文不重复贴。
- **「新写」型步骤**：给出完整实现代码。
- 所有业务逻辑来自 `mcard-main/background.js` 与 `mcard-main/dropStats.js`，可随时查阅原文。

### 三条全局改造规则（适用于所有搬迁步骤）

把 background.js 的函数搬进 Node 模块时，统一做这三处替换：

1. `await getAll()` → `await state.getState()`（读内存态深拷贝）
2. `await set({ ...patch })` → `await state.update({ ...patch })`（合并 + 落盘 + 广播）
3. 删除一切 `chrome.*` 调用（生命周期、图标、tabs、onMessage 分发——后者改由 Express 路由触发）

## 文件结构（Plan 1 产出）

```
mcard-server/
├── package.json                      # Task 1
├── src/
│   ├── server.js                     # Task 15：Express 入口，托管路由 + 启动加载 state
│   ├── store.js                      # Task 5：SQLite kv + state 持久化
│   ├── state.js                      # Task 6：内存 state + update + subscribe
│   ├── lib/
│   │   ├── shared.js                 # Task 2：后端纯函数子集（常量 + 工具，无 i18n/DOM）
│   │   ├── stats.js                  # Task 3：dropStats.js 原样搬迁（computeDropSummary 等）
│   │   ├── normalizers.js            # Task 4：slim/normalize*/mapSearchItem 等纯映射函数
│   │   ├── mteam.js                  # Task 7：mtFetch + 双 base + 401 + verifyApiKey
│   │   ├── collector.js              # Task 8-11：市场/数据/掉落/搜索采集
│   │   └── trader.js                 # Task 12：买卖撤
│   └── routes/
│       ├── api.js                    # Task 13：REST 端点
│       └── sse.js                    # Task 14：SSE 推送
├── tests/                            # 每个模块一个 test 文件
└── data/.gitkeep                     # SQLite 卷挂载点
```

每个文件单一职责，可独立测试。`collector`/`trader` 通过构造参数注入 `{ state, mteam, stats, normalizers }`，与存储/网络解耦。

---

## Task 1: 项目骨架 + Express 健康检查 + 测试框架

**Files:**
- Create: `mcard-server/package.json`
- Create: `mcard-server/src/server.js`（最小骨架，后续 Task 15 扩充）
- Create: `mcard-server/tests/health.test.js`
- Create: `mcard-server/data/.gitkeep`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "mcard-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test tests/"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "express": "^4.19.2"
  }
}
```

- [ ] **Step 2: 写最小 server.js（仅健康检查）**

```js
// src/server.js
import express from 'express';
import { fileURLToPath } from 'node:url';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log('[mcard] listening on ' + port));
}
```

- [ ] **Step 3: 写失败测试**

```js
// tests/health.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import http from 'node:http';

function getJson(server, path) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + path, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body || '{}') }));
    }).on('error', reject);
  });
}

test('GET /health returns ok', async () => {
  const server = createApp().listen(0);
  try {
    const r = await getJson(server, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  } finally { server.close(); }
});
```

- [ ] **Step 4: 安装依赖并跑测试**

Run: `cd mcard-server && npm install && npm test`
Expected: 1 test PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: 项目骨架 + Express 健康检查"
```

---

## Task 2: 后端纯函数子集 `shared.js`

**Files:**
- Create: `mcard-server/src/lib/shared.js`
- Test: `mcard-server/tests/shared.test.js`

**搬迁来源**：`mcard-main/shared.js:15-76`（RARITIES/RARITY_LABEL/MECH_TYPES/MECH_LABEL/isMechCard/mechTypeOf/parseMtTime/webUrl/API_OPTS/WEB_OPTS/buildDetailUrl/computeUsable）+ `mcard-main/background.js:94-104`（isPlainObj/deepMerge）+ `background.js:144-151`（shuffle）+ `dropStats.js:1-2`（DROP_SINCE_DEFAULT/DROP_RARITY_WEIGHT）。

**改造点**：① 顶层 `var`/`function` 改 ESM `export const`/`export function`；② 不迁 i18n（setI18nLang/t/applyI18n 等）与 DOM 函数（waitForCond）；③ `shuffle` 用 `Math.random`（应用代码允许）。

- [ ] **Step 1: 写 shared.js**

```js
// src/lib/shared.js
export const RARITIES = ['UR', 'SSR', 'SR', 'R', 'N'];
export const RARITY_LABEL = { UR: 'UR', SSR: 'SSR', SR: 'SR', R: 'R', N: 'N' };
export const MECH_TYPES = [
  { type: 'mana_voucher', label: '魔力符券' },
  { type: 'single_free', label: '置顶免费符' },
  { type: 'vip_7d', label: 'VIP七日符' },
];
export const MECH_LABEL = { mana_voucher: '魔力符券', single_free: '置顶免费符', vip_7d: 'VIP七日符' };
export const WEB_OPTS = ['kp.m-team.cc', 'zp.m-team.io'];
export const API_OPTS = ['api.m-team.cc', 'api.m-team.io'];
export const DROP_SINCE_DEFAULT = '2026-07-01 00:00:00';
export const DROP_RARITY_WEIGHT = { UR: 30, SSR: 10, SR: 5, R: 3, N: 1 };

export function isMechCard(x) {
  const v = (x && x.variant) || x || {};
  return v.provenance === 'mech' || (typeof v.filmId === 'string' && v.filmId.indexOf('mech:') === 0);
}
export function mechTypeOf(it) {
  if (it && it.type) return it.type;
  const v = (it && (it.variant || it)) || {};
  if (typeof v.filmId === 'string' && v.filmId.indexOf('mech:') === 0) return v.filmId.slice(5);
  return '';
}
export function parseMtTime(s) {
  if (!s) return NaN;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const d = new Date(s);
  return isNaN(d.getTime()) ? NaN : d.getTime();
}
export function webUrl(webBase, path) { return 'https://' + webBase + path; }
export function buildDetailUrl(x, webBase) {
  const v = (x && x.variant) || x || {};
  const q = new URLSearchParams({ filmId: v.filmId || '', rarity: v.rarity || '', provenance: v.provenance || '' });
  return webUrl(webBase || 'kp.m-team.cc', '/cards/market/detail?' + q.toString());
}
export function computeUsable(st) {
  const budget = (st && st.config && st.config.budget) || { total: 0, spent: 0 };
  const bTotal = Number(budget.total) || 0;
  const spent = Number(budget.spent) || 0;
  const remaining = bTotal - spent;
  const bonus = Number(st && st.profile && st.profile.bonus) || 0;
  return { bTotal, spent, remaining, bonus, usable: Math.min(remaining, bonus) };
}
export function isPlainObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
export function deepMerge(target, src) {
  if (!isPlainObj(target) || !isPlainObj(src)) return src;
  const out = Object.assign({}, target);
  for (const k of Object.keys(src)) {
    out[k] = (isPlainObj(target[k]) && isPlainObj(src[k])) ? deepMerge(target[k], src[k]) : src[k];
  }
  return out;
}
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
```

- [ ] **Step 2: 写测试**

```js
// tests/shared.test.js
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
```

- [ ] **Step 3: 跑测试**

Run: `cd mcard-server && npm test`
Expected: shared 的 6 个 + health 共 7 个 PASS。

- [ ] **Step 4: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: 后端纯函数子集 shared.js"
```

---

## Task 3: `stats.js`（dropStats.js 原样搬迁）

**Files:**
- Create: `mcard-server/src/lib/stats.js`
- Test: `mcard-server/tests/stats.test.js`

**搬迁来源**：`mcard-main/dropStats.js` 全文（`parseDropContext`/`computeDropSummary`/`computeCardLogSummary`）。该文件已是纯函数，常量与 Task 2 重复——此处保留本文件内部副本以保持自包含（与原文一致）。

**改造点**：① `var`/`function` 改 ESM `export`；② 删除文件末尾的 CommonJS `module.exports` 块。

- [ ] **Step 1: 搬迁 stats.js**

打开 `mcard-main/dropStats.js`，全文复制 `parseDropContext` / `_dropMt` / `_dropDateStr` / `_dropMaxStreak` / `computeDropSummary` / `computeCardLogSummary` 及常量 `DROP_SINCE_DEFAULT` / `DROP_RARITY_WEIGHT` / `DROP_TITLE_CN` 到 `src/lib/stats.js`。改 ESM：
- 三个常量加 `export const`
- 六个函数加 `export function`
- **删除** `if (typeof module !== 'undefined' ...)` CommonJS 导出块

- [ ] **Step 2: 写测试**

```js
// tests/stats.test.js
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
```

- [ ] **Step 3: 跑测试**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS（含 stats 3 个）。

- [ ] **Step 4: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: dropStats 纯逻辑搬迁 stats.js"
```

---

## Task 4: `normalizers.js`（卡牌字段映射纯函数）

**Files:**
- Create: `mcard-server/src/lib/normalizers.js`
- Test: `mcard-server/tests/normalizers.test.js`

**搬迁来源**：`background.js:868-886`（normalizeInventory）、`892-909`（normalizeMechanism）、`1348-1360`（slim）、`1365-1375`（mapSearchItem）。

**改造点**：`function` 改 `export function`；其余原样（这些函数无 `chrome.*`、无 `getAll/set`）。

- [ ] **Step 1: 搬迁并改 export**

把上述四个函数原样搬入 `src/lib/normalizers.js`，每个加 `export`。函数体不改一字。

- [ ] **Step 2: 写测试**

```js
// tests/normalizers.test.js
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
```

- [ ] **Step 3: 跑测试**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: 卡牌字段映射 normalizers.js"
```

---

## Task 5: `store.js`（SQLite 持久化）

**Files:**
- Create: `mcard-server/src/store.js`
- Test: `mcard-server/tests/store.test.js`

**职责**：`state` 表（id=1 存完整内存态 JSON，重启恢复）。api-key/apiBase/webBase 统一进 `state.config`，无需单独 kv 表。提供 `loadState()` / `saveState(state)`。

- [ ] **Step 1: 写失败测试**

```js
// tests/store.test.js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: store 3 个 FAIL（`openStore` 未定义）。

- [ ] **Step 3: 写实现**

```js
// src/store.js
import Database from 'better-sqlite3';

export function openStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');

  const select = db.prepare('SELECT data FROM state WHERE id = 1');
  const upsert = db.prepare(
    'INSERT INTO state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
  );

  return {
    loadState() {
      const row = select.get();
      return row ? JSON.parse(row.data) : null;
    },
    saveState(state) {
      upsert.run(JSON.stringify(state));
    },
    close() { db.close(); },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: SQLite 持久化 store.js"
```

---

## Task 6: `state.js`（内存 state + update + 广播）

**Files:**
- Create: `mcard-server/src/state.js`
- Test: `mcard-server/tests/state.test.js`

**职责**：内存中持有完整 state（用 `DEFAULT_STATE` 初始化）；`getState()` 返回深拷贝；`update(patch)` 顶层浅合并（`config` 键走 `deepMerge`，对齐 `chrome.storage.set` 语义）+ `saveState` + 广播给订阅者。这是 background.js 里 `getAll`/`set` 的替代品。

- [ ] **Step 1: 写失败测试**

```js
// tests/state.test.js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: state 6 个 FAIL。

- [ ] **Step 3: 写实现**

```js
// src/state.js
import { RARITIES, DROP_SINCE_DEFAULT, deepMerge, isPlainObj } from './lib/shared.js';

const DEFAULT_STATE = {
  config: {
    rarities: RARITIES,
    listPageSize: 10,
    maxPriceByRarity: { UR: 0, SSR: 0, SR: 0, R: 0, N: 0 },
    mechTypes: [],
    maxPriceByMech: { mana_voucher: 0, single_free: 0, vip_7d: 0 },
    presets: [],
    viewMode: 'price',
    searchTags: [],
    budget: { total: 0, spent: 0 },
    lang: null,
    apiKey: '',
    apiBase: '',
    webBase: '',
  },
  isRoundRunning: false,
  buckets: {},
  mechBucket: { lastReqId: 0, items: [], time: null, count: 0 },
  history: [],
  stats: { total: 0, misses: 0, lastRoundTime: null, lastError: null },
  round: null,
  profile: null,
  buyHistory: [],
  ordersAll: [],
  ordersTotal: 0,
  dropStats: {
    since: DROP_SINCE_DEFAULT, lastMsgDate: '', messages: [], feedCards: [], lastFeedAt: 0, summary: null,
  },
  bonus: null,
  cardLogs: [],
  cardLogSummary: null,
  cancelFailedOrders: [],
  marketHistory: [],
  inventory: [],
  mechInventory: [],
  inventoryTotal: 0,
  inventoryFetchedAt: 0,
};

export function createState({ store }) {
  const loaded = store.loadState();
  let state = loaded ? mergeDefaults(loaded) : structuredClone(DEFAULT_STATE);
  const subscribers = new Set();

  function mergeDefaults(loaded) {
    const out = Object.assign(structuredClone(DEFAULT_STATE), loaded);
    out.config = Object.assign({}, DEFAULT_STATE.config, loaded.config || {});
    return out;
  }

  return {
    getState() { return structuredClone(state); },
    async update(patch) {
      for (const k of Object.keys(patch)) {
        if (k === 'config' && isPlainObj(state.config) && isPlainObj(patch.config)) {
          state.config = deepMerge(state.config, patch.config);
        } else {
          state[k] = patch[k];
        }
      }
      store.saveState(state);
      const evt = { type: 'state', patch };
      for (const cb of subscribers) cb(evt);
    },
    subscribe(cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: 内存 state + update 广播 state.js"
```

---

## Task 7: `mteam.js`（mtFetch + 双 base + 401 + verifyApiKey）

**Files:**
- Create: `mcard-server/src/lib/mteam.js`
- Test: `mcard-server/tests/mteam.test.js`

**搬迁来源**：`background.js:1079-1149`（`_readApiBase`/`_writeApiBase`/`getApiKey`/`_mtFetchOnce`/`mtFetch`/`verifyApiKey`）。

**改造点**：① 删除 `chrome.storage` 调用；② 配置读写改为注入的 `{ getApiKey, getApiBase, setApiBase }`（由调用方从 state 提供）；③ `fetch` 用全局（测试 monkey-patch）。`saveApiKey` 的「存令牌」部分在 Task 13 由路由层 + state.update 完成，本模块只暴露无副作用的 `verifyApiKey` 与 `mtFetch`。

- [ ] **Step 1: 写失败测试**

```js
// tests/mteam.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMteam } from '../src/lib/mteam.js';

function mockFetch(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

test('mtFetch 401 抛 API_KEY_INVALID', async () => {
  const restore = mockFetch(async () => ({ status: 401, json: async () => ({ code: '401' }) }));
  const mt = createMteam({
    getApiKey: async () => 'k', getApiBase: async () => 'api.m-team.cc', setApiBase: async () => {},
  });
  await assert.rejects(() => mt.mtFetch('/x', {}), { message: 'API_KEY_INVALID' });
  restore();
});

test('mtFetch code 0 正常返回', async () => {
  const restore = mockFetch(async () => ({ status: 200, json: async () => ({ code: '0', data: 1 }) }));
  const mt = createMteam({ getApiKey: async () => 'k', getApiBase: async () => 'api.m-team.cc', setApiBase: async () => {} });
  const r = await mt.mtFetch('/x', {});
  assert.equal(r.data, 1);
  restore();
});

test('mtFetch 网络 fail 自动切另一 base 并落盘', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    if (calls === 1) throw new Error('network down');
    return { status: 200, json: async () => ({ code: '0' }) };
  });
  let savedBase = null;
  const mt = createMteam({ getApiKey: async () => 'k', getApiBase: async () => 'api.m-team.cc', setApiBase: async (b) => { savedBase = b; } });
  const r = await mt.mtFetch('/x', {});
  assert.equal(r.code, '0');
  assert.equal(savedBase, 'api.m-team.io');
  restore();
});

test('mtFetch 401 不回退（两站同令牌）', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls++; return { status: 401, json: async () => ({ code: '401' }) }; });
  const mt = createMteam({ getApiKey: async () => 'k', getApiBase: async () => 'api.m-team.cc', setApiBase: async () => {} });
  await assert.rejects(() => mt.mtFetch('/x', {}));
  assert.equal(calls, 1);
  restore();
});

test('getApiKey 未配置抛 NO_API_KEY', async () => {
  const restore = mockFetch(async () => ({ status: 200, json: async () => ({ code: '0' }) }));
  const mt = createMteam({ getApiKey: async () => '', getApiBase: async () => 'api.m-team.cc', setApiBase: async () => {} });
  await assert.rejects(() => mt.mtFetch('/x', {}), { message: 'NO_API_KEY' });
  restore();
});

test('verifyApiKey code 0 返回 ok + base', async () => {
  const restore = mockFetch(async (url) => ({
    status: 200,
    json: async () => ({ code: url.includes('.cc') ? '0' : '401' }),
  }));
  const mt = createMteam({ getApiKey: async () => '', getApiBase: async () => '', setApiBase: async () => {} });
  const v = await mt.verifyApiKey('goodkey');
  assert.equal(v.ok, true);
  assert.equal(v.apiBase, 'api.m-team.cc');
  restore();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: mteam 6 个 FAIL。

- [ ] **Step 3: 写实现**

```js
// src/lib/mteam.js
import { API_OPTS } from './shared.js';

export function createMteam({ getApiKey, getApiBase, setApiBase }) {
  async function _mtFetchOnce(base, path, body) {
    const token = await getApiKey();
    if (!token) throw new Error('NO_API_KEY');
    const res = await fetch('https://' + base + path, {
      method: 'POST',
      headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 || String(json.code) === '401') throw new Error('API_KEY_INVALID');
    return json;
  }

  async function mtFetch(path, body) {
    const cur = (await getApiBase()) || 'api.m-team.cc';
    try {
      return await _mtFetchOnce(cur, path, body);
    } catch (e) {
      if (e && e.message === 'API_KEY_INVALID') throw e;
      const other = API_OPTS.find((b) => b !== cur) || 'api.m-team.io';
      const r = await _mtFetchOnce(other, path, body);
      await setApiBase(other);
      return r;
    }
  }

  async function verifyApiKey(key) {
    let netFail = 0;
    for (const base of API_OPTS) {
      try {
        const res = await fetch('https://' + base + '/api/member/profile', {
          method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: '{}',
        });
        const json = await res.json().catch(() => ({}));
        if (String(json.code) === '0') return { ok: true, apiBase: base };
      } catch (e) { netFail++; }
    }
    return { ok: false, reason: netFail >= API_OPTS.length ? 'network' : 'invalid' };
  }

  return { mtFetch, verifyApiKey };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: M-Team 客户端 mteam.js（双 base + 401）"
```

---

## Task 8: `collector.js`（一）—— 市场采集

**Files:**
- Create: `mcard-server/src/lib/collector.js`
- Test: `mcard-server/tests/collector.market.test.js`

**搬迁来源**：`background.js:154-159`（fetchMarketList）、`161-177`（applyMarketRarity）、`179-183`（randSleep）、`185-235`（startRound）、`237-263`（triggerRefreshRound）、`326-364`（onRoundDone）。

**改造点**（应用三条全局规则）：① 所有 `await getAll()` → `await state.getState()`；② 所有 `await set(...)` → `await state.update(...)`；③ 删 `updateAction()`（图标）；④ `triggerRefreshRound` 的 `MARKET_REFRESH_COOLDOWN` 内存时间戳保留（`lastMarketRefreshAt`）；⑤ `onRoundDone` 末尾 `updateAction()` 删；⑥ `HISTORY_LIMIT` 常量搬入。

`collector.js` 导出工厂 `createCollector({ state, mteam, normalizers, stats })`，返回各业务方法。本任务先实现市场部分。

- [ ] **Step 1: 写失败测试**

```js
// tests/collector.market.test.js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: collector.market 2 个 FAIL（`createCollector` 未定义）。

- [ ] **Step 3: 实现 collector.js 市场部分**

```js
// src/lib/collector.js
import { shuffle } from './shared.js';

const HISTORY_LIMIT = 50;
const MARKET_REFRESH_COOLDOWN = 8 * 1000;
let lastMarketRefreshAt = 0;

export function createCollector({ state, mteam, normalizers, stats }) {
  const { slim } = normalizers;
  const { mtFetch } = mteam;

  async function fetchMarketList(rarity, pageSize) {
    const body = rarity === 'MECH'
      ? { pageNumber: 1, pageSize: 100, provenance: 'mech' }
      : { pageNumber: 1, pageSize: pageSize || 10, rarity };
    return mtFetch('/api/pt-card/market/list', body);
  }

  async function applyMarketRarity(rarity, items, time) {
    const allItems = items || [];
    const st = await state.getState();
    if (rarity === 'MECH') {
      const mechBucket = { items: allItems.map(slim), time, count: allItems.length };
      const history = [{ time, rarity: 'MECH', count: allItems.length }].concat(st.history || []).slice(0, HISTORY_LIMIT);
      await state.update({ mechBucket, history });
      return;
    }
    const buckets = Object.assign({}, st.buckets || {});
    buckets[rarity] = { items: allItems.map(slim), time, count: allItems.length };
    const history = [{ time, rarity, count: allItems.length }].concat(st.history || []).slice(0, HISTORY_LIMIT);
    await state.update({ buckets, history });
  }

  function randSleep(min, max) {
    const ms = Math.round(min + Math.random() * (max - min));
    return new Promise((r) => setTimeout(r, ms));
  }

  async function onRoundDone({ hits, misses, authFailed }) {
    const st = await state.getState();
    if (!st.round || st.round.done) return;
    const stats_ = Object.assign({}, st.stats, {
      total: (st.stats.total || 0) + 1,
      misses: (st.stats.misses || 0) + misses,
      lastRoundTime: Date.now(),
      lastError: authFailed ? 'api_key_invalid' : (misses > 0 ? 'partial_miss' : null),
    });
    await state.update({ isRoundRunning: false, round: null, stats: stats_ });
    if (authFailed) return;
    const after = await state.getState();
    if (after.refreshRequested) {
      await state.update({ refreshRequested: false });
      await startRound(after, 'refresh', null, (after.config && after.config.listPageSize) || 10);
    }
  }

  async function startRound(st, reason, onlyRarities, pageSize) {
    reason = reason || 'refresh';
    const cfg = st.config || {};
    let rarities;
    if (onlyRarities && onlyRarities.length) {
      rarities = shuffle(onlyRarities.slice());
    } else {
      const monRarities = (cfg.rarities && cfg.rarities.length) ? cfg.rarities.slice() : ['UR', 'SSR', 'SR', 'R', 'N'];
      if ((cfg.mechTypes || []).length) monRarities.push('MECH');
      rarities = shuffle(monRarities);
    }
    await state.update({ isRoundRunning: true });
    const round = { rarities, startedAt: Date.now(), done: false, reason };
    await state.update({ round });
    let hits = 0, misses = 0, authFailed = false;
    for (const rarity of rarities) {
      await state.update({ round: Object.assign({}, round, { currentRarity: rarity }) });
      try {
        const resp = await fetchMarketList(rarity, pageSize);
        if (resp && resp.code === '0' && resp.data && Array.isArray(resp.data.data)) {
          await applyMarketRarity(rarity, resp.data.data, Date.now());
          hits++;
        } else { misses++; }
      } catch (e) {
        misses++;
        if (e && e.message === 'API_KEY_INVALID') { authFailed = true; break; }
      }
      await randSleep(400, 900);
    }
    if (!authFailed) {
      try { await fetchProfile(); } catch (e) {}
      try { await fetchMyBonus(); } catch (e) {}
    }
    await onRoundDone({ hits, misses, authFailed });
  }

  async function triggerRefreshRound(source, onlyRarities) {
    source = source || 'manual';
    if (source === 'manual' && Date.now() - lastMarketRefreshAt < MARKET_REFRESH_COOLDOWN) {
      return { ok: true, throttled: true };
    }
    const st = await state.getState();
    if (source === 'manual') lastMarketRefreshAt = Date.now();
    const ps = (st.config && st.config.listPageSize) || 10;
    if (st.isRoundRunning) {
      await state.update({ refreshRequested: true });
      return { ok: true, queued: true };
    }
    await startRound(st, 'refresh', onlyRarities, ps);
    return { ok: true, queued: false };
  }

  // fetchProfile / fetchMyBonus 在 Task 9 实现，先占位让市场测试可跑
  async function fetchProfile() {}
  async function fetchMyBonus() {}

  return { startRound, triggerRefreshRound, fetchMarketList, applyMarketRarity, onRoundDone, fetchProfile, fetchMyBonus };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: collector 市场采集（startRound/triggerRefreshRound）"
```

---

## Task 9: `collector.js`（二）—— 数据采集（profile/bonus/trades/orders/inventory/marketHistory/cardLogs）

**Files:**
- Modify: `mcard-server/src/lib/collector.js`（替换 Task 8 的 `fetchProfile`/`fetchMyBonus` 占位 + 新增方法 + 全部加入 return）
- Test: `mcard-server/tests/collector.data.test.js`

**搬迁来源**：
- profile/bonus：`background.js:306-324`（onProfileData）、`573-576`（fetchProfile）、`1058-1073`（fetchMyBonus/onBonusData）
- 翻页：`556-571`（syncList）
- trades：`585-603`（ensureMyTrades）、`760-792`（mergeTrades）
- orders：`606-622`（ensureMyOrders）、`798-824`（mergeOrders）
- marketHistory：`630-693`（mergeMarketHistory/ensureMarketData）
- cardLogs：`701-744`（ensureCardLogs/mergeCardLogs）
- inventory：`831-909`（ensureInventoryData/normalizeInventory/fetchMechanismList/normalizeMechanism）、`921-924`（_todayStr）

**改造点**：应用全局规则。各 `ensure*` 的内存冷却时间戳（`_xxxPromise`/`lastXxxFetchAt`）保留为模块级变量。`normalizeInventory`/`normalizeMechanism` 用 `normalizers.*`；`computeCardLogSummary` 用 `stats.computeCardLogSummary`。`mergeOrders` 返回 `{added,updated,total}`，`syncList` 调它时用 `.then(rr => rr.added)`（原文 614 行）。

- [ ] **Step 1: 写失败测试**

```js
// tests/collector.data.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/lib/collector.js';
import { createState } from '../src/state.js';
import * as normalizers from '../src/lib/normalizers.js';
import * as stats from '../src/lib/stats.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function deps(mt) { return { state: createState({ store: fakeStore() }), mteam: mt, normalizers, stats }; }

test('ensureMyTrades 增量合并并设 side', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/market/myTrades')
      return { code: '0', data: { data: [{ id: 1, filmName: 'A', sellerId: 'me', buyerId: 'o', tradedAt: '2026-07-01 00:00:00', price: 10 }], total: 1 } };
    return { code: '0', data: { data: [], total: 0 } };
  }, verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ profile: { id: 'me' } });
  const col = createCollector(d);
  const r = await col.ensureMyTrades(true);
  assert.equal(r.tradesAdded, 1);
  assert.equal(d.state.getState().buyHistory[0].side, 'sell');
});

test('ensureInventoryData 全量覆盖', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/inventory') return { code: '0', data: { data: [{ id: 7, filmName: '持有' }], total: 1 } };
    if (path === '/api/pt-card/mechanism/list') return { code: '0', data: [] };
    return { code: '0', data: { data: [], total: 0 } };
  }, verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  await col.ensureInventoryData(true);
  assert.equal(d.state.getState().inventory.length, 1);
});

test('profile 解析 bonus/role', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: { username: 'u', id: '9', role: '1', memberCount: { bonus: '500' } } }), verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  await col.fetchProfile();
  assert.equal(d.state.getState().profile.bonus, '500');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: collector.data 3 个 FAIL。

- [ ] **Step 3: 实现数据采集方法**

在 `createCollector` 返回对象前，搬迁并实现下列方法（应用全局规则；`normalizeInventory`/`normalizeMechanism` 用 `normalizers.*`；`computeCardLogSummary` 用 `stats.*`）：`syncList`、`onProfileData`、`fetchProfile`（替换占位）、`fetchMyBonus`/`onBonusData`（替换占位）、`ensureMyTrades`/`mergeTrades`、`ensureMyOrders`/`mergeOrders`、`ensureMarketData`/`mergeMarketHistory`、`ensureCardLogs`/`mergeCardLogs`、`ensureInventoryData`/`fetchMechanismList`、`_todayStr`。

模块级冷却变量保留：`_myTradesPromise`/`lastMyTradesFetchAt`/`_myOrdersPromise`/`lastMyOrdersFetchAt`/`_marketDataPromise`/`lastMarketDataFetchAt`/`_cardLogsPromise`/`lastCardLogFetchAt`/`_inventoryPromise`/`lastInventoryFetchAt` 及各 `*_COOLDOWN` 常量（原文 8s/30s）。把所有新方法加入 `return { ... }`（与 Task 8 已返回的合并）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: collector 数据采集（trades/orders/inventory/history/cardLogs/profile/bonus）"
```

---

## Task 10: `collector.js`（三）—— 掉落统计（仅 feed）

**Files:**
- Modify: `mcard-server/src/lib/collector.js`
- Test: `mcard-server/tests/collector.drop.test.js`

**搬迁来源**：`background.js:1029-1054`（mergeDropFeed）。`_todayStr` 已在 Task 9 搬。

**改造点（关键删减）**：删除整段 tab 逻辑——`ensureDropStats` 的 `needFullTab` 判断与 `chrome.tabs.create` 分支（936-956）、`onDropFirst`（974-978）、`onDropDone`（981-986）、`mergeDropMessages`（989-1027）、`_dropPromise`/`_dropResolve`/`safeCloseTab`。`ensureDropStats` 简化为「总是走 feed」。

- [ ] **Step 1: 写失败测试**

```js
// tests/collector.drop.test.js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: collector.drop 2 个 FAIL。

- [ ] **Step 3: 实现 ensureDropStats（仅 feed）**

在 `createCollector` 内搬迁 `mergeDropFeed`（应用全局规则，`computeDropSummary` 用 `stats.computeDropSummary`），并实现简化版：

```js
async function ensureDropStats() {
  const r = await syncList('/api/pt-card/feed', mergeDropFeed, 25, 'incremental');
  const cur = await state.getState();
  await state.update({ dropStats: Object.assign({}, cur.dropStats || {}, { lastFeedAt: Date.now() }) });
  return { ok: true, dropsAdded: r.added };
}
```

把 `ensureDropStats` 加入 return。**不**搬迁任何 tab/`chrome.tabs` 相关代码。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: collector 掉落统计（仅 feed 增量，删除 tab 全量）"
```

---

## Task 11: `collector.js`（四）—— 定向搜索 + 询价 + refreshAll + setConfig

**Files:**
- Modify: `mcard-server/src/lib/collector.js`
- Test: `mcard-server/tests/collector.search.test.js`

**搬迁来源**：`background.js:1122-1132`（queryOrderbook）、`1376-1403`（searchMarket，mapSearchItem 已在 normalizers）、`746-757`（refreshAll）、`382-402`（setConfig/clearData）。

**改造点**：应用全局规则。`setConfig` 用 `deepMerge`（来自 shared）合并后 `state.update({ config: merged })`。`refreshAll` 调本模块各 `ensure*` + `startRound`，删 `chrome.*`。

- [ ] **Step 1: 写失败测试**

```js
// tests/collector.search.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/lib/collector.js';
import { createState } from '../src/state.js';
import * as normalizers from '../src/lib/normalizers.js';
import * as stats from '../src/lib/stats.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function deps(mt) { return { state: createState({ store: fakeStore() }), mteam: mt, normalizers, stats }; }

test('searchMarket 多 tag 合并去重', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/market/search')
      return { code: '0', data: { data: [{ cardId: '1', filmName: 'A', rarity: 'UR' }, { cardId: '2', filmName: 'B', rarity: 'SR' }] } };
    return { code: '0', data: { data: [] } };
  }, verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  const r = await col.searchMarket(['浪浪山', '深海']);
  assert.equal(r.items.length, 2);
});

test('queryOrderbook 取最高买价', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: { asks: [{ price: 100 }], bids: [{ price: 80 }, { price: 60 }] } }), verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  const r = await col.queryOrderbook('film1', 'normal', 'UR');
  assert.equal(r.ok, true);
  assert.equal(r.bid, 80);
});

test('setConfig 嵌套合并不丢字段', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0' }), verifyApiKey: async () => ({ ok: true }) });
  const col = createCollector(d);
  await col.setConfig({ budget: { total: 500 } });
  const cfg = d.state.getState().config;
  assert.equal(cfg.budget.total, 500);
  assert.ok(Array.isArray(cfg.rarities));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: search 3 个 FAIL。

- [ ] **Step 3: 实现搜索/询价/refreshAll/setConfig/clearData**

搬迁 `queryOrderbook`、`searchMarket`（`mapSearchItem` 用 `normalizers.mapSearchItem`）、`refreshAll`、`setConfig`（`deepMerge` from shared）、`clearData`（应用全局规则）。全部加入 return。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: collector 搜索/询价/refreshAll/setConfig"
```

---

## Task 12: `trader.js`（买卖撤）

**Files:**
- Create: `mcard-server/src/lib/trader.js`
- Test: `mcard-server/tests/trader.test.js`

**搬迁来源**：`background.js:407-498`（cancelBuyOrder/addCancelFailedOrder/buyCard）、`500-523`（sellCard）、`525-545`（cancelOrder）。

**改造点**：应用全局规则；`buildDetailUrl`/`computeUsable`/`isMechCard` 用 shared；`triggerRefreshRound`/`ensureInventoryData`/`ensureMyOrders` 改为调用注入的 `collector` 方法（构造参数增加 `collector`）。`CANCEL_RETRY`/`CANCEL_RETRY_DELAY` 常量搬入。

- [ ] **Step 1: 写失败测试**

```js
// tests/trader.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrader } from '../src/lib/trader.js';
import { createState } from '../src/state.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function fakeCollector() {
  return { triggerRefreshRound: async () => ({ ok: true }), ensureInventoryData: async () => ({}), ensureMyOrders: async () => ({}) };
}
function deps(mt) { return { state: createState({ store: fakeStore() }), mteam: mt, collector: fakeCollector() }; }

test('buyCard 无预算拒绝', async () => {
  const tr = createTrader(deps({ mtFetch: async () => ({ code: '0', data: {} }), verifyApiKey: async () => ({ ok: true }) }));
  const r = await tr.buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'budget_not_set');
});

test('buyCard 预算不足拒绝', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: {} }), verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 100, spent: 0 } }, profile: { bonus: '30' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 50 });
  assert.equal(r.reason, 'budget_insufficient');
});

test('buyCard 成交扣预算池', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0', data: { status: 'filled', trade: { price: 80 } } }), verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 1000, spent: 0 } }, profile: { bonus: '500' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 80 });
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
  assert.equal(d.state.getState().config.budget.spent, 80);
});

test('buyCard 未成交 open → cancel', async () => {
  const d = deps({ mtFetch: async (path) => {
    if (path === '/api/pt-card/market/buy') return { code: '0', data: { status: 'open', orderId: 99 } };
    if (path === '/api/pt-card/market/cancel') return { code: '0' };
    return { code: '0' };
  }, verifyApiKey: async () => ({ ok: true }) });
  await d.state.update({ config: { budget: { total: 1000, spent: 0 } }, profile: { bonus: '500' } });
  const r = await createTrader(d).buyCard({ variant: { filmId: 'f', rarity: 'UR', provenance: 'normal' }, expectPrice: 80 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unfilled');
  assert.equal(r.cancelFailed, false);
});

test('sellCard 普通卡传 cardId', async () => {
  let sentBody = null;
  const d = deps({ mtFetch: async (path, body) => { if (path === '/api/pt-card/market/sell') sentBody = body; return { code: '0', data: {} }; }, verifyApiKey: async () => ({ ok: true }) });
  const r = await createTrader(d).sellCard({ cardId: '7', netPrice: 100 });
  assert.equal(r.ok, true);
  assert.equal(sentBody.cardId, 7);
});

test('cancelOrder 成功', async () => {
  const d = deps({ mtFetch: async () => ({ code: '0' }), verifyApiKey: async () => ({ ok: true }) });
  const r = await createTrader(d).cancelOrder({ orderId: 5 });
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: trader 6 个 FAIL。

- [ ] **Step 3: 实现 trader.js**

```js
// src/lib/trader.js
import { buildDetailUrl, computeUsable, isMechCard } from './shared.js';

const CANCEL_RETRY = 3;
const CANCEL_RETRY_DELAY = 300;

export function createTrader({ state, mteam, collector }) {
  const { mtFetch } = mteam;

  async function cancelBuyOrder(orderId) {
    for (let i = 0; i < CANCEL_RETRY; i++) {
      try {
        const r = await mtFetch('/api/pt-card/market/cancel', { orderId: Number(orderId) });
        if (r && String(r.code) === '0') return true;
      } catch (e) {}
      if (i < CANCEL_RETRY - 1) await new Promise((res) => setTimeout(res, CANCEL_RETRY_DELAY));
    }
    return false;
  }

  async function addCancelFailedOrder(rec) {
    if (!rec || rec.orderId == null) return;
    const st = await state.getState();
    await state.update({ cancelFailedOrders: (st.cancelFailedOrders || []).concat([rec]) });
  }

  // buyCard / sellCard / cancelOrder：完整搬迁 background.js:430-498 / 502-523 / 527-545，
  // 逐行应用三条全局规则（getAll→state.getState，set→state.update），
  // 并把 triggerRefreshRound/ensureInventoryData/ensureMyOrders 换成 collector.* 调用。
  // 逻辑必须完整保留：预算校验（computeUsable）、限价安全门、filled/open 分支、
  // cancel 重试、批量 skipRefresh、成交扣预算池。
  async function buyCard(msg) { /* 搬 background.js:430-498 */ }
  async function sellCard(msg) { /* 搬 background.js:502-523 */ }
  async function cancelOrder(msg) { /* 搬 background.js:527-545 */ }

  return { buyCard, sellCard, cancelOrder };
}
```

> **搬迁说明**：上面 `buyCard/sellCard/cancelOrder` 的 `/* 搬 ... */` 是执行指引。实际产出必须是完整函数体（不得保留 `/* 搬 */` 注释），逻辑、分支、返回结构严格对齐原文，仅做「三条全局规则 + collector.* 替换」。测试已覆盖核心分支（无预算/预算不足/成交扣费/open→cancel/sell cardId/cancel）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: 买卖撤 trader.js"
```

---

## Task 13: `routes/api.js`（REST 端点）

**Files:**
- Create: `mcard-server/src/routes/api.js`
- Test: `mcard-server/tests/api.test.js`

**职责**：把 background.js 的 `onMessage` 分发（266-303）映射为 REST 路由。配置：`GET/POST /api/config`（POST 存 apiKey 经 verifyApiKey 验证后落库）。采集：`POST /api/collect`。交易：`POST /api/trade`。询价/搜索：`GET /api/orderbook`、`POST /api/search`。状态：`GET /api/state`。配置项：`POST /api/setconfig`。

- [ ] **Step 1: 写失败测试**

```js
// tests/api.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createState } from '../src/state.js';
import { createApiRouter } from '../src/routes/api.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }
function req(server, method, path, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : {} }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function setup(verify, collector) {
  const state = createState({ store: fakeStore() });
  const app = express(); app.use(express.json());
  app.use(createApiRouter({ state, collector: collector || {}, trader: {}, mteam: { verifyApiKey: verify } }));
  return { state, server: app.listen(0) };
}

test('GET /api/state 返回完整状态且不泄露 apiKey', async () => {
  const { server } = setup(async () => ({ ok: true }));
  try {
    const r = await req(server, 'GET', '/api/state');
    assert.equal(r.status, 200);
    assert.ok(r.json.config);
    assert.equal(r.json.config.apiKey, '');
  } finally { server.close(); }
});

test('POST /api/config 验证并落库 apiKey', async () => {
  const { state, server } = setup(async () => ({ ok: true, apiBase: 'api.m-team.cc' }));
  try {
    const r = await req(server, 'POST', '/api/config', { apiKey: 'goodkey', webBase: 'kp.m-team.cc' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(state.getState().config.apiKey, 'goodkey');
    assert.equal(state.getState().config.apiBase, 'api.m-team.cc');
  } finally { server.close(); }
});

test('POST /api/config 无效 key 返回 invalid 且不落库', async () => {
  const { state, server } = setup(async () => ({ ok: false, reason: 'invalid' }));
  try {
    const r = await req(server, 'POST', '/api/config', { apiKey: 'bad' });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, 'invalid');
    assert.equal(state.getState().config.apiKey, '');
  } finally { server.close(); }
});

test('POST /api/collect 路由到 collector', async () => {
  let called = null;
  const collector = { triggerRefreshRound: async () => { called = 'market'; return { ok: true }; }, ensureMyTrades: async () => ({}), ensureMyOrders: async () => ({}), ensureInventoryData: async () => ({}), ensureDropStats: async () => ({}), ensureMarketData: async () => ({}) };
  const { server } = setup(async () => ({ ok: true }), collector);
  try {
    await req(server, 'POST', '/api/collect', { type: 'market' });
    assert.equal(called, 'market');
  } finally { server.close(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: api 4 个 FAIL。

- [ ] **Step 3: 实现 api.js**

```js
// src/routes/api.js
import { Router } from 'express';

export function createApiRouter({ state, collector, trader, mteam }) {
  const router = Router();

  router.get('/api/state', (_req, res) => {
    const s = state.getState();
    const safe = structuredClone(s);
    if (safe.config) safe.config.apiKey = safe.config.apiKey ? '(set)' : '';
    res.json(safe);
  });

  router.post('/api/config', async (req, res) => {
    const { apiKey, webBase } = req.body || {};
    const key = String(apiKey || '').trim();
    if (!key) return res.json({ ok: false, reason: 'empty' });
    const v = await mteam.verifyApiKey(key);
    if (!v.ok) return res.json(v);
    await state.update({ config: { apiKey: key, apiBase: v.apiBase, webBase: webBase || '' } });
    return res.json({ ok: true });
  });
  router.get('/api/config', (_req, res) => {
    res.json({ hasKey: !!state.getState().config.apiKey });
  });

  router.post('/api/collect', async (req, res) => {
    const { type } = req.body || {};
    try {
      switch (type) {
        case 'market': return res.json(await collector.triggerRefreshRound('manual'));
        case 'trades': return res.json(await collector.ensureMyTrades(true));
        case 'orders': return res.json(await collector.ensureMyOrders(true));
        case 'inventory': return res.json(await collector.ensureInventoryData(true));
        case 'drops': return res.json(await collector.ensureDropStats());
        case 'marketStats': return res.json(await collector.ensureMarketData(true));
        case 'all': return res.json(await collector.refreshAll());
        default: return res.json({ ok: false, reason: 'unknown_type' });
      }
    } catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
  });

  router.post('/api/trade', async (req, res) => {
    const { action } = req.body || {};
    try {
      if (action === 'buy') return res.json(await trader.buyCard(req.body));
      if (action === 'sell') return res.json(await trader.sellCard(req.body));
      if (action === 'cancel') return res.json(await trader.cancelOrder(req.body));
      res.json({ ok: false, reason: 'unknown_action' });
    } catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
  });

  router.get('/api/orderbook', async (req, res) => {
    const { filmId, provenance, rarity } = req.query;
    res.json(await collector.queryOrderbook(filmId, provenance, rarity));
  });
  router.post('/api/search', async (req, res) => {
    const { tags, pageSize } = req.body || {};
    res.json(await collector.searchMarket(tags, pageSize));
  });
  router.post('/api/setconfig', async (req, res) => res.json(await collector.setConfig(req.body || {})));

  return router;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: REST API 路由 api.js"
```

---

## Task 14: `routes/sse.js`（SSE 状态推送）

**Files:**
- Create: `mcard-server/src/routes/sse.js`
- Test: `mcard-server/tests/sse.test.js`

**职责**：`GET /events` 建立 SSE 连接，订阅 `state.subscribe`，把 `{type:'state', patch}` 作为 SSE 事件推给客户端。替代 `chrome.storage.onChanged`。

- [ ] **Step 1: 写失败测试**

```js
// tests/sse.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createState } from '../src/state.js';
import { createSseRouter } from '../src/routes/sse.js';

function fakeStore() { let s = null; return { loadState: () => s, saveState: (x) => { s = x; } }; }

test('state.update 触发 SSE 事件', async () => {
  const state = createState({ store: fakeStore() });
  const app = express(); app.use(createSseRouter({ state }));
  const server = app.listen(0);
  const port = server.address().port;
  const p = new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/events', headers: { accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString(); if (buf.includes('\n\n')) resolve(buf); });
    });
  });
  await new Promise((r) => setTimeout(r, 50));
  await state.update({ profile: { id: 1 } });
  const buf = await p;
  assert.ok(buf.includes('event: state'));
  assert.ok(buf.includes('"profile"'));
  server.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: sse 1 个 FAIL（超时或未定义）。

- [ ] **Step 3: 实现 sse.js**

```js
// src/routes/sse.js
import { Router } from 'express';

export function createSseRouter({ state }) {
  const router = Router();
  router.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const send = (evt) => res.write('event: ' + evt.type + '\ndata: ' + JSON.stringify(evt) + '\n\n');
    const unsubscribe = state.subscribe(send);
    req.on('close', () => unsubscribe());
  });
  return router;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: SSE 状态推送 sse.js"
```

---

## Task 15: `server.js` 整合 + 端到端冒烟

**Files:**
- Modify: `mcard-server/src/server.js`（替换 Task 1 的最小骨架）
- Create: `mcard-server/tests/smoke.test.js`

**职责**：装配所有模块——openStore → createState → createMteam（注入 state 的 apiKey/apiBase 读写）→ createCollector → createTrader → createApiRouter + createSseRouter → listen。启动时重算 dropStats/cardLog summary（对齐 background.js:79-91）。

- [ ] **Step 1: 写端到端冒烟测试**

```js
// tests/smoke.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from '../src/server.js';

function req(server, method, p, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : {} }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

test('装配后 health + state + collect(unknown) 可用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcard-'));
  const { server } = createServer({ dbPath: path.join(dir, 's.db'), port: 0 });
  try {
    const h = await req(server, 'GET', '/health');
    assert.equal(h.json.ok, true);
    const s = await req(server, 'GET', '/api/state');
    assert.ok(s.json.config);
    const c = await req(server, 'POST', '/api/collect', { type: 'nope' });
    assert.equal(c.json.reason, 'unknown_type');
  } finally { server.close(); }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mcard-server && npm test`
Expected: smoke 1 个 FAIL（`createServer` 不存在）。

- [ ] **Step 3: 整合 server.js**

```js
// src/server.js
import express from 'express';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createState } from './state.js';
import { createMteam } from './lib/mteam.js';
import { createCollector } from './lib/collector.js';
import { createTrader } from './lib/trader.js';
import * as normalizers from './lib/normalizers.js';
import * as stats from './lib/stats.js';
import { createApiRouter } from './routes/api.js';
import { createSseRouter } from './routes/sse.js';

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function createStoreState(store) {
  const state = createState({ store });
  (async () => {
    try {
      const st = state.getState();
      const patch = {};
      const ds = st.dropStats;
      if (ds && Array.isArray(ds.messages) && ds.messages.length) {
        patch.dropStats = Object.assign({}, ds, { summary: stats.computeDropSummary(ds.messages, ds.feedCards, ds.since, todayStr()) });
      }
      if (Array.isArray(st.cardLogs) && st.cardLogs.length) {
        patch.cardLogSummary = stats.computeCardLogSummary(st.cardLogs);
      }
      if (Object.keys(patch).length) await state.update(patch);
    } catch (e) { console.warn('[mcard] startup recompute failed', e); }
  })();
  return state;
}

export function createServer({ dbPath = 'data/mcard.db', port } = {}) {
  const store = openStore(dbPath);
  const state = createStoreState(store);
  const mteam = createMteam({
    getApiKey: async () => state.getState().config.apiKey,
    getApiBase: async () => state.getState().config.apiBase,
    setApiBase: async (b) => state.update({ config: { apiBase: b } }),
  });
  const collector = createCollector({ state, mteam, normalizers, stats });
  const trader = createTrader({ state, mteam, collector });

  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(createApiRouter({ state, collector, trader, mteam }));
  app.use(createSseRouter({ state }));

  const server = app.listen(port ?? (Number(process.env.PORT) || 3000));
  return { app, server, state, store };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer();
  console.log('[mcard] server started');
}
```

- [ ] **Step 4: 跑全部测试**

Run: `cd mcard-server && npm test`
Expected: 全部 PASS（含 smoke）。

- [ ] **Step 5: 手动冒烟（curl）**

```bash
cd mcard-server && PORT=3000 node src/server.js &
sleep 1
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/api/state | head -c 200
curl -s -X POST http://127.0.0.1:3000/api/config -H 'content-type: application/json' -d '{"apiKey":"你的key","webBase":"kp.m-team.cc"}'
curl -s -X POST http://127.0.0.1:3000/api/collect -H 'content-type: application/json' -d '{"type":"market"}'
kill %1
```
Expected：`/health` 返回 `{"ok":true}`；填入真实 key 后 `/api/collect` 返回 `{"ok":true,...}`，再次 `GET /api/state` 可见 `buckets` 已落库。

- [ ] **Step 6: Commit**

```bash
cd mcard-server && git add -A && git commit -m "feat: server 整合 + 端到端冒烟（Plan 1 完成）"
```

---

## Plan 1 完成标准

- [ ] `npm test` 全绿（health/shared/stats/normalizers/store/state/mteam/collector.*/trader/api/sse/smoke）
- [ ] 填入真实 `x-api-key` 后，curl 可完成：市场采集、交易记录/挂单/持有/掉落/市场历史采集、买卖撤、询价、定向搜索
- [ ] `data/mcard.db` 持久化，容器重启后 state 恢复
- [ ] `GET /events` SSE 在采集/交易后推送 state patch

**后续**：Plan 2（前端 dashboard.js → app.js 通信层改造 + 移动端响应式）、Plan 3（PWA manifest/sw + Dockerfile）。

---

## 自审（writing-plans self-review）

**1. Spec 覆盖**：spec 第 5/6/7/8/9/12/13/14 节（项目结构、模块职责、数据流、API、chrome.* 映射、错误处理、测试、配置安全）均由 Plan 1 任务覆盖。spec 第 10/11 节（PWA、移动端）属 Plan 2/3，不在本计划。✅
**2. 占位符扫描**：Task 9（数据采集）与 Task 12（trader）的 `buyCard/sellCard/cancelOrder` 用「搬迁指引 + 来源行号」表述——这是迁移项目的必要形式（源码已在仓库 `mcard-main/background.js`），执行时须产出完整函数体，已明确声明并附核心分支测试。其余任务代码完整。✅
**3. 类型/命名一致性**：`state.getState/update/subscribe`、`createMteam({getApiKey,getApiBase,setApiBase})`、`createCollector({state,mteam,normalizers,stats})`、`createTrader({state,mteam,collector})`、`createApiRouter({state,collector,trader,mteam})`、`createSseRouter({state})` 在所有任务中签名一致。`config.apiKey/apiBase/webBase` 统一。✅

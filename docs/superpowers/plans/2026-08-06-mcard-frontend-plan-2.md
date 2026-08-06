# MCard 容器化 Plan 2：前端改造 + 移动端响应式 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把扩展的 `dashboard.{html,css,js}` 改造成普通 Web 前端（`public/`），通信层从 `chrome.runtime`/`chrome.storage` 换成 `fetch`（Plan 1 的 REST）+ `EventSource`（SSE），并加移动端底部 tab 栏响应式。由 Plan 1 的 Express 静态托管。

**Architecture:** `send(msg)`（dashboard.js:68-70）是唯一通信出口——15 种 type 全经此。把 `send` 内部从 `chrome.runtime.sendMessage` 换成 `fetch` 分发（`dispatch(msg)→{method,path,body}` 纯函数），所有 30+ 调用点无需改动。`chrome.storage.onChanged` 换成 `EventSource('/events')`，复用原 `refresh(keys)→renderAll/renderLive` 逻辑。`lockedCards` 换 `localStorage`，`chrome.tabs.create` 换 `window.open`。

**Tech Stack:** 原生 JS（无框架/无构建，沿用 dashboard.js）、Express 静态托管、`node:test`（测 dispatch 纯函数）、Playwright（端到端 DOM 验证）。

---

## 测试策略说明（前端改造的现实调整）

前端 DOM 代码不易 node 单测。本计划的测试分两层：
- **纯逻辑（dispatch 映射）**：提取为 ESM `public/dispatch.js`，用 `node:test` TDD（Node import + 浏览器挂 window）。
- **DOM/通信改造（send、SSE、localStorage、tabs）、移动端 CSS**：靠精确改造（行号 + old→new）+ review + **Playwright 端到端烟测**（T5）。

## Plan 1 API 契约（dispatch 映射依据）

| send type | → HTTP |
|---|---|
| `GET_STATE` | `GET /api/state` |
| `GET_ORDERBOOK` {filmId,provenance,rarity} | `GET /api/orderbook?filmId=&provenance=&rarity=` |
| `REFRESH_NOW` | `POST /api/collect {type:'market'}` |
| `LOAD_TRADES` | `POST /api/collect {type:'trades'}` |
| `LOAD_ORDERS` | `POST /api/collect {type:'orders'}` |
| `LOAD_INVENTORY` | `POST /api/collect {type:'inventory'}` |
| `LOAD_DROP_STATS` | `POST /api/collect {type:'drops'}` |
| `LOAD_MARKET_DATA` | `POST /api/collect {type:'marketStats'}` |
| `SEARCH_MARKET` {tags,pageSize} | `POST /api/search {tags,pageSize}` |
| `BUY_CARD` {variant,expectPrice,maxPrice,skipRefresh} | `POST /api/trade {action:'buy',...}` |
| `SELL_CARD` {cardId,isMech,netPrice,skipRefresh} | `POST /api/trade {action:'sell',...}` |
| `CANCEL_ORDER` {orderId,skipRefresh} | `POST /api/trade {action:'cancel',...}` |
| `SET_CONFIG` {config:{...}} | `POST /api/setconfig {…partial}` |
| `SAVE_API_KEY` {key,webBase} | `POST /api/config {apiKey,webBase}` |
| `SET_WEB_BASE` {webBase} | `POST /api/setconfig {webBase}` |

## 文件结构（Plan 2 产出）

```
mcard-server/
├── src/server.js                 # Modify：加 express.static('public')
├── public/                       # 新建：PWA 前端根（Plan 3 加 manifest/sw）
│   ├── index.html                # ← dashboard.html 改造（引用 + 底部 tab 栏）
│   ├── app.css                   # ← dashboard.css + 移动端 @media
│   ├── app.js                    # ← dashboard.js 改造（send/onChanged/lockedCards/tabs）
│   ├── dispatch.js               # 新建：纯函数 dispatch(msg)→request（TDD）
│   ├── shared.js / theme-bootstrap.js / lang-bootstrap.js / locales/ / logo.png  # 原样复制
│   └── dropStats.js / marketStats.js / portrait.js  # 原样复制（前端用的纯逻辑；注意这些仍是非 ESM 全局脚本）
└── tests/dispatch.test.js        # 新建：dispatch 单测
```

---

## Task 1: public/ 骨架 + Express 静态托管

**Files:**
- Create: `mcard-server/public/`（复制前端资源）
- Modify: `mcard-server/src/server.js`（加静态托管）
- Test: 手动 `curl` 验证

- [ ] **Step 1: 复制前端资源到 public/**

从 `mcard-main/` 复制到 `mcard-server/public/`（原样，不改内容）：
- `dashboard.html` → `public/index.html`
- `dashboard.css` → `public/app.css`
- `dashboard.js` → `public/app.js`
- `shared.js`、`theme-bootstrap.js`、`lang-bootstrap.js`、`logo.png`、`locales/`（整个目录）→ `public/`
- `dropStats.js`、`marketStats.js`、`portrait.js` → `public/`（前端 dashboard.js 依赖这些纯逻辑脚本）

Run（示例）:
```bash
cd /home/jaxo/workspace/mcard
mkdir -p mcard-server/public
cp mcard-main/dashboard.html mcard-server/public/index.html
cp mcard-main/dashboard.css mcard-server/public/app.css
cp mcard-main/dashboard.js mcard-server/public/app.js
cp mcard-main/shared.js mcard-main/theme-bootstrap.js mcard-main/lang-bootstrap.js mcard-main/logo.png mcard-server/public/
cp mcard-main/dropStats.js mcard-main/marketStats.js mcard-main/portrait.js mcard-server/public/
cp -r mcard-main/locales mcard-server/public/locales
```

- [ ] **Step 2: 改 index.html 的资源引用**

`index.html` 里把 `dashboard.css` → `app.css`、`dashboard.js` → `app.js`（`<link>` 和 `<script>` 标签）。其余不动。

- [ ] **Step 3: server.js 加静态托管**

在 `src/server.js` 顶部 import 加 `path`：
```js
import path from 'node:path';
```
在 `createServer` 内、挂载 apiRouter 之前加：
```js
  app.use(express.static(path.join(import.meta.dirname, '../public')));
```
（`import.meta.dirname` 是 server.js 的 src/ 目录，`../public` 指向 mcard-server/public/。）

- [ ] **Step 4: 验证静态托管**

Run:
```bash
cd /home/jaxo/workspace/mcard/mcard-server && PORT=3940 node src/server.js &
sleep 1
curl -s http://127.0.0.1:3940/ | head -5          # 应返回 index.html 开头
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3940/app.js   # 应 200
kill %1
```
Expected：`curl /` 返回 HTML；`app.js` 返回 200。npm test 仍全绿（51→不变，本任务无新测试）。

- [ ] **Step 5: Commit**

```bash
git -C /home/jaxo/workspace/mcard add mcard-server && git -C /home/jaxo/workspace/mcard commit -m "feat: public/ 前端骨架 + Express 静态托管"
```

---

## Task 2: dispatch.js（纯函数，TDD）+ app.js send 改造

**Files:**
- Create: `mcard-server/public/dispatch.js`
- Create: `mcard-server/tests/dispatch.test.js`
- Modify: `mcard-server/public/app.js`（send 函数，68-70）

- [ ] **Step 1: 写失败测试 `tests/dispatch.test.js`**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix /home/jaxo/workspace/mcard/mcard-server test`
Expected: dispatch 测试 FAIL（模块不存在）。

- [ ] **Step 3: 写 `public/dispatch.js`**

```js
// public/dispatch.js — send(msg) 的 fetch 路由映射（纯函数，浏览器 + Node 可测）
// 浏览器：<script type="module" src="dispatch.js"> 挂 window.dispatch
// Node：import { dispatch } 用于测试
export function dispatch(msg) {
  switch (msg.type) {
    case 'GET_STATE':        return { method: 'GET',  path: '/api/state' };
    case 'GET_ORDERBOOK': {
      const q = new URLSearchParams({ filmId: msg.filmId || '', provenance: msg.provenance || '', rarity: msg.rarity || '' });
      return { method: 'GET', path: '/api/orderbook?' + q.toString() };
    }
    case 'REFRESH_NOW':      return { method: 'POST', path: '/api/collect', body: { type: 'market' } };
    case 'LOAD_TRADES':      return { method: 'POST', path: '/api/collect', body: { type: 'trades' } };
    case 'LOAD_ORDERS':      return { method: 'POST', path: '/api/collect', body: { type: 'orders' } };
    case 'LOAD_INVENTORY':   return { method: 'POST', path: '/api/collect', body: { type: 'inventory' } };
    case 'LOAD_DROP_STATS':  return { method: 'POST', path: '/api/collect', body: { type: 'drops' } };
    case 'LOAD_MARKET_DATA': return { method: 'POST', path: '/api/collect', body: { type: 'marketStats' } };
    case 'SEARCH_MARKET':    return { method: 'POST', path: '/api/search', body: { tags: msg.tags, pageSize: msg.pageSize } };
    case 'BUY_CARD':         return { method: 'POST', path: '/api/trade', body: { action: 'buy', variant: msg.variant, expectPrice: msg.expectPrice, maxPrice: msg.maxPrice, skipRefresh: msg.skipRefresh } };
    case 'SELL_CARD':        return { method: 'POST', path: '/api/trade', body: { action: 'sell', cardId: msg.cardId, isMech: msg.isMech, netPrice: msg.netPrice, skipRefresh: msg.skipRefresh } };
    case 'CANCEL_ORDER':     return { method: 'POST', path: '/api/trade', body: { action: 'cancel', orderId: msg.orderId, skipRefresh: msg.skipRefresh } };
    case 'SET_CONFIG':       return { method: 'POST', path: '/api/setconfig', body: msg.config };
    case 'SAVE_API_KEY':     return { method: 'POST', path: '/api/config', body: { apiKey: msg.key, webBase: msg.webBase } };
    case 'SET_WEB_BASE':     return { method: 'POST', path: '/api/setconfig', body: { webBase: msg.webBase } };
    default: return null;
  }
}
if (typeof window !== 'undefined') window.dispatch = dispatch;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix /home/jaxo/workspace/mcard/mcard-server test`
Expected: dispatch 测试 PASS（9 个），全绿。

- [ ] **Step 5: 改造 app.js 的 send（68-70）+ index.html 加载 dispatch**

`app.js` 替换 68-70：
```js
// 原：
// function send(msg) {
//   return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r)));
// }
// 新：
function send(msg) {
  const d = window.dispatch(msg);
  if (!d) return Promise.resolve(null);
  return fetch(d.path, {
    method: d.method,
    headers: d.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: d.body !== undefined ? JSON.stringify(d.body) : undefined,
  }).then((r) => r.json()).catch((e) => { console.warn('[mcard] send failed', msg.type, e); return null; });
}
```

`index.html` 的 `<head>`（在 app.css 之后、theme/lang bootstrap 之前）加：
```html
<script type="module" src="dispatch.js"></script>
```
并把 `<script src="app.js"></script>` 改为 `<script defer src="app.js"></script>`（确保 dispatch module 先于 app.js 执行；defer 普通脚本与 module 都在 DOM 解析后按文档顺序执行）。

- [ ] **Step 6: Commit**

```bash
git -C /home/jaxo/workspace/mcard add mcard-server && git -C /home/jaxo/workspace/mcard commit -m "feat: dispatch.js 路由映射（TDD）+ app.js send 改 fetch"
```

---

## Task 3: app.js 其余通信改造（SSE + localStorage + tabs）

**Files:**
- Modify: `mcard-server/public/app.js`

**改造点 A：onChanged → EventSource（99-111）**

替换 `chrome.storage.onChanged.addListener(...)` 整段为：
```js
// SSE：后端 state 变更推送（替代 chrome.storage.onChanged）。复用 refresh(keys)→renderAll/renderLive。
const es = new EventSource('/events');
es.addEventListener('state', (e) => {
  let patch;
  try { patch = JSON.parse(e.data).patch || {}; } catch (err) { return; }
  refresh(Object.keys(patch));
});
```
（原 lockedCards 分支删除——lockedCards 改本地后不再从后端来；见改造点 B。）

**改造点 B：lockedCards → localStorage（3296-3305）**

`persistLocked`（3296-3298）改为：
```js
function persistLocked() {
  try { localStorage.setItem('mcard.lockedCards', JSON.stringify(Array.from(lockedSet))); } catch (e) {}
}
```
启动读取（3300-3305）改为：
```js
try {
  lockedSet = new Set(JSON.parse(localStorage.getItem('mcard.lockedCards') || '[]'));
  if (view === 'inventory') renderInventory();
} catch (e) {}
```

**改造点 C：chrome.tabs.create → window.open（4 处：715, 1214, 3802, 4040）**

每处 `chrome.tabs.create({ url })` 改为 `window.open(url, '_blank')`。模式：
```js
// 原：openBtn.onclick = (e) => { e.stopPropagation(); chrome.tabs.create({ url }); };
// 新：openBtn.onclick = (e) => { e.stopPropagation(); window.open(url, '_blank'); };
```

**改造点 D：检查残留 chrome.\***

改造 A-C 后，grep `public/app.js` 确认无 `chrome.` 残留（应为 0）：
```bash
grep -n "chrome\." /home/jaxo/workspace/mcard/mcard-server/public/app.js || echo "无残留（正确）"
```

- [ ] **Step 1: 应用改造 A-D**

逐处替换。注意：onChanged 整段（99-111）替换；persistLocked + 启动读取替换；4 处 tabs.create 替换。

- [ ] **Step 2: 验证无 chrome 残留**

Run: `grep -n "chrome\." /home/jaxo/workspace/mcard/mcard-server/public/app.js`
Expected: 无输出（或仅注释，若有一律清除）。

- [ ] **Step 3: 跑后端测试确认未破坏**

Run: `npm --prefix /home/jaxo/workspace/mcard/mcard-server test`
Expected: 仍全绿（dispatch 9 + 后端 51 = 60，本任务不改后端/dispatch）。

- [ ] **Step 4: Commit**

```bash
git -C /home/jaxo/workspace/mcard add mcard-server && git -C /home/jaxo/workspace/mcard commit -m "feat: app.js 通信改造（SSE/localStorage/window.open）"
```

---

## Task 4: 移动端响应式（底部 tab 栏 + @media）

**Files:**
- Modify: `mcard-server/public/index.html`（加底部 tab 栏）
- Modify: `mcard-server/public/app.css`（加 @media）
- Modify: `mcard-server/public/app.js`（绑定 tab 点击 + active 同步）

- [ ] **Step 1: index.html 加底部 tab 栏**

在 `</body>` 前、所有 `<script>` 之前加：
```html
<nav class="mobile-tabs" id="mobileTabs" aria-label="主导航">
  <button type="button" class="mtab" data-view="market"><span class="mtab-icon">🏪</span><span class="mtab-label">市场</span></button>
  <button type="button" class="mtab" data-view="trades"><span class="mtab-icon">💳</span><span class="mtab-label">交易</span></button>
  <button type="button" class="mtab" data-view="orders"><span class="mtab-icon">📋</span><span class="mtab-label">挂单</span></button>
  <button type="button" class="mtab" data-view="inventory"><span class="mtab-icon">📦</span><span class="mtab-label">持有</span></button>
  <button type="button" class="mtab" data-view="dropStats"><span class="mtab-icon">🎁</span><span class="mtab-label">掉落</span></button>
  <button type="button" class="mtab" data-view="marketData"><span class="mtab-icon">📈</span><span class="mtab-label">数据</span></button>
</nav>
```

- [ ] **Step 2: app.css 加移动端样式（文件末尾）**

```css
/* ============ 移动端底部 tab 栏（≤768px）============ */
.mobile-tabs { display: none; }

@media (max-width: 768px) {
  /* 底部固定 tab 栏 */
  .mobile-tabs {
    display: flex; position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
    background: var(--surface-1, #1a1d24); border-top: 1px solid var(--border, #2a2f3a);
    justify-content: space-around; padding: 4px 0 env(safe-area-inset-bottom, 4px);
  }
  .mobile-tabs .mtab {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
    background: none; border: 0; color: var(--text-dim, #8a8f99); font-size: 10px;
    padding: 6px 2px; min-height: 44px; cursor: pointer;
  }
  .mobile-tabs .mtab.active { color: var(--accent, #f5a623); }
  .mobile-tabs .mtab-icon { font-size: 18px; line-height: 1; }
  .mobile-tabs .mtab-label { font-size: 10px; }

  /* sidebar 折叠：移动端隐藏左侧面板（资料卡/预算/令牌/数据管理），用户通过顶部或抽屉访问
     —— 本期先隐藏，核心交互走 main + 底部 tab；profile/portrait 暂用桌面入口（可后续加抽屉） */
  .sidebar { display: none; }
  .layout { grid-template-columns: 1fr !important; }
  .main { padding-bottom: 64px; }   /* 给底部 tab 留空间 */
}
```
（注：sidebar 隐藏后，资料卡/预算/令牌/数据管理面板在移动端不可见。这是本期取舍——核心市场/交易/持有/掉落/数据 5 大 view 走底部 tab；portrait/令牌设置/预算等桌面端入口暂保留桌面。如需移动端访问，后续可加抽屉。）

- [ ] **Step 3: app.js 绑定 tab 点击 + active 同步**

在 app.js 初始化 IIFE（文件末尾的 `(function(){...})()` 内，renderAll 之后）加：
```js
  // 移动端底部 tab 栏：点击切 view + 同步 active
  document.querySelectorAll('.mobile-tabs .mtab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var v = btn.getAttribute('data-view');
      toggleView(v);
      // 切到非 market 的 view 时触发对应 LOAD_*（对齐桌面端 renderToolbar 行为）
      var loadType = { trades: 'LOAD_TRADES', orders: 'LOAD_ORDERS', inventory: 'LOAD_INVENTORY', dropStats: 'LOAD_DROP_STATS', marketData: 'LOAD_MARKET_DATA' }[v];
      if (loadType) send({ type: loadType });
    });
  });
```
并在 `toggleView`（345-355）末尾加 active 同步（找到 `toggleView` 函数，在其内 `renderLive()` 调用附近加）：
```js
  // 同步底部 tab active 态
  document.querySelectorAll('.mobile-tabs .mtab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-view') === view);
  });
```
（若 `toggleView` 内不便加，可在 `renderLive` 或 `renderToolbar` 末尾加——任选一处确保切 view 后 active 更新。）

- [ ] **Step 4: 验证（Playwright 移动视口）**

启动后端 `PORT=3941 node src/server.js &`，用 Playwright MCP：
- `browser_resize` 到 390×844（iPhone 视口）
- `browser_navigate` http://127.0.0.1:3941/
- `browser_snapshot` 确认底部 `.mobile-tabs` 可见、6 个 tab、sidebar 不可见
- 点 `持有` tab → 确认切到 inventory view（发出 LOAD_INVENTORY）

Expected：底部 tab 栏可见可点击，视图切换正常。kill 后端。

- [ ] **Step 5: Commit**

```bash
git -C /home/jaxo/workspace/mcard add mcard-server && git -C /home/jaxo/workspace/mcard commit -m "feat: 移动端底部 tab 栏 + 响应式 @media"
```

---

## Task 5: Playwright 端到端烟测

**Files:**
- 无新文件（手动/Playwright 验证脚本）

- [ ] **Step 1: 启动后端**

```bash
cd /home/jaxo/workspace/mcard/mcard-server && PORT=3942 node src/server.js &
sleep 1
```

- [ ] **Step 2: 用 Playwright MCP 验证核心流程**

`browser_navigate` http://127.0.0.1:3942/，然后验证：
1. **页面加载**：`browser_snapshot` 确认 topbar + 卡片网格区可见，无 JS 报错（`browser_console_messages` level=error 应无 `chrome is not defined` 之类）。
2. **令牌模态**：无 key 时应弹令牌设置模态（`#tokenModal`）。填一个假 key `test123` + 选 kp.m-team.cc → 保存。`browser_network_requests` filter `/api/config` 确认发出了 `POST /api/config {apiKey:'test123',...}`，后端返回 `{ok:false,reason:'invalid'}`（verifyApiKey 对假 key 返回 invalid），前端显示错误（`errInvalid`/`errVerify` 可见）。
3. **SSE 连接**：`browser_network_requests` 确认有 `/events` 的 EventSource 连接（pending/流式）。
4. **桌面视图切换**：`browser_resize` 到 1280×800，确认 sidebar 可见；点 `#buyHistoryBtn` → 确认发 `POST /api/collect {type:'trades'}`（Network 可见）。
5. **移动端 tab**：`browser_resize` 到 390×844，确认底部 `.mobile-tabs` 可见、sidebar 隐藏；点 `持有` tab → 发 `POST /api/collect {type:'inventory'}`。

（注：真实市场数据采集需有效 key，本烟测只验证前端↔后端契约 + UI 行为，不验证真实 M-Team 采集。）

- [ ] **Step 3: 收尾**

```bash
kill %1
```

- [ ] **Step 4: Commit（如有验证脚本或小修）**

```bash
git -C /home/jaxo/workspace/mcard add mcard-server && git -C /home/jaxo/workspace/mcard commit -m "test: Plan 2 端到端烟测通过" --allow-empty
```
（若烟测发现需小修，正常 commit 修改；若一切通过无改动，`--allow-empty` 标记里程碑。）

---

## Plan 2 完成标准

- [ ] `npm test` 全绿（后端 51 + dispatch 9 = 60）
- [ ] `public/` 前端由 Express 静态托管，浏览器打开 `/` 加载完整 dashboard
- [ ] `app.js` 无任何 `chrome.*` 残留；通信全部走 `fetch`（dispatch）+ `EventSource`（SSE）
- [ ] 移动端（≤768px）底部 tab 栏可切换 6 个 view
- [ ] Playwright 烟测：令牌模态、/api/config、SSE 连接、视图切换、移动 tab 全部正常

**后续**：Plan 3（PWA manifest/service worker + Dockerfile）。

---

## 自审（writing-plans self-review）

**1. Spec 覆盖**：spec 第 9 节（chrome.* 映射）由 T2/T3 全覆盖（15 type + onChanged + storage + tabs）；spec 第 11 节（移动端底部 tab + 响应式）由 T4 覆盖；spec 第 10 节（PWA manifest/sw）属 Plan 3。✅
**2. 占位符扫描**：所有改造有精确行号 + old→new 代码；dispatch 完整实现 + 测试。✅
**3. 一致性**：dispatch 映射与 Plan 1 api.js 端点逐一核对（/api/state、/api/collect、/api/trade、/api/config、/api/setconfig、/api/search、/api/orderbook）；send/dispatch 名跨任务一致。✅

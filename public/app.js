/*
 * app.js — 全屏面板逻辑（Web 前端，fetch + SSE 通信）
 *
 * 数据流：
 *   fetch /api/state (GET_STATE)       ← 后端
 *   EventSource /events (state 推送)   → 实时刷新（采集到新数据时）
 * 渲染策略：renderAll（含配置输入）仅在初始化/勾选集合变化时调用；
 *           renderLive（状态+卡片）在数据变化时调用，避免打断阈值输入。
 */
// RARITIES / RARITY_LABEL / MECH_TYPES / MECH_LABEL / isMechCard / mechTypeOf / parseMtTime / buildDetailUrl / computeUsable
// 均来自 shared.js（dashboard.html 在本脚本前加载 shared.js）
// title 等级（从低到高）：傳火 < 薪火 < 星火 < 殘焰 < 薪王
setI18nLang(window.__lang || detectLang()); // 字典已由 locales/*.js 注册；window.__lang 由 lang-bootstrap 设
if (localStorage.getItem('mcard.privacy') === 'on') document.body.classList.add('privacy-on'); // 隐私遮罩：尽早应用，避免 uid 先显后糊闪现
const TITLE_TIER = {
  '傳火': 'tt-1',
  '薪火': 'tt-2',
  '星火': 'tt-3',
  '殘焰': 'tt-4',
  '薪王': 'tt-5',
};
// 角色 1-9 → 中文简称 / 全称
const ROLE_MAP = {
  '1': '小卒', '2': '捕頭', '3': '知縣', '4': '通判', '5': '知州',
  '6': '府丞', '7': '府尹', '8': '總督', '9': '大臣',
};
const ROLE_FULL = {
  '1': '小卒／User', '2': '捕頭／Power User', '3': '知縣／Elite User', '4': '通判／Crazy User',
  '5': '知州／Insane User', '6': '府丞／Veteran User', '7': '府尹／Extreme User',
  '8': '總督／Ultimate User', '9': '大臣／mTorrent Master',
};
// 角色全称：英文版取 ROLE_FULL 的 ／ 后英文部分（User/Power User…），中文版原样（小卒／User）
function roleFullLabel(role) {
  const full = ROLE_FULL[role] || '';
  if (getI18nLang() === 'en' && full.indexOf('／') >= 0) return full.split('／')[1] || full;
  return full;
}
// 机制卡名 i18n（shared.js 的 MECH_LABEL 是中文，注入页用；dashboard 显示走 t()）
function mechLabel(type) { return t('mech.' + type) || MECH_LABEL[type] || type; }
// 机制卡类型 → 配色类（魔力符券=r-N / 置顶免费符=r-SR / VIP七日符=r-SSR；区别于机制卡通用紫 r-mech）
function mechColorClass(type) { return type === 'mana_voucher' ? 'r-N' : type === 'single_free' ? 'r-SR' : type === 'vip_7d' ? 'r-SSR' : 'r-mech'; }
// 来源配色：机制卡走 mechColorClass（稀有度色），掉落(real)/制造(forged) 用 inv-src-（与持有 dist-tag/chip 统一）
function provColorClass(p) { return p === 'real' ? 'inv-src-drop' : p === 'forged' ? 'inv-src-crafted' : mechColorClass(p); }
// label 存 i18n key（不预翻译），renderConfig 渲染时实时 t() 翻译。
// 否则顶层固化后，切语言虽会重建按钮（setLang→renderAll→renderConfig），读到的仍是旧语言文本 → stale。
const MODES = [
  { label: 'view.byCategory', value: 'group' },
  { label: 'view.byPrice', value: 'price' },
];
// 购买失败原因（与 background buyCard 返回的 reason key 对应；v0.2.5 购买改 buy 直连，detail/orderbook 链路的 reason 已移除）
// value 存 i18n key（不预翻译），showToast 时实时 t() 翻译，避免顶层固化导致切语言 stale（与 MODES 同模式）
const BUY_FAIL_REASON = {
  budget_not_set: 'err.budget_not_set',
  budget_insufficient: 'err.budget_insufficient',
  over_threshold: 'err.over_threshold',
  unfilled: 'err.unfilled',       // v0.2.5：buy 返回 open（卖单不存在/已提价），已自动撤单
  buy_failed: 'err.buy_failed',   // v0.2.5：buy/cancel 请求失败（网络/401/异常 status）
  error: 'err.error',
};
let state = null;

// ---------- 启动揭幕（开箱抽卡）：数据就绪(≥最短展示)/5s 超时/点击·键盘 任意触发冲屏揭幕 ----------
// 双档时间轴：平时 F5 压缩版（~1.3s）；登录成功跳转播完整仪式（login.html 种 sessionStorage 标记 → #splash.full，~2.8s）
var _splashT0 = Date.now();
var _splashDone = false;
var _splashMin = 1100;       // 最短展示：压缩版 1.1s（编排走完），full 版在 initSplash 里放宽到 2s
function dismissSplash() {
  if (_splashDone) return;
  _splashDone = true;
  var sp = $('splash');
  if (!sp) return;
  sp.classList.add('leave');
  setTimeout(function () { if (sp && sp.parentNode) sp.remove(); }, 950);  // leave 动画 0.6s + 遮罩淡出 0.15s delay，兜底移除
}
function splashReady() {  // 首屏数据就绪：展示满 _splashMin 再揭幕
  var wait = Math.max(0, _splashMin - (Date.now() - _splashT0));
  setTimeout(dismissSplash, wait);
}
(function initSplash() {
  var sp = $('splash');
  if (!sp) return;
  var full = false;
  try {
    if (sessionStorage.getItem('mcard.splash.full') === '1') {
      sessionStorage.removeItem('mcard.splash.full');
      sp.classList.add('full');
      _splashMin = 2000;
      full = true;
    }
  } catch (e) {}
  if (full) {
    setTimeout(dismissSplash, 5000);                     // 完整版：数据就绪+≥2s 揭幕（splashReady），5s 上限兜底
  } else {
    setTimeout(dismissSplash, 1300);                     // 平时：固定节奏揭幕，不等数据——首拉 state 大 JSON 时曾拖到 ~2.8s；界面在遮罩下渲染，揭开即见
  }
  sp.addEventListener('click', dismissSplash);           // 点击跳过（cursor:pointer 已提示）
  window.addEventListener('keydown', dismissSplash, { once: true });
})();
const PORTRAIT_SPAN_SINCE = '2026-07-01 00:00:00';  // 用户画像消费维度统计起点（固定 7/1，与掉落统计动态 since 无关）
let view = 'market'; // 卡片区视图：'market'(市场卡牌) | 'trades'(购买记录) | 'orders'(当前挂单)
let ordersSortDir = 'desc';  // 当前挂单排序：'desc'(最新在上) | 'asc'(最早在上)
let invSortDir = 'desc';     // 持有卡片排序
let tradesSortDir = 'desc';  // 交易记录排序
let apiKeyInvalidShown = false;  // 令牌失效弹窗会话级去重（避免每次 state 更新都弹；用户保存新 key 后重置）
let tradesFilter = { text: '', dateFrom: '', dateTo: '', exact: false, rarities: new Set(), mech: false, titles: new Set(), side: null }; // 交易记录搜索条件（前端临时；exact=精确等于，否则模糊包含；side=buy/sell 筛选）
let ordersFilter = { text: '', dateFrom: '', dateTo: '', exact: false, rarities: new Set(), mech: false, titles: new Set() }; // 挂单搜索条件（前端临时）
let inventoryFilter = { text: '', rarities: new Set(), mech: false, exact: false, titles: new Set(), source: new Set(), lock: false, showLocked: false }; // 持有卡片筛选（文本 + 稀有度/机制卡/称号/来源/交易锁多选；showLocked=显示手动锁定的卡，默认隐藏）

function send(msg) {
  const d = window.dispatch(msg);
  if (!d) return Promise.resolve(null);
  // 30s 超时：防请求无限挂起（此前无超时，后端卡住则前端永远等）。
  // 取 30s 而非更短——POST /api/collect 等待整轮采集完成才返回（翻页+randSleep 可能 10s+），短超时会误杀慢采集
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  return fetch(d.path, {
    method: d.method,
    headers: d.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: d.body !== undefined ? JSON.stringify(d.body) : undefined,
    signal: ctrl.signal,
  }).then((r) => r.json()).catch((e) => { console.warn('[mcard] send failed', msg.type, e); return null; })
    .finally(() => clearTimeout(timer));
}

// 是否已配置令牌（后端把 key 存在 state.config.apiKey，/api/state 脱敏成 '(set)'/''）
function hasApiKey(st) { return !!(st && st.config && st.config.apiKey); }

// ---------- DOM helpers（不使用 innerHTML） ----------
function el(tag, opts) {
  opts = opts || {};
  const e = document.createElement(tag);
  if (opts.cls) e.className = opts.cls;
  if (opts.text != null) e.textContent = opts.text;
  if (opts.attrs) for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
  return e;
}
function append(parent, ...kids) {
  for (const k of kids) {
    if (k == null) continue;
    parent.appendChild(typeof k === 'string' ? document.createTextNode(String(k)) : k);
  }
  return parent;
}
function $(id) { return document.getElementById(id); }

// patch 深合并（对象递归，数组/原始值直接覆盖）—— SSE 增量更新用，避免每次都拉全量 /api/state
function mergeObj(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b || {})) {
    const av = a[k], bv = b[k];
    out[k] = (av && bv && typeof av === 'object' && typeof bv === 'object' && !Array.isArray(av) && !Array.isArray(bv)) ? mergeObj(av, bv) : bv;
  }
  return out;
}
function applyPatch(patch) {
  if (!state) state = {};
  for (const k of Object.keys(patch || {})) {
    if (k === 'config') state.config = mergeObj(state.config || {}, patch.config || {});
    else state[k] = patch[k];
  }
}

// SSE：后端 state 变更推送。增量合并 patch → renderAll/renderLive（采集落盘即触发，不再拉全量 /api/state）。
const es = new EventSource('/events');
let esOpenedOnce = false;
es.addEventListener('open', () => {
  if (!esOpenedOnce) { esOpenedOnce = true; return; }  // 首次 open：init 已拉全量，跳过
  // 重连后校准：补回断线期间漏掉的 patch（罕见，仅连接中断恢复时触发一次）
  send({ type: 'GET_STATE' }).then((s) => { state = s; renderAll(); splashReady(); }).catch(() => { splashReady(); });
});
es.addEventListener('state', (e) => {
  let patch;
  try { patch = JSON.parse(e.data).patch || {}; } catch (err) { return; }
  applyPatch(patch);  // 增量合并推送的 patch，不再每次拉全量 /api/state（采集时十几条 → 0）
  const keys = Object.keys(patch);
  if (keys.indexOf('config') !== -1) renderAll();
  else renderLive(keys);
});

// ---------- 全量渲染（初始化 / 勾选集合变化） ----------
function renderAll() {
  lockedSet = new Set(((state && state.config && state.config.lockedCards) || []));  // 锁定状态从后端同步（跨设备）
  renderStatus();
  renderConfig();
  buildMarketTitleChips();
  renderSearchTags();
  renderLive();
  applyLabUrl();
}

// ---------- 状态区 ----------
function renderStatus() {
  if (!state) return;
  $('buyCount').textContent = (state.buyHistory && state.buyHistory.length) || 0;
  const oc = $('ordersCount'); if (oc) oc.textContent = ((state.ordersAll || []).filter((o) => o.status === 'open')).length;
  const _invAll = ((state.inventory || []).concat((state.mechInventory || []).filter((m) => !m.isUsed)));
  const _openSell = ((state.ordersAll || []).filter((o) => o.status === 'open' && o.side === 'sell')).length;
  const ic = $('inventoryCount'); if (ic) ic.textContent = _invAll.length + _openSell;
  const dsc = $('dropStatsCount');
  if (dsc) dsc.textContent = (state.dropStats && state.dropStats.summary && state.dropStats.summary.totalCards) || 0;
  const mdc = $('marketDataCount');
  if (mdc) mdc.textContent = (state.marketHistory && state.marketHistory.length) || 0;
  const cbc = $('cardBookCount'); if (cbc) cbc.textContent = cardBookFilmCount();
  // 令牌失效弹窗（一次性/会话内）：background 在 401 时把 stats.lastError='api_key_invalid'，
  // 此处检测到即弹令牌模态窗引导重输；用户保存成功后清 guard，避免重复弹。
  if (state.stats && state.stats.lastError === 'api_key_invalid' && !apiKeyInvalidShown) {
    apiKeyInvalidShown = true;
    openTokenModal();
  }
}

// ---------- 配置区（仅初始化 / 勾选变化时重建） ----------

function renderConfig() {
  const cfg = (state && state.config) || {};
  const sel = cfg.rarities || [];

  // 购买设置面板折叠开关（市场设置已迁入 main 区筛选条）
  const cPanel = $('configPanel');
  const cToggle = $('configToggle');
  if (cToggle) cToggle.onclick = () => cPanel && cPanel.classList.toggle('collapsed');

  // chips（div 承载点击：input 被隐藏，靠 chip 点击手动 toggle）
  const box = $('rarityBox');
  box.replaceChildren();
  const makeRarityChip = (r) => {
    const on = sel.indexOf(r) !== -1;
    const input = el('input', { attrs: { type: 'checkbox', 'data-r': r } });
    if (on) input.checked = true;
    const chip = el('div', { cls: 'chip r-' + r + (on ? ' on' : '') });
    append(chip, el('span', { cls: 'dot' }), input, el('span', { text: RARITY_LABEL[r] }));
    chip.addEventListener('click', () => { input.checked = !input.checked; onRarityChange(); });
    return chip;
  };
  // 一行平铺（UR/SSR/SR/R/N），由 .chips 自然 wrap
  RARITIES.forEach((r) => box.appendChild(makeRarityChip(r)));

  // 机制卡 chips（样式与稀有度统一，专属紫色，默认全关）
  const msel = cfg.mechTypes || [];
  const mechBoxEl = $('mechBox');
  if (mechBoxEl) {
    mechBoxEl.replaceChildren();
    for (const m of MECH_TYPES) {
      const on = msel.indexOf(m.type) !== -1;
      const input = el('input', { attrs: { type: 'checkbox', 'data-m': m.type, 'data-step': 'MECH' } });
      if (on) input.checked = true;
      const chip = el('div', { cls: 'chip ' + mechColorClass(m.type) + (on ? ' on' : '') });
      append(chip, el('span', { cls: 'dot' }), input, el('span', { text: mechLabel(m.type) }));
      chip.addEventListener('click', () => {
        input.checked = !input.checked;
        onMechChange();
      });
      mechBoxEl.appendChild(chip);
    }
  }

  // 阈值区分段：稀有度卡 / 机制卡（仅显示已勾选项）
  const limits = cfg.maxPriceByRarity || {};
  const mechLimits = cfg.maxPriceByMech || {};
  const tbox = $('thresholdBox');
  tbox.replaceChildren();
  const orderedSel = RARITIES.filter((r) => sel.indexOf(r) !== -1);
  const orderedMech = MECH_TYPES.filter((m) => msel.indexOf(m.type) !== -1);
  if (orderedSel.length) {
    tbox.appendChild(el('div', { cls: 'th-group-title', text: t('cfg.rarityCards') }));
    for (const r of orderedSel) tbox.appendChild(buildThresholdRow('r-' + r, RARITY_LABEL[r], limits[r]));
  }
  if (orderedMech.length) {
    tbox.appendChild(el('div', { cls: 'th-group-title', text: t('cfg.mech') }));
    for (const m of orderedMech) tbox.appendChild(buildThresholdRow(mechColorClass(m.type), mechLabel(m.type), mechLimits[m.type], m.type));
  }
  if (!orderedSel.length && !orderedMech.length) {
    tbox.appendChild(el('div', { cls: 'panel-hint', text: t('cfg.thresholdEmptyHint') }));
  }

  // 价格阈值面板：当前方案摘要 + 折叠开关（默认折叠，仅首次设置，之后保留用户展开状态）
  const tc = $('thresholdCurrent');
  if (tc) tc.textContent = detectCurrentPreset() || t('cfg.presetCustom');
  // 市场列表 pageSize（手动刷新用）
  const psBox = $('pageSizeBox');
  if (psBox) {
    psBox.replaceChildren();
    const curPs = cfg.listPageSize || 10;
    for (const v of [10, 20, 50, 100]) {
      const b = el('button', { cls: 'seg-btn mini' + (curPs === v ? ' on' : ''), text: String(v) });
      b.onclick = () => onPageSizePick(v);
      psBox.appendChild(b);
    }
  }
  // 显示模式
  const mbox = $('modeBox');
  if (mbox) {
    mbox.replaceChildren();
    const viewMode = cfg.viewMode || 'price';
    for (const m of MODES) {
      const on = viewMode === m.value;
      const b = el('button', { cls: 'seg-btn mini' + (on ? ' on' : ''), text: t(m.label) });
      b.onclick = () => onModePick(m.value);
      mbox.appendChild(b);
    }
  }

  // 阈值方案 + 价格阈值模态窗入口
  $('presetSave').onclick = onPresetSave;
  renderPresetList();
  const thToggle = $('thresholdToggle');
  if (thToggle) thToggle.onclick = openThresholdModal;
  const thClose = $('thresholdModalClose');
  if (thClose) thClose.onclick = closeThresholdModal;
  if (!renderConfig._thModalInited) {  // 点遮罩 / Esc 关闭（仅绑一次）
    renderConfig._thModalInited = true;
    const m = $('thresholdModal');
    if (m) m.addEventListener('click', (e) => { if (e.target === m) closeThresholdModal(); });
    document.addEventListener('keydown', (e) => { const mm = $('thresholdModal'); if (e.key === 'Escape' && mm && !mm.hidden) closeThresholdModal(); });
  }

  // 预算魔力池：总额输入框回显当前值（事件绑定见 initBudget，用实时 state 避免闭包旧值）
  const bt = $('budgetTotal');
  if (bt) {
    const cur = (cfg.budget && Number(cfg.budget.total)) || 0;
    bt.value = cur > 0 ? String(cur) : '';
  }

  // 数据管理：导出/导入/清空
  $('exportBtn').onclick = onExport;
  $('importBtn').onclick = onImport;
  const bhBtn = $('buyHistoryBtn');
  if (bhBtn) bhBtn.onclick = () => { toggleView('trades'); send({ type: 'LOAD_TRADES' }); };
  const oBtn = $('ordersBtn');
  if (oBtn) oBtn.onclick = () => { toggleView('orders'); send({ type: 'LOAD_ORDERS' }); };
  const invBtn = $('inventoryBtn');
  if (invBtn) invBtn.onclick = () => { toggleView('inventory'); send({ type: 'LOAD_INVENTORY' }); };
  const cbkBtn = $('cardBookBtn');
  if (cbkBtn) cbkBtn.onclick = () => { toggleView('cardBook'); send({ type: 'LOAD_INVENTORY' }); send({ type: 'LOAD_ORDERS' }); };
  const dsBtn = $('dropStatsBtn');
  if (dsBtn) dsBtn.onclick = () => { toggleView('dropStats'); send({ type: 'LOAD_DROP_STATS' }); };
  const mdBtn = $('marketDataBtn');
  if (mdBtn) mdBtn.onclick = () => { toggleView('marketData'); send({ type: 'LOAD_MARKET_DATA' }); };
  const psBtn = $('portraitBtn');
  if (psBtn) psBtn.onclick = () => { toggleView('portrait'); };
  const backBtn = $('backToMarketBtn');
  if (backBtn) backBtn.onclick = () => toggleView('market');
  // 市场工具行手动刷新：统一入口 triggerMarketRefresh（节流 + spin 同步）；无 key 时 toast 提示
  const rbtn = $('refreshBtn');
  if (rbtn) rbtn.onclick = () => {
    if (!state || !hasApiKey(state)) { showToast(t('token.unset'), 'info'); return; }
    triggerMarketRefresh();
  };
}

// ---------- live 部分：间隔标签 + 卡片 ----------
function renderLive(changedKeys) {
  if (!state) return;
  document.body.dataset.view = view;  // 同步当前视图到 body（供 CSS 按视图区分，如移动端隐藏价格单位）
  renderStatus();
  renderProfile();
  renderTokenPanel();
  // 仅在当前视图相关数据变化时重建该视图；changedKeys 为空（初始化/切视图/主动操作）则全重建。
  // 避免无关 storage 变化（如停留在掉落页时市场每轮刷新）触发柱状图/卡片整体重建而闪烁。
  const touched = (keys) => !changedKeys || keys.some((k) => changedKeys.indexOf(k) !== -1);
  if (view === 'trades') { if (touched(['buyHistory'])) renderTrades(); }
  else if (view === 'orders') { if (touched(['ordersAll', 'ordersTotal'])) renderOrders(); }
  else if (view === 'inventory') { if (touched(['inventory', 'mechInventory'])) renderInventory(); }
  else if (view === 'cardBook') { if (touched(['inventory', 'ordersAll'])) renderCardBook(); }
  else if (view === 'dropStats') { if (touched(['dropStats', 'cardLogs', 'cardLogSummary'])) renderDropStats(); }
  else if (view === 'marketData') { if (touched(['marketHistory'])) renderMarketData(); }
  else if (view === 'portrait') { if (touched(['profile'])) renderPortraitView(); }
  else { if (touched(['buckets', 'mechBucket'])) renderCards(); }
  renderToolbar();
}

// 工具栏随视图切换：购买记录视图显示「返回市场」、隐藏排序、高亮购买记录按钮
function renderToolbar() {
  const isTrades = view === 'trades';
  const isOrders = view === 'orders';
  const isInventory = view === 'inventory';
  const isCardBook = view === 'cardBook';
  const isDropStats = view === 'dropStats';
  const isPortrait = view === 'portrait';
  const isMarketData = view === 'marketData';
  const isSub = isTrades || isOrders || isInventory || isCardBook || isDropStats || isPortrait || isMarketData; // 子视图：显示返回、隐藏排序
  const back = $('backToMarketBtn');
  const modeBox = $('modeBox');
  const mf = $('marketFilter');
  if (back) back.style.display = isSub ? '' : 'none';
  if (modeBox) modeBox.style.display = isSub ? 'none' : '';
  const gt = $('gridToolbar');
  if (gt) gt.style.display = isSub ? 'none' : '';  // 按价格/按分类 仅市场 view 显示
  if (mf) mf.style.display = isSub ? 'none' : '';  // 市场筛选条仅市场 view 显示
  const bh = $('buyHistoryBtn');
  if (bh) bh.classList.toggle('active', isTrades);
  const ob = $('ordersBtn');
  if (ob) ob.classList.toggle('active', isOrders);
  const ib = $('inventoryBtn');
  if (ib) ib.classList.toggle('active', isInventory);
  const cbb = $('cardBookBtn');
  if (cbb) cbb.classList.toggle('active', isCardBook);
  const dsb = $('dropStatsBtn');
  if (dsb) dsb.classList.toggle('active', isDropStats);
  const mdb = $('marketDataBtn');
  if (mdb) mdb.classList.toggle('active', isMarketData);
  const psb = $('portraitBtn');
  if (psb) psb.classList.toggle('active', isPortrait);
  const ts = $('tradesSearch');
  if (ts) ts.style.display = isTrades ? '' : 'none';
  const tst = $('tradeStats');
  if (tst && !isTrades) tst.style.display = 'none';
  const ost = $('ordersStats');
  if (ost && !isOrders) ost.style.display = 'none';
  const os = $('ordersSearch');
  if (os) os.style.display = isOrders ? '' : 'none';
  const ist = $('inventoryStats');
  if (ist && !isInventory) ist.style.display = 'none';
  const isc = $('inventorySearch');
  if (isc) isc.style.display = isInventory ? '' : 'none';
  const cbv = $('cardBookView');
  if (cbv) cbv.style.display = isCardBook ? '' : 'none';
  const rs = $('resultSummary');
  if (rs) rs.style.visibility = isCardBook ? 'hidden' : '';  // 卡册不写结果摘要：visibility 保占位（display:none 会让 space-between 失衡、返回按钮跳到左侧）
  const dsv = $('dropStatsView');
  if (dsv) dsv.style.display = isDropStats ? '' : 'none';
  const pv = $('portraitView');
  if (pv) pv.style.display = isPortrait ? '' : 'none';
  const mdv = $('marketDataView');
  if (mdv) mdv.style.display = isMarketData ? '' : 'none';
  const tfb = $('titleFilterBox');
  if (tfb) tfb.style.display = isSub ? 'none' : '';  // 称号筛选仅市场 view 显示
  const grid = $('grid');
  if (grid) grid.style.display = (isDropStats || isPortrait || isMarketData || isCardBook) ? 'none' : ''; // 掉落/画像/市场数据/卡册视图隐藏卡牌网格
}
// ============ 我的卡册：持有+当前挂单 按影片聚合稀有度/称号（机制卡不计） ============
const CB_TITLE_WEIGHT = { '傳火': 1, '薪火': 2, '星火': 3, '殘焰': 4, '薪王': 5 }; // 排序加权：薪王>殘焰>星火>薪火>傳火
const CB_RARITY_WEIGHT = { UR: 30, SSR: 10, SR: 5, R: 3, N: 1 };  // 与掉落/画像 DROP_RARITY_WEIGHT（stats.js）同值——前端未加载 stats.js，写死同源
function computeCardBook() {
  const films = new Map();
  function add(c, listed) {
    if (!c || !c.filmId || c.provenance === 'mech') return;   // 机制卡不统计
    let f = films.get(c.filmId);
    if (!f) { f = { filmId: c.filmId, filmName: c.filmName || '', poster: c.poster || '', rarities: {}, titles: {} }; films.set(c.filmId, f); }
    const r = f.rarities[c.rarity] || (f.rarities[c.rarity] = {});        // { 稀有度: { 称号: {hold,listed} } }
    const tk = c.title || '';
    const b = r[tk] || (r[tk] = { hold: 0, listed: 0 });
    b[listed ? 'listed' : 'hold']++;
    if (tk) f.titles[tk] = true;                                          // 卡片级称号集合（加权排序每称号只计一次）
  }
  const invIds = new Set();
  (state.inventory || []).forEach((c) => { invIds.add(String(c.cardId || '')); add(c, false); });
  ((state.ordersAll) || []).filter((o) => o.status === 'open' && o.side === 'sell').forEach((o) => {
    if (invIds.has(String(o.cardId || ''))) return;                       // 与持有重复（理论不重叠，防重）
    add(o, true);
  });
  const arr = Array.from(films.values());
  for (const f of arr) {
    f.rarityCount = Object.keys(f.rarities).length;                                            // 集齐稀有度种数
    f.rarityScore = Object.keys(f.rarities).reduce((s, r) => s + (CB_RARITY_WEIGHT[r] || 0), 0);  // 档位质量：有该档则计一次权重（UR30>SSR10>SR5>R3>N1）
    f.titleScore = Object.keys(f.titles).reduce((s, tk) => s + (CB_TITLE_WEIGHT[tk] || 0), 0);  // 称号含金量：每称号计一次
  }
  // 排序：稀有度种数 ↓ → 稀有度加权和 ↓（种数同档时高档位优先）→ 称号加权分 ↓ → 片名
  arr.sort((a, b) => b.rarityCount - a.rarityCount || b.rarityScore - a.rarityScore || b.titleScore - a.titleScore || String(a.filmName).localeCompare(String(b.filmName)));
  return arr;
}

// 卡册称号固定列：从低到高（傳火→薪王），每称号下双格 = 左持有 右挂单
const CB_TITLES = ['傳火', '薪火', '星火', '殘焰', '薪王'];

// 卡册图片视口管理：滚出视口（rootMargin 外沿）即卸载 src——浏览器可回收解码位图（曾致「越滚内存越大」，上百张 poster 解码缓存不释放）；
// 进视口恢复加载。签名防重绘保证 DOM 稳定，observer 长期有效。
let _cbImgObs = null;
function cbImgObserver() {
  if (_cbImgObs) return _cbImgObs;
  _cbImgObs = new IntersectionObserver((ents) => {
    for (const e of ents) {
      const img = e.target;
      if (e.isIntersecting) {
        if (!img.getAttribute('src') && img.dataset.src) img.src = img.dataset.src;
      } else if (img.getAttribute('src')) {
        img.removeAttribute('src');   // 卸载解码位图；dataset.src 保留供回滚恢复
      }
    }
  }, { rootMargin: '300px 0px' });
  return _cbImgObs;
}

function buildCardBookCard(f, delay) {
  const card = el('div', { cls: 'cb-card' });
  card.style.animationDelay = delay + 'ms';
  // 左：poster（反色卡上的藏品图，同其它 view 规格）
  const pw = el('div', { cls: 'cb-poster' });
  const name = f.filmName || '?';
  const fb = el('div', { cls: 'poster-fallback', text: name.slice(0, 1) });
  fb.style.display = 'none';
  if (f.poster) {
    const img = el('img', { attrs: { alt: name, decoding: 'async' } });
    img.dataset.src = f.poster;           // src 由视口管理器按需加载/卸载（替代 loading=lazy）
    img.style.opacity = '0';
    img.style.transition = 'opacity .25s';
    img.onload = () => { img.style.opacity = '1'; };
    img.onerror = () => { img.remove(); fb.style.display = 'grid'; };
    cbImgObserver().observe(img);
    pw.appendChild(img);
  } else fb.style.display = 'grid';
  pw.appendChild(fb);
  // 卡片右上角：加入定向搜索（复用市场定向 tag：addSearchTag 去重+持久化+自动查询；不跳转 view）
  const sb = el('button', { cls: 'cb-search-btn', attrs: { type: 'button', title: t('cardBook.addSearch'), 'aria-label': t('cardBook.addSearch') } });
  const sbSvg = svgEl('svg', { attrs: { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' } });
  sbSvg.appendChild(svgEl('circle', { attrs: { cx: 7, cy: 7, r: 4.6, stroke: 'currentColor', 'stroke-width': 1.6 } }));
  sbSvg.appendChild(svgEl('path', { attrs: { d: 'M10.4 10.4L13.8 13.8', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' } }));
  sb.appendChild(sbSvg);
  sb.onclick = (e) => {
    e.stopPropagation();
    const cur = (state.config && state.config.searchTags) || [];
    if (cur.indexOf(name) !== -1) { showToast(t('cardBook.dupeSearch'), 'info'); return; }
    addSearchTag(name);
    showToast(t('cardBook.addedSearch', { name: name }), 'success');
  };
  // 右：片名（顶与 poster 齐）+ 5 行稀有度（均匀分布到 poster 底）；每行 = 双框稀有度徽章 + 5 称号×双格矩阵
  const right = el('div', { cls: 'cb-right' });
  right.appendChild(el('div', { cls: 'cb-name', attrs: { title: name }, text: name }));
  const rows = el('div', { cls: 'cb-rows' });
  for (const r of RARITIES) {
    const titles = f.rarities[r];
    const row = el('div', { cls: 'cb-row' + (titles ? '' : ' cb-empty') });  // cb-empty：勿用 empty（与全局空态 .empty 大 padding 冲突）
    row.appendChild(el('span', { cls: 'cb-r r-' + r, text: r }));
    const groups = el('div', { cls: 'cb-groups' });
    for (const tk of CB_TITLES) {
      const b = (titles && titles[tk]) || { hold: 0, listed: 0 };
      // 该稀有度下没有此称号 → 整组（名+双格）统一暗淡，与有量的组拉开层级，一眼看清有哪些
      const g = el('div', { cls: 'cb-tg' + ((b.hold || b.listed) ? '' : ' cb-none') });
      g.appendChild(el('div', { cls: 'cb-tn ' + (TITLE_TIER[tk] || 'tt-5'), text: tk }));
      const cells = el('div', { cls: 'cb-cells' });
      cells.appendChild(el('span', { cls: 'cb-cell hold' + (b.hold ? '' : ' zero'), text: String(b.hold) }));
      cells.appendChild(el('span', { cls: 'cb-cell sale' + (b.listed ? '' : ' zero'), text: String(b.listed) }));
      append(g, cells);
      groups.appendChild(g);
    }
    append(row, groups);
    rows.appendChild(row);
  }
  append(right, rows);
  append(card, pw, right, sb);
  return card;
}

// 侧栏计数用轻量影片数（不跑 computeCardBook 全量聚合——renderStatus 每次 renderLive 都执行）
function cardBookFilmCount() {
  const s = new Set();
  for (const c of (state.inventory || [])) if (c.filmId && c.provenance !== 'mech') s.add(c.filmId);
  for (const o of (state.ordersAll || [])) if (o.status === 'open' && o.side === 'sell' && o.filmId && o.provenance !== 'mech') s.add(o.filmId);
  return s.size;
}

let _cbRenderToken = 0;  // 渲染令牌：新渲染请求使旧分片任务作废（防过期批次与新渲染竞争写同一 grid）
function renderCardBook() {
  const box = $('cardBookView');
  if (!box) return;
  const arr = computeCardBook();
  // 数据签名：结构未变不重建（SSE 高频 patch 曾致 DOM/img 全量反复重建 → 解码内存峰值叠高、页面卡）。
  // sig 拼入当前语言：setLang→renderAll 时语言变化要穿透签名重建（图例等 t() 固化文案才能实时切换）
  const sig = getI18nLang() + '::' + arr.map((f) => f.filmId + ':' + RARITIES.filter((r) => f.rarities[r]).map((r) => r + Object.keys(f.rarities[r]).filter((tk) => tk).map((tk) => tk + f.rarities[r][tk].hold + '/' + f.rarities[r][tk].listed).join(',')).join(';')).join('|');
  if (box._sig === sig) return;
  box._sig = sig;
  _cbRenderToken++;
  const token = _cbRenderToken;
  box.replaceChildren();
  if (!arr.length) { box.appendChild(el('div', { cls: 'drop-empty', text: t('cardBook.empty') })); return; }
  // 图例：双格语义（左持有 右挂单）+ 称号由低到高
  const legend = el('div', { cls: 'cb-legend' });
  append(legend,
    el('span', { cls: 'cb-lg-cell hold', text: t('cardBook.hold') }),
    el('span', { cls: 'cb-lg-cell sale', text: t('cardBook.listed') }),
    el('span', { cls: 'cb-lg-note', text: t('cardBook.legendNote') }));
  box.appendChild(legend);
  const grid = el('div', { cls: 'cb-grid' });
  box.appendChild(grid);
  if (arr.length <= 40) {
    // 卡少：同步建（保留 stagger 入场动画）
    arr.forEach((f, i) => grid.appendChild(buildCardBookCard(f, Math.min(i, 20) * 25)));
    return;
  }
  // 卡多：rAF 分片渲染——上万节点单帧同步插入会卡死主线程几百 ms；每帧一批 + DocumentFragment 批量插，首帧即出首屏
  grid.classList.add('no-anim');
  const CHUNK = 24;
  let i = 0;
  (function fill() {
    if (token !== _cbRenderToken) return;  // 已有更新的渲染请求，本批次作废
    const frag = document.createDocumentFragment();
    for (let end = Math.min(i + CHUNK, arr.length); i < end; i++) frag.appendChild(buildCardBookCard(arr[i], 0));
    grid.appendChild(frag);
    if (i < arr.length) requestAnimationFrame(fill);
  })();
}

// 市场刷新统一入口：所有触发路径（按钮/切回市场/初始加载/保存 token/改 pageSize/批量买入后）都走这里。
// 8s 节流（连点只刷一次防滥用，与后端 market 冷却对齐）+ 刷新按钮 spin 同步（API 返回即停）——任何路径在刷，按钮都转，一目了然。
var _lastMarketRefreshAt = 0;
function triggerMarketRefresh(force) {
  if (!state || !hasApiKey(state)) return;
  var now = Date.now();
  if (!force && now - _lastMarketRefreshAt < 8000) return;   // 节流：冷却内静默忽略
  _lastMarketRefreshAt = now;
  var p = hasSearchTags() ? runSearch() : send({ type: 'REFRESH_NOW' });
  var rbtn = $('refreshBtn');
  if (rbtn) {
    rbtn.classList.add('refreshing');
    var stop = () => rbtn.classList.remove('refreshing');
    Promise.resolve(p).then(stop, stop);
  }
}

function toggleView(v) {
  view = v;
  document.body.dataset.view = v;  // 供 CSS 按视图区分（如移动端隐藏卡片价格单位）
  if (batchInView && batchInView !== v) clearBatchSelection(false);  // 切 view 清批量选择（renderLive 会重绘新 view）
  // 切视图失效签名缓存：market/trades/orders/inventory 复用同一 grid，非市场视图清子节点但不清 _sig；
  // 若不清，切回市场时 renderCards 会因 sig 未变 + grid 非空误判"无变化"而跳过重绘，残留上一视图卡片
  const grid = $('grid');
  if (grid) grid._sig = null;
  renderLive();
  // 回到市场视图时刷新：有定向 tag → runSearch；否则 → triggerRefreshRound（统一入口：节流+按钮 spin 同步）
  if (v === 'market') triggerMarketRefresh();
  // 移动端抽屉：切 view 后自动关闭
  var _sb = document.querySelector('.sidebar'); if (_sb) _sb.classList.remove('open');
  var _mk = $('drawerMask'); if (_mk) _mk.classList.remove('open');
}

// 聚合各数据源算画像（资料卡称号/氛围色 + 画像页复用）
function currentPortrait() {
  const p = state.profile || {}, bn = state.bonus || {};
  const ds = (state.dropStats && state.dropStats.summary) || {};
  const cl = state.cardLogSummary || {};   // count=0 时 computeCardLogSummary 返 null → 兜底 {}
  const tr = computeTradeStats(resolvedTrades());
  return computePortrait({
    bonus: p.bonus, finalBs: bn.finalBs,
    buySum: tr.buy.sum, sellSum: tr.sell.sum, buyCount: tr.buy.count, sellCount: tr.sell.count,
    spanDays: Math.max(1, Math.ceil((Date.now() - Date.parse(PORTRAIT_SPAN_SINCE)) / 86400000)), rarityScore: ds.rarityScore,
    cardCount: cl.count, cardAvg: cl.avg, cardMax: cl.max, cardMin: cl.min,
  });
}
// 称号里的博弈片段（开过符券才带，简称；未开卡→空字符串，向后兼容）
function portraitGambleNick(pt) {
  return pt.gambleKey && pt.gambleKey !== 'none' ? ' · ' + t('portrait.gambleNick.' + pt.gambleKey) : '';
}
// 角色称号（i18n 拼接）
function portraitNickOf(pt) {
  return t('portrait.nick', { mod: t('portrait.trendMod.' + pt.trend.key), tier: t('portrait.wealth.' + pt.wealth.key), luck: t('portrait.luck.' + pt.luckKey), gamble: portraitGambleNick(pt) });
}

// 个人资料卡（「我的」面板：身份头 + 魔力 hero + 数据行）
function renderProfile() {
  const box = $('profileCard');
  if (!box) return;
  // 眼睛挂资料卡面板（#myPanel）右上角，一次性（不随 profile 重渲染重复挂）
  var panel = $('myPanel');
  if (panel && !panel.querySelector('.pc-eye')) panel.appendChild(makeEyeBtn());
  const p = state.profile;
  box.replaceChildren();
  const _tradesRow = document.querySelector('.my-trades-row');
  if (!p) {
    // 无资料：隐藏 4 个数据按钮 + 预算条；不显示占位文案
    const bb = $('budgetBar'); if (bb) bb.style.display = 'none';
    if (_tradesRow) _tradesRow.style.display = 'none';
    return;
  }
  if (_tradesRow) _tradesRow.style.display = '';
  box.title = roleFullLabel(p.role) + (p.createdDate ? t('panel.profileRegisteredOn') + fmtDate(p.createdDate) : '');
  // 头部：用户名 + #id · 角色
  const head = el('div', { cls: 'pc-head' });
  append(head,
    el('div', { cls: 'pc-name', text: p.username || '?' }),
    el('div', { cls: 'pc-sub', text: '#' + (p.id || '-') + ' · ' + (getI18nLang() === 'en' ? roleFullLabel(p.role) : (ROLE_MAP[p.role] || p.role || '-')) })
  );
  // 魔力 hero（上下分隔线 + 渐变底，最醒目）
  const magic = el('div', { cls: 'pc-magic' });
  append(magic,
    el('div', { cls: 'pc-magic-label', text: t('common.magic') }),
    el('div', { cls: 'pc-magic-val', text: p.bonus || '0' })
  );
  const finalBs = Number(state.bonus && state.bonus.finalBs) || 0;
  if (finalBs > 0) magic.appendChild(el('div', { cls: 'pc-magic-rate', text: Math.round(finalBs) + '/hr', attrs: { title: t('portrait.finalBsTip') } }));
  // 数据行：上传 / 下载 / 比率（mono 紧凑横排）
  const stats = el('div', { cls: 'pc-stats' });
  append(stats,
    el('span', { text: '↑ ' + fmtBytes(p.uploaded) }),
    el('span', { text: '↓ ' + fmtBytes(p.downloaded) }),
    el('span', { text: t('panel.profileRatio') + fmtRate(p.shareRate) })
  );
  if (p.avatarUrl) {
    const avatar = el('img', { cls: 'pc-avatar', attrs: { alt: p.username || '', referrerpolicy: 'no-referrer' } });
    avatar.src = p.avatarUrl;
    avatar.onerror = () => avatar.remove(); // 防盗链/失效则移除，不留破图
    box.appendChild(avatar);
  }
  // 角色称号（头像/用户名/id/role 下方，点击进画像页；颜色跟随等级氛围色）
  const pt = currentPortrait();
  box.style.setProperty('--tier-color', pt.tierColor || 'var(--accent)');
  const nick = el('div', { cls: 'pc-nick', text: portraitNickOf(pt), attrs: { title: t('portrait.title') } });
  nick.onclick = () => toggleView('portrait');
  append(box, head, nick, magic, stats);
  renderBudgetBar(p);
}

// ============ 隐私遮罩（眼睛 toggle）：模糊资料卡身份 + 各 view uid ============
var EYE_SVGNS = 'http://www.w3.org/2000/svg';
function privacyOn() { return localStorage.getItem('mcard.privacy') === 'on'; }
function setPrivacy(on) {
  if (on) { localStorage.setItem('mcard.privacy', 'on'); document.body.classList.add('privacy-on'); }
  else { localStorage.removeItem('mcard.privacy'); document.body.classList.remove('privacy-on'); }
  document.querySelectorAll('.pc-eye').forEach(function (b) {
    b.classList.toggle('on', on);
    b.setAttribute('title', t('privacy.toggleTitle'));
    b.setAttribute('aria-label', t('privacy.toggleTitle'));
    b.replaceChildren(makeEyeIcon(on));
  });
}
// SVG 眼睛图标（Feather eye / eye-off path；DOM 构建，不 innerHTML——MV3 CSP）
function makeEyeIcon(closed) {
  var svg = document.createElementNS(EYE_SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (closed) {
    var p = document.createElementNS(EYE_SVGNS, 'path');
    p.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22');
    svg.appendChild(p);
  } else {
    var p1 = document.createElementNS(EYE_SVGNS, 'path');
    p1.setAttribute('d', 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');
    svg.appendChild(p1);
    var c = document.createElementNS(EYE_SVGNS, 'circle');
    c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '3');
    svg.appendChild(c);
  }
  return svg;
}
function makeEyeBtn() {
  var closed = privacyOn();
  var btn = el('button', { cls: 'pc-eye' + (closed ? ' on' : ''), attrs: { type: 'button', title: t('privacy.toggleTitle'), 'aria-label': t('privacy.toggleTitle'), 'data-i18n-title': 'privacy.toggleTitle', 'data-i18n-aria-label': 'privacy.toggleTitle' } });
  btn.appendChild(makeEyeIcon(closed));
  btn.onclick = function () { setPrivacy(!privacyOn()); };
  return btn;
}
// 预算魔力池进度条：渲染到两处——桌面顶栏 #budgetBar + 移动端市场工具行右侧 #budgetBarMobile
// （移动端顶栏版隐藏——300px 悬浮卡曾遮盖顶栏 brand/按钮；移动版显隐由 CSS 控制：≤944px × market view × 未设预算 .off）
function renderBudgetBar(p) {
  const bb = $('budgetBar');
  const bbM = $('budgetBarMobile');
  if (!bb) return;
  const bg = (state.config && state.config.budget) || {};
  const bTotal = Number(bg.total) || 0;
  if (bTotal <= 0) {
    bb.style.display = 'none'; bb.replaceChildren();
    if (bbM) { bbM.classList.add('off'); bbM.replaceChildren(); }
    return;
  }
  const spent = Number(bg.spent) || 0;
  const remaining = bTotal - spent;
  const bonus = Number(p && p.bonus) || 0;
  const usable = Math.min(remaining, bonus);  // 实际可用 = min(预算剩余, 账户余额)
  const acShort = bonus < remaining;          // 账户余额不足以覆盖预算剩余
  // 占比按"实际可用"算：is-short 时账户余额拖低占比，颜色自动降级
  const pct = Math.max(0, Math.min(100, Math.round((usable / bTotal) * 100)));
  const pctCls = pct >= 60 ? ' pct-high' : pct >= 20 ? ' pct-mid' : ' pct-low';
  bb.style.display = '';
  bb.replaceChildren();
  const card = el('div', { cls: 'pc-budget' + pctCls });
  append(card,
    el('span', { cls: 'pc-budget-label', text: t('budget.poolLabel') }),
    el('span', { cls: 'pc-budget-val', text: t('budget.usableOf', { usable: fmtNum(usable), total: fmtNum(bTotal) }) })
  );
  const bar = el('div', { cls: 'pc-budget-bar' });
  const fill = el('div', { cls: 'pc-budget-fill' });
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  append(card, bar);
  if (acShort) append(card, el('div', { cls: 'pc-budget-warn', text: t('budget.balanceLowWarn', { bonus: fmtNum(bonus) }) }));
  bb.appendChild(card);
  if (bbM) {  // 移动版同步一份：数字换 K/M/B 紧凑格式（窄空间防溢出）
    const mc = card.cloneNode(true);
    const mv = mc.querySelector('.pc-budget-val');
    if (mv) mv.textContent = t('budget.usableOf', { usable: fmtCompact(usable), total: fmtCompact(bTotal) });
    bbM.classList.remove('off');
    bbM.replaceChildren(mc);
  }
}

// ---------- 卡片网格 ----------
// 反查当前阈值/勾选是否精确匹配某个已保存方案：匹配返回方案名，否则 null（自定义）
function detectCurrentPreset() {
  const presets = (state && state.config && state.config.presets) || [];
  if (!presets.length) return null;
  const curLimits = (state.config && state.config.maxPriceByRarity) || {};
  const curMechLimits = (state.config && state.config.maxPriceByMech) || {};
  const curRarities = ((state.config && state.config.rarities) || RARITIES).slice().sort().join(',');
  const curMech = ((state.config && state.config.mechTypes) || []).slice().sort().join(',');
  for (const p of presets) {
    const pr = (p.rarities && p.rarities.length ? p.rarities : RARITIES).slice().sort().join(',');
    if (pr !== curRarities) continue;
    const pm = (p.mechTypes || []).slice().sort().join(',');
    if (pm !== curMech) continue;
    let ok = true;
    for (const r of RARITIES) {
      if ((Number(curLimits[r]) || 0) !== (Number(p.values && p.values[r]) || 0)) { ok = false; break; }
    }
    if (ok) for (const m of MECH_TYPES) {
      if ((Number(curMechLimits[m.type]) || 0) !== (Number(p.mechValues && p.mechValues[m.type]) || 0)) { ok = false; break; }
    }
    if (ok) return p.name;
  }
  return null;
}

function renderCards() {
  const grid = $('grid');
  const hasTags = ((state.config && state.config.searchTags) || []).length > 0;
  if (hasTags && searching) {   // 定向搜索串行中：显示 loading（绕过 _sig，结果回来时重绘）
    grid._sig = null;
    grid.replaceChildren();
    grid.appendChild(el('div', { cls: 'empty' }, el('div', { cls: 'search-loading', text: t('search.loading') })));
    return;
  }
  const buckets = (state && state.buckets) || {};
  const limits = (state.config && state.config.maxPriceByRarity) || {};
  const mechLimits = (state.config && state.config.maxPriceByMech) || {};
  const mechSel = new Set((state.config && state.config.mechTypes) || []);
  // 仅显示当前勾选的稀有度（按标准顺序），缓存仍保留以便重新勾选时立即可见
  const activeSet = new Set((state.config && state.config.rarities) || RARITIES);
  const orderedActive = RARITIES.filter((r) => activeSet.has(r));
  // 用户当前挂单（open sell）卖价 key：filmId|rarity|provenance|price —— 市场卡同款同价=自己的挂单（最低价就是自己在卖），购买按钮灰显
  const myAsks = new Set((((state && state.ordersAll) || []).filter((o) => o.status === 'open' && o.side === 'sell')).map((o) => [o.filmId, o.rarity, o.provenance, Number(o.price)].join('|')));

  // 数据源 + 过滤分叉：有定向 tag → searchResults 全部显示（不过稀有度/机制卡/称号/价格阈值）；否则 → buckets + 阈值/称号过滤
  let all = [];
  let shown;
  if (hasTags) {
    all = (searchResults || []).slice();   // 定向搜索：全部结果，不做任何筛选
    shown = all;
  } else {
    // 合并（勾选的稀有度桶 + 勾选的机制卡）
    for (const r of orderedActive) {
      const b = buckets[r];
      if (b && b.items) all = all.concat(b.items);
    }
    const mb = state.mechBucket;
    if (mb && mb.items) {
      for (const it of mb.items) {
        if (mechSel.has(mechTypeOf(it))) all.push(it);
      }
    }
    // 按阈值过滤：机制卡按 type+maxPriceByMech，普通卡按 rarity+maxPriceByRarity
    shown = all.filter((it) => {
      if (it.lowestAsk == null) return false; // 无卖单不显示（机制卡 mechanism/list 返回全部、无卖单时 lowestAsk=null；普通卡 market/list 通常都有 ask）
      if (isMechCard(it)) {
        if (!mechSel.has(mechTypeOf(it))) return false; // 未勾选的机制卡子类型不显示
        const limit = Number(mechLimits[mechTypeOf(it)]) || 0;
        if (limit <= 0) return true;
        const ask = it.lowestAsk == null ? NaN : Number(it.lowestAsk);
        return Number.isFinite(ask) && ask <= limit;
      }
      const r = (it.variant && it.variant.rarity) || '';
      const limit = Number(limits[r]) || 0;
      if (limit <= 0) return true;
      const ask = it.lowestAsk == null ? NaN : Number(it.lowestAsk);
      return Number.isFinite(ask) && ask <= limit;
    });
    if (marketTitleFilter.size > 0) shown = shown.filter((it) => marketTitleFilter.has(it.title));
  }

  // 内容签名：仅当影响渲染的输入（卡片内容 + 配置 + 语言）实质变化时才重建网格，
  // 避免 buckets.time 等无关字段每轮变化触发整网重建、hover 闪烁。shown 是过滤后的卡片（不含 buckets.time），故市场数据未变即跳过。
  const sig = ((state.config && state.config.viewMode) || 'price') + '|' +
    ((state.config && state.config.rarities) || []).join(',') + '|' +
    ((state.config && state.config.mechTypes) || []).join(',') + '|' +
    JSON.stringify((state.config && state.config.maxPriceByRarity) || {}) + '|' +
    JSON.stringify((state.config && state.config.maxPriceByMech) || {}) + '|' +
    getI18nLang() + '|' + JSON.stringify(shown);
  if (grid._sig && grid._sig === sig && grid.children.length > 0) return;
  grid._sig = sig;
  // 已有卡片=数据刷新=不重播 rise 动画（避免闪烁）；空=首次/切视图=保留入场动画
  grid.classList.toggle('no-anim', grid.children.length > 0);

  // 汇总
  const limitsActive = orderedActive.some((r) => (Number(limits[r]) || 0) > 0) ||
    MECH_TYPES.some((m) => mechSel.has(m.type) && (Number(mechLimits[m.type]) || 0) > 0);
  const presetName = detectCurrentPreset();
  if (hasTags) {
    $('resultSummary').replaceChildren(
      el('span', { text: t('search.directed') + ' · ' }),
      el('b', { text: String(shown.length) }),
      el('span', { text: t('card.summarySuffix') })
    );
  } else {
    $('resultSummary').replaceChildren(
      el('span', { text: t('card.currentSchemePrefix') }),
      el('b', { cls: 'scheme-name', text: presetName || t('cfg.presetCustom') }),
      el('span', { text: t('card.summaryTotalPrefix') }),
      el('b', { text: String(shown.length) }),
      el('span', { text: t('card.summarySuffix') + (limitsActive ? t('card.summaryFiltered') : t('card.summaryNoThreshold')) })
    );
  }

  grid.replaceChildren();
  if (!shown.length) {
    const empty = el('div', { cls: 'empty' });
    append(empty,
      el('div', { cls: 'big', text: all.length ? t('card.emptyFiltered') : t('card.emptyNoData') }),
      el('div', { cls: 'small', text: all.length ? t('card.emptyFilteredHint') : t('card.emptyNoDataHint') }));
    grid.appendChild(empty);
    return;
  }

  const viewMode = (state.config && state.config.viewMode) || 'price';
  if (viewMode === 'price') {
    // 按价格升序，不分稀有度
    const sorted = shown.slice().sort((a, b) =>
      (a.lowestAsk == null ? Infinity : Number(a.lowestAsk)) - (b.lowestAsk == null ? Infinity : Number(b.lowestAsk)));
    const list = sorted.slice(0, 300);
    list.forEach((it, i) => grid.appendChild(buildCard(it, Math.min(i, 40) * 30, myAsks)));
    if (sorted.length > list.length) {
      grid.appendChild(el('div', { cls: 'group-more', text: t('card.priceTruncate', { shown: list.length, total: sorted.length }) }));
    }
  } else {
    // 按分类分组：机制卡组（置顶）+ 稀有度组
    const groups = {};
    for (const r of orderedActive) groups[r] = [];
    for (const it of shown) {
      if (isMechCard(it)) {
        (groups['MECH'] = groups['MECH'] || []).push(it);
      } else {
        const r = (it.variant && it.variant.rarity) || 'N';
        if (!groups[r]) groups[r] = [];
        groups[r].push(it);
      }
    }
    const order = orderedActive.slice();
    if (groups['MECH'] && groups['MECH'].length) order.unshift('MECH'); // 机制卡组置顶（UR 之上）
    let cardIndex = 0;
    for (const r of order) {
      const list = groups[r];
      if (!list || !list.length) continue;
      list.sort((a, b) => (a.lowestAsk == null ? Infinity : Number(a.lowestAsk)) - (b.lowestAsk == null ? Infinity : Number(b.lowestAsk)));
      grid.appendChild(groupHeader(r, list.length));
      const slice = list.slice(0, 100);
      slice.forEach((it) => { grid.appendChild(buildCard(it, Math.min(cardIndex, 40) * 30, myAsks)); cardIndex++; });
      if (list.length > slice.length) {
        grid.appendChild(el('div', { cls: 'group-more', text: t('card.groupTruncate', { n: (list.length - slice.length) }) }));
      }
    }
  }
}

function groupHeader(r, count) {
  const isMech = r === 'MECH';
  const h = el('div', { cls: 'group-header' });
  append(h,
    el('span', { cls: 'gh-dot ' + (isMech ? 'r-mech' : 'r-' + r) }),
    el('span', { cls: 'gh-label', text: isMech ? t('card.groupMech') : (RARITY_LABEL[r] || r) }),
    el('span', { cls: 'gh-count', text: count + t('card.countUnit') }));
  return h;
}

function buildCard(it, delay, myAsks) {
  const isMech = isMechCard(it);
  const rarity = (it.variant && it.variant.rarity) || '';
  const url = buildDetailUrl(it, (state.config && state.config.webBase) || 'kp.m-team.cc');
  const price = it.lowestAsk == null ? null : Number(it.lowestAsk);
  const name = cardName(it);

  const card = el('div', { cls: 'card batch-mode' });
  card.style.animationDelay = delay + 'ms';
  // 批量选择：勾选框 + 点卡片 toggle（与持有/挂单统一）；openBtn/buyBtn 已 stopPropagation 不受影响
  const chk = el('div', { cls: 'batch-check' });
  card.appendChild(chk);
  card.onclick = () => onBatchCardClick(it, card, 'market');

  // poster
  const wrap = el('div', { cls: 'poster-wrap' });
  const fallback = el('div', { cls: 'poster-fallback', text: (name || '?').slice(0, 1) });
  fallback.style.display = 'none';
  if (it.poster) {
    const img = el('img', { cls: 'poster', attrs: { alt: name, loading: 'lazy' } });
    img.onerror = () => { img.remove(); fallback.style.display = 'grid'; };
    img.src = it.poster;
    wrap.appendChild(img);
  } else {
    fallback.style.display = 'grid';
  }
  wrap.appendChild(fallback);
  // 左上：稀有度/机制卡 badge（实色显眼）
  const badgeCls = isMech ? 'rarity-badge r-mech' : 'rarity-badge r-' + (rarity || 'N');
  const badgeText = isMech ? t('card.badgeMech') : (RARITY_LABEL[rarity] || rarity || '?');
  wrap.appendChild(el('div', { cls: badgeCls, text: badgeText }));
  // 右上：跳转按钮（新标签打开详情）
  const openBtn = el('button', { cls: 'ca-open', attrs: { title: t('card.openInNewTab') }, text: '↗' });
  openBtn.onclick = (e) => { e.stopPropagation(); window.open(url, '_blank'); };
  wrap.appendChild(openBtn);
  // 右下：title（药丸，按等级配色；机制卡不显示——固定傳火无信息量）
  if (it.title && !isMech) {
    const tier = TITLE_TIER[it.title] || 'tt-5';
    wrap.appendChild(el('div', { cls: 'title-tag ' + tier, text: it.title }));
  }

  // body
  const body = el('div', { cls: 'card-body' });
  append(body, el('div', { cls: 'film-name', text: name }));

  // 价格行：左价格，右购买按钮
  const priceRow = el('div', { cls: 'price-row' });
  const priceEl = el('div', { cls: 'price', attrs: price != null ? { title: fmtNum(price) } : {} });
  if (price != null) append(priceEl, document.createTextNode(fmtPrice(price)), el('span', { cls: 'unit', text: t('common.magic') }));
  else priceEl.appendChild(el('span', { cls: 'unit', text: '—' }));
  const buyBtn = el('button', { cls: 'ca-btn buy', attrs: { title: t('card.buyBtnTitle') }, text: t('card.buyBtn') });
  // 同款（filmId+rarity+provenance）同价 = 用户自己的挂单（最低价就是自己在卖）→ 灰显，避免自买
  if (myAsks && price != null && it.variant && myAsks.has([it.variant.filmId, rarity, it.variant.provenance, price].join('|'))) {
    buyBtn.disabled = true;
    buyBtn.classList.add('own-listing');
    buyBtn.title = t('card.ownListing');
    card.dataset.ownListing = '1';   // 标记自挂单：批量选择据此禁选（onBatchCardClick 拦截 + 隐藏勾选框）
  }
  buyBtn.onclick = (e) => { e.stopPropagation(); if (!buyBtn.disabled) onBuy(it); };
  append(priceRow, priceEl, buyBtn);
  body.appendChild(priceRow);

  append(card, wrap, body);
  return card;
}

// 交易记录方向(side)以显示时的 profile.id 实时重判：入库(background mergeTrades)那一刻 profile
// 可能尚未就绪，会把卖出(sellerId=我)误写成 buy 且不再重算；这里在渲染/统计前按当前 profile.id
// 重算 side，前端各入口(renderTrades/renderTradeStats/画像)统一据此判定。profile.id 未就绪时退回
// 原列表（不强行改写，避免把全部误判成 buy）。
function resolvedTrades() {
  const all = (state && state.buyHistory) || [];
  const pid = state && state.profile && state.profile.id;
  if (pid == null || pid === '') return all;
  const myId = String(pid);
  return all.map(function (it) {
    const side = (it.sellerId != null && String(it.sellerId) === myId) ? 'sell' : 'buy';
    return it.side === side ? it : Object.assign({}, it, { side: side });
  });
}

// 购买记录视图：渲染历史成交卡（复用 card 外观，价格行换成卖家+时间）
function renderTrades() {
  buildTradesChips();
  renderTradeStats();
  const grid = $('grid');
  grid.classList.toggle('no-anim', grid.children.length > 0);
  const all = resolvedTrades();
  const list = filterMyTrades(all);
  const tdir = tradesSortDir === 'desc' ? -1 : 1;
  list.sort((a, b) => tdir * ((parseMtTime(a.tradedAt) || 0) - (parseMtTime(b.tradedAt) || 0)));
  const filtered = list.length !== all.length;
  let buySum = 0, sellSum = 0, buyCnt = 0, sellCnt = 0;
  for (const it of list) {
    const p = Number(it.price) || 0;
    if (it.side === 'sell') { sellSum += netOf(p); sellCnt++; } else { buySum += p; buyCnt++; }
  }
  const buyAvg = buyCnt ? buySum / buyCnt : 0, sellAvg = sellCnt ? sellSum / sellCnt : 0;
  $('resultSummary').replaceChildren(
    el('span', { text: t('trade.summaryPrefix') }),
    el('b', { text: String(list.length) }),
    el('span', { text: filtered ? t('trade.summaryFilteredSuffix', { n: all.length }) : t('trade.summarySuffix', { n: list.length }) }),
    el('span', { cls: 'rs-buy', text: buyCnt ? t('trade.buyWithAvg', { total: fmtK(buySum), avg: fmtK(buyAvg) }) : t('trade.buyTotal', { total: fmtK(buySum) }) }),
    el('span', { cls: 'rs-sell', text: sellCnt ? t('trade.sellWithAvg', { total: fmtK(sellSum), avg: fmtK(sellAvg) }) : t('trade.sellTotal', { total: fmtK(sellSum) }) })
  );
  const sortBtn = $('tradesSortBtn');
  if (sortBtn) {
    sortBtn.textContent = tradesSortDir === 'desc' ? t('card.sortNewest') : t('card.sortOldest');
    sortBtn.onclick = () => { tradesSortDir = tradesSortDir === 'desc' ? 'asc' : 'desc'; renderTrades(); };
  }
  grid.replaceChildren();
  if (!list.length) {
    const empty = el('div', { cls: 'empty' });
    append(empty,
      el('div', { cls: 'big', text: all.length ? t('trade.emptyFiltered') : t('trade.emptyNoData') }),
      el('div', { cls: 'small', text: all.length ? t('trade.emptyFilteredHint') : t('trade.emptyNoDataHint') }));
    grid.appendChild(empty);
    return;
  }
  list.forEach((it, i) => grid.appendChild(buildTradeCard(it, Math.min(i, 40) * 25)));
}

// 挂单汇总：存活/在挂魔值/历史总数/成交/取消/重挂（从 ordersAll 实时统计）
function renderOrdersStats() {
  const box = $('ordersStats');
  if (!box) return;
  const all = (state && state.ordersAll) || [];
  const total = (state && state.ordersTotal) || all.length;
  const open = all.filter((o) => o.status === 'open');
  const filled = all.filter((o) => o.status === 'filled').length;
  const cancelled = all.filter((o) => o.status === 'cancelled').length;
  const cardIds = new Set(all.map((o) => o.cardId).filter(Boolean));
  const relist = Math.max(0, all.length - cardIds.size); // 重挂次数 = 总记录 - 独立卡数
  const openMagic = open.reduce((s, o) => s + (Number(o.price) || 0), 0);
  // 存活挂单的稀有度/mech 分布
  const rarityDist = {};
  let openMech = 0;
  open.forEach((o) => {
    if (isMechCard(o)) openMech++;
    else if (o.rarity) rarityDist[o.rarity] = (rarityDist[o.rarity] || 0) + 1;
  });
  const distTags = document.createDocumentFragment();
  let hasDist = false;
  RARITIES.forEach((r) => {
    if (rarityDist[r]) { distTags.appendChild(el('span', { cls: 'dist-tag r-' + r, text: r + '×' + rarityDist[r] })); hasDist = true; }
  });
  if (openMech) { distTags.appendChild(el('span', { cls: 'dist-tag r-mech', text: t('dist.mechPrefix', { n: openMech }) })); hasDist = true; }
  box.style.display = '';
  box.replaceChildren();
  append(box, statGroup('money', '🛒', t('order.statGroupOpen'),
    metric(t('order.metricOpenCount'), numVal(open.length, t('common.unitCards')), null, 'metric-vcenter'),
    metric(t('order.metricOpenTotal'), numVal(fmtNum(openMagic), t('common.magic')), null, 'metric-vcenter'),
    metric(t('order.metricOpenRarity'), hasDist ? distTags : '—', null, 'metric-wide metric-dist')
  ));
  append(box, statGroup('time', '📜', t('order.statGroupHistory'),
    metric(t('order.metricHistoryTotal'), numVal(total, t('common.unitTimes'))),
    metric(t('order.metricFilled'), numVal(filled, t('common.unitTimes'))),
    metric(t('order.metricCancelled'), numVal(cancelled, t('common.unitTimes'))),
    metric(t('order.metricRelist'), numVal(relist, t('common.unitTimes')))
  ));
}

// 当前挂单视图：渲染存活挂单(status=open)卡
function renderOrders() {
  buildOrdersChips();
  renderOrdersStats();
  const grid = $('grid');
  grid.classList.toggle('no-anim', grid.children.length > 0);
  const all = ((state && state.ordersAll) || []).filter((o) => o.status === 'open');
  const list = filterOrders(all);
  const odir = ordersSortDir === 'desc' ? -1 : 1;
  list.sort((a, b) => odir * ((parseMtTime(a.lastModifiedDate) || 0) - (parseMtTime(b.lastModifiedDate) || 0)));
  const filtered = list.length !== all.length;
  const sortBtn = $('ordersSortBtn');
  if (sortBtn) {
    sortBtn.textContent = ordersSortDir === 'desc' ? t('card.sortNewest') : t('card.sortOldest');
    sortBtn.onclick = () => { ordersSortDir = ordersSortDir === 'desc' ? 'asc' : 'desc'; renderOrders(); };
  }
  $('resultSummary').replaceChildren(
    el('span', { text: t('order.summaryPrefix') }),
    el('b', { text: String(list.length) }),
    el('span', { text: filtered ? t('order.summaryFilteredSuffix', { n: all.length }) : t('order.summarySuffix', { n: list.length }) })
  );
  grid.replaceChildren();
  if (!list.length) {
    const empty = el('div', { cls: 'empty' });
    append(empty,
      el('div', { cls: 'big', text: all.length ? t('order.emptyFiltered') : t('order.emptyNoData') }),
      el('div', { cls: 'small', text: all.length ? t('order.emptyFilteredHint') : t('order.emptyNoDataHint') }));
    grid.appendChild(empty);
    return;
  }
  list.forEach((it, i) => grid.appendChild(buildOrderCard(it, Math.min(i, 40) * 25)));
}


// 交易统计：基于全部记录计算总览指标（不随搜索筛选变化）
function computeTradeStats(list) {
  const stats = {
    spanDays: null, firstAt: '', lastAt: '',
    buy: { count: 0, sum: 0, avg: 0 }, sell: { count: 0, sum: 0, avg: 0 },
    net: 0,
    distinctKinds: 0, mechCount: 0, rarityDist: {}, topBuy: null, topSell: null,
    soldTo: 0, boughtFrom: 0, topCounter: null,
    maxDaySpend: null, maxDaySpendDate: '',
  };
  if (!Array.isArray(list) || !list.length) return stats;
  const kinds = new Set();
  const buyers = new Set();    // 我卖出的对手(买家)集合
  const sellers = new Set();   // 我买入的对手(卖家)集合
  const freq = {};             // 对手id -> { count, buy, sell }
  const dayBuy = {};           // 日期(YYYY-MM-DD) -> 当日买入支出合计
  let minT = Infinity, maxT = -Infinity, firstRaw = '', lastRaw = '';
  for (const it of list) {
    const isSell = it.side === 'sell';
    const side = isSell ? stats.sell : stats.buy;
    side.count++;
    const p = Number(it.price);
    if (Number.isFinite(p)) {
      const v = isSell ? netOf(p) : p;            // 卖出按扣税后净收入计入（与卡片显示一致）
      side.sum += v;
      if (isSell) { if (stats.topSell == null || v > stats.topSell) stats.topSell = v; }
      else {
        if (stats.topBuy == null || p > stats.topBuy) stats.topBuy = p;
        const day = (it.tradedAt || '').split(' ')[0];
        if (day) dayBuy[day] = (dayBuy[day] || 0) + p;
      }
    }
    if (it.filmId) kinds.add(it.filmId);
    const isMech = isMechCard(it);
    if (isMech) stats.mechCount++;
    else if (it.rarity) stats.rarityDist[it.rarity] = (stats.rarityDist[it.rarity] || 0) + 1;
    if (isSell) { if (it.buyerId) buyers.add(it.buyerId); }
    else { if (it.sellerId) sellers.add(it.sellerId); }
    const cid = isSell ? (it.buyerId || '') : (it.sellerId || '');
    if (cid) {
      const c = freq[cid] || (freq[cid] = { count: 0, buy: 0, sell: 0 });
      c.count++; if (isSell) c.sell++; else c.buy++;
    }
    const t = parseMtTime(it.tradedAt);
    if (Number.isFinite(t)) {
      if (t < minT) { minT = t; firstRaw = it.tradedAt; }
      if (t > maxT) { maxT = t; lastRaw = it.tradedAt; }
    }
  }
  stats.distinctKinds = kinds.size;
  stats.soldTo = buyers.size;
  stats.boughtFrom = sellers.size;
  stats.buy.avg = stats.buy.count ? stats.buy.sum / stats.buy.count : 0;
  stats.sell.avg = stats.sell.count ? stats.sell.sum / stats.sell.count : 0;
  stats.net = stats.buy.sum - stats.sell.sum;
  let maxDaySpend = null, maxDaySpendDate = '';
  for (const d in dayBuy) { if (maxDaySpend == null || dayBuy[d] > maxDaySpend) { maxDaySpend = dayBuy[d]; maxDaySpendDate = d; } }
  stats.maxDaySpend = maxDaySpend;
  stats.maxDaySpendDate = maxDaySpendDate;
  if (Number.isFinite(minT) && Number.isFinite(maxT)) {
    stats.spanDays = Math.floor((maxT - minT) / 86400000);
    stats.firstAt = fmtDate(firstRaw);
    stats.lastAt = fmtDate(lastRaw);
  }
  let best = null;
  for (const id in freq) {
    if (!best || freq[id].count > best.count) {
      best = { id, count: freq[id].count, side: freq[id].sell >= freq[id].buy ? 'sell' : 'buy' };
    }
  }
  stats.topCounter = best;
  return stats;
}

function renderTradeStats() {
  const box = $('tradeStats');
  if (!box) return;
  const all = resolvedTrades();
  if (!all.length) { box.style.display = 'none'; box.replaceChildren(); return; }
  const s = computeTradeStats(all);
  box.style.display = '';
  box.replaceChildren();

  // 组1 时间跨度
  append(box, statGroup('time', '📅', t('trade.statGroupSpan'),
    metric(t('trade.metricSpan'), s.spanDays != null ? numVal(s.spanDays, t('common.unitDays')) : '—', null, 'metric-wide metric-vcenter'),
    metric(t('trade.metricFirst'), s.firstAt || '—', null, 'metric-vcenter'),
    metric(t('trade.metricLast'), s.lastAt || '—', null, 'metric-vcenter'),
  ));

  // 组2 收支（净额 hero：正=净支出 红，负=净收入 绿）
  const netDir = s.net > 0 ? 'down' : (s.net < 0 ? 'up' : 'flat');
  const netLabel = s.net > 0 ? t('trade.netOut') : (s.net < 0 ? t('trade.netIn') : t('trade.netNeutral'));
  const netArrow = s.net > 0 ? '↑' : (s.net < 0 ? '↓' : '');
  const netNode = document.createDocumentFragment();
  const np = magicParts(s.net);
  const netFull = (s.net > 0 ? '+' : '') + np.full;
  netNode.appendChild(el('b', { text: np.num, attrs: { title: netFull } }));
  netNode.appendChild(el('span', { cls: 'u', text: np.unit, attrs: { title: netFull } }));
  if (netArrow) netNode.appendChild(el('span', { cls: 'arrow', text: netArrow }));
  // 单日最大支出：底部显示日期，点击联动搜索当天交易
  let spendVal = '—', spendSub = null;
  if (s.maxDaySpend != null) {
    spendVal = magicVal(s.maxDaySpend);
    if (s.maxDaySpendDate) {
      const dlink = el('span', { cls: 'ts-link', text: s.maxDaySpendDate });
      dlink.title = t('trade.maxSpendLinkTitle');
      dlink.onclick = () => {
        const df = $('tradeDateFrom'), dt = $('tradeDateTo');
        if (df) df.value = s.maxDaySpendDate;
        if (dt) dt.value = s.maxDaySpendDate;
        tradesFilter.dateFrom = s.maxDaySpendDate;
        tradesFilter.dateTo = s.maxDaySpendDate;
        renderTrades();
      };
      spendSub = dlink;
    }
  }
  const buyCountMetric = metric(t('trade.metricBuyCount'), numVal(s.buy.count, t('common.unitCards')), sumAvgSub(s.buy.sum, s.buy.avg), 'metric-vcenter');
  if (buyCountMetric && s.buy.count > 0) {
    buyCountMetric.style.cursor = 'pointer';
    buyCountMetric.classList.toggle('metric-toggle-on', tradesFilter.side === 'buy');
    buyCountMetric.onclick = () => { tradesFilter.side = (tradesFilter.side === 'buy' ? null : 'buy'); renderTrades(); };
  }
  const sellCountMetric = metric(t('trade.metricSellCount'), numVal(s.sell.count, t('common.unitCards')), sumAvgSub(s.sell.sum, s.sell.avg), 'metric-vcenter');
  if (sellCountMetric && s.sell.count > 0) {
    sellCountMetric.style.cursor = 'pointer';
    sellCountMetric.classList.toggle('metric-toggle-on', tradesFilter.side === 'sell');
    sellCountMetric.onclick = () => { tradesFilter.side = (tradesFilter.side === 'sell' ? null : 'sell'); renderTrades(); };
  }
  append(box, statGroup('money', '💰', t('trade.statGroupMoney'),
    buyCountMetric,
    sellCountMetric,
    metric(netLabel, netNode, null, 'metric-net metric-vcenter metric-' + netDir),
    metric(t('trade.metricMaxDaySpend'), spendVal, spendSub, 'metric-spend metric-vcenter'),
  ));

  // 组3 卡牌（分布按稀有度拆成带色 tag）
  const distTags = document.createDocumentFragment();
  let hasDist = false;
  ['UR', 'SSR', 'SR', 'R', 'N'].forEach((r) => {
    if (s.rarityDist[r]) { distTags.appendChild(el('span', { cls: 'dist-tag r-' + r, text: r + '×' + s.rarityDist[r] })); hasDist = true; }
  });
  if (s.mechCount) { distTags.appendChild(el('span', { cls: 'dist-tag r-mech', text: t('dist.mechPrefix', { n: s.mechCount }) })); hasDist = true; }
  append(box, statGroup('cards', '🃏', t('trade.statGroupCards'),
    metric(t('trade.metricDist'), hasDist ? distTags : '—', null, 'metric-wide metric-vcenter metric-dist'),
    metric(t('trade.metricTopBuy'), s.topBuy != null ? magicVal(s.topBuy) : '—', null, 'metric-vcenter'),
    metric(t('trade.metricTopSell'), s.topSell != null ? magicVal(s.topSell) : '—', null, 'metric-vcenter'),
  ));

  // 组4 交易对象（最常对手可点击联动搜索）
  let counterVal = '—', counterSub = null;
  if (s.topCounter) {
    const sideLabel = s.topCounter.side === 'sell' ? t('trade.counterMainSell') : t('trade.counterMainBuy');
    const link = el('span', { cls: 'ts-link md-uid-text', text: '#' + s.topCounter.id });
    link.title = t('trade.counterLinkTitle');
    link.onclick = () => {
      const txt = $('tradeSearchText');
      const ex = $('tradeExact');
      if (txt) txt.value = s.topCounter.id;
      if (ex) ex.checked = true;            // 联动时带上精确搜索（id 需精确匹配，避免子串误命中）
      tradesFilter.text = s.topCounter.id;
      tradesFilter.exact = true;
      renderTrades();
    };
    counterVal = link;
    counterSub = t('trade.counterSummary', { count: s.topCounter.count, side: sideLabel });
  }
  append(box, statGroup('people', '👥', t('trade.statGroupPeople'),
    metric(t('trade.metricSoldTo'), numVal(s.soldTo, t('common.unitPersons')), null, 'metric-vcenter'),
    metric(t('trade.metricBoughtFrom'), numVal(s.boughtFrom, t('common.unitPersons')), null, 'metric-vcenter'),
    metric(t('trade.metricMostFrequent'), counterVal, counterSub, 'metric-wide metric-vcenter metric-counter'),
  ));
}

// 统计区 UI 辅助
function statGroup(tone, ico, title, ...metrics) {
  const g = el('div', { cls: 'tstat-group' });
  if (tone) g.setAttribute('data-tone', tone);
  const head = el('div', { cls: 'tstat-head' });
  append(head, el('span', { cls: 'tstat-ico', text: ico }), el('span', { cls: 'tstat-title', text: title }));
  const body = el('div', { cls: 'tstat-body' });
  for (const m of metrics) if (m) append(body, m);
  append(g, head, body);
  return g;
}
// <b>数字</b> + 可选 <span class="u">单位</span>（单位做小字处理）
function numVal(n, unit) {
  const f = document.createDocumentFragment();
  f.appendChild(el('b', { text: String(n) }));
  if (unit) f.appendChild(el('span', { cls: 'u', text: unit }));
  return f;
}
// 大额魔力缩写：≤3位原样千分位；≥千用 K、≥百万用 M、≥十亿用 B（均取整）。
// 返回 {num, unit, full}：num=显示数字、unit=单位(含K/M/B前缀)、full=完整千分位(供 title)。
function magicParts(n) {
  const full = fmtNum(Math.round(n));
  const a = Math.abs(n);
  if (a >= 1e9) return { num: (n / 1e9).toFixed(2) + 'B',  unit: t('common.magic'), full };
  if (a >= 1e6) return { num: (n / 1e6).toFixed(2) + 'M', unit: t('common.magic'), full };
  if (a >= 1e3) return { num: Math.round(n / 1e3) + 'K', unit: t('common.magic'), full };
  return { num: full, unit: t('common.magic'), full };
}
// 魔力数值节点：<b>num</b><span class="u">unit</span>，鼠标悬浮显示完整值；null/非数返回 '—'。
function magicVal(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const p = magicParts(n);
  const f = document.createDocumentFragment();
  f.appendChild(el('b', { text: p.num, attrs: { title: p.full } }));
  f.appendChild(el('span', { cls: 'u', text: p.unit, attrs: { title: p.full } }));
  return f;
}
// 卖出净收入：m-team 卖单税 = 目标卖出价 × 5%，挂单价(=成交价) = 净收入 × 1.05；
// 故 净收入 = 成交价 / 1.05（等价 税费 = 成交价 / 21）。例：成交 157500 → 净 150000、税 7500。
// 注意不是成交价 × 0.95（那会算成 7875 税，错）——税基是净收入不是成交价。
function netOf(gross) { return Math.round((Number(gross) || 0) / 1.05); }

// 收支汇总的"总价/均价"小字：数字用 K/M/B 缩写，悬浮显示完整千分位版。
function sumAvgSub(sum, avg) {
  const sp = magicParts(sum), ap = magicParts(avg);
  const shortText = t('trade.metricSumAvg', { sum: sp.num, avg: ap.num });
  const fullText = t('trade.metricSumAvg', { sum: sp.full, avg: ap.full });
  return el('span', { text: shortText, attrs: { title: fullText } });
}
// 单个指标：label 在上(极小灰大写)，value 在下(大号 mono 数字)，可选 sub
function metric(label, val, sub, cls) {
  const m = el('div', { cls: 'metric' + (cls ? ' ' + cls : '') });
  append(m, el('div', { cls: 'metric-label', text: label }));
  const v = el('div', { cls: 'metric-val' });
  if (val instanceof Node) append(v, val); else if (val != null) v.textContent = val;
  append(m, v);
  if (sub != null) {
    const sEl = el('div', { cls: 'metric-sub' });
    if (sub instanceof Node) append(sEl, sub); else sEl.textContent = sub;
    append(m, sEl);
  }
  return m;
}

// 交易记录搜索：文本(片名/买家卖家ID/稀有度/称号/机制卡) + 时间区间
function filterMyTrades(list) {
  const f = tradesFilter;
  const text = (f.text || '').trim().toLowerCase();
  const kws = text ? text.split(/\s+/).filter(Boolean) : [];
  const hasDate = !!(f.dateFrom || f.dateTo);
  const hasRarity = f.mech || (f.rarities && f.rarities.size > 0);
  const hasTitle = f.titles && f.titles.size > 0;
  if (!kws.length && !hasDate && !hasRarity && !hasTitle && !f.side) return list;
  return list.filter((it) => {
    if (f.side && it.side !== f.side) return false;
    if (hasRarity) {
      const m = isMechCard(it);
      if (m) { if (!f.mech) return false; }
      else { if (!f.rarities.has(it.rarity || 'N')) return false; }
    }
    if (hasTitle && it.title && !f.titles.has(it.title)) return false;
    if (kws.length) {
      const fields = [it.filmName || '', it.buyerId != null ? String(it.buyerId) : '', it.sellerId != null ? String(it.sellerId) : ''].map((s) => s.toLowerCase());
      const exact = !!f.exact;
      if (!kws.every((kw) => { const k = kw.toLowerCase(); return fields.some((fld) => exact ? fld === k : fld.indexOf(k) !== -1); })) return false;
    }
    if (hasDate) {
      const t = parseMtTime(it.tradedAt);
      if (!Number.isFinite(t)) return false;
      if (f.dateFrom) {
        const from = parseDateBound(f.dateFrom, true);
        if (Number.isFinite(from) && t < from) return false;
      }
      if (f.dateTo) {
        const to = parseDateBound(f.dateTo, false);
        if (Number.isFinite(to) && t > to) return false;
      }
    }
    return true;
  });
}
// 挂单搜索：文本(片名/稀有度/称号/机制卡/买/卖/状态) + 时间区间（按 createdDate）
function filterOrders(list) {
  const f = ordersFilter;
  const text = (f.text || '').trim().toLowerCase();
  const kws = text ? text.split(/\s+/).filter(Boolean) : [];
  const hasDate = !!(f.dateFrom || f.dateTo);
  const hasRarity = f.mech || (f.rarities && f.rarities.size > 0);
  const hasTitle = f.titles && f.titles.size > 0;
  if (!kws.length && !hasDate && !hasRarity && !hasTitle) return list;
  return list.filter((it) => {
    if (hasRarity) {
      const m = isMechCard(it);
      if (m) { if (!f.mech) return false; }
      else { if (!f.rarities.has(it.rarity || 'N')) return false; }
    }
    if (hasTitle && it.title && !f.titles.has(it.title)) return false;
    if (kws.length) {
      const fields = [it.filmName || ''].map((s) => s.toLowerCase());
      const exact = !!f.exact;
      if (!kws.every((kw) => { const k = kw.toLowerCase(); return fields.some((fld) => exact ? fld === k : fld.indexOf(k) !== -1); })) return false;
    }
    if (hasDate) {
      const t = parseMtTime(it.createdDate);
      if (!Number.isFinite(t)) return false;
      if (f.dateFrom) { const from = parseDateBound(f.dateFrom, true); if (Number.isFinite(from) && t < from) return false; }
      if (f.dateTo) { const to = parseDateBound(f.dateTo, false); if (Number.isFinite(to) && t > to) return false; }
    }
    return true;
  });
}
// YYYY-MM-DD → 时间戳；start=true 当天 00:00:00，false 当天 23:59:59
function parseDateBound(s, start) {
  const d = new Date(s + 'T' + (start ? '00:00:00' : '23:59:59'));
  return isNaN(d.getTime()) ? NaN : d.getTime();
}

function buildTradeCard(it, delay) {
  const rarity = it.rarity || 'N';
  const filmId = it.filmId || '';
  const isMech = isMechCard(it);
  const name = isMech ? (mechLabel(filmId.slice(5)) || it.filmName || t('card.unnamed')) : (it.filmName || t('card.unnamed'));
  const url = buildDetailUrl(it, (state.config && state.config.webBase) || 'kp.m-team.cc');
  const gross = (it.price != null && it.price !== '') ? Number(it.price) : null; // 成交价（卖出=挂单价）
  const isSell = it.side === 'sell';
  // 卖出显示扣税后净收入（与汇总/统计统一）；买入显示成交价
  const price = (isSell && gross != null) ? netOf(gross) : gross;
  const counterId = isSell ? it.buyerId : it.sellerId; // 对手：卖出→买家，买入→卖家
  const counterLabel = isSell ? t('trade.counterBuyer') : t('trade.counterSeller');

  const card = el('div', { cls: 'card trade-card' + (isSell ? ' is-sell' : '') });
  card.style.animationDelay = delay + 'ms';

  const wrap = el('div', { cls: 'poster-wrap' });
  const fallback = el('div', { cls: 'poster-fallback', text: (name || '?').slice(0, 1) });
  fallback.style.display = 'none';
  if (it.poster) {
    const img = el('img', { cls: 'poster', attrs: { alt: name, loading: 'lazy' } });
    img.onerror = () => { img.remove(); fallback.style.display = 'grid'; };
    img.src = it.poster;
    wrap.appendChild(img);
  } else {
    fallback.style.display = 'grid';
  }
  wrap.appendChild(fallback);
  // 左上：稀有度/机制卡 badge
  wrap.appendChild(el('div', { cls: 'rarity-badge ' + (isMech ? 'r-mech' : 'r-' + rarity), text: isMech ? t('card.badgeMech') : (RARITY_LABEL[rarity] || rarity) }));
  const openBtn = el('button', { cls: 'ca-open', attrs: { title: t('card.openInNewTabDetail') }, text: '↗' });
  openBtn.onclick = (e) => { e.stopPropagation(); window.open(url, '_blank'); };
  wrap.appendChild(openBtn);
  if (it.title && !isMech) {
    const tier = TITLE_TIER[it.title] || 'tt-5';
    wrap.appendChild(el('div', { cls: 'title-tag ' + tier, text: it.title }));
  }

  const body = el('div', { cls: 'card-body' });
  const nameRow = el('div', { cls: 'film-name-row' });
  append(nameRow,
    el('div', { cls: 'film-name', text: name }),
    el('span', { cls: 'side-tag ' + (isSell ? 'sell' : 'buy'), text: isSell ? t('trade.sideSell') : t('trade.sideBuy') })
  );
  append(body, nameRow);

  // 底部双列：左 价格+魔力 / 右 对手label+id；底部一行 tradedAt
  const statRow = el('div', { cls: 'trade-stat-row' });
  const magicCol = el('div', { cls: 'trade-col' });
  const priceEl = el('div', { cls: 'trade-price', attrs: (isSell && gross != null) ? { title: t('trade.sellNetTip', { gross: fmtNum(gross) }) } : (price != null ? { title: fmtNum(price) } : {}) });
  if (price != null) append(priceEl, document.createTextNode(fmtPrice(price)), el('span', { cls: 'trade-price-unit', text: t('common.magic') }));
  else priceEl.appendChild(el('span', { cls: 'trade-price-unit', text: t('common.magic') }));
  magicCol.appendChild(priceEl);
  const counterCol = el('div', { cls: 'trade-col right' });
  append(counterCol, el('div', { cls: 'trade-col-label', text: counterLabel.trim() }));
  if (counterId) {
    var _wb = (state.config && state.config.webBase) || 'kp.m-team.cc';
    counterCol.appendChild(el('a', {
      cls: 'trade-counter',
      text: counterId,
      attrs: { href: webUrl(_wb, '/profile/detail/' + counterId), target: '_blank', rel: 'noopener' }
    }));
  } else {
    counterCol.appendChild(el('div', { cls: 'trade-counter', text: '—' }));
  }
  append(statRow, magicCol, counterCol);
  append(body, statRow);

  if (it.tradedAt) append(body, el('div', { cls: 'trade-time', text: it.tradedAt }));

  append(card, wrap, body);
  return card;
}

// 挂单历史模态：展示某 cardId 的全部挂单记录时间线（首次挂单 → 改价/重挂 → 成交/取消）
function showOrderHistory(cardId, head) {
  const all = ((state && state.ordersAll) || [])
    .filter((o) => String(o.cardId) === String(cardId))
    .sort((a, b) => (parseMtTime(a.createdDate) || 0) - (parseMtTime(b.createdDate) || 0));
  const filmId = head.filmId || '';
  const isMech = isMechCard(head);
  const name = isMech ? (mechLabel(filmId.slice(5)) || head.filmName || t('card.unnamed')) : (head.filmName || t('card.unnamed'));
  const statusText = (s) => s === 'open' ? t('order.statusOpen') : (s === 'filled' ? t('order.statusFilled') : (s === 'cancelled' ? t('order.statusCancelled') : s));
  const tl = el('div', { cls: 'oh-timeline' });
  if (!all.length) tl.appendChild(el('div', { cls: 'panel-hint', text: t('order.historyEmpty') }));
  all.forEach((o) => {
    const row = el('div', { cls: 'oh-item oh-' + (o.status || 'open') });
    append(row,
      el('span', { cls: 'oh-time', text: o.createdDate || '—' }),
      el('span', { cls: 'oh-price', text: fmtNum(Number(o.price) || 0) + ' ' + t('common.magic') }),
      el('span', { cls: 'oh-status', text: statusText(o.status) })
    );
    tl.appendChild(row);
  });
  const mask = el('div', { cls: 'modal-mask' });
  const box = el('div', { cls: 'modal' });
  const headRow = el('div', { cls: 'modal-head' });
  append(headRow, el('div', { cls: 'modal-icon', text: '📜' }), el('div', { cls: 'modal-title', text: name + t('order.historyModalTitle') }));
  const body = el('div', { cls: 'modal-body' });
  body.appendChild(tl);
  const actions = el('div', { cls: 'modal-actions' });
  const closeBtn = el('button', { cls: 'btn ghost', text: t('common.close') });
  actions.appendChild(closeBtn);
  append(box, headRow, body, actions);
  mask.appendChild(box);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('show'));
  let done = false;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    if (done) return; done = true;
    document.removeEventListener('keydown', onKey);
    mask.classList.remove('show');
    setTimeout(() => mask.remove(), 220);
  }
  document.addEventListener('keydown', onKey);
  closeBtn.onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
}

// ============ 持有卡片视图 ============
function renderInventory() {
  buildInventoryChips();
  renderInventoryStats();
  const grid = $('grid');
  grid.classList.toggle('no-anim', grid.children.length > 0);
  const all = ((state && state.inventory) || []).concat(((state && state.mechInventory) || []).filter((m) => !m.isUsed));
  const list = filterInventory(all);
  const idir = invSortDir === 'desc' ? -1 : 1;
  list.sort((a, b) => idir * ((parseMtTime(a.lastModifiedDate) || 0) - (parseMtTime(b.lastModifiedDate) || 0)));
  const filtered = list.length !== all.length;
  const sortBtn = $('inventorySortBtn');
  if (sortBtn) {
    sortBtn.textContent = invSortDir === 'desc' ? t('card.sortNewest') : t('card.sortOldest');
    sortBtn.onclick = () => { invSortDir = invSortDir === 'desc' ? 'asc' : 'desc'; renderInventory(); };
  }
  const openSell = ((state && state.ordersAll) || []).filter((o) => o.status === 'open' && o.side === 'sell').length;
  const total = all.length + openSell;
  $('resultSummary').replaceChildren(
    el('span', { text: t('inv.summaryPrefix') }),
    el('b', { text: String(total) }),
    el('span', { text: filtered ? t('inv.summaryFilteredSuffix', { n: list.length }) : t('inv.summarySuffix') })
  );
  grid.replaceChildren();
  if (!list.length) {
    const empty = el('div', { cls: 'empty' });
    append(empty,
      el('div', { cls: 'big', text: all.length ? t('inv.emptyFiltered') : t('inv.emptyNoData') }),
      el('div', { cls: 'small', text: all.length ? t('inv.emptyFilteredHint') : t('inv.emptyNoDataHint') }));
    grid.appendChild(empty);
    return;
  }
  list.forEach((it, i) => grid.appendChild(buildInventoryCard(it, Math.min(i, 40) * 25)));
}

// 持有卡片统计：总持有 / 可交易 / 锁定中 / 稀有度分布（含机制卡）
// 已使用（销毁）机制卡模态窗：列表展示名称 + 销毁时间
function showUsedMechDialog(usedMech) {
  const mask = el('div', { cls: 'modal-mask' });
  const box = el('div', { cls: 'modal' });
  const head = el('div', { cls: 'modal-head' });
  append(head, el('div', { cls: 'modal-icon', text: '♻️' }), el('div', { cls: 'modal-title', text: t('inv.usedTitle') }));
  box.appendChild(head);
  const body = el('div', { cls: 'modal-body' });
  const list = el('div', { cls: 'used-mech-modal-list' });
  const header = el('div', { cls: 'used-mech-row used-mech-header' });
  append(header, el('span', { cls: 'used-mech-name', text: t('inv.usedName') }), el('span', { cls: 'used-mech-time', text: t('inv.usedTime') }));
  list.appendChild(header);
  if (usedMech && usedMech.length) {
    usedMech.forEach((it) => {
      const row = el('div', { cls: 'used-mech-row' });
      append(row, el('span', { cls: 'used-mech-name', text: mechLabel(it.type) || it.filmName || '-' }), el('span', { cls: 'used-mech-time mono', text: it.usedAt || '' }));
      list.appendChild(row);
    });
  } else {
    list.appendChild(el('div', { cls: 'panel-hint', text: t('inv.usedEmpty') }));
  }
  body.appendChild(list);
  box.appendChild(body);
  const close = el('button', { cls: 'btn primary', type: 'button', text: t('common.close') });
  close.onclick = () => mask.remove();
  const actions = el('div', { cls: 'modal-actions' });
  actions.appendChild(close);
  box.appendChild(actions);
  mask.appendChild(box);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('show'));
}

function renderInventoryStats() {
  const box = $('inventoryStats');
  if (!box) return;
  const all = ((state && state.inventory) || []).concat(((state && state.mechInventory) || []).filter((m) => !m.isUsed));
  const now = Date.now();
  let locked = 0, tradable = 0, mechCount = 0, dropCount = 0, craftedCount = 0;
  const rarityDist = {};
  all.forEach((it) => {
    const lockUntil = parseMtTime(it.tradeLockUntil);
    if (Number.isFinite(lockUntil) && lockUntil > now) locked++; else tradable++;
    if (isMechCard(it)) mechCount++;
    else if (it.rarity) rarityDist[it.rarity] = (rarityDist[it.rarity] || 0) + 1;
    // 来源按 serial 末段：>0 掉落 / ==0 制造
    const serialNum = Number(String(it.serial || '').split('-').pop());
    if (Number.isFinite(serialNum)) { if (serialNum === 0) craftedCount++; else if (serialNum > 0) dropCount++; }
  });
  // 在挂卖单：挂单中的卖出卡所有权仍属用户，计入总持有
  const openSell = ((state && state.ordersAll) || []).filter((o) => o.status === 'open' && o.side === 'sell').length;
  const total = all.length + openSell;
  // 稀有度分布
  const rarityTags = document.createDocumentFragment();
  let hasRarity = false;
  RARITIES.forEach((r) => {
    if (rarityDist[r]) { rarityTags.appendChild(el('span', { cls: 'dist-tag r-' + r, text: r + '×' + rarityDist[r] })); hasRarity = true; }
  });
  // 来源分布（机制卡 + 掉落 / 制造）
  const provTags = document.createDocumentFragment();
  let hasProv = false;
  if (mechCount) { provTags.appendChild(el('span', { cls: 'dist-tag r-mech', text: t('dist.mechPrefix', { n: mechCount }) })); hasProv = true; }
  if (dropCount) { provTags.appendChild(el('span', { cls: 'dist-tag inv-src-drop', text: t('inv.drop') + '×' + dropCount })); hasProv = true; }
  if (craftedCount) { provTags.appendChild(el('span', { cls: 'dist-tag inv-src-crafted', text: t('inv.crafted') + '×' + craftedCount })); hasProv = true; }
  box.style.display = '';
  box.replaceChildren();
  // 已使用（销毁）机制卡
  const usedMech = ((state && state.mechInventory) || []).filter((m) => m.isUsed);
  const usedCount = usedMech.length;
  const usedMetric = metric(t('inv.metricUsed'), numVal(usedCount, t('common.unitCards')), null, 'metric-vcenter');
  if (usedMetric && usedCount > 0) {
    usedMetric.style.cursor = 'pointer';
    usedMetric.onclick = () => showUsedMechDialog(usedMech);
  }
  const onSellMetric = metric(t('inv.metricOnSell'), numVal(openSell, t('common.unitCards')), null, 'metric-vcenter');
  if (onSellMetric && openSell > 0) {
    onSellMetric.style.cursor = 'pointer';
    onSellMetric.onclick = () => toggleView('orders');
  }
  const lockedMetric = metric(t('inv.metricLocked'), numVal(locked, t('common.unitCards')), null, 'metric-vcenter');
  if (lockedMetric) {
    lockedMetric.style.cursor = 'pointer';
    lockedMetric.classList.toggle('metric-toggle-on', inventoryFilter.lock);
    lockedMetric.onclick = () => { inventoryFilter.lock = !inventoryFilter.lock; renderInventory(); };
  }
  append(box, statGroup('money', '🗂️', t('inv.statGroupOverview'),
    metric(t('inv.metricTotal'), numVal(total, t('common.unitCards')), null, 'metric-vcenter'),
    metric(t('inv.metricHeld'), numVal(all.length, t('common.unitCards')), null, 'metric-vcenter'),
    onSellMetric,
    metric(t('inv.metricTradable'), numVal(tradable, t('common.unitCards')), null, 'metric-vcenter'),
    lockedMetric,
    usedMetric
  ));
  append(box, statGroup('time', '📊', t('inv.statGroupDist'),
    metric(t('inv.metricRarity'), hasRarity ? rarityTags : '—', null, 'metric-wide metric-vcenter metric-dist'),
    metric(t('inv.metricSource'), hasProv ? provTags : '—', null, 'metric-wide metric-vcenter metric-dist')
  ));
}

// ============ 掉落统计视图（独立 view，精美数据展示，不复用 statGroup/metric） ============
let dropChartRange = 30; // 每日掉落柱状图范围：7 / 30 / 90 / 'all'
function renderDropStats() {
  const box = $('dropStatsView');
  if (!box) return;
  box.style.display = '';
  box.replaceChildren();
  const sum = state && state.dropStats && state.dropStats.summary;

  // 顶部结果摘要
  const rs = $('resultSummary');
  if (rs) rs.replaceChildren(
    el('span', { text: t('dropStats.title') + ' · ' }),
    el('b', { text: String(sum ? sum.totalCards : 0) }),
    el('span', { text: t('common.unitCards') })
  );

  if (!sum || !sum.totalCards) {
    const empty = el('div', { cls: 'drop-empty' });
    append(empty,
      el('div', { cls: 'drop-empty-ico', text: '🃏' }),
      el('div', { cls: 'drop-empty-tip', text: t('dropStats.empty') })
    );
    box.appendChild(empty);
    box.appendChild(renderCardLogCard());
    return;
  }

  // Hero：总掉落大数字
  const hero = el('div', { cls: 'drop-hero' });
  const heroNumrow = el('div', { cls: 'drop-hero-numrow' });
  append(heroNumrow,
    el('div', { cls: 'drop-hero-num', text: String(sum.totalCards) }),
    el('div', { cls: 'drop-hero-unit', text: t('common.unitCards') })
  );
  append(hero, heroNumrow,
    el('div', { cls: 'drop-hero-sub', text: t('dropStats.perDay', { n: sum.avgPerDay.toFixed(1) }) })
  );
  // 数据实际范围（since 随最新 25 条数据而定，不再固定 7/1）+ 接口限制说明
  if (sum.rangeStart && sum.rangeEnd) hero.appendChild(el('div', { cls: 'drop-hero-range', text: sum.rangeStart + ' ~ ' + sum.rangeEnd }));
  // 「官方接口仅25条」+「可手动补全」+ 按钮合并显示，仅 message 接口数据未补全时（msgTotal=0 从未导入，或已导入条数 < 接口总数）；补全后整体隐藏
  const _msgTotal = (state.dropStats && state.dropStats.msgTotal) || 0;
  const _needImport = !_msgTotal || (((state.dropStats && state.dropStats.messages) || []).length < _msgTotal);
  if (_needImport) {
    const cta = el('div', { cls: 'drop-hero-cta' });
    const ctaBtn = el('button', { cls: 'seg-btn mini', text: '📥 ' + t('dropStats.importBtn'), attrs: { type: 'button' } });
    ctaBtn.onclick = openDropImportModal;
    append(cta, el('span', { cls: 'drop-hero-cta-text', text: t('dropStats.feedNote') + ' · ' + t('dropStats.importHint') }), ctaBtn);
    hero.appendChild(cta);
  }

  // KPI 行：总历时 / 掉落天数 / 最大连续 / 近7天日均
  const kpi = el('div', { cls: 'drop-kpi' });
  append(kpi,
    dropKpi(t('dropStats.spanDays'), sum.totalDays, t('common.unitDays')),
    dropKpi(t('dropStats.dropDays'), sum.dropDays, t('common.unitDays')),
    dropKpi(t('dropStats.maxStreak'), sum.maxStreak, t('common.unitDays')),
    dropKpi(t('dropStats.recent7'), sum.recent7Avg.toFixed(1), t('common.unitPerDay'))
  );

  // 稀有度横向条形图
  const raritySection = el('div', { cls: 'drop-section' });
  append(raritySection, el('div', { cls: 'drop-section-title', text: t('dropStats.rarity') }));
  const bars = el('div', { cls: 'drop-bars' });
  RARITIES.forEach((r) => {
    const c = sum.rarityCount[r] || 0;
    const pct = sum.totalCards ? (c / sum.totalCards * 100) : 0;
    const w = pct;
    const row = el('div', { cls: 'drop-bar-row' });
    const track = el('div', { cls: 'drop-bar-track' });
    track.appendChild(el('div', { cls: 'drop-bar-fill r-' + r, attrs: { style: 'width:' + w + '%' } }));
    append(row,
      el('span', { cls: 'drop-bar-label r-' + r, text: r }),
      track,
      el('span', { cls: 'drop-bar-count', text: c + ' · ' + pct.toFixed(1) + '%' })
    );
    bars.appendChild(row);
  });
  raritySection.appendChild(bars);

  // 称号分布（横向条形图，同稀有度样式，按称号等级配色）
  const titleSection = el('div', { cls: 'drop-section' });
  append(titleSection, el('div', { cls: 'drop-section-title', text: t('dropStats.titles') }));
  const titleBars = el('div', { cls: 'drop-bars' });
  const titleKeys = Object.keys(sum.titleCount || {}).sort((a, b) => (sum.titleCount[a] || 0) - (sum.titleCount[b] || 0));
  titleKeys.forEach((tk) => {
    const c = sum.titleCount[tk] || 0;
    const pct = sum.totalCards ? (c / sum.totalCards * 100) : 0;
    const w = pct;
    const tier = TITLE_TIER[tk] || 'tt-5';
    const row = el('div', { cls: 'drop-bar-row' });
    const track = el('div', { cls: 'drop-bar-track' });
    track.appendChild(el('div', { cls: 'drop-bar-fill ' + tier, attrs: { style: 'width:' + w + '%' } }));
    append(row,
      el('span', { cls: 'drop-bar-label ' + tier, text: tk }),
      track,
      el('span', { cls: 'drop-bar-count', text: c + ' · ' + pct.toFixed(1) + '%' })
    );
    titleBars.appendChild(row);
  });
  titleSection.appendChild(titleBars);

  // 采样区间
  // 每日掉落柱状图（KPI 下方）
  const chartSection = buildDropChart(sum);

  // 稀有度 + 称号 并排两列
  const grid2 = el('div', { cls: 'drop-grid-2' });
  append(grid2, raritySection, titleSection);
  append(box, hero, kpi, chartSection, grid2, renderCardLogCard());
}

// 导入掉落记录模态：指引 + 粘贴 message search 响应 JSON + 解析导入（补齐 feed 之前的全量历史，messages 通路）
function openDropImportModal() {
  const mask = el('div', { cls: 'modal-mask' });
  const box = el('div', { cls: 'modal drop-import-modal' });
  const head = el('div', { cls: 'modal-head' });
  append(head,
    el('div', { cls: 'modal-icon', text: '📥' }),
    el('div', { cls: 'modal-title', text: t('dropStats.importTitle') })
  );
  box.appendChild(head);
  const body = el('div', { cls: 'modal-body' });
  const steps = el('ol', { cls: 'drop-import-steps' });
  (t('dropStats.importSteps') || '').split('\n').forEach(function (line) {
    const s = String(line).trim();
    if (s) steps.appendChild(el('li', { text: s }));
  });
  body.appendChild(steps);
  const ta = el('textarea', { cls: 'drop-import-textarea', attrs: { placeholder: t('dropStats.importPlaceholder'), rows: '8' } });
  body.appendChild(ta);
  const result = el('div', { cls: 'drop-import-result' });
  body.appendChild(result);
  box.appendChild(body);
  const cancelBtn = el('button', { cls: 'btn ghost', text: t('common.cancel'), attrs: { type: 'button' } });
  const importBtn = el('button', { cls: 'btn primary', text: t('dropStats.importDo'), attrs: { type: 'button' } });
  const actions = el('div', { cls: 'modal-actions' });
  append(actions, cancelBtn, importBtn);
  box.appendChild(actions);
  mask.appendChild(box);
  document.body.appendChild(mask);
  requestAnimationFrame(function () { mask.classList.add('show'); });
  const mainArea = $('mainArea');
  if (mainArea) mainArea.style.overflow = 'hidden';
  let done = false;
  function close() {
    if (done) return; done = true;
    document.removeEventListener('keydown', onKey);
    mask.classList.remove('show');
    setTimeout(function () { mask.remove(); }, 220);
    if (mainArea) mainArea.style.overflow = '';
  }
  var onKey = function (e) { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  cancelBtn.onclick = close;
  mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  importBtn.onclick = async function () {
    const json = (ta.value || '').trim();
    if (!json) { result.textContent = t('dropStats.importEmpty'); result.className = 'drop-import-result err'; return; }
    importBtn.disabled = true;
    importBtn.textContent = t('dropStats.importing');
    try {
      const r = await send({ type: 'IMPORT_DROPS', json: json });
      if (r && r.ok) {
        state = await send({ type: 'GET_STATE' });  // 拉最新（summary/rangeStart 已后端重算），供完整性检查
        renderAll();
        if (r.imported > 0) ta.value = '';
        const parts = [t('dropStats.importResult', { n: r.imported, skip: r.skipped, total: r.total })];
        if (r.page && r.page.totalPages > 1) parts.push(t('dropStats.importPaging', { pages: r.page.totalPages, page: r.page.pageNumber || 1, total: r.page.total }));
        if (r.page && r.page.total && r.total < r.page.total) parts.push(t('dropStats.importIncomplete', { have: r.total, total: r.page.total }));
        result.textContent = parts.join('\n');
        result.className = 'drop-import-result ' + (r.imported > 0 ? 'ok' : 'info');
      } else {
        result.textContent = t('dropStats.importError') + '：' + (t('dropStats.importReason.' + (r && r.reason)) || (r && r.error) || '');
        result.className = 'drop-import-result err';
      }
    } catch (e) {
      result.textContent = t('dropStats.importError');
      result.className = 'drop-import-result err';
    }
    importBtn.disabled = false;
    importBtn.textContent = t('dropStats.importDo');
  };
  setTimeout(function () { try { ta.focus(); } catch (e) {} }, 60);
}

// ============ 市场分析报告（HTML 单文件，新 tab 打开，可打印）============
// 全量数据（不受筛选影响）→ computeMarketSummary → analyzeMarket 判读 → 精致研报 HTML（内联 CSS + SVG）。
function _rptCSS() {
  return `
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 820px; margin: 0 auto; padding: 26px 22px 44px; color: #222; background: #f4f5f7; line-height: 1.5; }
.rpt-btn { position: fixed; top: 14px; right: 14px; z-index: 9; padding: 8px 16px; background: #f5a623; color: #fff; border: none; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 6px 18px rgba(245,166,35,.45); }
header { background: linear-gradient(135deg, #1a1a2e, #16213e); color: #fff; padding: 18px 24px; border-radius: 13px; margin-bottom: 12px; }
header h1 { margin: 0 0 4px; font-size: 18px; }
.headline { font-size: 12px; line-height: 1.7; opacity: .94; }
.meta { font-size: 10.5px; opacity: .55; margin-top: 8px; }
section { background: #fff; border-radius: 11px; padding: 11px 15px; margin-bottom: 6px; box-shadow: 0 2px 8px rgba(0,0,0,.04); }
section h2 { margin: 0 0 2px; font-size: 13px; color: #1a1a2e; }
.rpt-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.rpt-cell { min-width: 0; }
.rpt-cell h2 { font-size: 12.5px; }
.rpt-cell .verdict { font-size: 11px; margin: 1px 0 5px; }
.rpt-cell .metrics { grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 4px 0; }
.rpt-cell .metric { padding: 4px 5px; }
.rpt-cell .metric .v { font-size: 12.5px; }
.rpt-cell .metric .l { font-size: 9px; }
.verdict { font-size: 12px; color: #c47e00; font-weight: 600; margin: 2px 0 7px; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 7px; margin: 7px 0; }
.metric { background: #f7f8fa; border-radius: 7px; padding: 6px 9px; }
.metric .v { font-size: 14px; font-weight: 700; color: #1a1a2e; }
.metric .l { font-size: 10px; color: #888; }
table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 4px; }
th, td { padding: 4px 6px; text-align: left; border-bottom: 1px solid #f0f0f2; }
th { color: #999; font-weight: 600; font-size: 10px; }
td:first-child { font-weight: 600; }
.hint { font-size: 10px; color: #aaa; margin: 5px 0 2px; }
.rc-bars { display: flex; align-items: stretch; gap: 3px; }
.rc-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.rc-plot { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
.rc-bar { width: 80%; min-height: 1px; border-radius: 2px 2px 0 0; background: #f5a623; position: relative; }
.rc-val { position: absolute; top: -13px; left: 0; right: 0; text-align: center; font-size: 9px; color: #666; }
.rc-lab { font-size: 9px; color: #999; text-align: center; margin-top: 3px; height: 11px; overflow: hidden; }
.rc-N{background:#9e9e9e}.rc-R{background:#66bb6a}.rc-SR{background:#42a5f5}.rc-SSR{background:#ab47bc}.rc-UR{background:#ff7043}.rc-mech{background:#9c27b0}
.rpt-mech-row td { border-top: 1px solid #e0d4ec; }
.rpt-mech-row td:first-child { color: #9c27b0; }
footer { text-align: center; font-size: 10px; color: #bbb; margin: 10px 0 0; }
@page { margin: 0; }
@media print {
  body { background: #fff; padding: 10mm 12mm; max-width: none; }
  .rpt-btn { display: none; }
  section { box-shadow: none; padding: 7px 11px; margin-bottom: 5px; break-inside: avoid; }
  header { padding: 11px 15px; margin-bottom: 6px; break-after: avoid; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .rc-bar { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
}
// HTML 柱状图（div+flex，文字不变形；items: {label, value, cls, valLabel}）
function _rptBars(items, height) {
  height = height || 80;
  const ph = height - 14;  // 柱状区高度（留底部 label）
  const max = Math.max.apply(null, items.map(function (it) { return it.value || 0; })) || 1;
  let cols = '';
  items.forEach(function (it) {
    const h = Math.round((it.value || 0) / max * 100);
    const val = it.valLabel ? '<span class="rc-val">' + it.valLabel + '</span>' : '';
    cols += '<div class="rc-col"><div class="rc-plot" style="height:' + ph + 'px"><div class="rc-bar ' + (it.cls || '') + '" style="height:' + h + '%">' + val + '</div></div><div class="rc-lab">' + (it.label || '') + '</div></div>';
  });
  return '<div class="rc-bars">' + cols + '</div>';
}
function _rptMetric(v, l) { return '<div class="metric"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }
function _rptBuildHtml(sum, a, total, genTime, logoUrl) {
  const money = function (v) { return fmtPrice(v); };
  const pct = function (x) { return Math.round((x || 0) * 100) + '%'; };
  const dpct = function (x) { return (x >= 0 ? '+' : '') + Math.round((x || 0) * 100) + '%'; };
  const lang = window.__lang === 'en' ? 'en' : 'zh';
  const pa = a.priceAction, lq = a.liquidity, st = a.structure, va = a.valuation;
  // ① 量价 + ③ 流动 并排
  const cell1 = '<div class="rpt-cell"><h2>' + t('report.pa') + '</h2><div class="verdict">' + t('report.paVerdict.' + pa.tier) + '</div><div class="metrics">' + _rptMetric(pa.dailyAvg.toFixed(1), t('report.dailyAvg')) + (pa.tradeDelta != null ? _rptMetric(dpct(pa.tradeDelta), t('report.tradeDelta')) + _rptMetric(dpct(pa.priceDelta), t('report.priceDelta')) : '') + '</div></div>';
  const cell3 = '<div class="rpt-cell"><h2>' + t('report.liq') + '</h2><div class="verdict">' + t('report.flow.' + lq.flow) + '；' + t('report.both') + ' ' + pct(lq.bothPct) + '</div><div class="metrics">' + _rptMetric(pct(lq.pureBuyerPct), t('report.pureBuyer')) + _rptMetric(pct(lq.pureSellerPct), t('report.pureSeller')) + _rptMetric(pct(lq.bothPct), t('report.both')) + '</div>' + (lq.flipCount ? '<div class="hint">' + t('report.flipHint', { n: lq.flipCount, m: lq.avgMargin != null ? dpct(lq.avgMargin) : '—', d: lq.avgHoldDays != null ? lq.avgHoldDays.toFixed(1) : '—' }) + '</div>' : '') + '</div>';
  const s13 = '<section class="rpt-2col">' + cell1 + cell3 + '</section>';
  // ② 主导结构（普通卡 rarityMatrix + 机制卡 mechMatrix，占比统一按总 GMV = 普通+机制）
  const mm = st.matrix || [];
  let totVol = 0; mm.forEach(function (r) { totVol += r.volume || 0; });
  const mechM = sum.mechMatrix || [];
  let mechVol = 0, mechTrades = 0; mechM.forEach(function (m) { mechVol += m.volume || 0; mechTrades += m.trades || 0; });
  const grandVol = (totVol + mechVol) || 1;
  let mainR = null; mm.forEach(function (r) { if (!mainR || (r.volume || 0) > (mainR.volume || 0)) mainR = r; });
  const mainPct = mainR ? Math.round((mainR.volume || 0) / grandVol * 100) : 0;
  const mechPct = Math.round(mechVol / grandVol * 100);
  let s2 = '<section><h2>' + t('report.structure') + '</h2><div class="verdict">' + (mainR ? mainR.rarity + ' ' + t('report.contributed') + ' ' + mainPct + '% ' + t('report.gmv') : t('report.noData')) + (mechVol ? '；' + t('report.mech') + ' ' + mechPct + '% ' + t('report.gmv') : '') + '；' + t('report.hhiTier.' + st.hhiTier) + '（' + t('report.top10') + ' ' + pct(st.top10Pct) + '）' + '</div>';
  s2 += '<table><thead><tr><th>' + t('report.thRarity') + '</th><th>' + t('report.thTrades') + '</th><th>' + t('report.thShare') + '</th><th>' + t('report.thAvg') + '</th></tr></thead><tbody>';
  mm.forEach(function (r) { s2 += '<tr><td>' + r.rarity + '</td><td>' + r.trades + '</td><td>' + Math.round((r.volume || 0) / grandVol * 100) + '%</td><td>' + money(r.avgPrice) + '</td></tr>'; });
  if (mechVol) s2 += '<tr class="rpt-mech-row"><td>' + t('report.mech') + '</td><td>' + mechTrades + '</td><td>' + mechPct + '%</td><td>' + money(mechVol / (mechTrades || 1)) + '</td></tr>';
  const s2bars = mm.map(function (r) { return { label: r.rarity, value: r.volume, cls: 'rc-' + r.rarity }; });
  if (mechVol) s2bars.push({ label: t('report.mech'), value: mechVol, cls: 'rc-mech' });
  s2 += '</tbody></table><div class="hint">' + t('report.gmvHint') + '</div>' + _rptBars(s2bars, 64) + '</section>';
  // ④ 定价
  let s4 = '<section><h2>' + t('report.valuation') + '</h2><div class="verdict">' + t('report.skewTier.' + va.skewTier) + '；' + t('report.price') + t('report.cvTier.' + va.cvTier) + (va.ladderOk ? '' : '；' + t('report.ladderCollapse')) + '</div>';
  s4 += '<div class="metrics">' + _rptMetric(money(va.median), t('report.median')) + _rptMetric(money(va.avg), t('report.avg')) + _rptMetric(money(va.p25) + '~' + money(va.p75), t('report.p2575')) + '</div>';
  const ph = sum.priceHistogram || [];
  if (ph.length) s4 += '<div class="hint">' + t('report.distHint') + '</div>' + _rptBars(ph.map(function (b) { return { label: fmtK(b.lo), value: b.count, valLabel: String(b.count) }; }), 64);
  s4 += '</section>';
  // ⑤ 热门
  let s5 = '<section><h2>' + t('report.hot') + '</h2><table><thead><tr><th>' + t('report.topVol') + '</th><th>' + t('report.thAmount') + '</th></tr></thead><tbody>';
  (sum.topVolume || []).slice(0, 3).forEach(function (c) { s5 += '<tr><td>' + (c.filmName || '?') + '</td><td>' + money(c.volume) + '</td></tr>'; });
  s5 += '</tbody></table><table style="margin-top:6px"><thead><tr><th>' + t('report.topCirc') + '</th><th>' + t('report.thCards') + '</th></tr></thead><tbody>';
  (sum.topCirculation || []).slice(0, 3).forEach(function (c) { s5 += '<tr><td>' + (c.filmName || '?') + '</td><td>' + (c.uniqueCards || 0) + '</td></tr>'; });
  s5 += '</tbody></table></section>';
  // headline（摘要，i18n 拼）
  const hl = [];
  if (sum.rangeStart && sum.rangeEnd) hl.push(sum.rangeStart.slice(0, 10) + ' ~ ' + sum.rangeEnd.slice(0, 10));
  if (sum.totalTrades) hl.push(sum.totalTrades + ' ' + t('report.trades'));
  if (pa.tier !== 'nodata') hl.push(t('report.paVerdict.' + pa.tier));
  if (st.main) hl.push(st.main.rarity + ' ' + t('report.dominant') + '(' + pct(st.main.pct) + ')');
  hl.push(t('report.flow.' + lq.flow));
  hl.push(t('report.hhiTier.' + st.hhiTier));
  return '<!DOCTYPE html><html lang="' + lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="' + logoUrl + '"><title>' + t('report.title') + '</title><style>' + _rptCSS() + '</style></head><body>'
    + '<button class="rpt-btn" onclick="window.print()">' + t('report.print') + '</button>'
    + '<header><h1>' + t('report.title') + '</h1><div class="headline">' + hl.join(' ｜ ') + '</div><div class="meta">' + t('report.range') + ' ' + (sum.rangeStart || '').slice(0, 10) + ' ~ ' + (sum.rangeEnd || '').slice(0, 10) + '（' + t('report.excludeToday') + '）· ' + t('report.sample') + ' ' + total + ' ' + t('report.trades') + ' · ' + t('report.generated') + ' ' + genTime + '</div></header>'
    + s13 + s2 + s4 + s5
    + '<footer>' + t('report.footer') + '</footer></body></html>';
}
function openMarketReport() {
  const all = (state && state.marketHistory) || [];
  if (!all.length) { showToast(t('marketData.empty') || '暂无成交数据', 'error'); return; }
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  // 排除当天（未结束，数据不完整）；统计基准日 = 昨天
  const yd = new Date(now.getTime() - 86400000);
  const yesterday = yd.getFullYear() + '-' + String(yd.getMonth() + 1).padStart(2, '0') + '-' + String(yd.getDate()).padStart(2, '0');
  const hist = all.filter(function (tr) { const d = (tr.tradedAt || '').slice(0, 10); return d && d <= yesterday; });
  if (!hist.length) { showToast('暂无完整历史数据（已排除当天）', 'error'); return; }
  const genTime = today + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const sum = computeMarketSummary(hist, null, yesterday);
  const a = analyzeMarket(sum);
  const html = _rptBuildHtml(sum, a, hist.length, genTime, location.origin + '/logo.png');
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url);
  setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
}

// 每日掉落柱状图：稀有度堆叠（N→R→SR→SSR→UR），金银铜标 Top3 含金量日，自定义 hover tooltip，7/30/90/全部 可切换
function buildDropChart(sum) {
  const section = el('div', { cls: 'drop-section drop-chart-section' });
  const head = el('div', { cls: 'drop-chart-head' });
  append(head, el('div', { cls: 'drop-section-title drop-chart-title', text: t('dropStats.daily') }));
  const btns = el('div', { cls: 'drop-range-btns' });
  [7, 30, 90, 'all'].forEach((rng) => {
    const label = rng === 'all' ? t('dropStats.rangeAll') : t('dropStats.rangeN', { n: rng });
    const b = el('button', { cls: 'drop-range-btn' + (dropChartRange === rng ? ' active' : ''), text: label });
    b.onclick = () => { dropChartRange = rng; renderDropStats(); };
    btns.appendChild(b);
  });
  append(head, btns);
  append(section, head);

  const all = sum.dailyFull || [];
  const series = dropChartRange === 'all' ? all : all.slice(-dropChartRange);
  let maxCount = 0;
  for (const d of series) if (d.count > maxCount) maxCount = d.count;
  // 金/银/铜：Top3 含金量日的名次（1/2/3）
  const medal = {};
  (sum.top3Days || []).forEach((d, i) => { medal[d.date] = i + 1; });
  const order = ['N', 'R', 'SR', 'SSR', 'UR']; // 自底向上堆叠
  const step = Math.max(1, Math.ceil(series.length / 6));

  const scroll = el('div', { cls: 'drop-chart-scroll' });
  const wrap = el('div', { cls: 'drop-chart-wrap' });
  const tip = el('div', { cls: 'drop-chart-tip tip-inset' });
  const bars = el('div', { cls: 'drop-chart-bars' });
  const axis = el('div', { cls: 'drop-chart-axis' });

  series.forEach((d, i) => {
    const mk = medal[d.date];
    const bar = el('div', { cls: 'drop-chart-bar' + (mk ? ' medal-' + mk : '') + (d.count > 0 ? '' : ' zero') });
    if (d.count > 0 && maxCount > 0) {
      order.forEach((r) => {
        const n = (d.rarity && d.rarity[r]) || 0;
        if (n > 0) bar.appendChild(el('div', { cls: 'drop-chart-seg r-' + r, attrs: { style: 'height:' + (n / maxCount * 100) + '%' } }));
      });
    }
    bar.onmouseenter = () => {
      bars.classList.add('hovering');
      bar.classList.add('hover');
      const kids = [el('span', { cls: 'dct-date', text: d.date })];
      if (mk) kids.push(el('span', { cls: 'dct-medal medal-' + mk, text: ['🥇', '🥈', '🥉'][mk - 1] + ' #' + mk }));
      kids.push(el('span', { cls: 'dct-total', text: d.count + ' ' + t('common.unitCards') }));
      order.forEach((r) => {
        const n = (d.rarity && d.rarity[r]) || 0;
        if (n > 0) {
          const item = el('span', { cls: 'dct-item' });
          item.appendChild(el('span', { cls: 'dct-dot r-' + r }));
          item.appendChild(document.createTextNode(r + '×' + n));
          kids.push(item);
        }
      });
      tip.replaceChildren.apply(tip, kids);
      tip.classList.add('show');
    };
    bar.onmouseleave = () => {
      bars.classList.remove('hovering');
      bar.classList.remove('hover');
      tip.classList.remove('show');
    };
    bars.appendChild(bar);
    const slot = el('div', { cls: 'drop-chart-axis-slot' });
    if (i % step === 0 || i === series.length - 1) slot.textContent = d.date.slice(5);
    axis.appendChild(slot);
  });

  append(wrap, tip, bars, axis);
  append(scroll, wrap);
  append(section, scroll);
  return section;
}

function dropKpi(label, val, unit) {
  const tile = el('div', { cls: 'drop-kpi-tile' });
  const numrow = el('div', { cls: 'drop-kpi-numrow' });
  append(numrow,
    el('span', { cls: 'drop-kpi-val', text: String(val) }),
    el('span', { cls: 'drop-kpi-unit', text: unit || '' })
  );
  append(tile, numrow, el('div', { cls: 'drop-kpi-label', text: label }));
  return tile;
}

// ============ 魔力符券使用记录卡片（挂掉落统计末尾） ============
// bonus 千分位格式化：<1e3 原值，<1e6 → x.xK，else → x.xM
function fmtK(v) {
  v = Number(v) || 0;
  if (v < 1e3) return String(Math.round(v));
  if (v < 1e6) return (v / 1e3).toFixed(1) + 'K';
  return (v / 1e6).toFixed(1) + 'M';
}
// 价格显示：5 位及以下(<1e5)完整千分位；5 位以上 K/M/B 缩写（完整值由 title 悬浮显示）
function fmtPrice(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1e5) return fmtNum(n);
  if (abs < 1e6) return Math.round(n / 1e3) + 'K';
  if (abs < 1e9) return (n / 1e6).toFixed(abs < 1e7 ? 1 : 0) + 'M';
  return (n / 1e9).toFixed(1) + 'B';
}

// SVG 元素 helper（createElementNS；折线图用，保持无 innerHTML 风格）
function svgEl(tag, opts) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  opts = opts || {};
  if (opts.cls) e.setAttribute('class', opts.cls);
  if (opts.text != null) e.textContent = opts.text;
  if (opts.attrs) for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
  return e;
}

function renderCardLogCard() {
  const sum = state && state.cardLogSummary;
  const card = el('div', { cls: 'drop-section cardlog-card' });
  append(card, el('div', { cls: 'drop-section-title cardlog-card-title', text: '🎴 ' + t('cardLog.title') }));
  if (!sum) {
    card.appendChild(el('div', { cls: 'drop-empty-tip', text: t('cardLog.empty') }));
    return card;
  }
  const volKey = sum.volatility === 'high' ? 'cardLog.volHigh' : (sum.volatility === 'mid' ? 'cardLog.volMid' : 'cardLog.volLow');
  // 8 个统计合为一组 KPI（4 列 × 2 行）：核心 4 + 运气 4
  const kpi = el('div', { cls: 'drop-kpi cardlog-kpi' });
  append(kpi,
    dropKpi(t('cardLog.count'), sum.count, t('cardLog.unitCard')),
    dropKpi(t('cardLog.sum'), fmtK(sum.sum), ''),
    dropKpi(t('cardLog.avg'), fmtK(sum.avg), t('cardLog.unitPerCard')),
    dropKpi(t('cardLog.median'), fmtK(sum.median), t('cardLog.unitPerCard')),
    dropKpi(t('cardLog.max'), fmtK(sum.max), ''),
    dropKpi(t('cardLog.min'), fmtK(sum.min), ''),
    dropKpi(t('cardLog.lucky'), sum.lucky.toFixed(1) + 'x', ''),
    dropKpi(t('cardLog.volatility'), t(volKey), '')
  );
  append(card, kpi, buildCardLogDistChart(sum), buildCardLogSeriesChart(sum));
  return card;
}

// 收益分布横向条形图（仿稀有度分布 drop-bars）：4 档 0-10K / 10-30K / 30-50K / 50K+
function buildCardLogDistChart(sum) {
  const block = el('div', { cls: 'cardlog-block' });
  append(block, el('div', { cls: 'drop-section-title', text: t('cardLog.distribution') }));
  const labels = ['0-10K', '10-30K', '30-50K', '50K+'];
  const buckets = sum.buckets || [0, 0, 0, 0];
  const total = buckets.reduce((a, b) => a + b, 0) || 1;
  const bars = el('div', { cls: 'drop-bars' });
  buckets.forEach((c, i) => {
    const pct = c / total * 100;
    const track = el('div', { cls: 'drop-bar-track' });
    track.appendChild(el('div', { cls: 'drop-bar-fill r-UR', attrs: { style: 'width:' + pct + '%' } }));
    const row = el('div', { cls: 'drop-bar-row' });
    append(row,
      el('span', { cls: 'drop-bar-label r-UR', text: labels[i] }),
      track,
      el('span', { cls: 'drop-bar-count', text: c + ' · ' + pct.toFixed(0) + '%' })
    );
    bars.appendChild(row);
  });
  block.appendChild(bars);
  return block;
}

// 历史开卡曲线：全宽面积折线（百分比坐标 + non-scaling-stroke + HTML 坐标轴 + 渐变填充 + hover）
function buildCardLogSeriesChart(sum) {
  const block = el('div', { cls: 'cardlog-block' });
  append(block, el('div', { cls: 'drop-section-title', text: t('cardLog.series') }));
  const series = sum.series || [];
  if (series.length < 2) {
    block.appendChild(el('div', { cls: 'drop-empty-tip', text: t('cardLog.empty') }));
    return block;
  }
  const vals = series.map((s) => s.bonus);
  const max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
  const range = (max - min) || 1, n = series.length;
  const PADY = 6;
  const px = (i) => (n === 1 ? 50 : i / (n - 1) * 100).toFixed(2);
  const py = (v) => (PADY + (1 - (v - min) / range) * (100 - 2 * PADY)).toFixed(2);
  const pts = series.map((s, i) => px(i) + ',' + py(s.bonus)).join(' ');
  const areaPts = px(0) + ',' + (100 - PADY) + ' ' + pts + ' ' + px(n - 1) + ',' + (100 - PADY);

  const wrap = el('div', { cls: 'cardlog-line-wrap' });
  const tip = el('div', { cls: 'drop-chart-tip' });
  // Y 轴刻度（HTML 叠加，百分比定位，不变形）
  const yaxis = el('div', { cls: 'cardlog-yaxis' });
  [max, (min + max) / 2, min].forEach((val) => {
    const lab = el('span', { cls: 'cardlog-axis-label', text: fmtK(val) });
    lab.style.top = py(val) + '%';
    yaxis.appendChild(lab);
  });
  // SVG：viewBox 0-100 百分比坐标 + preserveAspectRatio:none 撑满；stroke 用 non-scaling 不变形
  const svg = svgEl('svg', { cls: 'cardlog-line', attrs: { viewBox: '0 0 100 100', preserveAspectRatio: 'none' } });
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { attrs: { id: 'cardlog-grad', x1: '0', y1: '0', x2: '0', y2: '1' } });
  grad.appendChild(svgEl('stop', { cls: 'cardlog-grad-from', attrs: { offset: '0%' } }));
  grad.appendChild(svgEl('stop', { cls: 'cardlog-grad-to', attrs: { offset: '100%' } }));
  defs.appendChild(grad);
  svg.appendChild(defs);
  [max, (min + max) / 2, min].forEach((val) => {
    svg.appendChild(svgEl('line', { cls: 'cardlog-grid', attrs: { x1: 0, y1: py(val), x2: 100, y2: py(val) } }));
  });
  svg.appendChild(svgEl('polygon', { cls: 'cardlog-area', attrs: { points: areaPts } }));
  svg.appendChild(svgEl('polyline', { cls: 'cardlog-stroke', attrs: { points: pts } }));
  // hover 圆点（HTML 叠加：固定 px 圆形不受 SVG 拉伸；颜色用 accent 区分折线）
  const dots = el('div', { cls: 'cardlog-dots' });
  series.forEach((s, i) => {
    const dot = el('div', { cls: 'cardlog-dot' });
    dot.style.left = px(i) + '%';
    dot.style.top = py(s.bonus) + '%';
    dot.addEventListener('mouseenter', () => {
      tip.replaceChildren(el('span', { cls: 'dct-date', text: (s.date || '').slice(5, 16) || '—' }), el('span', { cls: 'dct-total', text: fmtK(s.bonus) }));
      tip.classList.add('show');
    });
    dot.addEventListener('mouseleave', () => { tip.classList.remove('show'); });
    dots.appendChild(dot);
  });
  // X 轴刻度（HTML 叠加，百分比定位）
  const xaxis = el('div', { cls: 'cardlog-xaxis' });
  [0, Math.floor((n - 1) / 2), n - 1].forEach((i) => {
    const lab = el('span', { cls: 'cardlog-axis-label', text: '#' + (i + 1) });
    lab.style.left = px(i) + '%';
    xaxis.appendChild(lab);
  });
  append(wrap, yaxis, tip, svg, dots, xaxis);
  block.appendChild(wrap);
  return block;
}

// ---------- 用户画像 view（身份头 + 速写 + 雷达&五维详情 + 消费人格 + 运气构成）----------
// 聚合 profile(余额/头像) + bonus(产能 finalBs) + 交易记录(收支) + 掉落(运气) + 符券(博弈) → computePortrait
function renderPortraitView() {
  const box = $('portraitView');
  if (!box) return;
  box.style.display = '';
  box.replaceChildren();
  const p = state.profile || {};
  const bn = state.bonus || {};
  const ds = (state.dropStats && state.dropStats.summary) || {};
  const cl = state.cardLogSummary || {};
  const tr = computeTradeStats(resolvedTrades());
  const pt = computePortrait({
    bonus: p.bonus, finalBs: bn.finalBs,
    buySum: tr.buy.sum, sellSum: tr.sell.sum, buyCount: tr.buy.count, sellCount: tr.sell.count,
    spanDays: Math.max(1, Math.ceil((Date.now() - Date.parse(PORTRAIT_SPAN_SINCE)) / 86400000)), rarityScore: ds.rarityScore,
    cardCount: cl.count, cardAvg: cl.avg, cardMax: cl.max, cardMin: cl.min,
  });

  // 文案查 i18n（portrait.js 只产 key + 原始值，文案全走 locales）
  const tierL = t('portrait.wealth.' + pt.wealth.key);
  const luckL = t('portrait.luck.' + pt.luckKey);
  const gambleL = t('portrait.gamble.' + pt.gambleKey);
  const styleL = t('portrait.style.' + pt.styleKey);
  const mech = t('portrait.' + pt.mechKey, { n: Math.round(pt.dayIncome) });
  const nickname = t('portrait.nick', { mod: t('portrait.trendMod.' + pt.trend.key), tier: tierL, luck: luckL, gamble: portraitGambleNick(pt) });
  const identity = t('portrait.' + pt.narrativeIdKey, { tier: tierL, mech: mech });
  const spending = t('portrait.' + pt.spendingKey, { style: styleL, n: Math.round(pt.daySpend), days: (pt.trend.daysLeft != null ? pt.trend.daysLeft : '∞') });
  const luckLine = t('portrait.' + pt.luckLineKey, { luck: luckL, gamble: gambleL });

  const rs = $('resultSummary');
  if (rs) rs.replaceChildren(el('span', { text: t('portrait.title') + ' · ' }), el('b', { text: nickname }));

  // 氛围色：Hero 背景跟随财富等级
  box.style.setProperty('--tier-color', pt.tierColor || 'var(--accent)');

  // 1. 身份头 Hero：头像+名+徽章 / 角色称号 / 签名指标
  const hero = el('div', { cls: 'pt-hero' });
  const head = el('div', { cls: 'pt-hero-id' });
  if (p.avatarUrl) head.appendChild(el('img', { cls: 'pt-avatar', attrs: { src: p.avatarUrl, alt: '' } }));
  append(head, el('div', { cls: 'pt-name', text: p.username || '?' }), el('div', { cls: 'pt-sub', text: (getI18nLang() === 'en' ? roleFullLabel(p.role) : (ROLE_MAP[p.role] || p.role || '-')) }));
  const badge = el('div', { cls: 'pt-badge' });
  append(badge, el('span', { cls: 'pt-badge-icon', text: '🏆' }), el('span', { cls: 'pt-badge-label', text: tierL }));
  head.appendChild(badge);
  append(hero, head);
  append(hero, el('div', { cls: 'pt-nickname', text: nickname }));
  const signs = el('div', { cls: 'pt-signs' });
  append(signs,
    ptSign(fmtNum(pt.wealth.bonus), t('common.magic')),
    ptSign(Math.round(pt.dayIncome) + t('portrait.unitDay'), bn.finalBs ? t('portrait.perHour', { n: Math.round(bn.finalBs) }) : t('portrait.dim.income'))
  );
  hero.appendChild(signs);

  // 2. 人物速写卡（3 段：身份 / 消费 / 运气活跃）
  const narr = el('div', { cls: 'pt-narr' });
  append(narr, ptNarrLine('👤', identity), ptNarrLine('💸', spending), ptNarrLine('🍀', luckLine));

  // 3. 雷达 + 五维详情（左右）
  const chartRow = el('div', { cls: 'pt-chart-row' });
  const radar = buildPortraitRadar(pt.radar);
  const dimList = el('div', { cls: 'pt-dims' });
  pt.dims.forEach((d) => {
    const evalT = (d.key === 'income') ? t('portrait.incomeEval.' + d.evalKey)
      : (d.key === 'spend') ? t('portrait.spendEval.' + d.evalKey)
      : t('portrait.' + d.key + '.' + d.evalKey);
    dimList.appendChild(ptDim({ icon: d.icon, label: t('portrait.dim.' + d.key), evalT: evalT, value: d.value, unit: d.unit ? t('portrait.' + d.unit) : '', ratio: d.ratio, key: d.key }));
  });
  append(chartRow, radar, dimList);

  // 4. 消费人格（买卖构成 / 净收支 / 最大单笔 / 风格）
  const spendPanel = el('div', { cls: 'pt-panel' });
  spendPanel.appendChild(el('div', { cls: 'pt-panel-title', text: t('portrait.spendProfile') }));
  const spendGrid = el('div', { cls: 'pt-panel-grid' });
  append(spendGrid,
    ptMini(t('portrait.bought'), tr.buy.count + ' ' + t('common.unitCards'), Math.round(tr.buy.sum).toLocaleString() + ' ' + t('common.magic')),
    ptMini(t('portrait.sold'), tr.sell.count + ' ' + t('common.unitCards'), Math.round(tr.sell.sum).toLocaleString() + ' ' + t('common.magic')),
    ptMini(t('portrait.net'), (tr.net >= 0 ? '+' : '') + Math.round(tr.net).toLocaleString(), tr.net > 0 ? t('portrait.netOut') : (tr.net < 0 ? t('portrait.netIn') : '')),
    ptMini(t('portrait.topBuy'), tr.topBuy != null ? (Math.round(tr.topBuy).toLocaleString() + ' ' + t('common.magic')) : '—', ''),
    ptMini(t('portrait.topSell'), tr.topSell != null ? (Math.round(tr.topSell).toLocaleString() + ' ' + t('common.magic')) : '—', ''),
    ptMini(t('portrait.style'), styleL, '')
  );
  spendPanel.appendChild(spendGrid);

  // 5. 运气构成（稀有度分布 + Top3 含金量日）
  const luckPanel = el('div', { cls: 'pt-panel' });
  luckPanel.appendChild(el('div', { cls: 'pt-panel-title', text: t('portrait.luckProfile') }));
  const rarBars = el('div', { cls: 'pt-rar-bars' });
  const totalC = ds.totalCards || 0;
  ['UR', 'SSR', 'SR', 'R', 'N'].forEach((r) => {
    const c = (ds.rarityCount && ds.rarityCount[r]) || 0;
    const pct = totalC ? (c / totalC * 100) : 0;
    const row = el('div', { cls: 'pt-rar-row' });
    const track = el('div', { cls: 'pt-rar-track' });
    track.appendChild(el('div', { cls: 'pt-rar-fill r-' + r, attrs: { style: 'width:' + pct + '%' } }));
    append(row, el('span', { cls: 'pt-rar-lab r-' + r, text: r }), track, el('span', { cls: 'pt-rar-cnt', text: c + ' · ' + pct.toFixed(0) + '%' }));
    rarBars.appendChild(row);
  });
  const top3 = el('div', { cls: 'pt-top3' });
  (ds.top3Days || []).forEach((d, i) => {
    top3.appendChild(el('span', { cls: 'pt-top3-chip medal-' + (i + 1), text: ['🥇', '🥈', '🥉'][i] + ' ' + d.date.slice(5) + ' · ' + d.score }));
  });
  // 5b. 符券博弈摘要（开卡数 / 总收益 / 最高单卡 / 幸运倍率）；未开卡显 —
  const hasCard = cl && cl.count > 0;
  const cardGrid = el('div', { cls: 'pt-panel-grid' });
  append(cardGrid,
    ptMini(t('portrait.cardCount'), hasCard ? cl.count + ' ' + t('common.unitCards') : '—', ''),
    ptMini(t('portrait.cardSum'), hasCard ? Math.round(cl.sum).toLocaleString() + ' ' + t('common.magic') : '—', ''),
    ptMini(t('portrait.cardAvg'), hasCard ? Math.round(cl.avg).toLocaleString() + ' ' + t('common.magic') : '—', ''),
    ptMini(t('portrait.cardMax'), hasCard ? Math.round(cl.max).toLocaleString() + ' ' + t('common.magic') : '—', ''),
    ptMini(t('portrait.cardMin'), hasCard ? Math.round(cl.min).toLocaleString() + ' ' + t('common.magic') : '—', ''),
    ptMini(t('portrait.cardLucky'), hasCard ? Number(cl.lucky).toFixed(1) + 'x' : '—', '')
  );
  append(luckPanel, rarBars, top3, el('div', { cls: 'pt-panel-sub', text: t('portrait.gambleSection') }), cardGrid);

  append(box, hero, narr, chartRow, spendPanel, luckPanel);
}

// ============ 市场数据 view ============
var mdFilter = null;  // { rarities:Set, provenances:Set, titles:Set, dateFrom:'', dateTo:'' } 或 null
var mdChartSeries = 'volprice'; // volprice（量价叠加） | dist（价格分布） | hour（小时分布）
var mdChartRange = 30;         // 7 | 30 | 90 | 'all'（仅 volprice 用）
var mdChartMetric = 'count';   // count | volume（volprice 时柱的指标 toggle）
var mdCardRankTab = 'hot';    // expensive | hot | volume | circulation（卡视角，价格区）
var mdPeopleRankTab = 'buyerCount'; // buyerCount | buyerVolume | sellerCount | sellerVolume | flips（人视角，玩家区）
var mdCardRankLimit = 20;      // 卡视角 top-N，滚动到底 +20
var mdPeopleRankLimit = 20;    // 人视角 top-N，滚动到底 +20
var mdRankScroll = {};         // 排行滚动位置缓存：key=sec-tab → scrollTop（renderMarketData 重建时保持，各 tab/排行榜独立）
var mdCardSearch = '';         // 卡视角片名搜索（实时过滤 list）
var mdPeopleSearch = '';       // 人视角 uid 搜索（实时过滤 list + 详情卡）
// sum 缓存：sum 只依赖 mdFilter + hist，不依赖搜索词（mdCardSearch/mdPeopleSearch 是聚合后过滤）。
// 搜索按键 → renderMarketData → mdFilter 不变 → sig 同 + hist 同引用 → 复用 sum（跳过 computeMarketSummary 重算）；
// 筛选变化（mdFilter 变）/ 数据更新（hist 新引用）→ sig 或 ref 变 → 重算并更新缓存。
var mdSumCache = null, mdSumFilterSig = '', mdSumHistRef = null;
// 交易记录查询 tab 态（v0.3.2）
var mdActiveTab = 'overview';   // overview | trades
var mdTradeFilter = null;        // 交易记录 tab 独立筛选（不跨 tab），结构同 mdFilter
var mdTradeSearch = '';          // 交易记录搜索词（片名/uid）
var mdTradeDir = 'both';         // 方向筛选 both | buy | sell
var mdListPage = 1;              // 交易记录当前页码
var mdSortKey = null;     // null = 时间降序（默认）| 'price' | 'time'(升序，desc 归一为 null)
var mdSortDir = 'desc';   // desc | asc
function renderMarketData() {
  const box = $('marketDataView');
  if (!box) return;
  box.style.display = '';
  _mdSaveRankScroll(box);
  box.replaceChildren();
  const hist = (state && state.marketHistory) || [];
  const rs = $('resultSummary');
  if (rs) rs.replaceChildren(
    el('span', { text: t('marketData.title') + ' · ' }),
    el('b', { text: String(hist.length) }),
    el('span', { text: t('common.unitTrades') })
  );
  if (!hist.length) {
    const empty = el('div', { cls: 'drop-empty' });
    append(empty,
      el('div', { cls: 'drop-empty-ico', text: '📈' }),
      el('div', { cls: 'drop-empty-tip', text: t('marketData.empty') })
    );
    box.appendChild(empty);
    return;
  }
  // sum 缓存：搜索按键（mdCardSearch/mdPeopleSearch 变）不改 mdFilter → 复用 sum 跳过聚合重算；筛选/数据更新才重算
  const sig = mdFilter
    ? (['rarities', 'provenances', 'titles'].reduce(function (s, k) { return s + Array.from(mdFilter[k] || []).sort().join(',') + '|'; }, '') + (mdFilter.dateFrom || '') + '~' + (mdFilter.dateTo || ''))
    : 'null';
  let sum;
  if (mdSumCache && sig === mdSumFilterSig && hist === mdSumHistRef) {
    sum = mdSumCache;
  } else {
    var _nd = new Date();
    sum = computeMarketSummary(hist, mdFilter, _nd.getFullYear() + '-' + String(_nd.getMonth() + 1).padStart(2, '0') + '-' + String(_nd.getDate()).padStart(2, '0'));
    mdSumCache = sum; mdSumFilterSig = sig; mdSumHistRef = hist;
  }
  box.appendChild(buildMdTabs());                    // tab 条（两 tab 共有）
  if (mdActiveTab === 'trades') {
    box.appendChild(buildTradeView(hist));           // 交易记录查询区
    return;
  }
  // —— 以下为 overview 分支（原逻辑，sum 缓存 + 三区）——
  box.appendChild(buildMarketFilter(hist, sum));   // 筛选条（含样本量）
  box.appendChild(buildOverviewSection(sum));       // 区一：市场总览（全宽）
  const twoColA = el('div', { cls: 'md-two-col' });
  append(twoColA, buildPriceSection(sum), buildPlayersSection(sum)); // 区二 价格分析 ‖ 玩家行为(我的画像)
  box.appendChild(twoColA);
  const twoColB = el('div', { cls: 'md-two-col' });
  append(twoColB, buildMarketRank(sum, 'card'), buildMarketRank(sum, 'people')); // 区三 卡视角 ‖ 人视角 排行
  box.appendChild(twoColB);
  _mdRestoreRankScroll(box);
}

// 排行滚动位置保持：renderMarketData 整体重建 #marketDataView 时，各 .md-rank-list 的 scrollTop 会归零。
// 按 data-rank-sec + data-rank-tab（DOM 实际显示的 tab，非全局态——切 tag 的 onclick 会先改全局态）缓存，
// 重建前后保存/恢复，使每个排行榜、每个 tag 的滚动相互独立（卡视角滚动不受人视角切 tag 影响）。
function _mdSaveRankScroll(box) {
  box.querySelectorAll('.md-rank-list').forEach(function (w) {
    mdRankScroll[w.getAttribute('data-rank-sec') + '-' + w.getAttribute('data-rank-tab')] = w.scrollTop;
  });
}
function _mdRestoreRankScroll(box) {
  box.querySelectorAll('.md-rank-list').forEach(function (w) {
    const v = mdRankScroll[w.getAttribute('data-rank-sec') + '-' + w.getAttribute('data-rank-tab')];
    if (v != null) w.scrollTop = v;
  });
}
// 市场数据 view 顶部 tab 条：市场总览 | 交易记录查询
function buildMdTabs() {
  const wrap = el('div', { cls: 'md-tabs' });
  [['overview', 'marketData.tabOverview'], ['trades', 'marketData.tabTrades']].forEach(function (p) {
    const b = el('button', { cls: 'seg-btn md-tab' + (mdActiveTab === p[0] ? ' on' : ''), attrs: { type: 'button' }, text: t(p[1]) });
    b.onclick = function () { mdActiveTab = p[0]; renderMarketData(); };
    wrap.appendChild(b);
  });
  // 生成报告按钮（紧随交易记录查询 tab，绿色动作按钮，非 tab）
  const rpt = el('button', { cls: 'seg-btn md-tab md-report', attrs: { type: 'button' }, text: '📄 ' + t('marketData.report') });
  rpt.onclick = openMarketReport;
  wrap.appendChild(rpt);
  return wrap;
}

// 交易记录查询 tab 编排：筛选条（含搜索+方向）→ 列表+分页
function buildTradeView(hist) {
  const wrap = el('div', { cls: 'md-trade-view' });
  const filtered = filterTrades(hist, mdTradeFilter, mdTradeSearch, mdTradeDir);
  wrap.appendChild(buildTradeFilter(hist, filtered.length, hist.length));
  wrap.appendChild(buildTradeList(filtered, filtered.length));
  return wrap;
}

// 交易记录筛选条：rarity/provenance/title chip（绑 mdTradeFilter）+ 日期 + 搜索框 + 方向 chip + 匹配药丸/清除
function buildTradeFilter(hist, matchCount, total) {
  const wrap = el('div', { cls: 'market-filter md-trade-filter' });
  const facets = extractFacets(hist);
  const rarities = (typeof RARITIES !== 'undefined' && RARITIES) || ['UR', 'SSR', 'SR', 'R', 'N'];
  const f = mdTradeFilter || { rarities: new Set(), provenances: new Set(), titles: new Set(), dateFrom: '', dateTo: '' };
  // chip 点击改 mdTradeFilter + 页码重置 1 + 重渲染
  function setFilter(next) { mdTradeFilter = next; mdListPage = 1; renderMarketData(); }
  function chipGroup(labelKey, values, key, clsFn, textFn) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('span', { cls: 'chip-group-label', text: t(labelKey) }));
    const box = el('div', { cls: 'chips' });
    values.forEach(function (v) {
      const on = mdTradeFilter && mdTradeFilter[key] && mdTradeFilter[key].has(v);
      const chip = el('div', { cls: 'chip' + (clsFn ? ' ' + clsFn(v) : '') + (on ? ' on' : '') });
      append(chip, el('span', { cls: 'dot' }), el('span', { text: textFn ? textFn(v) : v }));
      chip.addEventListener('click', function () {
        let cur = mdTradeFilter;
        if (!cur) cur = { rarities: new Set(), provenances: new Set(), titles: new Set(), dateFrom: '', dateTo: '' };
        const s = cur[key];
        if (s.has(v)) s.delete(v); else s.add(v);
        if (!cur.rarities.size && !cur.provenances.size && !cur.titles.size && !cur.dateFrom && !cur.dateTo) cur = null;
        setFilter(cur);
      });
      box.appendChild(chip);
    });
    frag.appendChild(box);
    return frag;
  }
  // 稀有度/来源/称号 一行
  const chipsRow = el('div', { cls: 'mf-row' });
  chipsRow.appendChild(chipGroup('marketData.filterRarity', rarities, 'rarities', function (v) { return 'r-' + v; }));
  if (facets.provenances.length > 1) chipsRow.appendChild(chipGroup('marketData.filterProv', facets.provenances, 'provenances', provColorClass, provLabel));
  if (facets.titles.length > 1) chipsRow.appendChild(chipGroup('marketData.filterTitle', facets.titles, 'titles', function (v) { return 'inv-title ' + (TITLE_TIER[v] || 'tt-5'); }));
  wrap.appendChild(chipsRow);
  // 日期行
  const drow = el('div', { cls: 'mf-row' });
  drow.appendChild(el('span', { cls: 'chip-group-label', text: t('marketData.filterDate') }));
  const df = el('input', { cls: 'th-input ts-date', attrs: { type: 'date', value: f.dateFrom } });
  const dt = el('input', { cls: 'th-input ts-date', attrs: { type: 'date', value: f.dateTo } });
  df.oninput = dt.oninput = function () {
    let cur = mdTradeFilter;
    if (!cur) cur = { rarities: new Set(), provenances: new Set(), titles: new Set(), dateFrom: '', dateTo: '' };
    cur.dateFrom = df.value; cur.dateTo = dt.value;
    if (!cur.rarities.size && !cur.provenances.size && !cur.titles.size && !cur.dateFrom && !cur.dateTo) cur = null;
    setFilter(cur);
  };
  append(drow, df, el('span', { cls: 'ts-sep', text: '~' }), dt);
  wrap.appendChild(drow);
  // 搜索框 + 方向 chip 一行
  const searchRow = el('div', { cls: 'mf-row md-trade-searchrow' });
  searchRow.appendChild(buildTradeSearch());
  searchRow.appendChild(buildDirChips());
  wrap.appendChild(searchRow);
  // 匹配药丸 + 清除（仅有筛选/搜索/方向非默认时显示）
  if (mdTradeFilter || mdTradeSearch || mdTradeDir !== 'both') {
    const actionsRow = el('div', { cls: 'mf-row mf-actions' });
    const pill = el('span', { cls: 'md-pill', text: t('marketData.matchCount', { n: matchCount, m: total }) });
    const clr = el('button', { cls: 'seg-btn mini', text: t('search.clear'), attrs: { type: 'button' } });
    clr.onclick = function () { mdTradeFilter = null; mdTradeSearch = ''; mdTradeDir = 'both'; mdListPage = 1; renderMarketData(); };
    append(actionsRow, pill, clr);
    wrap.appendChild(actionsRow);
  }
  return wrap;
}

// 交易记录搜索框：复用 createSearchInput 的 composition 守卫 + 焦点恢复模式，绑 mdTradeSearch
function buildTradeSearch() {
  const wrap = el('div', { cls: 'md-rank-search-wrap' });
  const input = el('input', {
    cls: 'th-input md-rank-search',
    attrs: { type: 'text', placeholder: t('marketData.searchTrade'), 'data-md-search': 'trade' }
  });
  input.value = mdTradeSearch;
  let composing = false;
  function applySearch() {
    const v = input.value, pos = v.length;
    mdTradeSearch = v; mdListPage = 1;
    renderMarketData();
    const ni = document.querySelector('.md-rank-search[data-md-search="trade"]');
    if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (_) {} }
  }
  input.addEventListener('compositionstart', function () { composing = true; });
  input.addEventListener('compositionend', function () { composing = false; applySearch(); });
  input.oninput = function (e) { if (composing || (e && e.isComposing)) return; applySearch(); };
  wrap.appendChild(input);
  if (input.value) {
    const clr = el('span', { cls: 'md-rank-search-clr', text: '×' });
    clr.title = t('search.clear');
    clr.onclick = function () { mdTradeSearch = ''; mdListPage = 1; renderMarketData(); };
    wrap.appendChild(clr);
  }
  return wrap;
}

// 方向 chip：双向/买入/卖出（单选，绑 mdTradeDir）
function buildDirChips() {
  const box = el('div', { cls: 'chips md-dir-chips' });
  [['both', 'marketData.dirBoth'], ['buy', 'marketData.dirBuy'], ['sell', 'marketData.dirSell']].forEach(function (p) {
    const chip = el('div', { cls: 'chip md-dir' + (mdTradeDir === p[0] ? ' on' : ''), text: t(p[1]) });
    chip.onclick = function () { mdTradeDir = p[0]; mdListPage = 1; renderMarketData(); };
    box.appendChild(chip);
  });
  return box;
}

// tradedAt 'YYYY-MM-DD HH:mm:ss' → 'MM-DD HH:mm'
function mdFmtTime(s) {
  if (!s || s.length < 16) return s || '';
  return s.slice(5, 10) + ' ' + s.slice(11, 16);
}
// 数字串 → 千分位
function mdFmtNum(s) {
  if (s == null || s === '') return '';   // 缺失数据显空（Number('')===0 / Number(null)===0 会误显 "0"）
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString() : (s || '');
}

// 交易记录列表：filtered（已过滤+降序）→ 分页 slice → 表格 + 分页器
function buildTradeList(filtered, total) {
  const wrap = el('div', { cls: 'md-trade-list' });
  if (!total) {
    const empty = el('div', { cls: 'drop-empty' });
    append(empty, el('div', { cls: 'drop-empty-ico', text: '📋' }), el('div', { cls: 'drop-empty-tip', text: t('marketData.emptyTrades') }));
    wrap.appendChild(empty);
    return wrap;
  }
  const PER = 50;
  const pages = Math.max(1, Math.ceil(total / PER));
  if (mdListPage > pages) mdListPage = pages;
  if (mdListPage < 1) mdListPage = 1;
  const page = mdListPage;
  // 搜 uid（mdTradeSearch 纯数字）时：高亮买家/卖家命中格（B1）+ 方向相对该 uid 角色（B3）
  const uid = (mdTradeSearch && /^\d+$/.test(mdTradeSearch)) ? mdTradeSearch : null;
  // 排序（B2）：null = 时间降序（filtered 原序）；'time' = 时间升序（旧→新）；'price' = 价格
  let list = filtered;
  if (mdSortKey === 'price') {
    list = filtered.slice().sort(function (a, b) {
      return (Number(a.price) || 0) - (Number(b.price) || 0);
    });
    if (mdSortDir === 'desc') list.reverse();   // desc = 高→低
  } else if (mdSortKey === 'time') {
    list = filtered.slice().sort(function (a, b) {
      return (parseMtTime(a.tradedAt) || 0) - (parseMtTime(b.tradedAt) || 0);  // 升序 = 旧→新
    });
  }
  const slice = list.slice((page - 1) * PER, page * PER);
  // 表格
  const table = el('table', { cls: 'md-trade-table' });
  const thead = el('thead', {});
  const headRow = el('tr', {});
  // 价格 th 可点排序（B2）：当前 key 显 ↓/↑ 指示
  const priceTh = el('th', { cls: 'md-th-sort' + (mdSortKey === 'price' ? ' active' : '') });
  priceTh.textContent = t('marketData.colPrice') + (mdSortKey === 'price' ? (mdSortDir === 'desc' ? ' ↓' : ' ↑') : '');
  priceTh.onclick = function () {
    if (mdSortKey === 'price') mdSortDir = (mdSortDir === 'desc' ? 'asc' : 'desc');
    else { mdSortKey = 'price'; mdSortDir = 'desc'; }
    mdListPage = 1;   // 排序变化后回第 1 页（看最高/最低）
    renderMarketData();
  };
  // 时间 th 可点排序：当前时间排序中(null/'time')高亮；点切 ↓↔↑，从价格切来 → 回默认↓
  const timeOn = (mdSortKey === null || mdSortKey === 'time');
  const timeTh = el('th', { cls: 'md-th-sort' + (timeOn ? ' active' : '') });
  timeTh.textContent = t('marketData.colTime') + (timeOn ? (mdSortDir === 'desc' ? ' ↓' : ' ↑') : '');
  timeTh.onclick = function () {
    if (mdSortKey === 'time') { mdSortKey = null; mdSortDir = 'desc'; }        // ↑ → ↓(默认)
    else if (mdSortKey === null) { mdSortKey = 'time'; mdSortDir = 'asc'; }    // ↓ → ↑
    else { mdSortKey = null; mdSortDir = 'desc'; }                             // price → 回默认↓
    mdListPage = 1;
    renderMarketData();
  };
  append(headRow,
    timeTh,
    el('th', { text: t('marketData.colFilm') }),
    el('th', { text: t('marketData.colRarity') }),
    el('th', { text: t('marketData.colTitle') }),
    el('th', { text: t('marketData.colBuyer') }),
    el('th', { text: t('marketData.colSeller') }),
    priceTh,
    el('th', { text: t('marketData.colFee') }),
    el('th', { text: t('marketData.colDir') })
  );
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody', {});
  slice.forEach(function (r) {
    const dir = tradeDirection(r, uid);
    const dirKey = dir === 'buy' ? 'marketData.dirBuy' : (dir === 'sell' ? 'marketData.dirSell' : null);
    const tr = el('tr', {});
    // 稀有度彩色标签（复用 r-XX 配色；无 rarity 则空）
    const tdRar = el('td', { cls: 'md-td-rarity' });
    if (r.rarity) append(tdRar, el('span', { cls: 'md-rarity-tag r-' + r.rarity, text: r.rarity }));
    // 方向药丸
    const tdDir = el('td', { cls: 'md-td-dir' });
    if (dirKey) append(tdDir, el('span', { cls: 'md-dir-tag ' + dir, text: t(dirKey) }));
    else append(tdDir, el('span', { cls: 'md-dir-tag both', text: '—' }));
    // 买家/卖家：搜 uid 命中格高亮；uid 超链接（纯数字，点击新 tab 跳资料页）
    const tdBuyer = el('td', { cls: 'md-td-buyer' + (uid && r.buyerId === uid ? ' md-uid-hit' : '') });
    if (r.buyerId != null && r.buyerId !== '') tdBuyer.appendChild(mdUidLink(r.buyerId, false));
    const tdSeller = el('td', { cls: 'md-td-seller' + (uid && r.sellerId === uid ? ' md-uid-hit' : '') });
    if (r.sellerId != null && r.sellerId !== '') tdSeller.appendChild(mdUidLink(r.sellerId, false));
    append(tr,
      el('td', { cls: 'md-td-time', text: mdFmtTime(r.tradedAt) }),
      el('td', { cls: 'md-td-film', text: r.filmName || '' }),
      tdRar,
      el('td', { cls: 'md-td-title', text: r.title || '' }),
      tdBuyer,
      tdSeller,
      el('td', { cls: 'md-td-price mono', text: mdFmtNum(r.price) }),
      el('td', { cls: 'md-td-fee mono', text: mdFmtNum(r.fee) }),
      tdDir
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  // 分页器
  if (pages > 1 || total > PER) {
    const pager = el('div', { cls: 'md-pager' });
    const prev = el('button', { cls: 'seg-btn mini', attrs: { type: 'button' }, text: t('marketData.prev') });
    if (page <= 1) prev.disabled = true;
    else prev.onclick = function () { mdListPage = page - 1; renderMarketData(); };
    const next = el('button', { cls: 'seg-btn mini', attrs: { type: 'button' }, text: t('marketData.next') });
    if (page >= pages) next.disabled = true;
    else next.onclick = function () { mdListPage = page + 1; renderMarketData(); };
    const info = el('span', { cls: 'md-pager-info', text: t('marketData.pageOf', { x: page, y: pages }) });
    append(pager, prev, info, next);
    wrap.appendChild(pager);
  }
  return wrap;
}

// provenance 原值 → 显示文本（参考市场 view 卡片详情 t('provenance.X')：real→掉落/forged→制造/mech→机制卡）
// 未知值（如 digital）回退原值；chip 的 onclick 仍存原值供筛选匹配，仅展示层映射。
function provLabel(p) {
  if (!p) return '';
  const key = 'provenance.' + p;
  const lbl = t(key);
  return (lbl && lbl !== key) ? lbl : p;
}

// 市场数据筛选条：rarity（r-XX 配色）+ provenance/称号（extractFacets 全量）+ 日期 + 样本量 + 清除
function buildMarketFilter(hist, sum) {
  const wrap = el('div', { cls: 'market-filter' });
  const facets = extractFacets(hist);
  // chip 文本可选映射（textFn）；onclick 仍存原值供筛选匹配
  function chipGroup(labelKey, values, key, clsFn, textFn) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('span', { cls: 'chip-group-label', text: t(labelKey) }));
    const box = el('div', { cls: 'chips' });
    values.forEach(function (v) {
      const on = mdFilter && mdFilter[key] && mdFilter[key].has(v);
      const chip = el('div', { cls: 'chip' + (clsFn ? ' ' + clsFn(v) : '') + (on ? ' on' : '') });
      append(chip, el('span', { cls: 'dot' }), el('span', { text: textFn ? textFn(v) : v }));
      chip.addEventListener('click', function () {
        if (!mdFilter) mdFilter = { rarities: new Set(), provenances: new Set(), titles: new Set(), dateFrom: '', dateTo: '' };
        const s = mdFilter[key];
        if (s.has(v)) s.delete(v); else s.add(v);
        const f = mdFilter;
        if (!f.rarities.size && !f.provenances.size && !f.titles.size && !f.dateFrom && !f.dateTo) mdFilter = null;
        renderMarketData();
      });
      box.appendChild(chip);
    });
    frag.appendChild(box);
    return frag;
  }
  const rarities = (typeof RARITIES !== 'undefined' && RARITIES) || ['UR', 'SSR', 'SR', 'R', 'N'];
  const f = mdFilter || { rarities: new Set(), provenances: new Set(), titles: new Set(), dateFrom: '', dateTo: '' };
  // 稀有度/来源/称号 一行（flex-wrap：放得下一行，放不下换行）
  const chipsRow = el('div', { cls: 'mf-row' });
  chipsRow.appendChild(chipGroup('marketData.filterRarity', rarities, 'rarities', function (v) { return 'r-' + v; }));
  if (facets.provenances.length > 1) chipsRow.appendChild(chipGroup('marketData.filterProv', facets.provenances, 'provenances', provColorClass, provLabel));
  if (facets.titles.length > 1) chipsRow.appendChild(chipGroup('marketData.filterTitle', facets.titles, 'titles', function (v) { return 'inv-title ' + (TITLE_TIER[v] || 'tt-5'); }));
  wrap.appendChild(chipsRow);
  const drow = el('div', { cls: 'mf-row' });
  drow.appendChild(el('span', { cls: 'chip-group-label', text: t('marketData.filterDate') }));
  const df = el('input', { cls: 'th-input ts-date', attrs: { type: 'date', value: f.dateFrom } });
  const dt = el('input', { cls: 'th-input ts-date', attrs: { type: 'date', value: f.dateTo } });
  function onDate() {
    if (!mdFilter) mdFilter = { rarities: new Set(), provenances: new Set(), titles: new Set(), dateFrom: '', dateTo: '' };
    mdFilter.dateFrom = df.value; mdFilter.dateTo = dt.value;
    const x = mdFilter;
    if (!x.rarities.size && !x.provenances.size && !x.titles.size && !x.dateFrom && !x.dateTo) mdFilter = null;
    renderMarketData();
  }
  df.oninput = onDate; dt.oninput = onDate;
  append(drow, df, el('span', { cls: 'ts-sep', text: '~' }), dt);
  wrap.appendChild(drow);
  // 样本量药丸 + 清除按钮（一行居中；仅当前有筛选时显示）
  if (mdFilter) {
    const pct = Math.round(sum.totalTrades / hist.length * 100);
    const actionsRow = el('div', { cls: 'mf-row mf-actions' });
    const pill = el('span', { cls: 'md-pill', text: t('marketData.sampleCount', { n: sum.totalTrades, pct: pct }) });
    const clr = el('button', { cls: 'seg-btn mini', text: t('search.clear'), attrs: { type: 'button' } });
    clr.onclick = function () { mdFilter = null; renderMarketData(); };
    append(actionsRow, pill, clr);
    wrap.appendChild(actionsRow);
  }
  return wrap;
}

// 市场数据走势图：序列 tab（量价叠加 / 价格分布 / 小时分布）× 时间窗（仅 volprice）× 柱指标（笔数/额，仅 volprice）
function buildMarketChart(sum) {
  const section = el('div', { cls: 'drop-section drop-chart-section' });
  const head = el('div', { cls: 'drop-chart-head' });
  append(head, el('div', { cls: 'drop-section-title drop-chart-title', text: t('marketData.chartTitle') }));
  // 序列 tab：volprice / dist / hour
  const seriesBtns = el('div', { cls: 'drop-range-btns' });
  [['volprice','marketData.seriesVolPrice'],['dist','marketData.seriesDist'],['hour','marketData.chartHour']].forEach(function (p) {
    const b = el('button', { cls: 'drop-range-btn' + (mdChartSeries === p[0] ? ' active' : ''), text: t(p[1]), attrs: { type: 'button' } });
    b.onclick = function () { mdChartSeries = p[0]; renderMarketData(); };
    seriesBtns.appendChild(b);
  });
  append(head, seriesBtns);
  // 柱指标 toggle（笔数/额）+ 时间窗（7/30/90/全部）—— 仅 volprice 显示
  if (mdChartSeries === 'volprice') {
    const mb = el('div', { cls: 'drop-range-btns' });
    [['count','marketData.chartCount'],['volume','marketData.chartVolume']].forEach(function (p) {
      const b = el('button', { cls: 'drop-range-btn' + (mdChartMetric === p[0] ? ' active' : ''), text: t(p[1]), attrs: { type: 'button' } });
      b.onclick = function () { mdChartMetric = p[0]; renderMarketData(); };
      mb.appendChild(b);
    });
    append(head, mb);
    const rb = el('div', { cls: 'drop-range-btns' });
    [[7,'marketData.range7'],[30,'marketData.range30'],[90,'marketData.range90'],['all','marketData.rangeAll']].forEach(function (p) {
      const b = el('button', { cls: 'drop-range-btn' + (mdChartRange === p[0] ? ' active' : ''), text: t(p[1]), attrs: { type: 'button' } });
      b.onclick = function () { mdChartRange = p[0]; renderMarketData(); };
      rb.appendChild(b);
    });
    append(head, rb);
  }
  append(section, head);

  const daily = sum.daily || [];
  // 堆叠柱分类（参考 buildDropChart：稀有度低→高底→顶 + MECH）；seg/dot 类名 rarity 用 r-XX、MECH 用 r-mech（小写，复用现有 --r-mech 配色）
  const MD_CAT_ORDER = ['N', 'R', 'SR', 'SSR', 'UR', 'MECH'];
  const mdCatSfx = function (cat) { return cat === 'MECH' ? 'mech' : cat; };
  const mdSegCls = function (cat) { return 'drop-chart-seg r-' + mdCatSfx(cat); };
  // tooltip 一行：cat 标签（MECH→机制卡/MECH label，rarity→原码）+ 值（count→×N，volume→fmtPrice）
  const mdCatItem = function (cat, val, isVol) {
    const item = el('span', { cls: 'dct-item' });
    item.appendChild(el('span', { cls: 'dct-dot r-' + mdCatSfx(cat) }));
    const lbl = cat === 'MECH' ? t('provenance.mech') : cat;
    item.appendChild(document.createTextNode(lbl + ' ' + (isVol ? fmtPrice(val) : '×' + val)));
    return item;
  };
  // 统一 scroll/wrap/tip/axis 骨架
  const scroll = el('div', { cls: 'drop-chart-scroll' });
  const wrap = el('div', { cls: 'drop-chart-wrap' });
  const tip = el('div', { cls: 'drop-chart-tip' });
  const axis = el('div', { cls: 'drop-chart-axis' });

  if (mdChartSeries === 'hour') {
    // 小时分布（24 柱，按稀有度+机制卡堆叠分色），沿用 .drop-chart-bars（align-items:stretch + flex-column justify-end）
    const labels = []; for (let h = 0; h < 24; h++) labels.push(String(h));
    const values = sum.hourly || [];
    const hourlyByCat = sum.hourlyByCat || [];
    let max = 0;
    for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
    const step = Math.max(1, Math.ceil(labels.length / 6));
    const bars = el('div', { cls: 'drop-chart-bars' });
    labels.forEach(function (lab, i) {
      const v = values[i] || 0;
      const bar = el('div', { cls: 'drop-chart-bar' + (v > 0 ? '' : ' zero') });
      const hc = hourlyByCat[i] || {};
      if (v > 0 && max > 0) {
        MD_CAT_ORDER.forEach(function (cat) {
          const c = hc[cat]; if (!c) return;
          const n = c.count || 0;
          if (n > 0) bar.appendChild(el('div', { cls: mdSegCls(cat), attrs: { style: 'height:' + (n / max * 100) + '%' } }));
        });
      }
      bar.onmouseenter = function () {
        bars.classList.add('hovering'); bar.classList.add('hover');
        const kids = [el('span', { cls: 'dct-date', text: lab + ':00' }), el('span', { cls: 'dct-total', text: String(v) })];
        MD_CAT_ORDER.forEach(function (cat) {
          const c = hc[cat]; if (!c) return;
          const n = c.count || 0;
          if (n > 0) kids.push(mdCatItem(cat, n, false));
        });
        tip.replaceChildren.apply(tip, kids);
        tip.classList.add('show');
      };
      bar.onmouseleave = function () { bars.classList.remove('hovering'); bar.classList.remove('hover'); tip.classList.remove('show'); };
      bars.appendChild(bar);
      const slot = el('div', { cls: 'drop-chart-axis-slot' });
      if (i % step === 0 || i === labels.length - 1) slot.textContent = lab;
      axis.appendChild(slot);
    });
    append(wrap, tip, bars, axis);
  } else if (mdChartSeries === 'dist') {
    // 价格分布（6 桶对数直方图）：标注每桶价格区间，X 轴用 fmtK 紧凑下界，tooltip 显示完整区间 + 占比
    const buckets = sum.priceHistogram || [];
    const total = buckets.reduce(function (s, b) { return s + ((b && b.count) || 0); }, 0) || 1;
    let max = 0;
    for (let i = 0; i < buckets.length; i++) { const c = (buckets[i] && buckets[i].count) || 0; if (c > max) max = c; }
    const step = Math.max(1, Math.ceil(buckets.length / 6));
    const bars = el('div', { cls: 'md-chart-bars-vp', attrs: { style: 'margin-top:30px' } });
    buckets.forEach(function (b, i) {
      const v = (b && b.count) || 0;
      const bar = el('div', { cls: 'md-chart-bar-vp' + (v > 0 ? '' : ' zero') });
      if (v > 0 && max > 0) bar.style.height = (v / max * 100) + '%';
      const range = b ? (fmtPrice(b.lo) + ' – ' + fmtPrice(b.hi)) : '';
      const pct = Math.round(v / total * 100);
      bar.onmouseenter = function () {
        bars.classList.add('hovering'); bar.classList.add('hover');
        tip.replaceChildren(
          el('span', { cls: 'dct-date', text: range }),
          el('span', { cls: 'dct-total', text: v + ' ' + t('common.unitTrades') + ' · ' + pct + '%' })
        );
        tip.classList.add('show');
      };
      bar.onmouseleave = function () { bars.classList.remove('hovering'); bar.classList.remove('hover'); tip.classList.remove('show'); };
      bars.appendChild(bar);
      const slot = el('div', { cls: 'drop-chart-axis-slot' });
      if (i % step === 0 || i === buckets.length - 1) slot.textContent = b ? fmtK(b.lo) : '';
      axis.appendChild(slot);
    });
    append(wrap, tip, bars, axis);
  } else {
    // volprice 量价叠加：柱(成交量，淡) + 均价折线(突出) + 面积，同 .md-chart-bars-vp 单区叠加
    const series = mdChartRange === 'all' ? daily : daily.slice(-mdChartRange);
    const key = mdChartMetric === 'volume' ? 'volume' : 'count';
    const isVol = key === 'volume';
    const labels = series.map(function (d) { return d.date; });
    const barVals = series.map(function (d) { return d[key] || 0; });
    const lineVals = series.map(function (d) { return d.avgPrice || 0; });
    let maxBar = 1; for (let i = 0; i < barVals.length; i++) if (barVals[i] > maxBar) maxBar = barVals[i];
    let maxLine = 1; for (let i = 0; i < lineVals.length; i++) if (lineVals[i] > maxLine) maxLine = lineVals[i];
    const step = Math.max(1, Math.ceil(labels.length / 6));
    const bars = el('div', { cls: 'md-chart-bars-vp', attrs: { style: 'margin-top:30px' } });
    let col = 'var(--up)';
    labels.forEach(function (lab, i) {
      const v = barVals[i] || 0;
      const d = series[i] || {};
      const bar = el('div', { cls: 'md-chart-bar-vp' + (v > 0 ? ' is-stacked' : ' zero') });
      const byCat = d.byCat || {};
      if (v > 0 && maxBar > 0) {
        // 段高 = cat.metricVal / maxBar × 100%（maxBar=序列日总最大值；段高可比且和=柱可视高度，不溢出）
        MD_CAT_ORDER.forEach(function (cat) {
          const c = byCat[cat]; if (!c) return;
          const cv = c[key] || 0;
          if (cv > 0) bar.appendChild(el('div', { cls: mdSegCls(cat), attrs: { style: 'height:' + (cv / maxBar * 100) + '%' } }));
        });
      }
      bar.onmouseenter = function () {
        bars.classList.add('hovering'); bar.classList.add('hover');
        const kids = [
          el('span', { cls: 'dct-date', text: lab }),
          el('span', { cls: 'dct-total', text: t('marketData.chartCount') + ' ' + String(d.count || 0) }),
          el('span', { cls: 'dct-total', text: t('marketData.chartVolume') + ' ' + fmtPrice(d.volume || 0) }),
          el('span', { cls: 'dct-total', text: t('marketData.kpiAvg') + ' ' + fmtPrice(d.avgPrice || 0) })
        ];
        MD_CAT_ORDER.forEach(function (cat) {
          const c = byCat[cat]; if (!c) return;
          const cv = c[key] || 0;
          if (cv > 0) kids.push(mdCatItem(cat, cv, isVol));
        });
        tip.replaceChildren.apply(tip, kids);
        tip.classList.add('show');
      };
      bar.onmouseleave = function () { bars.classList.remove('hovering'); bar.classList.remove('hover'); tip.classList.remove('show'); };
      bars.appendChild(bar);
      const slot = el('div', { cls: 'drop-chart-axis-slot' });
      if (i % step === 0 || i === labels.length - 1) slot.textContent = lab.slice(5) || lab;
      axis.appendChild(slot);
    });
    // 均价折线 + 面积（SVG 绝对覆盖 bars-vp；vector-effect 修粗细不一）
    if (lineVals.length >= 2 && maxLine > 0) {
      const up = lineVals[lineVals.length - 1] >= lineVals[0];
      col = up ? 'var(--up)' : 'var(--down)';
      const w = Math.max(labels.length * 14, 200), HH = 120;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'md-chart-line');
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + HH);
      svg.setAttribute('preserveAspectRatio', 'none');
      const pts = labels.map(function (_, i) {
        return ((i + 0.5) * (w / labels.length)) + ',' + (HH - (lineVals[i] || 0) / maxLine * (HH - 8) - 4);
      });
      const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      area.setAttribute('points', '0,' + HH + ' ' + pts.join(' ') + ' ' + w + ',' + HH);
      area.setAttribute('fill', 'transparent');
      svg.appendChild(area);
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.setAttribute('points', pts.join(' '));
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', col);
      poly.setAttribute('stroke-width', '2');
      poly.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(poly);
      bars.appendChild(svg);
    }
    // 图例
    const legend = el('div', { cls: 'md-chart-vp-legend' });
    legend.appendChild(el('span', { cls: 'lg-bar', text: '▎' + t(mdChartMetric === 'volume' ? 'marketData.chartVolume' : 'marketData.chartCount') }));
    const lgLine = el('span', { cls: 'lg-line', text: '━' + t('marketData.kpiAvg') });
    lgLine.style.color = col;
    legend.appendChild(lgLine);
    bars.appendChild(legend);
    append(wrap, tip, bars, axis);
  }
  append(scroll, wrap);
  append(section, scroll);
  return section;
}

// 排行搜索框 helper：card 搜片名 / people 搜 uid，实时过滤；中文 IME composition 守卫（compositionend 才触发）+ renderMarketData 重建 DOM 后焦点恢复并把光标放到末尾。正常模式由 tabs 行调用（margin-left:auto 推到最右），人视角搜索模式独立一行调用（详情卡上方，避免死胡同）。返回 wrap（input + 清除×），× 仅当前有值时显示
function createSearchInput(section) {
  const isCard = section === 'card';
  const wrap = el('div', { cls: 'md-rank-search-wrap' });
  const input = el('input', {
    cls: 'th-input md-rank-search',
    attrs: {
      type: 'text',
      placeholder: t(isCard ? 'marketData.searchName' : 'marketData.searchUid'),
      'data-md-search': section
    }
  });
  input.value = isCard ? mdCardSearch : mdPeopleSearch;
  let composing = false;
  function applySearch() {
    const v = input.value;
    const pos = v.length;
    if (isCard) mdCardSearch = v; else mdPeopleSearch = v;
    renderMarketData();
    // renderMarketData 重建 DOM 致输入失焦，恢复焦点并把光标放到末尾，否则每打一个字都要重新点击
    const ni = document.querySelector('.md-rank-search[data-md-search="' + section + '"]');
    if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (_) {} }
  }
  input.addEventListener('compositionstart', function () { composing = true; });
  input.addEventListener('compositionend', function () { composing = false; applySearch(); });
  input.oninput = function (e) {
    if (composing || (e && e.isComposing)) return;   // composition 期间跳过
    applySearch();
  };
  wrap.appendChild(input);
  // 清除 ×（仅当前有值时显示）
  if (input.value) {
    const clr = el('span', { cls: 'md-rank-search-clr', text: '×' });
    clr.title = t('search.clear');
    clr.onclick = function () { if (isCard) mdCardSearch = ''; else mdPeopleSearch = ''; renderMarketData(); };
    wrap.appendChild(clr);
  }
  return wrap;
}

// 排行榜：按 section 渲染（card=卡视角给价格区 / people=人视角给玩家区），tab 各自独立态，top-N 共用，受全局筛选影响；人榜 profile.id 命中高亮「我」；两段各有搜索框（card 片名 tabs 内右 / people uid 固定标题下独立行，正常+搜索模式都渲染），people 搜索时列表上方多出 uid 详情卡（含成交订单列表）
function buildMarketRank(sum, section) {
  const isCard = section === 'card';
  const tab = isCard ? mdCardRankTab : mdPeopleRankTab;
  const sec = el('div', { cls: 'drop-section' });
  // 标题行：标题左 + 搜索框右（两段统一，搜索框固定右上角，无论正常/搜索模式都在）
  const head = el('div', { cls: 'md-rank-head' });
  head.appendChild(el('div', { cls: 'drop-section-title', text: t(isCard ? 'marketData.rankSectionCard' : 'marketData.rankSectionPeople') }));
  head.appendChild(createSearchInput(section));
  sec.appendChild(head);
  // 人视角搜索时显示 uid 详情卡（含成交订单列表，传 hist），不渲染 tabs/list
  if (!isCard && mdPeopleSearch) {
    sec.appendChild(buildMdUserDetail(sum, mdPeopleSearch, state.marketHistory));
    return sec;
  }
  // tab（按 section 选定义；搜索框已在标题行右上角，tabs 内不放）
  const tabs = el('div', { cls: 'drop-range-btns' });
  const tabDefs = isCard
    ? [['expensive','marketData.rankExpensive'],['hot','marketData.rankHot'],['volume','marketData.rankVolume'],['circulation','marketData.rankCirculation']]
    : [['buyerCount','marketData.rankBuyerCount'],['buyerVolume','marketData.rankBuyerVolume'],['sellerCount','marketData.rankSellerCount'],['sellerVolume','marketData.rankSellerVolume'],['flips','marketData.flipRank']];
  tabDefs.forEach(function (p) {
    const b = el('button', { cls: 'drop-range-btn' + (tab === p[0] ? ' active' : ''), text: t(p[1]), attrs: { type: 'button' } });
    b.onclick = function () { if (isCard) { mdCardRankTab = p[0]; mdCardRankLimit = 20; } else { mdPeopleRankTab = p[0]; mdPeopleRankLimit = 20; } renderMarketData(); };
    tabs.appendChild(b);
  });
  sec.appendChild(tabs);
  // list（按 section/tab）
  let list;
  if (isCard) {
    list = tab === 'expensive' ? (sum.topExpensive || [])
      : tab === 'hot' ? (sum.topHot || [])
      : tab === 'volume' ? (sum.topVolume || [])
      : (sum.topCirculation || []);
  } else if (tab === 'flips') {
    list = (sum.flips || []).slice().sort(function (a, b) { return (b.totalProfit || 0) - (a.totalProfit || 0); });
  } else {
    const arr = (tab === 'buyerCount' || tab === 'buyerVolume') ? (sum.buyers || []) : (sum.sellers || []);
    const byVolume = tab === 'buyerVolume' || tab === 'sellerVolume';
    list = arr.slice().sort(function (a, b) { return byVolume ? b.volume - a.volume : b.trades - a.trades; });
  }
  // E: 过滤（card 模糊片名 / people uid 包含）
  if (isCard) {
    list = list.filter(function (item) { return !mdCardSearch || (item.filmName || '').toLowerCase().includes(mdCardSearch.toLowerCase()); });
  } else {
    list = list.filter(function (item) { return !mdPeopleSearch || String(item.id || '').includes(mdPeopleSearch); });
  }
  if (!list.length) { sec.appendChild(el('div', { cls: 'drop-empty-tip', text: t('marketData.noMatch') })); return sec; }
  const wrap = el('div', { cls: 'md-rank-list', attrs: { 'data-rank-sec': section, 'data-rank-tab': tab } });
  const myId = (state.profile && state.profile.id != null) ? String(state.profile.id) : '';
  const renderRow = function (item, i) {
    return isCard ? buildMarketRankRow(item, i)
      : (tab === 'flips' ? buildFlipRow(item, i, myId) : buildPeopleRankRow(item, i, myId));
  };
  list.slice(0, isCard ? mdCardRankLimit : mdPeopleRankLimit).forEach(function (item, i) { wrap.appendChild(renderRow(item, i)); });
  // 滚动到底自动加载更多（增量追加新行，取代「展开更多」按钮）：不触发 renderMarketData，滚动位置自然保持不跳
  wrap.addEventListener('scroll', function () {
    if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 60) return;
    const start = isCard ? mdCardRankLimit : mdPeopleRankLimit;
    if (start >= list.length) return;
    if (isCard) mdCardRankLimit += 20; else mdPeopleRankLimit += 20;
    const end = isCard ? mdCardRankLimit : mdPeopleRankLimit;
    list.slice(start, end).forEach(function (item, idx) { wrap.appendChild(renderRow(item, start + idx)); });
  });
  sec.appendChild(wrap);
  return sec;
}

// 单行：排名 + 海报 + 片名/称号/稀有度 + 主值 + 辅助值（按 tab 不同）
function buildMarketRankRow(item, i) {
  const row = el('div', { cls: 'md-rank-row' });
  const rank = el('span', { cls: 'md-rank-no', text: String(i + 1) });
  const poster = item.poster ? el('img', { cls: 'md-rank-poster', attrs: { src: item.poster, alt: '', loading: 'lazy' } }) : el('div', { cls: 'md-rank-poster' });
  const main = el('div', { cls: 'md-rank-main' });
  const name = el('div', { cls: 'md-rank-name', text: (item.filmName || '—') + (item.year ? ' (' + item.year + ')' : '') });
  name.style.cursor = 'pointer';
  name.title = t('marketData.clickToSearch');
  name.onclick = function () { mdCardSearch = String(item.filmName || ''); renderMarketData(); };
  append(main,
    name,
    el('div', { cls: 'md-rank-meta', text: [item.rarity, item.title, item.provenance].filter(Boolean).join(' · ') })
  );
  const val = el('div', { cls: 'md-rank-val' });
  if (mdCardRankTab === 'expensive') {
    const sub = el('div', { cls: 'md-rank-sub' });
    append(sub,
      document.createTextNode(item.id ? t('marketData.tradeNo', { id: item.id }) + ' · ' : ''),
      mdUidLink(item.sellerId),
      document.createTextNode(t('marketData.uidFlowMid')),
      mdUidLink(item.buyerId),
      document.createTextNode(' · ' + (item.tradedAt || '').slice(5))
    );
    append(val,
      el('div', { cls: 'md-rank-primary', text: fmtPrice(Number(item.price) || 0) }),
      sub
    );
  } else if (mdCardRankTab === 'hot') {
    append(val,
      el('div', { cls: 'md-rank-primary', text: t('marketData.rankTrades', { n: item.trades || 0 }) }),
      el('div', { cls: 'md-rank-sub', text: fmtPrice(item.volume || 0) + ' · ' + t('marketData.rankUniqueCards', { n: item.uniqueCards || 0 }) })
    );
  } else if (mdCardRankTab === 'volume') {
    append(val,
      el('div', { cls: 'md-rank-primary', text: fmtPrice(item.volume || 0) }),
      el('div', { cls: 'md-rank-sub', text: t('marketData.rankTrades', { n: item.trades || 0 }) + ' · ' + fmtPrice(item.avgPrice || 0) + ' · ' + _mdLiq(item) })
    );
  } else { // circulation：片级（filmMap 派生），无 avgPerDay/intervalMedian，不加流动性后缀避免「日均0.0」误导
    append(val,
      el('div', { cls: 'md-rank-primary', text: t('marketData.rankUniqueCards', { n: item.uniqueCards || 0 }) }),
      el('div', { cls: 'md-rank-sub', text: t('marketData.rankTrades', { n: item.trades || 0 }) + ' · ' + fmtPrice(item.volume || 0) })
    );
  }
  append(row, rank, poster, main, val);
  return row;
}
// 人视角排行单行：排名 + 完整 uid（或「我」前缀 + uid）+ 主值(trades/volume) + 辅值；profile.id 命中加 md-rank-me 高亮；不显示头像
function buildPeopleRankRow(item, i, myId) {
  const isMe = myId && item.id === myId;
  const byVolume = mdPeopleRankTab === 'buyerVolume' || mdPeopleRankTab === 'sellerVolume';
  const row = el('div', { cls: 'md-rank-row' + (isMe ? ' md-rank-me' : '') });
  const main = el('div', { cls: 'md-rank-main' });
  const name = el('div', { cls: 'md-rank-name' });
  append(name, document.createTextNode((isMe ? t('marketData.rankMe') + ' · ' : '') + 'uid：'), el('span', { cls: 'md-uid-text', text: String(item.id) }));
  name.style.cursor = 'pointer';
  name.title = t('marketData.clickToSearch');
  name.onclick = function () { mdPeopleSearch = String(item.id); renderMarketData(); };
  append(main,
    name,
    el('div', { cls: 'md-rank-meta', text: t('marketData.kpiAvg') + ' ' + fmtPrice(item.avgPrice || 0) })
  );
  const val = el('div', { cls: 'md-rank-val' });
  append(val,
    el('div', { cls: 'md-rank-primary', text: byVolume ? fmtPrice(item.volume || 0) : t('marketData.rankTrades', { n: item.trades || 0 }) }),
    el('div', { cls: 'md-rank-sub', text: byVolume ? t('marketData.rankTrades', { n: item.trades || 0 }) : fmtPrice(item.volume || 0) })
  );
  append(row,
    el('span', { cls: 'md-rank-no', text: String(i + 1) }),
    main,
    val
  );
  return row;
}
// id 缩略：取后 4 位前加 …
// ---------- 市场数据三区 section builder（总览/价格/玩家；T9+10+11）----------
// 共享 helper
function mdSectionTitle(titleKey, rangeText) {
  const h = el('div', { cls: 'md-section-title' });
  append(h, el('span', { cls: 'md-section-bar' }), el('span', { cls: 'md-section-name', text: t(titleKey) }));
  if (rangeText) h.appendChild(el('span', { cls: 'md-pill md-pill-range', text: rangeText }));
  return h;
}
function mdKpiCoreTile(label, val, accent) {
  const c = el('div', { cls: 'md-kpi-core' + (accent ? ' accent' : '') });
  append(c, el('div', { cls: 'md-kpi-label', text: label }), el('div', { cls: 'md-kpi-val', text: val }));
  return c;
}
function mdPill(text, cls, title) { const o = { cls: 'md-pill' + (cls ? ' ' + cls : ''), text: text }; if (title) o.attrs = { title: title }; return el('span', o); }
// uid 超链接：withPrefix=true（默认）显示「uid:123」，false 显示纯数字；点击在新 tab 打开 kp.m-team.cc 用户资料页；空 uid 返回「—」文本节点
function mdUidLink(uid, withPrefix) {
  if (uid == null || uid === '') return document.createTextNode('—');
  var webBase = (state.config && state.config.webBase) || 'kp.m-team.cc';
  return el('a', { cls: 'md-uid-link', text: (withPrefix === false ? String(uid) : 'uid:' + uid), attrs: { href: webUrl(webBase, '/profile/detail/' + encodeURIComponent(uid)), target: '_blank', rel: 'noopener' } });
}
// 卡视角流动性后缀：日均 + 间隔中位（ms→h），缺数据 '—'
function _mdLiq(item) {
  const perDay = (Number(item.avgPerDay) || 0).toFixed(1);
  const ival = item.intervalMedian == null ? '—' : (item.intervalMedian / 3600000).toFixed(1) + 'h';
  return t('marketData.liqPerDay', { n: perDay }) + ' · ' + t('marketData.liqInterval', { n: ival });
}

// 区一：市场总览（叙事条 + 核心 KPI + 结构药丸 + 量价图）
function buildOverviewSection(sum) {
  const sec = el('div', { cls: 'md-section' });
  sec.appendChild(mdSectionTitle('marketData.sectionOverview',
    sum.rangeStart && sum.rangeEnd ? (sum.rangeStart + ' ~ ' + sum.rangeEnd) : ''));
  sec.appendChild(buildNarrative(sum));
  const core = el('div', { cls: 'md-kpi-core-row' });
  append(core,
    mdKpiCoreTile(t('marketData.kpiVolume'), fmtK(sum.totalVolume), false),
    mdKpiCoreTile(t('marketData.kpiTrades'), String(sum.totalTrades), false),
    mdKpiCoreTile(t('marketData.kpiMedian'), fmtPrice(sum.medianPrice), true)); // 中位价 accent
  sec.appendChild(core);
  // 辅助 KPI + 市场结构 合并同一行（flex wrap 药丸混排）
  const aux = el('div', { cls: 'md-kpi-aux' });
  append(aux,
    mdPill(t('marketData.kpiAvg') + ' ' + fmtPrice(sum.avgPrice)),
    mdPill(t('marketData.kpiBuyers') + ' ' + sum.uniqueBuyers),
    mdPill(t('marketData.kpiSellers') + ' ' + sum.uniqueSellers),
    mdPill(t('marketData.kpiCards') + ' ' + sum.uniqueCards));
  append(aux, buildStructure(sum));
  sec.appendChild(aux);
  sec.appendChild(buildMarketChart(sum)); // T7 量价叠加图
  return sec;
}
// 叙事条：7 日环比（成交笔数 ▲/▼ X% · 价格 ↑/↓ Y%）+ 领涨稀有度；趋势数据不足给提示
function buildNarrative(sum) {
  const tr = sum.trend;
  const box = el('div', { cls: 'md-narrative' + (tr ? (tr.tradeDeltaPct >= 0 ? ' up' : ' down') : '') });
  if (!tr) { box.textContent = t('marketData.dataInsufficient'); return box; }
  const dup = tr.tradeDeltaPct >= 0;
  box.textContent = t('marketData.pulse', {
    trades: tr.vol7,
    delta: (dup ? '▲' : '▼') + Math.abs(Math.round(tr.tradeDeltaPct * 100)) + '%',
    priceDelta: (tr.priceDeltaPct >= 0 ? '↑' : '↓') + Math.abs(Math.round(tr.priceDeltaPct * 100)) + '%',
    leader: tr.leader || ''
  });
  return box;
}
// 结构药丸：集中度(top10) + 重叠(pureBuyer/pureSeller/both) + 手续费率（返回 fragment，由调用方并入药丸行）
function buildStructure(sum) {
  const c = sum.concentration || {}, o = sum.overlap || {};
  const frag = document.createDocumentFragment();
  append(frag,
    mdPill(t('marketData.whale') + ' ' + Math.round((c.top10Pct || 0) * 100) + '%', 'warn'),
    mdPill(t('marketData.pureBuyer') + ' ' + Math.round((o.pureBuyerPct || 0) * 100) + '%'),
    mdPill(t('marketData.pureSeller') + ' ' + Math.round((o.pureSellerPct || 0) * 100) + '%'),
    mdPill(t('marketData.both') + ' ' + Math.round((o.bothPct || 0) * 100) + '%'),
    mdPill(t('marketData.feeRate') + ' ' + ((sum.feeRate || 0) * 100).toFixed(1) + '%'));
  return frag;
}

// 区二：价格分析（分位药丸 + 稀有度矩阵 + 成交之最；卡排行已移至区三）
function buildPriceSection(sum) {
  const sec = el('div', { cls: 'md-section' });
  sec.appendChild(mdSectionTitle('marketData.sectionPrice'));
  const pct = el('div', { cls: 'md-kpi-aux' });
  append(pct,
    mdPill(t('marketData.p25') + ' ' + fmtPrice(sum.priceP25), null, t('marketData.p25Tip')),
    mdPill(t('marketData.p75') + ' ' + fmtPrice(sum.priceP75), null, t('marketData.p75Tip')),
    mdPill(t('marketData.p90') + ' ' + fmtPrice(sum.priceP90), null, t('marketData.p90Tip')),
    mdPill(t('marketData.stdDev') + ' ' + fmtPrice(sum.priceStd), null, t('marketData.stdDevTip')));
  sec.appendChild(pct);
  sec.appendChild(buildRarityMatrix(sum));
  sec.appendChild(buildTopDeal(sum));
  return sec;
}
// 稀有度矩阵：表头 + 机制卡3类（置顶）+ 稀有度行（首列彩色标签）
function buildRarityMatrix(sum) {
  const mech = sum.mechMatrix || [];
  const rar = sum.rarityMatrix || [];
  if (!mech.length && !rar.length) return el('div');
  const m = el('div', { cls: 'md-rarity-matrix' });
  append(m,
    el('div', { cls: 'md-rm-h', text: '' }), el('div', { cls: 'md-rm-h', text: t('marketData.kpiTrades') }),
    el('div', { cls: 'md-rm-h', text: t('marketData.kpiVolume') }), el('div', { cls: 'md-rm-h', text: t('marketData.kpiAvg') }),
    el('div', { cls: 'md-rm-h', text: t('marketData.kpiMedian') }));
  // 机制卡行（置顶；首列 dim 文本标签与稀有度彩签区分）
  mech.forEach(function (mm) {
    append(m,
      el('div', { cls: 'md-rm-r md-rm-mech', text: t('mech.' + mm.type) || mm.type }),
      el('div', { text: String(mm.trades) }), el('div', { text: fmtK(mm.volume) }),
      el('div', { text: fmtPrice(mm.avgPrice) }), el('div', { text: fmtPrice(mm.median) }));
  });
  // 稀有度行（首列彩色标签复用 .md-rarity-tag.r-XX）
  rar.forEach(function (r) {
    const label = el('div', { cls: 'md-rm-r' });
    append(label, el('span', { cls: 'md-rarity-tag r-' + r.rarity, text: r.rarity }));
    append(m, label,
      el('div', { text: String(r.trades) }), el('div', { text: fmtK(r.volume) }),
      el('div', { text: fmtPrice(r.avgPrice) }), el('div', { text: fmtPrice(r.median) }));
  });
  return m;
}
// 成交之最：最贵一笔（片名 · 价格 · 买家→卖家 · 日期；完整 uid）
function buildTopDeal(sum) {
  const t0 = (sum.topExpensive || [])[0];
  if (!t0) return el('div');
  const row = el('div', { cls: 'md-topdeal' });
  append(row,
    document.createTextNode(t('marketData.topDealName', { name: t0.filmName || '—', price: fmtPrice(Number(t0.price) || 0) })),
    mdUidLink(t0.sellerId),
    document.createTextNode(t('marketData.uidFlowMid')),
    mdUidLink(t0.buyerId),
    document.createTextNode(t('marketData.topDealTail', { date: (t0.tradedAt || '').slice(5) }))
  );
  return row;
}

// 区二右：玩家行为 = 我的市场画像（扩充；人视角排行已移至区三）
function buildPlayersSection(sum) {
  const sec = el('div', { cls: 'md-section md-players' });
  sec.appendChild(mdSectionTitle('marketData.myProfile'));
  const my = buildMyProfile(sum);
  if (my) sec.appendChild(my);
  else sec.appendChild(el('div', { cls: 'drop-empty-tip', text: t('marketData.noMatch') }));
  return sec;
}
// 我的市场画像：分层结构（排名药丸 / 净盈亏突出 / 买入‖卖出两栏 / 份额 / 倒卖）；无 profile.id 或无成交 → null 隐藏
function buildMyProfile(sum) {
  const myId = (state.profile && state.profile.id != null) ? String(state.profile.id) : '';
  if (!myId) return null;
  const find = function (arr) { return arr.find(function (x) { return x.id === myId; }); };
  const buyer = find(sum.buyers || []);
  const seller = find(sum.sellers || []);
  const flip = find(sum.flips || []);
  if (!buyer && !seller && !flip) return null; // 无成交则隐藏
  const rankIn = function (arr) { const i = arr.findIndex(function (x) { return x.id === myId; }); return i >= 0 ? i + 1 : null; };
  const br = rankIn((sum.buyers || []).slice().sort(function (a, b) { return b.volume - a.volume; }));
  const sr = rankIn((sum.sellers || []).slice().sort(function (a, b) { return b.volume - a.volume; }));
  const box = el('div', { cls: 'md-profile' });
  // 1. 排名药丸行（买/卖额榜 #名次）
  const head = el('div', { cls: 'mp-head' });
  append(head,
    mdPill(t('marketData.rankBuyerVolume') + ' #' + (br || '—')),
    mdPill(t('marketData.rankSellerVolume') + ' #' + (sr || '—')));
  box.appendChild(head);
  // 2. 净盈亏突出大字（同时有买+卖才显；居中，涨绿 var(--up)/跌红 var(--down)）
  if (buyer && seller) {
    const net = Number(seller.volume || 0) - Number(buyer.volume || 0);
    const nb = el('div', { cls: 'mp-net ' + (net >= 0 ? 'up' : 'down') });
    append(nb,
      el('span', { cls: 'mp-net-l', text: t('marketData.netPnl') }),
      el('span', { cls: 'mp-net-v', text: (net >= 0 ? '+' : '') + fmtPrice(net) }));
    box.appendChild(nb);
  }
  // 3. 买入 ‖ 卖出 对称两栏（grid 2 列；每栏 列头 + 3 行 label:value；只买或只卖则单栏）
  if (buyer || seller) {
    const pair = el('div', { cls: 'mp-pair' + (buyer && seller ? '' : ' single') });
    if (buyer) {
      const bc = el('div', { cls: 'mp-col' });
      append(bc,
        el('div', { cls: 'mp-col-h', text: t('marketData.buyCol') }),
        mpRow(t('marketData.rankBuyerCount'), String(buyer.trades != null ? buyer.trades : '—')),
        mpRow(t('marketData.rankBuyerVolume'), fmtPrice(buyer.volume || 0)),
        mpRow(t('marketData.buyAvg'), fmtPrice(buyer.avgPrice || 0)));
      pair.appendChild(bc);
    }
    if (seller) {
      const sc = el('div', { cls: 'mp-col' });
      append(sc,
        el('div', { cls: 'mp-col-h', text: t('marketData.sellCol') }),
        mpRow(t('marketData.rankSellerCount'), String(seller.trades != null ? seller.trades : '—')),
        mpRow(t('marketData.rankSellerVolume'), fmtPrice(seller.volume || 0)),
        mpRow(t('marketData.sellAvg'), fmtPrice(seller.avgPrice || 0)));
      pair.appendChild(sc);
    }
    box.appendChild(pair);
  }
  // 4. 市场份额药丸（买入/卖出 各有则显；占大盘 totalVolume 的百分比）
  if ((buyer || seller) && sum.totalVolume) {
    const sk = el('div', { cls: 'mp-share' });
    if (buyer) sk.appendChild(mdPill(t('marketData.buyShare') + ' ' + ((buyer.volume || 0) / sum.totalVolume * 100).toFixed(1) + '%'));
    if (seller) sk.appendChild(mdPill(t('marketData.sellShare') + ' ' + ((seller.volume || 0) / sum.totalVolume * 100).toFixed(1) + '%'));
    box.appendChild(sk);
  }
  // 5. 倒卖药丸行（flip 有则显：次数 · 套利额 · 毛利率 · 持有天数）
  if (flip) {
    const fk = el('div', { cls: 'mp-flips' });
    const profit = Number(flip.totalProfit) || 0;
    append(fk,
      mdPill(t('marketData.flipCount', { n: flip.flips || 0 })),
      mdPill(t('marketData.flipProfit') + ' ' + fmtPrice(profit), profit >= 0 ? 'up' : 'down'),
      mdPill(t('marketData.flipMargin') + ' ' + ((flip.avgMargin || 0) * 100).toFixed(0) + '%'),
      mdPill(t('marketData.holdDays', { n: (flip.avgHoldDays || 0).toFixed(1) })));
    box.appendChild(fk);
  }
  return box;
}
// 画像/详情 行 helper：label 左 muted + value 右粗体（flex space-between 对齐）
function mpRow(label, value) {
  const r = el('div', { cls: 'mp-row' });
  append(r,
    el('span', { cls: 'mp-row-l', text: label }),
    el('span', { cls: 'mp-row-v', text: value }));
  return r;
}
// 倒卖榜单行：排名 + 完整 uid（或我前缀 + uid）+ 持有天数 + 总利润(涨跌色) + 倒卖次数·均毛利；不显示头像
function buildFlipRow(item, i, myId) {
  const isMe = myId && item.id === myId;
  const row = el('div', { cls: 'md-rank-row' + (isMe ? ' md-rank-me' : '') });
  const main = el('div', { cls: 'md-rank-main' });
  const name = el('div', { cls: 'md-rank-name' });
  append(name, document.createTextNode((isMe ? t('marketData.rankMe') + ' · ' : '') + 'uid：'), el('span', { cls: 'md-uid-text', text: String(item.id) }));
  name.style.cursor = 'pointer';
  name.title = t('marketData.clickToSearch');
  name.onclick = function () { mdPeopleSearch = String(item.id); renderMarketData(); };
  append(main,
    name,
    el('div', { cls: 'md-rank-meta', text: t('marketData.holdDays', { n: (item.avgHoldDays || 0).toFixed(1) }) }));
  const val = el('div', { cls: 'md-rank-val' });
  const profit = item.totalProfit || 0;
  append(val,
    el('div', { cls: 'md-rank-primary', attrs: { style: 'color:' + (profit >= 0 ? 'var(--up)' : 'var(--down)') }, text: fmtPrice(profit) }),
    el('div', { cls: 'md-rank-sub', text: t('marketData.flipCount', { n: item.flips || 0 }) + ' · ' + ((item.avgMargin || 0) * 100).toFixed(0) + '%' }));
  append(row, el('span', { cls: 'md-rank-no', text: String(i + 1) }), main, val);
  return row;
}

// 人视角 uid 详情卡：people 段搜索命中时，在排行列表上方汇总该用户买/卖/倒卖数据 + 该 uid 的成交订单列表（hist 找，新到老 top50）；某项无数据（不在 buyers/sellers/flips）显示 —，无任何命中显示 noMatchUser
function buildMdUserDetail(sum, query, hist) {
  const buyer = (sum.buyers || []).find(function (x) { return String(x.id || '') === query; });
  const seller = (sum.sellers || []).find(function (x) { return String(x.id || '') === query; });
  const flip = (sum.flips || []).find(function (x) { return String(x.id || '') === query; });
  const box = el('div', { cls: 'md-user-detail' });
  if (!buyer && !seller && !flip) {
    box.appendChild(el('div', { cls: 'ud-name', text: t('marketData.noMatchUser') }));
    return box;
  }
  const hasFlip = !!flip;
  const profit = hasFlip ? (flip.totalProfit || 0) : 0;
  // 单个汇总药丸：label + value（value 可带涨跌色）
  function chip(label, value, color) {
    const s = el('span', { cls: 'ud-item' });
    if (color) {
      append(s, document.createTextNode(label + ' '), el('span', { attrs: { style: 'color:' + color }, text: value }));
    } else {
      s.textContent = label + ' ' + value;
    }
    return s;
  }
  const udName = el('div', { cls: 'ud-name' });
  append(udName, document.createTextNode('uid：'), el('span', { cls: 'md-uid-text', text: String((buyer || seller || flip).id) }));
  append(box, udName);
  // 汇总药丸组（买/卖/倒卖），包一层 ud-pills 以便下方挂订单列表
  const pills = el('div', { cls: 'ud-pills' });
  append(pills,
    chip(t('marketData.rankBuyerCount'), buyer ? String(buyer.trades || 0) : '—'),
    chip(t('marketData.rankBuyerVolume'), buyer ? fmtPrice(buyer.volume || 0) : '—'),
    chip(t('marketData.rankSellerCount'), seller ? String(seller.trades || 0) : '—'),
    chip(t('marketData.rankSellerVolume'), seller ? fmtPrice(seller.volume || 0) : '—'),
    el('span', { cls: 'ud-item', text: hasFlip ? t('marketData.flipCount', { n: flip.flips || 0 }) : '—' }),
    chip(t('marketData.flipProfit'), hasFlip ? fmtPrice(profit) : '—', hasFlip ? (profit >= 0 ? 'var(--up)' : 'var(--down)') : null),
    chip(t('marketData.flipMargin'), hasFlip ? ((flip.avgMargin || 0) * 100).toFixed(0) + '%' : '—'),
    el('span', { cls: 'ud-item', text: hasFlip ? t('marketData.holdDays', { n: (flip.avgHoldDays || 0).toFixed(1) }) : '—' })
  );
  box.appendChild(pills);
  // 成交订单列表：hist 找 uid 成交（买或卖），按 tradedAt 降序（新到老），top 50；每行 相对时间+动作+卡+价
  const trades = (hist || []).filter(function (tr) {
    return String(tr.buyerId || '') === query || String(tr.sellerId || '') === query;
  }).slice().sort(function (a, b) { return _mkMs(b.tradedAt) - _mkMs(a.tradedAt); });
  const ut = el('div', { cls: 'md-ut' });
  if (!trades.length) {
    ut.appendChild(el('div', { cls: 'drop-empty-tip', text: t('marketData.noMatch') }));
  } else {
    if (trades.length > 50) {
      ut.appendChild(el('div', { cls: 'md-ut-count', text: t('marketData.tradesCount', { n: trades.length }) }));
    }
    trades.slice(0, 50).forEach(function (tr) {
      const isBuyer = String(tr.buyerId || '') === query;
      const ago = fmtAgo(Date.now() - _mkMs(tr.tradedAt));
      const act = isBuyer
        ? t('marketData.buyFrom', { id: tr.sellerId })
        : t('marketData.sellTo', { id: tr.buyerId });
      const cardName = [tr.filmName, tr.rarity, tr.title].filter(Boolean).join('-');
      const row = el('div', { cls: 'md-ut-row' });
      append(row,
        el('span', { cls: 'md-ut-ago', text: ago }),
        el('span', { cls: 'md-ut-act', text: act }),
        el('span', { cls: 'md-ut-card', text: cardName || '—' }),
        el('span', { cls: 'md-ut-price', text: fmtPrice(Number(tr.price) || 0) })
      );
      ut.appendChild(row);
    });
  }
  box.appendChild(ut);
  return box;
}
// 相对时间：ms 差 → 「X秒/分钟/小时/天/月/年前」（<0 或无效 → —）
function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return t('marketData.agoSec', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('marketData.agoMin', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('marketData.agoHour', { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('marketData.agoDay', { n: d });
  const mo = Math.floor(d / 30);
  if (mo < 12) return t('marketData.agoMonth', { n: mo });
  return t('marketData.agoYear', { n: Math.floor(d / 365) });
}

// 画像辅助：签名指标 / 速写行 / 五维详情行 / 深挖 mini 卡
function ptSign(val, label) {
  const s = el('div', { cls: 'pt-sign' });
  append(s, el('div', { cls: 'pt-sign-val', text: val }), el('div', { cls: 'pt-sign-label', text: label }));
  return s;
}
function ptNarrLine(icon, text) {
  const l = el('div', { cls: 'pt-narr-line' });
  append(l, el('span', { cls: 'pt-narr-ico', text: icon }), el('span', { cls: 'pt-narr-text', text: text }));
  return l;
}
function ptDim(d) {
  const row = el('div', { cls: 'pt-dim' });
  const head = el('div', { cls: 'pt-dim-head' });
  append(head,
    el('span', { cls: 'pt-dim-ico', text: d.icon }),
    el('span', { cls: 'pt-dim-label', text: d.label }),
    el('span', { cls: 'pt-dim-eval', text: d.evalT })
  );
  const track = el('div', { cls: 'pt-dim-track' });
  track.appendChild(el('div', { cls: 'pt-dim-fill dim-' + d.key, attrs: { style: 'width:' + Math.round(d.ratio * 100) + '%' } }));
  append(row, head, track, el('div', { cls: 'pt-dim-val', text: d.value + (d.unit || '') }));
  return row;
}
function ptMini(label, val, sub) {
  const m = el('div', { cls: 'pt-mini' });
  append(m, el('div', { cls: 'pt-mini-val', text: val }), el('div', { cls: 'pt-mini-label', text: label }));
  if (sub) m.appendChild(el('div', { cls: 'pt-mini-sub', text: sub }));
  return m;
}

// 五维雷达：createElementNS 构建 SVG（MV3 CSP + 安全规范，不用 innerHTML）
function buildPortraitRadar(r) {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const A = [
    { key: 'wealth', label: t('portrait.axisWealth') },
    { key: 'income', label: t('portrait.axisIncome') },
    { key: 'spend',  label: t('portrait.axisSpend') },
    { key: 'luck',   label: t('portrait.axisLuck') },
    { key: 'gamble', label: t('portrait.axisGamble') },
  ];
  const cx = 130, cy = 120, R = 88, n = A.length;
  const pt2 = (i, val) => {
    const ang = -Math.PI / 2 + i * 2 * Math.PI / n;
    return [cx + R * val * Math.cos(ang), cy + R * val * Math.sin(ang)];
  };
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 260 240');
  svg.setAttribute('class', 'portrait-radar-svg');
  const mk = (tag, attrs) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const ringPts = (lvl) => A.map((_, i) => { const p = pt2(i, lvl); return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
  const dataPts = A.map((a, i) => { const p = pt2(i, (r && r[a.key]) || 0); return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
  [0.33, 0.66, 1].forEach((lvl) => svg.appendChild(mk('polygon', { points: ringPts(lvl), class: 'rr-ring' })));
  A.forEach((_, i) => { const p = pt2(i, 1); svg.appendChild(mk('line', { x1: cx, y1: cy, x2: p[0].toFixed(1), y2: p[1].toFixed(1), class: 'rr-axis' })); });
  svg.appendChild(mk('polygon', { points: dataPts, class: 'rr-data' }));
  A.forEach((a, i) => { const p = pt2(i, (r && r[a.key]) || 0); svg.appendChild(mk('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 3, class: 'rr-dot' })); });
  A.forEach((a, i) => { const p = pt2(i, 1.18); const tx = mk('text', { x: p[0].toFixed(1), y: p[1].toFixed(1), class: 'rr-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' }); tx.textContent = a.label; svg.appendChild(tx); });
  const wrap = el('div', { cls: 'portrait-radar' });
  wrap.appendChild(svg);
  return wrap;
}

function portraitKpi(label, val, sub) {
  const tile = el('div', { cls: 'portrait-kpi-tile' });
  append(tile,
    el('div', { cls: 'portrait-kpi-val', text: val }),
    el('div', { cls: 'portrait-kpi-label', text: label })
  );
  if (sub) tile.appendChild(el('div', { cls: 'portrait-kpi-sub', text: sub }));
  return tile;
}

// 持有卡片筛选：文本(片名/称号/serial/稀有度) + 稀有度/机制卡多选
function filterInventory(list) {
  const f = inventoryFilter;
  const text = (f.text || '').trim().toLowerCase();
  const kws = text ? text.split(/\s+/).filter(Boolean) : [];
  const hasRarity = f.mech || (f.rarities && f.rarities.size > 0);
  const hasTitle = f.titles && f.titles.size > 0;
  const hasSource = f.source && f.source.size > 0;
  const hasLock = !!f.lock;
  const hideUserLocked = !f.showLocked;  // 默认隐藏手动锁定的卡（独立于交易锁 tradeLockUntil）
  if (!kws.length && !hasRarity && !hasTitle && !hasSource && !hasLock && !hideUserLocked) return list;
  return list.filter((it) => {
    const mech = isMechCard(it);
    if (hasRarity) {
      if (mech) { if (!f.mech) return false; }
      else { if (!f.rarities.has(it.rarity || 'N')) return false; }
    }
    if (hasTitle && it.title && !f.titles.has(it.title)) return false;
    if (hasSource) {
      const num = Number(String(it.serial || '').split('-').pop());
      const src = (Number.isFinite(num) && num === 0) ? 'crafted' : 'drop';
      if (!f.source.has(src)) return false;
    }
    if (hideUserLocked && isUserLocked(it)) return false;
    if (hasLock) {
      const lockUntil = parseMtTime(it.tradeLockUntil);
      if (!(Number.isFinite(lockUntil) && lockUntil > Date.now())) return false;
    }
    if (kws.length) {
      const fields = [it.filmName || ''].map((s) => s.toLowerCase());
      const exact = !!f.exact;
      if (!kws.every((kw) => { const k = kw.toLowerCase(); return fields.some((fld) => exact ? fld === k : fld.indexOf(k) !== -1); })) return false;
    }
    return true;
  });
}

// 持有卡片询价缓存（cardKey → 最高买价），本次会话防重复请求
const orderbookCache = new Map();
function applyInvAsk(btn, bid) {
  if (bid != null && bid !== '') { btn.textContent = fmtNum(Number(bid)); btn.classList.add('has-bid'); btn.classList.remove('no-bid'); }
  else { btn.textContent = t('inv.noBid'); btn.classList.add('no-bid'); btn.classList.remove('has-bid'); }
}
function buildAskBtn(it, filmId, rarity) {
  const btn = el('button', { cls: 'inv-ask-btn', attrs: { type: 'button' }, text: t('inv.ask') });
  const cardKey = filmId + '|' + (it.provenance || '') + '|' + rarity;
  if (orderbookCache.has(cardKey)) applyInvAsk(btn, orderbookCache.get(cardKey));
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.textContent = '…';
    btn.classList.remove('has-bid', 'no-bid');
    const r = await send({ type: 'GET_ORDERBOOK', filmId, provenance: it.provenance || '', rarity });
    btn.dataset.busy = '';
    if (r && r.ok) { orderbookCache.set(cardKey, r.bid); applyInvAsk(btn, r.bid); }
    else { applyInvAsk(btn, null); }
  };
  return btn;
}

// 卖出模态窗：净卖价输入 + 实时明细 + 挂卖按钮（点击后状态在按钮内：loading → 成功关窗 / 失败留窗）
function openSellDialog(it) {
  const input = el('input', { cls: 'modal-input', attrs: { type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: t('inv.sellPlaceholder') } });
  const netCell = el('span', { cls: 'sd-val' });
  const feeCell = el('span', { cls: 'sd-val sd-fee' });
  const listCell = el('span', { cls: 'sd-val' });
  const updateBreakdown = () => {
    const net = Number(input.value) || 0;
    netCell.textContent = fmtNum(net);
    feeCell.textContent = '+ ' + fmtNum(Math.round(net * 0.05));
    listCell.textContent = fmtNum(Math.round(net * 1.05));
  };
  input.addEventListener('input', updateBreakdown);
  updateBreakdown();
  const breakdown = el('div', { cls: 'sell-breakdown' });
  const addRow = (extraCls, lbl, valCell) => { const row = el('div', { cls: 'sd-row ' + (extraCls || '') }); append(row, el('span', { cls: 'sd-lbl', text: lbl }), valCell); breakdown.appendChild(row); };
  addRow('', t('inv.sdNet'), netCell);
  addRow('', t('inv.sdFee'), feeCell);
  addRow('sd-total', t('inv.sdList'), listCell);
  const body = el('div', { cls: 'modal-body' });
  append(body, el('div', { cls: 'modal-note', text: t('inv.sellPromptLabel') }), input, breakdown);

  const mask = el('div', { cls: 'modal-mask' });
  const box = el('div', { cls: 'modal' });
  box.appendChild(buildModalHero(it));
  box.appendChild(body);
  const cancelBtn = el('button', { cls: 'btn ghost', text: t('common.cancel') });
  const sellBtn = el('button', { cls: 'btn sell', text: t('common.sell') });
  const actions = el('div', { cls: 'modal-actions' });
  append(actions, cancelBtn, sellBtn);
  box.appendChild(actions);
  mask.appendChild(box);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('show'));
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 60);

  let closed = false;
  const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey); mask.classList.remove('show'); setTimeout(() => mask.remove(), 220); };
  const onKey = (e) => { if (e.key === 'Escape' && !sellBtn.dataset.busy) close(); };
  document.addEventListener('keydown', onKey);
  cancelBtn.onclick = () => { if (!sellBtn.dataset.busy) close(); };
  mask.addEventListener('click', (e) => { if (e.target === mask && !sellBtn.dataset.busy) close(); });

  // 挂卖按钮：校验净价 → 50 上限检查 → sell；状态在按钮内（loading），成功才关窗
  sellBtn.onclick = async () => {
    if (sellBtn.dataset.busy) return;
    const netPrice = Number(input.value);
    if (!Number.isFinite(netPrice) || netPrice <= 0) { showToast(t('inv.sellInvalidPrice'), 'error'); return; }
    const origText = sellBtn.textContent;
    sellBtn.dataset.busy = '1'; sellBtn.disabled = true; sellBtn.textContent = '…';
    await send({ type: 'LOAD_ORDERS' });
    const st = await send({ type: 'GET_STATE' });
    if (((st && st.ordersAll) || []).filter((o) => o.status === 'open').length >= 50) {
      sellBtn.dataset.busy = ''; sellBtn.disabled = false; sellBtn.textContent = origText;
      showToast(t('inv.sellOrderFull'), 'error'); return;
    }
    const r = await send({ type: 'SELL_CARD', cardId: it.cardId, isMech: isMechCard(it), netPrice: netPrice });
    if (r && r.ok) { showToast(t('inv.sellSuccessToast', { price: netPrice }), 'success'); close(); }
    else { sellBtn.dataset.busy = ''; sellBtn.disabled = false; sellBtn.textContent = origText; showToast(t('inv.sellFailedToast'), 'error'); }
  };
}

// ============ 批量操作：步骤级执行器 ============
// 每项 = 有序步骤数组，每步状态机 pending→running→done/failed。
// 串行：某步失败跳下一项；×关中断；重试从首个非done步骤续跑（不重做已成功步骤）。

function makeBatchStep(kind, params) {
  return { kind: kind, params: params, status: 'pending' };
}

// op: 'sell' | 'cancel' | 'modify'
// card: inventory 项（sell，含 cardId/tradeLockUntil）或 order 项（cancel/modify，含 id=orderId/cardId）
// netPrice: 净卖价（sell/modify 用）
function makeBatchItem(op, card, netPrice) {
  var isMech = isMechCard(card);
  var cardId = card.cardId;
  var orderId = card.id;  // order 挂单 id（inventory 项无）
  var steps = [];
  if (op === 'cancel') {
    steps.push(makeBatchStep('cancel', { orderId: orderId }));
  } else if (op === 'sell') {
    steps.push(makeBatchStep('sell', { netPrice: netPrice, cardId: cardId, isMech: isMech }));
  } else if (op === 'modify') {
    steps.push(makeBatchStep('cancel', { orderId: orderId }));
    steps.push(makeBatchStep('sell', { netPrice: netPrice, cardId: cardId, isMech: isMech }));
  } else if (op === 'buy') {
    steps.push(makeBatchStep('buy', { variant: card.variant, expectPrice: card.lowestAsk, filmName: card.filmName, poster: card.poster, rarity: (card.variant && card.variant.rarity) || '', title: card.title || '' }));
  }
  return { op: op, card: card, steps: steps, netPrice: netPrice };
}

// 该项首个非 done 步骤（重试/续跑入口）；null = 全 done
function nextStepToRun(item) {
  for (var i = 0; i < item.steps.length; i++) {
    if (item.steps[i].status !== 'done') return item.steps[i];
  }
  return null;
}
function itemHasFailed(item) {
  return item.steps.some(function (s) { return s.status === 'failed'; });
}
function itemAllDone(item) {
  return item.steps.every(function (s) { return s.status === 'done'; });
}
function itemHasUnfilled(item) {
  return item.steps.some(function (s) { return s.unfilled; });
}

// dashboard 侧随机延迟（项间防风控节流）
function sleepRand(min, max) {
  var ms = min + Math.floor(Math.random() * (max - min));
  return new Promise(function (res) { setTimeout(res, ms); });
}

// 执行单步 → { ok, error }
async function execBatchStep(step) {
  try {
    if (step.kind === 'cancel') {
      var r = await send({ type: 'CANCEL_ORDER', orderId: step.params.orderId, skipRefresh: true });  // 批量：跳过逐张刷新，整批后统一刷
      return { ok: !!(r && r.ok) };
    }
    if (step.kind === 'buy') {
      var _rar = step.params.rarity || (step.params.variant || {}).rarity || '';
      var _monLimit = Number(((state.config && state.config.maxPriceByRarity) || {})[_rar]) || 0;
      var b = await send({ type: 'BUY_CARD', variant: step.params.variant, expectPrice: step.params.expectPrice, filmName: step.params.filmName, poster: step.params.poster, rarity: step.params.rarity, title: step.params.title, maxPrice: _monLimit, skipRefresh: true });
      var confirmed = !!(b && b.confirmed);
      var isUnfilled = !!(b && b.reason === 'unfilled' && !b.cancelFailed);  // 仅 open+cancel成功 才算"未成交"；cancel_failed/budget_*/buy_failed 都是真失败
      return { ok: confirmed, unfilled: isUnfilled };
    }
    var s = await send({ type: 'SELL_CARD', cardId: step.params.cardId, netPrice: step.params.netPrice, isMech: step.params.isMech, skipRefresh: true });
    return { ok: !!(s && s.ok) };
  } catch (e) { return { ok: false, error: e }; }
}

// 串行执行 items（整批或重试子集）。onStep(item,step) 每次状态变化回调；shouldAbort() true 则当前项完成后停。
async function runBatch(items, onStep, shouldAbort) {
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var step;
    while ((step = nextStepToRun(item))) {
      step.status = 'running';
      onStep(item, step);
      var res = await execBatchStep(step);
      step.status = res.ok ? 'done' : 'failed';
      if (res.unfilled) step.unfilled = true;  // buy 未成交标记（paint 灰 chip / retryAllFailed 排除）
      onStep(item, step);
      if (!res.ok) break;  // 失败 → 跳出该项剩余步骤
    }
    await sleepRand(400, 900);
    if (shouldAbort()) break;
  }
}

// ============ 手动锁定（用户主动锁，独立于交易锁 tradeLockUntil） ============
var lockedSet = new Set();  // 用户锁定 cardId 集合，跨设备同步（state.config.lockedCards；renderAll 时从后端重建）
function isUserLocked(card) { return lockedSet.has(card.cardId); }
function persistLocked() {
  send({ type: 'SET_CONFIG', config: { lockedCards: Array.from(lockedSet) } });
}

// ============ 批量操作：点卡片选择 + 悬浮面板 ============
var batchInView = null;        // null | 'inventory' | 'orders'（当前选择所在 view）
var batchSelected = new Set(); // 持有存 cardId / 挂单存 orderId

function isCardLocked(card) {
  var lu = parseMtTime(card.tradeLockUntil);
  return Number.isFinite(lu) && lu > Date.now();
}
function batchIdOf(card) {
  if (batchInView === 'orders') return card.id;
  if (batchInView === 'market') {  // 市场卡无 cardId/id，用购买三元组（buyCard API 入参）
    var v = card.variant || {};
    return v.filmId + '|' + v.provenance + '|' + v.rarity;
  }
  return card.cardId;
}

// 点卡片 toggle 选中；view 由 card builder 传入。第一次点击进入选择态。
function onBatchCardClick(card, cardEl, view) {
  // 市场自挂单不可批量选中（与单卡购买灰显一致，避免自买）
  if (view === 'market' && cardEl && cardEl.dataset.ownListing) {
    showToast(t('card.ownListing'));
    return;
  }
  if (batchInView && batchInView !== view) batchSelected = new Set();  // 跨 view 不混选
  batchInView = view;
  var id = batchIdOf(card);
  var nowSel;
  if (batchSelected.has(id)) { batchSelected.delete(id); nowSel = false; }
  else { batchSelected.add(id); nowSel = true; }
  if (batchSelected.size === 0) batchInView = null;
  if (cardEl) {  // 直接更新被点卡片的选中视觉（避免整列重绘）
    cardEl.classList.toggle('selected', nowSel);
    var chk = cardEl.querySelector('.batch-check');
    if (chk) chk.classList.toggle('checked', nowSel);
  }
  renderFloatingBatch();
}

// 悬浮批量面板：batchSelected 非空时显示计数 + 操作按钮 + 清除
function renderFloatingBatch() {
  var panel = $('batchFloating');
  if (!panel) return;
  var n = batchSelected.size;
  if (n === 0) { panel.hidden = true; return; }
  panel.hidden = false;
  $('batchFloatCount').textContent = t('batch.selected', { n: n });
  var actions = $('batchFloatActions');
  actions.replaceChildren();
  function addBtn(key, fn) {
    var b = el('button', { cls: 'seg-btn mini', attrs: { type: 'button' }, text: t(key) });
    b.onclick = fn; actions.appendChild(b);
  }
  if (batchInView === 'inventory') { addBtn('batch.lock', lockSelected); addBtn('batch.sell', openBatchSell); }
  else if (batchInView === 'orders') { addBtn('batch.cancel', openBatchCancel); addBtn('batch.modify', openBatchModify); }
  else if (batchInView === 'market') addBtn('batch.buy', openBatchBuy);
}

// 批量锁定选中卡片（纯本地，不走批量执行器）：选中 cardId 写入 lockedSet → 清选中 → 重绘出蒙版
function lockSelected() {
  const cards = (state.inventory || []).concat((state.mechInventory || []).filter(function (m) { return !m.isUsed; }));
  let n = 0;
  cards.forEach(function (c) {
    if (batchSelected.has(c.cardId) && !isUserLocked(c) && !isCardLocked(c)) { lockedSet.add(c.cardId); n++; }
  });
  if (n === 0) { showToast(t('batch.lockNone')); return; }
  persistLocked();
  clearBatchSelection(true);  // 清选中 + renderInventory（重绘后锁卡显蒙版）
}

// 清空选择（清除按钮 / 模态关闭后 / 切 view）。rerender=true 时重绘当前 view 清选中视觉。
function clearBatchSelection(rerender) {
  var v = batchInView;
  batchInView = null; batchSelected = new Set();
  // 直接清除所有选中卡片的视觉（renderCards 有 _sig 防重绘，市场 view 选中态变化不触发重绘，需手动清；持有/挂单 renderInventory/Orders 重建亦无害）
  document.querySelectorAll('.batch-mode.selected').forEach(function (c) {
    c.classList.remove('selected');
    var chk = c.querySelector('.batch-check'); if (chk) chk.classList.remove('checked');
  });
  renderFloatingBatch();
  if (rerender !== false) { if (v === 'inventory') renderInventory(); else if (v === 'orders') renderOrders(); else if (v === 'market') renderCards(); }
}

function initBatch() {
  initBatchModal();
  $('batchFloatClear').onclick = () => clearBatchSelection(true);
}

// ============ 批量操作：模态骨架 ============
var batchState = null;  // { op, items, running, aborted }

function openBatchModal(op, items) {
  batchState = { op: op, items: items, running: false, aborted: false };
  var m0 = $('batchModal'); if (m0) m0.dataset.op = op;  // op 标识供 CSS 区分（modify 卡片列弹性，其余固定宽）
  var titles = { sell: 'batch.sellTitle', cancel: 'batch.cancelTitle', modify: 'batch.modifyTitle', buy: 'batch.buyTitle' };
  $('batchModalTitle').textContent = t(titles[op], { n: items.length });
  renderBatchBody();
  renderBatchFooter();
  var m = $('batchModal');
  _batchFocusRestore = modalFocusRestore();
  m.hidden = false;
  var main = $('mainArea'); if (main) main.style.overflow = 'hidden';  // 锁背景滚动
  requestAnimationFrame(function () { m.classList.add('show'); });
}
var _batchFocusRestore = null;
function closeBatchModal() {
  if (!batchState) return;
  if (batchState.running) { batchState.aborted = true; return; }  // 执行中：标记中断，当前项完成后停
  hideBatchModal();
}
function hideBatchModal() {
  var m = $('batchModal');
  m.classList.remove('show');
  setTimeout(function () { m.hidden = true; var main = $('mainArea'); if (main) main.style.overflow = ''; }, 180);
  if (_batchFocusRestore) { _batchFocusRestore(); _batchFocusRestore = null; }
  batchState = null;
  clearBatchSelection(true);
}

function renderBatchBody() {
  var body = $('batchModalBody');
  body.replaceChildren();
  var head = el('div', { cls: 'batch-head' });  // sticky 顶部（设价区 + 表头固定，行滚动）
  if (batchState.op !== 'cancel' && batchState.op !== 'buy' && typeof buildBatchPriceBar === 'function') head.appendChild(buildBatchPriceBar());
  head.appendChild(buildBatchHeader());
  body.appendChild(head);
  batchState.items.forEach(function (item) { body.appendChild(buildBatchRow(item)); });
}

// 批量列表表头（与 batch-row 列对齐；按 op 显示对应列）
function buildBatchHeader() {
  var row = el('div', { cls: 'batch-row batch-header' });
  row.appendChild(el('div', { cls: 'batch-row-name', text: t('batch.colCard') }));
  if (batchState.op !== 'sell' && batchState.op !== 'buy') row.appendChild(el('div', { cls: 'batch-cur-price', text: t('batch.colCurrent') }));
  if (batchState.op !== 'cancel') row.appendChild(el('div', { cls: 'batch-price', text: batchState.op === 'buy' ? t('batch.colBuy') : t('batch.colNet') }));
  row.appendChild(el('div', { cls: 'batch-row-status', text: t('batch.colStatus') }));
  row.appendChild(el('div', { cls: 'batch-row-remove' }));  // ✕ 占位（header 无删除按钮，占位与 row 的 ✕ 列对齐，避免 justify-center 错位）
  return row;
}

function buildBatchRow(item) {
  var c = item.card, isMech = isMechCard(c);
  var name = isMech ? (mechLabel(mechTypeOf(c)) || c.filmName || t('card.unnamed')) : (c.filmName || t('card.unnamed'));
  var row = el('div', { cls: 'batch-row' });
  append(row, el('div', { cls: 'batch-row-name', text: name + ' · ' + (isMech ? t('card.badgeMech') : (c.rarity || '')) + (c.title ? ' · ' + c.title : '') }));
  // 当前挂单价（挂单操作 cancel/modify 显示原价参考；sell/buy 不显示）
  if (batchState.op !== 'sell' && batchState.op !== 'buy') {
    var cur = (c.price != null && c.price !== '') ? Number(c.price) : NaN;
    row.appendChild(el('div', { cls: 'batch-cur-price', text: Number.isFinite(cur) ? fmtNum(cur) : '—' }));
  }
  if (batchState.op === 'buy') {
    // buy 价格只读：显示 lowestAsk（用户不改）
    var ask = Number(c.lowestAsk);
    row.appendChild(el('div', { cls: 'batch-price', text: Number.isFinite(ask) ? fmtNum(ask) : '—' }));
  } else if (batchState.op !== 'cancel') {
    var inp = el('input', { cls: 'th-input batch-price', attrs: { type: 'number', min: '0', inputmode: 'numeric', placeholder: t('inv.sellPlaceholder') } });
    inp.disabled = !!batchState.running;  // 用 property 设 disabled（el() 的 setAttribute 对 disabled:false 会误禁用：属性存在即生效）
    inp.value = item.netPrice || '';
    inp.oninput = function () {
      item.netPrice = Number(inp.value) || 0;
      item.steps.forEach(function (s) { if (s.kind === 'sell') s.params.netPrice = item.netPrice; });
    };
    row.appendChild(inp);
  }
  var st = el('div', { cls: 'batch-row-status' });
  row.appendChild(st);
  item._rowEl = row; item._statusEl = st;
  paintBatchRowStatus(item);
  var rm = el('button', { cls: 'batch-row-remove', attrs: { type: 'button', title: t('batch.remove') }, text: '✕' });
  rm.disabled = !!batchState.running;  // 用 property（同上，避免 setAttribute 误禁用）
  rm.onclick = function () { removeBatchItem(item); };
  row.appendChild(rm);
  return row;
}

// 模态内删除单项（执行中禁用；全删完关模态）
function removeBatchItem(item) {
  if (!batchState || batchState.running) return;
  var idx = batchState.items.indexOf(item);
  if (idx >= 0) batchState.items.splice(idx, 1);
  if (!batchState.items.length) { hideBatchModal(); return; }
  var titles = { sell: 'batch.sellTitle', cancel: 'batch.cancelTitle', modify: 'batch.modifyTitle', buy: 'batch.buyTitle' };
  $('batchModalTitle').textContent = t(titles[batchState.op], { n: batchState.items.length });
  renderBatchBody();
  renderBatchFooter();
}

function paintBatchRowStatus(item) {
  var st = item._statusEl; if (!st) return;
  st.replaceChildren();
  var cancel = item.steps.find(function (s) { return s.kind === 'cancel'; });
  var sell = item.steps.find(function (s) { return s.kind === 'sell'; });
  var buy = item.steps.find(function (s) { return s.kind === 'buy'; });
  function chip(label, status) {
    var mark = status === 'done' ? ' ✓' : status === 'failed' ? ' ✗' : status === 'running' ? ' …' : '';
    st.appendChild(el('span', { cls: 'batch-chip ' + status, text: label + mark }));
  }
  if (cancel) chip(t('batch.stepCancel'), cancel.status);
  if (sell) { if (cancel) st.appendChild(el('span', { text: ' · ' })); chip(item.op === 'modify' ? t('batch.stepRelist') : t('batch.stepSell'), sell.status); }
  if (buy) {
    if (buy.unfilled) st.appendChild(el('span', { cls: 'batch-chip unfilled', text: t('batch.stepUnfilled') }));
    else chip(t('batch.stepBuy'), buy.status);
  }
  if (itemHasFailed(item) && !itemHasUnfilled(item) && !batchState.running) {
    if (cancel && cancel.status === 'done' && sell && sell.status === 'failed') {
      st.appendChild(el('span', { cls: 'batch-warn', text: t('batch.delisted') }));
    }
    var rt = el('button', { cls: 'seg-btn mini', attrs: { type: 'button' }, text: t('batch.retry') });
    rt.onclick = function () { retryOne(item); };
    st.appendChild(rt);
  }
}

async function runBatchOp() {
  if (!batchState || batchState.running) return;
  if (batchState.op === 'buy') {  // buy：预算总花费预检（价格只读=lowestAsk，不需设价校验；不增挂单不校验50）
    var sum = batchState.items.reduce(function (a, it) { return a + (Number(it.card.lowestAsk) || 0); }, 0);
    var usable = computeUsable(state).usable;
    if (sum > usable) { showToast(t('batch.budgetShort', { need: fmtNum(sum), have: fmtNum(usable) }), 'error'); return; }
  } else if (batchState.op !== 'cancel') {  // sell/modify 需设净价
    var missing = batchState.items.filter(function (it) { return !it.netPrice || it.netPrice <= 0; });
    if (missing.length) { showToast(t('batch.missingPrice', { n: missing.length }), 'error'); return; }
  }
  if (batchState.op === 'sell') {  // 仅纯新增挂单才校验 50 上限；改价=撤1挂1净不变、取消只减不增、buy 不增挂单，均不校验
    var openN = (state.ordersAll || []).filter(function (o) { return o.status === 'open'; }).length;
    if (openN + batchState.items.length > 50) { showToast(t('batch.limit50', { cur: openN, n: batchState.items.length }), 'error'); return; }
  }
  batchState.running = true; batchState.aborted = false;
  toggleBatchInputs(true);
  await runBatch(batchState.items, paintBatchRowStatus, function () { return batchState.aborted; });
  batchState.running = false;
  toggleBatchInputs(false);
  renderBatchFooter();
  if (batchState.op === 'buy') {  // buy 影响交易记录 + 预算(storage.onChanged 自动) + 市场网格；不刷挂单/持有
    triggerMarketRefresh(true);
    send({ type: 'LOAD_TRADES' });
  } else {
    send({ type: 'LOAD_ORDERS' });
    if (batchState.op !== 'cancel') send({ type: 'LOAD_INVENTORY' });  // 卖出/改价影响持有，整批后统一刷一次（批量期间逐张已跳过）
  }
  if (batchState.aborted) return;
}
async function retryOne(item) {
  if (batchState.running) return;
  batchState.running = true; toggleBatchInputs(true);
  await runBatch([item], paintBatchRowStatus, function () { return batchState.aborted; });
  batchState.running = false; toggleBatchInputs(false); renderBatchFooter();
  if (batchState.op === 'buy') { triggerMarketRefresh(true); send({ type: 'LOAD_TRADES' }); }
  else { send({ type: 'LOAD_ORDERS' }); if (batchState.op !== 'cancel') send({ type: 'LOAD_INVENTORY' }); }
}
async function retryAllFailed() {
  var failed = batchState.items.filter(function (it) { return itemHasFailed(it) && !itemHasUnfilled(it); });  // 排除未成交（重试无意义）
  if (!failed.length || batchState.running) return;
  batchState.running = true; toggleBatchInputs(true);
  await runBatch(failed, paintBatchRowStatus, function () { return batchState.aborted; });
  batchState.running = false; toggleBatchInputs(false); renderBatchFooter();
  if (batchState.op === 'buy') { triggerMarketRefresh(true); send({ type: 'LOAD_TRADES' }); }
  else { send({ type: 'LOAD_ORDERS' }); if (batchState.op !== 'cancel') send({ type: 'LOAD_INVENTORY' }); }
}
function toggleBatchInputs(disabled) {
  document.querySelectorAll('#batchModalBody .batch-price').forEach(function (i) { i.disabled = disabled; });
  document.querySelectorAll('#batchModalBody .batch-row-remove').forEach(function (i) { i.disabled = disabled; });
}
function renderBatchFooter() {
  var f = $('batchModalFooter'); f.replaceChildren();
  if (!batchState.running) {
    var failedN = batchState.items.filter(function (it) { return itemHasFailed(it) && !itemHasUnfilled(it); }).length;
    if (failedN > 0) {
      var rt = el('button', { cls: 'btn ghost', attrs: { type: 'button' }, text: t('batch.retryAllFailed') });
      rt.onclick = retryAllFailed; f.appendChild(rt);
    }
    var submitMap = { sell: 'batch.submitSell', cancel: 'batch.submitCancel', modify: 'batch.submitModify', buy: 'batch.submitBuy' };
    var allDone = batchState.items.every(itemAllDone);
    var submit = el('button', { cls: 'btn primary', attrs: { type: 'button' }, text: t(submitMap[batchState.op], { n: batchState.items.length }) });
    submit.disabled = allDone;
    submit.onclick = runBatchOp;
    f.appendChild(submit);
  }
}
function initBatchModal() {
  $('batchModalClose').onclick = closeBatchModal;
  // 故意不绑 #batchModal mask click → 遮罩不关（防误关）
}

// 顶部设价区：按稀有度/称号维度批量设价（sell/modify 共用，cancel 不渲染）
function buildBatchPriceBar() {
  var bar = el('div', { cls: 'batch-pricebar' });
  var dim = el('select', { cls: 'th-input' });
  dim.appendChild(el('option', { attrs: { value: 'rarity' }, text: t('batch.byRarity') }));
  dim.appendChild(el('option', { attrs: { value: 'title' }, text: t('batch.byTitle') }));
  var val = el('select', { cls: 'th-input' });
  function dimValOf(it) { return dim.value === 'rarity' ? (isMechCard(it.card) ? 'MECH' : (it.card.rarity || '')) : (it.card.title || ''); }
  function fillVal() {
    val.replaceChildren();
    var seen = {};
    batchState.items.forEach(function (it) { var v = dimValOf(it); if (v && !seen[v]) { seen[v] = 1; val.appendChild(el('option', { attrs: { value: v }, text: v })); } });
  }
  dim.onchange = fillVal; fillVal();
  var price = el('input', { cls: 'th-input', attrs: { type: 'number', min: '0', inputmode: 'numeric', placeholder: t('inv.sellPlaceholder') } });
  var apply = el('button', { cls: 'seg-btn mini', attrs: { type: 'button' }, text: t('batch.apply') });
  apply.onclick = function () {
    var p = Number(price.value) || 0; if (p <= 0) return;
    var v = val.value;
    batchState.items.forEach(function (it) {
      if (dimValOf(it) === v) {
        it.netPrice = p;
        it.steps.forEach(function (s) { if (s.kind === 'sell') s.params.netPrice = p; });
        var inp = it._rowEl && it._rowEl.querySelector('.batch-price'); if (inp) inp.value = p;
      }
    });
  };
  append(bar, el('span', { text: t('batch.setPrice') }), dim, val, price, apply);
  return bar;
}

// 持有批量卖出入口：取选中且未锁卡片，构造 sell items（netPrice 初始 0，由设价区/行内输入填）
function openBatchSell() {
  var all = (state.inventory || []).concat(state.mechInventory || []);
  var cards = all.filter(function (c) { return batchSelected.has(c.cardId) && !isCardLocked(c) && !isUserLocked(c); });
  if (!cards.length) return;
  openBatchModal('sell', cards.map(function (c) { return makeBatchItem('sell', c, 0); }));
}

// 挂单批量取消入口：取选中挂单，构造 cancel items（单步 cancel(orderId)）
function openBatchCancel() {
  var orders = (state.ordersAll || []).filter(function (o) { return batchSelected.has(o.id); });
  if (!orders.length) return;
  openBatchModal('cancel', orders.map(function (o) { return makeBatchItem('cancel', o, 0); }));
}

// 挂单批量改价入口：取选中挂单，构造 modify items（cancel(旧orderId) + sell(新netPrice) 两步）
function openBatchModify() {
  var orders = (state.ordersAll || []).filter(function (o) { return batchSelected.has(o.id); });
  if (!orders.length) return;
  openBatchModal('modify', orders.map(function (o) { return makeBatchItem('modify', o, 0); }));
}

// 市场批量购买入口：取选中市场卡（从当前渲染源按 batchSelected key 回查），构造 buy items（单步 buy，price=lowestAsk）
function openBatchBuy() {
  var cards = marketSelectedItems();
  if (!cards.length) return;
  // 前置预算校验（与单卡 onBuy / runBatchOp 同口径，详细带指引）：未设预算池 / 可用额度小于所选总价 → 直接 toast，不开模态
  var u = computeUsable(state);
  if (u.bTotal <= 0) { showToast(t('err.buyBudgetNotSet'), 'error'); return; }
  var sum = cards.reduce(function (a, c) { return a + (Number(c.lowestAsk) || 0); }, 0);
  if (sum > u.usable) {
    var reason = u.bonus < u.remaining ? t('err.balanceInsufficient') : t('err.budgetRemainingInsufficient');
    showToast(reason + t('err.buyBudgetInsufficientToast', { price: fmtNum(sum), usable: fmtNum(u.usable) }), 'error');
    return;
  }
  openBatchModal('buy', cards.map(function (c) { return makeBatchItem('buy', c, 0); }));
}

// 按当前网格渲染源（定向搜索结果优先，否则 buckets+mechBucket）用 batchSelected 的 key 集合回查市场 it 对象。
// 与 renderCards 同源判断：hasTags（config.searchTags 非空）→ 模块级 searchResults；否则 buckets（{<rarity>:{items:[]}}）+ mechBucket（{items:[]}）。
function marketSelectedItems() {
  var hasTags = ((state.config && state.config.searchTags) || []).length > 0;
  var src;
  if (hasTags) {
    src = (searchResults || []).slice();  // 模块级裸变量（renderCards 同款）
  } else {
    src = [];
    // 注：不按 orderedActive 稀有度/mechSel 过滤（与 renderCards 不同）——安全，因 batchSelected 只持有已渲染（已过滤）卡片的 key，未渲染的卡不会匹配。
    var buckets = state.buckets || {};
    Object.keys(buckets).forEach(function (r) { var b = buckets[r]; if (b && b.items) src = src.concat(b.items); });
    var mb = state.mechBucket; if (mb && mb.items) src = src.concat(mb.items);
  }
  var savedView = batchInView;  // batchIdOf 依赖 batchInView，临时确保 market（openBatchBuy 调用时本就是 market，此保护为函数独立可复用）
  batchInView = 'market';
  var out = src.filter(function (it) { return batchSelected.has(batchIdOf(it)); });
  batchInView = savedView;
  return out;
}

// 卖出按钮：打开卖出模态窗（挂卖按钮内集成校验/50检查/sell + 状态）；交易锁定期内禁用变灰
function buildSellBtn(it) {
  const lockUntil = parseMtTime(it.tradeLockUntil);
  const locked = Number.isFinite(lockUntil) && lockUntil > Date.now();
  const btn = el('button', { cls: 'inv-sell-btn', attrs: { type: 'button' }, text: t('inv.sell') });
  if (locked) {
    btn.disabled = true;
    if (it.tradeLockUntil) btn.title = t('inv.locksUntil', { time: it.tradeLockUntil });
  } else {
    btn.onclick = (e) => { e.stopPropagation(); if (!btn.dataset.busy) openSellDialog(it); };
  }
  return btn;
}

// 卖出净卖价输入弹窗：手输净卖价 + 含税提示；返回有效净价或 null（取消/无效）
async function promptSellPrice(it) {
  const input = el('input', { cls: 'modal-input', attrs: { type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: t('inv.sellPlaceholder') } });
  // 价格明细：net / 抽水5% / 挂单价（实时算：挂单价 = net × 1.05，抽水 = net × 0.05）
  const netCell = el('span', { cls: 'sd-val' });
  const feeCell = el('span', { cls: 'sd-val sd-fee' });
  const listCell = el('span', { cls: 'sd-val' });
  const updateBreakdown = () => {
    const net = Number(input.value) || 0;
    netCell.textContent = fmtNum(net);
    feeCell.textContent = '+ ' + fmtNum(Math.round(net * 0.05));
    listCell.textContent = fmtNum(Math.round(net * 1.05));
  };
  input.addEventListener('input', updateBreakdown);
  updateBreakdown();
  const breakdown = el('div', { cls: 'sell-breakdown' });
  const addRow = (extraCls, lbl, valCell) => {
    const row = el('div', { cls: 'sd-row ' + (extraCls || '') });
    append(row, el('span', { cls: 'sd-lbl', text: lbl }), valCell);
    breakdown.appendChild(row);
  };
  addRow('', t('inv.sdNet'), netCell);
  addRow('', t('inv.sdFee'), feeCell);
  addRow('sd-total', t('inv.sdList'), listCell);
  const body = el('div');
  append(body,
    el('div', { cls: 'modal-note', text: t('inv.sellPromptLabel') }),
    input,
    breakdown
  );
  const ok = await confirmDialog({ hero: buildModalHero(it), body: body, confirmText: t('common.sell'), cancelText: t('common.cancel'), confirmVariant: 'sell' });
  if (!ok) return null;
  const netPrice = Number(input.value);
  if (!Number.isFinite(netPrice) || netPrice <= 0) { showToast(t('inv.sellInvalidPrice'), 'error'); return null; }
  return netPrice;
}

// 持有卡片：复用 trade-card 外观，加交易锁徽章 + 询价/卖出按钮 + 来源/种子数
// 单色锁图标（SVG，stroke=currentColor 随按钮 color 变色，非彩色 emoji）
function lockIconSvg(size) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size || 22);
  svg.setAttribute('height', size || 22);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '5'); rect.setAttribute('y', '11');
  rect.setAttribute('width', '14'); rect.setAttribute('height', '9'); rect.setAttribute('rx', '2');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M8 11V8a4 4 0 0 1 8 0v3');
  svg.appendChild(rect); svg.appendChild(path);
  return svg;
}

// 手动锁卡的磨砂遮罩 + 解锁按钮（两步点击确认防误点）
function buildLockOverlay(it) {
  const overlay = el('div', { cls: 'lock-overlay' });
  const btn = el('button', { cls: 'unlock-btn', attrs: { type: 'button', title: t('batch.unlockTip'), 'aria-label': t('batch.unlockTip') } });
  const hint = el('span', { cls: 'unlock-hint', text: t('batch.unlockConfirm') });
  append(btn, lockIconSvg(22), hint);
  let confirming = false;
  let timer = null;
  btn.onclick = (e) => {
    e.stopPropagation();  // 不冒泡（锁定卡无 onclick，双保险）
    if (!confirming) {
      confirming = true;
      btn.classList.add('confirming');  // 变红 + 抖 + 显示提示
      timer = setTimeout(() => { confirming = false; btn.classList.remove('confirming'); }, 3000);  // 3s 超时恢复
    } else {
      if (timer) { clearTimeout(timer); timer = null; }
      confirming = false;
      lockedSet.delete(it.cardId);
      persistLocked();       // set → onChanged 拦截会再 renderInventory（幂等）
      renderInventory();     // 立即反馈（不等 onChanged 的 ms 级延迟）
    }
  };
  append(overlay, btn);
  return overlay;
}

function buildInventoryCard(it, delay) {
  const rarity = it.rarity || 'N';
  const filmId = it.filmId || '';
  const isMech = isMechCard(it);
  const name = isMech ? (mechLabel(filmId.slice(5)) || it.filmName || t('card.unnamed')) : (it.filmName || t('card.unnamed'));
  const url = buildDetailUrl(it, (state.config && state.config.webBase) || 'kp.m-team.cc');
  const now = Date.now();
  const lockUntil = parseMtTime(it.tradeLockUntil);
  const locked = Number.isFinite(lockUntil) && lockUntil > now;

  const card = el('div', { cls: 'card inventory-card' });
  card.style.animationDelay = delay + 'ms';

  card.classList.add('batch-mode');
  const tradeLocked = isCardLocked(it);   // 交易锁（tradeLockUntil，平台临时）
  const userLocked = isUserLocked(it);    // 手动锁（用户主动，持久）
  if (tradeLocked) card.classList.add('batch-locked');        // 交易锁：灰显
  if (userLocked) { card.classList.add('manual-locked'); card.appendChild(buildLockOverlay(it)); }  // 手动锁：磨砂蒙版 + 解锁按钮
  if (!tradeLocked && !userLocked) {      // 未锁：可选
    var chk = el('div', { cls: 'batch-check ' + (batchSelected.has(it.cardId) ? 'checked' : '') });
    card.appendChild(chk);
    card.classList.toggle('selected', batchSelected.has(it.cardId));
    card.onclick = () => onBatchCardClick(it, card, 'inventory');
  }

  const wrap = el('div', { cls: 'poster-wrap' });
  const fallback = el('div', { cls: 'poster-fallback', text: (name || '?').slice(0, 1) });
  fallback.style.display = 'none';
  if (it.poster) {
    const img = el('img', { cls: 'poster', attrs: { alt: name, loading: 'lazy' } });
    img.onerror = () => { img.remove(); fallback.style.display = 'grid'; };
    img.src = it.poster;
    wrap.appendChild(img);
  } else {
    fallback.style.display = 'grid';
  }
  wrap.appendChild(fallback);
  wrap.appendChild(el('div', { cls: 'rarity-badge ' + (isMech ? 'r-mech' : 'r-' + rarity), text: isMech ? t('card.badgeMech') : (RARITY_LABEL[rarity] || rarity) }));
  const openBtn = el('button', { cls: 'ca-open', attrs: { title: t('card.openInNewTabDetail') }, text: '↗' });
  openBtn.onclick = (e) => { e.stopPropagation(); window.open(url, '_blank'); };
  wrap.appendChild(openBtn);
  if (it.title && !isMech) {
    const tier = TITLE_TIER[it.title] || 'tt-5';
    wrap.appendChild(el('div', { cls: 'title-tag ' + tier, text: it.title }));
  }
  // 交易锁徽章（poster 右下角）
  const lockEl = el('div', { cls: 'inv-lock ' + (locked ? 'is-locked' : 'is-tradable'), text: locked ? t('inv.locked') : t('inv.tradable') });
  if (locked && it.tradeLockUntil) lockEl.title = t('inv.locksUntil', { time: it.tradeLockUntil });
  wrap.appendChild(lockEl);

  const body = el('div', { cls: 'card-body' });
  append(body, el('div', { cls: 'film-name', text: name }));
  // 元信息行：左年份 · 右种子数（都没有则不显示）
  if (it.year || it.currentSeeders) {
    const metaRow = el('div', { cls: 'inv-meta-row' });
    append(metaRow,
      el('span', { cls: 'inv-meta', text: it.year || '' }),
      el('span', { cls: 'inv-meta', text: it.currentSeeders ? '🌱 ' + it.currentSeeders : '' })
    );
    append(body, metaRow);
  }

  // 询价 + 卖出按钮同一行（询价左、卖出右）置底
  const actionRow = el('div', { cls: 'inv-serial-row' });
  actionRow.appendChild(buildAskBtn(it, filmId, rarity));
  actionRow.appendChild(buildSellBtn(it));
  append(body, actionRow);

  append(card, wrap, body);
  return card;
}

// 稀有度筛选 chips：每次 renderInventory 重建（文本实时取，防切语言 stale）
// 稀有度/机制卡筛选 chips 公共构造（持有/交易/挂单三视图共用）
// 筛选 chips 公共构造（分组：稀有度[含机制卡] → 来源[持有独有] → 称号）
function buildFilterChips(boxId, filterObj, renderFn, withSource, withLock) {
  const box = $(boxId);
  if (!box) return;
  box.replaceChildren();
  const mkChip = (cls, lbl, onClick) => {
    const chip = el('button', { cls: 'chip ' + cls, attrs: { type: 'button' } });
    chip.appendChild(el('span', { cls: 'dot' }));
    chip.appendChild(document.createTextNode(lbl));
    chip.onclick = onClick;
    return chip;
  };
  const groupLabel = (text) => box.appendChild(el('span', { cls: 'chip-group-label', text }));
  groupLabel(t('cfg.rarity'));
  RARITIES.forEach((r) => {
    const on = filterObj.rarities.has(r);
    box.appendChild(mkChip('r-' + r + (on ? ' on' : ''), r, () => {
      if (filterObj.rarities.has(r)) filterObj.rarities.delete(r);
      else filterObj.rarities.add(r);
      renderFn();
    }));
  });
  // 来源组：机制卡（所有 view）+ 掉落/制造（持有 withSource）
  groupLabel(t('inv.metricSource'));
  box.appendChild(mkChip('r-mech' + (filterObj.mech ? ' on' : ''), t('cfg.mech'), () => { filterObj.mech = !filterObj.mech; renderFn(); }));
  if (withSource) {
    [['drop', t('inv.drop')], ['crafted', t('inv.crafted')]].forEach(([key, lbl]) => {
      const on = filterObj.source.has(key);
      box.appendChild(mkChip('inv-src-' + key + (on ? ' on' : ''), lbl, () => {
        if (filterObj.source.has(key)) filterObj.source.delete(key);
        else filterObj.source.add(key);
        renderFn();
      }));
    });
  }
  groupLabel(t('search.titleLabel'));
  Object.keys(TITLE_TIER).forEach((title) => {
    const on = filterObj.titles.has(title);
    box.appendChild(mkChip('inv-title ' + (TITLE_TIER[title] || 'tt-5') + (on ? ' on' : ''), title, () => {
      if (filterObj.titles.has(title)) filterObj.titles.delete(title);
      else filterObj.titles.add(title);
      renderFn();
    }));
  });
  // 手动锁开关（持有独有）：称号后，文字 + 勾选框；默认隐藏手动锁卡，勾选后显示
  if (withLock) {
    const lbl = el('label', { cls: 'chip-group-label inv-lock-toggle', attrs: { title: t('inv.showLockedHint') } });
    append(lbl, el('span', { text: t('inv.showLocked') }), el('input', { attrs: { type: 'checkbox' } }));
    const cb = lbl.querySelector('input');
    cb.checked = !!filterObj.showLocked;
    cb.addEventListener('change', () => { filterObj.showLocked = cb.checked; renderFn(); });
    box.appendChild(lbl);
  }
}
// 市场称号筛选（多选，空=不限；称号名站点术语不译，切语言经 renderAll 重建）
let marketTitleFilter = new Set();
function buildMarketTitleChips() {
  const box = $('titleFilterBox');
  if (!box) return;
  box.replaceChildren();
  Object.keys(TITLE_TIER).forEach((title) => {
    const on = marketTitleFilter.has(title);
    const chip = el('button', { cls: 'chip inv-title ' + (TITLE_TIER[title] || 'tt-5') + (on ? ' on' : ''), attrs: { type: 'button' } });
    chip.appendChild(el('span', { cls: 'dot' }));
    chip.appendChild(document.createTextNode(title));
    chip.onclick = () => {
      if (marketTitleFilter.has(title)) { marketTitleFilter.delete(title); chip.classList.remove('on'); }
      else { marketTitleFilter.add(title); chip.classList.add('on'); }
      renderCards();
      const cb = box.querySelector('.title-clear'); if (cb) cb.hidden = marketTitleFilter.size === 0;
    };
    box.appendChild(chip);
  });
  const clearBtn = el('button', { cls: 'title-clear', attrs: { type: 'button', title: t('search.clear') }, text: '✕' });
  clearBtn.hidden = marketTitleFilter.size === 0;
  clearBtn.onclick = () => { marketTitleFilter.clear(); renderCards(); buildMarketTitleChips(); };
  box.appendChild(clearBtn);
}

// ============ 市场 view 定向搜索 tag（多 keyword；非空时市场走 /market/search 而非 buckets 刷新） ============
let searchResults = null;   // null=未查询(走 buckets)；数组=定向搜索结果(已映射成 buckets item 结构，复用 renderCards)
let searching = false;      // 串行查询中(loading)
let _searchSeq = 0;         // 防并发：只采纳最新一次查询的结果
function hasSearchTags() { return ((state.config && state.config.searchTags) || []).length > 0; }

function renderSearchTags() {
  const mf = $('marketFilter');
  if (mf) mf.classList.toggle('has-tags', hasSearchTags());  // 有 tag → 隐藏稀有度/机制卡/称号/价格阈值筛选行
  const box = $('searchTagBox');
  if (!box) return;
  if (box.querySelector('.search-tag-input')) return;  // 输入中不打断
  const tags = ((state.config && state.config.searchTags) || []);
  box.replaceChildren();
  for (const tag of tags) {
    const chip = el('div', { cls: 'search-tag' });
    chip.appendChild(el('span', { text: tag }));
    const close = el('span', { cls: 'st-close', text: '×', attrs: { title: t('search.removeTag') } });
    close.onclick = () => removeSearchTag(tag);
    chip.appendChild(close);
    box.appendChild(chip);
  }
  const add = el('button', { cls: 'search-tag-add', attrs: { type: 'button', title: t('search.addTag') }, text: '+' });
  add.onclick = showSearchTagInput;
  box.appendChild(add);
}

function showSearchTagInput() {
  const box = $('searchTagBox');
  if (!box) return;
  const add = box.querySelector('.search-tag-add');
  if (!add) return;
  const wrap = el('div', { cls: 'search-tag-input-wrap' });
  const input = el('input', { cls: 'search-tag-input', attrs: { type: 'text', placeholder: t('search.tagPh') } });
  const save = el('button', { cls: 'search-tag-save', attrs: { type: 'button', title: t('search.addTag') }, text: '✓' });
  wrap.appendChild(input);
  wrap.appendChild(save);
  add.replaceWith(wrap);
  input.focus();
  let done = false;
  const finish = (doSave) => {
    if (done) return; done = true;
    const v = doSave ? String(input.value || '').trim() : '';
    wrap.remove();  // 先移除输入区，放行 renderSearchTags 的「输入中」guard（否则它误判跳过重建 → tag 不更新）
    if (v) addSearchTag(v);  // async：后台持久化 + 触发查询；新 tag 由 addSearchTag 完成后补渲染
    renderSearchTags();       // 重建 tag 横排 + + 按钮
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { finish(false); }
  };
  save.onmousedown = (e) => e.preventDefault();  // 阻止 input 失焦，让 onclick 生效
  save.onclick = () => finish(true);
  input.onblur = () => finish(false);  // 点别处=取消（不保存半截）
}

async function addSearchTag(tag) {
  const cur = ((state.config && state.config.searchTags) || []).slice();
  if (cur.indexOf(tag) !== -1) return;  // 不允许重复
  cur.push(tag);
  if (state.config) state.config.searchTags = cur;  // 乐观更新（立即隐藏筛选行 + 显示新 tag，避免 await 往返期间闪烁）
  renderSearchTags();
  await send({ type: 'SET_CONFIG', config: { searchTags: cur } });
  await runSearch();
}

async function removeSearchTag(tag) {
  const cur = ((state.config && state.config.searchTags) || []).slice().filter((x) => x !== tag);
  if (state.config) state.config.searchTags = cur;  // 乐观更新
  renderSearchTags();
  await send({ type: 'SET_CONFIG', config: { searchTags: cur } });
  if (cur.length) await runSearch();
  else { searchResults = null; renderCards(); }  // 清空 tag：回到 buckets
}

// 发起定向搜索：串行查所有 tag → 合并去重 → 一次渲染。pageSize 用页面选的 listPageSize。
async function runSearch() {
  const tags = ((state.config && state.config.searchTags) || []);
  if (!tags.length) { searchResults = null; searching = false; renderCards(); return; }
  var _now = Date.now();                                   // 2s 节流：seq 只丢弃旧结果不挡连发——连点/回车连击每次都打 M-TEAM search（反风控）
  if (runSearch._lastAt && _now - runSearch._lastAt < 2000) return;
  runSearch._lastAt = _now;
  if (!hasApiKey(state)) return;
  const seq = ++_searchSeq;
  searching = true;
  renderCards();  // 立即显示 loading
  let items = [];
  try {
    const resp = await send({ type: 'SEARCH_MARKET', tags, pageSize: (state.config && state.config.listPageSize) || 10 });
    if (seq !== _searchSeq) return;  // 被更新的查询取代，丢弃旧结果
    items = (resp && resp.items) || [];
  } catch (e) {
    if (seq !== _searchSeq) return;
    items = [];
  }
  searchResults = items;
  searching = false;
  renderCards();
}
function buildInventoryChips() { buildFilterChips('inventoryRarityBox', inventoryFilter, renderInventory, true, true); }
function buildTradesChips() { buildFilterChips('tradeRarityBox', tradesFilter, renderTrades, false); }
function buildOrdersChips() { buildFilterChips('orderRarityBox', ordersFilter, renderOrders, false); }

// 挂单卡：复用 trade-card 外观，价格行右侧换成「数量」，底部为挂单时间
function buildOrderCard(it, delay) {
  const rarity = it.rarity || 'N';
  const filmId = it.filmId || '';
  const isMech = isMechCard(it);
  const name = isMech ? (mechLabel(filmId.slice(5)) || it.filmName || t('card.unnamed')) : (it.filmName || t('card.unnamed'));
  const url = buildDetailUrl(it, (state.config && state.config.webBase) || 'kp.m-team.cc');
  const price = (it.price != null && it.price !== '') ? Number(it.price) : null;
  const isSell = it.side === 'sell';
  const qty = Number(it.qty) || 1;

  const card = el('div', { cls: 'card trade-card order-card' + (isSell ? ' is-sell' : '') });
  card.style.animationDelay = delay + 'ms';

  card.classList.add('batch-mode');
  var chk = el('div', { cls: 'batch-check ' + (batchSelected.has(it.id) ? 'checked' : '') });
  card.appendChild(chk);
  card.classList.toggle('selected', batchSelected.has(it.id));
  card.onclick = () => onBatchCardClick(it, card, 'orders');

  const wrap = el('div', { cls: 'poster-wrap' });
  const fallback = el('div', { cls: 'poster-fallback', text: (name || '?').slice(0, 1) });
  fallback.style.display = 'none';
  if (it.poster) {
    const img = el('img', { cls: 'poster', attrs: { alt: name, loading: 'lazy' } });
    img.onerror = () => { img.remove(); fallback.style.display = 'grid'; };
    img.src = it.poster;
    wrap.appendChild(img);
  } else {
    fallback.style.display = 'grid';
  }
  wrap.appendChild(fallback);
  wrap.appendChild(el('div', { cls: 'rarity-badge ' + (isMech ? 'r-mech' : 'r-' + rarity), text: isMech ? t('card.badgeMech') : (RARITY_LABEL[rarity] || rarity) }));
  const openBtn = el('button', { cls: 'ca-open', attrs: { title: t('card.openInNewTabDetail') }, text: '↗' });
  openBtn.onclick = (e) => { e.stopPropagation(); window.open(url, '_blank'); };
  wrap.appendChild(openBtn);
  if (it.title && !isMech) {
    const tier = TITLE_TIER[it.title] || 'tt-5';
    wrap.appendChild(el('div', { cls: 'title-tag ' + tier, text: it.title }));
  }

  const body = el('div', { cls: 'card-body' });
  const nameRow = el('div', { cls: 'film-name-row' });
  append(nameRow,
    el('div', { cls: 'film-name', text: name }),
    el('span', { cls: 'side-tag ' + (isSell ? 'sell' : 'buy'), text: isSell ? t('order.sideAsk') : t('order.sideBid') })
  );
  append(body, nameRow);

  const statRow = el('div', { cls: 'trade-stat-row' });
  const magicCol = el('div', { cls: 'trade-col' });
  const priceEl = el('div', { cls: 'trade-price', attrs: price != null ? { title: fmtNum(price) } : {} });
  if (price != null) append(priceEl, document.createTextNode(fmtPrice(price)), el('span', { cls: 'trade-price-unit', text: t('common.magic') }));
  else priceEl.appendChild(el('span', { cls: 'trade-price-unit', text: t('common.magic') }));
  magicCol.appendChild(priceEl);
  const actCol = el('div', { cls: 'trade-col right' });
  const modifyBtn = el('button', { cls: 'inv-sell-btn', attrs: { type: 'button' }, text: t('order.modify') });
  modifyBtn.onclick = (e) => { e.stopPropagation(); onOrderModify(it); };
  actCol.appendChild(modifyBtn);
  append(statRow, magicCol, actCol);
  append(body, statRow);

  // 挂单历史入口（仅存活卡显示；点击展开该 cardId 的全部挂单记录）
  const histBtn = el('button', { cls: 'oh-trigger', attrs: { title: t('order.historyBtnTitle') }, text: t('order.historyBtn') });
  histBtn.onclick = (e) => { e.stopPropagation(); showOrderHistory(it.cardId, it); };
  append(body, histBtn);

  append(card, wrap, body);
  return card;
}

// 购买模态窗顶部：海报 + 稀有度徽章 + 片名 + 价格，让用户一眼确认买的是哪张
function buildModalHero(it) {
  const isMech = isMechCard(it);
  const rarity = (it.variant && it.variant.rarity) || it.rarity || 'N';
  const name = cardName(it);
  const hero = el('div', { cls: 'modal-hero' });
  const pw = el('div', { cls: 'modal-poster' });
  const fallback = el('div', { cls: 'poster-fallback', text: (name || '?').slice(0, 1) });
  fallback.style.display = 'none';
  if (it.poster) {
    const img = el('img', { attrs: { alt: name } });
    img.onerror = () => { img.remove(); fallback.style.display = 'grid'; };
    img.src = it.poster;
    pw.appendChild(img);
  } else {
    fallback.style.display = 'grid';
  }
  pw.appendChild(fallback);
  // 左上：稀有度/机制卡 badge（文字，在 modal 海报内与右下 title 统一缩小）
  const badgeCls = isMech ? 'rarity-badge r-mech' : 'rarity-badge r-' + rarity;
  const badgeText = isMech ? t('card.badgeMech') : (RARITY_LABEL[rarity] || rarity);
  pw.appendChild(el('div', { cls: badgeCls, text: badgeText }));
  // 右下：title 药丸（傳火/薪火/星火/殘焰/薪王）；机制卡不显示
  if (it.title && !isMech) {
    const tier = TITLE_TIER[it.title] || 'tt-5';
    pw.appendChild(el('div', { cls: 'title-tag ' + tier, text: it.title }));
  }
  // 海报按稀有度上色（2px 边框 + 阴影由 CSS 控）
  pw.style.borderColor = isMech ? 'var(--r-mech)' : ('var(--r-' + rarity + ')');
  const info = el('div', { cls: 'modal-hero-info' });
  append(info, el('div', { cls: 'modal-title', text: name }));
  if (it.year) append(info, el('div', { cls: 'modal-subtitle', text: it.year }));
  // 元信息 grid：稀有度/称号/来源/序号（参考官网 dl/dt/dd 两列布局）
  const provenance = it.provenance || (it.variant && it.variant.provenance) || '';
  const grid = el('dl', { cls: 'modal-hero-grid' });
  const addField = (lbl, val, extraCls) => {
    const dt = el('dt', { cls: 'mhg-label', text: lbl });
    const dd = el('dd', { cls: 'mhg-value ' + (extraCls || '') });
    dd.textContent = val;
    grid.appendChild(dt); grid.appendChild(dd);
  };
  if (!isMech && rarity) addField(t('modal.fieldRarity'), RARITY_LABEL[rarity] || rarity, 'mhg-bold');
  if (!isMech && it.title) addField(t('modal.fieldTitle'), it.title, 'mhg-bold');
  if (provenance) addField(t('modal.fieldSource'), t('provenance.' + provenance), 'mhg-source');
  if (it.serial) addField(t('modal.fieldSerial'), it.serial, 'mono');
  if (grid.children.length) append(info, grid);
  append(hero, pw, info);
  return hero;
}

// 自建模态窗（替代原生 confirm）：返回 Promise<boolean>
// 点遮罩 / Esc / 取消按钮 = false；确认按钮 / 聚焦时回车 = true
// opts.hero(节点) 优先，替代默认 icon+title 头部（购买时展示海报）
// modal 焦点归还：打开时记录触发元素，关闭后还焦点（键盘用户不丢上下文）。返回 restore 函数
function modalFocusRestore() {
  const prior = document.activeElement;
  return function restore() { try { if (prior && prior.focus) prior.focus(); } catch (e) {} };
}

function confirmDialog(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const restoreFocus = modalFocusRestore();
    const mask = el('div', { cls: 'modal-mask' });
    const box = el('div', { cls: 'modal' });
    if (opts.hero) {
      box.appendChild(opts.hero);
    } else {
      const head = el('div', { cls: 'modal-head' });
      append(head,
        el('div', { cls: 'modal-icon', text: opts.icon || '$' }),
        el('div', { cls: 'modal-title', text: opts.title || t('common.confirmTitle') })
      );
      box.appendChild(head);
    }
    const body = el('div', { cls: 'modal-body' });
    if (typeof opts.body === 'string') body.textContent = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    box.appendChild(body);

    const cancelBtn = el('button', { cls: 'btn ghost', text: opts.cancelText || t('common.cancel') });
    const confirmCls = opts.confirmVariant ? ('btn ' + opts.confirmVariant) : 'btn primary';
    const confirmBtn = el('button', { cls: confirmCls, text: opts.confirmText || t('common.confirm') });
    const actions = el('div', { cls: 'modal-actions' });
    append(actions, cancelBtn, confirmBtn);
    box.appendChild(actions);
    mask.appendChild(box);
    document.body.appendChild(mask);

    requestAnimationFrame(() => mask.classList.add('show'));
    setTimeout(() => { try { confirmBtn.focus(); } catch (e) {} }, 60);

    let done = false;
    function close(result) {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey);
      mask.classList.remove('show');
      setTimeout(() => { mask.remove(); restoreFocus(); }, 220);
      resolve(result);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    cancelBtn.onclick = () => close(false);
    confirmBtn.onclick = () => close(true);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });
  });
}

// 选择模态窗（hero + body + 2 选项按钮）：返回 '1' / '2' / null（Esc/遮罩关闭）
function choiceDialog(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const restoreFocus = modalFocusRestore();
    const mask = el('div', { cls: 'modal-mask' });
    const box = el('div', { cls: 'modal' });
    if (opts.hero) box.appendChild(opts.hero);
    else {
      const head = el('div', { cls: 'modal-head' });
      append(head, el('div', { cls: 'modal-icon', text: opts.icon || '$' }), el('div', { cls: 'modal-title', text: opts.title || t('common.confirmTitle') }));
      box.appendChild(head);
    }
    const body = el('div', { cls: 'modal-body' });
    if (typeof opts.body === 'string') body.textContent = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    box.appendChild(body);
    const opt1 = el('button', { cls: 'btn ' + (opts.option1Variant || 'ghost'), text: opts.option1Text || t('common.cancel') });
    const opt2 = el('button', { cls: 'btn ' + (opts.option2Variant || 'primary'), text: opts.option2Text || t('common.confirm') });
    const actions = el('div', { cls: 'modal-actions' });
    append(actions, opt1, opt2);
    box.appendChild(actions);
    mask.appendChild(box);
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('show'));
    let done = false;
    function close(result) { if (done) return; done = true; document.removeEventListener('keydown', onKey); mask.classList.remove('show'); setTimeout(() => { mask.remove(); restoreFocus(); }, 220); resolve(result); }
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    opt1.onclick = () => close('1');
    opt2.onclick = () => close('2');
    mask.addEventListener('click', (e) => { if (e.target === mask) close(null); });
  });
}

// 挂单修改：弹选择窗（取消挂单 / 修改挂单价）。改价 = cancel + 新价重新 sell
async function onOrderModify(it) {
  if (onOrderModify._busy) return;   // 单飞锁：撤单/改价（cancel+sell 两步）全程只允许一个流程，连点防重复撤挂
  onOrderModify._busy = true;
  try {
  const body = el('div');
  // 当前挂单价（改价参考）—— it.price 与挂单卡片同源（挂单价 = 净收入 × 1.05）
  const cur = (it.price != null && it.price !== '') ? Number(it.price) : NaN;
  if (Number.isFinite(cur)) {
    const priceLine = el('div', { cls: 'modal-price-line' });
    append(priceLine,
      el('span', { cls: 'modal-price-label', text: t('order.currentPrice') }),
      el('b', { cls: 'modal-price', text: fmtNum(cur) }),
      el('span', { cls: 'modal-price-unit', text: t('common.magic') })
    );
    body.appendChild(priceLine);
  }
  append(body, el('div', { cls: 'modal-note', text: t('order.modifyChoiceHint') }));
  const choice = await choiceDialog({
    hero: buildModalHero(it), body: body,
    option1Text: t('order.cancelOrder'), option1Variant: 'sell',
    option2Text: t('order.modifyPrice'), option2Variant: 'primary',
  });
  if (choice === '1') {
    const r = await send({ type: 'CANCEL_ORDER', orderId: it.id });
    showToast(r && r.ok ? t('order.cancelSuccess') : t('order.cancelFailed'), r && r.ok ? 'success' : 'error');
  } else if (choice === '2') {
    const netPrice = await promptSellPrice(it);
    if (netPrice == null) return;
    const cr = await send({ type: 'CANCEL_ORDER', orderId: it.id });
    if (!cr || !cr.ok) { showToast(t('order.cancelFailed'), 'error'); return; }
    const sr = await send({ type: 'SELL_CARD', cardId: it.cardId, isMech: isMechCard(it), netPrice: netPrice });
    if (sr && sr.ok) { await send({ type: 'LOAD_ORDERS' }); showToast(t('order.modifySuccess'), 'success'); }
    else showToast(t('order.modifyFailed'), 'error');
  }
  } finally { onOrderModify._busy = false; }
}

// 一键购买：二次确认 → 后台开详情页核对价格并成交
async function onBuy(it) {
  if (onBuy._busy) return;   // 单飞锁：确认弹窗+购买全程只允许一个流程（连点/多卡并发 = 双买风险）
  onBuy._busy = true;
  try {
  const price = it.lowestAsk;
  // 无卖单防御（lowestAsk=null 或负值）；0 放行（可能有 0 价挂单）
  if (price == null || Number(price) < 0) { showToast(t('err.noAsk'), 'error'); return; }
  const name = cardName(it);
  // 预算魔力池拦截：未设/不足则直接提示，不进入二次确认（与 background buyCard 同口径）
  const u = computeUsable(state);
  if (u.bTotal <= 0) { showToast(t('err.buyBudgetNotSet'), 'error'); return; }
  if (Number(price) > u.usable) {
    const reason = u.bonus < u.remaining ? t('err.balanceInsufficient') : t('err.budgetRemainingInsufficient');
    showToast(reason + t('err.buyBudgetInsufficientToast', { price: price, usable: u.usable }), 'error');
    return;
  }
  const body = el('div');
  // 价格展示（lowestAsk）
  const priceLine = el('div', { cls: 'modal-price-line' });
  append(priceLine,
    el('b', { cls: 'modal-price', text: fmtNum(price) }),
    el('span', { cls: 'modal-price-unit', text: t('common.magic') })
  );
  append(body,
    priceLine,
    el('div', { cls: 'modal-note', text: t('trade.buyConfirmNote', { price: price }) })
  );
  const ok = await confirmDialog({
    hero: buildModalHero(it),
    body,
    confirmText: t('common.buy'),
    cancelText: t('common.cancel'),
    confirmVariant: 'buy',
  });
  if (!ok) return;
  // 购买走 background buy 直连（buy 限价 + 可能 cancel 撤挂单），结果回这里展示
  const loading = showToast(t('trade.buyingToast', { name: name }), 'info', 0);
  let resp;
  try {
    const _rar = (it.rarity || (it.variant || {}).rarity || '');
    const _monLimit = Number(((state.config && state.config.maxPriceByRarity) || {})[_rar]) || 0;
    resp = await send({ type: 'BUY_CARD', variant: it.variant, expectPrice: Number(price), filmName: name, poster: it.poster || '', rarity: _rar, title: (it.title || ''), maxPrice: _monLimit });
  } catch (e) {
    resp = { ok: false, reason: 'error' };
  }
  dismissToast(loading);
  if (resp && resp.ok && resp.confirmed) {
    showToast(t('trade.buySuccessToast', { name: name, price: resp.price }), 'success');
  } else if (resp && resp.ok && !resp.confirmed) {
    showToast(t('trade.buyUnconfirmedToast', { name: name }), 'info');
  } else {
    const reason = (resp && resp.reason) || 'error';
    const text = t(BUY_FAIL_REASON[reason] || 'err.unknownReason');
    // cancel 撤单也失败（残留挂单）：toast 附 detail url 提示用户到站点手动撤销
    const extra = (resp && resp.cancelFailed && resp.url)
      ? t('err.cancelFailedExtra', { url: resp.url }) : '';
    showToast(t('trade.buyFailedToast', { text: text + extra }), 'error');
  }
  } finally { onBuy._busy = false; }
}

// ---------- 事件 ----------
async function onRarityChange() {
  const sel = RARITIES.filter((r) => {
    const node = document.querySelector('input[data-r="' + r + '"]');
    return node && node.checked;
  });
  if (!sel.length) {
    const fb = document.querySelector('input[data-r="N"]');
    if (fb) { fb.checked = true; const c = fb.closest('.chip'); if (c) c.classList.add('on'); }
    sel.push('N');
  }
  document.querySelectorAll('.chip').forEach((c) => {
    const inp = c.querySelector('input'); if (inp) c.classList.toggle('on', inp.checked);
  });
  const cfg = Object.assign({}, state.config || {}, { rarities: sel });
  await send({ type: 'SET_CONFIG', config: cfg });
  state = await send({ type: 'GET_STATE' });
  renderAll();
}

async function onMechChange() {
  const sel = MECH_TYPES.filter((m) => {
    const node = document.querySelector('input[data-m="' + m.type + '"]');
    return node && node.checked;
  }).map((m) => m.type);
  document.querySelectorAll('#mechBox .chip').forEach((c) => {
    const inp = c.querySelector('input'); if (inp) c.classList.toggle('on', inp.checked);
  });
  const cfg = Object.assign({}, state.config || {}, { mechTypes: sel });
  await send({ type: 'SET_CONFIG', config: cfg });
  state = await send({ type: 'GET_STATE' });
  renderAll();
}

async function onThresholdChange(e) {
  const key = e.target.dataset.key;
  const kind = e.target.dataset.kind;
  const v = parseInt(e.target.value, 10);
  const val = Number.isFinite(v) && v > 0 ? v : 0;
  const cfg = Object.assign({}, state.config || {});
  if (kind === 'm') {
    const cur = Object.assign({}, cfg.maxPriceByMech || {});
    cur[key] = val;
    cfg.maxPriceByMech = cur;
  } else {
    const cur = Object.assign({}, cfg.maxPriceByRarity || {});
    cur[key] = val;
    cfg.maxPriceByRarity = cur;
  }
  await send({ type: 'SET_CONFIG', config: cfg });
  state = await send({ type: 'GET_STATE' });
  renderLive();
}

async function onPageSizePick(value) {
  document.querySelectorAll('#pageSizeBox .seg-btn').forEach((b) => {
    b.classList.toggle('on', Number(b.textContent) === value);
  });
  const cfg = Object.assign({}, state.config || {}, { listPageSize: value });
  await send({ type: 'SET_CONFIG', config: cfg });
  state = await send({ type: 'GET_STATE' });
  renderLive();
  triggerMarketRefresh();   // 改 pageSize 后立即刷新市场（有 tag → 重 search；统一入口：节流+按钮 spin 同步）
}

async function onModePick(value) {
  document.querySelectorAll('#modeBox .seg-btn').forEach((b, i) => {
    b.classList.toggle('on', MODES[i] && MODES[i].value === value);
  });
  await send({ type: 'SET_CONFIG', config: Object.assign({}, state.config, { viewMode: value }) });
  state = await send({ type: 'GET_STATE' });
  renderLive();
}

// 导入合并：只合并扩展自产数据——config（deepMerge，budget 仅保留 total/spent 本机值）。
// 业务数据（交易/挂单/持有/机制卡/Bonus/资料/掉落统计）均可从 API 全量重采，不再导入导出；老版导出文件里的这些字段会被忽略。
function mergeImportedData(cur, incoming) {
  const result = Object.assign({}, cur);
  if (incoming.config) {
    result.config = Object.assign({}, cur.config || {}, incoming.config);
    if (incoming.config.budget) {
      // budget：total/spent 为本机状态，保留当前值不导入（仅合并可能存在的其他字段）
      const curB = (cur.config && cur.config.budget) || {};
      result.config.budget = {
        total: curB.total != null ? curB.total : 0,
        spent: curB.spent != null ? curB.spent : 0,
      };
    }
  }
  return result;
}
// 导出白名单：只导出扩展自产数据（config）
const EXPORT_KEYS = ['config'];
// 导出：config 固定导出
function onExport() {
  // Web 端：config 由后端 state 提供（GET_STATE 已脱敏 apiKey 为 '(set)'），直接读内存。
  const data = { config: (state && state.config) ? Object.assign({}, state.config) : null };
  const mask = el('div', { cls: 'modal-mask' });
  const box = el('div', { cls: 'modal' });
  const head = el('div', { cls: 'modal-head' });
  append(head, el('div', { cls: 'modal-icon', text: '↧' }), el('div', { cls: 'modal-title', text: t('common.exportTitle') }));
  box.appendChild(head);
  const body = el('div', { cls: 'modal-body' });
  append(body, el('div', { cls: 'modal-note', text: t('common.exportNote') }));
  box.appendChild(body);
  const actions = el('div', { cls: 'modal-actions' });
  const cancelBtn = el('button', { cls: 'btn ghost', text: t('common.cancel') });
  const dlBtn = el('button', { cls: 'btn primary', text: t('panel.export') });
  append(actions, cancelBtn, dlBtn);
  box.appendChild(actions);
  mask.appendChild(box);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('show'));
  let done = false;
  const close = () => { if (done) return; done = true; mask.classList.remove('show'); setTimeout(() => mask.remove(), 220); };
  cancelBtn.onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  dlBtn.onclick = () => {
    const out = {};
    if (data.config) {
      const cfg = Object.assign({}, data.config);
      delete cfg.apiKey;  // 凭证不入导出文件（原扩展 apiKey 独立于 config 存储，此处对齐脱敏语义）
      out.config = cfg;
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mteam-monitor-data.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast(t('common.exportSuccess'), 'success');
    close();
  };
}
// 导入数据：模态窗选文件 + 校验，校验通过才允许导入
function onImport() {
  const mask = el('div', { cls: 'modal-mask' });
  const box = el('div', { cls: 'modal' });
  const head = el('div', { cls: 'modal-head' });
  append(head, el('div', { cls: 'modal-icon', text: '↥' }), el('div', { cls: 'modal-title', text: t('common.importTitle') }));
  const body = el('div', { cls: 'modal-body' });
  append(body, el('div', { cls: 'modal-note', text: t('common.importNote') }));
  const fileRow = el('div', { cls: 'import-file-row' });
  const pickBtn = el('button', { cls: 'btn ghost', text: t('common.importPickFile') });
  const fileName = el('span', { cls: 'import-filename', text: t('common.importNoFile') });
  append(fileRow, pickBtn, fileName);
  body.appendChild(fileRow);
  const status = el('div', { cls: 'import-status' });
  body.appendChild(status);
  const input = el('input', { attrs: { type: 'file', accept: 'application/json,.json' } });
  input.style.display = 'none';
  body.appendChild(input);
  append(box, head, body);
  const actions = el('div', { cls: 'modal-actions' });
  const cancelBtn = el('button', { cls: 'btn ghost', text: t('common.cancel') });
  const confirmBtn = el('button', { cls: 'btn primary', text: t('common.import'), attrs: { disabled: 'true' } });
  append(actions, cancelBtn, confirmBtn);
  box.appendChild(actions);
  mask.appendChild(box);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('show'));

  let parsed = null;
  let done = false;
  const close = () => {
    if (done) return; done = true;
    document.removeEventListener('keydown', onKey);
    mask.classList.remove('show');
    setTimeout(() => mask.remove(), 220);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  cancelBtn.onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  pickBtn.onclick = () => input.click();
  const setFail = (msg) => { confirmBtn.setAttribute('disabled', 'true'); status.textContent = msg; status.className = 'import-status error-text'; };
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    fileName.textContent = file.name;
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (err) { parsed = null; setFail(t('err.importInvalidJson')); input.value = ''; return; }
    if (data && typeof data === 'object' && data.config) {
      parsed = data;
      const cnt = ((data.config && data.config.presets) || []).length;
      status.textContent = t('common.importValid', { n: cnt });
      status.className = 'import-status ok-text';
      confirmBtn.removeAttribute('disabled');
    } else {
      parsed = null;
      setFail(t('err.importMissingConfig'));
    }
    input.value = '';
  };
  confirmBtn.onclick = async () => {
    if (!parsed) return;
    // Web 端：合并后经 SET_CONFIG 落盘后端（setConfig 会 deepMerge 并剔除 apiKey）。
    const merged = mergeImportedData({ config: state.config || {} }, parsed);
    await send({ type: 'SET_CONFIG', config: merged.config });
    showToast(t('common.importSuccess'), 'success');
    close();
  };
}

// ---------- 阈值方案 ----------
// 预设方案预览态：点 tag 切换选中（仅预览参数），点「应用」才真正加载
let selectedPreset = null;

function renderPresetList() {
  const box = $('presetList');
  if (!box) return;
  const presets = (state && state.config && state.config.presets) || [];
  box.replaceChildren();
  if (!presets.length) {
    box.appendChild(el('div', { cls: 'panel-hint', text: t('cfg.presetListEmpty') }));
    return;
  }
  // 保留上次选中；被删/失效则回退第一个
  if (!selectedPreset || !presets.find((p) => p.name === selectedPreset.name)) selectedPreset = presets[0];
  const p = selectedPreset;

  // ① 方案名 tag（点击切换预览，× 删除）
  const tagsRow = el('div', { cls: 'preset-tags' });
  presets.forEach((it) => {
    const tag = el('div', { cls: 'chip preset-tag' + (it.name === p.name ? ' on' : ''), text: it.name });
    tag.title = it.name;
    tag.onclick = () => { selectedPreset = it; renderPresetList(); };
    tagsRow.appendChild(tag);
  });
  box.appendChild(tagsRow);

  // ② 选中方案参数详情
  const rarities = (p.rarities || []).join(' / ') || '—';
  const prices = RARITIES.map((r) => { const v = Number(p.values && p.values[r]) || 0; return v > 0 ? r + ' ' + v : null; }).filter(Boolean).join(' · ') || t('cfg.presetNoLimit');
  const mechs = MECH_TYPES.map((m) => { const v = Number(p.mechValues && p.mechValues[m.type]) || 0; return v > 0 ? mechLabel(m.type) + ' ' + v : null; }).filter(Boolean).join(' · ');
  const detail = el('div', { cls: 'preset-detail' });
  const detailRow = (label, val) => { const r = el('div', { cls: 'pd-row' }); append(r, el('span', { cls: 'pd-label', text: label }), el('span', { cls: 'pd-val', text: val })); return r; };
  append(detail, detailRow(t('cfg.rarity'), rarities), detailRow(t('cfg.priceThreshold'), prices));
  if (mechs) detail.appendChild(detailRow(t('cfg.mech'), mechs));
  box.appendChild(detail);

  // ③ 删除（左下角）/ 应用（右下角）
  const act = el('div', { cls: 'preset-detail-actions' });
  const delBtn = el('button', { cls: 'btn ghost', text: t('common.delete') });
  delBtn.onclick = () => { if (selectedPreset) onPresetDelete(selectedPreset.name); };
  const applyBtn = el('button', { cls: 'btn primary', text: t('cfg.presetApply') });
  applyBtn.onclick = () => { if (selectedPreset) onPresetLoad(selectedPreset); };
  append(act, delBtn, applyBtn);
  box.appendChild(act);
}

async function onPresetSave() {
  const input = $('presetName');
  const name = (input.value || '').trim();
  if (!name) { showToast(t('err.presetNameRequired'), 'error'); input.focus(); return; }
  const presets = ((state.config && state.config.presets) || []).slice();
  const idx = presets.findIndex((p) => p.name === name);
  const entry = {
    name,
    rarities: ((state.config && state.config.rarities) || []).slice(),
    values: Object.assign({}, (state.config && state.config.maxPriceByRarity) || {}),
    mechTypes: ((state.config && state.config.mechTypes) || []).slice(),
    mechValues: Object.assign({}, (state.config && state.config.maxPriceByMech) || {}),
  };
  if (idx >= 0) presets[idx] = entry; else presets.push(entry);
  await send({ type: 'SET_CONFIG', config: Object.assign({}, state.config, { presets }) });
  state = await send({ type: 'GET_STATE' });
  input.value = '';
  renderPresetList();
  showToast(idx >= 0 ? t('cfg.presetUpdated', { name: name }) : t('cfg.presetSaved', { name: name }));
}

async function onPresetLoad(preset) {
  const patch = { maxPriceByRarity: Object.assign({}, preset.values) };
  // 有保存稀有度的方案才恢复（兼容旧方案：无 rarities 时不动当前勾选）
  if (preset.rarities && preset.rarities.length) patch.rarities = preset.rarities.slice();
  // 机制卡：仅当方案保存了机制卡字段时才恢复（兼容旧方案）
  if (preset.mechTypes) patch.mechTypes = preset.mechTypes.slice();
  if (preset.mechValues) patch.maxPriceByMech = Object.assign({}, preset.mechValues);
  await send({ type: 'SET_CONFIG', config: Object.assign({}, state.config, patch) });
  state = await send({ type: 'GET_STATE' });
  renderAll();
  showToast(t('cfg.presetLoaded', { name: preset.name }));
}

async function onPresetDelete(name) {
  const presets = ((state.config && state.config.presets) || []).filter((p) => p.name !== name);
  await send({ type: 'SET_CONFIG', config: Object.assign({}, state.config, { presets }) });
  state = await send({ type: 'GET_STATE' });
  renderPresetList();
  showToast(t('cfg.presetDeleted', { name: name }));
}

// 价格阈值模态窗：市场筛选条「价格阈值」入口弹出（含阈值列表 + 预设方案）
function openThresholdModal() {
  const m = $('thresholdModal');
  if (!m) return;
  _thFocusRestore = modalFocusRestore();
  m.hidden = false;
  const main = $('mainArea');
  if (main) main.style.overflow = 'hidden';  // 锁背景滚动（main 是滚动容器）
  requestAnimationFrame(() => {
    m.classList.add('show');
    const first = m.querySelector('input'); if (first) first.focus();  // a11y：打开即聚焦首输入
  });
}
let _thFocusRestore = null;
function closeThresholdModal() {
  const m = $('thresholdModal');
  if (!m) return;
  m.classList.remove('show');
  setTimeout(() => {
    m.hidden = true;
    const main = $('mainArea'); if (main) main.style.overflow = '';  // 模态消失后再解锁
    if (_thFocusRestore) { _thFocusRestore(); _thFocusRestore = null; }
  }, 180);
}

// 右下角状态 Toast：type='success'(绿,默认) | 'error'(红) | 'info'(蓝,进行中/提示)。
// duration: ms，0=持久(需手动 dismissToast)。支持多个堆叠。返回 toast 元素。
function showToast(msg, type, duration) {
  type = (type === 'error' || type === 'info') ? type : 'success';
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = el('div', { cls: 'toast-wrap', attrs: { role: 'status', 'aria-live': 'polite' } }); document.body.appendChild(wrap); }
  const t = el('div', { cls: 'toast ' + type });
  const icon = type === 'error' ? '!' : type === 'info' ? 'i' : '✓';
  append(t,
    el('div', { cls: 'toast-icon', text: icon }),
    el('div', { cls: 'toast-msg', text: msg })
  );
  wrap.appendChild(t);
  // 双 rAF 确保初始 transform(translateX 120%) 先渲染，再加 show 触发滑入过渡
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  clearTimeout(t._timer);
  const ms = duration == null ? 3600 : duration;
  if (ms > 0) t._timer = setTimeout(() => dismissToast(t), ms);
  return t;
}
function dismissToast(t) {
  if (!t) return;
  clearTimeout(t._timer);
  t.classList.remove('show');
  setTimeout(() => t.remove(), 360);
}

// ---------- helpers ----------
// 阈值行：tagCls 决定 dot 颜色类(r-UR/r-mech)；mechType 非空=机制卡(data-kind='m')
function buildThresholdRow(tagCls, label, value, mechType) {
  const row = el('div', { cls: 'th-row' + (mechType ? ' th-row-mech' : '') });
  const tag = el('div', { cls: 'th-tag ' + tagCls });
  const dot = el('span', { cls: 'dot' });
  dot.style.background = tagCls === 'r-mech' ? 'var(--r-mech)' : 'var(--' + tagCls + ')';
  append(tag, dot, el('span', { text: label }));
  const key = mechType || tagCls.replace('r-', '');
  const kind = mechType ? 'm' : 'r';
  const input = el('input', {
    cls: 'th-input',
    attrs: { type: 'number', min: '0', step: '100', placeholder: t('cfg.thresholdPlaceholder'), 'data-key': key, 'data-kind': kind },
  });
  const v = Number(value);
  if (v > 0) input.value = v;
  input.addEventListener('change', onThresholdChange);
  append(row, tag, input);
  return row;
}

function cardName(it) {
  if (isMechCard(it)) return mechLabel(mechTypeOf(it)) || it.filmName || t('card.unnamed');
  return it.filmName || t('card.unnamed');
}
function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}
// 紧凑数字：K/M/B 缩写（保 2 位小数）——移动端预算条等窄空间用
function fmtCompact(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(Math.round(n * 100) / 100);
}
function fmtBytes(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = n;
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(2) + u[i];
}
function fmtRate(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}
function fmtDate(s) {
  if (!s) return '—';
  return String(s).split(' ')[0];
}

// 预算魔力池：一次性绑定总额输入与重置按钮
function initBudget() {
  // 直接 send budget patch（background setConfig 已深合并，未传字段如 spent 自动保留）
  const sendBudget = async (patch) => {
    await send({ type: 'SET_CONFIG', config: { budget: patch } });
    if (state.config) state.config.budget = Object.assign({}, state.config.budget, patch);
    renderBudgetBar(state.profile);
  };
  const bt = $('budgetTotal');
  if (bt) bt.addEventListener('change', async () => {
    const newTotal = Math.max(0, Math.floor(Number(bt.value) || 0));
    await sendBudget({ total: newTotal });
  });
  const br = $('budgetReset');
  if (br) br.addEventListener('click', async () => {
    const body = el('div', { cls: 'modal-note', text: t('budget.resetNote') });
    const ok = await confirmDialog({ icon: '↻', title: t('budget.resetTitle'), body, confirmText: t('common.reset'), cancelText: t('common.cancel') });
    if (!ok) return;
    await sendBudget({ total: 0, spent: 0 }); // 重置 = 清总额与已花费
    if (bt) bt.value = '';
  });
}

// ---------- 主题切换（两态：dark / light） ----------
const THEME_LABEL = { dark: t('theme.dark'), light: t('theme.light') };

// ---------- 语言 ----------
function initLang(storedConfigLang) {
  var lang = window.__lang || storedConfigLang || detectLang();
  setI18nLang(lang);
  if (!localStorage.getItem('mcard.lang')) {
    localStorage.setItem('mcard.lang', lang);
    patchConfigLang(lang);
  }
  applyI18n(document);
}
function setLang(lang) {
  lang = (lang === 'en') ? 'en' : 'zh';
  localStorage.setItem('mcard.lang', lang);
  setI18nLang(lang);
  patchConfigLang(lang);
  applyI18n(document);
  renderAll();
}
function patchConfigLang(lang) {
  // Web 端：lang 走 SET_CONFIG 增量合并（后端 deepMerge 仅改 lang 字段）。
  send({ type: 'SET_CONFIG', config: { lang: lang } });
}

function initTheme() {
  const btn = $('themeBtn');
  if (!btn) return;
  const __t = window.__theme || {};
  const resolve = __t.resolve || function (p) { return p === 'light' ? 'light' : 'dark'; };
  const apply = (p) => { document.documentElement.dataset.theme = resolve(p); };
  let pref = localStorage.getItem('mcard.theme') || 'light';
  if (pref !== 'dark' && pref !== 'light') pref = 'light';
  function render() {
    const label = t('theme.btnLabel', { label: THEME_LABEL[pref] });
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  btn.addEventListener('click', () => {
    pref = pref === 'dark' ? 'light' : 'dark';
    localStorage.setItem('mcard.theme', pref);
    apply(pref);
    render();
  });
  render();
}

// ---------- 回到顶部 ----------
function initBackTop() {
  const area = $('mainArea');
  const btn = $('backTopBtn');
  if (!area || !btn) return;
  area.addEventListener('scroll', () => {
    btn.classList.toggle('show', area.scrollTop > 200);
  });
  btn.addEventListener('click', () => {
    area.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ---------- API 直连测试（POC：令牌仅本会话内存，不落盘） ----------
// ---------- API 令牌管理面板（折叠 / 脱敏查看 / 修改 / 保存即校验）----------
function maskToken(t) {
  if (!t) return '';
  return t.length > 10 ? t.slice(0, 4) + '••••' + t.slice(-4) : '••••';
}

// 刷新令牌面板到 view 态（脱敏值 + 徽章 + 显隐编辑控件）。编辑中（readOnly=false）跳过，避免覆盖输入。
function renderTokenPanel() {
  var field = $('tokenField');
  var badge = $('tokenBadge');
  var editIcon = $('tokenEditIcon');
  var editActions = $('tokenEditActions');
  if (!field || !field.readOnly) return;   // 不存在或编辑中：不覆盖
  var key = hasApiKey(state) || '';
  field.value = key ? '••••••••' : '';
  field.placeholder = key ? '' : t('token.placeholderEmpty');
  field.classList.remove('editing');
  if (badge) { badge.textContent = key ? t('token.set') : t('token.unset'); badge.className = 'token-badge' + (key ? ' on' : ''); }
  if (editActions) editActions.hidden = true;
  if (editIcon) editIcon.hidden = !key;
  var apiEl = $('siteApi');
  if (apiEl) {
    var apiBase = (state.config && state.config.apiBase) || 'api.m-team.cc';
    apiEl.textContent = t('site.currentApi', { base: apiBase });
  }
}

function initTokenPanel() {
  var panel = $('tokenPanel');
  var toggle = $('tokenToggle');
  var field = $('tokenField');
  var editIcon = $('tokenEditIcon');
  var editActions = $('tokenEditActions');
  var saveBtn = $('tokenSaveBtn');
  var msg = $('tokenMsg');
  if (!panel || !field) return;

  function editMode() {
    field.value = '';
    field.readOnly = false;
    field.placeholder = t('token.placeholderNew');
    field.classList.add('editing');
    if (editActions) editActions.hidden = false;
    if (editIcon) editIcon.hidden = true;
    if (msg) msg.textContent = '';
    field.focus();
  }

  if (toggle) toggle.addEventListener('click', function () { panel.classList.toggle('collapsed'); });
  if (editIcon) editIcon.addEventListener('click', editMode);
  // 编辑中失焦（点别处）= 取消回 view 态；保存按钮 mousedown 阻止失焦，故点保存不会取消。
  field.addEventListener('blur', function () {
    if (field.readOnly) return;
    field.readOnly = true;
    if (msg) msg.textContent = '';
    renderTokenPanel();
  });
  if (saveBtn) {
    saveBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });  // 保住 input 焦点
    saveBtn.addEventListener('click', async function () {
      var key = (field.value || '').trim();
      if (!key) { if (msg) { msg.textContent = t('token.errEmpty'); msg.className = 'token-msg err'; } field.focus(); return; }
      saveBtn.disabled = true;
      if (msg) { msg.textContent = t('token.verifying'); msg.className = 'token-msg'; }
      var r = await send({ type: 'SAVE_API_KEY', key: key });
      saveBtn.disabled = false;
      if (r && r.ok) {
        field.readOnly = true;            // 退出编辑态，让 renderAll→renderLive→renderTokenPanel 刷新
        state = await send({ type: 'GET_STATE' });
        document.body.classList.remove('no-token');
        apiKeyInvalidShown = false;  // 新 key 已保存，重置失效弹窗 guard
        renderAll();
        if (msg) { msg.textContent = t('token.saved'); msg.className = 'token-msg ok'; }
        setTimeout(function () { if (msg && field.readOnly) msg.textContent = ''; }, 2000);
      } else {
        var reason = (r && r.reason) || 'unknown';
        if (msg) {
          msg.textContent = reason === 'invalid' ? t('token.errInvalid') : (reason === 'network' ? t('token.errNetwork') : t('token.errSave'));
          msg.className = 'token-msg err';
        }
        field.focus(); field.select();   // 失败：留在编辑态便于重输
      }
    });
  }

  // 网址入口下拉：选项 + 切换（只存 webBase，不验证不刷新）
  var siteSel = $('siteSelect');
  if (siteSel) {
    WEB_OPTS.forEach(function (w) {
      var o = document.createElement('option');
      o.value = w; o.textContent = 'https://' + w + '/';
      siteSel.appendChild(o);
    });
    siteSel.value = (state.config && state.config.webBase) || 'kp.m-team.cc';
    siteSel.addEventListener('change', async function () {
      await send({ type: 'SET_WEB_BASE', webBase: siteSel.value });
      state = await send({ type: 'GET_STATE' });
      renderAll();   // 重绘 url 链接（用新 webBase）
    });
  }

  renderTokenPanel();
}

// ---------- 首次令牌引导模态窗（无 mtApiKey 时弹出，保存后触发首次全量刷新建库）----------
// 打开令牌模态窗（首次引导 + 令牌失效重新输入复用同一入口）
var _tokenFocusRestore = null;
function openTokenModal() {
  var modal = $('tokenModal');
  var input = $('tokenModalInput');
  var save = $('tokenModalSave');
  var consent = $('tokenModalConsent');
  if (!modal || !input || !save) return;
  _tokenFocusRestore = modalFocusRestore();
  modal.hidden = false;
  input.value = '';
  var siteSel = $('tokenModalSite');
  if (siteSel) {
    siteSel.value = (state.config && state.config.webBase) || 'kp.m-team.cc';
    var _labA = $('labUrl');   // 模态内实验室链接随选中站即时更新（未保存的待选值）
    if (_labA) { var _u = webUrl(siteSel.value, '/usercp?tab=laboratory'); _labA.href = _u; _labA.textContent = _u; }
  }
  if (consent) consent.checked = false;
  save.disabled = true;
  setTimeout(function(){ input.focus(); }, 50);
}
function initTokenModal() {
  var modal = $('tokenModal');
  var input = $('tokenModalInput');
  var save = $('tokenModalSave');
  var consent = $('tokenModalConsent');
  var verifying = false;
  function syncSaveDisabled() { if (!verifying) save.disabled = consent ? !consent.checked : false; }
  if (!modal || !input || !save) return;
  if (!hasApiKey(state)) openTokenModal();
  if (consent) consent.addEventListener('change', syncSaveDisabled);
  var _siteSel = $('tokenModalSite');
  if (_siteSel) _siteSel.addEventListener('change', function () {   // 切站即时更新实验室链接（待选值）
    var a = $('labUrl');
    if (a) { var u = webUrl(_siteSel.value, '/usercp?tab=laboratory'); a.href = u; a.textContent = u; }
  });
  save.addEventListener('click', async function () {
    var token = (input.value || '').trim();
    if (!token) { input.focus(); return; }
    if (consent && !consent.checked) { consent.focus(); return; }  // 必须勾选同意
    verifying = true; save.disabled = true;
    var origText = save.textContent; save.textContent = t('token.verifying');
    var siteSel = $('tokenModalSite');
    var webBase = siteSel ? siteSel.value : 'kp.m-team.cc';
    var r = await send({ type: 'SAVE_API_KEY', key: token, webBase: webBase });
    verifying = false; save.textContent = origText;
    syncSaveDisabled();
    if (r && r.ok) {
      modal.hidden = true;
      if (_tokenFocusRestore) { _tokenFocusRestore(); _tokenFocusRestore = null; }
      document.body.classList.remove('no-token');
      apiKeyInvalidShown = false;  // 新 key 已保存，重置失效弹窗 guard，下次失效可再弹
      state = await send({ type: 'GET_STATE' });
      renderAll();
      triggerMarketRefresh(true);   // 验证后立即触发市场采集（refreshAll 的 ensure 前置慢、市场 startRound 排最后；先采一轮让市场尽快出卡；force 绕节流）
    } else {
      var msgEl = $('tokenModalMsg');
      if (msgEl) { msgEl.textContent = (r && r.reason === 'invalid') ? t('token.errInvalid') : t('token.errVerify'); msgEl.className = 'token-msg err'; }
      input.focus(); input.select();
    }
  });
}

// 实验室链接按当前 webBase 动态生成（切站点后随 renderAll 刷新）
function applyLabUrl() {
  var a = $('labUrl');
  if (a) {
    var webBase = (state.config && state.config.webBase) || 'kp.m-team.cc';
    a.href = webUrl(webBase, '/usercp?tab=laboratory');
    a.textContent = webUrl(webBase, '/usercp?tab=laboratory');
  }
}

// ---------- 启动 ----------
(async () => {
  state = await send({ type: 'GET_STATE' });
  initLang(state && state.config && state.config.lang);
  var _langBtn = document.getElementById('langBtn');
  if (_langBtn) _langBtn.addEventListener('click', function () { setLang(getI18nLang() === 'en' ? 'zh' : 'en'); });
  initTheme();
  renderAll();
  // 移动端：交易/挂单/持有 顶部统计卡片折叠头（默认折叠，点击展开；头本身只在移动端+有数据时由 CSS 显示）
  ['tradeStats', 'ordersStats', 'inventoryStats'].forEach(function (id) {
    var box = document.getElementById(id);
    if (!box || (box.previousElementSibling && box.previousElementSibling.classList.contains('stats-fold-head'))) return;
    var head = document.createElement('button');
    head.className = 'stats-fold-head'; head.type = 'button';
    var ico = document.createElement('span'); ico.className = 'sf-ico'; ico.textContent = '📊';
    var lbl = document.createElement('span'); lbl.className = 'sf-label'; lbl.setAttribute('data-i18n', 'panel.statsOverview'); lbl.textContent = t('panel.statsOverview');
    var caret = document.createElement('i'); caret.className = 'sf-caret';
    head.appendChild(ico); head.appendChild(lbl); head.appendChild(caret);
    head.addEventListener('click', function () { box.classList.toggle('unfolded'); });
    box.insertAdjacentElement('beforebegin', head);
  });
  // 移动端抽屉：hamburger 开/合 + 遮罩点击关闭
  var _mt = $('menuToggle'), _mk = $('drawerMask'), _sb = document.querySelector('.sidebar');
  if (_mt && _sb) _mt.addEventListener('click', function () {
    var open = _sb.classList.toggle('open');
    if (_mk) _mk.classList.toggle('open', open);
  });
  if (_mk) _mk.addEventListener('click', function () {
    if (_sb) _sb.classList.remove('open');
    _mk.classList.remove('open');
  });
  initBackTop();
  initTradesSearch();
  initOrdersSearch();
  initInventorySearch();
  initBudget();
  initBatch();
  initTokenPanel();
  if (!hasApiKey(state)) document.body.classList.add('no-token');
  initTokenModal();
  // 加载时刷新市场：有定向 tag → runSearch；否则 → triggerRefreshRound（统一入口：节流+按钮 spin 同步）
  triggerMarketRefresh();
})();

// 交易记录搜索框事件绑定（仅初始化一次）
function initTradesSearch() {
  const txt = $('tradeSearchText');
  if (txt) txt.addEventListener('input', (e) => { tradesFilter.text = e.target.value; renderTrades(); });
  const df = $('tradeDateFrom');
  if (df) df.addEventListener('change', (e) => { tradesFilter.dateFrom = e.target.value; renderTrades(); });
  const dt = $('tradeDateTo');
  if (dt) dt.addEventListener('change', (e) => { tradesFilter.dateTo = e.target.value; renderTrades(); });
  const ex = $('tradeExact');
  if (ex) ex.addEventListener('change', (e) => { tradesFilter.exact = e.target.checked; renderTrades(); });
  const clr = $('tradeSearchClear');
  if (clr) clr.onclick = () => {
    tradesFilter = { text: '', dateFrom: '', dateTo: '', exact: false, rarities: new Set(), mech: false, titles: new Set(), side: null };
    if (txt) txt.value = '';
    if (df) df.value = '';
    if (dt) dt.value = '';
    if (ex) ex.checked = false;
    renderTrades();
  };
}

// 挂单搜索框事件绑定（仅初始化一次）
function initOrdersSearch() {
  const txt = $('orderSearchText');
  if (txt) txt.addEventListener('input', (e) => { ordersFilter.text = e.target.value; renderOrders(); });
  const df = $('orderDateFrom');
  if (df) df.addEventListener('change', (e) => { ordersFilter.dateFrom = e.target.value; renderOrders(); });
  const dt = $('orderDateTo');
  if (dt) dt.addEventListener('change', (e) => { ordersFilter.dateTo = e.target.value; renderOrders(); });
  const ex = $('orderExact');
  if (ex) ex.addEventListener('change', (e) => { ordersFilter.exact = e.target.checked; renderOrders(); });
  const clr = $('orderSearchClear');
  if (clr) clr.onclick = () => {
    ordersFilter = { text: '', dateFrom: '', dateTo: '', exact: false, rarities: new Set(), mech: false, titles: new Set() };
    if (txt) txt.value = '';
    if (df) df.value = '';
    if (dt) dt.value = '';
    if (ex) ex.checked = false;
    renderOrders();
  };
}

// 持有卡片搜索框事件绑定（仅初始化一次）
function initInventorySearch() {
  const txt = $('inventorySearchText');
  if (txt) txt.addEventListener('input', (e) => { inventoryFilter.text = e.target.value; renderInventory(); });
  const ex = $('inventoryExact');
  if (ex) ex.addEventListener('change', (e) => { inventoryFilter.exact = e.target.checked; renderInventory(); });
  const clr = $('inventorySearchClear');
  if (clr) clr.onclick = () => {
    inventoryFilter = { text: '', rarities: new Set(), mech: false, exact: false, titles: new Set(), source: new Set(), lock: false, showLocked: false };
    if (txt) txt.value = '';
    if (ex) ex.checked = false;
    renderInventory(); // buildInventoryChips 依新 inventoryFilter 重建 chips 选中态，无需手动清 on
  };
}

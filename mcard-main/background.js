/*
 * background.js — MV3 service worker（手动工具后台：采集 + 交易直连）
 *
 * 架构：手动触发（dashboard 刷新 / 购买 / 卖出 / 各 view 加载）+ mtFetch 直连 api.m-team.cc + 串行采集 + 流式落盘。
 * 自动购买 / 定时监控 / 消息推送已迁至独立 Docker 服务（docker 分支 server/），扩展不再承担。
 *
 * 单轮生命周期（均手动触发）：
 *   triggerRefreshRound('manual' | 'buy') → startRound(st, 'refresh', ...)
 *     → 按 rarities（shuffle 顺序）循环 fetchMarketList(rarity) → applyMarketRarity 入库
 *     → 每轮顺带 fetchProfile（刷新魔力值）
 *     → onRoundDone：写 stats；若购买排队了刷新则续一轮
 *   兜底：mtFetch 401 → 抛 API_KEY_INVALID，由调用方 / dashboard 处理。
 *
 * 状态全部存 chrome.storage.local，不依赖 SW 内存（SW 会休眠）。
 */

importScripts('shared.js', 'locales/zh.js', 'locales/en.js', 'dropStats.js', 'marketStats.js'); // 跨脚本共享常量与纯函数 + i18n 字典 + 掉落统计纯逻辑 + 市场统计纯逻辑

// ============ i18n 语言同步（config.lang → setI18nLang） ============
// SW 无 localStorage；语言偏好由 dashboard 写入 config.lang，这里读取并跟随。
chrome.storage.local.get('config', function (res) {
  setI18nLang((res && res.config && res.config.lang) || detectLang());
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.config && changes.config.newValue) {
    setI18nLang(changes.config.newValue.lang || getI18nLang());
  }
});

const HISTORY_LIMIT = 50;        // design.md 功能6：保存最近 50 条
// RARITIES / isMechCard / parseMtTime / buildDetailUrl / computeUsable
// 均来自 shared.js（见文件顶部 importScripts）。机制卡分桶说明见 applyMarketRarity。

const DEFAULT_STATE = {
  config: {
    rarities: RARITIES,
    listPageSize: 10,        // 市场列表每页条数（手动刷新用；默认 10）
    maxPriceByRarity: { UR: 0, SSR: 0, SR: 0, R: 0, N: 0 }, // 各稀有度最高 lowestAsk，0 = 不限
    mechTypes: [],          // 勾选的机制卡子类型(type)，默认全关
    maxPriceByMech: { mana_voucher: 0, single_free: 0, vip_7d: 0 }, // 各机制卡子类型阈值，0 = 不限
    presets: [],            // 保存的阈值方案 [{ name, rarities, values, mechTypes, mechValues }]
    viewMode: 'price',      // 卡片显示模式：'group'(按分类) | 'price'(按价格升序，默认)
    searchTags: [],         // 市场 view 定向搜索 keyword 列表；非空时市场 view 走 /market/search 而非 buckets 刷新
    budget: { total: 0, spent: 0 }, // 预算魔力池：total=总额(0=未启用)，spent=已花费（手动购买的预算上限）
    lang: null,                      // UI 语言偏好：'zh' | 'en' | null（首次探测；dashboard 手动切换后双写）
  },
  isRoundRunning: false,
  buckets: {},              // { UR: { lastReqId, items, time, count }, ... }
  mechBucket: { lastReqId: 0, items: [], time: null, count: 0 }, // 机制卡独立桶（3 张固定，来自 market 页机制卡分类）
  history: [],             // 最近 N 条采集事件
  stats: {
    total: 0, misses: 0,
    lastRoundTime: null, lastError: null,
  },
  round: null,             // { rarities, startedAt, done, reason, currentRarity }
  profile: null,           // 个人资料 { username, id, createdDate, role, bonus, uploaded, downloaded, shareRate, time }
  buyHistory: [],          // 交易记录缓存 [{id, side, filmId, filmName, poster, rarity, provenance, title, price, buyerId, sellerId, tradedAt, localTime}]，按 id 去重、新的在前、不裁；来源 myTrades
  ordersAll: [],           // 全部挂单记录累积(按记录id去重，status变化时更新) [{id,cardId,side,filmId,filmName,poster,rarity,provenance,title,price,qty,status,createdDate,lastModifiedDate}]；存活=open/成交=filled/取消=cancelled；来源 myorders，增量合并
  ordersTotal: 0,          // myorders 返回的 data.total（历史总挂单数，网站全量；个人场景=ordersAll.length）
  dropStats: {                          // 卡片掉落概率统计（tab msg/search 全量 + feed 近期增量）
    since: DROP_SINCE_DEFAULT,          // 起点时间，写死 2026-07-01（不暴露配置入口）
    lastMsgDate: '',                    // 已采数据最新 createdDate（增量游标，tab/feed 共用）
    messages: [],                       // msg/search 全量消息表 [{ msgId, createdDate, receiver, title, context }]，不裁剪
    feedCards: [],                      // feed 近期增量卡片 [{ cardId, createdDate, rarity, title }]（msg 之后）
    lastFeedAt: 0,                      // 上次数据获取时刻 ms（feed 或 tab；gate：超 7 天 → tab 全量）
    summary: null,                      // 聚合缓存（computeDropSummary 结果，merge 时整体重算）
  },
  bonus: null,                          // 用户 Bonus 明细（来源 profile/detail 页 /api/tracker/mybonus）：{ lastFetchDate, finalBs, raw }
  cardLogs: [],                         // 魔力符券开卡记录（来源 /api/credit/logs type=CARD_MECHANISM）：[{id,createdDate,bonus,paid}]，按 id 去重、降序
  cardLogSummary: null,                 // cardLogs 聚合（computeCardLogSummary 结果，merge/启动时重算）
  cancelFailedOrders: [],               // cancel 撤单 3 次重试全失败的残留挂单记录（v0.2.5，为未来查看页预留）：[{orderId,filmId,rarity,provenance,price,url,ts}]
};

// ============ 存储 helpers ============
const getAll = () => chrome.storage.local.get(null);
const set = (obj) => chrome.storage.local.set(obj);

// SW 启动：dropStats.summary 用最新 computeDropSummary 重算（dropStats.js 改动后自动生效，无需重采）
getAll().then((st) => {
  const patch = {};
  const ds = st.dropStats;
  if (ds && Array.isArray(ds.messages) && ds.messages.length && ds.since) {
    const fresh = computeDropSummary(ds.messages, ds.feedCards, ds.since, _todayStr());
    if (JSON.stringify(ds.summary) !== JSON.stringify(fresh)) { ds.summary = fresh; patch.dropStats = ds; console.log('[MTEAM] drop summary recomputed on startup'); }
  }
  if (Array.isArray(st.cardLogs) && st.cardLogs.length) {
    const freshCl = computeCardLogSummary(st.cardLogs);
    if (JSON.stringify(st.cardLogSummary) !== JSON.stringify(freshCl)) { patch.cardLogSummary = freshCl; console.log('[MTEAM] cardLog summary recomputed on startup'); }
  }
  if (Object.keys(patch).length) set(patch);
}).catch(() => {});

// 纯对象判定（排除数组/null/原始值），供 deepMerge 判定哪些键需递归合并
function isPlainObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
// 深合并：嵌套普通对象递归合并；数组与原始值直接覆盖。
// 让 dashboard 可直接 send 嵌套 patch（如 {budget:{spent:100}}）而不丢同对象其他字段。
function deepMerge(target, src) {
  if (!isPlainObj(target) || !isPlainObj(src)) return src;
  const out = Object.assign({}, target);
  for (const k of Object.keys(src)) {
    out[k] = (isPlainObj(target[k]) && isPlainObj(src[k])) ? deepMerge(target[k], src[k]) : src[k];
  }
  return out;
}

async function ensureDefaults() {
  const all = await getAll();
  const patch = {};
  for (const k of Object.keys(DEFAULT_STATE)) {
    if (all[k] === undefined) patch[k] = DEFAULT_STATE[k];
  }
  // config 合并默认字段（兼容老版本：补 mechTypes / maxPriceByMech 等新增字段）
  const cfg = Object.assign({}, DEFAULT_STATE.config, all.config || {});
  if (!Array.isArray(cfg.rarities) || !cfg.rarities.length) cfg.rarities = DEFAULT_STATE.config.rarities;
  if (!Array.isArray(cfg.mechTypes)) cfg.mechTypes = [];
  if (!cfg.maxPriceByMech) cfg.maxPriceByMech = Object.assign({}, DEFAULT_STATE.config.maxPriceByMech);
  if (!cfg.budget || typeof cfg.budget !== 'object') cfg.budget = { total: 0, spent: 0 };
  patch.config = cfg;
  if (Object.keys(patch).length) await set(patch);
}

// ============ 生命周期 ============
chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  const st0 = await getAll();
  if (st0.isRoundRunning) await set({ isRoundRunning: false, round: null });  // reload 清残留采集态（SW 采集时被杀会残留 true）
  console.log('[MTEAM] installed, defaults set');
  await updateAction();
});

// 点击扩展图标 → 在新 tab 打开 dashboard
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  const st = await getAll();
  if (st.isRoundRunning) await set({ isRoundRunning: false, round: null });  // 重启清残留采集态
  await updateAction();
});

// Fisher–Yates 洗牌
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// 市场列表直连：普通稀有度按 rarity 过滤（pageSize 由调用方传，默认 10）；机制卡用 provenance:'mech'（pageSize=100 拿全）。
async function fetchMarketList(rarity, pageSize) {
  const body = rarity === 'MECH'
    ? { pageNumber: 1, pageSize: 100, provenance: 'mech' }
    : { pageNumber: 1, pageSize: pageSize || 10, rarity };
  return mtFetch('/api/pt-card/market/list', body);
}

// 单个 rarity 入库（mech 机制卡走 mechBucket）。提取自原 onMarketData，去掉 reqId 防过期。
async function applyMarketRarity(rarity, items, time) {
  const allItems = items || [];
  const st = await getAll();
  if (rarity === 'MECH') {
    const mechBucket = { items: allItems.map(slim), time, count: allItems.length };
    const history = [{ time, rarity: 'MECH', count: allItems.length }]
      .concat(st.history || []).slice(0, HISTORY_LIMIT);
    await set({ mechBucket, history });
    return;
  }
  const buckets = Object.assign({}, st.buckets || {});
  buckets[rarity] = { items: allItems.map(slim), time, count: allItems.length };
  const history = [{ time, rarity, count: allItems.length }]
    .concat(st.history || []).slice(0, HISTORY_LIMIT);
  await set({ buckets, history });
}

// 人类化随机延时（防风控），替代原 content 的 STEP_DELAY。
function randSleep(min, max) {
  const ms = Math.round(min + Math.random() * (max - min));
  return new Promise((r) => setTimeout(r, ms));
}

async function startRound(st, reason, onlyRarities, pageSize) {
  reason = reason || 'refresh'; // 所有调用点均传 'refresh'（手动 / 购买触发的刷新轮）；pageSize 由调用方传入
  const cfg = st.config || DEFAULT_STATE.config;
  let rarities;
  if (onlyRarities && onlyRarities.length) {
    // 仅采集指定分类（购买后只刷新那一个分类）
    rarities = shuffle(onlyRarities.slice());
  } else {
    // 采集范围 = 监控勾选（前端展示也只看 config.rarities）
    const monRarities = (cfg.rarities && cfg.rarities.length) ? cfg.rarities.slice() : RARITIES.slice();
    const list = monRarities;
    // 机制卡：勾选子类型即采集（list 接口按 rarity 过滤，MECH 走 mechBucket）
    if ((cfg.mechTypes || []).length) list.push('MECH');
    rarities = shuffle(list); // 每轮随机顺序，避免固定采集节奏
  }

  await set({ isRoundRunning: true });
  updateAction();
  const round = { rarities, startedAt: Date.now(), done: false, reason };
  await set({ round });
  console.log('[MTEAM] start round', rarities.join(','));

  let hits = 0, misses = 0, authFailed = false;
  for (const rarity of rarities) {
    await set({ round: Object.assign({}, round, { currentRarity: rarity }) });
    try {
      const resp = await fetchMarketList(rarity, pageSize);
      if (resp && resp.code === '0' && resp.data && Array.isArray(resp.data.data)) {
        await applyMarketRarity(rarity, resp.data.data, Date.now());
        hits++;
        console.log('[MTEAM] market data received', rarity, resp.data.data.length);
      } else {
        misses++;
        console.warn('[MTEAM] market empty/invalid', rarity);
      }
    } catch (e) {
      misses++;
      console.warn('[MTEAM] market fetch failed', rarity, e);
      if (e && e.message === 'API_KEY_INVALID') { authFailed = true; break; }  // 令牌失效，终止本轮
    }
    await randSleep(400, 900);  // 人类化节奏
  }

  // 每轮顺带刷新 profile + bonus（魔力值/明细）；令牌失效时跳过（mtFetch 已抛 API_KEY_INVALID）
  if (!authFailed) {
    try { await fetchProfile(); } catch (e) { console.warn('[MTEAM] profile fetch failed', e); }
    try { await fetchMyBonus(); } catch (e) { console.warn('[MTEAM] bonus fetch failed', e); }
  }

  await onRoundDone({ hits, misses, authFailed }, null);
}

// manual 市场刷新冷却：防快速切视图/反复点返回市场触发密集采集（风控）。与 MYORDERS_FETCH_COOLDOWN
// 同模式——SW 内存时间戳，被杀重置无害；仅节流 manual 全集刷新，不影响购买后的 onlyRarities 刷新。
const MARKET_REFRESH_COOLDOWN = 8 * 1000;
let lastMarketRefreshAt = 0;

// 购买等动作成功后立即刷新一次市场数据（不受监控开关影响）。
// 若恰好有轮在跑，排队（refreshRequested），由 onRoundDone 在该轮结束后立即续一轮，
// 避免"买完正好撞上正在采集→刷新被吞掉"。
async function triggerRefreshRound(source, onlyRarities) {
  source = source || 'manual';
  // manual 刷新节流：8s 内的重复 REFRESH_NOW（快速切视图/反复返回市场）直接跳过，避免密集采集触发风控
  if (source === 'manual' && Date.now() - lastMarketRefreshAt < MARKET_REFRESH_COOLDOWN) {
    console.log('[MTEAM] refresh throttled (manual cooldown)');
    return { ok: true, throttled: true };
  }
  const st = await getAll();
  if (source === 'manual') lastMarketRefreshAt = Date.now();  // 通过冷却即记录（含排队），防冷却期内反复触发
  const ps = (st.config && st.config.listPageSize) || 10;  // 手动市场刷新用配置 pageSize（默认 10）
  if (st.isRoundRunning) {
    await set({ refreshRequested: true });
    console.log('[MTEAM] refresh requested (' + source + '), will run after current round');
    return { ok: true, queued: true };
  }
  console.log('[MTEAM] refresh triggered (' + source + ')', onlyRarities ? onlyRarities.join(',') : 'all');
  await startRound(st, 'refresh', onlyRarities, ps);
  return { ok: true, queued: false };
}

// ============ 消息总线 ============
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) return;
      const tabId = sender.tab && sender.tab.id;

      switch (msg.type) {
        case 'GET_STATE':     ensureCardLogs(); return sendResponse(await buildPopupState());
        case 'REFRESH_ALL':   return sendResponse(await refreshAll());
        case 'SAVE_API_KEY':  return sendResponse(await saveApiKey(msg.key, msg.webBase));
        case 'REFRESH_NOW':   return sendResponse(await triggerRefreshRound('manual'));
        case 'SET_CONFIG':    return sendResponse(await setConfig(msg.config));
        case 'SET_WEB_BASE': {
          const { config } = await chrome.storage.local.get('config');
          await chrome.storage.local.set({ config: Object.assign({}, config || {}, { webBase: msg.webBase }) });
          return sendResponse({ ok: true });
        }
        case 'CLEAR_DATA':    return sendResponse(await clearData());
        case 'GET_ORDERBOOK': return sendResponse(await queryOrderbook(msg.filmId, msg.provenance, msg.rarity));
        case 'BUY_CARD':      return sendResponse(await buyCard(msg));
        case 'SELL_CARD':     return sendResponse(await sellCard(msg));
        case 'CANCEL_ORDER':  return sendResponse(await cancelOrder(msg));
        case 'LOAD_TRADES':   return sendResponse(await ensureMyTrades(true));
        case 'LOAD_ORDERS':   return sendResponse(await ensureMyOrders(true));
        case 'LOAD_INVENTORY':  return sendResponse(await ensureInventoryData(true));
        case 'LOAD_DROP_STATS': return sendResponse(await ensureDropStats());
        case 'LOAD_MARKET_DATA': return sendResponse(await ensureMarketData(true));
        case 'DROP_FIRST':    return sendResponse(await onDropFirst());
        case 'DROP_DONE':     await onDropDone(msg, sender); return sendResponse({ ok: true });
        case 'SEARCH_MARKET': return sendResponse(await searchMarket(msg.tags, msg.pageSize));
      }
    } catch (e) {
      console.error('[MTEAM] msg handler error', e);
      try { sendResponse({ ok: false, error: String(e) }); } catch (e2) {}
    }
  })();
  return true; // 异步响应
});

// 个人资料数据到达 → 提取所需字段存储
async function onProfileData(resp) {
  if (!resp || resp.code !== '0' || !resp.data) return;
  const d = resp.data;
  const mc = d.memberCount || {};
  const profile = {
    username: d.username || '',
    id: d.id || '',
    avatarUrl: d.avatarUrl || d.avatar || '',  // 头像（API 字段名兜底）
    createdDate: d.createdDate || '',
    role: d.role || '',
    bonus: mc.bonus || '0',
    uploaded: mc.uploaded || '0',
    downloaded: mc.downloaded || '0',
    shareRate: mc.shareRate || '0',
    time: Date.now(),
  };
  await set({ profile });
  console.log('[MTEAM] profile updated', profile.username, 'bonus', profile.bonus);
}

// ---- 一轮完成：统计 + 自适应（直连后无 tab 可关；由 startRound 直接调用）----
async function onRoundDone(msg, sender) {
  const st = await getAll();
  if (!st.round || st.round.done) return;

  // startRound 直接调用时传 {hits, misses, authFailed}（hits/misses 为数字计数）
  const authFailed = !!(msg && msg.authFailed);
  const hits = Number(msg.hits) || 0;
  const misses = Number(msg.misses) || 0;
  console.log('[MTEAM] round done', 'hits', hits, 'misses', misses, 'authFailed', authFailed);

  const stats = Object.assign({}, st.stats, {
    total: (st.stats.total || 0) + 1,
    misses: (st.stats.misses || 0) + misses,
    lastRoundTime: Date.now(),
    lastError: authFailed ? 'api_key_invalid' : (misses > 0 ? 'partial_miss' : null),
  });
  await set({
    isRoundRunning: false,
    round: null,
    stats,
  });
  updateAction(); // 采集结束即时刷新图标（从雷达切回 logo）

  // 令牌失效：不续轮、不触发后续（mtFetch 已抛 API_KEY_INVALID，由调用方处理）
  if (authFailed) {
    console.warn('[MTEAM] round aborted: API key invalid');
    return;
  }

  // 有排队的刷新请求（购买时撞上正在跑的轮）→ 立即续一轮，跳过正常 interval 等待
  const after = await getAll();
  if (after.refreshRequested) {
    await set({ refreshRequested: false });
    console.log('[MTEAM] running requested refresh round');
    await startRound(after, 'refresh', null, (after.config && after.config.listPageSize) || 10);
    return;
  }
}

// 关闭 tab 前置判断：若该窗口只剩这一个 tab，跳过（避免关掉最后一个 tab 导致 Chrome 退出）
async function safeCloseTab(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    if (tabs.length <= 1) {
      // 只剩这一个 tab：先打开 dashboard 再关原 tab，避免关掉最后一个 tab 导致 Chrome 退出
      console.log('[MTEAM] open dashboard before closing last tab', tabId);
      await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      await chrome.tabs.remove(tabId);
      return;
    }
    await chrome.tabs.remove(tabId);
  } catch (e) { /* tab 可能已关 */ }
}
async function setConfig(config) {
  if (!config) return { ok: false };
  const st = await getAll();
  const prev = st.config || {};
  const merged = deepMerge(prev, config);
  const patch = { config: merged };
  await set(patch);
  updateAction();
  return { ok: true };
}

async function clearData() {
  await set({
    buckets: {}, mechBucket: Object.assign({}, DEFAULT_STATE.mechBucket),
    history: [],
    stats: Object.assign({}, DEFAULT_STATE.stats),
    marketHistory: [],
  });
  updateAction();
  return { ok: true };
}

// ============ 一键购买（buy 直连 + cancel 闭环，v0.2.5） ============
// 手动购买：mtFetch buy(限价，price=入库 lowestAsk) → filled 成交 / open 挂单 → cancel 撤挂单。
// 替代了开 detail tab 点按钮的旧链路（detail.js / inject orderbook 端点 / manifest detail 注入已删）。
const CANCEL_RETRY = 3;          // cancel 失败重试次数
const CANCEL_RETRY_DELAY = 300;  // 重试间隔(ms)

// 撤销 buy 自动挂出的买单：重试最多 CANCEL_RETRY 次（静默），全部失败返回 false。
async function cancelBuyOrder(orderId) {
  for (let i = 0; i < CANCEL_RETRY; i++) {
    try {
      const r = await mtFetch('/api/pt-card/market/cancel', { orderId: Number(orderId) });
      if (r && String(r.code) === '0') return true;
    } catch (e) { /* 401(API_KEY_INVALID)/网络错：mtFetch 已处理，继续重试 */ }
    if (i < CANCEL_RETRY - 1) await new Promise((res) => setTimeout(res, CANCEL_RETRY_DELAY));
  }
  return false;
}

// 记录 cancel 撤单失败的残留挂单（为未来「撤单残留查看页」预留）
async function addCancelFailedOrder(rec) {
  if (!rec || rec.orderId == null) return;
  const st = await getAll();
  await set({ cancelFailedOrders: (st.cancelFailedOrders || []).concat([rec]) });
}

// 一键购买：buy 直连(限价，price=入库 lowestAsk) → filled 成交 / open 挂单则 cancel 撤销。结果交 dashboard 展示。
async function buyCard(msg) {
  const variant = msg.variant || {};
  const expectPrice = Number(msg.expectPrice);
  const st = await getAll();
  // 预算兜底：未设/不足则拒绝（防前端绕过与并发连点）
  const u = computeUsable(st);
  if (u.bTotal <= 0) return { ok: false, reason: 'budget_not_set' };
  if (!Number.isFinite(expectPrice) || expectPrice < 0) return { ok: false, reason: 'buy_failed' }; // 无效价格安全门（NaN/负值）；0 放行（支持 0 价挂单）
  if (Number.isFinite(expectPrice) && expectPrice > u.usable) {
    return { ok: false, reason: 'budget_insufficient', usable: u.usable, remaining: u.remaining, bonus: u.bonus };
  }
  // 入库价阈值硬上限（调用方传 maxPrice = 监控阈值）。
  // 不再购前查 orderbook——buy 的限价语义本身是安全门：绝不按高于 price 成交（要么 ≤price 吃单，要么挂单）。
  const maxPrice = Number(msg.maxPrice) || 0;
  if (maxPrice > 0 && Number.isFinite(expectPrice) && expectPrice > maxPrice) {
    return { ok: false, reason: 'over_threshold', expectPrice: expectPrice, limit: maxPrice };
  }

  // buy 直连：price = 入库价（限价 = 最高愿付价）
  let json;
  try {
    json = await mtFetch('/api/pt-card/market/buy', {
      filmId: variant.filmId,
      rarity: variant.rarity,
      provenance: variant.provenance,
      price: expectPrice,
    });
  } catch (e) {
    return { ok: false, reason: 'buy_failed' };  // API_KEY_INVALID / 网络错
  }
  if (!json || String(json.code) !== '0' || !json.data) return { ok: false, reason: 'buy_failed' };

  const data = json.data;
  const detailUrl = buildDetailUrl(variant);

  // 成交：status=filled，data.trade 含完整成交信息（id/price/fee/buyerId/sellerId/tradedAt）
  if (data.status === 'filled' && data.trade) {
    const trade = data.trade;
    // 成交是权威时刻：扣减预算池已花费
    const cur = await getAll();
    const cb = (cur.config && cur.config.budget) || { total: 0, spent: 0 };
    const ct = Number(cb.total) || 0;
    if (ct > 0) {
      const newSpent = (Number(cb.spent) || 0) + (Number(trade.price) || 0);
      await set({ config: Object.assign({}, cur.config, { budget: { total: ct, spent: newSpent } }) });
    }
    // 购买后刷新该卡所属分类（机制卡→MECH，普通→rarity）；批量调用传 skipRefresh 跳过逐张刷新（整批后前端统一刷）
    if (!msg.skipRefresh) {
      const key = isMechCard(variant) ? 'MECH' : (variant.rarity || null);
      triggerRefreshRound('buy', key ? [key] : null).catch((e) => console.warn('[MTEAM] refresh trigger failed', e));
    }
    return { ok: true, confirmed: true, price: trade.price, trade: trade };
  }

  // 未成交：status=open（卖单不在/已提价）→ buy 自动挂了一个买单，必须 cancel 撤掉，否则可能被意外成交
  if (data.status === 'open' && data.orderId != null) {
    const cancelled = await cancelBuyOrder(data.orderId);
    if (!cancelled) {
      // cancel 重试全败：存表留痕（手动购买额外由 dashboard toast 带 url 提示）
      await addCancelFailedOrder({
        orderId: Number(data.orderId), filmId: variant.filmId, rarity: variant.rarity,
        provenance: variant.provenance, price: expectPrice, url: detailUrl, ts: Date.now(),
      });
    }
    return { ok: false, confirmed: false, reason: 'unfilled', cancelFailed: !cancelled, url: detailUrl };
  }

  return { ok: false, reason: 'buy_failed' };  // 其它异常 status
}

// 卖出挂单：mtFetch sell（netPrice=净卖价/卖家到手；API 自动加 5% 税，挂单价=netPrice×1.05）。
// 普通卡传 cardId，机制卡传 mechanismCardId（互斥，值都取调用方传的 cardId）。
async function sellCard(msg) {
  const netPrice = Number(msg.netPrice);
  if (!Number.isFinite(netPrice) || netPrice <= 0) return { ok: false, reason: 'sell_failed' };
  const body = { netPrice: netPrice };
  if (msg.isMech) body.mechanismCardId = Number(msg.cardId);
  else body.cardId = Number(msg.cardId);
  let json;
  try {
    json = await mtFetch('/api/pt-card/market/sell', body);
  } catch (e) {
    return { ok: false, reason: 'sell_failed' };  // API_KEY_INVALID / 网络错
  }
  if (!json || String(json.code) !== '0' || !json.data) return { ok: false, reason: 'sell_failed' };
  // 成功：刷新持有（卡已挂卖单）+ 当前挂单（新挂单）。批量模式（msg.skipRefresh）跳过逐张刷新，由 dashboard 整批后统一刷一次
  if (!msg.skipRefresh) {
    await Promise.all([
      ensureInventoryData(true).catch((e) => console.warn('[MTEAM] inventory refresh after sell failed', e)),
      ensureMyOrders(true).catch((e) => console.warn('[MTEAM] orders refresh after sell failed', e)),
    ]);
  }
  return { ok: true };
}

// 取消挂单：mtFetch cancel（body {orderId} 数字，成功 code:'0' data:null）。
// 用于「当前挂单」的取消 / 改价（改价 = cancel 后用新价重新 sell）。
async function cancelOrder(msg) {
  const orderId = Number(msg.orderId);
  if (!Number.isFinite(orderId) || orderId <= 0) return { ok: false, reason: 'cancel_failed' };
  let json;
  try {
    json = await mtFetch('/api/pt-card/market/cancel', { orderId });
  } catch (e) {
    return { ok: false, reason: 'cancel_failed' };
  }
  if (!json || String(json.code) !== '0') return { ok: false, reason: 'cancel_failed' };
  // 成功：刷新挂单（取消的消失）+ 持有（卡回到持有）。批量模式（msg.skipRefresh）跳过逐张刷新，由 dashboard 整批后统一刷一次
  if (!msg.skipRefresh) {
    await Promise.all([
      ensureMyOrders(true).catch((e) => console.warn('[MTEAM] orders refresh after cancel failed', e)),
      ensureInventoryData(true).catch((e) => console.warn('[MTEAM] inventory refresh after cancel failed', e)),
    ]);
  }
  return { ok: true };
}

// ============ 交易记录 + 挂单：翻页直连（mytrades 增量衔接 / myorders 每次全量）============
// LOAD_TRADES / LOAD_ORDERS 都走 ensureMyOrdersData。mytrades 翻页衔接（日常 1 页即停，首次翻全建库）；
// myorders 每次翻页拿全（pageSize=200，挂单状态会变需全量刷新）。profile 单次。均走原 merge 函数。
const LIST_MAX_PAGES = 100;

// 通用翻页：逐页请求 + mergeFn 合并，直到停止条件。
//   stopMode 'incremental'：本页 0 新增即停（与本地衔接，适合历史增量，日常 1 页）；
//   stopMode 'full'：只看拿全（total/空页），适合每次全量刷新的当前态数据。
// mergeFn(items, total) 返回本页新增数（>0 表示有新数据）。
async function syncList(path, mergeFn, pageSize, stopMode, extraBody) {
  let page = 0, totalAdded = 0;
  while (page < LIST_MAX_PAGES) {
    page++;
    const resp = await mtFetch(path, Object.assign({ pageNumber: page, pageSize: pageSize }, extraBody || {}));
    if (!resp || resp.code !== '0' || !resp.data || !Array.isArray(resp.data.data)) break;
    const items = resp.data.data;
    const total = Number(resp.data.total) || 0;
    const added = await mergeFn(items, total) || 0;
    totalAdded += added;
    if (!items.length) break;                              // 空页 = 拿全
    if (stopMode === 'incremental' && !added) break;       // 衔接：本页全已在本地
    if (total && page * pageSize >= total) break;          // 按 total 拿全
  }
  return { pages: page, added: totalAdded };
}

async function fetchProfile() {
  const resp = await mtFetch('/api/member/profile', {});
  await onProfileData(resp);
}

let _myOrdersPromise = null;
const MYORDERS_FETCH_COOLDOWN = 8000;
let lastMyOrdersFetchAt = 0;

// mytrades 翻页衔接（日常 1 页增量，首次 pageSize=200 翻全建库）+ profile。
let _myTradesPromise = null;
let lastMyTradesFetchAt = 0;
async function ensureMyTrades(force) {
  if (_myTradesPromise) return _myTradesPromise;
  if (!force && Date.now() - lastMyTradesFetchAt < MYORDERS_FETCH_COOLDOWN) return { ok: true, skipped: true };
  lastMyTradesFetchAt = Date.now();
  _myTradesPromise = (async () => {
    const out = { ok: true };
    try {
      const st = await getAll();
      const ps = (st.buyHistory && st.buyHistory.length) ? 20 : 200;
      const r = await syncList('/api/pt-card/market/myTrades', mergeTrades, ps, 'incremental');
      out.tradesAdded = r.added;
      console.log('[MTEAM] myTrades synced', r);
      try { await fetchProfile(); } catch (e) { console.warn('[MTEAM] profile fetch failed', e); }
    } catch (e) { console.warn('[MTEAM] myTrades fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
    finally { _myTradesPromise = null; }
    return out;
  })();
  return _myTradesPromise;
}

// myorders 每次翻页拿全（pageSize=200）+ profile。
async function ensureMyOrders(force) {
  if (_myOrdersPromise) return _myOrdersPromise;
  if (!force && Date.now() - lastMyOrdersFetchAt < MYORDERS_FETCH_COOLDOWN) return { ok: true, skipped: true };
  lastMyOrdersFetchAt = Date.now();
  _myOrdersPromise = (async () => {
    const out = { ok: true };
    try {
      const r = await syncList('/api/pt-card/market/myorders',
        (items, total) => mergeOrders(items, total).then((rr) => rr.added), 200, 'full');
      console.log('[MTEAM] orders synced', r);
      try { await fetchProfile(); } catch (e) { console.warn('[MTEAM] profile fetch failed', e); }
    } catch (e) { console.warn('[MTEAM] orders fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
    finally { _myOrdersPromise = null; }
    return out;
  })();
  return _myOrdersPromise;
}

// ============ 市场成交历史：tradeHistory 直连翻页（首次全量 200 / 增量 50）============
let _marketDataPromise = null;
let lastMarketDataFetchAt = 0;
const MARKETDATA_FETCH_COOLDOWN = 8000;

// 按 id 去重合并进 marketHistory（保留分析所需全字段）；按 tradedAt 降序。返回本页新增数。
async function mergeMarketHistory(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const st = await getAll();
  const exist = Array.isArray(st.marketHistory) ? st.marketHistory.slice() : [];
  const existIds = {};
  for (let i = 0; i < exist.length; i++) existIds[String(exist[i].id)] = 1;
  let added = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.id == null) continue;
    const id = String(it.id);
    if (existIds[id]) continue;
    exist.push({
      id: id,
      buyerId: it.buyerId != null ? String(it.buyerId) : '',
      sellerId: it.sellerId != null ? String(it.sellerId) : '',
      filmId: it.filmId || '',
      filmName: it.filmName || '',
      rarity: it.rarity || '',
      provenance: it.provenance || '',
      title: it.title || '',
      price: it.price != null ? String(it.price) : '',
      fee: it.fee != null ? String(it.fee) : '',
      cardId: it.cardId != null ? String(it.cardId) : '',
      buyOrderId: (it.buyOrderId === null || it.buyOrderId === undefined) ? null : String(it.buyOrderId),
      sellOrderId: (it.sellOrderId === null || it.sellOrderId === undefined) ? null : String(it.sellOrderId),
      tradedAt: it.tradedAt || '',
      poster: it.poster || '',
      year: it.year || '',
    });
    existIds[id] = 1;
    added++;
  }
  if (!added) return 0;
  exist.sort(function (a, b) { return (parseMtTime(b.tradedAt) || 0) - (parseMtTime(a.tradedAt) || 0); });
  await set({ marketHistory: exist });
  return added;
}

// 首次（marketHistory 空）→ pageSize=200 翻页至 total；之后 → pageSize=50 增量（日常 1 页）。
async function ensureMarketData(force) {
  if (_marketDataPromise) return _marketDataPromise;
  if (!force && Date.now() - lastMarketDataFetchAt < MARKETDATA_FETCH_COOLDOWN) return { ok: true, skipped: true };
  lastMarketDataFetchAt = Date.now();
  _marketDataPromise = (async () => {
    const out = { ok: true };
    try {
      const st = await getAll();
      let has = Array.isArray(st.marketHistory) && st.marketHistory.length;
      // v0.3.2 迁移：旧数据缺 buyOrderId/sellOrderId（方向判定字段）→ 清空触发全量重采
      if (has && st.marketHistory.some(function (r) { return !('buyOrderId' in r); })) {
        await set({ marketHistory: [] });
        has = false;
      }
      const ps = has ? 50 : 200;
      const r = await syncList('/api/pt-card/market/tradeHistory', mergeMarketHistory, ps, 'incremental');
      out.added = r.added;
      console.log('[MTEAM] marketHistory synced', r);
    } catch (e) { console.warn('[MTEAM] marketHistory fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
    finally { _marketDataPromise = null; }
    return out;
  })();
  return _marketDataPromise;
}

// ============ 魔力符券使用记录：credit/logs 直连翻页（增量合并）============
let _cardLogsPromise = null;
const CARDLOG_FETCH_COOLDOWN = 30000;
let lastCardLogFetchAt = 0;

// 魔力符券开卡记录（/api/credit/logs type=CARD_MECHANISM）。GET_STATE 自动触发 + 30s 冷却；需 profile.id 作 uid。
async function ensureCardLogs(force) {
  if (_cardLogsPromise) return _cardLogsPromise;
  if (!force && Date.now() - lastCardLogFetchAt < CARDLOG_FETCH_COOLDOWN) return { ok: true, skipped: true };
  const st0 = await getAll();
  if (!(st0.profile && st0.profile.id != null)) return { ok: false, reason: 'no_profile' };  // 需 uid
  lastCardLogFetchAt = Date.now();
  _cardLogsPromise = (async () => {
    const out = { ok: true };
    try {
      const uid = String(st0.profile.id);
      const r = await syncList('/api/credit/logs', mergeCardLogs, 100, 'incremental', { type: 'CARD_MECHANISM', uid: uid });
      out.cardLogsAdded = r.added;
      console.log('[MTEAM] cardLogs synced', r);
    } catch (e) { console.warn('[MTEAM] cardLogs fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
    finally { _cardLogsPromise = null; }
    return out;
  })();
  return _cardLogsPromise;
}

// 按 id 增量合并进 cardLogs；存 createdDate/bonus/paid，按 createdDate 降序
async function mergeCardLogs(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const st = await getAll();
  const exist = (st.cardLogs || []).slice();
  const existIds = new Set(exist.map((c) => String(c.id)));
  let added = 0;
  for (const it of items) {
    if (it.id == null || existIds.has(String(it.id))) continue;
    exist.push({
      id: String(it.id),
      createdDate: it.createdDate || '',
      lastModifiedDate: it.lastModifiedDate || '',
      bonus: it.bonus != null ? String(it.bonus) : '',
      paid: !!it.paid,
    });
    existIds.add(String(it.id));
    added++;
  }
  if (!added) return 0;
  exist.sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));
  await set({ cardLogs: exist, cardLogSummary: computeCardLogSummary(exist) });
  return added;
}

// 首次（保存 token 后）/ 手动全量刷新：各 ensure 跑一次（各走自己的 gate/冷却/翻页；首次冷却未触发会全跑）。
async function refreshAll() {
  try {
    const st = await getAll();
    await Promise.all([ensureMyTrades(), ensureMyOrders(), ensureInventoryData()]);
    await ensureDropStats();
    await ensureMarketData();
    try { await fetchMyBonus(); } catch (e) { console.warn('[MTEAM] bonus fetch failed', e); }
    await startRound(st, 'refresh', null, (st.config && st.config.listPageSize) || 10);   // 首次也采集一轮市场卡片
  } catch (e) { console.warn('[MTEAM] refreshAll error', e); }
  return { ok: true };
}

// 按 id 增量合并进 buyHistory；side 由 sellerId/buyerId == 我的 id 判定；按 tradedAt 降序
async function mergeTrades(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const st = await getAll();
  const myId = (st.profile && st.profile.id != null) ? String(st.profile.id) : null;
  const exist = (st.buyHistory || []).slice();
  const existIds = new Set(exist.map((t) => String(t.id)));
  let added = 0;
  for (const it of items) {
    if (it.id == null || existIds.has(String(it.id))) continue;
    const side = (myId != null && String(it.sellerId) === myId) ? 'sell' : 'buy';
    exist.push({
      id: String(it.id),
      side,
      filmId: it.filmId || '',
      filmName: it.filmName || '',
      poster: it.poster || '',
      rarity: it.rarity || '',
      provenance: it.provenance || '',
      title: it.title || '',
      price: it.price != null ? String(it.price) : '',
      buyerId: it.buyerId != null ? String(it.buyerId) : '',
      sellerId: it.sellerId != null ? String(it.sellerId) : '',
      tradedAt: it.tradedAt || '',
      localTime: Date.now(),
    });
    existIds.add(String(it.id));
    added++;
  }
  if (!added) return 0;
  exist.sort((a, b) => (parseMtTime(b.tradedAt) || 0) - (parseMtTime(a.tradedAt) || 0));
  await set({ buyHistory: exist });
  return added;
}

// ============ 挂单记录：增量合并进 ordersAll（按记录id去重，status变化更新）============

// 增量合并挂单记录进 ordersAll：按记录 id 去重；新 id 追加，已有 id 更新可变字段(status/price/lastModifiedDate)。
// cardId 是卡片身份(同 cardId 多条记录 = 该卡挂单轨迹)，记录 id 是单次挂单号。
async function mergeOrders(items, total) {
  const st = await getAll();
  const exist = new Map((st.ordersAll || []).map((o) => [String(o.id), o]));
  if (!Array.isArray(items) || !items.length) return { added: 0, updated: 0, total: exist.size };
  let added = 0, updated = 0;
  for (const it of items) {
    if (!it || it.id == null) continue;
    const id = String(it.id);
    const norm = {
      id: id, cardId: String(it.cardId || ''), side: it.side || 'sell',
      filmId: it.filmId || '', filmName: it.filmName || '', poster: it.poster || '',
      rarity: it.rarity || '', provenance: it.provenance || '', title: it.title || '',
      price: it.price != null ? String(it.price) : '', qty: it.qty != null ? String(it.qty) : '1',
      status: it.status || 'open',
      createdDate: it.createdDate || '', lastModifiedDate: it.lastModifiedDate || '',
    };
    const cur = exist.get(id);
    if (!cur) { exist.set(id, norm); added++; }
    else if (cur.status !== norm.status || cur.price !== norm.price || cur.lastModifiedDate !== norm.lastModifiedDate) {
      exist.set(id, Object.assign({}, cur, { status: norm.status, price: norm.price, lastModifiedDate: norm.lastModifiedDate }));
      updated++;
    }
  }
  if (!added && !updated) return { added: 0, updated: 0, total: exist.size };
  await set({ ordersAll: Array.from(exist.values()), ordersTotal: total || exist.size });
  return { added, updated, total: exist.size };
}

// inventory 直连：POST /api/pt-card/inventory，pageSize=200 一次拿全部持有（全量覆盖）。
let _inventoryPromise = null;
const INVENTORY_FETCH_COOLDOWN = 30000;
let lastInventoryFetchAt = 0;

async function ensureInventoryData(force) {
  if (_inventoryPromise) return _inventoryPromise;
  if (!force && Date.now() - lastInventoryFetchAt < INVENTORY_FETCH_COOLDOWN) return { ok: true, skipped: true };
  lastInventoryFetchAt = Date.now();
  _inventoryPromise = (async () => {
    const out = { ok: true };
    try {
      const resp = await mtFetch('/api/pt-card/inventory', { pageNumber: 1, pageSize: 200 });
      if (resp && resp.code === '0' && resp.data && Array.isArray(resp.data.data)) {
        const items = resp.data.data.map(normalizeInventory).filter(Boolean);
        // 机制卡持有（mechanism/list，独立接口；失败不影响普通卡）
        let mechItems = [];
        try {
          const mechResp = await fetchMechanismList();
          if (mechResp && mechResp.code === '0' && Array.isArray(mechResp.data)) {
            mechItems = mechResp.data.map(normalizeMechanism).filter(Boolean);
          }
        } catch (e) { console.warn('[MTEAM] mechanism fetch failed', e); }
        await set({ inventory: items, mechInventory: mechItems, inventoryTotal: Number(resp.data.total) || items.length, inventoryFetchedAt: Date.now() });
        out.count = items.length + mechItems.length;
        console.log('[MTEAM] inventory loaded', items.length, '+ mech', mechItems.length);
      } else {
        console.warn('[MTEAM] inventory fetch failed or empty');
        out.ok = false; out.reason = 'fetch_failed';
      }
    } catch (e) {
      console.warn('[MTEAM] inventory fetch failed', e);
      out.ok = false; out.reason = String(e && e.message || e);
    } finally {
      _inventoryPromise = null;
    }
    return out;
  })();
  return _inventoryPromise;
}

// 单卡字段映射（全量覆盖写入 inventory 键）
function normalizeInventory(it) {
  if (!it) return null;
  return {
    cardId: String(it.id || ''),
    filmId: it.filmId || '',
    filmName: it.filmName || '',
    year: it.year || '',
    rarity: it.rarity || '',
    title: it.title || '',
    poster: it.poster || '',
    provenance: it.provenance || '',
    serial: it.serial || '',
    tradeLockUntil: it.tradeLockUntil || '',
    torrentId: it.torrentId != null ? String(it.torrentId) : '',
    currentSeeders: it.currentSeeders != null ? String(it.currentSeeders) : '',
    createdDate: it.createdDate || '',
    lastModifiedDate: it.lastModifiedDate || '',
  };
}

// 机制卡持有（mechanism/list，body 空，data 直接数组；usedAt!=null 已使用销毁）
async function fetchMechanismList() {
  return mtFetch('/api/pt-card/mechanism/list', {});
}
function normalizeMechanism(it) {
  if (!it) return null;
  return {
    cardId: String(it.id || ''),
    filmId: 'mech:' + (it.type || ''),
    filmName: it.displayName || '',
    rarity: it.rarity || 'N',
    type: it.type || '',
    serial: it.serial || '',
    tradeLockUntil: it.tradeLockUntil || '',
    provenance: 'mech',
    isMech: true,
    isUsed: !!it.usedAt,            // usedAt 非空 = 已使用销毁
    usedAt: it.usedAt || null,
    createdDate: it.createdDate || '',
    lastModifiedDate: it.lastModifiedDate || '',
  };
}

// ============ 掉落概率统计：混合采集（feed 日常增量 + tab 全量兜底）============
// feed（/pt-card/feed 直连，pageSize=25 最新 25 条）：每次点掉落统计 view 触发，只收 createdDate >
//   lastMsgDate（msg 最新之后），天然不与 messages 重叠。每天最多 3 张，7 天 21 条 < 25，留 4 条冗余。
// tab（msg/search 开 /message/-2 + content 翻页）：首次建库 + 距上次 feed > 7 天的全量兜底（feed 25 条
//   不够覆盖时修正）。tab 翻页拿全 lastMsgDate 之后的（不限于 25），merge 后清空 feedCards 重新累积。
// gate：messages 空 或 now-lastFeedAt > 7天 → tab；否则 feed。两条路径完成后都更新 lastFeedAt（重置 7 天计时）。
const DROP_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let _dropPromise = null;
let _dropResolve = null;   // tab 链路等 DROP_DONE 的握手

function _todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function ensureDropStats() {
  if (_dropPromise) return _dropPromise;
  const st = await getAll();
  const ds = st.dropStats || {};
  const hasData = Array.isArray(ds.messages) && ds.messages.length;
  const lastFeedAt = Number(ds.lastFeedAt) || 0;
  const needFullTab = !hasData || (Date.now() - lastFeedAt > DROP_WEEK_MS);  // 首次 或 feed 超7天 → tab
  _dropPromise = (async () => {
    const out = { ok: true };
    try {
      if (needFullTab) {
        // ===== tab 全量（msg/search 开 /message/-2 + content 翻页拿全 lastMsgDate 之后）=====
        let tab;
        try {
          const { config } = await chrome.storage.local.get('config');
          const webBase = (config && config.webBase) || 'kp.m-team.cc';
          tab = await chrome.tabs.create({ url: webUrl(webBase, '/message/-2') + '?mtm_drop=1', active: false });
          console.log('[MTEAM] msg tab created', tab.id);
        } catch (e) {
          console.warn('[MTEAM] open msg tab failed', e);
          out.ok = false; out.reason = 'open_failed';
          return out;
        }
        const tabId = tab.id;
        await new Promise((res) => {                              // 等 content 的 DROP_DONE
          _dropResolve = res;
          setTimeout(() => { if (_dropResolve === res) { _dropResolve = null; console.warn('[MTEAM] drop fetch timeout'); res(); } }, 90000);
        });
        _dropResolve = null;
        await safeCloseTab(tabId);
        out.tab = true;
      } else {
        // ===== feed 增量（/pt-card/feed 直连，最新 25 条）=====
        const r = await syncList('/api/pt-card/feed', mergeDropFeed, 25, 'incremental');
        out.dropsAdded = r.added;
        console.log('[MTEAM] drop feed synced', r);
      }
      // 无论 tab/feed，更新 lastFeedAt（重置 7 天计时）
      const cur = await getAll();
      await set({ dropStats: Object.assign({}, cur.dropStats || {}, { lastFeedAt: Date.now() }) });
    } catch (e) { console.warn('[MTEAM] drop fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
    finally { _dropPromise = null; }
    return out;
  })();
  return _dropPromise;
}

// content 问停止时间（tab 增量游标 = lastMsgDate；content 翻页拿 lastMsgDate 之后的全部，不限于 feed 25 条）
async function onDropFirst() {
  const st = await getAll();
  const ds = st.dropStats || {};
  return { stopDate: ds.lastMsgDate || ds.since || DROP_SINCE_DEFAULT };
}

// content 翻页完，合并所有页 messages（tab 全量）；tab 后清空 feedCards（msg 已含最新，feed 重新增量）
async function onDropDone(msg, sender) {
  if (msg && Array.isArray(msg.messages)) {
    await mergeDropMessages(msg.messages);
  }
  if (_dropResolve) { const r = _dropResolve; _dropResolve = null; r(); }   // 唤醒 ensureDropStats 关 tab
}

// 过滤「卡片掉落」+ 按 msgId 去重 + merge + 推进 lastMsgDate；tab 全量后清空 feedCards 重新累积
async function mergeDropMessages(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  const st = await getAll();
  const ds = Object.assign({}, st.dropStats || {});
  ds.messages = Array.isArray(ds.messages) ? ds.messages.slice() : [];
  ds.since = ds.since || DROP_SINCE_DEFAULT;
  const existIds = new Set(ds.messages.map((m) => String(m.msgId)));
  const myId = (st.profile && st.profile.id != null) ? String(st.profile.id) : '';
  const cursor = ds.lastMsgDate || '';
  let added = 0, latest = cursor;
  for (const it of items) {
    if (!it || it.id == null) continue;
    const id = String(it.id);
    if (existIds.has(id)) continue;
    const title = it.title || '';
    if (title.indexOf('卡片掉落') === -1) continue;          // 仅「卡片掉落」消息
    const created = it.createdDate || '';
    if (cursor && created && created <= cursor) continue;     // 增量游标：只收更新的
    ds.messages.push({
      msgId: id,
      createdDate: created,
      receiver: myId || (it.receiver != null ? String(it.receiver) : ''),
      title: title,
      context: it.context || '',
    });
    existIds.add(id);
    if (created > latest) latest = created;
    added++;
  }
  if (added) {
    ds.lastMsgDate = latest || ds.lastMsgDate;
    ds.messages.sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));
  }
  ds.feedCards = [];   // tab 全量已含最新，清空 feed 增量（重新累积 msg 之后的新卡）
  ds.summary = computeDropSummary(ds.messages, ds.feedCards, ds.since, _todayStr());
  await set({ dropStats: ds });
  console.log('[MTEAM] drop merged (tab), +' + added + ', total msgs', ds.messages.length);
  return added;
}

// feed 增量：/pt-card/feed 结构化卡片 → feedCards（cardId 去重，游标 createdDate > lastMsgDate 只补 msg 之后）
async function mergeDropFeed(items, total) {
  if (!Array.isArray(items) || !items.length) return 0;
  const st = await getAll();
  const ds = Object.assign({}, st.dropStats || {});
  ds.feedCards = Array.isArray(ds.feedCards) ? ds.feedCards.slice() : [];
  ds.since = ds.since || DROP_SINCE_DEFAULT;
  const existIds = new Set(ds.feedCards.map((c) => String(c.cardId)));
  const cursor = ds.lastMsgDate || '';   // feed 只补 msg 最新之后，不重叠
  let added = 0;
  for (const it of items) {
    if (!it || it.id == null) continue;
    const id = String(it.id);
    if (existIds.has(id)) continue;
    const created = it.createdDate || '';
    if (cursor && created && created <= cursor) continue;     // 只补 msg 之后
    ds.feedCards.push({ cardId: id, createdDate: created, rarity: it.rarity || '', title: it.title || '' });
    existIds.add(id);
    added++;
  }
  if (added) ds.feedCards.sort((a, b) => (b.createdDate || '').localeCompare((a.createdDate || '')));
  ds.summary = computeDropSummary(ds.messages, ds.feedCards, ds.since, _todayStr());
  await set({ dropStats: ds });
  console.log('[MTEAM] drop merged (feed), +' + added + ', total feedCards', ds.feedCards.length);
  return added;
}

// mybonus 直连：POST /api/tracker/mybonus（无需 uid，返回当前令牌对应用户）。
// 与 fetchProfile 同为裸采集——无 daily / 冷却 gate，由调用方按需触发。
async function fetchMyBonus() {
  const resp = await mtFetch('/api/tracker/mybonus', {});
  await onBonusData(resp);
}

async function onBonusData(resp) {
  if (!resp || resp.code !== '0' || !resp.data) return;
  const fp = resp.data.formulaParams || {};
  const finalBs = Number(fp.finalBs) || 0;
  await set({ bonus: {
    lastFetchDate: _todayStr(),
    finalBs: finalBs,
    raw: { bonus: resp.data.bonus || {}, formulaParams: fp },
  } });
  console.log('[MTEAM] bonus saved, finalBs=', finalBs);
}

// ============ M-Team API 直连（x-api-key 鉴权，POC 已验证）============
// api.m-team.cc 支持 x-api-key header，无需页面签名 _sgin。msg/search 被官方隐私
// 拦截仍走 inject；list/profile/mytrades/myorders/inventory/mybonus 逐步迁移到此。
// apiBase 从 config 读（探测存入；默认 api.m-team.cc）；网络 fail 自动回退另一 base。
async function _readApiBase() {
  const { config } = await chrome.storage.local.get('config');
  return (config && config.apiBase) || 'api.m-team.cc';
}
async function _writeApiBase(base) {
  const { config } = await chrome.storage.local.get('config');
  await chrome.storage.local.set({ config: Object.assign({}, config || {}, { apiBase: base }) });
}

// 从 storage 读令牌；未配置抛 NO_API_KEY，由调用方 catch。
async function getApiKey() {
  const { mtApiKey } = await chrome.storage.local.get('mtApiKey');
  if (!mtApiKey) throw new Error('NO_API_KEY');
  return mtApiKey;
}

// 单次 fetch：POST base+path + x-api-key，401 抛 API_KEY_INVALID。
async function _mtFetchOnce(base, path, body) {
  const token = await getApiKey();
  const res = await fetch('https://' + base + path, {
    method: 'POST',
    headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 || String(json.code) === '401') throw new Error('API_KEY_INVALID');
  return json;
}

// 统一 fetch：用 config.apiBase；网络 fail（非 401）回退另一 base 并落盘。
async function mtFetch(path, body) {
  const cur = await _readApiBase();
  try { return await _mtFetchOnce(cur, path, body); }
  catch (e) {
    if (e && e.message === 'API_KEY_INVALID') throw e;   // 令牌错不回退（两站同令牌）
    const other = API_OPTS.find((b) => b !== cur) || 'api.m-team.io';
    const r = await _mtFetchOnce(other, path, body);     // 网络 fail → 试另一个
    await _writeApiBase(other);                           // 通 → 落盘新 apiBase
    return r;
  }
}

// 询价：orderbook 直连，取最高买价（bids[0]，bids 按价格降序）；无买单返回 null
async function queryOrderbook(filmId, provenance, rarity) {
  try {
    const resp = await mtFetch('/api/pt-card/market/orderbook', { filmId: filmId || '', provenance: provenance || '', rarity: rarity || '' });
    const data = (resp && resp.data) || {};
    const asks = Array.isArray(data.asks) ? data.asks : [];
    const bids = Array.isArray(data.bids) ? data.bids : [];
    return { ok: true, ask: asks.length ? (asks[0].price || null) : null, bid: bids.length ? (bids[0].price || null) : null };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

// 顺序探测 API base（.cc 先试，code:'0' 即用不测下一个；不通试 .io）+ 验证令牌。
async function verifyApiKey(key) {
  var netFail = 0;
  for (const base of API_OPTS) {
    try {
      const res = await fetch('https://' + base + '/api/member/profile', {
        method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: '{}',
      });
      const json = await res.json().catch(() => ({}));
      if (String(json.code) === '0') return { ok: true, apiBase: base };
      // 有响应但 code 非 '0' → 令牌无效（两站同令牌，另一站也大概率非 0，但保持完整探测）
    } catch (e) { netFail++; /* 网络 fail，试下一个 base */ }
  }
  // 全部网络 fail → network；至少一个有响应（非 0）→ invalid
  return { ok: false, reason: netFail >= API_OPTS.length ? 'network' : 'invalid' };
}

// 验证（探测 api）+ 存令牌 + apiBase + webBase + 全量刷新。webBase 由调用方传（tokenModal）。
async function saveApiKey(key, webBase) {
  key = (key || '').trim();
  if (!key) return { ok: false, reason: 'empty' };
  const v = await verifyApiKey(key);
  if (!v.ok) return v;
  const { config } = await chrome.storage.local.get('config');
  const newCfg = Object.assign({}, config || {}, { apiBase: v.apiBase });
  if (webBase) newCfg.webBase = webBase;
  await chrome.storage.local.set({ mtApiKey: key, config: newCfg });
  refreshAll().catch((e) => console.warn('[MTEAM] refreshAll after saveApiKey failed', e));
  return { ok: true };
}

// ============ popup 查询的状态快照 ============
async function buildPopupState() {
  // 这里只回原始状态快照（dashboard 据此渲染）
  return getAll();
}

// ============ 扩展图标（雷达，Canvas 程序生成 + 采集时旋转动画） ============
const ICON_SIZE = 48;
let _iconCanvas = null, _iconCtx = null;
function iconCtx() {
  if (!_iconCanvas) {
    _iconCanvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
    _iconCtx = _iconCanvas.getContext('2d');
  }
  return _iconCtx;
}
function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function hexA(hex, a) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
// state: 'collect'(采集,扇形旋转) | 'stop'(停止,灰)；phase=扫描角度(弧度)
function drawRadarIcon(state, phase) {
  const c = iconCtx();
  const s = ICON_SIZE, cx = s / 2, cy = s / 2, R = s / 2 - 3;
  const main = state === 'collect' ? '#f5a623' : '#6f7689';
  const dim = state === 'stop';
  c.clearRect(0, 0, s, s);
  // 圆角深底
  const bg = c.createLinearGradient(0, 0, s, s);
  bg.addColorStop(0, '#171b24'); bg.addColorStop(1, '#0a0c10');
  roundRectPath(c, 2, 2, s - 4, s - 4, 11);
  c.fillStyle = bg; c.fill();
  c.save();
  roundRectPath(c, 2, 2, s - 4, s - 4, 11);
  c.clip();
  // 同心圆 + 十字
  c.lineWidth = 1;
  c.strokeStyle = dim ? 'rgba(130,139,150,0.16)' : hexA(main, 0.22);
  [R, R * 0.66, R * 0.33].forEach((r) => { c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke(); });
  c.beginPath();
  c.moveTo(cx - R, cy); c.lineTo(cx + R, cy);
  c.moveTo(cx, cy - R); c.lineTo(cx, cy + R);
  c.stroke();
  // 扫描扇形（仅采集时）
  if (state === 'collect' && phase != null) {
    c.save();
    c.translate(cx, cy);
    c.rotate(phase);
    const sweep = Math.PI / 2.2, steps = 20;
    for (let i = 0; i < steps; i++) {
      const a0 = -sweep * (i / steps), a1 = -sweep * ((i + 1) / steps);
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, R, a1, a0);
      c.closePath();
      c.fillStyle = hexA(main, 0.42 * (1 - i / steps));
      c.fill();
    }
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(R, 0);
    c.strokeStyle = hexA(main, 0.9); c.lineWidth = 1.4; c.stroke();
    c.restore();
  }
  // 光点（检测目标）
  const dots = [[0.34, -0.42, 1.7], [-0.5, 0.18, 1.4], [0.08, 0.55, 1.6], [-0.24, -0.5, 1.2]];
  for (const [dx, dy, dr] of dots) {
    const x = cx + dx * R, y = cy + dy * R;
    if (!dim) {
      c.beginPath(); c.arc(x, y, dr + 2, 0, Math.PI * 2);
      c.fillStyle = hexA(main, 0.18); c.fill();
    }
    c.beginPath(); c.arc(x, y, dr, 0, Math.PI * 2);
    c.fillStyle = dim ? '#4a5163' : main; c.fill();
  }
  // 中心
  c.beginPath(); c.arc(cx, cy, 2.2, 0, Math.PI * 2);
  c.fillStyle = dim ? '#6f7689' : '#ffffff'; c.fill();
  c.restore();
}
function setIconSafe(details, label) {
  try {
    chrome.action.setIcon(details, () => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[MTEAM] setIcon failed [' + label + ']:', err.message);
    });
  } catch (e) {
    console.warn('[MTEAM] setIcon throw [' + label + ']:', e);
  }
}
function applyIcon(state, phase) {
  try {
    drawRadarIcon(state, phase);
    setIconSafe({ imageData: iconCtx().getImageData(0, 0, ICON_SIZE, ICON_SIZE) }, state + (phase != null ? '+anim' : ''));
  } catch (e) {
    setIconSafe({ path: 'logo.png' }, state + ' fallback');
  }
}
// 把 logo.png 读成 imageData（fetch + createImageBitmap），避开 setIcon({path}) 在 SW 的 Icon invalid
let _logoImageData = null;
async function getLogoImageData() {
  if (_logoImageData) return _logoImageData;
  try {
    const resp = await fetch(chrome.runtime.getURL('logo.png'));
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, ICON_SIZE, ICON_SIZE);
    _logoImageData = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
    if (bmp.close) bmp.close();
    return _logoImageData;
  } catch (e) {
    console.warn('[MTEAM] load logo imageData failed:', e);
    return null;
  }
}
// 采集期间 SW 活跃，setInterval 可靠；采集结束 stopIconAnim 即停（等待时静态）
let _iconAnim = null, _iconPhase = 0;
function startIconAnim() {
  if (_iconAnim) return;
  _iconPhase = 0;
  _iconAnim = setInterval(() => { _iconPhase += 0.32; applyIcon('collect', _iconPhase); }, 100);
}
function stopIconAnim() {
  if (_iconAnim) { clearInterval(_iconAnim); _iconAnim = null; }
}

// ============ badge + title + 图标 统一刷新 ============
// 两态：isRoundRunning（采集中）→ 琥珀雷达旋转；否则 → logo。
async function updateAction() {
  const st = await getAll();
  let title, iconState;
  if (st.isRoundRunning) {
    iconState = 'collect';
    const cur = st.round && st.round.currentRarity;
    const curLabel = cur === 'MECH' ? t('nav.iconCollectingMech') : cur;
    title = cur ? t('nav.iconTitleCollecting', { label: curLabel }) : t('nav.iconTitleCollectingIdle');
  } else {
    iconState = 'stop';
    title = t('nav.iconTitleStopped');
  }
  try { chrome.action.setTitle({ title }); } catch (e) {}
  if (iconState === 'collect') {
    startIconAnim();                       // 琥珀雷达旋转
  } else {
    stopIconAnim();
    // setIcon({path}) 在 SW 读 logo.png 会 Icon invalid，改用 imageData（fetch 读入后绘制）
    const logo = await getLogoImageData();
    if (logo) setIconSafe({ imageData: logo }, 'stop-logo');
    else applyIcon('stop');              // logo 读不进则退回灰雷达
  }
}

// ============ 纯函数：卡牌身份/名称/价格提取（基于实测结构） ============
// 唯一身份：variant 的 filmId + rarity + provenance 组合（detail URL 即据此定位）
function idOf(it) {
  if (!it || typeof it !== 'object') return null;
  const v = it.variant || {};
  const key = [v.filmId, v.rarity, v.provenance].filter((x) => x != null && x !== '').join('|');
  if (key) return key;
  return it.id || it.cardId || it.uuid || null;
}

function nameOf(it) {
  if (!it || typeof it !== 'object') return '';
  return it.filmName || it.title || it.name || '';
}

function priceOf(it) {
  if (!it || typeof it !== 'object') return '';
  return it.lowestAsk == null ? '' : String(it.lowestAsk);
}

// 精简：留展示/去重/跳转所需字段（含 poster 供卡片显示），丢弃 spark7d / type 等
function slim(it) {
  if (!it || typeof it !== 'object') return it;
  return {
    variant: it.variant || null,
    filmName: it.filmName || '',
    title: it.title || '',
    poster: it.poster || '',
    type: it.type || '', // 机制卡子类型(mana_voucher/single_free/vip_7d)
    lowestAsk: it.lowestAsk == null ? null : it.lowestAsk,
    last: it.last == null ? null : it.last,
    chg24h: it.chg24h == null ? null : it.chg24h,
  };
}

// ============ 市场 view 定向搜索（/api/pt-card/market/search） ============
// 多 tag 串行查询，每个返回 data.data（挂单列表），映射成 buckets item 结构以复用 renderCards。
// cardId 级去重（同一挂单被多 tag 命中只留一条）；lowestAsk 取挂单 price。
function mapSearchItem(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    variant: { filmId: s.filmId || '', rarity: s.rarity || '', provenance: s.provenance || '' },
    filmName: s.filmName || '',
    title: s.title || '',
    poster: s.poster || '',
    type: s.type || '',
    lowestAsk: s.price != null ? s.price : null,
  };
}
async function searchMarket(tags, pageSize) {
  if (!Array.isArray(tags) || !tags.length) return { ok: true, items: [] };
  const ps = Number(pageSize) || 100;
  const seen = new Set();
  const out = [];
  for (const kw of tags) {
    const keyword = String(kw || '').trim();
    if (!keyword) continue;
    let resp;
    try {
      resp = await mtFetch('/api/pt-card/market/search', { pageSize: ps, keyword });
    } catch (e) {
      if (e && e.message === 'API_KEY_INVALID') throw e;  // 令牌失效：上抛，dashboard 提示
      console.warn('[MTEAM] market search failed:', keyword, e && e.message); continue;  // 单 tag 失败跳过，继续其它 tag
    }
    if (!resp || resp.code !== '0' || !resp.data) continue;
    const items = (resp.data && resp.data.data) || [];
    for (const it of items) {
      const cid = it.cardId != null ? it.cardId : it.id;
      const key = cid != null ? String(cid) : (it.filmId + '|' + it.rarity + '|' + it.provenance + '|' + (it.price || ''));
      if (seen.has(key)) continue;
      seen.add(key);
      const mapped = mapSearchItem(it);
      if (mapped) out.push(mapped);
    }
  }
  return { ok: true, items: out };
}

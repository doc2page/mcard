// src/lib/collector.js
import { shuffle, parseMtTime, deepMerge } from './shared.js';

const HISTORY_LIMIT = 50;
const MARKET_REFRESH_COOLDOWN = 8 * 1000;
const LIST_MAX_PAGES = 100;
let lastMarketRefreshAt = 0;

export function createCollector({ state, mteam, normalizers, stats }) {
  const { slim } = normalizers;
  const { mtFetch } = mteam;

  // 采集冷却/去重状态（每个 collector 实例独立，便于测试 + 多实例）
  const MYORDERS_FETCH_COOLDOWN = 8000;
  const MARKETDATA_FETCH_COOLDOWN = 8000;
  const CARDLOG_FETCH_COOLDOWN = 30000;
  const INVENTORY_FETCH_COOLDOWN = 30000;
  let _myOrdersPromise = null;
  let lastMyOrdersFetchAt = 0;
  let _myTradesPromise = null;
  let lastMyTradesFetchAt = 0;
  let _marketDataPromise = null;
  let lastMarketDataFetchAt = 0;
  let _cardLogsPromise = null;
  let lastCardLogFetchAt = 0;
  let _inventoryPromise = null;
  let lastInventoryFetchAt = 0;
  let _dropPromise = null;

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
    console.log('[mcard] round done', { hits, misses, authFailed });
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
    try {
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
    } finally {
      // 兜底解锁：循环中途若抛错（state.update/randSleep 等旧版位于内层 try 外，一旦崩则 onRoundDone 永不执行、锁永久卡住），finally 确保仍解锁
      await onRoundDone({ hits, misses, authFailed });
    }
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

  // ============ 通用翻页（mytrades/myorders/marketHistory/cardLogs 共用）============
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
    await state.update({ profile });
    console.log('[mcard] profile updated', profile.username, 'bonus', profile.bonus);
  }

  async function fetchProfile() {
    const resp = await mtFetch('/api/member/profile', {});
    await onProfileData(resp);
  }

  // ============ mytrades 翻页衔接（日常 1 页增量，首次 pageSize=200 翻全建库）============
  // mytrades 翻页衔接（日常 1 页增量，首次 pageSize=200 翻全建库）+ profile。
  async function ensureMyTrades(force) {
    if (_myTradesPromise) return _myTradesPromise;
    if (!force && Date.now() - lastMyTradesFetchAt < MYORDERS_FETCH_COOLDOWN) return { ok: true, skipped: true };
    lastMyTradesFetchAt = Date.now();
    _myTradesPromise = (async () => {
      const out = { ok: true };
      try {
        const st = await state.getState();
        const ps = (st.buyHistory && st.buyHistory.length) ? 20 : 200;
        const r = await syncList('/api/pt-card/market/myTrades', mergeTrades, ps, 'incremental');
        out.tradesAdded = r.added;
        console.log('[mcard] myTrades synced', r);
        try { await fetchProfile(); } catch (e) { console.warn('[mcard] profile fetch failed', e); }
      } catch (e) { console.warn('[mcard] myTrades fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
      finally { _myTradesPromise = null; }
      return out;
    })();
    return _myTradesPromise;
  }

  // 按 id 增量合并进 buyHistory；side 由 sellerId/buyerId == 我的 id 判定；按 tradedAt 降序
  async function mergeTrades(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    const st = await state.getState();
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
    await state.update({ buyHistory: exist });
    return added;
  }

  // ============ 挂单记录：增量合并进 ordersAll（按记录id去重，status变化更新）============
  // 增量合并挂单记录进 ordersAll：按记录 id 去重；新 id 追加，已有 id 更新可变字段(status/price/lastModifiedDate)。
  // cardId 是卡片身份(同 cardId 多条记录 = 该卡挂单轨迹)，记录 id 是单次挂单号。
  async function mergeOrders(items, total) {
    const st = await state.getState();
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
    await state.update({ ordersAll: Array.from(exist.values()), ordersTotal: total || exist.size });
    return { added, updated, total: exist.size };
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
        console.log('[mcard] orders synced', r);
        try { await fetchProfile(); } catch (e) { console.warn('[mcard] profile fetch failed', e); }
      } catch (e) { console.warn('[mcard] orders fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
      finally { _myOrdersPromise = null; }
      return out;
    })();
    return _myOrdersPromise;
  }

  // ============ 市场成交历史：tradeHistory 直连翻页（首次全量 200 / 增量 50）============
  // 按 id 去重合并进 marketHistory（保留分析所需全字段）；按 tradedAt 降序。返回本页新增数。
  async function mergeMarketHistory(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    const st = await state.getState();
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
    await state.update({ marketHistory: exist });
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
        const st = await state.getState();
        let has = Array.isArray(st.marketHistory) && st.marketHistory.length;
        // v0.3.2 迁移：旧数据缺 buyOrderId/sellOrderId（方向判定字段）→ 清空触发全量重采
        if (has && st.marketHistory.some(function (r) { return !('buyOrderId' in r); })) {
          await state.update({ marketHistory: [] });
          has = false;
        }
        const ps = has ? 50 : 200;
        const r = await syncList('/api/pt-card/market/tradeHistory', mergeMarketHistory, ps, 'incremental');
        out.added = r.added;
        console.log('[mcard] marketHistory synced', r);
      } catch (e) { console.warn('[mcard] marketHistory fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
      finally { _marketDataPromise = null; }
      return out;
    })();
    return _marketDataPromise;
  }

  // ============ 魔力符券使用记录：credit/logs 直连翻页（增量合并）============
  // 魔力符券开卡记录（/api/credit/logs type=CARD_MECHANISM）。需 profile.id 作 uid。
  async function ensureCardLogs(force) {
    if (_cardLogsPromise) return _cardLogsPromise;
    if (!force && Date.now() - lastCardLogFetchAt < CARDLOG_FETCH_COOLDOWN) return { ok: true, skipped: true };
    const st0 = await state.getState();
    if (!(st0.profile && st0.profile.id != null)) return { ok: false, reason: 'no_profile' };  // 需 uid
    lastCardLogFetchAt = Date.now();
    _cardLogsPromise = (async () => {
      const out = { ok: true };
      try {
        const uid = String(st0.profile.id);
        const r = await syncList('/api/credit/logs', mergeCardLogs, 100, 'incremental', { type: 'CARD_MECHANISM', uid: uid });
        out.cardLogsAdded = r.added;
        console.log('[mcard] cardLogs synced', r);
      } catch (e) { console.warn('[mcard] cardLogs fetch failed', e); out.ok = false; out.reason = String(e && e.message || e); }
      finally { _cardLogsPromise = null; }
      return out;
    })();
    return _cardLogsPromise;
  }

  // 按 id 增量合并进 cardLogs；存 createdDate/bonus/paid，按 createdDate 降序
  async function mergeCardLogs(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    const st = await state.getState();
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
    await state.update({ cardLogs: exist, cardLogSummary: stats.computeCardLogSummary(exist) });
    return added;
  }

  // ============ 持有：inventory 直连（全量覆盖）+ 机制卡（mechanism/list 独立接口）============
  // inventory 直连：POST /api/pt-card/inventory，pageSize=200 一次拿全部持有（全量覆盖）。
  async function ensureInventoryData(force) {
    if (_inventoryPromise) return _inventoryPromise;
    if (!force && Date.now() - lastInventoryFetchAt < INVENTORY_FETCH_COOLDOWN) return { ok: true, skipped: true };
    lastInventoryFetchAt = Date.now();
    _inventoryPromise = (async () => {
      const out = { ok: true };
      try {
        const resp = await mtFetch('/api/pt-card/inventory', { pageNumber: 1, pageSize: 200 });
        if (resp && resp.code === '0' && resp.data && Array.isArray(resp.data.data)) {
          const items = resp.data.data.map(normalizers.normalizeInventory).filter(Boolean);
          // 机制卡持有（mechanism/list，独立接口；失败不影响普通卡）
          let mechItems = [];
          try {
            const mechResp = await fetchMechanismList();
            if (mechResp && mechResp.code === '0' && Array.isArray(mechResp.data)) {
              mechItems = mechResp.data.map(normalizers.normalizeMechanism).filter(Boolean);
            }
          } catch (e) { console.warn('[mcard] mechanism fetch failed', e); }
          await state.update({ inventory: items, mechInventory: mechItems, inventoryTotal: Number(resp.data.total) || items.length, inventoryFetchedAt: Date.now() });
          out.count = items.length + mechItems.length;
          console.log('[mcard] inventory loaded', items.length, '+ mech', mechItems.length);
        } else {
          console.warn('[mcard] inventory fetch failed or empty');
          out.ok = false; out.reason = 'fetch_failed';
        }
      } catch (e) {
        console.warn('[mcard] inventory fetch failed', e);
        out.ok = false; out.reason = String(e && e.message || e);
      } finally {
        _inventoryPromise = null;
      }
      return out;
    })();
    return _inventoryPromise;
  }

  // 机制卡持有（mechanism/list，body 空，data 直接数组；usedAt!=null 已使用销毁）
  async function fetchMechanismList() {
    return mtFetch('/api/pt-card/mechanism/list', {});
  }

  // ============ mybonus 直连（裸采集，无冷却 gate，由调用方按需触发）============
  async function fetchMyBonus() {
    const resp = await mtFetch('/api/tracker/mybonus', {});
    await onBonusData(resp);
  }

  async function onBonusData(resp) {
    if (!resp || resp.code !== '0' || !resp.data) return;
    const fp = resp.data.formulaParams || {};
    const finalBs = Number(fp.finalBs) || 0;
    await state.update({ bonus: {
      lastFetchDate: _todayStr(),
      finalBs: finalBs,
      raw: { bonus: resp.data.bonus || {}, formulaParams: fp },
    } });
    console.log('[mcard] bonus saved, finalBs=', finalBs);
  }

  function _todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ============ 掉落统计（仅 feed 增量；原 tab 全量路径已删除——容器无浏览器）============
  // feed 增量：/pt-card/feed 结构化卡片 → feedCards（cardId 去重，游标 createdDate > lastMsgDate 只补 msg 之后）
  async function mergeDropFeed(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    const st = await state.getState();
    const ds = Object.assign({}, st.dropStats || {});
    ds.feedCards = Array.isArray(ds.feedCards) ? ds.feedCards.slice() : [];
    if (ds.lastMsgDate) ds.feedCards = ds.feedCards.filter((c) => (c.createdDate || '') > ds.lastMsgDate);  // 只留 messages 未覆盖的（> lastMsgDate），避免与导入的全量 messages 双源重叠
    ds.since = ds.since || '';
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
    // since 取 messages+feedCards 最早一条（导入的历史 messages 可能早于 feed，不能只看 feed 丢起点）
    let earliest = '';
    for (const arr of [ds.messages, ds.feedCards]) {
      if (!Array.isArray(arr)) continue;
      for (const it of arr) { const d = it.createdDate || ''; if (d && (!earliest || d < earliest)) earliest = d; }
    }
    if (earliest) ds.since = earliest;
    ds.summary = stats.computeDropSummary(ds.messages, ds.feedCards, ds.since, _todayStr());
    await state.update({ dropStats: ds });
    console.log('[mcard] drop merged (feed), +' + added + ', total feedCards', ds.feedCards.length);
    return added;
  }

  // feed 增量直连（最新 25 条），不走 tab。单例去重 + try/catch，与其它 ensure* 一致。
  async function ensureDropStats() {
    if (_dropPromise) return _dropPromise;
    _dropPromise = (async () => {
      const out = { ok: true };
      try {
        const r = await syncList('/api/pt-card/feed', mergeDropFeed, 25, 'incremental');
        out.dropsAdded = r.added;
        const cur = await state.getState();
        await state.update({ dropStats: Object.assign({}, cur.dropStats || {}, { lastFeedAt: Date.now() }) });
      } catch (e) { console.warn('[mcard] drop feed failed', e); out.ok = false; out.reason = String(e && e.message || e); }
      // 魔力符券开卡记录（/api/credit/logs，需 profile.id）；profile 未就绪时内部自动跳过
      try { await ensureCardLogs(true); } catch (e) { console.warn('[mcard] cardLogs in dropStats failed', e); }
      finally { _dropPromise = null; }
      return out;
    })();
    return _dropPromise;
  }

  // ============ 导入掉落记录（手动粘贴 message search 响应，补齐 feed 之前的全量历史）============
  // 用户在 kp.m-team.cc/message/-2 搜「卡片掉落」→ 复制 search 请求响应 → 粘贴到前端模态 → 此处解析合并。
  // 与 feed 互补：messages=全量历史（本入口），feedCards=近期增量（feed 接口）；computeDropSummary 双源聚合。
  async function importDropMessages(raw) {
    const parsed = _parseDropJson(raw);
    if (!parsed.ok) return parsed;
    const st = await state.getState();
    const ds = Object.assign({}, st.dropStats || {});
    ds.messages = Array.isArray(ds.messages) ? ds.messages.slice() : [];
    ds.feedCards = Array.isArray(ds.feedCards) ? ds.feedCards.slice() : [];
    const existIds = new Set(ds.messages.map((m) => String(m.id)));
    let imported = 0, skipped = 0;
    for (const it of parsed.items) {
      if (!it || it.id == null) { skipped++; continue; }
      const id = String(it.id);
      if (existIds.has(id)) { skipped++; continue; }
      const ctx = it.context || '';
      if (!stats.parseDropContext(ctx).length) { skipped++; continue; }  // 只留能解析出卡片的掉卡 message
      ds.messages.push({ id: id, createdDate: it.createdDate || '', context: ctx });
      existIds.add(id);
      imported++;
    }
    // msgTotal = message 接口总条数（响应头部每次都带，无论本次是否新增）——即使全重复也记录，供前端判断补全（老用户首导或重导同样数据都能补上 msgTotal）
    const newMsgTotal = (parsed.page && parsed.page.total) || 0;
    const msgTotalChanged = newMsgTotal && newMsgTotal !== (ds.msgTotal || 0);
    if (newMsgTotal) ds.msgTotal = newMsgTotal;
    if (imported) {
      ds.messages.sort((a, b) => (b.createdDate || '').localeCompare((a.createdDate || '')));
      ds.lastMsgDate = ds.messages[0].createdDate;  // feed 游标 = messages 最新，只补其后，不与导入历史重叠
      ds.feedCards = ds.feedCards.filter((c) => (c.createdDate || '') > ds.lastMsgDate);  // messages 是全量（含近期），剔除 feedCards 中已被覆盖的重叠部分，避免双源重复计算
      let earliest = '';
      for (const m of ds.messages) { const d = m.createdDate || ''; if (d && (!earliest || d < earliest)) earliest = d; }
      for (const c of ds.feedCards) { const d = c.createdDate || ''; if (d && (!earliest || d < earliest)) earliest = d; }
      if (earliest) ds.since = earliest;
      ds.summary = stats.computeDropSummary(ds.messages, ds.feedCards, ds.since, _todayStr());
      console.log('[mcard] drop imported (messages), +' + imported + ', total messages', ds.messages.length);
    }
    if (imported || msgTotalChanged) await state.update({ dropStats: ds });
    return { ok: true, imported: imported, skipped: skipped, total: ds.messages.length, page: parsed.page || null };
  }

  // 解析粘贴 JSON → message 数组。容忍完整响应 {code,data:{data:[...]}} / {data:[...]} / 裸数组 / 单条。
  function _parseDropJson(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty' };
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'invalid_json' }; }
    let arr, page = null;
    if (Array.isArray(obj)) arr = obj;
    else if (obj && obj.data && Array.isArray(obj.data.data)) {
      arr = obj.data.data;
      page = { totalPages: Number(obj.data.totalPages) || 0, total: Number(obj.data.total) || 0, pageNumber: Number(obj.data.pageNumber) || 0, pageSize: Number(obj.data.pageSize) || 0 };
    }
    else if (obj && Array.isArray(obj.data)) arr = obj.data;
    else if (obj && typeof obj === 'object' && obj.id != null) arr = [obj];
    else return { ok: false, reason: 'no_messages' };
    return { ok: true, items: arr, page: page };
  }

  // ============ 询价：orderbook 直连（取最高买价 bids[0]，bids 按价格降序）============
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

  // ============ 市场搜索：多 tag 串行，cardId 去重合并 ============
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
        if (e && e.message === 'API_KEY_INVALID') throw e;  // 令牌失效：上抛
        console.warn('[mcard] market search failed:', keyword, e && e.message); continue;  // 单 tag 失败跳过
      }
      if (!resp || resp.code !== '0' || !resp.data) continue;
      const items = (resp.data && resp.data.data) || [];
      for (const it of items) {
        const cid = it.cardId != null ? it.cardId : it.id;
        const key = cid != null ? String(cid) : (it.filmId + '|' + it.rarity + '|' + it.provenance + '|' + (it.price || ''));
        if (seen.has(key)) continue;
        seen.add(key);
        const mapped = normalizers.mapSearchItem(it);
        if (mapped) out.push(mapped);
      }
    }
    return { ok: true, items: out };
  }

  // ============ 首次/手动全量刷新：各 ensure 跑一次 + 一轮市场卡片 ============
  async function refreshAll() {
    try {
      const st = await state.getState();
      await Promise.all([ensureMyTrades(), ensureMyOrders(), ensureInventoryData()]);
      await ensureDropStats();
      await ensureMarketData();
      try { await fetchMyBonus(); } catch (e) { console.warn('[mcard] bonus fetch failed', e); }
      await startRound(st, 'refresh', null, (st.config && st.config.listPageSize) || 10);
    } catch (e) { console.warn('[mcard] refreshAll error', e); }
    return { ok: true };
  }

  // ============ 配置：嵌套合并（deepMerge，不丢字段）============
  async function setConfig(config) {
    if (!config) return { ok: false };
    const safe = Object.assign({}, config);
    delete safe.apiKey;   // 只能经 /api/config（verifyApiKey 验证）设置
    delete safe.apiBase;
    const st = await state.getState();
    const merged = deepMerge(st.config || {}, safe);
    await state.update({ config: merged });
    return { ok: true };
  }

  // ============ 清空采集数据（恢复 DEFAULT_STATE 子集，内联字面量）============
  async function clearData() {
    await state.update({
      buckets: {},
      mechBucket: { lastReqId: 0, items: [], time: null, count: 0 },
      history: [],
      stats: { total: 0, misses: 0, lastRoundTime: null, lastError: null },
      marketHistory: [],
    });
    return { ok: true };
  }

  return {
    startRound, triggerRefreshRound, fetchMarketList, applyMarketRarity, onRoundDone,
    fetchProfile, fetchMyBonus,
    syncList, onProfileData, ensureMyTrades, ensureMyOrders, ensureMarketData,
    ensureCardLogs, ensureInventoryData, fetchMechanismList,
    ensureDropStats, importDropMessages, queryOrderbook, searchMarket, refreshAll, setConfig, clearData,
  };
}

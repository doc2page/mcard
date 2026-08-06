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

  // fetchProfile / fetchMyBonus filled in by a later task; placeholders so market tests run.
  async function fetchProfile() {}
  async function fetchMyBonus() {}

  return { startRound, triggerRefreshRound, fetchMarketList, applyMarketRarity, onRoundDone, fetchProfile, fetchMyBonus };
}

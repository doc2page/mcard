// src/state.js
import { RARITIES, deepMerge, isPlainObj } from './lib/shared.js';

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
    lockedCards: [],
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
    since: '', lastMsgDate: '', messages: [], feedCards: [], lastFeedAt: 0, summary: null, msgTotal: 0,
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
    // 原子读改写：fn 直接在活 state[key] 上修改（不经 getState 副本），同步执行无并发窗口。
    // 「getState 副本 → 改 → update 写回」模式在多写源并发时会互相覆盖丢更新
    // （如 dropStats：采集 feed 增量与手动导入同时进行，后写覆盖先写）。双写源的 key 一律用 mutate。
    mutate(key, fn) {
      fn(state[key]);
      store.saveState(state);
      const evt = { type: 'state', patch: { [key]: state[key] } };
      for (const cb of subscribers) cb(evt);
    },
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

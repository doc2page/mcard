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

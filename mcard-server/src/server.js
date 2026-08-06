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

// 启动重算 dropStats/cardLog summary（对齐 background.js:79-91 的启动逻辑）
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

// 简单 app（仅 /health），供 health.test.js 使用，无需 db
export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

// 完整装配：store → state → mteam → collector → trader → routes
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

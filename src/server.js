// src/server.js
import express from 'express';
import path from 'node:path';
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
import { requireAuth } from './lib/auth.js';
import { createAuthRouter } from './routes/auth.js';

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 启动重算 dropStats/cardLog summary（对齐 background.js:79-91 的启动逻辑）
function createStoreState(store) {
  const state = createState({ store });
  // 运行锁是进程内瞬时态，绝不跨重启保留——上次崩溃残留的 isRoundRunning:true 会持久化进 db，重启后让 triggerRefreshRound 永远走 queued 分支、市场采集再也不触发
  state.update({ isRoundRunning: false, round: null });
  (async () => {
    try {
      const st = state.getState();
      const patch = {};
      const ds = st.dropStats;
      if (ds && ((Array.isArray(ds.feedCards) && ds.feedCards.length) || (Array.isArray(ds.messages) && ds.messages.length))) {
        // feedCards 只留 messages 未覆盖的（> lastMsgDate），避免与导入的全量 messages 双源重叠重复计算
        const lmd = ds.lastMsgDate || '';
        const feedCards = (lmd && Array.isArray(ds.feedCards)) ? ds.feedCards.filter((c) => (c.createdDate || '') > lmd) : (ds.feedCards || []);
        // since 取 messages+feedCards 最早一条（导入的历史 messages 可能早于 feed；对齐 mergeDropFeed）
        let earliest = '';
        for (const arr of [feedCards, ds.messages]) {
          if (!Array.isArray(arr)) continue;
          for (const it of arr) { const d = it.createdDate || ''; if (d && (!earliest || d < earliest)) earliest = d; }
        }
        const since = earliest || ds.since || '';
        patch.dropStats = Object.assign({}, ds, { feedCards: feedCards, since: since, summary: stats.computeDropSummary(ds.messages, feedCards, since, todayStr()) });
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

  // 访问鉴权（设 AUTH_PASSWORD env 启用；未设则完全开放，向后兼容）
  const authPassword = process.env.AUTH_PASSWORD || '';
  const publicDir = path.join(import.meta.dirname, '../public');
  if (authPassword) {
    app.use(createAuthRouter({ password: authPassword, publicDir }));  // /login + /api/login + /api/logout
    app.use(requireAuth({ password: authPassword }));                   // 保护后续路由（白名单放行登录相关）
    console.log('[mcard] auth enabled (AUTH_PASSWORD set)');
  }

  app.use(express.static(publicDir));
  app.use(createApiRouter({ state, collector, trader, mteam }));
  app.use(createSseRouter({ state }));

  const host = process.env.HOST || '127.0.0.1';
  const server = app.listen(port ?? (Number(process.env.PORT) || 3000), host);
  return { app, server, state, store };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, store } = createServer();
  console.log('[mcard] server started');
  // 优雅退出：docker stop/restart 发 SIGTERM → 停止接受新连接 → 关 SQLite（WAL 落盘）→ 退出。
  // SSE 长连接会挂住 server.close 回调，5s 兜底强退（快于 docker 默认 10s SIGKILL）。
  let _closing = false;
  function shutdown(sig) {
    if (_closing) return;
    _closing = true;
    console.log('[mcard] shutting down (' + sig + ')...');
    server.close(() => {
      try { store.close(); } catch (e) { /* db 已关闭 */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

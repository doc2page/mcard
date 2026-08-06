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
    try {
      res.json(await collector.queryOrderbook(filmId, provenance, rarity));
    } catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
  });
  router.post('/api/search', async (req, res) => {
    const { tags, pageSize } = req.body || {};
    try {
      res.json(await collector.searchMarket(tags, pageSize));
    } catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
  });
  router.post('/api/setconfig', async (req, res) => {
    try {
      res.json(await collector.setConfig(req.body || {}));
    } catch (e) { res.json({ ok: false, error: String(e.message || e) }); }
  });

  return router;
}

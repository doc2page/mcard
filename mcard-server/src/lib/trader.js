// src/lib/trader.js
import { buildDetailUrl, computeUsable, isMechCard } from './shared.js';

const CANCEL_RETRY = 3;
const CANCEL_RETRY_DELAY = 300;

export function createTrader({ state, mteam, collector }) {
  const { mtFetch } = mteam;

  async function cancelBuyOrder(orderId) {
    for (let i = 0; i < CANCEL_RETRY; i++) {
      try {
        const r = await mtFetch('/api/pt-card/market/cancel', { orderId: Number(orderId) });
        if (r && String(r.code) === '0') return true;
      } catch (e) {}
      if (i < CANCEL_RETRY - 1) await new Promise((res) => setTimeout(res, CANCEL_RETRY_DELAY));
    }
    return false;
  }

  async function addCancelFailedOrder(rec) {
    if (!rec || rec.orderId == null) return;
    const st = await state.getState();
    await state.update({ cancelFailedOrders: (st.cancelFailedOrders || []).concat([rec]) });
  }

  // 一键购买：buy 直连(限价，price=入库 lowestAsk) → filled 成交 / open 挂单则 cancel 撤销。结果交 dashboard 展示。
  async function buyCard(msg) {
    const variant = msg.variant || {};
    const expectPrice = Number(msg.expectPrice);
    const st = await state.getState();
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
      const cur = await state.getState();
      const cb = (cur.config && cur.config.budget) || { total: 0, spent: 0 };
      const ct = Number(cb.total) || 0;
      if (ct > 0) {
        const newSpent = (Number(cb.spent) || 0) + (Number(trade.price) || 0);
        await state.update({ config: Object.assign({}, cur.config, { budget: { total: ct, spent: newSpent } }) });
      }
      // 购买后刷新该卡所属分类（机制卡→MECH，普通→rarity）；批量调用传 skipRefresh 跳过逐张刷新（整批后前端统一刷）
      if (!msg.skipRefresh) {
        const key = isMechCard(variant) ? 'MECH' : (variant.rarity || null);
        collector.triggerRefreshRound('buy', key ? [key] : null).catch((e) => console.warn('[mcard] refresh trigger failed', e));
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
        collector.ensureInventoryData(true).catch((e) => console.warn('[mcard] inventory refresh after sell failed', e)),
        collector.ensureMyOrders(true).catch((e) => console.warn('[mcard] orders refresh after sell failed', e)),
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
        collector.ensureMyOrders(true).catch((e) => console.warn('[mcard] orders refresh after cancel failed', e)),
        collector.ensureInventoryData(true).catch((e) => console.warn('[mcard] inventory refresh after cancel failed', e)),
      ]);
    }
    return { ok: true };
  }

  return { buyCard, sellCard, cancelOrder };
}

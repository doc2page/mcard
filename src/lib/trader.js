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

  // 普通卡兑换机制卡：恰好 10 张同稀有度普通卡 → 1 张机制符。recipeId 1=魔力符(N) 2=置顶免费符(SR) 3=VIP符(UR)。
  // 后端双重校验（前端已拦，防前端状态过期/绕过）：10 个不同 cardId + state.inventory 回查均为普通卡、稀有度匹配、未手动锁定。
  // 挂单卡不在 inventory（回查 miss 即拒）；冷却卡（tradeLockUntil）可兑，官方允许。
  const REDEMPTION_RECIPES = {
    1: { rarity: 'N', mechType: 'mana_voucher' },
    2: { rarity: 'SR', mechType: 'single_free' },
    3: { rarity: 'UR', mechType: 'vip_7d' },
  };
  async function redemption(msg) {
    const recipe = REDEMPTION_RECIPES[msg.recipeId];
    const cardIds = Array.isArray(msg.cardIds) ? msg.cardIds : [];
    if (!recipe) return { ok: false, reason: 'unknown_recipe' };
    if (cardIds.length !== 10) return { ok: false, reason: 'need_exact_10' };
    const ids = Array.from(new Set(cardIds.map(Number)));
    if (ids.length !== 10) return { ok: false, reason: 'need_exact_10' };  // 有重复 cardId
    const st = await state.getState();
    const byId = new Map((st.inventory || []).map((c) => [String(c.cardId), c]));
    const locked = new Set(((st.config && st.config.lockedCards) || []).map(String));
    for (const id of ids) {
      const c = byId.get(String(id));
      if (!c || isMechCard(c) || c.rarity !== recipe.rarity) return { ok: false, reason: 'card_mismatch', cardId: id };
      if (locked.has(String(id))) return { ok: false, reason: 'card_locked', cardId: id };
    }
    let json;
    try {
      json = await mtFetch('/api/pt-card/redemption/submit', { cardIds: ids, recipeId: Number(msg.recipeId) });
    } catch (e) {
      return { ok: false, reason: 'redeem_failed' };  // API_KEY_INVALID / 网络错
    }
    if (!json || String(json.code) !== '0' || !json.data) return { ok: false, reason: 'redeem_failed' };
    const reward = (json.data && json.data.reward) || {};
    // 本地记录兑换历史（前端统计卡展示已兑换分类/数量；写前重读防覆盖并发写）
    const st2 = await state.getState();
    await state.update({ redemptions: (st2.redemptions || []).concat([{ recipeId: Number(msg.recipeId), mechType: reward.mechType || recipe.mechType, count: ids.length, at: Date.now() }]) });
    return { ok: true, mechType: reward.mechType || recipe.mechType, mechCardId: reward.mechCardId || null };
  }

  // 挂买改价专用：纯限价买单——open 未成交 = 挂上（不撤），filled = 直接成交。
  // 不走 buyCard 的预算池/价格阈值门与「open 即撤」逻辑（改价语义 = 调整既有挂单价格，非新买入决策）
  async function relistBuy(msg) {
    const variant = msg.variant || {};
    const price = Number(msg.price);
    if (!variant.filmId || !Number.isFinite(price) || price <= 0) return { ok: false, reason: 'buy_failed' };
    let json;
    try {
      json = await mtFetch('/api/pt-card/market/buy', { filmId: variant.filmId, rarity: variant.rarity, provenance: variant.provenance, price: price });
    } catch (e) {
      return { ok: false, reason: 'buy_failed' };  // API_KEY_INVALID / 网络错
    }
    if (!json || String(json.code) !== '0' || !json.data) return { ok: false, reason: 'buy_failed' };
    return { ok: true, filled: String(json.data.status) === 'filled' };
  }

  return { buyCard, sellCard, cancelOrder, redemption, relistBuy };
}

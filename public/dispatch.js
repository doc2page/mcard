// public/dispatch.js — send(msg) 的 fetch 路由映射（纯函数，浏览器 + Node 可测）
export function dispatch(msg) {
  switch (msg.type) {
    case 'GET_STATE':        return { method: 'GET',  path: '/api/state' };
    case 'GET_ORDERBOOK': {
      const q = new URLSearchParams({ filmId: msg.filmId || '', provenance: msg.provenance || '', rarity: msg.rarity || '' });
      return { method: 'GET', path: '/api/orderbook?' + q.toString() };
    }
    case 'REFRESH_NOW':      return { method: 'POST', path: '/api/collect', body: { type: 'market' } };
    case 'LOAD_TRADES':      return { method: 'POST', path: '/api/collect', body: { type: 'trades' } };
    case 'LOAD_ORDERS':      return { method: 'POST', path: '/api/collect', body: { type: 'orders' } };
    case 'LOAD_INVENTORY':   return { method: 'POST', path: '/api/collect', body: { type: 'inventory' } };
    case 'LOAD_DROP_STATS':  return { method: 'POST', path: '/api/collect', body: { type: 'drops' } };
    case 'LOAD_MARKET_DATA': return { method: 'POST', path: '/api/collect', body: { type: 'marketStats' } };
    case 'SEARCH_MARKET':    return { method: 'POST', path: '/api/search', body: { tags: msg.tags, pageSize: msg.pageSize } };
    case 'BUY_CARD':         return { method: 'POST', path: '/api/trade', body: { action: 'buy', variant: msg.variant, expectPrice: msg.expectPrice, maxPrice: msg.maxPrice, skipRefresh: msg.skipRefresh } };
    case 'SELL_CARD':        return { method: 'POST', path: '/api/trade', body: { action: 'sell', cardId: msg.cardId, isMech: msg.isMech, netPrice: msg.netPrice, skipRefresh: msg.skipRefresh } };
    case 'CANCEL_ORDER':     return { method: 'POST', path: '/api/trade', body: { action: 'cancel', orderId: msg.orderId, skipRefresh: msg.skipRefresh } };
    case 'SET_CONFIG':       return { method: 'POST', path: '/api/setconfig', body: msg.config };
    case 'SAVE_API_KEY':     return { method: 'POST', path: '/api/config', body: { apiKey: msg.key, webBase: msg.webBase } };
    case 'SET_WEB_BASE':     return { method: 'POST', path: '/api/setconfig', body: { webBase: msg.webBase } };
    default: return null;
  }
}
if (typeof window !== 'undefined') window.dispatch = dispatch;

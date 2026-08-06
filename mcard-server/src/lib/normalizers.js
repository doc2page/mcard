// src/lib/normalizers.js — 卡牌字段映射纯函数（自 background.js 搬迁为 ESM）
// 无 chrome.* / 无 getAll/set，纯逻辑，可被 node --test 单测。

// 精简：留展示/去重/跳转所需字段（含 poster 供卡片显示），丢弃 spark7d / type 等
export function slim(it) {
  if (!it || typeof it !== 'object') return it;
  return {
    variant: it.variant || null,
    filmName: it.filmName || '',
    title: it.title || '',
    poster: it.poster || '',
    type: it.type || '', // 机制卡子类型(mana_voucher/single_free/vip_7d)
    lowestAsk: it.lowestAsk == null ? null : it.lowestAsk,
    last: it.last == null ? null : it.last,
    chg24h: it.chg24h == null ? null : it.chg24h,
  };
}

// 单卡字段映射（全量覆盖写入 inventory 键）
export function normalizeInventory(it) {
  if (!it) return null;
  return {
    cardId: String(it.id || ''),
    filmId: it.filmId || '',
    filmName: it.filmName || '',
    year: it.year || '',
    rarity: it.rarity || '',
    title: it.title || '',
    poster: it.poster || '',
    provenance: it.provenance || '',
    serial: it.serial || '',
    tradeLockUntil: it.tradeLockUntil || '',
    torrentId: it.torrentId != null ? String(it.torrentId) : '',
    currentSeeders: it.currentSeeders != null ? String(it.currentSeeders) : '',
    createdDate: it.createdDate || '',
    lastModifiedDate: it.lastModifiedDate || '',
  };
}

// 机制卡字段映射（mechanism/list 项；usedAt!=null 已使用销毁）
export function normalizeMechanism(it) {
  if (!it) return null;
  return {
    cardId: String(it.id || ''),
    filmId: 'mech:' + (it.type || ''),
    filmName: it.displayName || '',
    rarity: it.rarity || 'N',
    type: it.type || '',
    serial: it.serial || '',
    tradeLockUntil: it.tradeLockUntil || '',
    provenance: 'mech',
    isMech: true,
    isUsed: !!it.usedAt,            // usedAt 非空 = 已使用销毁
    usedAt: it.usedAt || null,
    createdDate: it.createdDate || '',
    lastModifiedDate: it.lastModifiedDate || '',
  };
}

// 市场 search 命中项映射成 buckets item 结构（复用 renderCards）；lowestAsk 取挂单 price。
export function mapSearchItem(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    variant: { filmId: s.filmId || '', rarity: s.rarity || '', provenance: s.provenance || '' },
    filmName: s.filmName || '',
    title: s.title || '',
    poster: s.poster || '',
    type: s.type || '',
    lowestAsk: s.price != null ? s.price : null,
  };
}

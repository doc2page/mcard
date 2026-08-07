// src/lib/shared.js
export const RARITIES = ['UR', 'SSR', 'SR', 'R', 'N'];
export const RARITY_LABEL = { UR: 'UR', SSR: 'SSR', SR: 'SR', R: 'R', N: 'N' };
export const MECH_TYPES = [
  { type: 'mana_voucher', label: '魔力符券' },
  { type: 'single_free', label: '置顶免费符' },
  { type: 'vip_7d', label: 'VIP七日符' },
];
export const MECH_LABEL = { mana_voucher: '魔力符券', single_free: '置顶免费符', vip_7d: 'VIP七日符' };
export const WEB_OPTS = ['kp.m-team.cc', 'zp.m-team.io'];
export const API_OPTS = ['api.m-team.cc', 'api.m-team.io'];
export const DROP_SINCE_DEFAULT = '2026-07-01 00:00:00';
export const DROP_RARITY_WEIGHT = { UR: 30, SSR: 10, SR: 5, R: 3, N: 1 };

export function isMechCard(x) {
  const v = (x && x.variant) || x || {};
  return v.provenance === 'mech' || (typeof v.filmId === 'string' && v.filmId.indexOf('mech:') === 0);
}
export function mechTypeOf(it) {
  if (it && it.type) return it.type;
  const v = (it && (it.variant || it)) || {};
  if (typeof v.filmId === 'string' && v.filmId.indexOf('mech:') === 0) return v.filmId.slice(5);
  return '';
}
export function parseMtTime(s) {
  if (!s) return NaN;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  const d = new Date(s);
  return isNaN(d.getTime()) ? NaN : d.getTime();
}
export function webUrl(webBase, path) { return 'https://' + webBase + path; }
export function buildDetailUrl(x, webBase) {
  const v = (x && x.variant) || x || {};
  const q = new URLSearchParams({ filmId: v.filmId || '', rarity: v.rarity || '', provenance: v.provenance || '' });
  return webUrl(webBase || 'kp.m-team.cc', '/cards/market/detail?' + q.toString());
}
export function computeUsable(st) {
  const budget = (st && st.config && st.config.budget) || { total: 0, spent: 0 };
  const bTotal = Number(budget.total) || 0;
  const spent = Number(budget.spent) || 0;
  const remaining = bTotal - spent;
  const bonus = Number(st && st.profile && st.profile.bonus) || 0;
  return { bTotal, spent, remaining, bonus, usable: Math.min(remaining, bonus) };
}
export function isPlainObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
export function deepMerge(target, src) {
  if (!isPlainObj(target) || !isPlainObj(src)) return src;
  const out = Object.assign({}, target);
  for (const k of Object.keys(src)) {
    out[k] = (isPlainObj(target[k]) && isPlainObj(src[k])) ? deepMerge(target[k], src[k]) : src[k];
  }
  return out;
}
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

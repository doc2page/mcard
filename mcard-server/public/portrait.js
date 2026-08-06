/*
 * portrait.js — 用户画像纯逻辑（财富等级 + 消费趋势 + 五维雷达 + 维度 key）
 * 自包含：不依赖 chrome.* 或 i18n，只产出 key + 原始值；文案由 dashboard 用 t() 查 locales。
 * 可被 node --test 单测（测 key/数值/归一，不测文案）。
 *
 * 核心原则：
 *  - 财富等级是【绝对存量标尺】，纯看余额分 9 档，和消费行为正交。
 *  - 消费趋势是【流量走向】：积攒/自给/消耗/透支，按天判定（日产能 vs 日支出 + 存量可持续天数）。
 */

// 财富等级阈值（魔力余额，左闭右开）。label 走 locales（portrait.wealth.<key>），这里只存 max/key/color
// 贫穷<3万 ≤ 温饱<10万 ≤ 普通<30万 ≤ 中产<100万 ≤ 富裕<300万 ≤ 富豪<1000万 ≤ 巨富<5000万 ≤ 新钱<1亿 ≤ 老钱
var WEALTH_TIERS = [
  { max: 30000,     key: 'poor',     color: '#6a7284' },
  { max: 100000,    key: 'modest',   color: '#5b9aa0' },
  { max: 300000,    key: 'average',  color: '#6b7e9e' },
  { max: 1000000,   key: 'middle',   color: '#f5a623' },   // 中产：正金
  { max: 3000000,   key: 'rich',     color: '#ffd11a' },   // 富裕：亮黄金（更黄更亮，与中产拉开）
  { max: 10000000,  key: 'wealthy',  color: '#ff7a2d' },   // 富豪：橙
  { max: 50000000,  key: 'tycoon',   color: '#e8402d' },   // 巨富：红橙
  { max: 100000000, key: 'nouveau',  color: '#b886e8' },
  { max: Infinity,  key: 'oldmoney', color: '#7a4fb8' },
];

function wealthTier(bonus) {
  const b = Number(bonus) || 0;
  for (let i = 0; i < WEALTH_TIERS.length; i++) {
    if (b < WEALTH_TIERS[i].max) return { tier: WEALTH_TIERS[i], index: i };
  }
  return { tier: WEALTH_TIERS[WEALTH_TIERS.length - 1], index: WEALTH_TIERS.length - 1 };
}

// 对数归一：把跨大数量级的值（魔力）压到 0-1。10^lo→0, 10^hi→1。
function _logNorm(v, lo, hi) {
  const x = Number(v) || 0;
  if (x <= 0) return 0;
  const l = Math.log10(x);
  if (l <= lo) return 0;
  if (l >= hi) return 1;
  return (l - lo) / (hi - lo);
}

// 各维度档位 key（文案走 locales）
function tradeStyleKey(b, s) { return (b + s === 0) ? 'newbie' : (b >= s * 2 ? 'hoard' : (s > b ? 'flip' : 'turn')); }
function luckKey(r) { return r >= 15 ? 'lucky' : (r >= 6 ? 'normal' : 'unlucky'); }
// 符券博弈：张数归一（100张封顶）+ 分档（count=赌性, avg=欧皇度, range=极差波动；波动优先于均值）
function _countNorm(c) { const x = Number(c) || 0; return x <= 0 ? 0 : Math.min(1, Math.log10(x) / 2); }
function gambleKey(c, a, rg) {
  const n = Number(c) || 0;
  if (n <= 0) return 'none';            // 未涉足
  if (n < 10) return 'newbie';          // 尝鲜
  if (rg >= 50000) return 'coaster';    // 过山车（波动大，优先）
  if (a >= 20000) return 'lucky';       // 欧皇赌徒（高均值）
  return 'grind';                       // 苦挖（低均值且稳）
}
function incomeKey(f) { return f >= 300 ? 'high' : (f >= 100 ? 'mid' : (f > 0 ? 'low' : 'none')); }
function spendKey(s) { return s <= 0 ? 'zero' : (s >= 10000 ? 'heavy' : (s >= 1000 ? 'mid' : 'light')); }

// 主入口
// 入参字段（全部可选，缺省按 0 处理）：
//   bonus(魔力余额), finalBs(每小时产能),
//   buySum, sellSum, buyCount, sellCount, spanDays(统计窗口总历时天数 since~今天),
//   rarityScore(掉落运气分),
//   cardCount(符券开卡数), cardAvg(平均收益), cardMax/cardMin(单卡极值) → 博弈维
function computePortrait(a) {
  a = a || {};
  const bonus = Number(a.bonus) || 0;
  const finalBs = Math.max(0, Number(a.finalBs) || 0);
  const buySum = Number(a.buySum) || 0, sellSum = Number(a.sellSum) || 0;
  const buyCount = Number(a.buyCount) || 0, sellCount = Number(a.sellCount) || 0;
  const spanDays = Number(a.spanDays) || 0;
  const rarityScore = Number(a.rarityScore) || 0;
  const cardCount = Number(a.cardCount) || 0;
  const cardAvg = Number(a.cardAvg) || 0;
  const cardRange = Math.max(0, (Number(a.cardMax) || 0) - (Number(a.cardMin) || 0));

  const wt = wealthTier(bonus);
  const dayIncome = finalBs * 24;                        // 日产能（每小时×24）
  const netSpend = buySum - sellSum;                     // 净支出（正=买>卖）
  // spanDays = 统计窗口总历时（since~今天，含没交易日）；日均支出 = 净支出 / 总历时，不外推放大
  const daySpend = spanDays > 0 ? Math.max(0, netSpend) / spanDays : Math.max(0, netSpend);

  // 消费趋势（按天）：日产能 vs 日支出
  let trendKey, daysLeft = null;
  if (netSpend <= 0) {
    trendKey = 'hoard';
  } else if (dayIncome >= daySpend) {
    trendKey = 'self';
  } else {
    const deficit = daySpend - dayIncome;               // 日亏空
    daysLeft = bonus > 0 ? Math.floor(bonus / deficit) : 0;
    trendKey = daysLeft >= 90 ? 'drain' : 'overdraw';   // 还能撑≥90天为消耗，否则透支
  }

  // 五维雷达（0-1）
  // 博弈维 = 赌性0.5 + 欧皇0.25 + 波动0.25（张数/均值/极差 各自归一）；未开卡→0
  const gCount = _countNorm(cardCount);
  const gAvg = _logNorm(cardAvg, 2, 5);                    // 均值：100 ~ 100k
  const gRange = _logNorm(cardRange, 2, 5);                // 极差：100 ~ 100k
  const radar = {
    wealth: wt.index / (WEALTH_TIERS.length - 1),
    income: _logNorm(finalBs, 0, 3),                    // 产能：1 ~ 1000 /h
    spend: _logNorm(daySpend, 1, 4),                       // 消费：10 ~ 10000 /天
    luck: Math.max(0, Math.min(1, rarityScore / 30)),
    gamble: cardCount > 0 ? Math.max(0, Math.min(1, 0.5 * gCount + 0.25 * gAvg + 0.25 * gRange)) : 0,
  };

  // 五维详情（图标 + 原始值 + 单位 key + 评价 key + 归一 ratio）；文案/单位由 dashboard t() 查
  const dims = [
    { key: 'wealth', icon: '💰', value: Math.round(bonus).toLocaleString(), unit: '', evalKey: wt.tier.key, ratio: radar.wealth },
    { key: 'income', icon: '⚙️', value: Math.round(dayIncome), unit: 'unitDay', evalKey: incomeKey(finalBs), ratio: radar.income },
    { key: 'spend', icon: '💸', value: Math.round(daySpend), unit: 'unitDay', evalKey: spendKey(daySpend), ratio: radar.spend },
    { key: 'luck', icon: '🍀', value: rarityScore.toFixed(1), unit: 'unitScore', evalKey: luckKey(rarityScore), ratio: radar.luck },
    { key: 'gamble', icon: '🎰', value: String(cardCount), unit: 'unitCard', evalKey: gambleKey(cardCount, cardAvg, cardRange), ratio: radar.gamble },
  ];

  // 速写/称号：选择哪个 i18n 模板 key（dashboard 用 t() 渲染时填参数）
  const narrativeIdKey = trendKey === 'hoard' ? 'narrIdHoard' : (trendKey === 'self' ? 'narrIdSelf' : 'narrIdPlain');
  const spendingKey = netSpend > 0 ? 'narrSpend' : 'narrSpendZero';
  const luckLineKey = 'narrLuck';   // 运气 + 博弈合一（不再依赖掉落活跃天数）

  return {
    wealth: { key: wt.tier.key, bonus: bonus, index: wt.index, color: wt.tier.color },
    trend: { key: trendKey, daysLeft: daysLeft },
    styleKey: tradeStyleKey(buyCount, sellCount),
    luckKey: luckKey(rarityScore),
    gambleKey: gambleKey(cardCount, cardAvg, cardRange),
    radar: radar,
    dims: dims,
    // 模板选择 key + 原始值，供 dashboard t() 拼速写/称号
    narrativeIdKey: narrativeIdKey,
    spendingKey: spendingKey,
    luckLineKey: luckLineKey,
    mechKey: finalBs > 0 ? 'mechSeed' : 'mechNo',
    tierColor: wt.tier.color,
    dayIncome: dayIncome, daySpend: daySpend, netSpend: netSpend,
  };
}

// CommonJS 兼容：供 node --test 用 require；dashboard <script> 引入时 module 未定义，自动跳过。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePortrait: computePortrait, WEALTH_TIERS: WEALTH_TIERS };
}

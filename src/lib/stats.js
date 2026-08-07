/*
 * stats.js — 掉落统计纯逻辑（context 解析 + summary 聚合）
 * 自包含：不依赖 chrome.* 或其他全局，可被 node --test 单测。
 * 自 dropStats.js 原样搬迁为 ESM。
 */
export const DROP_SINCE_DEFAULT = '2026-07-01 00:00:00';
export const DROP_RARITY_WEIGHT = { UR: 30, SSR: 10, SR: 5, R: 3, N: 1 };
// 称号英文代号 → 中文等级（站点 context 里是英文代号，展示用中文等级）
export const DROP_TITLE_CN = { SPARK: '傳火', TORCHBEARER: '薪火', EMBER: '星火', FLAME: '殘焰', ASHES_KING: '薪王' };

// 解析 context → [{ rarity, filmName, title }, ...]；无法解析返回 []
// 用户确认：中英文共用一套正则，基于两种已知样本（多张列表 / 单张首行）。
export function parseDropContext(context) {
  if (!context || typeof context !== 'string') return [];
  // 多张：每行 "数字. 稀有度《片名》『代号』"
  const reMulti = /^\d+\.\s*([A-Z]+)《([^》]+)》『([^』]+)』/;
  const out = [];
  const lines = context.split(/\n/);
  for (const line of lines) {
    const m = reMulti.exec(line.trim());
    if (m) out.push({ rarity: m[1], filmName: m[2], title: m[3] });
  }
  if (out.length) return out;
  // 单张首行："你獲得了 N《片名》『代号』"（繁/简/英 obtain 兼容）
  const reSingle = /(?:獲得|获得|obtain)[^A-Z]*([A-Z]+)《([^》]+)》『([^』]+)』/;
  const m2 = reSingle.exec(context);
  if (m2) return [{ rarity: m2[1], filmName: m2[2], title: m2[3] }];
  return [];
}

// 'YYYY-MM-DD HH:MM:SS' → ms（本地时区，自包含，不依赖 shared.parseMtTime）
function _dropMt(s) {
  if (!s) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0).getTime();
}
// ms（本地）→ 'YYYY-MM-DD'
function _dropDateStr(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 排序日期数组（'YYYY-MM-DD'）的最长连续链
function _dropMaxStreak(days) {
  if (!days.length) return 0;
  let max = 1, cur = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round((_dropMt(days[i]) - _dropMt(days[i - 1])) / 86400000);
    if (diff === 1) { cur++; if (cur > max) max = cur; }
    else if (diff <= 0) { /* 同日/异常，不重置 */ }
    else cur = 1;
  }
  return max;
}

// 聚合 messages（msg/search 全量）+ feedCards（feed 近期增量，msg 之后）→ summary（每次 merge 后整体重算）
// today: 'YYYY-MM-DD'（参考日，统计窗口终点，默认用 latest 数据日）
export function computeDropSummary(messages, feedCards, since, today) {
  const msgs = Array.isArray(messages) ? messages : [];
  const feeds = Array.isArray(feedCards) ? feedCards : [];
  const rarityCount = { UR: 0, SSR: 0, SR: 0, R: 0, N: 0 };
  const titleCount = {};
  const dayCount = {};
  const dayBreakdown = {}; // 每日 per-rarity 张数：{ day: {UR,SSR,SR,R,N} }
  let totalCards = 0, latest = '';
  // msg/search 消息：parseDropContext 解析 context 文本
  for (const m of msgs) {
    const created = m.createdDate || '';
    if (created > latest) latest = created;
    const cards = parseDropContext(m.context);
    for (const c of cards) {
      totalCards++;
      if (rarityCount[c.rarity] != null) rarityCount[c.rarity]++;
      // 称号按中文等级聚合（代号→中文映射，未知代号原样保留）
      const tn = DROP_TITLE_CN[c.title] || c.title;
      titleCount[tn] = (titleCount[tn] || 0) + 1;
      const day = created.slice(0, 10);
      if (day) {
        dayCount[day] = (dayCount[day] || 0) + 1;
        if (!dayBreakdown[day]) dayBreakdown[day] = { UR: 0, SSR: 0, SR: 0, R: 0, N: 0 };
        if (dayBreakdown[day][c.rarity] != null) dayBreakdown[day][c.rarity]++;
      }
    }
  }
  // feed 结构化卡片（msg 之后的近期增量）
  for (const c of feeds) {
    const created = c.createdDate || '';
    if (created > latest) latest = created;
    const rarity = c.rarity || '';
    totalCards++;
    if (rarityCount[rarity] != null) rarityCount[rarity]++;
    const tn = c.title || '';
    if (tn) titleCount[tn] = (titleCount[tn] || 0) + 1;
    const day = created.slice(0, 10);
    if (day) {
      dayCount[day] = (dayCount[day] || 0) + 1;
      if (!dayBreakdown[day]) dayBreakdown[day] = { UR: 0, SSR: 0, SR: 0, R: 0, N: 0 };
      if (dayBreakdown[day][rarity] != null) dayBreakdown[day][rarity]++;
    }
  }
  const days = Object.keys(dayCount).sort();
  // 参考日：today 优先（含 latest→今天的没掉卡日子），否则退回 latest 数据日
  const refDay = today || latest;
  // 总历时 = since ~ 参考日（含其间没掉卡的日子）
  const totalDays = (refDay && since) ? Math.max(1, Math.floor((_dropMt(refDay) - _dropMt(since)) / 86400000) + 1) : 0;
  // 近7天日均 = 参考日往回 7 个自然日的张数和 / 7（没掉卡的日子算 0）
  let recent7Sum = 0;
  const baseMs = _dropMt(refDay);
  if (Number.isFinite(baseMs)) {
    for (let i = 0; i < 7; i++) recent7Sum += (dayCount[_dropDateStr(baseMs - i * 86400000)] || 0);
  }
  const recent7Avg = recent7Sum / 7;
  // 每日评分 = Σ(稀有度权重 × 张数)：数量都 1-3 张，比数量无区分度，比含金量才有意义
  const dayScore = {};
  for (const d of Object.keys(dayBreakdown)) {
    const b = dayBreakdown[d];
    let sc = 0;
    for (const r of Object.keys(b)) sc += (DROP_RARITY_WEIGHT[r] || 0) * b[r];
    dayScore[d] = sc;
  }
  // Top3 含金量日：评分降序，同分按日期更近优先（柱状图金/银/铜外框）
  const top3Days = Object.keys(dayScore)
    .map((d) => ({ date: d, score: dayScore[d] }))
    .sort((a, b) => b.score - a.score || _dropMt(b.date) - _dropMt(a.date))
    .slice(0, 3);
  let weighted = 0;
  for (const r of Object.keys(rarityCount)) weighted += (rarityCount[r] || 0) * (DROP_RARITY_WEIGHT[r] || 0);
  // dailyFull: rangeStart~rangeEnd 每一天的连续序列（含 0 掉落天），供柱状图渲染
  const dailyFull = [];
  if (refDay && since) {
    const startMs = _dropMt(since), endMs = _dropMt(refDay);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      for (let ms = startMs; ms <= endMs; ms += 86400000) {
        const ds = _dropDateStr(ms);
        dailyFull.push({ date: ds, count: dayCount[ds] || 0, rarity: dayBreakdown[ds] || { UR: 0, SSR: 0, SR: 0, R: 0, N: 0 } });
      }
    }
  }
  return {
    totalCards: totalCards,
    rarityCount: rarityCount,
    titleCount: titleCount,
    totalDays: totalDays,
    dropDays: days.length,
    maxStreak: _dropMaxStreak(days),
    avgPerDay: totalDays ? totalCards / totalDays : 0,
    recent7Avg: recent7Avg,
    top3Days: top3Days,
    dailyFull: dailyFull,
    rarityScore: totalCards ? weighted / totalCards : 0,
    rangeStart: (since || '').slice(0, 10),
    rangeEnd: (refDay || '').slice(0, 10),
  };
}

// 魔力符券开卡记录聚合 → summary（纯逻辑，可单测）
// 只统计 paid===true（开卡数量=成功开卡数）；bonus 取 Number。
export function computeCardLogSummary(logs) {
  const all = Array.isArray(logs) ? logs : [];
  const paid = all.filter((c) => c && c.paid === true);
  const arr = paid.map((c) => Number(c.bonus)).filter((n) => Number.isFinite(n));
  const n = arr.length;
  if (!n) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const sorted = arr.slice().sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const max = sorted[n - 1], min = sorted[0];
  const lucky = avg > 0 ? max / avg : 0;                       // 幸运倍率 = 最高/平均
  const variance = arr.reduce((a, b) => a + (b - avg) * (b - avg), 0) / n;
  const cv = avg > 0 ? Math.sqrt(variance) / avg : 0;          // 变异系数 → 波动等级
  const volatility = cv > 0.8 ? 'high' : (cv > 0.4 ? 'mid' : 'low');
  const buckets = [0, 0, 0, 0];                                 // 0-10K / 10-30K / 30-50K / 50K+
  for (const b of arr) {
    if (b < 10000) buckets[0]++;
    else if (b < 30000) buckets[1]++;
    else if (b < 50000) buckets[2]++;
    else buckets[3]++;
  }
  const series = paid.slice()                                    // 历史开卡曲线：createdDate 升序的 {bonus, date}
    .sort((a, b) => (a.createdDate || '').localeCompare(b.createdDate || ''))
    .map((c) => ({ bonus: Number(c.bonus) || 0, date: c.lastModifiedDate || c.createdDate || '' }));
  return { count: n, sum: sum, avg: avg, median: median, max: max, min: min, lucky: lucky, volatility: volatility, buckets: buckets, series: series };
}

/*
 * marketStats.js — 市场数据纯逻辑（tradeHistory 聚合）
 * 自包含：不依赖 chrome.* 或其他全局，可被 node --test 单测。
 * background.js（importScripts）+ dashboard.html（<script>）双端引入：
 *   background 落盘无筛选 summary；dashboard 本地实时重算筛选态。
 */
// 'YYYY-MM-DD HH:MM:SS' → ms（本地时区）
function _mkMs(s) {
  if (!s) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0).getTime();
}
// ms（本地）→ 'YYYY-MM-DD'
function _dateStr(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 'YYYY-MM-DD HH:MM:SS' → 小时 0-23（无时间返回 -1）
function _hour(s) {
  const m = /(\d{2}):\d{2}:\d{2}$/.exec(s || '');
  return m ? +m[1] : -1;
}
// 升序数组中位数（奇取中，偶取中间两值平均）；空数组返 0。供 _overview/_cardRanks 共用。
function _median(sortedArr) {
  const n = sortedArr.length;
  if (!n) return 0;
  return n % 2 ? sortedArr[(n - 1) / 2] : (sortedArr[n / 2 - 1] + sortedArr[n / 2]) / 2;
}

// 大盘 KPI：买卖卡去重计数、volume、min/max ms、avgPrice/medianPrice、
// feeTotal/feeRate、集中度(top10 占比+HHI)、买卖家重叠(pure/both/total)。
// prices 已升序排好、volume 已算好（主函数顶层累加），避免重复累加（DRY）。
function _overview(subset, prices, volume) {
  // buyers 累加成交额（同时供 uniqueBuyers 计数 + 集中度，DRY，避免重扫）；sellers/cards 仍 {id:1}
  const buyers = {}, sellers = {}, cards = {};
  let minMs = Infinity, maxMs = 0;
  let feeTotal = 0;
  for (let i = 0; i < subset.length; i++) {
    const tr = subset[i];
    const p = Number(tr.price);
    const pv = Number.isFinite(p) ? p : 0;
    if (tr.buyerId != null) {
      const bk = String(tr.buyerId);
      buyers[bk] = (buyers[bk] || 0) + pv;
    }
    if (tr.sellerId != null) sellers[String(tr.sellerId)] = 1;
    if (tr.cardId != null) cards[String(tr.cardId)] = 1;
    const f = Number(tr.fee);
    if (Number.isFinite(f)) feeTotal += f;
    const ms = _mkMs(tr.tradedAt);
    if (Number.isFinite(ms)) {
      if (ms < minMs) minMs = ms;
      if (ms > maxMs) maxMs = ms;
    }
  }
  const n = prices.length;
  const median = _median(prices);
  // 集中度：top10 买家额占比 + HHI（复用 buyers 额 map，无需重扫 subset）
  const bvArr = Object.values(buyers).sort(function (a, b) { return b - a; });
  const bvTotal = bvArr.reduce(function (s, v) { return s + v; }, 0) || 1;
  const top10 = bvArr.slice(0, 10).reduce(function (s, v) { return s + v; }, 0);
  const hhi = bvArr.reduce(function (s, v) { const share = v / bvTotal; return s + share * share; }, 0) * 10000;
  // 买卖家重叠：集合差/交（复用 buyers/sellers 的 key 集）
  const bSet = new Set(Object.keys(buyers));
  const sSet = new Set(Object.keys(sellers));
  let pureBuyer = 0, pureSeller = 0, both = 0;
  bSet.forEach(function (id) { if (sSet.has(id)) both++; else pureBuyer++; });
  sSet.forEach(function (id) { if (!bSet.has(id)) pureSeller++; });
  // total 空输入=0；oDen 仅作占比分母兜底（防除零），不混进对外字段
  const oTotal = new Set([].concat(Array.from(bSet), Array.from(sSet))).size;
  const oDen = oTotal || 1;
  return {
    totalTrades: subset.length,
    uniqueBuyers: Object.keys(buyers).length,
    uniqueSellers: Object.keys(sellers).length,
    totalVolume: volume,
    uniqueCards: Object.keys(cards).length,
    avgPrice: n ? volume / n : 0,
    medianPrice: median,
    rangeStart: Number.isFinite(minMs) ? _dateStr(minMs) : '',
    rangeEnd: Number.isFinite(maxMs) ? _dateStr(maxMs) : '',
    feeTotal: feeTotal,
    feeRate: volume ? feeTotal / volume : 0,
    concentration: { top10Pct: top10 / bvTotal, hhi: hhi },
    overlap: {
      pureBuyer: pureBuyer, pureSeller: pureSeller, both: both, total: oTotal,
      pureBuyerPct: pureBuyer / oDen, pureSellerPct: pureSeller / oDen, bothPct: both / oDen,
    },
  };
}

// 时间走势 + 价格分布 + 趋势：dayMap → daily（date 升序）、hourly[24]；
// prices（升序）→ 分位/标准差/对数直方图；daily → 7 日环比/领涨稀有度。
// byCat（v0.3.1 堆叠柱）：daily 每天 + hourly 每时 各存 byCat{ cat: {count,volume} }，
// cat = provenance==='mech' ? 'MECH' : (rarity||'N')，供 UI 按稀有度+机制卡堆叠分色。
// 补全空白天：rawDaily（有成交日，升序）→ 最早成交日 ~ end 的连续日期序列。
// end = today（若 >= 最早成交日）否则最末成交日；无成交天 count/volume=0、avgPrice forward-fill
// 前一成交日（让均价折线在空白天保持前价而非掉 0）。供柱状图连续渲染（对齐掉落统计 dailyFull）。
function _fillEmptyDays(rawDaily, today) {
  if (!rawDaily.length) return rawDaily;
  const start = rawDaily[0].date;
  const last = rawDaily[rawDaily.length - 1].date;
  const end = (today && today >= start) ? today : last;
  if (end === last) return rawDaily;  // 无 today 或 today ≤ 最末成交日 → 无需补
  const byDate = {};
  for (let i = 0; i < rawDaily.length; i++) byDate[rawDaily[i].date] = rawDaily[i];
  const cur = _mkMs(start), endMs = _mkMs(end);
  if (!Number.isFinite(cur) || !Number.isFinite(endMs)) return rawDaily;
  const out = [];
  let prevAvg = rawDaily[0].avgPrice || 0;
  for (let ms = cur; ms <= endMs; ms += 86400000) {
    const ds = _dateStr(ms);
    if (byDate[ds]) { prevAvg = byDate[ds].avgPrice; out.push(byDate[ds]); }
    else out.push({ date: ds, count: 0, volume: 0, avgPrice: prevAvg, byCat: {} });
  }
  return out;
}

function _timeseries(subset, prices, today) {
  const dayMap = {};
  const hourly = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  const hourlyByCat = []; for (let i = 0; i < 24; i++) hourlyByCat.push({});
  for (let i = 0; i < subset.length; i++) {
    const tr = subset[i];
    const p = Number(tr.price);
    const pv = Number.isFinite(p) ? p : 0;
    const cat = tr.provenance === 'mech' ? 'MECH' : (tr.rarity || 'N');
    const ms = _mkMs(tr.tradedAt);
    if (Number.isFinite(ms)) {
      const ds = _dateStr(ms);
      if (!dayMap[ds]) dayMap[ds] = { count: 0, volume: 0, byCat: {} };
      dayMap[ds].count++;
      if (Number.isFinite(p)) dayMap[ds].volume += p;
      const dc = dayMap[ds].byCat;
      if (!dc[cat]) dc[cat] = { count: 0, volume: 0 };
      dc[cat].count++; dc[cat].volume += pv;
    }
    const h = _hour(tr.tradedAt);
    if (h >= 0 && h < 24) {
      hourly[h]++;
      const hc = hourlyByCat[h];
      if (!hc[cat]) hc[cat] = { count: 0, volume: 0 };
      hc[cat].count++; hc[cat].volume += pv;
    }
  }
  const rawDaily = Object.keys(dayMap).sort().map(function (ds) {
    const d = dayMap[ds];
    return { date: ds, count: d.count, volume: d.volume, avgPrice: d.count ? d.volume / d.count : 0, byCat: d.byCat };
  });
  const daily = _fillEmptyDays(rawDaily, today);  // 补空白天（柱状图连续）；trend 仍用 rawDaily 口径不受干扰
  // 价格分布：分位（Math.min 防越界）+ 总体标准差 + 对数直方图
  const n = prices.length;
  const pct = function (p) { return n ? prices[Math.min(n - 1, Math.floor(p * n))] : 0; };
  const mean = n ? prices.reduce(function (s, v) { return s + v; }, 0) / n : 0;
  const std = n ? Math.sqrt(prices.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / n) : 0;
  const histogram = _priceHistogram(prices);
  // 趋势：daily ≥14 天才算（last7 vs prev7 环比）
  let trend = null;
  if (rawDaily.length >= 14) {
    const last7 = rawDaily.slice(-7), prev7 = rawDaily.slice(-14, -7);
    const sum = function (arr, k) { return arr.reduce(function (s, d) { return s + d[k]; }, 0); };
    const vol7 = sum(last7, 'count'), volPrev7 = sum(prev7, 'count') || 0;
    const price7 = sum(last7, 'volume') / (sum(last7, 'count') || 1);
    const pricePrev7 = sum(prev7, 'volume') / (sum(prev7, 'count') || 1);
    trend = {
      vol7: vol7, volPrev7: volPrev7, price7: price7, pricePrev7: pricePrev7,
      tradeDeltaPct: volPrev7 ? (vol7 - volPrev7) / volPrev7 : 0,
      priceDeltaPct: pricePrev7 ? (price7 - pricePrev7) / pricePrev7 : 0,
      leader: _leaderRarity(subset),
    };
  }
  return {
    daily: daily, hourly: hourly, hourlyByCat: hourlyByCat,
    priceP25: pct(0.25), priceP75: pct(0.75), priceP90: pct(0.9),
    priceStd: std, priceHistogram: histogram, trend: trend,
  };
}

// 价格对数直方图：6 桶（lo= floor(log10 min), hi= ceil(log10 max)），label 由 dashboard 格式化。
function _priceHistogram(prices) {
  if (!prices.length) return [];
  const lo = Math.floor(Math.log10(prices[0] || 1));
  const hi = Math.ceil(Math.log10(prices[prices.length - 1] || 1));
  const buckets = 6, span = Math.max(1, (hi - lo) || 1), step = span / buckets;
  const out = Array.from({ length: buckets }, function (_, i) {
    return { count: 0, volume: 0, lo: Math.round(Math.pow(10, lo + i * step)), hi: Math.round(Math.pow(10, lo + (i + 1) * step)) };
  });
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (!(p > 0)) continue; // 防御：跳过非正价格（log10(p≤0)=NaN→bi=NaN→out[NaN] 崩溃）
    const lg = Math.log10(p || 1);
    let bi = Math.floor((lg - lo) / step);
    if (bi < 0) bi = 0;
    if (bi >= buckets) bi = buckets - 1;
    out[bi].count++;
    out[bi].volume += p;
  }
  return out;
}

// 领涨稀有度：按 rarity 分组，各算近 7 日均价 vs 前 7 日均价的环比，取环比最大者；
// 无前 7 日数据的 rarity 跳过；全部跳过 → ''。基准 now = subset 内最大 ms。
function _leaderRarity(subset) {
  if (!subset.length) return '';
  let now = 0;
  for (let i = 0; i < subset.length; i++) {
    const ms = _mkMs(subset[i].tradedAt);
    if (Number.isFinite(ms) && ms > now) now = ms;
  }
  if (!now) return '';
  const cut7 = now - 7 * 86400000, cut14 = now - 14 * 86400000;
  // 每 rarity 累加 last7/prev7 的额与量
  const rMap = {};
  for (let i = 0; i < subset.length; i++) {
    const tr = subset[i];
    const r = tr.rarity;
    if (!r) continue;
    const ms = _mkMs(tr.tradedAt);
    if (!Number.isFinite(ms)) continue;
    const p = Number(tr.price); const pv = Number.isFinite(p) ? p : 0;
    if (!rMap[r]) rMap[r] = { lastVol: 0, lastCnt: 0, prevVol: 0, prevCnt: 0 };
    if (ms > cut7) { rMap[r].lastVol += pv; rMap[r].lastCnt++; }
    else if (ms > cut14) { rMap[r].prevVol += pv; rMap[r].prevCnt++; }
  }
  let best = '', bestPct = -Infinity;
  Object.keys(rMap).forEach(function (r) {
    const g = rMap[r];
    if (!g.prevCnt || !g.lastCnt) return; // 前 7 或近 7 任一为空→跳过（对称，防 last7 空被误判暴跌）
    const lastAvg = g.lastVol / (g.lastCnt || 1);
    const prevAvg = g.prevVol / g.prevCnt;
    const delta = prevAvg ? (lastAvg - prevAvg) / prevAvg : 0;
    if (delta > bestPct) { bestPct = delta; best = r; }
  });
  return best;
}

// 卡视角排行：topExpensive、cardMap→topHot/topVolume、filmMap→topCirculation
function _cardRanks(subset) {
  const topExpensive = subset.slice().sort(function (a, b) { return (Number(b.price) || 0) - (Number(a.price) || 0); });
  const cardMap = {};
  for (let i = 0; i < subset.length; i++) {
    const tr = subset[i];
    const cid = String(tr.cardId);
    if (cid === 'undefined' || cid === '') continue;
    if (!cardMap[cid]) cardMap[cid] = { cardId: cid, filmId: tr.filmId, filmName: tr.filmName, poster: tr.poster, rarity: tr.rarity, title: tr.title, year: tr.year, trades: 0, volume: 0, times: [] };
    cardMap[cid].trades++;
    const pp = Number(tr.price); if (Number.isFinite(pp)) cardMap[cid].volume += pp;
    const _ms = _mkMs(tr.tradedAt); if (Number.isFinite(_ms)) cardMap[cid].times.push(_ms);
  }
  const cardArr = Object.keys(cardMap).map(function (k) {
    const c = cardMap[k];
    c.avgPrice = c.trades ? c.volume / c.trades : 0;
    // 流动性：日均（trades/跨度天数，单笔 span=1）+ 间隔中位数（单笔=null）
    c.times = c.times.filter(Number.isFinite).sort(function (a, b) { return a - b; });
    const ts = c.times;
    const span = ts.length >= 2 ? Math.max(1, (ts[ts.length - 1] - ts[0]) / 86400000) : 1;
    c.avgPerDay = c.trades / span;
    if (ts.length < 2) c.intervalMedian = null;
    else {
      const gaps = []; for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
      gaps.sort(function (a, b) { return a - b; });
      c.intervalMedian = _median(gaps);
    }
    delete c.times; // 不落盘临时字段
    return c;
  });
  const topVolume = cardArr.slice().sort(function (a, b) { return b.volume - a.volume; });
  const filmMap = {};
  for (let i = 0; i < subset.length; i++) {
    const tr = subset[i];
    const fid = tr.filmId; if (!fid) continue;
    if (!filmMap[fid]) filmMap[fid] = { filmId: fid, filmName: tr.filmName, poster: tr.poster, year: tr.year, _cards: {}, trades: 0, volume: 0 };
    if (tr.cardId != null) filmMap[fid]._cards[String(tr.cardId)] = 1;
    filmMap[fid].trades++;
    const pp = Number(tr.price); if (Number.isFinite(pp)) filmMap[fid].volume += pp;
  }
  const topCirculation = Object.keys(filmMap).map(function (k) {
    const f = filmMap[k];
    return { filmId: f.filmId, filmName: f.filmName, poster: f.poster, year: f.year, uniqueCards: Object.keys(f._cards).length, trades: f.trades, volume: f.volume };
  }).sort(function (a, b) { return b.uniqueCards - a.uniqueCards; });
  // 热门榜按 filmId 归总（而非 cardId）：同一影片的多张卡（如魔力符券每次掉落 cardId 不同）合并为一条，按成交笔数排序
  const topHot = Object.keys(filmMap).map(function (k) {
    const f = filmMap[k];
    return { filmId: f.filmId, filmName: f.filmName, poster: f.poster, year: f.year, uniqueCards: Object.keys(f._cards).length, trades: f.trades, volume: f.volume };
  }).sort(function (a, b) { return b.trades - a.trades; });
  // 稀有度基准矩阵：每个 rarity 的 trades/volume/avgPrice/median（精确中位）
  // 机制卡（provenance==='mech'）不计入稀有度矩阵，归 mechMatrix（与 _timeseries:105 的 cat 分流一致）
  const rMap = {};
  for (let i = 0; i < subset.length; i++) {
    const tr = subset[i];
    if (tr.provenance === 'mech') continue;   // 机制卡不计入稀有度矩阵（归 mechMatrix）
    const r = tr.rarity; if (!r) continue;
    if (!rMap[r]) rMap[r] = [];
    const p = Number(tr.price); if (Number.isFinite(p)) rMap[r].push(p);
  }
  const rarityMatrix = (typeof RARITIES !== 'undefined' ? RARITIES : Object.keys(rMap))
    .filter(function (r) { return rMap[r]; })
    .map(function (r) {
      const ps = rMap[r].slice().sort(function (a, b) { return a - b; });
      const vol = ps.reduce(function (s, v) { return s + v; }, 0);
      const md = _median(ps);
      return { rarity: r, trades: ps.length, volume: vol, avgPrice: ps.length ? vol / ps.length : 0, median: md };
    });
  // 机制卡 3 类别矩阵（filmId 以 'mech:' 开头推导 type；与 rarityMatrix 结构镜像，rarity→type）
  var _MECH_TYPES = ['mana_voucher', 'single_free', 'vip_7d'];
  var mMap = {};
  for (var j = 0; j < subset.length; j++) {
    var tr2 = subset[j];
    if (tr2.provenance !== 'mech') continue;
    var fid = tr2.filmId;
    var mtype = (typeof fid === 'string' && fid.indexOf('mech:') === 0) ? fid.slice(5) : '';
    if (!mtype) continue;
    if (!mMap[mtype]) mMap[mtype] = [];
    var pp = Number(tr2.price); if (Number.isFinite(pp)) mMap[mtype].push(pp);
  }
  var mechMatrix = _MECH_TYPES.filter(function (t) { return mMap[t]; }).map(function (t) {
    var ps2 = mMap[t].slice().sort(function (a, b) { return a - b; });
    var vol2 = ps2.reduce(function (s, v) { return s + v; }, 0);
    return { type: t, trades: ps2.length, volume: vol2, avgPrice: ps2.length ? vol2 / ps2.length : 0, median: _median(ps2) };
  });
  return { topExpensive: topExpensive, topHot: topHot, topVolume: topVolume, topCirculation: topCirculation, rarityMatrix: rarityMatrix, mechMatrix: mechMatrix };
}

// 人视角：buyerMap→buyers、sellerMap→sellers（未排序，dashboard 按榜排）
function _peopleRanks(subset) {
  const buyerMap = {}, sellerMap = {};
  for (let i = 0; i < subset.length; i++) {
    const tr = subset[i];
    const pp = Number(tr.price); const pv = Number.isFinite(pp) ? pp : 0;
    if (tr.buyerId != null) {
      const bid = String(tr.buyerId);
      if (!buyerMap[bid]) buyerMap[bid] = { id: bid, trades: 0, volume: 0 };
      buyerMap[bid].trades++; buyerMap[bid].volume += pv;
    }
    if (tr.sellerId != null) {
      const sid = String(tr.sellerId);
      if (!sellerMap[sid]) sellerMap[sid] = { id: sid, trades: 0, volume: 0 };
      sellerMap[sid].trades++; sellerMap[sid].volume += pv;
    }
  }
  const buyerArr = Object.keys(buyerMap).map(function (k) { const b = buyerMap[k]; b.avgPrice = b.trades ? b.volume / b.trades : 0; return b; });
  const sellerArr = Object.keys(sellerMap).map(function (k) { const s = sellerMap[k]; s.avgPrice = s.trades ? s.volume / s.trades : 0; return s; });
  return { buyers: buyerArr, sellers: sellerArr };
}

// 关系图谱：倒卖识别（同卡 FIFO 配对·毛利·持有天数）。
// 同一 cardId 的成交链按 tradedAt 升序，玩家作为 buyerId 时入队（买入），
// 后来作为 sellerId 时消费自己的队列队首（卖出）= 一次"先买后卖"倒卖。
// FIFO：shift 取队首=最早未配对买入。未平仓（买了没卖）/链断裂（卖了但之前没买）不计；
// 亏本仍计入（毛利率为负）。
function _relations(subset) {
  const byCard = {};
  for (let i = 0; i < subset.length; i++) {
    const tr = subset[i];
    if (tr.cardId == null) continue;
    const cid = String(tr.cardId);
    if (!byCard[cid]) byCard[cid] = [];
    byCard[cid].push(tr);
  }
  const playerStat = {}; // id -> {flips, totalProfit, sumMargin, holdDays[]}
  const ensure = function (id) { return playerStat[id] || (playerStat[id] = { flips: 0, totalProfit: 0, sumMargin: 0, holdDays: [] }); };
  for (const cid in byCard) {
    // 预计算 ms 一次（_mkMs 含正则+Date），后续排序/入队/配对复用，避免重复解析
    const chain = byCard[cid].map(function (tr) { return { tr: tr, ms: _mkMs(tr.tradedAt) }; })
      .sort(function (a, b) {
        // 无效 tradedAt（NaN ms）排末尾，且不入队/不配对，防 NaN 流入 holdDays
        const da = Number.isFinite(a.ms) ? a.ms : Infinity;
        const db = Number.isFinite(b.ms) ? b.ms : Infinity;
        return da - db;
      });
    const queues = {}; // playerId -> [buyEvent,...] 未平仓买入队列（每张卡独立）
    for (let i = 0; i < chain.length; i++) {
      const tr = chain[i].tr;
      const ms = chain[i].ms;
      const buy = tr.buyerId != null ? String(tr.buyerId) : '';
      const sell = tr.sellerId != null ? String(tr.sellerId) : '';
      const price = Number(tr.price);
      // 买入事件入队（该玩家作为买家）；ms 守卫：无效 tradedAt 跳过
      if (buy && Number.isFinite(ms)) { (queues[buy] || (queues[buy] = [])).push({ price: price, ts: ms }); }
      // 卖出事件：消费【卖家】队列队首（FIFO）——卖家当初作为买家时入的队；ms 守卫同上
      if (sell && Number.isFinite(ms) && queues[sell] && queues[sell].length) {
        const buyEv = queues[sell].shift();
        const profit = (Number.isFinite(price) ? price : 0) - (Number.isFinite(buyEv.price) ? buyEv.price : 0);
        const holdDays = (ms - buyEv.ts) / 86400000;
        const st = ensure(sell);
        st.flips++; st.totalProfit += profit;
        if (buyEv.price) st.sumMargin += profit / buyEv.price;
        st.holdDays.push(holdDays);
      }
    }
  }
  const flips = Object.keys(playerStat).map(function (id) {
    const st = playerStat[id];
    const avgHold = st.holdDays.length ? st.holdDays.reduce(function (s, v) { return s + v; }, 0) / st.holdDays.length : 0;
    return { id: id, flips: st.flips, totalProfit: st.totalProfit, avgMargin: st.flips ? st.sumMargin / st.flips : 0, avgHoldDays: avgHold };
  });
  return { flips: flips };
}

// 聚合 tradeHistory → summary。filter=null 不过滤；否则 { rarities:Set, provenances:Set, titles:Set, dateFrom:'YYYY-MM-DD', dateTo:'YYYY-MM-DD' }
// 内部按职责拆 5 子函数：_overview / _timeseries / _cardRanks / _peopleRanks / _relations。
function computeMarketSummary(trades, filter, today) {
  const all = Array.isArray(trades) ? trades : [];
  const subset = filter ? all.filter(function (tr) {
    if (filter.rarities && filter.rarities.size) {
      if (tr.provenance === 'mech') return false;   // 机制卡有稀有度但归「来源」筛选管，不参与稀有度筛选（对齐 _cardRanks 稀有度矩阵口径）
      if (!filter.rarities.has(tr.rarity)) return false;
    }
    if (filter.provenances && filter.provenances.size && !filter.provenances.has(tr.provenance)) return false;
    if (filter.titles && filter.titles.size && !filter.titles.has(tr.title)) return false;
    const ds = _dateStr(_mkMs(tr.tradedAt));
    if (filter.dateFrom && ds < filter.dateFrom) return false;
    if (filter.dateTo && ds > filter.dateTo) return false;
    return true;
  }) : all;
  // prices 升序数组 + volume 提到顶层算好，供 _overview(avgPrice/medianPrice) 使用（_timeseries 后续任务也要用）。
  const prices = [];
  let volume = 0;
  for (let i = 0; i < subset.length; i++) {
    const p = Number(subset[i].price);
    if (Number.isFinite(p)) { volume += p; prices.push(p); }
  }
  prices.sort(function (a, b) { return a - b; });
  return Object.assign({},
    _overview(subset, prices, volume),
    _timeseries(subset, prices, today),
    _cardRanks(subset),
    _peopleRanks(subset),
    _relations(subset)
  );
}

// 从全量提取可选筛选值（不受当前筛选影响，供 chips）
function extractFacets(trades) {
  const all = Array.isArray(trades) ? trades : [];
  const prov = {}, title = {};
  for (let i = 0; i < all.length; i++) {
    const tr = all[i];
    if (tr.provenance) prov[tr.provenance] = 1;
    if (tr.title) title[tr.title] = 1;
  }
  return { provenances: Object.keys(prov).sort(), titles: Object.keys(title).sort() };
}

// 单笔成交方向（由 buyOrderId 决定）：buyOrderId 为 null（买方主动吃卖单）→ 'buy' 买入；
// buyOrderId 有值（卖方主动吃买单，含 sellOrderId null 与两者都有）→ 'sell' 卖出；
// 两者都缺失（null/undefined）→ 'both' 无信息。旧数据缺这俩字段（undefined）自然归 'both'，降级无害。
// 可选 uid：提供时（搜某 uid）按该 uid 在本笔的角色判方向（作买家=buy / 作卖家=sell / 不参与=both），
// 不提供则走 order 逻辑，向后兼容。
function tradeDirection(rec, uid) {
  if (uid) {
    if (rec.buyerId === uid) return 'buy';      // 该 uid 作买家 = 买入
    if (rec.sellerId === uid) return 'sell';    // 该 uid 作卖家 = 卖出
    return 'both';
  }
  const b = rec.buyOrderId, s = rec.sellOrderId;
  if (b == null && s == null) return 'both';    // 都缺失/null → 无信息（含旧数据 undefined）
  return b == null ? 'buy' : 'sell';            // buyOrderId null → 买入；有值 → 卖出
}

// 交易记录查询 tab 的过滤：rarity/provenance/title/日期 + 片名(模糊)/uid(精确) 搜索 + 方向。
// 日期口径与 computeMarketSummary 一致（_dateStr(_mkMs) 转 'YYYY-MM-DD' 再字典序比）。
// hist 已按 tradedAt 降序，过滤后保持原序；调用方自行分页。
function filterTrades(hist, filter, search, dir) {
  // search 为纯数字（uid）时，方向判定相对该 uid 角色（B3）；否则 uid=null 走原 order 逻辑
  var uid = (search && /^\d+$/.test(search)) ? search : null;
  return hist.filter(function (r) {
    if (filter) {
      if (filter.rarities && filter.rarities.size) {
        if (r.provenance === 'mech') return false;   // 机制卡归「来源」筛选管，不参与稀有度筛选（与 computeMarketSummary 一致）
        if (!filter.rarities.has(r.rarity)) return false;
      }
      if (filter.provenances && filter.provenances.size && !filter.provenances.has(r.provenance)) return false;
      if (filter.titles && filter.titles.size && !filter.titles.has(r.title)) return false;
      if (filter.dateFrom || filter.dateTo) {
        const ds = _dateStr(_mkMs(r.tradedAt));
        if (filter.dateFrom && ds < filter.dateFrom) return false;
        if (filter.dateTo && ds > filter.dateTo) return false;
      }
    }
    if (search) {
      if (/^\d+$/.test(search)) {
        if (r.buyerId !== search && r.sellerId !== search) return false;
      } else {
        if (!(r.filmName || '').includes(search)) return false;
      }
    }
    if (dir && dir !== 'both' && tradeDirection(r, uid) !== dir) return false;
    return true;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeMarketSummary: computeMarketSummary, extractFacets: extractFacets, tradeDirection: tradeDirection, filterTrades: filterTrades };
}

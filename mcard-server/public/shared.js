/*
 * shared.js — 跨脚本共享的常量与纯函数（单一来源，各 world 各注入一份副本）
 *
 * 加载方式：
 *   - background.js：importScripts('shared.js')（MV3 service worker 顶层）
 *   - dashboard.html：<script src="shared.js">（在 dashboard.js 之前）
 *   - content.js：manifest content_scripts 的 js 数组把它排在 content.js 前（message 页）
 *
 * 约束：顶层只用 var + function 声明，禁用 let/const/class（历史原因：曾因 detail 页
 * 双注入执行两次而必需；v0.2.5 detail 注入移除后已单次，但约定保留——幂等无害更安全）。
 * var/function 幂等无害，const/let 重复声明会抛 SyntaxError。零顶层副作用。
 */

// 稀有度（展示顺序；仅作集合/默认勾选用，顺序无功能影响）
var RARITIES = ['UR', 'SSR', 'SR', 'R', 'N'];
var RARITY_LABEL = { UR: 'UR', SSR: 'SSR', SR: 'SR', R: 'R', N: 'N' };

// 机制卡子类型（3 张固定卡，按 type 区分）
var MECH_TYPES = [
  { type: 'mana_voucher', label: '魔力符券' },
  { type: 'single_free',  label: '置顶免费符' },
  { type: 'vip_7d',       label: 'VIP七日符' },
];
var MECH_LABEL = { mana_voucher: '魔力符券', single_free: '置顶免费符', vip_7d: 'VIP七日符' };

// 机制卡判定：variant.provenance==='mech' 或 filmId 以 'mech:' 开头。
// 入参可为 item（含 .variant）、variant 对象、或扁平交易记录（provenance/filmId 挂顶层），均兼容。
function isMechCard(x) {
  var v = (x && x.variant) || x || {};
  return v.provenance === 'mech' ||
    (typeof v.filmId === 'string' && v.filmId.indexOf('mech:') === 0);
}

// 机制卡子类型：优先取 type 字段，兜底从 filmId(mech:xxx) 推导
function mechTypeOf(it) {
  if (it && it.type) return it.type;
  var v = (it && (it.variant || it)) || {};
  if (typeof v.filmId === 'string' && v.filmId.indexOf('mech:') === 0) return v.filmId.slice(5);
  return '';
}

// "2026-07-24 19:55:36" → 时间戳（按本地时区）；解析失败返回 NaN（与 Date.getTime() 语义一致）
function parseMtTime(s) {
  if (!s) return NaN;
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  var d = new Date(s);
  return isNaN(d.getTime()) ? NaN : d.getTime();
}

// ============ 站点域名（web 用户选 / api 自动探测）============
var WEB_OPTS = ['kp.m-team.cc', 'zp.m-team.io'];      // 用户选（url 跳转）
var API_OPTS = ['api.m-team.cc', 'api.m-team.io'];    // 自动探测（mtFetch）
function webUrl(webBase, path) { return 'https://' + webBase + path; }

// 详情页 URL：入参可为 variant 对象、item（含 .variant）、或扁平交易记录
function buildDetailUrl(x, webBase) {
  var v = (x && x.variant) || x || {};
  var q = new URLSearchParams({
    filmId: v.filmId || '',
    rarity: v.rarity || '',
    provenance: v.provenance || '',
  });
  return webUrl(webBase || 'kp.m-team.cc', '/cards/market/detail?' + q.toString());
}

// 预算可用额度：usable = min(预算剩余, 账户魔力余额)。background 与 dashboard 共用同一口径，避免漂移。
function computeUsable(st) {
  var budget = (st && st.config && st.config.budget) || { total: 0, spent: 0 };
  var bTotal = Number(budget.total) || 0;
  var spent = Number(budget.spent) || 0;
  var remaining = bTotal - spent;
  var bonus = Number(st && st.profile && st.profile.bonus) || 0;
  var usable = Math.min(remaining, bonus);
  return { bTotal: bTotal, spent: spent, remaining: remaining, bonus: bonus, usable: usable };
}

// 等待条件成立：pred() 返回 truthy 即 resolve(该值)；超时 resolve(null)。
// opts.observe=true（默认）挂 MutationObserver 加速 DOM 条件；数据条件传 false 仅轮询。
// 第一拍立即 check；truthy/超时统一清理（clearInterval/clearTimeout/disconnect），超时再扫一次兜底。
function waitForCond(pred, opts){
  opts = opts || {};
  var timeout = opts.timeout || 10000;
  var poll = opts.poll || 200;
  var useObserver = opts.observe !== false;
  return new Promise(function(resolve){
    var iv, timer, obs, done = false;
    function finish(val){
      if (done) return;
      done = true;
      if (iv) clearInterval(iv);
      if (timer) clearTimeout(timer);
      if (obs) obs.disconnect();
      resolve(val);
    }
    function check(){ var v = pred(); if (v) finish(v); }
    check(); // 第一拍立即
    iv = setInterval(function(){ check(); }, poll);
    timer = setTimeout(function(){ finish(pred() || null); }, timeout); // 超时再扫一次兜底
    if (useObserver && typeof MutationObserver !== 'undefined'){
      try {
        obs = new MutationObserver(function(){ check(); });
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    }
  });
}

// ============ i18n（中/英两态，面板手动切换） ============
// 字典注册表：locales/zh.js / locales/en.js 调用 registerMessages 填充。
// shared.js 会在 detail 页 ISOLATED world 执行两次 → 顶层只用 var/function（幂等重声明无害）。
// 注入页不加载 locales/*.js → __i18nMessages 为空 → t() 降级返回 key（注入页不调 t()，无害）。
var __i18nMessages = { zh: {}, en: {} };
var __i18nLang = 'zh';

function registerMessages(lang, dict) {
  var dst = __i18nMessages[lang];
  if (!dst || !dict) return;
  for (var k in dict) {
    if (Object.prototype.hasOwnProperty.call(dict, k)) dst[k] = dict[k];
  }
}

// 设当前语言；dashboard 端顺带同步 <html lang>（无 document 环境如 SW 则跳过）
function setI18nLang(lang) {
  __i18nLang = (lang === 'en') ? 'en' : 'zh';
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = (__i18nLang === 'en') ? 'en' : 'zh-CN';
  }
}
function getI18nLang() { return __i18nLang; }

// 按浏览器 UI 语言探测：zh* → zh，否则 en
function detectLang() {
  var ui = '';
  try { ui = (chrome && chrome.i18n && chrome.i18n.getUILanguage) ? chrome.i18n.getUILanguage() : ''; } catch (e) {}
  if (!ui && typeof navigator !== 'undefined' && navigator.language) ui = navigator.language;
  if (!ui) ui = 'zh';
  return (String(ui).toLowerCase().indexOf('zh') === 0) ? 'zh' : 'en';
}

// 取文案；当前语言缺 key 回退另一语言，再缺返回 key 本身。{name} 占位插值。
function t(key, params) {
  var dict = __i18nMessages[__i18nLang] || {};
  var s = dict[key];
  if (s == null) s = (__i18nMessages[(__i18nLang === 'zh') ? 'en' : 'zh'] || {})[key];
  if (s == null) return key;
  if (params) {
    s = String(s).replace(/\{(\w+)\}/g, function (_, name) {
      return (params[name] != null) ? String(params[name]) : '';
    });
  }
  return s;
}

// 扫描 root 下 [data-i18n*] 批量替换；仅 dashboard 调用（background 无 DOM）。
// 仅支持纯文本叶子节点（textContent/placeholder/title/aria-label）；含嵌套子元素的文本
// 需把要译的文本包成 <span data-i18n="..."> 再处理（避免清掉兄弟子元素）。不用 innerHTML（XSS）。
function applyI18n(root) {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  root = root || document;
  var sel = '[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label]';
  var nodes = root.querySelectorAll(sel);
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i], key;
    key = el.getAttribute('data-i18n');             if (key) el.textContent = t(key);
    key = el.getAttribute('data-i18n-placeholder'); if (key) el.placeholder = t(key);
    key = el.getAttribute('data-i18n-title');       if (key) el.title = t(key);
    key = el.getAttribute('data-i18n-aria-label');  if (key) el.setAttribute('aria-label', t(key));
  }
}

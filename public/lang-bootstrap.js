/*
 * lang-bootstrap.js — 语言首帧引导（消除首屏中英闪烁）
 *
 * 放 <head> 内、theme-bootstrap.js 之后、dashboard.css 之后，<script src> 同步执行。
 * 独立外部文件因 MV3 CSP 禁内联 script（同 theme-bootstrap.js 理由）。
 *
 * 职责：同步读 localStorage('mcard.lang') → 设 <html lang> + window.__lang。
 * 首次无偏好时按 navigator.language 探测（不写盘；持久化由 dashboard.js 的 initLang 负责）。
 * <html lang> 同时驱动 .lang-label 的 CSS ::after 显示（零闪烁）。
 */
(function () {
  var pref = localStorage.getItem('mcard.lang');
  var lang = pref;
  if (lang !== 'zh' && lang !== 'en') {
    var n = ((navigator.language || 'zh-CN') + '').toLowerCase();
    lang = (n.indexOf('zh') === 0) ? 'zh' : 'en';
  }
  document.documentElement.lang = (lang === 'en') ? 'en' : 'zh-CN';
  window.__lang = lang;
})();

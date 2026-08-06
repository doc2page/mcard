/*
 * theme-bootstrap.js — 主题首帧引导（消除首屏闪烁）
 *
 * 必须在 <body> 渲染前同步执行，所以放在 <head> 内、dashboard.css 之后，
 * 以 <script src="theme-bootstrap.js"> 引入。
 *
 * 为什么是独立外部文件而非 <head> 内联 <script>：
 *   MV3 扩展页面的 CSP 默认 script-src 'self'，禁止内联 script（unsafe-inline /
 *   hash / nonce 均不被 extension_pages 支持来放行 inline）。内联会被拦截不执行。
 *   <script src>（无 async/defer）同样会同步阻塞 body 解析直到脚本执行完，
 *   因此 data-theme 仍能在首帧绘制前设置，零闪烁特性保留。
 *
 * 职责：
 *   1. 同步读 localStorage 主题偏好，解析为 dark/light 设到 <html data-theme>。
 *   2. 暴露 window.__theme（含 pref/mq/resolve）供 dashboard.js 的 initTheme 复用，
 *      避免重复创建 matchMedia。
 *
 * 不注册 prefers-color-scheme 监听 —— 由 dashboard.js 的 initTheme 统一管理，
 * 避免重复注册。
 */
(function () {
  var pref = localStorage.getItem('mcard.theme') || 'light';
  var mq = window.matchMedia('(prefers-color-scheme: light)');
  function resolve(p) {
    return p === 'light' ? 'light' : (p === 'auto' ? (mq.matches ? 'light' : 'dark') : 'dark');
  }
  document.documentElement.dataset.theme = resolve(pref);
  window.__theme = { pref: pref, mq: mq, resolve: resolve };
})();

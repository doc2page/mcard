/*
 * content.js — 运行在 ISOLATED world（扩展环境，能用 chrome.* API）
 *
 * 角色：background 与页面(inject/MAIN)之间的桥梁。
 *   市场主循环已改为 background 通过 mtFetch 直连 api.m-team.cc，本脚本不再驱动采集；
 *   仅保留：掉落统计的 msg 翻页（handleMsgSearch/clickNextPage）+ inject 握手。
 *   （market/list + profile + orderbook 均已改 background mtFetch 直连，不再经 inject 拦截；inject 现仅拦 msg/search。）
 */
(() => {
  // shared.js 由 manifest 排在本脚本前注入（掉落统计的 msg 翻页仅用到其纯函数/常量 subset）

  // 安全转发：扩展重载/卸载或 tab 被关后 chrome.runtime 可能失效，sendMessage 会同步抛
  // "Extension context invalidated"（.catch 接不住同步 throw）；这里转成 rejected promise 交给调用方 .catch。
  const rt = chrome.runtime;
  function safeSend(msg) {
    try { return rt.sendMessage(msg); }
    catch (e) { return Promise.reject(e); }
  }

  let injectReady = false;

  // ---------- 接收 inject 的 postMessage ----------
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'mtm-inject') return;

    if (data.type === 'INJECT_READY') {
      if (!injectReady) {
        injectReady = true;
        console.log('[MTEAM] content: inject ready');
      }
      return;
    }
    if (data.type === 'MSG_SEARCH') {
      handleMsgSearch(data).catch((e) => console.warn('[MTEAM] msg search error', e));
    }
  });

  // 主动 ping inject：无论两者谁先注入，都能拿到 INJECT_READY
  window.postMessage({ source: 'mtm-content', type: 'PING' }, '*');

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ---------- 掉落消息采集：模拟点击"下一页"翻页，inject 被动 hook 每页 ----------
  // 仅在采集 tab（URL 带 ?mtm_drop=1）工作。
  // 站点不允许 content 直接调 /api/msg/search 翻页，改模拟点击 ant 分页器：
  // 点"下一页" → 页面自发请求 → inject hook → 本 handler 收到新页 → 喂给等待中的循环。
  let dropBusy = false;
  let dropSession = null;   // { waitingNext: resolver|null } 翻页循环与 handler 之间的握手
  async function handleMsgSearch(data) {
    if (location.search.indexOf('mtm_drop') === -1) return;     // 非采集 tab：忽略
    const resp = data.response;
    if (!resp || resp.code !== '0' || !resp.data || !Array.isArray(resp.data.data)) return;

    // 翻页循环正在等下一页：把本页喂给它
    if (dropSession && dropSession.waitingNext) {
      const batch = resp.data.data;
      const page = Number(resp.data.pageNumber) || 0;
      const res = dropSession.waitingNext;
      dropSession.waitingNext = null;
      res({ batch: batch, page: page });
      return;
    }
    if (dropBusy || dropSession) return;   // 采集中（非等待态）忽略重复

    // 首次：开始采集会话
    dropBusy = true;
    try {
      let stopDate = '';
      try {
        const cfg = await safeSend({ type: 'DROP_FIRST' });
        stopDate = (cfg && cfg.stopDate) || '';
      } catch (e) { return; }   // background 未就绪：放弃
      const totalPages = Number(resp.data.totalPages) || 1;
      let all = resp.data.data.slice();
      let page = Number(resp.data.pageNumber) || 1;
      dropSession = { waitingNext: null };

      while (page < totalPages) {
        const earliest = earliestCreatedDate(all);
        if (earliest && stopDate && earliest <= stopDate) break;
        // 点击"下一页"；按钮禁用/消失则停
        if (!await clickNextPage()) { console.log('[MTEAM] drop: next btn unavailable, stop'); break; }
        // 等下一次 MSG_SEARCH（inject hook 点击触发的新页）；15s 超时停
        const next = await new Promise((res) => {
          dropSession.waitingNext = res;
          setTimeout(() => { if (dropSession.waitingNext === res) { dropSession.waitingNext = null; res(null); } }, 15000);
        });
        if (!next || !next.batch || !next.batch.length) { console.log('[MTEAM] drop: no next data, stop'); break; }
        all = all.concat(next.batch);
        page = next.page || (page + 1);
        if (all.length > 5000) break;                            // 安全上限，防异常无限翻
      }

      dropSession = null;
      safeSend({ type: 'DROP_DONE', messages: all }).catch(() => {});
    } catch (e) {
      console.warn('[MTEAM] drop session error', e);
      dropSession = null;
    } finally {
      dropBusy = false;
    }
  }
  function earliestCreatedDate(msgs) {
    let min = '';
    for (const m of msgs) if (m && m.createdDate && (!min || m.createdDate < min)) min = m.createdDate;
    return min;
  }
  // 模拟点击 ant-pagination"下一页"；等分页器渲染（最多 8s），禁用/找不到返回 false
  async function clickNextPage() {
    const find = () => document.querySelector('.ant-pagination-next:not(.ant-pagination-disabled) button, .ant-pagination-next:not(.ant-pagination-disabled) a');
    const deadline = Date.now() + 8000;
    let btn = null;
    while (Date.now() < deadline && !(btn = find())) { await sleep(200); }
    if (!btn) return false;
    try { btn.click(); } catch (e) { return false; }
    return true;
  }
})();

# MCard

M-Team 卡牌市场手动工具，自托管 Docker Web 服务。后端 Node 20 + Express + SQLite，前端原生 JavaScript（无框架），通信 `fetch`（dispatch.js 映射 15 type→REST）+ `EventSource`（SSE）。仓库根 = 项目根。

## 运行

```bash
# 容器（推荐）
sudo docker compose up -d --build     # 端口 31414；jaxo 不在 docker 组需 sudo
sudo docker compose logs -f           # 日志
sudo docker compose restart           # 重启
sudo docker compose up -d --build     # 改代码后重建（build 走代理）
sudo docker compose down              # 停止删容器（data 保留）

# 本地开发
npm install && npm start              # better-sqlite3 需 python3/make/g++
npm test                              # node --test tests/**/*.test.js
```

容器名 `mcard`，restart `unless-stopped`（宿主重启自启）。数据 `data/mcard.db`（API key + 缓存，删容器不丢，db 文件 gitignore）。

## 关键约定（勿违反）

- **鉴权**：`AUTH_PASSWORD` env（设了启用无状态 HMAC token 登录，全站 `requireAuth` 中间件 + 独立 `login.html`，cookie 30 天；密码走 `.env` gitignore 不入库；不设=完全开放）。与 API key 独立（API key 管 M-TEAM 访问）。
- **代理**：build 走代理（`docker-compose.yml` 的 `build.args` `127.0.0.1:7890` + `network: host`），运行时 `environment` **无代理变量**，容器直连 M-TEAM。
- **手动触发**：所有采集/交易由页面手动点击触发，无后台轮询（反风控）。冷却：market 8s / trades·orders·marketData 8s / cardLog·inventory 30s + `isRoundRunning` 锁 + randSleep 400-900ms。
- **运行锁勿跨重启持久化**：`isRoundRunning` 是进程内瞬时态——启动时 `server.js` 的 `createStoreState` 强制重置为 false、`round=null`；`collector.js` 的 `startRound` 用 try/finally 兜底 `onRoundDone`（解锁）。否则一次采集崩溃会让锁卡 true 进 db，重启后 `triggerRefreshRound` 永远走 `queued` 分支、市场采集再也不触发（症状：市场卡片停旧快照，但行情/持有/挂单/掉落照常刷新）。
- **since 两套别混**：掉落统计 since = 官方最新 25 条数据的最早时间（动态）；**用户画像消费维度**用固定 7/1（`PORTRAIT_SPAN_SINCE` 常量，app.js 顶部；前端没加载 dropStats.js，不能直接用其 `DROP_SINCE_DEFAULT`）。
- **掉落统计双源 + 手动导入**：`dropStats.messages`（用户粘贴 message search 响应手动导入的全量历史）+ `feedCards`（feed 接口最新 25 条增量），`computeDropSummary(messages, feedCards, since, today)` 双源聚合。导入入口 `POST /api/drop-import`（dispatch `IMPORT_DROPS`），hero CTA 仅在 `rangeStart ≠ 2026-07-01`（`DROP_FULL_SINCE`，数据未补全）时显示。**双源勿重叠**：`feedCards` 只存 `createdDate > lastMsgDate`（messages 未覆盖的增量），否则与 messages 时间区间重叠会被聚合各算一遍导致重复（mergeDropFeed / importDropMessages / createStoreState 三处均维护此不变量）。
- **掉落 dailyFull 日界**：`computeDropSummary`（stats.js）算 dailyFull / totalDays 的起止点必须截到日界 `slice(0,10)`——`since` 带时分（最早掉卡 `HH:MM:SS`）会让日循环每天偏移，`endMs`（当天 00:00）把当天柱子裁掉。
- **设置存后端**：lockedCards 在 config；仅 theme/privacy 留前端 localStorage。
- **不主动 Playwright 验证**：改完 rebuild + restart 后直接交用户验证，别主动开 Playwright 截图/测量。

## 移动端（@media ≤768px，全在 app.css）

抽屉导航（hamburger + off-canvas sidebar，z-index 200 / 遮罩 150）；统计卡片默认折叠（交易/挂单/持有，`.stats-fold-head`）；市场/交易/挂单隐藏价格单位（持有保留）；`.main padding-bottom: calc(60px + env(safe-area-inset-bottom))`；`.main-toolbar z-index:20`（高于锁卡遮罩 5，低于抽屉 150）；`.modal max-width: calc(100vw-16px)` 防批量模态溢出。

踩坑要点：`.main` 要显式 `overflow-x:hidden`（`overflow-y:auto` 会把另一向的 visible 强制成 auto，导致横向滚动）；`.main-toolbar` 移动端去负 margin（否则撑出 6px 横滚）；`.md-two-col` 用 `minmax(0,1fr)`（否则 grid auto 列被内容 min-content 撑出）。

## 关键文件

- 后端 `src/`：`server.js`（挂 auth 中间件）、`lib/auth.js`（HMAC token + `requireAuth` + 白名单）、`routes/auth.js`（/login + /api/login + /api/logout）、`lib/collector.js`（采集 + 冷却；`ensureCardLogs` 在 `ensureDropStats` 内调用）、`state.js`
- 前端 `public/`：`app.js`（主逻辑 + `PORTRAIT_SPAN_SINCE` + SSE `applyPatch` 增量 + 移动端折叠头注入 + `provColorClass`）、`app.css`（移动端 @media）、`login.html`（独立登录页，logo.png + 主题色按钮 + 语言自适应）、`dispatch.js`（15 type→REST）、`portrait.js`（画像趋势四档）、`marketStats.js`（extractFacets/filterTrades）、`dropStats.js`（后端共用，前端未加载）
- 部署：`docker-compose.yml`、`Dockerfile`、`.env`(gitignore)、`README.md`/`README.en.md`

## 鉴权链路

`AUTH_PASSWORD` env → `POST /api/login` 验密码（timingSafeEqual）→ 签 HMAC-SHA256 token（payload=过期时间，不落库）→ `Set-Cookie: mcard_token`（httpOnly, SameSite=Lax, 30天）→ `requireAuth` 验 cookie（白名单：`/login` `/api/login` `/api/logout` `/login.html` `/logo.png` `/health`，未登录页面 302、API/SSE 401）。

## 文档

`README.md`（中）+ `README.en.md`（英），互相链接。仓库 2026-08-07 整理：原 `mcard-server/` 子目录移到根（52 文件 rename 保历史），`mcard-main`/`docs`/截图已删。

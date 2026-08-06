# MCard 容器化 + PWA 设计

- 日期：2026-08-06
- 来源项目：`mcard-main/`（M-Team 卡牌市场手动工具，Chrome MV3 扩展，v0.5.5）
- 目标产出：一个 Docker 容器化的 Web 应用（含 PWA），可在手机/桌面浏览器使用

## 1. 背景与目标

现有 `mcard-main/` 是一个 Chrome MV3 扩展，依附浏览器运行。本设计将其重构为一个独立的 Docker 容器 Web 应用，并增加移动端支持与 PWA 能力。

**重构的底层依据**：扩展与 M-Team 的通信分两条链路——

- **mtFetch 直连**（覆盖 90%+ 功能）：`background.js:1098` 仅用 `x-api-key` header 调 `api.m-team.cc`，代码注释明确「无需页面签名 `_sgin`」。不依赖 cookie、不依赖浏览器会话。**可在服务端运行。**
- **inject 拦截 msg/search**（仅掉落统计全量兜底）：注入 M-Team 官方页劫持页面 fetch，强依赖浏览器登录态。

因此：去掉 msg/search 全量兜底后，浏览器依赖彻底清零，可做成纯后端 + Web 前端。

## 2. 范围与非目标

### 范围
- Node.js 后端：复用 `background.js` 的采集/交易/统计逻辑，剥离 `chrome.*`，套上 Express + SSE
- Web 前端：复用 `dashboard.js`（原生 JS），通信层从 `chrome.runtime` 换为 `fetch + EventSource`
- SQLite 持久化（替代 `chrome.storage`）
- PWA：可安装 + 移动端响应式 + App Shell 秒开
- Docker 单容器部署

### 非目标（明确排除）
- ❌ 多用户 / 账号系统 / 数据隔离（单用户自用）
- ❌ 后台定时采集 / 轮询 / 推送通知（保持纯手动触发，规避风控）
- ❌ msg/search 全量掉落统计（仅保留 feed 增量，最近 25 条）
- ❌ 离线数据缓存 / 离线优先（在线使用，断网仅提示）
- ❌ 前端框架重写（保持原生 JS，仅改通信层）

## 3. 已确认的需求决策

| 维度 | 决定 | 理由 |
|---|---|---|
| 使用规模 | 单用户自用，无登录 | YAGNI；最简架构 |
| x-api-key 配置 | **web 设置**（首次 `POST /api/config` 存 SQLite） | 手机端设置方便；失效可在 web 重设 |
| PWA 能力 | 可安装 + 移动端响应式 + App Shell | 覆盖 90% 移动需求，最务实 |
| 移动端导航 | **底部 tab 栏**（非抽屉式） | 用户指定 |
| 采集模式 | 纯手动触发，无后台轮询 | 忠于原设计，最低风控风险 |
| 掉落统计 | 仅 `/pt-card/feed` 增量 | 去掉 msg/search 全量；牺牲历史回填 |
| 前端策略 | 保持原生 JS，仅改通信层 | 最大化复用 5000 行成熟代码，风险最低 |
| 后端 | Node.js + Express + SQLite | 与 background.js 同构；单文件存储 |
| 实时刷新 | SSE（`EventSource`） | 单向推送够用，比 WebSocket 简单 |
| 部署 | 单容器 all-in-one（Node 托管 PWA 静态资源） | 一个镜像、一个端口 |

## 4. 架构总览

```
┌──────────────────────────────────────────────────┐
│              Docker 容器（单镜像 / 单端口）          │
│                                                   │
│   浏览器（手机 / 桌面）—— PWA                       │
│   ┌────────────────────────────────────────────┐  │
│   │  public/: app.js(原生) + manifest + sw.js  │  │
│   └───────────┬────────────────────────────────┘  │
│         fetch │ POST /api/collect | /api/trade      │
│               │ GET  /api/state                     │
│          SSE  │ /events（状态推送）                  │
│               ▼                                    │
│   ┌────────────────────────────────────────────┐  │
│   │  Node.js + Express                         │  │
│   │  routes/api.js · routes/sse.js             │  │
│   │  collector · trader · stats · state · store│  │
│   └───────────┬────────────────────────────────┘  │
│               │ mtFetch（x-api-key，人类化间隔）     │
│               ▼                                    │
│   ┌────────────────────────────────────────────┐  │
│   │  SQLite (data/mcard.db) ← volume 持久化挂载 │  │
│   └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
                 │ HTTPS
                 ▼  api.m-team.cc  /  api.m-team.io
```

**核心思路**：`background.js` 的采集/合并/统计逻辑是纯 JS，原样搬进 Node；剥离 `chrome.*`、套上 Express + SSE；前端 `dashboard.js` 原样保留，只把数据来源从 `chrome.runtime` 换成 `fetch + EventSource`。

## 5. 项目结构

```
mcard-server/
├── Dockerfile
├── package.json
├── src/
│   ├── server.js            # Express 入口（托管 public/ + API + SSE）
│   ├── state.js             # 内存 state + 订阅广播（替代 background 全局 state + onChanged）
│   ├── lib/
│   │   ├── mteam.js         # mtFetch 直连（从 background.js 剥离，去 chrome.*）
│   │   ├── collector.js     # 采集：market/profile/trades/orders/inventory/feed
│   │   ├── trader.js        # 买卖撤
│   │   └── stats.js         # dropStats + marketStats + portrait（纯逻辑，原样复用）
│   ├── store.js             # SQLite 持久化（替代 chrome.storage）
│   └── routes/
│       ├── api.js           # REST：collect / trade / state / config
│       └── sse.js           # SSE 状态推送
├── public/                  # PWA 前端
│   ├── index.html           # ← dashboard.html 改造
│   ├── app.css              # ← dashboard.css + 新增移动端 @media
│   ├── app.js               # ← dashboard.js（chrome.* → fetch/SSE）
│   ├── shared.js / theme-bootstrap.js / lang-bootstrap.js / locales/  # 原样
│   ├── manifest.webmanifest # PWA 清单
│   └── sw.js                # App Shell 缓存
└── data/                    # SQLite 卷挂载点
```

## 6. 模块职责

每个模块「做什么 / 怎么用 / 依赖什么」：

- **`server.js`**：Express 入口。托管 `public/` 静态资源，挂载 `/api` 与 `/events` 路由。依赖：routes、store 初始化。
- **`state.js`**：持有内存态（market/orders/trades/inventory/profile/bonus/dropStats 等，结构对齐 background 的全局 `state` 对象）；提供 `getState()`、`update(patch)`、`subscribe(cb)`。`update` 后广播给 SSE 订阅者。替代 `chrome.storage` + `onChanged`。
- **`lib/mteam.js`**：`mtFetch(path, body)`，从 `background.js:1075-1120` 剥离。保留：`x-api-key` header、`.cc`/`.io` 双 base 自动切换、401 抛 `API_KEY_INVALID`、人类化随机间隔。依赖：配置中的 api-key/apiBase。
- **`lib/collector.js`**：采集逻辑（`background.js` 的 refresh/ensure/merge 系列）。触发式调用 mtFetch，结果写 store + 更新 state。依赖：mteam、store、state。
- **`lib/trader.js`**：买卖撤（`background.js:405-535`）。依赖：mteam、store、state。
- **`lib/stats.js`**：`dropStats.js` + `marketStats.js` + `portrait.js` 原样合并（已是纯函数，末尾 `module.exports` 兼容）。无外部依赖，可单测。
- **`store.js`**：SQLite 持久化（better-sqlite3）。表：`kv`（config：api-key/apiBase/webBase 等）、`state`（持久化最近一次内存态快照，重启恢复）、各业务表（market/orders/trades/inventory/drops）。提供 get/set/merge 接口。依赖：data/mcard.db。
- **`routes/api.js`**：REST 端点（见第 8 节）。
- **`routes/sse.js`**：`GET /events`，`Content-Type: text/event-stream`，订阅 `state` 广播，推送 JSON patch。

## 7. 数据流（手动采集完整链路）

1. 手机点「刷新」→ `app.js` 发 `POST /api/collect {type:'market'}`
2. Express → `collector.refreshMarket()` 串行 `mtFetch` 各稀有度（**保留人类化随机间隔 + .cc/.io 自动切换**）+ profile + bonus
3. 每批结果写 SQLite（`store.merge*`）+ 更新 `state.js` 内存
4. state 变更 → SSE 广播给所有连接的客户端
5. `app.js` 收到 SSE → 复用原 `renderLive()` 重渲染

买卖撤同理：`POST /api/trade {action:'buy|sell|cancel', ...}` → `trader` → 更新 state → SSE。

## 8. API 设计

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/state` | 取完整内存态（首屏初始化，替代 `GET_STATE`） |
| POST | `/api/collect` | 触发采集 `{type: market\|trades\|orders\|inventory\|drops\|profile\|marketStats}` |
| POST | `/api/trade` | 交易 `{action: buy\|sell\|cancel, ...}` |
| GET | `/api/config` | 查询是否已配置 api-key（不返回明文） |
| POST | `/api/config` | 设置/更新 api-key + 站点（.cc/.io），经 profile 验证有效后落库 |
| GET | `/events` | SSE 状态推送（state patch + error 事件） |

## 9. `chrome.*` → 容器化 替换映射表

| 扩展机制 | 容器化替换 |
|---|---|
| `chrome.storage.local` get/set | `store.js` → SQLite |
| `chrome.runtime.sendMessage(GET_STATE)` | `GET /api/state` |
| `chrome.runtime.sendMessage(REFRESH/BUY/…)` | `POST /api/collect`、`/api/trade` |
| `chrome.storage.onChanged` | `EventSource('/events')` |
| background 全局 `state` 对象 | `state.js` 内存 state + 广播 |
| `chrome.tabs.create(详情页 url)` | `window.open(url)` |
| `chrome.action` 图标点击 | 移除（PWA 直接打开） |
| `inject.js` + `content.js`（msg/search） | **删除**（掉落仅 feed） |
| `manifest` background/content_scripts | Dockerfile + Express |

## 10. PWA 设计

- **`manifest.webmanifest`**：`display:standalone`、`name/short_name`、`theme_color/background_color`、多尺寸图标（复用 `logo.png`，至少 192/512）、`start_url:/`、`orientation:any`
- **`sw.js`**：
  - `install`：预缓存 App Shell（`/`、`app.css`、`app.js`、`shared.js`、`theme-bootstrap.js`、`lang-bootstrap.js`、`locales/*`、`logo.png`）
  - `fetch`：**网络优先**；App Shell 资源离线时回退缓存；**市场 API 数据不缓存**（在线使用）
  - `activate`：清理旧缓存
- **字体**：在线 Google Fonts（Bricolage Grotesque / Sora / JetBrains Mono）；SW 不缓存字体 → 离线降级为系统字体（可接受，PWA 选择在线使用）

## 11. 移动端响应式

现有 `dashboard.css` 为桌面优先，**0 个 `@media` 查询**。新增断点 `@media (max-width: 768px)`：

- **导航**：左侧栏 `.sidebar` 在移动端隐藏，改为**底部固定 tab 栏**（图标 + 文字，项与原扩展侧栏各 view 入口一一对应），触摸目标 ≥ 44px
- **顶栏**：`.topbar` 折叠（隐藏副标题、预算条收进抽屉或简化）
- **卡片网格**：桌面 4 列 → 平板 2 列 → 手机 1 列
- **宽表格**（交易记录/挂单）：横向滚动 + 首列粘性
- **模态框**：移动端改为底部弹层（bottom sheet）而非居中遮罩

> 桌面端（`>768px`）保持现有侧栏布局不变。

## 12. 错误处理与反风控（全部保留原逻辑）

- `mtFetch` 401 → 抛 `API_KEY_INVALID` → SSE 推 `error` 事件 → 前端弹令牌设置模态
- `.cc` 网络失败 → 自动切 `.io`（`background.js:1109-1118` 逻辑保留）
- **人类化随机请求间隔**（关键反风控，原样保留）
- 纯手动触发、无轮询（已定）
- api-key 经 `/api/member/profile` 验证有效后才落库（沿用原验证逻辑）

## 13. 测试策略

- **纯逻辑层**：`dropStats.js / marketStats.js / portrait.js` 已是纯函数 + `node --test` 兼容（`dropStats.js` 末尾已有 `module.exports`）→ **直接单测，零改造**
- **`collector` / `trader`**：注入 mock fetch（模拟 M-Team API 响应 + 401 + 双 base 切换）测试
- **`store.js`**：临时 SQLite 文件测试 get/set/merge/重启恢复
- **`state.js`**：测试 update → 订阅回调触发
- **SSE**：测试 state 变更 → 事件推送
- **统计回归**：用扩展实际采到的样本数据（context 文本、feed 卡片）做黄金样本断言

## 14. 配置与安全

- **配置**：`x-api-key` + 站点（.cc/.io）经 web 设置（`POST /api/config`），存 SQLite `kv` 表，经 profile 验证后落库
- **持久化**：`data/mcard.db` 通过 Docker volume 挂载，容器重建不丢数据；内存态定期快照写入 SQLite，重启恢复
- ⚠️ **安全提示**：单用户无登录 = 任何能访问该端口的人都能用你的 key 操作买卖。**强烈建议**二选一：
  1. `bind 127.0.0.1` + Tailscale / VPN（推荐，零额外认证代码）
  2. 前置 Caddy / nginx 反向代理 + HTTP 基础认证
  - 局域网自用风险较低；公网裸奔不可接受
- api-key 明文存本地 SQLite（单用户自用，容器内文件），不上日志、不返回明文给前端

## 15. 迁移工作量与风险

**工作量评估**：中等偏大重构（非简单打包）。主要工作：
- 剥离 `background.js` 的 `chrome.*`、拆分到 `lib/` 各模块（大头）
- `dashboard.js` 通信层改造（`chrome.runtime.sendMessage` / `chrome.storage` → `fetch` / `EventSource`）
- SQLite 持久化层新建
- PWA 三件套（manifest/sw/图标）+ 移动端 `@media`
- Dockerfile + volume

**风险**：
- `dashboard.js`（5000 行）通信层散落多处，改造需细致，遗漏会导致视图不刷新
- M-Team API 若变更风控策略，人类化间隔逻辑需同步调整（与原扩展同等风险）
- feed 仅 25 条增量，掉落统计历史残缺（已知取舍）

**降低风险**：先迁移纯逻辑层（stats）并跑通单测，再迁移采集/交易，最后做前端通信层与 PWA，分阶段验证。

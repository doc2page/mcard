# MCard 容器化 Plan 3：PWA + Docker 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 给 `mcard-server` 加 PWA 三件套（可安装 + App Shell 秒开）和 Dockerfile（容器化收尾）。完成后「容器化 + 移动端 PWA」全部交付。

**Architecture:** `public/` 加 `manifest.webmanifest`（可安装、standalone、图标复用 logo.png 512×512 声明 192/512）+ `sw.js`（install 预缓存 App Shell、fetch 网络优先离线回退、API/SSE 不缓存）。`index.html` 引用 manifest + 注册 SW。`mcard-server/Dockerfile` 基于 `node:20-slim` + python3/make/g++（编译 better-sqlite3），`npm ci --omit=dev`，`HOST=0.0.0.0`，volume `/app/data`。

**Tech Stack:** PWA（Web App Manifest + Service Worker）、Docker（node:20-slim）。

---

## 文件结构（Plan 3 产出）

```
mcard-server/
├── Dockerfile                  # 新建
├── .dockerignore               # 新建
└── public/
    ├── manifest.webmanifest    # 新建：PWA 清单
    ├── sw.js                   # 新建：service worker（App Shell 缓存）
    └── index.html              # Modify：加 manifest link + theme-color + SW 注册
```

---

## Task 1: PWA manifest + index.html 引用

**Files:**
- Create: `mcard-server/public/manifest.webmanifest`
- Modify: `mcard-server/public/index.html`（`<head>` 加 manifest link + theme-color + apple-touch-icon）

- [ ] **Step 1: 写 `manifest.webmanifest`**

```json
{
  "name": "MCard · M-Team 卡牌市场工具",
  "short_name": "MCard",
  "description": "M-Team 卡牌市场手动工具",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#0a0c10",
  "theme_color": "#f5a623",
  "icons": [
    { "src": "logo.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "logo.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "logo.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```
（logo.png 实际 512×512；声明 192 entry 浏览器会缩放显示，满足 PWA 安装的 192+512 要求。theme_color #f5a623 / background_color #0a0c10 取自 dashboard.css 的 accent/深底变量。）

- [ ] **Step 2: index.html `<head>` 加 PWA 标签**

在 `<title>MCard</title>` 之后加：
```html
  <link rel="manifest" href="manifest.webmanifest" />
  <meta name="theme-color" content="#f5a623" />
  <link rel="apple-touch-icon" href="logo.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

- [ ] **Step 3: 验证 manifest 可访问**

```bash
cd /home/jaxo/workspace/mcard/mcard-server && PORT=3950 node src/server.js &
sleep 1
curl -s http://127.0.0.1:3950/manifest.webmanifest | head -3   # 应返回 JSON 开头
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3950/logo.png  # 200
kill %1
```

- [ ] **Step 4: Commit**

```bash
git -C /home/jaxo/workspace/mcard add mcard-server && git -C /home/jaxo/workspace/mcard commit -m "feat: PWA manifest + index.html 引用"
```

---

## Task 2: service worker（App Shell 缓存 + 注册）

**Files:**
- Create: `mcard-server/public/sw.js`
- Modify: `mcard-server/public/index.html`（注册 SW）

- [ ] **Step 1: 写 `public/sw.js`**

```js
// sw.js — App Shell 缓存（在线使用；市场 API/SSE 不缓存）
const CACHE = 'mcard-shell-v1';
const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/dispatch.js',
  '/shared.js',
  '/theme-bootstrap.js',
  '/lang-bootstrap.js',
  '/dropStats.js',
  '/marketStats.js',
  '/portrait.js',
  '/logo.png',
  '/manifest.webmanifest',
  '/locales/zh.js',
  '/locales/en.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API + SSE：不缓存（在线使用，市场数据始终走网络）
  if (url.pathname.startsWith('/api/') || url.pathname === '/events') return;
  // App Shell：网络优先，离线回退缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || new Response('offline', { status: 503 })))
  );
});
```

- [ ] **Step 2: index.html 注册 SW**

在 `</body>` 前、其它 `<script>` 之前加：
```html
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('[mcard] SW register failed', e); });
    });
  }
</script>
```

- [ ] **Step 3: 验证（Playwright）**

启动后端 `PORT=3951 node src/server.js &`，用 Playwright MCP：
- `browser_navigate` http://127.0.0.1:3951/
- `browser_evaluate`：`navigator.serviceWorker.getRegistration().then(r => ({registered: !!r, scope: r && r.scope}))` —— 应 `{registered: true, scope: 'http://127.0.0.1:3951/'}`
- `browser_network_requests` static —— 应见 `sw.js` 加载
- （可选）`browser_console_messages` 无 SW 报错

kill 后端。

- [ ] **Step 4: Commit**

```bash
git -C /home/jaxo/workspace/mcard add mcard-server && git -C /home/jaxo/workspace/mcard commit -m "feat: service worker（App Shell 缓存 + 注册）"
```

---

## Task 3: Dockerfile + .dockerignore + docker build/run 验证

**Files:**
- Create: `mcard-server/Dockerfile`
- Create: `mcard-server/.dockerignore`

- [ ] **Step 1: 写 `mcard-server/Dockerfile`**

```dockerfile
# MCard 后端容器（Node 20 + better-sqlite3 编译）
FROM node:20-slim

# better-sqlite3 是 native 模块，编译需 python3/make/g++
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用 docker 层缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制源码 + 前端
COPY src ./src
COPY public ./public
RUN mkdir -p data

# 容器内绑所有接口（安全靠宿主网络/反代/Tailscale；见 spec 第 14 节）
ENV HOST=0.0.0.0
ENV PORT=3000

VOLUME /app/data
EXPOSE 3000

CMD ["node", "src/server.js"]
```

- [ ] **Step 2: 写 `mcard-server/.dockerignore`**

```
node_modules
data/*.db
data/*.db-shm
data/*.db-wal
.git
tests
.gitignore
```

- [ ] **Step 3: docker build**

```bash
cd /home/jaxo/workspace/mcard/mcard-server && docker build -t mcard-server:dev .
```
Expected：build 成功（首次会下载 node:20-slim + apt-get + npm ci 编译 better-sqlite3，约 2-5 分钟）。

- [ ] **Step 4: docker run + curl 验证**

```bash
docker run -d --name mcard-smoke -p 3001:3000 mcard-server:dev
sleep 2
curl -s http://127.0.0.1:3001/health                              # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/    # 200 (index.html)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/manifest.webmanifest  # 200
curl -s http://127.0.0.1:3001/api/state | head -c 80              # {"config":...}
docker stop mcard-smoke && docker rm mcard-smoke
```
Expected：/health→`{"ok":true}`；/、/manifest.webmanifest→200；/api/state→JSON。

- [ ] **Step 5: Commit**

```bash
git -C /home/jaxo/workspace/mcard add mcard-server && git -C /home/jaxo/workspace/mcard commit -m "feat: Dockerfile + .dockerignore（容器化收尾，Plan 3 完成）"
```

---

## Plan 3 完成标准

- [ ] `manifest.webmanifest` 可访问，index.html 引用 manifest + theme-color + apple-touch-icon
- [ ] `sw.js` 注册成功（Playwright 验证 `navigator.serviceWorker.getRegistration()` 非 null）
- [ ] App Shell 资源在 SW 缓存中；API/SSE 不缓存
- [ ] `docker build` 成功；`docker run` 后 curl `/health`/`/`/`/manifest.webmanifest`/`/api/state` 全部正常
- [ ] 容器 `HOST=0.0.0.0` 绑定，volume `/app/data` 持久化

**整体交付**：Plan 1（后端）+ Plan 2（前端+移动端）+ Plan 3（PWA+Docker）= 一个可 `docker run` 的移动端 PWA 卡牌工具。

---

## 自审（writing-plans self-review）

**1. Spec 覆盖**：spec 第 10 节（PWA manifest/sw/App Shell/字体降级）由 T1+T2 覆盖；spec 第 14 节部署/安全（Dockerfile、HOST=0.0.0.0、volume）由 T3 覆盖。✅
**2. 占位符扫描**：manifest/sw.js/Dockerfile 全部完整代码，无 TBD。✅
**3. 一致性**：HOST env 与 Plan 1 server.js 加固（`process.env.HOST || '127.0.0.1'`）衔接——Dockerfile 设 HOST=0.0.0.0 让容器绑所有接口，宿主端口映射；本地开发仍默认 127.0.0.1。manifest theme_color 与 dashboard.css accent 一致。✅

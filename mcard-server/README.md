# MCard Server

> M-TEAM 卡片市场助手 · 自托管 Web 服务（移动端自适应）
>
> [English](README.en.md) · 中文

原 Chrome 扩展重构为 Docker 化的 Web 服务，单用户自用。后端 Node.js + Express + SQLite，前端原生 JavaScript（无框架），`docker compose` 一键启动，手机和电脑浏览器都能用。

## 功能

- 💳 **持有卡片** —— 查看持有的卡牌，可手动锁定（锁定后不会被交易处理）
- 📊 **市场行情** —— 手动采集市场挂牌、价格、稀有度分布
- 🛒 **交易** —— 买入 / 卖出 / 撤单（内置安全门与预算池控制）
- 📈 **市场数据** —— 量价叠加 / 价格分布 / 小时分布走势图，支持时间窗切换
- 📉 **掉落统计** —— 基于 Feed 的增量统计（官方接口仅返回最新 25 条，起始时间随实际数据而定）
- 🎟️ **魔力符券记录** —— 开卡收益 / 分布 / 幸运倍率（基于 credit/logs）
- 🔖 **订单簿** —— 按卡查询在售挂单
- 📱 **移动端自适应** —— 抽屉式导航、统计卡片可折叠，手机 / 平板 / 桌面通用
- 🔑 **API Key 经页面设置** —— 存储在后端 SQLite，不落浏览器

## 快速开始

在 `mcard-server` 目录下：

```bash
docker compose up -d --build
```

浏览器打开 **http://localhost:31414**，首次访问在页面输入你的 M-TEAM API Key 即可（会自动校验并触发一次全量采集）。

> **移动端**：手机连同一局域网 Wi-Fi，访问 **http://<电脑局域网IP>:31414**（如 `http://192.168.1.10:31414`）。

## 配置

所有配置都在 `docker-compose.yml` 里：

| 项目 | 默认值 | 说明 |
| --- | --- | --- |
| 端口 | `31414:31414` | 改左侧即可换端口，如 `8080:31414` |
| 数据卷 | `./data:/app/data` | SQLite 数据库（API Key + 缓存），备份整个 `data/` 目录即可 |
| 重启策略 | `unless-stopped` | 崩溃自动重启，手动停止则不重启 |
| 访问密码 | `AUTH_PASSWORD=""` | 留空=不鉴权；填密码则访问需登录（见下方「访问鉴权」）|

数据持久化在 `./data/mcard.db`，删容器、重建镜像都不会丢失 API Key 和已采集数据。

## 常用命令

```bash
docker compose up -d --build   # 构建并后台启动
docker compose logs -f          # 查看日志
docker compose restart          # 重启（改代码后：先 up --build 再 restart）
docker compose down             # 停止并删除容器（数据保留）
```

## 本地开发（不用 Docker）

```bash
npm install
npm start      # 默认监听 127.0.0.1:31414
npm test       # 运行测试
```

> `better-sqlite3` 是 native 模块，本地安装需 `python3` / `make` / `g++`（编译环境）。

## 说明

- **构建走代理 / 运行不走代理**：`docker-compose.yml` 的 `build.args` 设了 `HTTP_PROXY`/`HTTPS_PROXY`（默认 `http://127.0.0.1:7890`，仅 build 阶段供 apt 装编译链 / npm 拉包使用，靠 `network: host` 访问宿主代理）；而容器运行时的 `environment` 不含任何代理变量，HTTP 请求直连 M-TEAM。换代理地址改 `build.args` 即可。
- **纯手动触发**：所有数据采集、交易均由页面手动点击触发，无后台轮询。
- **访问鉴权（可选）**：`docker-compose.yml` 设 `AUTH_PASSWORD` 即开启登录保护——所有页面 / API / SSE 都需密码登录（登录态 cookie 保持 30 天）；留空则不鉴权。**注意**：局域网 HTTP 下密码是明文传输的，要传输加密请在前面加 HTTPS 反代（Caddy/Nginx）。
- **单用户**：API Key 是唯一的业务凭证（访问 M-TEAM），和访问密码相互独立。`HOST=0.0.0.0` 会监听所有网卡——建议部署在可信网络（家庭局域网、Tailscale 等）。

## 项目结构

```
mcard-server/
├── docker-compose.yml      # 一键编排
├── Dockerfile              # Node 20 + better-sqlite3 编译
├── package.json
├── src/                    # 后端
│   ├── server.js           # Express 入口
│   ├── store.js            # SQLite 持久化
│   ├── state.js            # 状态管理 + 订阅
│   ├── routes/             # REST API + SSE
│   └── lib/                # mteam / collector / trader
├── public/                 # 前端（原生 JS）
│   ├── index.html
│   ├── app.js / app.css
│   └── dispatch.js
├── tests/
└── data/                   # SQLite（运行时生成，已 gitignore）
```

## 许可

私有项目，自用。

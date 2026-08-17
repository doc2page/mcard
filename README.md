# MCard Server

[![Docker Pulls](https://img.shields.io/docker/pulls/doc2page/mcard.svg?style=flat-square)](https://hub.docker.com/r/doc2page/mcard)
[![Image](https://img.shields.io/docker/v/doc2page/mcard.svg?style=flat-square&label=image)](https://hub.docker.com/r/doc2page/mcard/tags)
[![Release](https://img.shields.io/github/v/release/doc2page/mcard.svg?style=flat-square)](https://github.com/doc2page/mcard/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-20-brightgreen.svg?style=flat-square)](https://nodejs.org)

> M-TEAM 卡片市场助手 · 自托管 Web 服务（移动端自适应）

[English](README.en.md) · 中文

原 Chrome 扩展重构为 Docker 化的 Web 服务，单用户自用。后端 Node.js + Express + SQLite，前端原生 JavaScript（无框架），`docker compose` 一键启动，手机和电脑浏览器都能用。

## 功能

- 💳 **持有卡片** —— 查看持有的卡牌，可手动锁定（锁定后不会被交易处理）
- 📚 **我的卡册** —— 按影片聚合稀有度/称号的收藏册（持有+挂单双格矩阵，一键加入定向搜索）
- 📊 **市场行情** —— 手动采集市场挂牌、价格、稀有度分布
- 🛒 **交易** —— 买入 / 卖出 / 撤单（内置安全门与预算池控制）
- 📈 **市场数据** —— 量价叠加 / 价格分布 / 小时分布走势图，支持时间窗切换 + 一键生成分析报告
- 📉 **掉落统计** —— 基于 Feed 的增量统计（官方接口仅返回最新 25 条，支持手动导入补全历史）
- 🎟️ **魔力符券记录** —— 开卡收益 / 分布 / 幸运倍率
- 🔖 **订单簿** —— 按卡查询在售挂单
- 📱 **移动端自适应** —— 抽屉式导航、统计卡片可折叠，手机 / 平板 / 桌面通用
- 🔑 **API Key 经页面设置** —— 存储在后端 SQLite，不落浏览器
- 🔐 **可选访问鉴权** —— HMAC token 登录保护（cookie 30 天）

## 效果展示

<p align="center">
  <img src="screenshots/market.png" alt="市场行情"><br>
  <b>市场行情</b> · 挂牌 · 价格 · 稀有度分布
</p>

<p align="center">
  <img src="screenshots/market-data.png" alt="市场数据"><br>
  <b>市场数据</b> · 量价叠加 / 价格分布 / 走势 · 一键分析报告
</p>

<p align="center">
  <img src="screenshots/drop-stats.png" alt="掉落统计"><br>
  <b>掉落统计</b> · Feed 增量 + 手动导入补全历史
</p>

<p align="center">
  <img src="screenshots/portrait.png" alt="用户画像"><br>
  <b>用户画像</b> · 消费维度趋势四档
</p>

<p align="center">
  <img src="screenshots/batch-modal.png" alt="批量操作"><br>
  <b>批量操作</b> · 批量买入 / 卖出（安全门 + 预算池）
</p>

## 快速开始

镜像已发布到 [Docker Hub](https://hub.docker.com/r/doc2page/mcard)（`doc2page/mcard`），两种方式任选：

### ① 拉取镜像（推荐）

```bash
docker run -d --name mcard -p 31414:31414 -v mcard-data:/app/data \
  -e AUTH_PASSWORD=changeme --restart unless-stopped doc2page/mcard:1.2.0
```

或 `docker-compose.yml`：

```yaml
services:
  mcard:
    image: doc2page/mcard:1.2.0
    container_name: mcard
    ports: ["31414:31414"]
    volumes: ["./data:/app/data"]
    environment:
      AUTH_PASSWORD: "changeme"   # 留空 = 不启用鉴权
    restart: unless-stopped
```

### ② 源码自建

```bash
git clone https://github.com/doc2page/mcard.git
cd mcard
docker compose up -d --build
```

浏览器打开 **http://localhost:31414**，首次访问在页面输入你的 M-TEAM API Key 即可（会自动校验并触发一次全量采集）。

> 📱 **移动端**：手机连同一局域网 Wi-Fi，访问 **http://<电脑局域网IP>:31414**（如 `http://192.168.1.10:31414`）。

## 配置

所有配置都在 `docker-compose.yml` 里：

| 项目 | 默认值 | 说明 |
| --- | --- | --- |
| 端口 | `31414:31414` | 改左侧即可换端口，如 `8080:31414` |
| 数据卷 | `./data:/app/data` | SQLite 数据库（API Key + 缓存），备份整个 `data/` 目录即可 |
| 重启策略 | `unless-stopped` | 崩溃自动重启，手动停止则不重启 |
| 访问密码 | `AUTH_PASSWORD=""` | 留空=不鉴权；填密码则访问需登录（见下方「访问鉴权」）|
| 时区 | `Asia/Shanghai` | 掉落统计日界按此时区（M-TEAM 数据为北京时间）。改时区在 `.env` 设 `TZ=`，如 `TZ=UTC` |

数据持久化在 `./data/mcard.db`，删容器、重建镜像都不会丢失 API Key 和已采集数据。

> **目录权限**：v1.2.1 起容器以非 root（`node`，uid 1000）运行。若宿主 `./data` 目录属主不是 uid 1000（如群晖等 NAS 常见），首次启动前执行一次：`sudo chown -R 1000:1000 ./data`

## 常用命令

```bash
docker compose up -d            # 启动（拉镜像版）；源码自建用 up -d --build
docker compose logs -f          # 查看日志
docker compose restart          # 重启
docker compose down             # 停止并删除容器（数据保留）
```

## 数据备份与恢复

所有数据（API Key、配置、采集缓存）都在 `data/mcard.db` 一个文件里。

**日常备份**（运行中，安全快照需同时拷贝 WAL 三件套）：

```bash
docker cp mcard:/app/data/mcard.db ./mcard.db.bak
docker cp mcard:/app/data/mcard.db-wal ./mcard.db-wal.bak 2>/dev/null || true
docker cp mcard:/app/data/mcard.db-shm ./mcard.db-shm.bak 2>/dev/null || true
```

**严谨备份**（停机几秒，最稳）：

```bash
docker compose down && cp -r data "backup-$(date +%F)" && docker compose up -d
```

**恢复**：`docker compose down` → 把备份的 db（及 -wal/-shm）放回 `data/` → `docker compose up -d`。

**db 损坏重建**（症状：启动报 `SQLITE_CORRUPT` / `file is not a database`）：有备份先恢复备份；没有则删除 `data/mcard.db*` 重启——需重新填 API Key 并重新采集，历史数据不可恢复，请养成备份习惯。

## 升级与回滚

```bash
# 升级（先备份！见上节）
docker compose down
docker pull doc2page/mcard:latest        # 或指定版本如 :1.2.1
docker compose up -d

# 回滚：把 docker-compose.yml 里 image 改回旧版本 tag，再 up -d
```

版本间数据向后兼容（patch/minor 不改存储结构）。版本历史见 [Releases](https://github.com/doc2page/mcard/releases)。

## 安全注意事项

- **API Key 与访问密码在 HTTP 下均为明文传输**。局域网/Tailscale 内使用可接受；**公网部署必须前置 HTTPS 反代**。Caddy 最小配置：

  ```
  mcard.example.com {
      reverse_proxy 127.0.0.1:31414
  }
  ```

- 容器以非 root（`node`, uid 1000）运行；`HOST=0.0.0.0` 监听所有网卡——请勿裸露到不可信网络
- API Key（管 M-TEAM 访问）与 `AUTH_PASSWORD`（管页面访问）相互独立，都建议设置

## 常见问题（FAQ）

| 症状 | 排查 |
| --- | --- |
| 容器启动失败 / 数据写不进 | `./data` 目录属主非 uid 1000（NAS 常见）：`sudo chown -R 1000:1000 ./data` 后重启 |
| 页面能开但采集报错 | API Key 失效——页面右上重新填写令牌（M-TEAM 用户实验室重新生成）；或查看 `docker compose logs -f` |
| 数据不刷新 | 各采集有冷却（市场 8s / 持有·掉落 30s），稍后再点；确认手动刷新按钮状态 |
| 忘记访问密码 | 修改 `.env` 的 `AUTH_PASSWORD` 后 `docker compose up -d`，数据不受影响 |
| 升级后起不来 | 回滚到上一版本镜像（见「升级与回滚」），然后 [提 issue](https://github.com/doc2page/mcard/issues) |

## 本地开发（不用 Docker）

```bash
npm install
npm start      # 默认监听 127.0.0.1:31414
```

> `better-sqlite3` 是 native 模块，本地安装需 `python3` / `make` / `g++`（编译环境）。

## 说明

- **构建走代理 / 运行不走代理**（仅源码自建相关，拉镜像可跳过）：`docker-compose.yml` 的 `build.args` 设了 `HTTP_PROXY`/`HTTPS_PROXY`（默认 `http://127.0.0.1:7890`，仅 build 阶段供 apt 装编译链 / npm 拉包使用，靠 `network: host` 访问宿主代理）；而容器运行时的 `environment` 不含任何代理变量，HTTP 请求直连 M-TEAM。换代理地址改 `build.args` 即可。
- **纯手动触发**：所有数据采集、交易均由页面手动点击触发，无后台轮询（反风控）。
- **访问鉴权（可选）**：`docker-compose.yml` 设 `AUTH_PASSWORD` 即开启登录保护——所有页面 / API / SSE 都需密码登录（登录态 cookie 保持 30 天）；留空则不鉴权。**注意**：局域网 HTTP 下密码是明文传输的，要传输加密请在前面加 HTTPS 反代（Caddy/Nginx）。
- **单用户**：API Key 是唯一的业务凭证（访问 M-TEAM），和访问密码相互独立。`HOST=0.0.0.0` 会监听所有网卡——建议部署在可信网络（家庭局域网、Tailscale 等）。

## 项目结构

```
mcard/
├── src/                    # 后端（Node + Express + SQLite）
│   ├── server.js           # 入口 + 鉴权中间件
│   ├── store.js            # SQLite 持久化
│   ├── state.js            # 进程内状态 + 订阅
│   ├── routes/             # REST · SSE · 鉴权
│   └── lib/                # mteam · collector · trader · stats
├── public/                 # 前端（原生 JS，无框架）
│   ├── index.html
│   ├── app.js / app.css    # 主逻辑 + 样式
│   ├── dispatch.js         # type → REST 映射
│   ├── marketStats.js      # 市场分析 + 报告
│   ├── portrait.js         # 用户画像
│   └── locales/            # i18n（zh / en）
├── Dockerfile              # Node 20 + better-sqlite3
├── docker-compose.yml      # 一键编排
├── LICENSE                 # MIT
└── package.json
```

## 许可

[MIT](LICENSE) © 2026 doc2page

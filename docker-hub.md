# MCard Server

> 🇨🇳 **M-TEAM 卡片市场助手** · 自托管 Docker Web 服务（移动端自适应，纯手动触发）
> 🇬🇧 M-TEAM card market helper · self-hosted Docker web service (mobile-friendly, manual-trigger only)

Node.js + Express + SQLite 后端，原生 JavaScript 前端（无框架）。手机 / 电脑浏览器通用，单用户自用。

[中文文档](https://github.com/doc2page/mcard/blob/main/README.md) · [English](https://github.com/doc2page/mcard/blob/main/README.en.md) · [Issues](https://github.com/doc2page/mcard/issues)

---

## ✨ 功能 / Features

- 💳 **持有卡片** —— 可手动锁定（锁定后不参与交易）
- 📊 **市场行情** —— 手动采集挂牌 / 价格 / 稀有度分布
- 🛒 **交易** —— 买入 / 卖出 / 撤单（内置安全门 + 预算池控制）
- 📈 **市场数据** —— 量价叠加 / 价格分布 / 小时分布走势，支持时间窗切换 + 一键生成分析报告
- 📉 **掉落统计** —— Feed 增量统计（官方接口仅返回最新 25 条，支持手动导入补全历史）
- 🎟️ **魔力符券记录** —— 开卡收益 / 分布 / 幸运倍率
- 🔖 **订单簿** —— 按卡查询在售挂单
- 📱 **移动端自适应** —— 抽屉导航、可折叠统计卡，手机 / 平板 / 桌面通用
- 🔑 **API Key 存后端 SQLite** —— 不落浏览器

## 🚀 快速开始 / Quick Start

**`docker run` 一行启动：**

```bash
docker run -d \
  --name mcard \
  -p 31414:31414 \
  -v mcard-data:/app/data \
  -e AUTH_PASSWORD=changeme \
  --restart unless-stopped \
  doc2page/mcard:1.0.2
```

**或 `docker-compose.yml`：**

```yaml
services:
  mcard:
    image: doc2page/mcard:1.0.2
    container_name: mcard
    ports: ["31414:31414"]
    volumes: ["./data:/app/data"]
    environment:
      AUTH_PASSWORD: "changeme"   # 留空 = 不启用鉴权
    restart: unless-stopped
```

```bash
docker compose up -d
```

浏览器打开 **http://localhost:31414**，首次访问在页面输入你的 M-TEAM API Key（自动校验并触发一次全量采集）。
📱 移动端：手机连同一局域网 Wi-Fi，访问 `http://<电脑局域网IP>:31414`。

## ⚙️ 配置 / Config

| 项目 | 默认 | 说明 |
| --- | --- | --- |
| 端口 | `31414` | `-p 8080:31414` 换端口 |
| 数据卷 | `/app/data` | SQLite（API Key + 缓存），备份整个 `data/` 目录 |
| `AUTH_PASSWORD` | 空 | 留空 = 完全开放；设密码则需登录（cookie 30 天） |
| 时区 | `Asia/Shanghai` | 掉落日界按此时区（M-TEAM 数据为北京时间）。`.env` 设 `TZ=` 覆盖 |
| 重启 | `unless-stopped` | 崩溃自启，手动停止不重启 |

数据持久化在 `data/mcard.db`，**删容器 / 重建镜像都不丢** API Key 与已采集数据。

## 📌 说明 / Notes

- **纯手动触发**：所有采集 / 交易均由页面点击触发，**无后台轮询**（反风控）。
- **单用户**：API Key 管 M-TEAM 访问，`AUTH_PASSWORD` 管页面访问，二者独立。
- **网络安全**：`HOST=0.0.0.0` 监听所有网卡——请部署在可信网络（家庭局域网 / Tailscale 等）。局域网 HTTP 下密码明文传输，需加密请在前面加 HTTPS 反代（Caddy / Nginx）。

## 🏗️ 自建 / Build from source

```bash
git clone https://github.com/doc2page/mcard.git
cd mcard
docker compose up -d --build
```

## 🔗 链接

- 源码与完整文档：https://github.com/doc2page/mcard
- 问题反馈：https://github.com/doc2page/mcard/issues
- 镜像标签：`1.0.2` · `latest`（仅 amd64）

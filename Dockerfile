# MCard 后端容器（Node 20 + better-sqlite3 编译）
FROM node:20-slim

# better-sqlite3 是 native 模块，编译需 python3/make/g++
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用 docker 层缓存）
COPY package.json package-lock.json ./
# npmmirror（官方源在部分代理下不稳定曾致卡死）；同层清三样：npm 下载缓存（cacache 曾 97MB）、
# better-sqlite3 源码编译中间产物（prebuild 下载失败回退编译时 obj/sqlite3.a ~17MB，只需留 .node）
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com \
    && rm -rf /root/.npm \
    && (rm -rf node_modules/better-sqlite3/build/Release/obj node_modules/better-sqlite3/build/Release/obj.target node_modules/better-sqlite3/build/Release/*.a || true)

# 复制源码 + 前端
COPY src ./src
COPY public ./public
RUN mkdir -p data && chown -R node:node /app/data

# 容器内绑所有接口（安全靠宿主网络/反代/Tailscale；见 spec 第 14 节）
ENV HOST=0.0.0.0
ENV PORT=31414
# 默认时区（docker-compose TZ 可覆盖）。tzdata 已装；掉落日界按此时区，须与 M-TEAM 数据时区（北京）一致。
ENV TZ=Asia/Shanghai

# 非 root 运行（安全红线）。注意：bind mount 的宿主 data 目录需 uid 1000 可写（见 README 部署说明）
USER node

# 健康检查：/health 在鉴权白名单内，无需 cookie
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||31414)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

VOLUME /app/data
EXPOSE 31414

CMD ["node", "src/server.js"]

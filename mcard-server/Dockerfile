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
ENV PORT=31414

VOLUME /app/data
EXPOSE 31414

CMD ["node", "src/server.js"]

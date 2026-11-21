# MarketHub bot — uy serveri (Coolify) uchun
FROM node:22-slim
ENV TZ=Asia/Tashkent \
    MINIAPP_HOST=0.0.0.0 \
    FORCE_LOCAL=1 \
    NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx esbuild scripts/local.ts --bundle --platform=node --format=esm --outfile=/app/bot.mjs

EXPOSE 8787
# Ma'lumotlar (.local-kv.json) /data papkasida (Persistent Storage) saqlanadi
WORKDIR /data
CMD ["sh", "-c", "mkdir -p /data/.local && exec node /app/bot.mjs"]

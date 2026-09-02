FROM node:22-slim

# كروم للسيرفر (whatsapp-web.js يشغّل واتساب ويب داخله)
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DATA_DIR=/data \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY app.js ui.html ./

# القرص الدائم: جلسة واتساب + التصريح + سجل المُرسل
VOLUME /data
EXPOSE 3777
CMD ["node", "app.js"]

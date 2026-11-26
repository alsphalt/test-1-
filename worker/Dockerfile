# WhatsApp worker — deploy this to any always-on host (Railway, Fly, Render, VPS).
# The Vercel deployment hosts the web app only; sockets cannot live on serverless.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY worker ./worker
COPY scripts ./scripts

ENV NODE_ENV=production
CMD ["node", "worker/index.mjs"]

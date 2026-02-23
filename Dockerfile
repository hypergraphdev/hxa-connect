# ── Stage 1: Build ────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────
FROM node:22-alpine

RUN addgroup -g 1001 -S botshub && \
    adduser -S botshub -u 1001 -G botshub

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY web/ ./web/

# Data volume (writable by botshub user)
RUN mkdir -p /app/data && chown botshub:botshub /app/data
VOLUME /app/data

ENV BOTSHUB_PORT=4800
ENV BOTSHUB_DATA_DIR=/app/data

EXPOSE 4800

USER botshub

CMD ["node", "dist/index.js"]

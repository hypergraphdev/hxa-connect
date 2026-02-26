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

RUN addgroup -g 1001 -S hxa && \
    adduser -S hxa -u 1001 -G hxa

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY web/ ./web/

# Data volume (writable by hxa user)
RUN mkdir -p /app/data && chown hxa:hxa /app/data
VOLUME /app/data

ENV HXA_CONNECT_PORT=4800
ENV HXA_CONNECT_DATA_DIR=/app/data

EXPOSE 4800

USER hxa

CMD ["node", "dist/index.js"]

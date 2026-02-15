FROM node:22-alpine

WORKDIR /app

# Install deps
COPY package.json ./
RUN npm install --production=false

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY web/ ./web/

# Build TypeScript
RUN npx tsc

# Remove dev deps
RUN npm prune --production

# Data volume
VOLUME /app/data

ENV BOTSHUB_PORT=4800
ENV BOTSHUB_DATA_DIR=/app/data

EXPOSE 4800

CMD ["node", "dist/index.js"]

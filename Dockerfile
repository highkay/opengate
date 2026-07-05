# ── Build stage ─────────────────────────────────────────────────────
FROM oven/bun:alpine AS build
WORKDIR /app
COPY package.json bun.lock* package-lock.json* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY . .
RUN bun run build

# ── Production stage ────────────────────────────────────────────────
FROM oven/bun:alpine AS production
WORKDIR /app

# Install system deps for Playwright/Chromium and the Node.js wreq sidecar.
RUN apk add --no-cache \
    ca-certificates \
    nodejs \
    chromium \
    nss \
    freetype \
    harfbuzz \
    glib \
    font-noto-cjk \
    dbus \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Copy built artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/models.json ./dist/models.json
COPY --from=build /app/src/worker ./dist/worker
COPY --from=build /app/src/routes/dashboard/public ./src/routes/dashboard/public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Non-root user for security
RUN addgroup -g 1001 -S qwen && \
    adduser -S qwen -u 1001 -G qwen && \
    mkdir -p /app/.qwen /app/logs && \
    chown -R qwen:qwen /app
USER qwen

ENV PORT=26405
ENV HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 26405
VOLUME [ "/app/.qwen" ]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-26405}/ping" || exit 1

CMD [ "bun", "dist/index.js" ]

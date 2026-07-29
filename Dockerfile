# ── Build stage ─────────────────────────────────────────────────────
FROM oven/bun:1.3.14-debian AS build
WORKDIR /app
COPY package.json bun.lock* package-lock.json* ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ── Production stage ────────────────────────────────────────────────
FROM oven/bun:1.3.14-debian AS production
WORKDIR /app

# Install system Chromium plus the optional manual CAPTCHA console.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    nodejs \
    chromium \
    dbus-x11 \
    fluxbox \
    fonts-liberation \
    fonts-noto-cjk \
    novnc \
    websockify \
    wget \
    x11vnc \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/models.json ./dist/models.json
COPY --from=build /app/src/worker ./dist/worker
COPY --from=build /app/src/routes/dashboard/public ./src/routes/dashboard/public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/qwen-entrypoint

# Non-root user for security
RUN groupadd --gid 1001 qwen && \
    useradd --uid 1001 --gid qwen --create-home --shell /usr/sbin/nologin qwen && \
    mkdir -p /app/.qwen /app/logs /home/qwen/.cache && \
    chown -R qwen:qwen /app/.qwen /app/logs /home/qwen
USER qwen

ENV PORT=26405
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CLOAKBROWSER_BINARY_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
EXPOSE 26405
EXPOSE 7900
VOLUME [ "/app/.qwen" ]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-26405}/ping" || exit 1

ENTRYPOINT [ "/usr/local/bin/qwen-entrypoint" ]
CMD [ "bun", "dist/index.js" ]

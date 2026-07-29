# Qwen Gate Deployment Guide

Production deployment for Qwen Gate.

## Table of Contents

- [Quick Start](#quick-start)
- [Docker / GHCR (recommended for this host)](#docker--ghcr-recommended-for-this-host)
- [PM2 Process Manager](#pm2-process-manager)
- [systemd Service (Linux)](#systemd-service-linux)
- [Configuration](#configuration)
- [Reverse Proxy (nginx)](#reverse-proxy-nginx)
- [Monitoring](#monitoring)
- [Security](#security)

## Quick Start

```bash
# Install dependencies (postinstall creates config.json with defaults)
bun install --production

# Customize config (optional -- skip if defaults are fine)
bun run setup

# Start the server
bun start
```

The server runs on `http://localhost:26405` by default. Configure via `bun run setup` or edit `config.json` directly.

## Docker / GHCR (recommended for this host)

### How images are published

| Step | Detail |
|------|--------|
| Source of truth | GitHub `highkay/opengate` `main` branch |
| CI quality gate | `.github/workflows/ci.yml` — biome, `tsc --noEmit`, `bun test` |
| Image build | `.github/workflows/docker-ghcr.yml` — builds **`Dockerfile`**, pushes to GHCR |
| Triggers | Push to `main` when `Dockerfile` / `package.json` / `bun.lock` / `src/**` / the workflow file change; or `workflow_dispatch` |
| Registry | `ghcr.io/highkay/opengate` |

**Tags:**

- `latest` — current `main`
- `sha-<short>` — immutable commit pin (use this in compose)
- `main` — branch tag

Agent-oriented end-to-end checklist: root **[AGENTS.md](../AGENTS.md)**.

### Deploy tree (`Qwen2api`)

Keep **runtime data separate from source**:

| Path | Purpose |
|------|---------|
| `/home/admin/opengate` | Git clone / source + Actions-driven releases |
| `/home/admin/Qwen2api` | Compose instance: image pin, `config.json`, `.qwen/`, `logs/` |

Example `docker-compose.yml`:

```yaml
services:
  qwen2api:
    image: ghcr.io/highkay/opengate:sha-e1b61dd   # pin to a CI-built SHA
    container_name: qwen2api
    restart: unless-stopped
    init: true
    environment:
      PORT: "7860"
      HOST: "0.0.0.0"
      NODE_ENV: production
      AUTH_STARTUP_CONCURRENCY: "1"
      AUTH_STARTUP_BACKOFF_MS: "3000"
      AUTH_STARTUP_JITTER_MS: "3000"
      AUTH_STARTUP_BACKOFF_MULTIPLIER: "2"
      AUTH_STARTUP_MAX_BACKOFF_MS: "15000"
      AUTH_STARTUP_LOGIN_ATTEMPTS: "1"
    ports:
      - "7860:7860"
    shm_size: "1gb"
    volumes:
      - ./.qwen:/app/.qwen
      - ./config.json:/app/config.json
      - ./logs:/app/logs
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:7860/ping || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3
```

### Browser-assisted login recovery

API login remains the primary path. When Qwen requires CAPTCHA or interactive verification, the container can open a persistent Chromium profile and expose an authenticated noVNC console on loopback only.

Add the following deployment settings:

```yaml
services:
  qwen2api:
    env_file:
      - ./.browser.env
    environment:
      MANUAL_BROWSER_ENABLED: "true"
      BROWSER_MANUAL_URL: "http://127.0.0.1:7900/vnc.html?autoconnect=true&resize=remote"
    ports:
      - "7860:7860"
      - "127.0.0.1:7900:7900"
    shm_size: "1gb"
```

Create the secret file without committing it:

```bash
umask 077
printf 'BROWSER_VNC_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .browser.env
```

Access the console through an SSH tunnel instead of exposing it publicly:

```bash
ssh -L 7900:127.0.0.1:7900 user@server
```

Then open `http://127.0.0.1:7900/vnc.html?autoconnect=true&resize=remote`, enter the password from `.browser.env`, and complete the login or CAPTCHA. The login job polls the persistent browser cookies, saves the resulting token atomically, marks the account ready, and closes the browser context. Failed, expired, or timed-out jobs also close their context.

`MANUAL_BROWSER_ENABLED` is disabled by default. Enabling it without `BROWSER_VNC_PASSWORD` makes the container refuse to start, preventing an unauthenticated browser console.

### Authentication persistence

- Passwords are stored with AES-256-GCM in `.qwen/accounts.json`.
- On first write, `.qwen/master.key` is created with mode `0600`. Existing installations seed it from the current `API_KEY`, so later API key rotation does not make stored account passwords undecryptable.
- Token, refresh token, expiry, password migration, and throttle state use atomic file replacement.
- Keep `.qwen/master.key`, `.qwen/accounts.json`, and browser profiles together in backups. Losing `master.key` makes encrypted passwords unrecoverable.
- Startup authentication is serialized and uses one HTTP-only sign-in attempt per account by default. It never opens an interactive browser or Playwright WAF recovery during boot; CAPTCHA/browser login is started only by an explicit dashboard login job. The `AUTH_STARTUP_*` variables above control concurrency, retry count, backoff, jitter, multiplier, and maximum delay.
- `/v1/models` is generated from the bundled model catalog and compatibility aliases. It does not contact Qwen, consume an account, or start browser-based WAF recovery.

### Update instance to a new release

```bash
# After GitHub Actions "Docker GHCR" succeeds for commit <short>
docker login ghcr.io   # if package is private
docker pull ghcr.io/highkay/opengate:sha-<short>
docker pull ghcr.io/highkay/opengate:latest

cd /home/admin/Qwen2api
# set image: ghcr.io/highkay/opengate:sha-<short>
echo '<short>' > OPENGATE_COMMIT
docker compose up -d --force-recreate
curl -sS http://127.0.0.1:7860/ping
```

### Local image builds (debug only)

| File | Use |
|------|-----|
| `Dockerfile` | Same as GHCR CI (full deps, larger) |
| `Dockerfile.local` | Faster local rebuilds (slim runtime) |

```bash
docker build -f Dockerfile.local -t ghcr.io/highkay/opengate:local-$(git rev-parse --short HEAD) .
```

Do **not** leave production compose on `local-*` tags after a real fix is merged — promote via GHCR `sha-*`.

## PM2 Process Manager

PM2 keeps the server running forever with auto-restart on crash.

```bash
# Install PM2 globally
bun add -g pm2

# Start with PM2
pm2 start bun --name "qwen-gate" -- start

# Save process list (survives reboot)
pm2 save

# Generate startup script
pm2 startup

# Useful commands
pm2 status                # View status
pm2 logs qwen-gate        # View logs
pm2 monit                 # Monitor resources
pm2 restart qwen-gate     # Restart
pm2 stop qwen-gate        # Stop
```

### Clustering (multi-core)

```bash
pm2 start bun --name "qwen-gate" -i max -- start
```

Runs one instance per CPU core.

### Auto-restart on crash

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'qwen-gate',
    script: 'bun',
    args: 'start',
    instances: 1,
    exec_mode: 'fork',
    max_restarts: 10,
    restart_delay: 4000,
    max_memory_restart: '1G',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
  }]
};

// mkdir -p logs  (create the logs directory referenced above)
// pm2 start ecosystem.config.js
```

## systemd Service (Linux)

Create `/etc/systemd/system/qwen-gate.service`:

```ini
[Unit]
Description=Qwen Gate API Proxy
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/qwen-gate
ExecStart=/usr/bin/bun start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable qwen-gate
sudo systemctl start qwen-gate
sudo systemctl status qwen-gate
journalctl -u qwen-gate -f  # View logs
```

## Configuration

Configuration lives in `config.json` at the project root. There is no `.env` file — all settings use `config.json`.

### Interactive Setup

```bash
bun run setup
```

Prompts for port, host, API key, browser engine, and more. Saves to `config.json`.

### Manual Configuration

```json
{
  "PORT": "26405",
  "HOST": "0.0.0.0",
  "API_KEY": "your-secret-key",
  "BROWSER": "chromium",
  "TOOL_CALLING": "true",
  "CLEAN_OUTPUT": "true",
  "STREAMING_MODE": "auto"
}
```

Settings apply immediately. No restart needed for most changes.

### Via Dashboard

Open `http://localhost:26405/dashboard/settings` (or your configured PORT) for the web config UI. Changes persist to `config.json`.

## Reverse Proxy (nginx)

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location /v1/ {
        proxy_pass http://127.0.0.1:26405;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Required for streaming
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
    }
}
```

### SSL with Let's Encrypt

```bash
sudo apt install certbot nginx
sudo certbot --nginx -d api.yourdomain.com
```

## Monitoring

### Health Check

```bash
curl http://localhost:26405/v1/models
```

### Application Logs

```bash
pm2 logs qwen-gate                  # Via PM2
journalctl -u qwen-gate -f          # Via systemd
```

`LOG_FORMAT` defaults to `json`. Set to `"text"` for human-readable log output.

### Dashboard

Open `http://localhost:26405/dashboard` (or your configured PORT) for real-time request logs, account status, and session pool stats.

## Security

- Set `API_KEY` in `config.json` — protects all `/v1/*` endpoints
- Run behind nginx with SSL in production
- Use a firewall (`ufw`) to restrict access
- Keep Bun and dependencies updated

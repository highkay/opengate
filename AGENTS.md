# Qwen Gate — Project Guide

## Runtime

- **Bun only** (v1.3+). Node.js `start:node` script exists but is secondary.
- No build step for local/dev: `bun src/index.tsx` runs TypeScript directly.
- Production Docker images **do** compile with `bun run build` (`tsc` → `dist/`).
- Uses `bun.lock` (not `package-lock.json`).
- Import extensions use `.ts`/`.tsx` (see `allowImportingTsExtensions` in tsconfig).

## Commands

```bash
bun test              # All tests, no setup needed
bun start             # Dev server (`bun src/index.tsx`)
bun dev               # Hot reload (`bun --watch src/index.tsx`)
bun cluster           # Multi-core mode
bun qg                # CLI entry (`bun src/cli.ts`)
bunx biome check src/ # Lint / format check (CI enforces this)
bunx tsc --noEmit     # Typecheck (CI enforces this)
```

## File organization

```
src/
  index.tsx             Server entry, routing, CORS, auth
  cli.ts                CLI parser
  cluster.ts            Cluster mode
  models.json           Model definitions (context lengths, modalities)
  routes/               API handlers + streaming logic
    dashboard/          Web dashboard (monitoring, accounts, logs, network, settings)
  tools/                Tool call system (parser, guard, schema, registry)
  services/             Auth, accounts, sessions, Qwen API transport, logStore, config
  utils/                Shared utilities
  middleware/           Rate limiter
  types/                TypeScript interfaces
  tests/                Integration tests
.github/workflows/
  ci.yml                biome + tsc + bun test on push/PR
  docker-ghcr.yml       Build/push image to GHCR on main (src/Dockerfile changes)
Dockerfile              Full production image (Chromium + Node sidecar) — used by GHCR CI
Dockerfile.local        Slimmer local image (faster rebuilds, no full Chromium set)
```

## Development & release workflow

This repo is developed on GitHub (`highkay/opengate`) and published as container images on GHCR. **Do not treat a one-off local `docker build` as the release path** unless you are only prototyping.

### 1. Develop & verify locally

```bash
bun install --frozen-lockfile
bunx biome check src/
bunx tsc --noEmit
bun test
bun dev   # optional smoke test
```

- Prefer small, focused commits with Conventional Commits (`fix:`, `feat:`, `docs:`, …).
- New tests live next to the code (e.g. `src/utils/retry.circuit.test.ts`) or under `src/tests/`.
- `biome check` fails CI on unsorted imports — keep import names sorted.

### 2. Ship code via GitHub

```bash
git checkout main
git pull --ff-only
# …edit…
git add -A
git commit -m "fix: …"
git push origin main
```

Push to `main` triggers:

| Workflow | File | What it does |
|----------|------|----------------|
| **CI** | `.github/workflows/ci.yml` | `biome check`, `tsc --noEmit`, `bun test` |
| **Docker GHCR** | `.github/workflows/docker-ghcr.yml` | Builds `Dockerfile`, pushes to GHCR (also `workflow_dispatch`) |

Docker GHCR only runs when these paths change: `Dockerfile`, `package.json`, `bun.lock`, `src/**`, `.github/workflows/docker-ghcr.yml`. Docs-only commits skip the image build.

### 3. GHCR image tags

Registry image:

```text
ghcr.io/highkay/opengate
```

| Tag | Meaning |
|-----|---------|
| `latest` | Tip of default branch (`main`) |
| `sha-<short>` | Immutable pin to commit (preferred for production compose) |
| `main` | Branch ref tag |

Example: commit `e1b61dd` → `ghcr.io/highkay/opengate:sha-e1b61dd` and `…:latest`.

### 4. Update a running instance from GHCR

Canonical local deploy tree on this host: **`/home/admin/Qwen2api`** (compose + data only; source lives in `/home/admin/opengate`).

```bash
# Auth once if the package is private
echo "$GITHUB_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin

SHORT=$(cd /home/admin/opengate && git rev-parse --short HEAD)   # or the CI commit you want
docker pull "ghcr.io/highkay/opengate:sha-${SHORT}"
docker pull ghcr.io/highkay/opengate:latest   # optional

# Pin compose to the immutable tag, record commit, recreate
cd /home/admin/Qwen2api
# edit docker-compose.yml → image: ghcr.io/highkay/opengate:sha-${SHORT}
echo "$SHORT" > OPENGATE_COMMIT
docker compose up -d --force-recreate
docker compose ps
curl -sS http://127.0.0.1:7860/ping
```

`Qwen2api` layout:

| Path | Role |
|------|------|
| `docker-compose.yml` | Service definition; pin `image:` to a GHCR `sha-*` tag |
| `config.json` | Runtime config (not in opengate git) |
| `.qwen/accounts.json` | Account tokens / pool state (secrets — never commit) |
| `.qwen/monitor.json` | Request monitor history |
| `logs/` | Crash / wreq logs |
| `OPENGATE_COMMIT` | Short SHA of the image currently intended to run |

### 5. Local Docker (optional, not the release path)

```bash
# Fast iteration image (no full Chromium stack)
docker build -f Dockerfile.local -t ghcr.io/highkay/opengate:local-$(git rev-parse --short HEAD) .

# Same base as CI (slower / larger)
docker build -f Dockerfile -t ghcr.io/highkay/opengate:local-$(git rev-parse --short HEAD) .
```

Use local tags only for debugging. After the change is good, **push to `main` and consume the GHCR `sha-*` image**.

### 6. Agent checklist after a fix that must ship

1. Implement + tests + `biome` / `tsc` / `bun test` green.
2. Commit and **push to `origin/main`**.
3. Wait for **Docker GHCR** workflow success (and CI green).
4. `docker pull ghcr.io/highkay/opengate:sha-<short>`.
5. Update `Qwen2api/docker-compose.yml` + `OPENGATE_COMMIT`, `docker compose up -d --force-recreate`.
6. Smoke-test `/ping` and one `/v1/chat/completions` call.

## Reliability pitfalls (do not regress)

- **Circuit breaker recovery**: In `createQwenStream` (`src/services/qwen.ts`), always gate with `qwenCircuitBreaker.allowRequest()` (or `tryTransitionToHalfOpen()`), **never** only `getState() === 'open'`. `getState()` does not transition `open → half_open`, so the process can permanently reject all accounts until restart even when `Retry after 0ms`.
- **Global breaker**: The Qwen circuit breaker is process-global (all accounts). Account UI can still show `authenticated` / `available` while every chat fails with `Circuit breaker is open`.
- **inFlight counters**: Account `inFlight` is in-memory; stuck values skew picking until restart. Prefer fixing release paths over raising the safety-valve threshold.

## Project-specific rules

- **Tag names** (tool call keywords, think tag names) live in `src/utils/tagNames.ts`. All consumers import from there.
- **Config values** (feature_config, Qwen API settings) live in `src/services/qwen.ts`. Export reusable builders, don't inline copies.
- **Config file**: `config.json` (not version controlled, generated by installer). All 23 config keys can be overridden by env vars of the same name (e.g., `PORT`, `API_KEY`). See `ConfigSchema` in `src/services/configService.ts` for the full key list. `STREAM_IDLE_TIMEOUT_MS` is env-only (not a config key).
- **Do not commit** runtime secrets from deploy trees (`Qwen2api/config.json`, `.qwen/accounts.json`, tokens).

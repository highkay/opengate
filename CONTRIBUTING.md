# Contributing

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run `bun install`
4. Create a branch: `git checkout -b feat/my-feature`

## Development

```bash
bun dev        # Start in development mode
bun test            # Run tests
```

### Code Style

- TypeScript with strict mode
- Use `logStore.systemLog()` for logging — not `console.*`
- Follow existing patterns in the codebase
- Keep functions focused and under 80 lines where possible

## Pull Request Process

1. Update tests to cover your changes
2. Run locally before push:
   - `bunx biome check src/`
   - `bunx tsc --noEmit`
   - `bun test`
3. Update relevant documentation in `docs/` (and `AGENTS.md` if agent/deploy conventions change)
4. Add a CHANGELOG entry when the change is user-visible

CI (`.github/workflows/ci.yml`) enforces biome, typecheck, and tests on every push/PR.

## Release / container images

Production images are **not** published by hand from a laptop as the default path.

1. Merge or push to `main`.
2. GitHub Actions **Docker GHCR** (`.github/workflows/docker-ghcr.yml`) builds `Dockerfile` and pushes:
   - `ghcr.io/highkay/opengate:latest`
   - `ghcr.io/highkay/opengate:sha-<short>`
   - `ghcr.io/highkay/opengate:main`
3. Deploy instances pull a **pinned** `sha-*` tag (see `docs/DEPLOYMENT.md` and `AGENTS.md`).

`Dockerfile.local` is for fast local experimentation only. Docs-only changes do not rebuild GHCR (path filters).

Full agent-oriented checklist: **[AGENTS.md](./AGENTS.md)**.

## Commit Messages

Conventional Commits format:

```
feat(scopes): add new feature
fix(scopes): fix a bug
chore(scopes): maintenance task
docs(scopes): documentation changes
```

## Project Structure

```
src/
├── cli.ts          # CLI entry point
├── cluster.ts      # Cluster mode
├── index.tsx       # Server entry, routing, CORS, auth
├── models.json     # Model definitions
├── middleware/      # Rate limiter
├── routes/         # API handlers + streaming
│   └── dashboard/  # Web dashboard
├── services/       # Auth, accounts, sessions, Qwen API transport, config
├── tests/          # Integration tests
├── tools/          # Tool calling system
├── types/          # OpenAI-compatible types
└── utils/          # Shared utilities
```

## Questions?

Open a GitHub Discussion or issue.

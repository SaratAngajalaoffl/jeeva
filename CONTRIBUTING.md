# Contributing to Jeeva

Thanks for your interest in contributing! This project has three parts — a Next.js dashboard (`frontend/`), an Express API (`api/`), and a Rust trading engine (`engine/`) — see the [README](./README.md) for how they fit together, and [`CONTEXT.md`](./CONTEXT.md) for the project's internal glossary and naming conventions.

## Getting set up

```bash
cp .env.example .env   # set AUTH_USERNAME / AUTH_PASSWORD / JWT_SECRET
docker compose up --build
```

This starts MongoDB, TimescaleDB, the API, the engine, and the dashboard with no external credentials required — every PERP defaults to mock execution and the Fake decision maker.

## Making changes

- **frontend/ and api/** are npm workspaces at the repo root: `npm ci` from the repo root installs both. Run workspace scripts with `--workspace=frontend` or `--workspace=api`, e.g. `npm run lint --workspace=api`.
- **engine/** is a standalone Rust crate: run `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` from `engine/`.
- **Postgres schema** is owned entirely by the migrations in `api/migrations/`. To change it, add a migration with `npm run migrate create <name> --workspace=api` rather than editing tables by hand.

Before opening a PR, run the checks that apply to what you touched:

| Area | Lint/format | Tests |
|---|---|---|
| `engine/` | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` | `cargo test` |
| `api/` | `npm run lint --workspace=api` | `npm run test --workspace=api` |
| `frontend/` | `npm run lint --workspace=frontend` | `npm run test --workspace=frontend` |

CI (`.github/workflows/ci.yml`) runs the same checks per-area, only for the parts of the repo your PR actually touches, plus a Postgres/MongoDB integration setup for `engine/` and `api/`.

## Safety-sensitive areas

Jeeva can place real orders against a real Hyperliquid wallet in live mode. When touching the decision cycle, execution adapters, or the auto-flatten safety net (`engine/src/decision/`), favor caution: default to mock-safe behavior, and call out in your PR description any change that affects when/how real orders get placed.

## Submitting a PR

1. Fork the repo and create a branch off `main`.
2. Keep PRs focused — one logical change per PR is easier to review.
3. Make sure the relevant lint/test commands above pass locally.
4. Open a PR describing what changed and why. Link any related issue.

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/SaratAngajalaoffl/jeeva/issues) with steps to reproduce (for bugs) or the use case you're trying to solve (for features).

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).

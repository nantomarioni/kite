# Agent guide — kite

Tool-agnostic guide for coding agents (Cursor, Claude Code, Copilot, Codex, …).
This root file is repo-wide orientation; component detail lives in nested
`AGENTS.md` files that load nearest-first when you edit that folder:

- `pkg/AGENTS.md` — the Go backend (Gin API + Kubernetes client + GORM).
- `ui/AGENTS.md` — the React + TypeScript frontend (Vite + TanStack Query).

## What this is

**Kite** is a modern, self-hosted **Kubernetes dashboard** — a single Go binary
that serves a REST/SSE/WebSocket API *and* embeds the built React SPA. It manages
multiple clusters (kubeconfig-discovered or in-cluster), browses/edits all the
standard k8s resources + CRDs, streams pod logs and terminals, shows Prometheus
metrics, and has its own users/RBAC/OAuth layer backed by a SQL database.

Two components, one process:

| Component | Dir | Stack | Role |
|---|---|---|---|
| Backend | `pkg/` + `main.go` + `internal/` | Go 1.25, Gin, `sigs.k8s.io/controller-runtime` client, GORM (sqlite/mysql/postgres), Prometheus client, JWT | The API server + k8s broker. Embeds the built UI via `//go:embed static`. |
| Frontend | `ui/` | React 19 + TypeScript 5, Vite 7, TanStack Query, Tailwind v4, Radix UI, Monaco editor, xterm.js | The dashboard SPA. Built to `static/`, embedded into the Go binary. |

The two communicate **only over HTTP** under `/api/v1` (plus `/api/auth`,
`/api/users`, `/api/v1/admin`). There is **no codegen** between them — the
TypeScript types in `ui/src/types/` are hand-mirrored from the Go response
shapes. Keep them in sync by hand.

### Fork status (important)

This is a **fork** of upstream `zxh326/kite` (origin: `nantomarioni/kite`).

- **`main`** tracks upstream.
- **`fork`** is the working branch (`main` + local feature commits) and is what
  deploys to the homelab. The Go module path is still `github.com/zxh326/kite` —
  don't rename it.

Local additions on `fork` (study these as the canonical "how we add features"
examples): **Vertical Pod Autoscaler (VPA) views**, **per-container resource
usage**, **pod termination reason / resource config**, **app-view**, **auth-proxy
support**, and the **homelab CI/CD workflow**. Most fork work is in `ui/` (VPA is
frontend-only, consuming the generic CRD API); the backend touch points are
`pkg/auth/handler.go`, `pkg/common/common.go`, and `pkg/model/user.go`
(auth-proxy). Keep the upstream diff small and rebase-friendly; prefer adding
over rewriting upstream files.

> The README, `README_zh.md`, and `docs/` are upstream-authored and point at
> `kite.zzde.me` / `github.com/zxh326/kite`. Trust this file and the actual tree
> for fork-specific behavior (deploy target, branch).

## How to run things

Everything is wrapped in the root **`Makefile`** (`make help` lists targets).
`pnpm` is the UI package manager (`ui/pnpm-lock.yaml`); `cd ui` before raw pnpm.

### Both together (dev)

```bash
make deps     # pnpm install (ui) + go mod download
make dev      # builds, runs the Go binary with ANONYMOUS_USER_ENABLED=true,
              # then starts the Vite dev server (frontend on Vite, proxying API to :8080)
```

`make build` does `frontend` (→ `static/`) then `backend` (→ `./kite`), and
`make run` runs the built binary. The binary serves on **`:8080`** by default
(override with `PORT`).

### Backend only (Go)

```bash
go build -trimpath -o kite .   # or: make backend  (needs static/ to exist for embed)
go test -v ./...               # or: make test
go vet ./...
make lint                      # go vet + golangci-lint (downloads v2.7.2 to ./bin)
make format                    # go fmt ./...
```

Note: `main.go` has `//go:embed static`, so a from-scratch `go build` needs a
`static/` dir to exist (run `make frontend` first, or it fails to embed).

### Frontend only (`cd ui`)

```bash
pnpm install
pnpm run dev          # Vite dev server
pnpm run build        # tsc -b && vite build  → ../static (per vite.config.ts)
pnpm run lint         # eslint .
pnpm run type-check   # tsc --noEmit
pnpm run format       # prettier --write .
```

### Docker

```bash
docker build -t kite .          # multistage: node:20-alpine (ui) → golang:1.25-alpine → distroless/static
```

`Dockerfile` builds the UI with pnpm, copies `static/` into the Go build, and
ships a distroless binary on `:8080`. `Dockerfile.binary` is a thin
"copy a prebuilt binary" variant.

### Release / deploy

- **Upstream** releases via `.github/workflows/release.yaml` (multi-arch image
  to `ghcr.io/zxh326/kite`, Helm chart, GitHub release) and ships a Helm chart
  (`charts/kite/`) + `deploy/install.yaml`.
- **This fork** deploys via `.github/workflows/homelab-cicd.yml`: on push to
  **`fork`**, build+push `ghcr.io/nantomarioni/kite:<short-sha>` (and `:fork`),
  then `yq`-bump the image tag in the `nantomarioni/homelab-manifests` repo
  (`apps/kite/values.yaml`) for ArgoCD to pick up. Standard homelab GitOps flow.

## Quality gate

Mirror upstream CI (`.github/workflows/ci.yml`, on PRs to `main`), which runs:

```bash
make deps && make build      # both components compile
golangci-lint run            # config in .golangci.yml (go 1.25, staticcheck etc.)
make pre-commit              # = make format + make lint (go vet + golangci + ui eslint)
make test                    # go test -v ./...
```

Run the gate for the component you touched, at minimum:

- **Backend:** `go vet ./...`, `golangci-lint run`, `go test ./...`.
- **Frontend:** `cd ui && pnpm run type-check && pnpm run lint`.
- **Both compile:** `make build`.

There are **no frontend unit tests** (no test runner in `ui/package.json`);
`pnpm run type-check` + `pnpm run lint` are the bar. Go tests exist but are
sparse (e.g. `pkg/handlers/resources/pod_handler_test.go`).

## Conventions (repo-wide)

- **One binary, embedded UI.** The Go server owns routing; the SPA is served from
  the embedded `static/` FS with a `NoRoute` SPA fallback (`main.go`
  `setupStatic`). API 404s under `/api/` return JSON; everything else returns
  `index.html`.
- **API base path** is configurable via `KITE_BASE` (sub-path hosting). The
  backend injects it into `index.html`; the frontend reads it via
  `ui/src/lib/subpath.ts`. Don't hardcode `/api/v1` on the client — use the
  `apiClient` / `fetchAPI` helpers.
- **No shared code / no codegen** across `pkg/` and `ui/`. Response-shape changes
  ripple by hand: edit the Go handler/struct, then mirror it in `ui/src/types/`.
- **Config is env-driven** (`pkg/common/common.go` `LoadEnvs()`): `PORT`,
  `JWT_SECRET`, `DB_TYPE`/`DB_DSN` (sqlite default → `dev.db`), `KITE_ENCRYPT_KEY`,
  `KITE_BASE`, `AUTH_PROXY_*`, `ANONYMOUS_USER_ENABLED`, etc. Read config from the
  `common` package vars, not `os.Getenv` scattered in handlers.
- **Cluster access**: clusters are persisted in the DB and built from kubeconfig
  content or in-cluster config (`pkg/cluster/cluster_manager.go`). Requests pick a
  cluster via the `x-cluster-name` header / `ClusterMiddleware`.
- **Auth**: JWT in an httpOnly cookie + refresh; password, OAuth, API-key, and
  (fork) auth-proxy providers. Protected routes use `RequireAuth()`; admin routes
  add `RequireAdmin()`; resource routes add `RBACMiddleware()`.

## Where things live

```
.
├── main.go                 # entry: Gin engine, router wiring, static embed, graceful shutdown
├── internal/load.go        # extra env/config loading (internal.LoadConfigFromEnv)
├── pkg/                     # backend (see pkg/AGENTS.md)
│   ├── handlers/            # HTTP handlers; handlers/resources/ = the k8s resource API
│   ├── cluster/             # multi-cluster manager (kubeconfig / in-cluster) + prometheus
│   ├── kube/                # k8s client, exec, log, proxy, terminal
│   ├── auth/ rbac/ model/   # users, roles, GORM models + DB init
│   ├── middleware/ common/  # gin middleware (auth, cluster, CORS, metrics) + config vars
│   ├── prometheus/ appview/ version/ utils/
├── ui/                      # frontend (see ui/AGENTS.md)
│   ├── src/{pages,components,lib,types,contexts,hooks,i18n}/
│   ├── vite.config.ts       # outDir → ../static
│   └── package.json         # pnpm scripts
├── static/                  # BUILD OUTPUT (embedded by main.go) — gitignored
├── charts/kite/             # upstream Helm chart
├── deploy/                  # upstream install.yaml
├── docs/                    # upstream VitePress docs site
├── scripts/                 # get-version.sh, release.sh, install-hooks.sh, …
├── Dockerfile, Dockerfile.binary, .golangci.yml
└── .github/workflows/       # ci.yml (upstream), homelab-cicd.yml (this fork), release.yaml, …
```

## Adding a feature — the cross-stack chain

The dashboard pattern: a new resource view = a **backend resource handler** +
**frontend types/page/route**. Canonical examples:

**Built-in resource (backend + frontend):** follow how `pods`/`deployments` are
wired.
1. **Backend handler** — register in `pkg/handlers/resources/handler.go`
   `RegisterRoutes`. Most resources are one line:
   `NewGenericResourceHandler[*T, *TList]("name", isClusterScoped, searchable)`.
   For custom behavior (scale, drain, extra routes) write a dedicated handler
   (`pod_handler.go`, `deployment_handler.go`) implementing the `resourceHandler`
   interface, using `registerCustomRoutes` for non-CRUD routes. Standard routes
   (`List/Get/Create/Update/Delete/Patch/history/describe`) are registered
   automatically per scope. See `pkg/AGENTS.md`.
2. **Frontend types** — add the resource to `ResourceType`, `ResourcesTypeMap`,
   and `ResourceTypeMap` in `ui/src/types/api.ts` (mirror the Go shape; reuse
   `kubernetes-types` where possible).
3. **Frontend data** — consume via the generic hooks in `ui/src/lib/api.ts`
   (`useResources`, `useResource`, `useResourcesWatch` for SSE, `updateResource`,
   etc.) — keyed off the resource string. Add a custom `api.ts` function only for
   non-CRUD endpoints (e.g. `scaleDeployment`).
4. **Frontend page + route** — add a page under `ui/src/pages/`, a route in
   `ui/src/routes.tsx`, a sidebar entry, and i18n keys in **both**
   `ui/src/i18n/locales/en.json` and `zh.json`.

**CRD-only view (frontend-only — the VPA fork example):** CRDs are already served
by the generic `/:crd` handler, so no backend change is needed. The fork's VPA
views (`ui/src/pages/vpa-list-page.tsx`, `vpa-detail.tsx`, `ui/src/types/vpa.ts`,
`ui/src/components/vpa-*.tsx`) fetch the CRD through the existing API and render a
custom UI. Replicate this shape for new CRD dashboards.

Mirror response-shape changes on **both** sides in the same change (see "Ripple
awareness" below) — there is no type sync to catch drift.

## Ripple awareness

Kite is one binary built from two components plus a GitOps deploy, so changes
ripple along two contracts. Check the other side before declaring a change done.

- **`pkg/` ↔ `ui/` (the JSON contract).** The backend's HTTP responses and the
  frontend's TypeScript types are **hand-mirrored — there is no codegen**. A Go
  handler/struct change that alters a response shape (a field, a list shape, a
  resource map entry) must be matched by hand in `ui/src/types/` (`api.ts`'s
  `ResourceType` / `ResourcesTypeMap` / `ResourceTypeMap`, or a dedicated file
  like `types/vpa.ts`), and vice-versa. Nothing fails the build on drift — the
  stale type silently keeps agreeing. The route shapes themselves
  (`/:namespace/:name`, cluster-scoped `/_all/:name`, the `x-cluster-name`
  header, `KITE_BASE` sub-path) are also a shared contract: change them in
  `pkg/` and `main.go` and you must update the `ui/src/lib` client/stream
  builders too. See `pkg/AGENTS.md` and `ui/AGENTS.md`.
- **`fork` branch ↔ `nantomarioni/homelab-manifests` (the deploy contract).**
  `.github/workflows/homelab-cicd.yml` builds `ghcr.io/nantomarioni/kite` on push
  to `fork` and `yq`-bumps `apps/kite/values.yaml` in the `homelab-manifests`
  repo (`.<repo>.image.tag`). Renaming the image, the chart values key, or the
  app path requires a matching change in `homelab-manifests` (and the homelab
  Helm chart there must stay consistent with this repo's container/port shape).
- **Fork hygiene (upstream `zxh326/kite`).** Keep the upstream diff small and
  rebase-friendly: the Go module path stays `github.com/zxh326/kite`, and
  fork-only backend code (auth-proxy) stays isolated to `pkg/auth/handler.go`,
  `pkg/common/common.go`, and `pkg/model/user.go`. Most fork features are
  frontend-only and consume the existing generic API (see the VPA example).

## When stuck

- Backend (handlers, k8s client, cluster manager, GORM, auth/RBAC) → `pkg/AGENTS.md`.
- Frontend (pages, hooks, types, i18n, theming) → `ui/AGENTS.md`.
- Upstream behavior / install / config reference → the README and the upstream
  docs at <https://kite.zzde.me> (and `docs/` in-repo). Remember they describe
  upstream `zxh326/kite`, not this fork's deploy flow.
- "Did I break the other component / the deploy?" → the "Ripple awareness"
  section above (the `pkg/` ↔ `ui/` JSON contract + the `homelab-manifests`
  deploy bump).
- Deploy/CI → `.github/workflows/homelab-cicd.yml` (this fork) and the
  `nantomarioni/homelab-manifests` repo (`apps/kite/`).

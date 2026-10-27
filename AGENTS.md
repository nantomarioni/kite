# Agent guide — kite

Primary agent guide for this repo. Nested guides: `pkg/AGENTS.md` (Go backend:
Gin API + Kubernetes client + GORM) and `ui/AGENTS.md` (React + TypeScript
frontend: Vite + TanStack Query). No `docs/` knowledge files of our own —
`docs/` is the upstream VitePress site.

## What this is

**Kite** is a self-hosted **Kubernetes dashboard** — one Go binary serving a
REST/SSE/WebSocket API *and* the embedded React SPA. Multi-cluster
(kubeconfig-discovered or in-cluster), browses/edits standard resources + CRDs,
streams pod logs/terminals, shows Prometheus metrics, and has its own
users/RBAC/OAuth layer on a SQL database.

| Component | Dir | Stack |
|---|---|---|
| Backend | `pkg/` + `main.go`/`app.go`/`routes.go`/`static.go` + `internal/` | Go 1.26, Gin, controller-runtime client, GORM (sqlite/mysql/postgres), JWT; embeds the UI via `//go:embed static` |
| Frontend | `ui/` | React 19 + TS 6, Vite 8, TanStack Query, Tailwind v4, Radix, Monaco, xterm.js; builds to `static/` |

They talk **only over HTTP** (`/api/v1`, `/api/auth`, `/api/users`,
`/api/v1/admin`). **No codegen**: `ui/src/types/` is hand-mirrored from the Go
response shapes.

### Fork status

Fork of upstream `kite-org/kite` (ex-`zxh326/kite`; origin `nantomarioni/kite`). **`main`** tracks
upstream; **`fork`** = `main` + local commits and is what deploys. The Go module
path stays `github.com/zxh326/kite` — don't rename it. Local additions (the
canonical "how we add features" examples): VPA views, **auth-proxy**
support, **OpenTelemetry tracing**, the homelab CI/CD workflow — one commit
per feature on top of upstream. The UI work is in `ui/`; backend touch points
are `pkg/auth/middleware.go` (auth-proxy + the `auth.authenticate` span),
`pkg/common/common.go`, `pkg/model/user.go`, plus tracing: `pkg/tracing/`, its
`main.go`/`app.go` wiring, one-line hooks in `pkg/cluster/cluster_manager.go`,
`pkg/kube/client.go`, `pkg/prometheus/client.go` and both Describe handlers,
and `ctx` plumbing through the user/cluster/oauth/rbac `pkg/model` funcs +
callers (a wide upstream diff — expect sync conflicts there).
Upstream is synced by replaying the fork's own commits onto upstream `main`
and landing them on `fork` with a merge commit (no force-push).
Keep the upstream diff small and rebase-friendly; add rather than rewrite.

> `README*.md` and `docs/` are upstream-authored (`kite.zzde.me`). Trust this
> file for fork behaviour (deploy target, branch).

## How to run things

Root `Makefile` wraps everything (`make help`); `pnpm` for the UI (`cd ui`).

```bash
make deps                 # pnpm install (ui) + go mod download
make dev                  # build, run Go binary with ANONYMOUS_USER_ENABLED=true, start Vite (proxies API to :8080)
make build                # frontend (→ static/) then backend (→ ./kite); make run serves on :8080 (PORT)
# Backend
go build -trimpath -o kite .   # needs static/ to exist (//go:embed) — run make frontend first
make test | make lint | make format   # go test ./... + ui vitest | go vet + golangci-lint v2.12.1 (./bin) | go fmt
# Frontend (cd ui)
pnpm run dev | build | lint | test | format   # build = tsc -b && vite build → ../static; test = vitest run
pnpm exec tsc --noEmit -p tsconfig.app.json   # typecheck (root `type-check` config has no sources)
docker build -t kite .    # node:24-alpine → golang:1.26-alpine → distroless/static, :8080
```

**Deploy (this fork):** `.github/workflows/homelab-cicd.yml` on push to `fork`
builds `ghcr.io/nantomarioni/kite:<short-sha>` (+ `:fork`) and `yq`-bumps
`.kite.image.tag` in `homelab-manifests/apps/kite/values.yaml` for ArgoCD.
Upstream's `release.yaml` / `charts/kite` / `deploy/` are not used here.

## Quality gate

Mirrors upstream `.github/workflows/ci.yml`:

```bash
make deps && make build       # both compile
make pre-commit               # format + lint (go vet, golangci-lint, ui eslint)
make test                     # go test -v ./... + cd ui && pnpm run test (vitest)
```

Minimum per component: backend `go vet ./... && golangci-lint run && go test
./...` (needs a `static/` dir; `TestSetupStatic` needs a real UI build);
frontend `cd ui && pnpm exec tsc -b && pnpm run lint && pnpm run test`.

## Conventions

- **One binary, embedded UI.** Gin owns routing; the SPA is served from the
  embedded `static/` with a `NoRoute` fallback (`static.go` `setupStatic`). API
  404s under `/api/` are JSON; everything else is `index.html`.
- **`KITE_BASE`** sub-path hosting: backend injects it into `index.html`,
  frontend reads `ui/src/lib/subpath.ts`. Never hardcode `/api/v1` client-side —
  use `apiClient` / `fetchAPI`.
- **No shared code / codegen** across `pkg/` and `ui/`: a response-shape change
  is edited in Go and mirrored by hand in `ui/src/types/`, same change.
- **Config is env-driven** via `pkg/common/common.go` `LoadEnvs()` (`PORT`,
  `JWT_SECRET`, `DB_TYPE`/`DB_DSN` — sqlite default `dev.db`, `KITE_ENCRYPT_KEY`,
  `KITE_BASE`, `AUTH_PROXY_*`, `ANONYMOUS_USER_ENABLED`). Read the `common`
  package vars, not scattered `os.Getenv`. Exception: `pkg/tracing` lets the
  OTel SDK read the standard `OTEL_*` env itself; no OTLP endpoint = tracing off.
- **Model functions take `ctx` first** (user/cluster/oauth/rbac; upstream's
  newer models don't yet — untraced, not wrong): handlers pass `c.Request.Context()`,
  startup/background `context.Background()`, writes that must finish after a
  client disconnect (history, login upserts) `context.WithoutCancel(ctx)`. Gin
  `ContextWithFallback` is on, so `c` is a valid context — but never use `c` in
  a goroutine outliving the handler (`c.Copy()` + `context.WithoutCancel`).
- **Clusters** persist in the DB (`pkg/cluster/cluster_manager.go`); a request
  selects one via the `x-cluster-name` header (`ClusterMiddleware`).
- **Auth**: JWT in an httpOnly cookie + refresh; password / OAuth / API-key /
  passkey/MFA / (fork) auth-proxy. `RequireAuth()` (`pkg/auth/middleware.go`) →
  `RequireAdmin()` → `RBACMiddleware()`.

## Where things live

```
main.go                 # entry: cluster-agent subcommand, tracing init, server + graceful shutdown
app.go                  # initializeApp (env, DB, RBAC, config, clusters) + buildEngine (middleware chain)
routes.go static.go     # all API route groups; embedded SPA + NoRoute fallback
internal/               # config file / env loading (load.go, config.go)
pkg/                    # backend (pkg/AGENTS.md): resources/ (k8s API), cluster/ kube/ auth/ rbac/ model/ users/ …
ui/                     # frontend (ui/AGENTS.md): src/{pages,components,lib,types,contexts,hooks,i18n}, vite.config.ts (outDir ../static)
static/                 # BUILD OUTPUT embedded by static.go — gitignored
charts/kite/ deploy/ docs/   # upstream Helm chart, install.yaml, VitePress docs (not used by the fork deploy)
scripts/                # get-version.sh, release.sh, install-hooks.sh
.github/workflows/      # ci.yml (upstream), homelab-cicd.yml (fork), release.yaml
```

## Adding a feature — the cross-stack chain

A new resource view = backend handler + frontend types/page/route.

**Built-in resource:** follow `pods`/`deployments`.
1. **Backend** — register in `pkg/resources/handler.go` `RegisterRoutes`
   (usually one `NewGenericResourceHandler[*T, *TList](...)` line) and keep
   `pkg/common/resource.go` in sync. Custom behaviour = a dedicated handler
   (`pod_handler.go`). See `pkg/AGENTS.md`.
2. **Catalog** — one entry in `ui/src/lib/resource-catalog.ts`; sidebar,
   routes, breadcrumbs and search derive from it.
3. **Types** — `ResourcesTypeMap` / `ResourceTypeMap` in `ui/src/types/api.ts`.
4. **Pages** — custom list/detail in `ui/src/pages/resource-definitions.tsx`;
   detail pages build on `ResourceDetailShell` + `ResourceOverview`. i18n keys
   in **both** `en.json` and `zh.json`.

**CRD-only view (frontend-only — the VPA example):** CRDs are served by the
generic `/:crd` handler as `<plural>.<group>`; VPA is a catalog entry
`verticalpodautoscalers` whose pages (`ui/src/pages/vpa-*.tsx`,
`ui/src/types/vpa.ts`, `ui/src/components/vpa-*.tsx`) call the API with
`verticalpodautoscalers.autoscaling.k8s.io`. Replicate for new CRD dashboards.

## Ripple awareness

Check the other side before declaring done. Siblings are `../<repo>` checkouts
(`github.com/nantomarioni/<repo>`).

- **`pkg/` ↔ `ui/` (intra-repo JSON contract).** Hand-mirrored types — nothing
  fails the build on drift. Route shapes (`/:namespace/:name`, cluster-scoped
  `/_all/:name`, `x-cluster-name`, `KITE_BASE`) are shared too: change them in
  `pkg/`/`routes.go` and update the `ui/src/lib` client/stream builders.
- **`homelab-manifests`** (`apps/kite/`) — the CI bump path `.kite.image.tag`
  in `values.yaml`; the chart's `extraEnvs` configure this fork's auth-proxy:
  `AUTH_PROXY_ENABLED=true`, `AUTH_PROXY_HEADER_{NAME,EMAIL,GROUPS,USERNAME,UID}`
  = `X-Authentik-*` (`AUTH_PROXY_DEFAULT_ROLE` is parsed but unused); its Traefik `Middleware`
  `authentik-auth` forwards exactly those `authResponseHeaders`. Renaming an
  `AUTH_PROXY_*` env var in `pkg/common/common.go` or the image/port shape is a
  change there too. `extraEnvs` also set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
  (VictoriaTraces URL, pinned by its `fullnameOverride`) and
  `OTEL_SERVICE_NAME=kite`; kite continues Traefik's `traceparent`.
- **`homelab`** — the Authentik proxy provider for `kite.antomarioni.com`
  (`terraform/3-core-config/authentik-kite.tf`, `forward_domain` mode) is what
  populates the `X-Authentik-*` headers; group → role mapping on the kite side
  assumes Authentik group names.
- **Upstream `kite-org/kite`** (remote `upstream`) — fork-only backend code
  stays isolated to `pkg/auth/middleware.go`, `pkg/common/common.go`,
  `pkg/model/user.go` and `pkg/tracing/` (+ one-line hooks in
  `main.go`/`app.go`, `cluster_manager.go`,
  `pkg/kube/client.go`, `pkg/prometheus/client.go`, the Describe handlers); the
  `ctx`-first `pkg/model` signatures touch many upstream callers. Most fork
  features are frontend-only on the generic API.

## When stuck

- Backend (handlers, k8s client, cluster manager, GORM, auth/RBAC) → `pkg/AGENTS.md`.
- Frontend (pages, hooks, types, i18n, theming) → `ui/AGENTS.md`.
- Upstream behaviour / config reference → README + <https://kite.zzde.me>
  (describes upstream, not this fork's deploy).
- Deploy/CI → `.github/workflows/homelab-cicd.yml` + `../homelab-manifests/apps/kite/`.

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
| Backend | `pkg/` + `main.go` + `internal/` | Go 1.25, Gin, controller-runtime client, GORM (sqlite/mysql/postgres), JWT; embeds the UI via `//go:embed static` |
| Frontend | `ui/` | React 19 + TS 5, Vite 7, TanStack Query, Tailwind v4, Radix, Monaco, xterm.js; builds to `static/` |

They talk **only over HTTP** (`/api/v1`, `/api/auth`, `/api/users`,
`/api/v1/admin`). **No codegen**: `ui/src/types/` is hand-mirrored from the Go
response shapes.

### Fork status

Fork of upstream `zxh326/kite` (origin `nantomarioni/kite`). **`main`** tracks
upstream; **`fork`** = `main` + local commits and is what deploys. The Go module
path stays `github.com/zxh326/kite` — don't rename it. Local additions (the
canonical "how we add features" examples): VPA views, per-container resource
usage, pod termination reason / resource config, app-view, **auth-proxy**
support, the homelab CI/CD workflow. Most fork work is in `ui/`; backend touch
points are `pkg/auth/handler.go`, `pkg/common/common.go`, `pkg/model/user.go`.
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
make test | make lint | make format   # go test ./... | go vet + golangci-lint v2.7.2 (./bin) | go fmt
# Frontend (cd ui)
pnpm run dev | build | lint | type-check | format   # build = tsc -b && vite build → ../static
docker build -t kite .    # node:20-alpine → golang:1.25-alpine → distroless/static, :8080
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
make test                     # go test -v ./...
```

Minimum per component: backend `go vet ./... && golangci-lint run && go test
./...`; frontend `cd ui && pnpm run type-check && pnpm run lint`. There are
**no frontend unit tests**; Go tests are sparse (e.g.
`pkg/handlers/resources/pod_handler_test.go`).

## Conventions

- **One binary, embedded UI.** Gin owns routing; the SPA is served from the
  embedded `static/` with a `NoRoute` fallback (`main.go` `setupStatic`). API
  404s under `/api/` are JSON; everything else is `index.html`.
- **`KITE_BASE`** sub-path hosting: backend injects it into `index.html`,
  frontend reads `ui/src/lib/subpath.ts`. Never hardcode `/api/v1` client-side —
  use `apiClient` / `fetchAPI`.
- **No shared code / codegen** across `pkg/` and `ui/`: a response-shape change
  is edited in Go and mirrored by hand in `ui/src/types/`, same change.
- **Config is env-driven** via `pkg/common/common.go` `LoadEnvs()` (`PORT`,
  `JWT_SECRET`, `DB_TYPE`/`DB_DSN` — sqlite default `dev.db`, `KITE_ENCRYPT_KEY`,
  `KITE_BASE`, `AUTH_PROXY_*`, `ANONYMOUS_USER_ENABLED`). Read the `common`
  package vars, not scattered `os.Getenv`.
- **Clusters** persist in the DB (`pkg/cluster/cluster_manager.go`); a request
  selects one via the `x-cluster-name` header (`ClusterMiddleware`).
- **Auth**: JWT in an httpOnly cookie + refresh; password / OAuth / API-key /
  (fork) auth-proxy. `RequireAuth()` → `RequireAdmin()` → `RBACMiddleware()`.

## Where things live

```
main.go                 # Gin engine, router wiring, static embed, graceful shutdown
internal/load.go        # extra env/config loading
pkg/                    # backend (pkg/AGENTS.md): handlers/ (resources/ = k8s API), cluster/, kube/,
                        #   auth/ rbac/ model/, middleware/ common/, prometheus/ appview/ version/ utils/
ui/                     # frontend (ui/AGENTS.md): src/{pages,components,lib,types,contexts,hooks,i18n}, vite.config.ts (outDir ../static)
static/                 # BUILD OUTPUT embedded by main.go — gitignored
charts/kite/ deploy/ docs/   # upstream Helm chart, install.yaml, VitePress docs (not used by the fork deploy)
scripts/                # get-version.sh, release.sh, install-hooks.sh
.github/workflows/      # ci.yml (upstream), homelab-cicd.yml (fork), release.yaml
```

## Adding a feature — the cross-stack chain

A new resource view = backend handler + frontend types/page/route.

**Built-in resource:** follow `pods`/`deployments`.
1. **Backend** — register in `pkg/handlers/resources/handler.go` `RegisterRoutes`;
   usually one line `NewGenericResourceHandler[*T, *TList]("name", isClusterScoped, searchable)`.
   Custom behaviour = a dedicated handler (`pod_handler.go`) implementing
   `resourceHandler`, extra routes via `registerCustomRoutes`. See `pkg/AGENTS.md`.
2. **Types** — add to `ResourceType`, `ResourcesTypeMap`, `ResourceTypeMap` in
   `ui/src/types/api.ts` (reuse `kubernetes-types`).
3. **Data** — generic hooks in `ui/src/lib/api.ts` (`useResources`,
   `useResource`, `useResourcesWatch` SSE, `updateResource`); custom `api.ts`
   functions only for non-CRUD endpoints (`scaleDeployment`).
4. **Page + route** — `ui/src/pages/`, `ui/src/routes.tsx`, sidebar entry, i18n
   keys in **both** `ui/src/i18n/locales/en.json` and `zh.json`.

**CRD-only view (frontend-only — the VPA example):** CRDs are already served by
the generic `/:crd` handler; `ui/src/pages/vpa-list-page.tsx`, `vpa-detail.tsx`,
`ui/src/types/vpa.ts`, `ui/src/components/vpa-*.tsx` fetch through the existing
API. Replicate for new CRD dashboards.

## Ripple awareness

Check the other side before declaring done. Siblings are `../<repo>` checkouts
(`github.com/nantomarioni/<repo>`).

- **`pkg/` ↔ `ui/` (intra-repo JSON contract).** Hand-mirrored types — nothing
  fails the build on drift. Route shapes (`/:namespace/:name`, cluster-scoped
  `/_all/:name`, `x-cluster-name`, `KITE_BASE`) are shared too: change them in
  `pkg/`/`main.go` and update the `ui/src/lib` client/stream builders.
- **`homelab-manifests`** (`apps/kite/`) — the CI bump path `.kite.image.tag`
  in `values.yaml`; the chart's `extraEnvs` configure this fork's auth-proxy:
  `AUTH_PROXY_ENABLED=true`, `AUTH_PROXY_HEADER_{NAME,EMAIL,GROUPS,USERNAME,UID}`
  = `X-Authentik-*`, `AUTH_PROXY_DEFAULT_ROLE=guest`; its Traefik `Middleware`
  `authentik-auth` forwards exactly those `authResponseHeaders`. Renaming an
  `AUTH_PROXY_*` env var in `pkg/common/common.go` or the image/port shape is a
  change there too.
- **`homelab`** — the Authentik proxy provider for `kite.antomarioni.com`
  (`terraform/3-core-config/authentik-kite.tf`, `forward_domain` mode) is what
  populates the `X-Authentik-*` headers; group → role mapping on the kite side
  assumes Authentik group names.
- **Upstream `zxh326/kite`** — fork-only backend code stays isolated to
  `pkg/auth/handler.go`, `pkg/common/common.go`, `pkg/model/user.go`; most fork
  features are frontend-only on the generic API.

## When stuck

- Backend (handlers, k8s client, cluster manager, GORM, auth/RBAC) → `pkg/AGENTS.md`.
- Frontend (pages, hooks, types, i18n, theming) → `ui/AGENTS.md`.
- Upstream behaviour / config reference → README + <https://kite.zzde.me>
  (describes upstream, not this fork's deploy).
- Deploy/CI → `.github/workflows/homelab-cicd.yml` + `../homelab-manifests/apps/kite/`.

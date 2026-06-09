# Agent guide — kite backend (`pkg/`)

The Go side of kite: a Gin HTTP server that brokers Kubernetes (multi-cluster)
and owns kite's own users/RBAC/OAuth in a SQL DB. Read the root `AGENTS.md`
first for the big picture, fork status, and the cross-stack feature chain.

## Stack & entry

- **Go 1.25**, module `github.com/zxh326/kite` (don't rename — it's a fork).
- **Gin** for HTTP; routing is wired in `main.go` (`setupAPIRouter` /
  `setupStatic`), not in `pkg/`.
- **`sigs.k8s.io/controller-runtime` client** (`pkg/kube`) for typed k8s access,
  plus `client-go` for exec/log/terminal/proxy.
- **GORM** (`pkg/model`) over sqlite (default, `dev.db`), mysql, or postgres.
- **Prometheus client** for metrics endpoints; `klog` for logging.

## Layout

```
pkg/
├── handlers/                 # HTTP handlers (the API surface)
│   ├── resources/            # the Kubernetes resource API (the heart of the app)
│   │   ├── handler.go        # resourceHandler interface + RegisterRoutes + route registration
│   │   ├── generic_resource_handler.go   # NewGenericResourceHandler[T,TList] — generic CRUD
│   │   ├── pod_handler.go deployment_handler.go node_handler.go event_handler.go cr_handler.go
│   │   ├── related_resources.go          # Deployment→Pods etc.
│   │   └── pod_handler_test.go
│   ├── overview_handler.go prom_handler.go logs_handler.go terminal_handler.go
│   ├── node_terminal_handler.go search_handler.go proxy_handler.go
│   ├── resource_apply_handler.go image_tags_handler.go template_handler.go user_handler.go apikey_handler.go
├── cluster/                  # ClusterManager: build ClientSets from kubeconfig / in-cluster; prometheus discovery
├── kube/                     # K8sClient wrapper, exec.go, log.go, proxy.go, terminal.go
├── auth/                     # auth handler: password / OAuth / API-key / (fork) auth-proxy; JWT cookies
├── rbac/                     # role definitions + RBAC enforcement helpers
├── model/                    # GORM models + InitDB (AutoMigrate); user/cluster/oauth/role/template/history
├── middleware/               # auth, cluster (x-cluster-name), cors, logger, metrics, rbac
├── common/                   # config vars + LoadEnvs(); shared types; rbac constants
├── prometheus/ appview/ version/ utils/
```

## Request pipeline (from `main.go`)

Global middleware: `Metrics → gzip(opt) → Recovery → Logger → CORS`. Then route
groups under `common.Base`:

- **Public:** `/healthz`, `/api/v1/version`, `/api/v1/init_check`, `/api/auth/*`.
- **Admin** (`/api/v1/admin`): `RequireAuth()` + `RequireAdmin()` — clusters,
  oauth-providers, roles, users, apikeys, templates. (The bootstrap
  `create_super_user` + `clusters/import` are intentionally pre-auth until setup
  completes.)
- **Protected** (`/api/v1`): `RequireAuth()` + `ClusterMiddleware(cm)`. Resource
  routes additionally apply `RBACMiddleware()` before
  `resources.RegisterRoutes(api)`.

## The resource handler pattern (most important)

Every k8s resource type is a `resourceHandler` (interface in
`handlers/resources/handler.go`) registered by string key in `RegisterRoutes`:

```go
"services": NewGenericResourceHandler[*corev1.Service, *corev1.ServiceList]("services", false /*clusterScoped*/, true /*searchable*/),
"deployments": NewDeploymentHandler(),  // dedicated handler for extra behavior
```

- **Generic CRUD** comes from `GenericResourceHandler[T, TList]` — covers
  `List/Get/Create/Update/Delete/Patch/ListHistory/Describe`, YAML marshalling,
  soft history recording, search, and SSE watch. For a plain resource, one
  registration line is the whole feature.
- **Custom behavior**: embed the generic handler in a named struct and add
  methods (see `DeploymentHandler.Restart`, `pod_handler.go`,
  `node_handler.go`). Implement the `Restartable` interface for restart support.
  Register non-CRUD routes by overriding `registerCustomRoutes(group)`
  (e.g. `/scale`, `/drain`, `/files`).
- **Route shapes** are auto-generated per scope in `registerNamespaceScopeRoutes`
  / `registerClusterScopeRoutes`. Namespaced: `/:namespace/:name`; cluster-scoped:
  `/_all/:name`. The client uses `_all` as the "no namespace" sentinel.
- **CRDs** are handled generically by `CRHandler` via the catch-all `/:crd`
  group — **no per-CRD backend code needed**. (The fork's VPA views ride this.)
- **Related resources** and **search** are opt-in: add the resource type to the
  `supportedRelatedResourceTypes` list / pass `searchable=true`.

Inside a handler, get the active cluster client and user from the gin context:
`cs := c.MustGet("cluster").(*cluster.ClientSet)` (set by `ClusterMiddleware`)
and `c.MustGet("user").(model.User)`. Talk to k8s via `cs.K8sClient` (the
controller-runtime client).

## Multi-cluster & config

- `cluster.NewClusterManager()` (called in `main.go`) loads clusters from the DB;
  each `ClientSet` is built from kubeconfig content
  (`createClientSetFromConfig`) or in-cluster config (`createClientSetInCluster`)
  in `pkg/cluster/cluster_manager.go`. Prometheus URL is per-cluster
  (discovered or configured).
- The active cluster per request comes from the **`x-cluster-name`** header,
  resolved by `middleware.ClusterMiddleware`.
- **All env config** lives in `pkg/common/common.go` (`LoadEnvs()`): `PORT`,
  `JWT_SECRET`, `DB_TYPE`/`DB_DSN`, `KITE_ENCRYPT_KEY`, `KITE_BASE`,
  `ANONYMOUS_USER_ENABLED`, `DISABLE_GZIP`, and the fork's `AUTH_PROXY_*` set.
  Read these package vars; don't sprinkle `os.Getenv`. `internal/load.go`
  (`internal.LoadConfigFromEnv`) handles additional config.

## Database

`model.InitDB()` opens the GORM connection per `DBType`/`DBDSN` and
`AutoMigrate`s the model structs (`pkg/model/*.go`: user, cluster, oauth, rbac,
template, resource_history). New persisted entity → add the struct + include it
in the `AutoMigrate` list in `pkg/model/model.go`. Secrets (e.g. kubeconfig,
oauth client secret) are encrypted with `KITE_ENCRYPT_KEY` (`custom_type.go`).

## Conventions & quality gate

- **Lint is strict** — `.golangci.yml` (v2) enables `errcheck`, `staticcheck`,
  `gocritic`, `gocyclo`, `govet`, `dupl`, `unparam`, `unused`, `misspell`, etc.,
  with `go 1.25`. `ui/` is excluded. Keep functions under the cyclomatic limit;
  handle every error.
- Gate before done: `go vet ./...`, `golangci-lint run`, `go test ./...`
  (`make lint` + `make test` cover these; `make format` = `go fmt`).
- **Auth-proxy is fork code** (`pkg/auth/handler.go`, `pkg/common/common.go`,
  `pkg/model/user.go`) — keep changes there minimal and isolated to preserve
  rebase-friendliness against upstream.
- A handler change that alters a JSON response shape **must** be mirrored in
  `ui/src/types/` by hand — there is no codegen (see `ui/AGENTS.md`).

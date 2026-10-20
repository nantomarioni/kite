# Agent guide — kite backend (`pkg/`)

The Go side: a Gin server brokering Kubernetes (multi-cluster) and owning
kite's users/RBAC/OAuth in a SQL DB. Routing is wired in the root
`routes.go` (`setupAPIRouter`) and `static.go` (`setupStatic`), the engine in
`app.go` (`buildEngine`), not here. controller-runtime client
(`pkg/kube`) + `client-go` for exec/log/terminal/proxy; GORM over
sqlite/mysql/postgres; `klog` logging.

## Layout

```
pkg/
├── resources/                # the Kubernetes resource API (the heart of the app)
│   ├── handler.go            # resourceHandler interface + RegisterRoutes + route registration
│   ├── generic_resource_handler*.go  # NewGenericResourceHandler[T,TList] — generic CRUD/list/write/history+Describe
│   ├── pod_handler.go deployment_handler.go node_handler.go event_handler.go cr_handler.go logs_handler.go
│   └── related_resources.go apply_handler.go resolve_handler.go  (+ *_test.go)
├── users/ apikeys/ templates/ settings/ system/ search/ metrics/ proxy/ terminal/ images/ helm/ ai/ plugins/
│                             # one package per remaining API area (handler.go each)
├── cluster/ clusteragent/    # ClusterManager (ClientSets from kubeconfig / in-cluster / cluster agent); prometheus
├── kube/                     # K8sClient wrapper, exec.go, log.go, proxy.go, terminal.go
├── auth/                     # login/bootstrap/oauth handlers; middleware.go = RequireAuth (+ fork auth-proxy); JWT
├── mfa/ passkey/             # TOTP + WebAuthn
├── rbac/                     # role definitions + RBAC enforcement helpers
├── model/                    # GORM models + InitDB (AutoMigrate); user/cluster/oauth/role/template/history
├── middleware/               # auth, cluster (x-cluster-name), cors, logger, metrics, rbac
├── common/                   # config vars + LoadEnvs(); shared types; rbac constants
├── tracing/                  # (fork) OTel: server, HTTP transport, k8s, GORM, Prometheus, describe
├── prometheus/ appview/ version/ utils/
```

## Request pipeline (`app.go` + `routes.go`)

Global: `tracing (if enabled) → Metrics → gzip(opt) → Recovery → Logger → CORS`; groups under `common.Base`:
**Public** `/healthz`, `/metrics`, `/api/v1/version`, `/api/v1/bootstrap`,
`/api/auth/*`, cluster-agent connect/register; **Admin** `/api/v1/admin` = `RequireAuth()` + `RequireAdmin()`;
**Protected** `/api/v1` = `RequireAuth()` + `ClusterMiddleware(cm)`, resource
routes add `RBACMiddleware()` before `resources.RegisterRoutes(api)`.
Inner-layer spans (k8s, GORM, Prometheus, describe) exist only under a request
span (no orphan informer traces); upgrade/exec/WS are skipped.

## The resource handler pattern (most important)

Every k8s resource type is a `resourceHandler` (interface in
`resources/handler.go`) registered by string key in `RegisterRoutes`:

```go
"services": NewGenericResourceHandler[*corev1.Service, *corev1.ServiceList]("services", false /*clusterScoped*/, true /*searchable*/),
"deployments": NewDeploymentHandler(),  // dedicated handler for extra behavior
```

- **Generic CRUD** (`GenericResourceHandler[T, TList]`) covers
  `List/Get/Create/Update/Delete/Patch/ListHistory/Describe`, YAML, history,
  search, SSE watch — one registration line is the whole feature.
- **Custom behaviour**: embed the generic handler in a named struct
  (`DeploymentHandler.Restart`, `pod_handler.go`, `node_handler.go`); implement
  `Restartable` for restart; override `registerCustomRoutes(group)` for
  non-CRUD routes (`/scale`, `/drain`, `/files`).
- **Route shapes** are auto-generated per scope in `registerNamespaceScopeRoutes`
  / `registerClusterScopeRoutes`. Namespaced: `/:namespace/:name`; cluster-scoped:
  `/_all/:name`. The client uses `_all` as the "no namespace" sentinel.
- **CRDs** are handled generically by `CRHandler` via the catch-all `/:crd`
  group — no per-CRD backend code (the fork VPA views ride this).
- **Related resources** and **search** are opt-in: add the resource type to the
  `supportedRelatedResourceTypes` list / pass `searchable=true`.

In a handler: `cs := c.MustGet("cluster").(*cluster.ClientSet)` (set by `ClusterMiddleware`)
and `c.MustGet("user").(model.User)`. Talk to k8s via `cs.K8sClient` (the
controller-runtime client).

## Multi-cluster & config

- `cluster.NewClusterManager()` loads clusters from the DB; each `ClientSet` is
  built from kubeconfig content or in-cluster config
  (`pkg/cluster/cluster_manager.go`); Prometheus URL is per-cluster. The active
  cluster per request = **`x-cluster-name`** header (`middleware.ClusterMiddleware`).
- **All env config** is in `pkg/common/common.go` `LoadEnvs()` (incl. the fork's
  `AUTH_PROXY_*` set — a contract with `../homelab-manifests/apps/kite/values.yaml`,
  see root Ripple awareness). Read the package vars; don't sprinkle `os.Getenv`.

## Database

`model.InitDB()` opens the GORM connection per `DBType`/`DBDSN` and
`AutoMigrate`s the model structs (`pkg/model/*.go`: user, cluster, oauth, rbac,
template, resource_history, passkey, settings, …). New persisted entity → add the struct + include it
in the `AutoMigrate` list in `pkg/model/model.go`. Secrets (e.g. kubeconfig,
oauth client secret) are encrypted with `KITE_ENCRYPT_KEY` (`custom_type.go`).
User/cluster/oauth/rbac model funcs take `ctx` first; `tracing.InstrumentDB` spans each statement
with placeholder SQL only.

## Conventions & quality gate

- **Lint is strict** (`.golangci.yml` v2: `errcheck`, `gocyclo`, `dupl`, …):
  handle every error, stay under the cyclomatic limit. Gate: `make lint` +
  `make test`.
- **Auth-proxy is fork code** (`pkg/auth/middleware.go`, `pkg/common/common.go`,
  `pkg/model/user.go`) — keep it minimal and isolated for rebases.
- A JSON response-shape change **must** be mirrored by hand in `ui/src/types/`
  (no codegen; see `ui/AGENTS.md`).

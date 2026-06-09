# Agent guide — kite frontend (`ui/`)

The React SPA for kite. Built with Vite to `../static/`, then **embedded into the
Go binary** — it is not deployed separately. Read the root `AGENTS.md` first for
the big picture, fork status, and the cross-stack feature chain.

## Stack

- **React 19 + TypeScript 5**, **Vite 7** (`vite.config.ts`).
- **pnpm** is the package manager (`pnpm-lock.yaml`). `cd ui` before running it.
- **TanStack Query** (`@tanstack/react-query`) for all server state + caching.
- **TanStack Table** for data tables; **Tailwind CSS v4** + **Radix UI** +
  shadcn-style components (`components.json`, "new-york", base `neutral`) for UI.
- **Monaco editor** for YAML editing; **xterm.js** for terminals; **recharts** for
  metrics; **react-router-dom v7** for routing; **i18next** for en/zh.

## Commands (`cd ui`)

```bash
pnpm install
pnpm run dev          # Vite dev server (proxies /api → http://localhost:8080, see vite.config.ts)
pnpm run build        # tsc -b && vite build → ../static
pnpm run lint         # eslint .   (eslint.config.js, typescript-eslint + react-hooks)
pnpm run type-check   # tsc --noEmit
pnpm run format       # prettier --write .
```

Quality gate (no unit test runner exists here): **`pnpm run type-check` +
`pnpm run lint` must be clean**, and `vite build` must succeed (covered by
`make build` at repo root). Usually run together with the backend via
`make dev` from the repo root.

## Layout

```
ui/src/
├── main.tsx App.tsx routes.tsx     # bootstrap, shell, router (react-router-dom)
├── pages/                          # one file per route (overview, resource-list, resource-detail, settings, vpa-*, …)
├── components/                     # feature components + components/ui/ (shadcn primitives), chart/, editors/, AppView/
├── lib/
│   ├── api.ts                      # ALL data hooks/fns (useResources, useResource, mutations, SSE/WS streams)
│   ├── api-client.ts               # fetch wrapper w/ auth refresh + cluster header (apiClient)
│   ├── subpath.ts                  # KITE_BASE / dynamic-base handling (withSubPath, getWebSocketUrl)
│   ├── appview-api.ts useWebSocket.ts k8s.ts utils.ts favorites.ts query-provider.tsx
├── types/                          # api.ts (ResourceType maps), k8s.ts, vpa.ts, gateway.ts, sidebar.ts, themes.ts
├── contexts/                       # auth-context, cluster-context, sidebar-config-context
├── hooks/                          # use-cluster, use-favorites, use-mobile, use-page-title, use-query, …
├── i18n/locales/{en,zh}.json       # translations (keep parallel)
└── styles/ index.css App.css
```

## The data layer (do this, not raw fetch)

All server access goes through **`src/lib/api.ts`**, which wraps
`apiClient` (`api-client.ts` — handles the auth cookie, 401 refresh, and the
`x-cluster-name` header) and exposes TanStack Query hooks. Don't call `fetch`
directly from a component.

- **Generic resource access** is keyed off the resource string and typed via the
  maps in `src/types/api.ts`:
  - `useResources(resource, namespace?, opts)` — list (paginated).
  - `useResourcesWatch(resource, namespace?, opts)` — **SSE** live list
    (`added`/`modified`/`deleted` events; uses `_all` for all namespaces).
  - `useResource(resource, name, namespace?)` — single object.
  - `updateResource` / `patchResource` / `createResource` / `deleteResource`,
    `useResourceHistory`, `useDescribe`, `useRelatedResources`.
  - Streams: `useLogsStream` / `useLogsWebSocket` (logs), terminals via xterm +
    `useWebSocket`.
- **The type contract** is hand-mirrored from the Go response shapes — there is
  **no codegen**. To add a resource type, extend `ResourceType`,
  `ResourcesTypeMap` (list shape), and `ResourceTypeMap` (single shape) in
  `src/types/api.ts`; reuse `kubernetes-types` for k8s objects. A backend
  response-shape change requires a matching hand-edit here.

## Adding a view

1. **Types** — add to `src/types/api.ts` (or a dedicated file like `types/vpa.ts`
   for a CRD).
2. **Data** — reuse the generic hooks in `api.ts`. Only add a bespoke `api.ts`
   function for a non-CRUD endpoint (mirror `scaleDeployment`, `drainNode`).
3. **Page + route** — new `pages/<name>.tsx`, register in `routes.tsx` (lazy-load
   heavy pages, see `AppView`), and add it to the sidebar config
   (`contexts/sidebar-config-context.tsx` / `types/sidebar.ts`).
4. **i18n** — add keys to **both** `i18n/locales/en.json` and `zh.json` (keep the
   trees parallel).

**CRD views need no backend change** — they fetch the CRD through the existing
generic API. The fork's **VPA** views are the canonical example: `types/vpa.ts`,
`pages/vpa-list-page.tsx` + `vpa-detail.tsx`, and `components/vpa-monitoring.tsx`
/ `vpa-resource-comparison.tsx`. Other fork additions: per-container resource
usage (`components/container-table.tsx`, `container-status-table.tsx`,
`pod-resource-usage.tsx`), surfaced on `pages/pod-detail.tsx`.

## Conventions

- **Imports via the `@/` alias** (`@/lib`, `@/components`, `@/types`, …) — not
  deep relative paths. Import order is enforced by
  `@ianvs/prettier-plugin-sort-imports` (`prettier.config.cjs`): react → 3rd-party
  → `@/types` → `@/lib` → `@/hooks` → `@/components/ui` → `@/components` →
  relative.
- **Prettier**: no semicolons, single quotes, 2-space, `trailingComma: es5`, LF.
- **shadcn/ui** primitives live in `components/ui/`; compose them, prefer Radix +
  Tailwind utility classes over custom CSS. Icons from **lucide-react** (and
  `@tabler/icons-react`).
- **Sub-path aware**: never hardcode `/api/v1` or `ws://` URLs — use
  `apiClient` / `fetchAPI` and the helpers in `lib/subpath.ts`
  (`withSubPath`, `getWebSocketUrl`). `KITE_BASE` is injected at runtime.
- **Multi-cluster**: the active cluster is the `current-cluster` localStorage key,
  sent as `x-cluster-name`; `apiClient` and the SSE/WS builders add it. Read it
  via the cluster context/hooks, don't re-implement.
- **i18n**: every user-facing string is a key in both locale files; use
  `react-i18next` (`useTranslation`). en/zh must stay structurally parallel.
- **Theming**: `next-themes` + the appearance/color-theme providers; respect the
  existing CSS variables rather than hardcoding colors.

# Agent guide — kite frontend (`ui/`)

The React SPA, built by Vite to `../static/` and **embedded in the Go binary**
(not deployed separately). Root `AGENTS.md` has the big picture + fork status.
Stack: React 19 + TS 5, Vite 7, pnpm, TanStack Query/Table, Tailwind v4 + Radix
+ shadcn (`components.json`, "new-york"), Monaco, xterm.js, recharts,
react-router-dom v7, i18next (en/zh).

## Commands (`cd ui`)

```bash
pnpm install
pnpm run dev          # Vite dev server (proxies /api → :8080)
pnpm run build        # tsc -b && vite build → ../static
pnpm run lint | type-check | format   # eslint . | tsc --noEmit | prettier --write .
```

Gate (no unit test runner): **`type-check` + `lint` clean** and `vite build`
succeeds (root `make build`).

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

All server access goes through **`src/lib/api.ts`** (wraps `apiClient` —
auth cookie, 401 refresh, `x-cluster-name`) as TanStack Query hooks. Never
`fetch` from a component.

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
- **The type contract** is hand-mirrored from Go (**no codegen**): extend
  `ResourceType`, `ResourcesTypeMap` (list), `ResourceTypeMap` (single) in
  `src/types/api.ts`; reuse `kubernetes-types`. A backend shape change needs a
  matching hand-edit here.

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

**CRD views need no backend change** (generic CRD API). Fork examples: VPA
(`types/vpa.ts`, `pages/vpa-list-page.tsx` + `vpa-detail.tsx`,
`components/vpa-*.tsx`); per-container usage (`components/container-table.tsx`,
`pod-resource-usage.tsx`) on `pages/pod-detail.tsx`.

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

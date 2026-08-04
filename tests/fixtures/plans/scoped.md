---
slug: scoped
created: 2026-01-01
status: active
phases: 7
handoffs: docs/handoffs/scoped/
memory: project_scoped
---

# Scoped test plan

One root fanning out to six phases whose Repos cells cover the whole scope
grammar: markdown around a name, a parenthetical aside, a comma list, an
undeclared cell (which must read as `all`), and a path that is a prefix of
another phase's repo. After phase 1, some sibling pairs are disjoint (they may
run as parallel sessions) and some share a tree (they must not).

Expected scopes: 1 `api-server` · 2 `api-server` · 3 `web-app` ·
4 `api-server,docs` · 5 `all` · 6 `packages/cart-api` · 7 `packages`.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Root      | —  | —    | `api-server`               | builds |
| 2 | Api       | 1  | 3    | api-server                 | builds |
| 3 | Web       | 1  | 2    | **web-app**                | builds |
| 4 | Both      | 1  | 3    | api-server, docs           | builds |
| 5 | Anything  | 1  | —    | —                          | builds |
| 6 | Cart      | 1  | 2, 3 | packages/cart-api (deploy) | builds |
| 7 | Packages  | 1  | 2, 3 | packages                   | builds |

**Blocking:** 1 is the root; 1 → {2, 3, 4, 5, 6, 7}.
**Independent:** 2 ∥ 3 (disjoint scopes) · 6 ∩ 7 (path prefix — same tree).

## Phases

### Phase 1 — Root
- **Goal:** root.
- **Size:** S
- **Exit criteria:** 1. builds
- **Verification:** `true`

### Phase 2 — Api
- **Goal:** api.
- **Size:** S
- **Exit criteria:** 1. builds
- **Verification:** `true`

### Phase 3 — Web
- **Goal:** web.
- **Size:** S
- **Exit criteria:** 1. builds
- **Verification:** `true`

### Phase 4 — Both
- **Goal:** both.
- **Size:** S
- **Exit criteria:** 1. builds
- **Verification:** `true`

### Phase 5 — Anything
- **Goal:** undeclared scope.
- **Size:** S
- **Exit criteria:** 1. builds
- **Verification:** `true`

### Phase 6 — Cart
- **Goal:** one package.
- **Size:** S
- **Exit criteria:** 1. builds
- **Verification:** `true`

### Phase 7 — Packages
- **Goal:** the packages tree.
- **Size:** S
- **Exit criteria:** 1. builds
- **Verification:** `true`

## End-to-end verification

`true`

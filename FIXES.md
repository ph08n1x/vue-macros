# better-define / api Resolver Fixes

## Summary

This document captures the intermittent CI failure we hit in `@vue-macros/better-define`, what in the architecture was failing, and how it was fixed.

Observed failures included:

- `Cannot resolve TS type: ...`
- `Unexpected early exit... Unfinished hook action(s) on exit`

The failure was non-deterministic and typically reproduced only under high parallelism (CI / large builds).

## Architecture context

`better-define` delegates TypeScript props analysis to `@vue-macros/api`.

High-level flow:

1. Plugin transform entry: [`packages/better-define/src/index.ts`](./packages/better-define/src/index.ts)
2. Core transform orchestration: [`packages/better-define/src/core/index.ts`](./packages/better-define/src/core/index.ts)
3. SFC analysis and macro handling: [`packages/api/src/vue/analyze.ts`](./packages/api/src/vue/analyze.ts)
4. Props type resolution: [`packages/api/src/vue/props.ts`](./packages/api/src/vue/props.ts)
5. TS reference + namespace resolution:
   - [`packages/api/src/ts/resolve-reference.ts`](./packages/api/src/ts/resolve-reference.ts)
   - [`packages/api/src/ts/namespace.ts`](./packages/api/src/ts/namespace.ts)
   - [`packages/api/src/ts/resolve.ts`](./packages/api/src/ts/resolve.ts)

`resolveTSNamespace()` is a shared dependency in this chain: it builds the per-file type `exports` and `declarations` maps used by downstream reference resolution.

## Root cause

In [`packages/api/src/ts/namespace.ts`](./packages/api/src/ts/namespace.ts), `resolveTSNamespace(scope)` set `scope.exports` early, before all statements/imports were fully processed.

Important detail: in this implementation, the existence of `scope.exports` was effectively treated as a "namespace already resolved" flag, but in reality it only meant "namespace initialization has started."

Under concurrent transforms:

1. Call A starts namespace build for `scope`.
2. A sets `scope.exports = { [namespaceSymbol]: true }` near the beginning of the function.
3. A is still walking file statements (imports/exports/declarations) and has not finished populating `scope.declarations`.
4. Call B enters `resolveTSNamespace(scope)` for the same scope while A is in progress.
5. B hits `if (scope.exports) return ok()` and exits immediately, assuming namespace work is complete.
6. B then continues type resolution using `scope.declarations` that may still be partially populated.
7. Depending on timing, symbols may be missing (`undefined`) and reference resolution fails.
8. This surfaces as flaky unresolved-type errors that can disappear on rerun.

This produced CI flakiness (pass/fail on reruns with no code changes).

## Fixes implemented

### 1) Single-flight guard for namespace resolution

File: [`packages/api/src/ts/namespace.ts`](./packages/api/src/ts/namespace.ts)

- Added `namespaceResolveTasks` map:
  - `WeakMap<TSScope, { token: symbol; task: Promise<void> }>`
- If another chain is already resolving the same scope:
  - wait for the existing task to finish
  - return only after namespace is complete

This prevents reads of partially-built namespace state.

### 2) Re-entrant deadlock protection (owner token)

Files:

- [`packages/api/src/ts/namespace.ts`](./packages/api/src/ts/namespace.ts)
- [`packages/api/src/ts/resolve-reference.ts`](./packages/api/src/ts/resolve-reference.ts)
- [`packages/api/src/ts/resolve.ts`](./packages/api/src/ts/resolve.ts)

After introducing wait-on-inflight, a second issue appeared: re-entrant calls from the same resolution chain could end up waiting on their own task.

To fix this:

- Added `namespaceToken` propagation through the resolver chain.
- In `resolveTSNamespace`:
  - if in-flight task belongs to the same token, return immediately (same chain)
  - if token differs, wait (true concurrent chain)

This preserves synchronization across concurrent requests while preventing self-deadlock.

Example timeline (`A` and `B` resolving the same scope):

1. `A` starts `resolveTSNamespace(scope)` with token `tA`.
2. `A` registers in-flight task: `scope -> { token: tA, task: PromiseA }`.
3. During `A`'s own reference walk, `A` re-enters `resolveTSNamespace(scope, tA)`.
4. Resolver sees in-flight token is the same (`tA`) and returns immediately (re-entrant same chain; no self-wait).
5. Concurrently, `B` starts with token `tB` and calls `resolveTSNamespace(scope, tB)`.
6. Resolver sees in-flight token differs (`tA` vs `tB`), so `B` waits on `PromiseA`.
7. `A` completes namespace population and resolves `PromiseA`.
8. `B` resumes only after `A` finished, so `B` reads fully-populated declarations.

The key branch is:

```ts
if (inFlight.token === namespaceToken) return ok() // same chain, re-entrant
await inFlight.task                                 // different chain, wait
```

## Why this fixes the CI flakes

- Namespace population is now effectively serialized per scope.
- Concurrent callers cannot observe half-populated declarations.
- Re-entrant calls do not block on themselves.

Result: deterministic behavior under parallel transforms.

## Behavior impact

- No intentional semantic changes to type-resolution rules.
- The fix is synchronization-only around namespace construction.
- Existing supported TS patterns continue to behave the same, now with stable ordering.



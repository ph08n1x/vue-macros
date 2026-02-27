# defineProps Resolution Stability Fixes

This document summarizes the issues we encountered in `defineProps` type transformation, with concrete examples and how each code change addresses them.

## Problems We Hit

### 1. Deadlock in namespace resolution (hard hang)

- Symptom: a shard run stalls forever.
- Log signature: many `resolve:wait-start` entries and no matching `resolve:wait-end`.
- Concrete cycle observed:
  - Token `42` resolving `options.d.ts` waits on `vue.d.ts`.
  - Token `88` resolving `vue.d.ts` (from `index.d.ts`) waits on `options.d.ts`.
  - Circular wait: `42 -> 88` and `88 -> 42`.

### 2. "Too-early" / incomplete type resolution under cycle pressure

- Symptom: when avoiding deadlock, resolution can proceed before dependent namespace work fully settles.
- Impact: unresolved `TSTypeReference` values can remain after the first prop-resolution pass.

### 3. Duplicate concurrent work increases race windows

- Symptom:
  - Same TS file parsed repeatedly by concurrent transforms.
  - Same `(importer, id)` module/type resolution run repeatedly.
- Impact:
  - More contention and timing sensitivity.
  - Increased chance of unstable behavior in heavy parallel transforms.

### 4. Poor visibility for long waits

- Symptom: hard to distinguish normal contention from pathological waiting in CI.
- Impact: diagnosis is slow and uncertain.

## Fixes Implemented

### A. Cycle-safe wait handling in `resolveTSNamespace`

- File: `packages/api/src/ts/namespace.ts`
- Change:
  - Added token wait graph tracking.
  - Before waiting on in-flight owner, detect whether `request -> owner` introduces a cycle.
  - If cycle is found, skip the blocking wait (`resolve:wait-cycle-skip`).
- Why it helps:
  - Prevents hard deadlocks caused by cross-scope token cycles.

### B. Deferred retry after cycle-skip

- File: `packages/api/src/ts/namespace.ts`
- Change:
  - When a cycle wait is skipped, schedule a deferred retry after owner completion:
    - `resolve:wait-cycle-retry-scheduled`
    - `resolve:wait-cycle-retry-done`
    - `resolve:wait-cycle-retry-failed`
  - Added `waitForDeferredNamespaceResolutions()` helper.
- Why it helps:
  - Avoids "skip and forget" behavior; resolution gets another chance after graph convergence.

### C. Final completeness retry for prop definitions

- File: `packages/api/src/vue/props.ts`
- Change:
  - After initial `resolveNormal()` pass, count unresolved `TSTypeReference` property values.
  - If unresolved refs exist:
    - wait for deferred namespace retries
    - run one additional resolution pass
  - Logs:
    - `resolve:definitions-retry-start`
    - `resolve:definitions-retry-end`
- Why it helps:
  - Reduces incomplete `defineProps` outputs caused by transient cycle timing.

### D. Singleflight for TS file parsing/loading

- File: `packages/api/src/ts/scope.ts`
- Change:
  - Added in-flight task cache for `getTSFile(filePath)`.
  - Concurrent callers now share one read/parse promise.
- Why it helps:
  - Removes duplicated file parse work and narrows race windows.

### E. Singleflight for resolver work

- File: `packages/api/src/ts/resolve-file.ts`
- Change:
  - Added in-flight dedupe per `(importer, id)` in `resolveDts`.
  - Added singleflight `typesResolver` init and reset-on-init-failure behavior.
- Why it helps:
  - Avoids duplicate parallel resolution calls for identical targets.

### F. Wait-timeout diagnostics (non-invasive)

- File: `packages/api/src/ts/namespace.ts`
- Change:
  - Added soft timeout diagnostic log `resolve:wait-timeout` for long waits.
  - Does not force-cancel waits.
  - Env control:
    - `VUE_MACROS_API_WAIT_WARN_MS` (default `10000`)
- Why it helps:
  - Gives clear visibility for abnormal waits without altering correctness flow.

## Outcome

- Deadlocks are prevented.
- Early/incomplete resolution during cyclic contention is mitigated by deferred and final retry passes.
- Concurrency pressure is reduced through singleflight in key hot paths.
- CI and shard-level diagnosis is substantially improved through richer wait diagnostics.

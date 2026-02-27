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

## Detailed Log Walkthrough (Deadlock Case)

This section maps the observed locked-run logs to exact runtime behavior.

### Pre-fix Deadlock Sequence

1. Token `88` starts resolving Vue index types
- Log shape:
  - `resolve:start scope .../vue/types/index.d.ts tokenId: 88`
- Meaning:
  - `resolveTSNamespace()` creates an in-flight task and marks token `88` as owner for that scope.

2. Token `88` traverses import into `vue.d.ts`
- Log shape:
  - `resolve:import-hit ... source './vue' -> importScope .../vue/types/vue.d.ts`
  - `resolve:start scope .../vue/types/vue.d.ts tokenId: 88`
- Meaning:
  - token `88` now owns `vue.d.ts` resolution as part of index traversal.

3. Token `42` starts resolving `options.d.ts`
- Log shape:
  - `resolve:start scope .../vue/types/options.d.ts tokenId: 42`
- Meaning:
  - independent in-flight owner (`42`) for the options scope.

4. Token `42` tries to enter `vue.d.ts` (owned by `88`)
- Log shape:
  - `resolve:wait-start scope .../vue/types/vue.d.ts ownerTokenId: 88 requestTokenId: 42`
- Meaning:
  - token `42` is now waiting on token `88`.

5. Token `88` later tries to enter `options.d.ts` (owned by `42`)
- Log shape:
  - `resolve:wait-start scope .../vue/types/options.d.ts ownerTokenId: 42 requestTokenId: 88`
- Meaning:
  - token `88` is now waiting on token `42`.

Result:
- Circular wait: `42 -> 88` and `88 -> 42`
- Stuck state:
  - repeated `wait-start`
  - no `wait-end`
  - no final `resolve:done` for blocked scopes

### Post-fix Behavior on Same Pattern

1. First wait edge is recorded
- Example:
  - `42` waiting on `88` adds graph edge `42 -> 88`.

2. Second wait attempt checks for cycle
- Example:
  - `88` trying to wait on `42` asks if this creates cycle.
  - Since `42 -> 88` exists, `88 -> 42` would close a cycle.

3. Cyclic wait is skipped instead of blocked
- Log shape:
  - `resolve:wait-cycle-skip`
- Meaning:
  - deadlock is prevented by avoiding the second blocking wait.

4. Deferred retry is scheduled
- Log shape:
  - `resolve:wait-cycle-retry-scheduled`
  - later `resolve:wait-cycle-retry-done` (or `...-failed`)
- Meaning:
  - once owner finishes, skipped scope is retried to recover completeness.

5. `defineProps` pass performs final completeness retry
- Log shape:
  - `resolve:definitions-retry-start`
  - `resolve:definitions-retry-end`
- Meaning:
  - if unresolved `TSTypeReference` prop values remain after first pass,
    wait for deferred namespace retries and re-run one final resolution pass.

### Why This Combination Works

- Deadlock prevention:
  - cycle waits are no longer allowed to block forever.
- Resolution quality:
  - deferred namespace retry + final prop retry reduce transient incompleteness.
- Operational clarity:
  - timeout and cycle logs make CI issues inspectable and attributable.

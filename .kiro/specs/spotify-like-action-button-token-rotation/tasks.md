# Implementation Plan: spotify-like-action-button-token-rotation

## Overview

Extend the existing `spotify-like-action-button` Worker's `src/spotify/token.ts` so a Spotify-issued replacement `refresh_token` is persisted to a new KV binding instead of discarded, with a synchronous, best-effort write and a Secret fallback. Work proceeds bottom-up within the affected modules: first the KV binding and type additions, then the token-store read/write helpers inside `token.ts`, then the outcome/message threading through `like.ts`/`messages.ts`/`index.ts`, then the end-to-end properties that need the full handler. Deploy documentation and the `wrangler.toml` binding are independent of the runtime code and can proceed in parallel with the adapters.

Implementation language: **TypeScript** on the `workerd` runtime, extending the existing project (no new project scaffolding — `package.json`, `vitest.config.ts`, and the test harness from the base feature are reused as-is).

## Tasks

- [x] 1. KV binding and type additions
  - [x] 1.1 Add the `TOKEN_KV` binding to `wrangler.toml` and local dev types
    - Add a `[[kv_namespaces]]` block to `wrangler.toml` with `binding = "TOKEN_KV"`, using a placeholder id with an inline comment directing the Setup_Operator to replace it via `wrangler kv namespace create` (documented fully in task 5.1)
    - Confirm `wrangler dev` and the existing `vitest.config.ts` (`wrangler: { configPath: "./wrangler.toml" }`) pick up the binding as a local KV simulation with no other config change
    - _Requirements: 5.1, 6.1, 6.2_

  - [x] 1.2 Extend `src/types.ts` with the `TOKEN_KV` binding and the `rotationFailed` outcome field
    - Add `TOKEN_KV: KVNamespace` to the `Env` interface
    - Add the optional `rotationFailed?: boolean` field to the `Outcome` union's `added` case only; every other case is unchanged
    - _Requirements: 1.2, 3.1, 3.3_

- [x] 2. Token-store read and write
  - [x] 2.1 Implement the effective-refresh-token read with fallback
    - In `src/spotify/token.ts`, add `readEffectiveRefreshToken(env)` reading `env.TOKEN_KV.get("refresh_token")`, returning that value when present and non-empty, and returning `env.SPOTIFY_REFRESH_TOKEN` otherwise (including when the KV read throws or rejects)
    - Call this only when the in-isolate access-token cache is cold (i.e., only when an exchange is actually about to happen), matching the existing warm-cache early return in `getAccessToken`
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 2.2 Write property test for the effective refresh token
    - **Property 3: The effective refresh token prefers Token_Store and falls back to the Secret**
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [x] 2.3 Write property test for KV read failure degrading to fallback
    - **Property 7: A Token_Store read failure degrades to the same behavior as an empty Token_Store**
    - **Validates: Requirements 2.3, 3.1**

  - [x] 2.4 Implement rotated-refresh-token persistence
    - Add `persistRotatedRefreshToken(env, newRefreshToken)` writing `env.TOKEN_KV.put("refresh_token", newRefreshToken)` followed by `env.TOKEN_KV.put("rotated_at", <ISO 8601 timestamp>)`, returning `true` on success and `false` if either write throws or rejects (swallowing the error, not propagating it)
    - Wire it into `getAccessToken`: after a successful token-exchange response, if `body.refresh_token` is a non-empty string, call `persistRotatedRefreshToken` and record whether it succeeded; if `body.refresh_token` is absent or empty, skip the write entirely
    - Change `getAccessToken`'s success return value from a bare token string to `{token, rotationFailed}`, keeping the outer `Result<T, Failure>` shape and the `Failure`-producing paths (bad status, malformed body) exactly as they are today
    - Confirm `invalidateAccessToken()` is unchanged and touches only the in-isolate access-token cache, never `TOKEN_KV`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.5_

  - [x] 2.5 Write property test for rotation persistence
    - **Property 1: A rotated refresh token is persisted verbatim, and only when one is issued**
    - **Validates: Requirements 1.1, 1.2, 1.4**

  - [x] 2.6 Write property test for the rotation timestamp
    - **Property 2: A successful rotation always records a timestamp alongside the token**
    - **Validates: Requirements 1.3**

  - [x] 2.7 Write property test for the bootstrap secret's immutability
    - **Property 4: The bootstrap secret is never overwritten**
    - **Validates: Requirements 2.4**

  - [x] 2.8 Write unit tests for cache warmth and cache-invalidation boundaries
    - Assert a warm access-token cache causes zero calls to `env.TOKEN_KV.get` (the KV read only happens when an exchange is about to occur)
    - Assert `invalidateAccessToken()` does not call any `TOKEN_KV` method
    - Assert the stale-token retry path's second `getAccessToken` call (see `src/like.ts`) also reads `TOKEN_KV`, not just the Secret, after the first call's cache was invalidated
    - _Requirements: 2.1, 2.4_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Outcome, message, and handler threading
  - [x] 4.1 Thread `rotationFailed` through `likeCurrentTrack`
    - In `src/like.ts`, destructure `getAccessToken`'s new `{token, rotationFailed}` result and pass `rotationFailed` through to the `{kind: "added", track, rotationFailed}` return only; every other return statement in `likeCurrentTrack` is unchanged
    - Use `rotationFailed || undefined` so the field is omitted (not `false`) whenever rotation didn't fail, keeping existing `toEqual({kind: "added", track})` assertions valid
    - Do not thread a rotation-failure flag from the stale-token retry's second `getAccessToken` call into the outcome (per design.md's explicit scope limit)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Add the rotation-warning message formatter
    - In `src/messages.ts`, extend `formatAddedMessage` to accept an optional second argument `{rotationFailed?: boolean}` and append the fixed suffix `（但 token 更新失敗，請留意）` when `rotationFailed` is true; the existing one-argument call shape continues to produce the unsuffixed message
    - _Requirements: 3.3_

  - [x] 4.3 Write property test for the rotation-failure warning
    - **Property 6: The rotation-failure warning appears exactly when a rotation was attempted and failed**
    - **Validates: Requirements 3.3**

  - [x] 4.4 Write property test for outcome/status stability under a rotation failure
    - **Property 5: A Token_Store write failure never changes the Spotify-facing outcome**
    - Requires substituting `env.TOKEN_KV` with a proxy whose `get` delegates to the real (local-simulation) `KVNamespace` and whose `put` rejects, per design.md's Testing Strategy note
    - **Validates: Requirements 3.1, 3.2, 3.4**

  - [x] 4.5 Wire the rotation-aware message into `index.ts`'s `respond()`
    - Update the `added`-outcome branch of `respond()` to call `formatAddedMessage(outcome.track, {rotationFailed: outcome.rotationFailed})`; `ok` stays `true` and the HTTP status stays `200`, unchanged from the base feature's outcome-to-status table
    - Confirm no new top-level JSON field is added to the response body — `rotationFailed` affects only which string `message` contains
    - _Requirements: 3.3, 3.4, 7.1_

  - [x] 4.6 Write property test for auth-failure indistinguishability
    - **Property 8: An auth failure on the effective refresh token is indistinguishable from any other auth failure**
    - **Validates: Requirements 4.1, 4.2**

- [x] 5. Deploy documentation
  - [x] 5.1 Document KV namespace provisioning in the setup README(s)
    - Document `wrangler kv namespace create <name>` and adding the printed id to `wrangler.toml`'s `[[kv_namespaces]]` block, before `wrangler deploy`, in both `README.md` and `README.zh-TW.md`
    - State plainly that no `wrangler kv key put` seeding step is needed — the Worker falls back to `SPOTIFY_REFRESH_TOKEN` until the first rotation happens on its own
    - State that local development requires no additional KV setup beyond what `wrangler dev` already provisions automatically from the `wrangler.toml` binding
    - _Requirements: 5.2, 6.1, 6.2, 6.3_

- [x] 6. Secret-containment property test
  - [x] 6.1 Write property test for rotation-state containment
    - **Property 9: Rotation bookkeeping never appears in the response or in logs**
    - Extends the base feature's secret-containment approach (`test/property/secret-containment.spec.ts`) to also cover KV-sourced refresh-token values; a `rotated_at` timestamp value MAY appear in captured log output but MUST NOT appear in the response body or headers
    - **Validates: Requirements 7.1, 7.2**

- [x] 7. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties; each is tagged `Feature: spotify-like-action-button-token-rotation, Property N: <title>` and runs a minimum of 100 cases
- No task in this plan is marked optional (`*`): this feature is small enough, and the properties tight enough to the requirements, that skipping any of them leaves a real gap (e.g. skipping Property 5's outcome-stability test would leave Requirement 3's central guarantee — a storage hiccup never costs the user a like — unverified)
- Manual post-deploy verification (confirm a press succeeds with an empty Token_Store, then confirm `wrangler kv key get refresh_token --binding=TOKEN_KV` returns a value after Spotify happens to rotate one) is a setup step documented in task 5.1, not an automated task, since rotation timing is at Spotify's discretion

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "2.6", "2.7", "2.8"] },
    { "id": 4, "tasks": ["3"] },
    { "id": 5, "tasks": ["4.1", "4.2"] },
    { "id": 6, "tasks": ["4.3", "4.4", "4.5"] },
    { "id": 7, "tasks": ["4.6"] },
    { "id": 8, "tasks": ["5.1", "6.1"] },
    { "id": 9, "tasks": ["7"] }
  ],
  "note": "2.4 depends only on 2.1 (both write and read touch the same getAccessToken function body), not on 2.2/2.3 (which are read-side property tests); it is placed in wave 2 alongside them for simplicity since 2.2-2.4 have no cross-dependencies and can run in parallel."
}
```

# Implementation Plan: spotify-like-action-button

## Overview

Build the Worker bottom-up so each layer is testable before the next depends on it: scaffold the Wrangler/TypeScript project and test harness, then the pure modules (message catalog, outcome classification, shared-secret gate), then the Spotify adapters (HTTP wrapper, token exchange, playback normalization, add-only library writes), then wire the orchestration and `fetch` handler. End-to-end property tests come after the handler exists, since Properties 2, 4, 5, 6, 7, 8, 9, 10, and 11 assert against the request log of the real handler running in `workerd`. The one-time refresh-token helper and the setup documentation are independent of the Worker code and can be built in parallel with the adapters.

Implementation language: **TypeScript** on the `workerd` runtime (as specified in the design).

## Tasks

- [x] 1. Project scaffolding and test harness
  - [x] 1.1 Create the Wrangler + TypeScript Worker project
    - Add `package.json`, `wrangler.toml` (main `src/index.ts`, compatibility date, no bindings other than secrets), and `tsconfig.json` with `@cloudflare/workers-types`
    - Create the `src/` and `scripts/` directory layout from the design's component map
    - Add a minimal `src/index.ts` that exports a `fetch` handler returning a placeholder JSON response, so the project builds
    - Add `.gitignore` covering `.dev.vars`, `node_modules`, `.wrangler`, and add a `.dev.vars.example` listing the four secret keys with empty values
    - _Requirements: 5.2, 5.3_

  - [x] 1.2 Set up the test harness
    - Add `vitest`, `@cloudflare/vitest-pool-workers`, and `fast-check` as dev dependencies
    - Add `vitest.config.ts` using `defineWorkersConfig` so tests run the real handler in `workerd`
    - Add `test`, `dev`, and `deploy` scripts to `package.json`
    - Configure fast-check to a minimum of 100 runs per property
    - _Requirements: 4.1_

  - [x] 1.3 Define core types and the Result helpers
    - Create `src/types.ts` with `Env`, `TrackInfo`, `PlaybackState`, `Failure`, and `Outcome` exactly as specified in the design's Data Models section
    - Add `Result<T, E>` with `ok()` and `err()` constructors so no module throws across a boundary
    - _Requirements: 3.2, 5.1_

  - [x] 1.4 Build the fake Spotify test harness
    - Create a recording fetch stub that captures method, URL, headers, and body for every outbound call and serves scripted responses per URL pattern
    - Model the library as a `Set<string>` of saved track ids where `PUT /v1/me/library?uris=<spotify:track:<id> URIs>` inserts, to support the model-based properties
    - Add fast-check generators for track names and artists (CJK, emoji, leading/trailing whitespace, names containing `" - "`), playback payloads (multi-artist, `is_playing` both values, extra/unknown fields, `id: null` local files, episodes, ads), and status codes across 400–599 including 429
    - _Requirements: 4.1_

- [x] 2. Message catalog and outcome classification
  - [x] 2.1 Implement the message catalog
    - Create `src/messages.ts` with one entry per non-success outcome from the design's mapping table: `目前沒有播放中的歌曲`, `目前播放的內容無法加入喜愛`, `Spotify 授權已失效，請重新取得授權`, `操作未完成，請稍後再試`, `無法連線到 Spotify，請檢查網路連線`, `伺服器設定不完整，請檢查 Worker 設定`, `未授權的請求`
    - Add the success formatter producing `已加入喜愛：<歌名> - <歌手>`
    - Export the catalog as an enumerable collection so tests can assert membership
    - _Requirements: 1.3, 1.4, 1.5, 2.2, 4.1, 4.2, 4.3, 4.4_

  - [x] 2.2 Write property test for the success message template
    - **Property 3: The success message is the template instantiated with the track's name and artist**
    - **Validates: Requirements 1.3, 2.2**

  - [x] 2.3 Implement outcome classification and the status code map
    - Create `src/outcome.ts` with `classify(failure, site)` mapping `auth`/`api`/`network`/`malformed`/`config` failures to outcomes per the mapping table
    - Encode the call-site distinction: a failed token exchange maps any 4xx to `auth_failed`; a failed data call uses the plain status classes (401/403 → `auth_failed`, other ≥400 → `api_failed`)
    - Map `malformed` to `api_failed` and never retry 429
    - Export the outcome → HTTP status table (200 for business outcomes and Spotify failures, 401/404/405 for `unauthorized`/`not_found`/`method_not_allowed`)
    - _Requirements: 4.2, 4.3, 4.4_

  - [x] 2.4 Write unit tests for the classification mapping
    - Assert each row of the mapping table, including `400 invalid_grant` at the token site resolving to `auth_failed` and 429 resolving to `api_failed` without a retry
    - _Requirements: 4.2, 4.3_

- [x] 3. Shared-secret gate
  - [x] 3.1 Implement the shared-secret gate
    - Create `src/gate.ts` with `isAuthorizedCaller(request, env)` parsing `Authorization: Bearer <secret>`
    - Compare lengths first, then compare bytes with a constant-time routine; reject a missing or malformed header before any other work
    - Perform no Spotify calls and read no request body or query parameters
    - _Requirements: 5.1, 5.4, 5.5_

  - [x] 3.2 Write unit tests for the gate
    - Cover absent header, wrong scheme, empty secret, wrong secret, correct secret, and a secret that is a prefix of the real one
    - _Requirements: 5.1, 5.4, 5.5_

- [x] 4. Spotify HTTP call wrapper
  - [x] 4.1 Implement the no-throw fetch wrapper
    - Create `src/spotify/http.ts` with `call(url, init)` applying `AbortSignal.timeout(6_000)`
    - Return `err({kind:"auth"})` for 401/403, `err({kind:"api"})` for other statuses ≥400, `ok(res)` otherwise, and convert every thrown error (DNS, TLS, reset, abort) into `err({kind:"network"})`
    - Add a `readJson` helper that yields `undefined` rather than throwing on an empty or invalid body
    - _Requirements: 4.2, 4.3, 4.4_

  - [x] 4.2 Write unit tests for the call wrapper
    - Assert status classification boundaries, that an aborted/timed-out request yields the network failure, and that `readJson` tolerates empty and malformed bodies
    - _Requirements: 4.3, 4.4_

- [x] 5. Token exchange with in-isolate cache
  - [x] 5.1 Implement the refresh-token grant
    - Create `src/spotify/token.ts` with `getAccessToken(env)` POSTing to `https://accounts.spotify.com/api/token` with `grant_type=refresh_token` and the stored refresh token, authorized by a `Basic` header built from `<client id>:<client secret>`
    - Read credentials only from `env`; accept no caller-supplied input
    - Return `err({kind:"malformed"})` when `access_token` is not a string
    - Cache the token in module scope with a 60 second expiry margin, and export an invalidation function for the retry path
    - _Requirements: 3.1, 3.2, 5.1_

  - [x] 5.2 Write property test for the token exchange
    - **Property 1: Token exchange uses the refresh-token grant with the stored credentials**
    - **Validates: Requirements 3.1**

  - [x] 5.3 Write unit tests for the token cache
    - Assert a warm cache skips the exchange, a token inside the expiry margin triggers a fresh exchange, a missing `expires_in` defaults to 3600 seconds, and invalidation forces the next call to re-exchange
    - _Requirements: 3.1_

- [x] 6. Playback normalization
  - [x] 6.1 Implement currently-playing normalization
    - Create `src/spotify/player.ts` with `getCurrentlyPlaying(token)` calling `GET /v1/me/player/currently-playing`
    - Normalize every row of the design's response table into `PlaybackState`: 204, empty body, `item: null`, and `currently_playing_type` of `ad`/`unknown` become `{track: null}`; episodes and local files become a track with `id: null`; a paused track with an id is still a track
    - Extract `name` and `artists[0].name`, tolerating absent or empty `artists`
    - _Requirements: 1.1, 1.4_

  - [x] 6.2 Write unit tests for the normalization table
    - One case per row of the table, including that `is_playing: false` still yields a track and that an episode yields `id: null` rather than `track: null`
    - _Requirements: 1.1, 1.4_

- [x] 7. Add-only library writes
  - [x] 7.1 Implement the saved-tracks module
    - Create `src/spotify/library.ts` exporting `trackUriFromId(trackId)` producing `spotify:track:<id>`
    - Export `saveTrack(token, trackUri)` issuing `PUT /v1/me/library?uris=<encoded trackUri>`
    - Export `isTrackSaved(token, trackUri)` using `GET /v1/me/library/contains?uris=<encoded trackUri>` as an off-critical-path probe whose failure is swallowed and cannot change the outcome
    - Export no `DELETE` path from this module
    - _Requirements: 2.1, 2.3, 3.4_

  - [x] 7.2 Write unit tests for the library module
    - Assert the `PUT` URL and URI encoding via `trackUriFromId`, that a re-add of a present track returns success, that `isTrackSaved` parses the boolean array shape, and that a probe failure leaves the outcome unchanged
    - _Requirements: 2.1, 2.2, 3.5_

- [x] 8. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Orchestration and request handler
  - [x] 9.1 Implement the `likeCurrentTrack` orchestration
    - Create `src/like.ts` running token → currently-playing → save in sequence, returning an `Outcome` at every branch
    - Map a null track to `nothing_playing` and a track with a null id to `not_addable` before any write
    - Return `{kind:"added", track}` on a successful `PUT`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1_

  - [x] 9.2 Implement the stale-token retry
    - On a `401` from a data call made with a cached token, invalidate the cache, re-exchange once, and retry that call once
    - Report a second `401` as `auth_failed`; cap the retry at one attempt so a revoked authorization cannot loop
    - _Requirements: 3.1, 4.2_

  - [x] 9.3 Wire the `fetch` handler and response shaping
    - Implement `src/index.ts`: reject any path other than `/like` with `not_found`, any method other than `POST` with `method_not_allowed`, then run the gate before any Spotify call
    - Add `respond(outcome)` emitting `application/json` with `message`, `ok`, `outcome`, and `track` for the success case, using the outcome → HTTP status table
    - Log only the outcome kind and HTTP status; never a token, secret, header, or body
    - _Requirements: 4.1, 5.1, 5.2_

  - [x] 9.4 Add secret binding validation
    - Create `src/config.ts` checking the four required bindings are present and non-empty, returning `err({kind:"config", missing})`
    - Run the check before the token exchange so a misconfigured Worker issues zero Spotify calls, and wire it into the handler to produce the `misconfigured` outcome
    - _Requirements: 3.2, 5.2_

  - [ ]* 9.5 Write unit tests for the retry and status codes
    - Assert the retry issues exactly one re-exchange and one retried call, and stops after one retry
    - Assert each outcome returns the HTTP status from the design's status table
    - _Requirements: 4.1, 4.2_

- [x] 10. End-to-end property and smoke tests
  - [ ]* 10.1 Write property test for the add request
    - **Property 2: A playing track always produces an add request for that track**
    - **Validates: Requirements 1.1, 1.2**

  - [ ]* 10.2 Write property test for the no-track family
    - **Property 4: Every "no track" signal maps to the nothing-playing message and writes nothing**
    - **Validates: Requirements 1.4**

  - [ ]* 10.3 Write property test for not-addable content
    - **Property 5: A not-addable current track is reported distinctly and writes nothing**
    - Assert the message `目前播放的內容無法加入喜愛` and that no request is issued against `/me/library`
    - **Validates: Requirements 1.5**

  - [ ]* 10.4 Write property test for idempotence
    - **Property 6: Liking is idempotent**
    - Model-based against the fake library `Set<string>` across repeated invocations
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 10.5 Write property test for library monotonicity
    - **Property 7: The library never shrinks**
    - Assert no `DELETE` appears in the recorded request log across arbitrary sequences of successes, 4xx, 5xx, malformed bodies, and thrown errors
    - **Validates: Requirements 2.3**

  - [ ]* 10.6 Write property test for failure classification totality
    - **Property 8: Failure classification is total and matches the mapping table**
    - Inject failures at all three Spotify call sites
    - **Validates: Requirements 4.2, 4.3, 4.4**

  - [ ]* 10.7 Write property test for message presence
    - **Property 9: Every response carries a message from the catalog**
    - **Validates: Requirements 4.1**

  - [ ]* 10.8 Write property test for account binding and the gate
    - **Property 10: The account binding cannot be influenced by the caller, and unauthorized callers reach nothing**
    - Assert zero outbound requests for absent, wrong, or malformed bearer secrets
    - **Validates: Requirements 5.1, 5.4, 5.5**

  - [ ] 10.9 Write property test for secret containment
    - **Property 11: Secrets never escape the Worker**
    - Assert no secret value appears in the response body, any response header, or captured log output
    - **Validates: Requirements 5.2**

  - [ ]* 10.10 Write smoke tests for missing configuration
    - One test per missing or empty secret binding asserting the `misconfigured` message and zero Spotify calls
    - _Requirements: 3.2, 5.2_

- [x] 11. One-time refresh-token helper script
  - [x] 11.1 Implement `scripts/get-refresh-token.ts`
    - Build the authorize URL with the four scopes `user-read-currently-playing`, `user-read-playback-state`, `user-library-modify`, `user-library-read` and redirect URI `http://127.0.0.1:8787/callback`
    - Serve a local callback listener that captures `code` and exchanges it for a refresh token via the authorization-code grant with Basic auth
    - Print the refresh token to stdout only; write no credential to disk, and exclude the script from the deployed Worker bundle
    - _Requirements: 3.3, 5.3_

  - [ ]* 11.2 Write unit test for the authorize URL scopes
    - Assert the URL contains exactly the four required scopes and the expected redirect URI
    - _Requirements: 3.3_

- [x] 12. Setup documentation and credential scanning
  - [x] 12.1 Write the setup and deploy README
    - Document registering the Spotify application and obtaining the client id and client secret
    - Document the one-time authorization-code procedure (helper script and the manual curl equivalent) with the four scopes, including that scopes cannot be widened without repeating the flow
    - Document `wrangler secret put` for all four secrets, `wrangler deploy`, and `.dev.vars` plus `wrangler dev` for local runs
    - Document the Shortcut configuration (POST to `/like`, `Authorization: Bearer <SHORTCUT_SECRET>`, no body, `Show Notification` reading the `message` key) and Action Button binding
    - Document the verification pass and the symptom that a generic iOS action error means a wrong `Authorization` header
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 12.2 Add the credential scanning script
    - Create `scripts/scan-secrets.sh` failing on credential-shaped literals in tracked files and on a committed `.dev.vars`
    - Wire it as a `package.json` script so CI and local runs use the same check
    - _Requirements: 5.3_

  - [ ]* 12.3 Write tests for the credential scanner
    - Assert the scanner fails on a planted credential literal and on a tracked `.dev.vars`, and passes on the clean tree
    - _Requirements: 5.2, 5.3_

- [ ] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties; each is tagged `Feature: spotify-like-action-button, Property N: <title>` and runs a minimum of 100 cases
- Properties 2, 4, 5, 6, 7, 8, 9, 10, and 11 are handler-level and therefore live in task 10, after the `fetch` handler is wired; Properties 1 and 3 sit next to the modules they constrain
- Manual post-deploy verification (playing track, stopped playback, podcast) is a setup step documented in task 12.1, not an automated task

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["1.4", "2.1", "3.1", "4.1", "11.1", "12.1"] },
    { "id": 4, "tasks": ["2.2", "2.3", "3.2", "4.2", "5.1", "6.1", "7.1", "11.2", "12.2"] },
    { "id": 5, "tasks": ["2.4", "5.2", "5.3", "6.2", "7.2", "9.1", "9.4", "12.3"] },
    { "id": 6, "tasks": ["9.2"] },
    { "id": 7, "tasks": ["9.3"] },
    { "id": 8, "tasks": ["9.5", "10.1", "10.2", "10.3", "10.4", "10.5", "10.6", "10.7", "10.8", "10.9", "10.10"] }
  ]
}
```

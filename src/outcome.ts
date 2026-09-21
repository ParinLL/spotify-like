// Outcome classification per the design's "Error Handling and Message
// Mapping" section. `classify` is the single place where a Failure becomes
// an Outcome; it is pure mapping and never retries — the 429-avoidance and
// stale-token retry behavior live in the orchestration layer (task 9.2), not
// here. See design.md's note on spotify/token.ts: Spotify returns a plain
// `400 invalid_grant` (not 401) for a revoked refresh token, so a failed
// token exchange must treat ANY 4xx as an auth failure, while a failed data
// call (currently-playing, library) only treats 401/403 as an auth failure
// and every other >=400 status as a generic api failure.

import type { Failure, Outcome } from "./types";

/**
 * The call site a Failure originated from. `http.ts`'s `call()` already
 * narrows 401/403 into `{kind: "auth"}` and every other >=400 status into
 * `{kind: "api"}`, so at the "data" site that split is exactly what the
 * mapping table wants. At the "token" site, Spotify's `400 invalid_grant`
 * arrives as `{kind: "api", status: 400}` — indistinguishable at the
 * Failure level from any other 4xx — so classify() special-cases "token" to
 * treat every 4xx (whether it arrived as "auth" or "api") as auth_failed.
 */
export type CallSite = "token" | "data";

/**
 * Maps a Failure from a given call site to the Outcome the user sees, per
 * the design's mapping table. Total over every Failure kind x every
 * CallSite — there is no fallthrough.
 */
export function classify(failure: Failure, site: CallSite): Outcome {
  switch (failure.kind) {
    case "auth":
      // http.ts only produces "auth" for 401/403, which is auth_failed at
      // both call sites (token: any 4xx is auth_failed; data: 401/403 is
      // auth_failed directly).
      return { kind: "auth_failed" };

    case "api":
      if (site === "token" && failure.status >= 400 && failure.status < 500) {
        // Token exchange 4xx, e.g. 400 invalid_grant — treated as an auth
        // failure regardless of the specific status.
        return { kind: "auth_failed" };
      }
      // Every other status >= 400, including 429 and 5xx (at either site),
      // is a generic api failure. classify() never retries — a 429 simply
      // lands here like any other api failure.
      return { kind: "api_failed" };

    case "network":
      // fetch threw: DNS, TLS, reset, timeout/abort.
      return { kind: "network_failed" };

    case "malformed":
      // Response body was not the expected shape.
      return { kind: "api_failed" };

    case "config":
      // A required secret binding is absent or empty.
      return { kind: "misconfigured" };
  }
}

/**
 * The outcome -> HTTP status table from design.md's "Endpoint Contract" /
 * "Status codes" section. Business outcomes and Spotify-side failures all
 * return 200 so the Shortcut's `Get Contents of URL` step always proceeds to
 * `Show Notification`; only the routing/gate outcomes get a real HTTP
 * status.
 */
export const OUTCOME_STATUS: Record<Outcome["kind"], number> = {
  added: 200,
  episode_added: 200,
  nothing_playing: 200,
  not_addable: 200,
  auth_failed: 200,
  api_failed: 200,
  network_failed: 200,
  misconfigured: 200,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
};

/** Looks up the HTTP status for a given Outcome per OUTCOME_STATUS. */
export function httpStatusForOutcome(outcome: Outcome): number {
  return OUTCOME_STATUS[outcome.kind];
}

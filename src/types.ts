// Core data model shared across the Worker, per the design's Data Models
// section. Every module that crosses a boundary (Spotify HTTP calls, token
// exchange, orchestration) returns a Result instead of throwing, so failures
// are values that flow through classify() into an Outcome.

export interface Env {
  SPOTIFY_CLIENT_ID: string; // wrangler secret
  SPOTIFY_CLIENT_SECRET: string; // wrangler secret
  SPOTIFY_REFRESH_TOKEN: string; // wrangler secret — bootstrap value, never overwritten
  SHORTCUT_SECRET: string; // wrangler secret — authenticates the caller
  TOKEN_KV: KVNamespace; // Token_Store binding — persists a rotated refresh token
}

export interface TrackInfo {
  id: string | null; // null for local files and episodes: not addable
  name: string;
  artist: string; // artists[0].name
}

export interface PlaybackState {
  track: TrackInfo | null;
}

export type Failure =
  | { kind: "auth"; status: number }
  | { kind: "api"; status: number }
  | { kind: "network"; cause: unknown }
  | { kind: "malformed" }
  | { kind: "config"; missing: string[] };

export type Outcome =
  | { kind: "added"; track: TrackInfo; rotationFailed?: boolean }
  | { kind: "nothing_playing" }
  | { kind: "not_addable" }
  | { kind: "auth_failed" }
  | { kind: "api_failed" }
  | { kind: "network_failed" }
  | { kind: "misconfigured" }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "method_not_allowed" };

/**
 * Result<T, E> — the no-throw boundary type. Every module that can fail
 * (Spotify HTTP calls, token exchange, orchestration steps) returns one of
 * these instead of throwing, discriminated on `ok` so call sites narrow with
 * a plain `if (!res.ok)` check and read `res.value` / `res.error`.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error };
}

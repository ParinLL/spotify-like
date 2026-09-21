// Core data model shared across the Worker, per the design's Data Models
// section. Every module that crosses a boundary (Spotify HTTP calls, token
// exchange, orchestration) returns a Result instead of throwing, so failures
// are values that flow through classify() into an Outcome.

/**
 * The language of the user-facing notification text, selected by the
 * MESSAGE_LANGUAGE var. `zh_TW` uses an underscore rather than the BCP 47
 * `zh-TW` because it is an environment-variable value, not a content
 * negotiation header, and underscores avoid quoting surprises in shell and
 * TOML contexts.
 */
export type Language = "en" | "zh_TW";

export interface Env {
  SPOTIFY_CLIENT_ID: string; // wrangler secret
  SPOTIFY_CLIENT_SECRET: string; // wrangler secret
  SPOTIFY_REFRESH_TOKEN: string; // wrangler secret — bootstrap value, never overwritten
  SHORTCUT_SECRET: string; // wrangler secret — authenticates the caller
  TOKEN_KV: KVNamespace; // Token_Store binding — persists a rotated refresh token
  /**
   * Plain var (not a secret), optional: "en" (the default) or "zh_TW".
   * Absent or empty means English. A present-but-unrecognized value is a
   * typo rather than an intention, so it is reported as a configuration
   * error instead of silently falling back — see config.ts.
   */
  MESSAGE_LANGUAGE?: string;
}

export interface TrackInfo {
  id: string | null; // null for local files: not addable
  name: string;
  artist: string; // artists[0].name
}

/**
 * A currently-playing podcast episode. `name` is the episode's own title;
 * `show` is the podcast/show name — Spotify keeps these as two separate
 * fields (`item.name` vs `item.show.name`), and a "節目名稱 - 單集標題"
 * message needs both. `id` is null when Spotify reports a playing episode
 * without a full item object (`item: null` alongside
 * `currently_playing_type: "episode"`, observed in production) — there is
 * no episode id to add in that case, same as a local file.
 */
export interface EpisodeInfo {
  id: string | null;
  name: string;
  show: string;
}

export interface PlaybackState {
  // Mutually exclusive: at most one of `track` / `episode` is non-null at
  // any time, per what the currently-playing endpoint can report.
  track: TrackInfo | null;
  episode: EpisodeInfo | null;
}

export type Failure =
  | { kind: "auth"; status: number }
  | { kind: "api"; status: number }
  | { kind: "network"; cause: unknown }
  | { kind: "malformed" }
  | { kind: "config"; missing: string[]; invalid?: string[] };

export type Outcome =
  | { kind: "added"; track: TrackInfo; rotationFailed?: boolean }
  | { kind: "episode_added"; episode: EpisodeInfo; rotationFailed?: boolean }
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

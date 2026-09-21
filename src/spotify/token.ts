// The refresh-token grant with an in-isolate cache. Exchanges the stored
// Refresh_Token for a fresh Access_Token, caching it in module scope until it
// is within EXPIRY_MARGIN_MS of expiry. See design.md, "spotify/token.ts —
// token exchange".
//
// Test-environment note: @cloudflare/vitest-pool-workers documents that it
// "reuses Workers and their module caches between test runs where
// possible" — storage isolation is per test file, but a module-scope `let`
// like `cached` below is NOT guaranteed to reset between test files sharing
// a pooled worker. Without a safeguard, one test file's cached token (keyed
// to its own fake SPOTIFY_REFRESH_TOKEN) could leak into another file's
// test and short-circuit its exchange, producing a flaky "fetch was never
// called" failure that only reproduces under certain CI scheduling (seen
// in production CI, never locally). `cached` therefore also records which
// SPOTIFY_REFRESH_TOKEN Secret it was populated under, and getAccessToken
// treats a mismatch as a cache miss. In production this is a no-op check —
// a single deployment has exactly one SPOTIFY_REFRESH_TOKEN Secret for its
// whole lifetime (barring an actual rotation, which already forces a fresh
// exchange for other reasons) — so this costs nothing at runtime and exists
// purely to make the cache self-validating across whatever module-reuse
// behavior the test environment does.

import { err, ok, type Env, type Failure, type Result } from "../types";
import { call, readJson } from "./http";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3600;
const TOKEN_KV_KEY = "refresh_token";
const ROTATED_AT_KV_KEY = "rotated_at";

interface CachedToken {
  token: string;
  expiresAt: number;
  /**
   * The env.SPOTIFY_REFRESH_TOKEN Secret value in effect when this token was
   * cached. Compared on every read so a cache populated under a different
   * Secret (only possible in a test environment sharing a module instance
   * across files — see the module doc comment above) is never reused.
   */
  secretFingerprint: string;
}

/**
 * The result of a token exchange: the Access_Token to use as the bearer
 * credential, plus whether a rotated refresh token was issued by Spotify
 * but failed to persist. See design.md, "spotify/token.ts — changed".
 */
export interface TokenExchangeResult {
  token: string;
  /** True only if this call obtained a new refresh_token and failed to persist it. */
  rotationFailed: boolean;
}

let cached: CachedToken | null = null;

/**
 * Clears the module-scope token cache, forcing the next `getAccessToken`
 * call to re-exchange the refresh token. Used by the stale-token retry path
 * (task 9.2) after a data call reports a 401 with a cached token.
 *
 * This only clears the in-isolate Access_Token cache — it never touches
 * Token_Store, since a stale Access_Token and a stale Refresh_Token are
 * different problems.
 */
export function invalidateAccessToken(): void {
  cached = null;
}

export async function getAccessToken(env: Env): Promise<Result<TokenExchangeResult, Failure>> {
  if (
    cached !== null &&
    cached.secretFingerprint === env.SPOTIFY_REFRESH_TOKEN &&
    Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS
  ) {
    return ok({ token: cached.token, rotationFailed: false });
  }

  const effectiveRefreshToken = await readEffectiveRefreshToken(env);

  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await call(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: effectiveRefreshToken,
    }),
  });
  if (!res.ok) return res;

  const body = await readJson(res.value);
  if (typeof body !== "object" || body === null || !("access_token" in body)) {
    return err({ kind: "malformed" });
  }

  const accessToken = (body as { access_token: unknown }).access_token;
  if (typeof accessToken !== "string") {
    return err({ kind: "malformed" });
  }

  const expiresInRaw = (body as { expires_in?: unknown }).expires_in;
  const expiresIn = typeof expiresInRaw === "number" ? expiresInRaw : DEFAULT_EXPIRES_IN_S;

  cached = {
    token: accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    secretFingerprint: env.SPOTIFY_REFRESH_TOKEN,
  };

  let rotationFailed = false;
  const newRefreshToken = (body as { refresh_token?: unknown }).refresh_token;
  if (typeof newRefreshToken === "string" && newRefreshToken.length > 0) {
    rotationFailed = !(await persistRotatedRefreshToken(env, newRefreshToken));
  }

  return ok({ token: accessToken, rotationFailed });
}

/**
 * The Effective_Refresh_Token: prefers the most recently rotated value in
 * Token_Store, falling back to the Worker Secret when Token_Store holds
 * nothing (including when the KV read itself fails). See design.md,
 * "Effective_Refresh_Token".
 */
async function readEffectiveRefreshToken(env: Env): Promise<string> {
  try {
    const stored = await env.TOKEN_KV.get(TOKEN_KV_KEY);
    if (stored !== null && stored.length > 0) return stored;
  } catch {
    // KV read failure: fall through to the Secret, same as "KV has nothing".
  }
  return env.SPOTIFY_REFRESH_TOKEN;
}

/**
 * Persists a Rotated_Refresh_Token and its Rotation_Timestamp to
 * Token_Store. Best-effort: swallows any failure from either write and
 * reports it via the boolean return rather than throwing, matching
 * `spotify/library.ts`'s `isTrackSaved` pattern for an off-critical-path
 * write whose result cannot change whether the add is issued. See
 * design.md, "spotify/token.ts — changed".
 */
async function persistRotatedRefreshToken(env: Env, newRefreshToken: string): Promise<boolean> {
  try {
    await env.TOKEN_KV.put(TOKEN_KV_KEY, newRefreshToken);
    await env.TOKEN_KV.put(ROTATED_AT_KV_KEY, new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

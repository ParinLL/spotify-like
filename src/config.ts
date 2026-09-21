// Secret binding validation. Per design.md: a misconfigured Worker (a
// missing or empty required secret) must issue zero Spotify calls, so this
// check runs before the token exchange and short-circuits the orchestration
// with a `config` failure that classify() maps to the `misconfigured`
// outcome.
//
// Requirements: 3.2, 5.2

import type { Env, Failure, Result } from "./types";
import { err, ok } from "./types";

const REQUIRED_KEYS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REFRESH_TOKEN",
  "SHORTCUT_SECRET",
] as const;

/**
 * Returns `ok(env)` only if every required secret binding is present and a
 * non-empty string. Otherwise returns `err({kind: "config", missing})`
 * listing the names of the missing or empty bindings, in the order checked.
 */
export function validateConfig(env: Env): Result<Env, Failure> {
  const missing: string[] = [];

  for (const key of REQUIRED_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    return err({ kind: "config", missing });
  }

  return ok(env);
}

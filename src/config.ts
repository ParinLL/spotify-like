// Secret binding validation. Per design.md: a misconfigured Worker (a
// missing or empty required secret) must issue zero Spotify calls, so this
// check runs before the token exchange and short-circuits the orchestration
// with a `config` failure that classify() maps to the `misconfigured`
// outcome.
//
// Requirements: 3.2, 5.2

import type { Env, Failure, Result } from "./types";
import { err, ok } from "./types";
import { parseLanguage } from "./messages";

const REQUIRED_KEYS = [
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REFRESH_TOKEN",
  "SHORTCUT_SECRET",
] as const;

/**
 * Returns `ok(env)` only if every required secret binding is present and a
 * non-empty string, and MESSAGE_LANGUAGE — if set at all — names a language
 * we actually have a catalog for. Otherwise returns
 * `err({kind: "config", missing, invalid})`, naming the offending bindings.
 *
 * MESSAGE_LANGUAGE is optional, so absent or empty is not an error: it means
 * the default language. But a non-empty value we do not recognize is
 * reported rather than quietly falling back, because the only way to get one
 * is to have tried to configure the language and misspelled it — and a
 * silent fallback would leave the Worker answering in the wrong language
 * with nothing to indicate why.
 *
 * Only binding *names* are recorded, never values: this Failure is
 * constructed from an Env that also holds secrets, and keeping values out of
 * it by construction is what stops one leaking into a log line later.
 */
export function validateConfig(env: Env): Result<Env, Failure> {
  const missing: string[] = [];

  for (const key of REQUIRED_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) {
      missing.push(key);
    }
  }

  const invalid: string[] = [];
  const language = env.MESSAGE_LANGUAGE;
  if (typeof language === "string" && language.length > 0 && parseLanguage(language) === null) {
    invalid.push("MESSAGE_LANGUAGE");
  }

  if (missing.length > 0 || invalid.length > 0) {
    return err(invalid.length > 0 ? { kind: "config", missing, invalid } : { kind: "config", missing });
  }

  return ok(env);
}

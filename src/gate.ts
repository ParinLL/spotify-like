// Shared-secret gate for the Shortcut caller. Per design.md "Security
// Considerations" point 2 and 3: reject a missing or malformed Authorization
// header before any other work, compare lengths first, then compare bytes
// with a fixed-time routine rather than `===` so response timing does not
// leak a prefix of the secret. This module performs no Spotify calls and
// reads no request body or query parameters.
//
// Requirements: 5.1, 5.4, 5.5

import type { Env } from "./types";

const BEARER_PREFIX = "Bearer ";

/**
 * Returns true only if `request` carries `Authorization: Bearer <secret>`
 * where `<secret>` exactly matches `env.SHORTCUT_SECRET`.
 */
export function isAuthorizedCaller(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization");
  if (header === null || !header.startsWith(BEARER_PREFIX)) return false;

  const presented = header.slice(BEARER_PREFIX.length);
  const expected = env.SHORTCUT_SECRET;
  if (typeof expected !== "string" || expected.length === 0) return false;

  return timingSafeEqual(presented, expected);
}

/**
 * Constant-time-with-respect-to-content string comparison. Lengths are
 * compared first (a length mismatch is not secret-dependent and is safe to
 * branch on immediately). When lengths match, every byte pair is compared
 * unconditionally — the loop never short-circuits on the first mismatch —
 * and the result is folded into a single accumulator so the number of
 * operations does not depend on where (or whether) the inputs differ.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);

  if (aBytes.length !== bBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

// Property test for task 2.6. Per design.md's "Property 2", any
// token-exchange response that triggers a Token_Store write of a
// Rotated_Refresh_Token also writes a Rotation_Timestamp in the same
// invocation, and that timestamp parses as a valid point in time within the
// invocation's window.
//
// Requirements: 1.3

import { env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { getAccessToken, invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";

function tokenResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({ access_token: accessToken, expires_in: 3600, refresh_token: refreshToken }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * Refresh-token string generator: non-empty printable ASCII, following the
 * style of `credentialArb` in test/spotify/token.spec.ts.
 */
const rotatedRefreshTokenArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 40,
  unit: "grapheme-ascii",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccessToken — rotation timestamp", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 2: A successful rotation always records a timestamp alongside the token",
    async () => {
      await fc.assert(
        fc.asyncProperty(rotatedRefreshTokenArb, async (rotatedRefreshToken) => {
          // Cold cache: force the exchange to actually happen for this run.
          invalidateAccessToken();

          // Clear both Token_Store keys before the run so this run's write
          // is unambiguous.
          await workerEnv.TOKEN_KV.delete("refresh_token");
          await workerEnv.TOKEN_KV.delete("rotated_at");

          const env: Env = {
            SPOTIFY_CLIENT_ID: "client-id",
            SPOTIFY_CLIENT_SECRET: "client-secret",
            SPOTIFY_REFRESH_TOKEN: "bootstrap-refresh-token",
            SHORTCUT_SECRET: "irrelevant-for-this-test",
            TOKEN_KV: workerEnv.TOKEN_KV,
          };

          const fetchMock = vi
            .fn()
            .mockResolvedValue(tokenResponse("access-token", rotatedRefreshToken));
          vi.stubGlobal("fetch", fetchMock);

          const before = Date.now();
          const result = await getAccessToken(env);
          const after = Date.now();

          expect(result.ok).toBe(true);

          const rotatedAt = await workerEnv.TOKEN_KV.get("rotated_at");
          expect(rotatedAt).not.toBeNull();

          const rotatedAtMs = new Date(rotatedAt as string).getTime();
          expect(Number.isNaN(rotatedAtMs)).toBe(false);
          expect(rotatedAtMs).toBeGreaterThanOrEqual(before);
          expect(rotatedAtMs).toBeLessThanOrEqual(after);

          // Ties this property to Property 1: the timestamp write happened
          // in the same invocation as the token write, not some unrelated
          // write.
          const storedRefreshToken = await workerEnv.TOKEN_KV.get("refresh_token");
          expect(storedRefreshToken).toBe(rotatedRefreshToken);

          vi.unstubAllGlobals();
        }),
      );
    },
  );
});

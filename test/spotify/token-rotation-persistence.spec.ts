// Property test for task 2.5. Per design.md's "Property 1" for the
// spotify-like-action-button-token-rotation feature, a rotated refresh
// token returned in a token-exchange response is persisted verbatim to
// Token_Store, and Token_Store is written to only when a non-empty
// `refresh_token` was actually issued.
//
// Requirements: 1.1, 1.2, 1.4
//
// Uses the real ambient local-simulation KV binding from `cloudflare:test`
// (see test/spotify/token.spec.ts, test/spotify/token-cache.spec.ts), not a
// hand-rolled fake, per design.md's Testing Strategy. Because that KV
// binding's storage persists across calls within this test file, the
// `refresh_token` key is explicitly deleted/reset at the start of every
// property run, and invalidateAccessToken() is called to force a cold-cache
// exchange every run.
//
// This file is dedicated to Property 1 only, to avoid colliding with other
// in-flight tasks writing to test/spotify/token*.spec.ts.

import { env as workerEnv } from "cloudflare:test";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";

const REFRESH_TOKEN_KV_KEY = "refresh_token";

/**
 * Non-empty printable-ASCII token string generator, following the style of
 * `credentialArb` in test/spotify/token.spec.ts.
 */
const tokenStringArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 40,
  unit: "grapheme-ascii",
});

const env: Env = {
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "client-secret",
  SPOTIFY_REFRESH_TOKEN: "bootstrap-refresh-token",
  SHORTCUT_SECRET: "irrelevant-for-this-test",
  TOKEN_KV: workerEnv.TOKEN_KV,
};

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("persistRotatedRefreshToken (via getAccessToken)", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 1: A rotated refresh token is persisted verbatim, and only when one is issued",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          tokenStringArb,
          fc.string({ minLength: 1, maxLength: 40 }),
          fc.constantFrom<"issued" | "absent" | "empty">("issued", "absent", "empty"),
          async (rotatedRefreshToken, accessToken, mode) => {
            // Cold cache and clean KV slate for every run, so runs don't
            // leak into each other.
            invalidateAccessToken();
            await workerEnv.TOKEN_KV.delete(REFRESH_TOKEN_KV_KEY);

            const body: Record<string, unknown> = {
              access_token: accessToken,
              expires_in: 3600,
            };

            if (mode === "issued") {
              body.refresh_token = rotatedRefreshToken;
            } else if (mode === "empty") {
              body.refresh_token = "";
            }
            // mode === "absent": no refresh_token field at all.

            let sentinelSeeded = false;
            const SENTINEL = "sentinel-unchanged-value";
            if (mode !== "issued") {
              // Seed a known sentinel so "no write occurred" can be
              // asserted by confirming the sentinel is untouched, rather
              // than trying to intercept the `put` call itself.
              await workerEnv.TOKEN_KV.put(REFRESH_TOKEN_KV_KEY, SENTINEL);
              sentinelSeeded = true;
            }

            const fetchMock = vi.fn().mockResolvedValue(tokenResponse(body));
            vi.stubGlobal("fetch", fetchMock);

            const result = await getAccessToken(env);
            expect(result.ok).toBe(true);

            const stored = await workerEnv.TOKEN_KV.get(REFRESH_TOKEN_KV_KEY);

            if (mode === "issued") {
              // A rotated refresh token was issued: the next read of
              // Token_Store returns exactly that value.
              expect(stored).toBe(rotatedRefreshToken);
              if (result.ok) {
                expect(result.value.rotationFailed).toBe(false);
              }
            } else {
              // No refresh_token field (or an empty one): no write to
              // Token_Store at all — the sentinel is unchanged.
              expect(sentinelSeeded).toBe(true);
              expect(stored).toBe(SENTINEL);
              if (result.ok) {
                expect(result.value.rotationFailed).toBe(false);
              }
            }

            vi.unstubAllGlobals();
          },
        ),
      );
    },
  );
});

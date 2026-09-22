// Property test for task 2.2. Per design.md's "Property 3", the Worker's
// token-exchange request always uses the Effective_Refresh_Token: the value
// held in Token_Store when present, falling back to `env.SPOTIFY_REFRESH_TOKEN`
// only when Token_Store holds nothing.
//
// Requirements: 2.1, 2.2, 2.3

import { env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { getAccessToken, invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";

const TOKEN_KV_KEY = "refresh_token";

/**
 * Refresh-token string generator: non-empty, reasonable printable-ASCII
 * strings, following the style of `credentialArb` in token.spec.ts. Avoids
 * `:` for consistency with that convention, though it isn't load-bearing
 * here since these values only ever travel as a form field, not a Basic
 * auth payload.
 */
const refreshTokenArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40, unit: "grapheme-ascii" })
  .filter((s) => !s.includes(":"));

function tokenResponse(accessToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function baseEnv(refreshTokenSecret: string): Env {
  return {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REFRESH_TOKEN: refreshTokenSecret,
    SHORTCUT_SECRET: "irrelevant-for-this-test",
    TOKEN_KV: workerEnv.TOKEN_KV,
  };
}

async function captureRefreshTokenParam(env: Env): Promise<string | null> {
  const fetchMock = vi.fn().mockResolvedValue(tokenResponse("access-token"));
  vi.stubGlobal("fetch", fetchMock);

  const result = await getAccessToken(env);
  expect(result.ok).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const rawBody = init.body;
  const bodyText = rawBody instanceof URLSearchParams ? rawBody.toString() : String(rawBody);
  const params = new URLSearchParams(bodyText);

  vi.unstubAllGlobals();
  return params.get("refresh_token");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccessToken — Effective_Refresh_Token", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 3: The effective refresh token prefers Token_Store and falls back to the Secret",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          refreshTokenArb,
          refreshTokenArb,
          async (secretRefreshToken, kvRefreshToken) => {
            // Reset TOKEN_KV between runs so state from a prior run never
            // leaks into this one, and force a cold cache so the exchange
            // actually happens (a warm cache would skip reading the
            // Effective_Refresh_Token entirely).
            await workerEnv.TOKEN_KV.delete(TOKEN_KV_KEY);
            invalidateAccessToken();

            // --- KV populated case ---
            await workerEnv.TOKEN_KV.put(TOKEN_KV_KEY, kvRefreshToken);

            const kvPopulatedParam = await captureRefreshTokenParam(
              baseEnv(secretRefreshToken),
            );
            expect(kvPopulatedParam).toBe(kvRefreshToken);
            if (kvRefreshToken !== secretRefreshToken) {
              expect(kvPopulatedParam).not.toBe(secretRefreshToken);
            }

            // --- KV empty case ---
            await workerEnv.TOKEN_KV.delete(TOKEN_KV_KEY);
            invalidateAccessToken();

            const kvEmptyParam = await captureRefreshTokenParam(baseEnv(secretRefreshToken));
            expect(kvEmptyParam).toBe(secretRefreshToken);
          },
        ),
      );
    },
  );
});

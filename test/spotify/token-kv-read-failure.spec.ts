// Property test for task 2.3. Per design.md's "Property 7", a Token_Store
// read failure must degrade silently to exactly the same behavior as an
// empty Token_Store: the Worker's token-exchange request falls back to
// `env.SPOTIFY_REFRESH_TOKEN`, and the failure never surfaces as a Failure
// or otherwise changes the caller-visible result.
//
// Requirements: 2.3, 3.1

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { getAccessToken, invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

/**
 * Refresh-token generator: non-empty printable ASCII, following the style
 * of test/spotify/token.spec.ts's `credentialArb`.
 */
const secretRefreshTokenArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 40,
  unit: "grapheme-ascii",
});

function tokenResponse(accessToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A minimal stand-in for env.TOKEN_KV whose `get` always rejects, simulating
 * a Token_Store read failure. getAccessToken's read path only ever calls
 * `.get` on the binding (see src/spotify/token.ts's readEffectiveRefreshToken),
 * so a stub exposing just that method is sufficient here; the cast is the
 * read-side counterpart to the write-side substitution design.md's Testing
 * Strategy section sanctions for Property 5.
 */
function failingKv(): KVNamespace {
  return {
    get: () => Promise.reject(new Error("simulated KV outage")),
  } as unknown as KVNamespace;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccessToken", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 7: A Token_Store read failure degrades to the same behavior as an empty Token_Store",
    async () => {
      await fc.assert(
        fc.asyncProperty(secretRefreshTokenArb, async (secretRefreshToken) => {
          // Cold cache: force the exchange to actually happen for this run.
          invalidateAccessToken();

          const env: Env = {
            SPOTIFY_CLIENT_ID: "client-id",
            SPOTIFY_CLIENT_SECRET: "client-secret",
            SPOTIFY_REFRESH_TOKEN: secretRefreshToken,
            SHORTCUT_SECRET: "irrelevant-for-this-test",
            TOKEN_KV: failingKv(),
          };

          const fetchMock = vi.fn().mockResolvedValue(tokenResponse("access-token"));
          vi.stubGlobal("fetch", fetchMock);

          const result = await getAccessToken(env);

          expect(fetchMock).toHaveBeenCalledTimes(1);
          const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
          expect(url).toBe(TOKEN_URL);

          const rawBody = init.body;
          const bodyText =
            rawBody instanceof URLSearchParams ? rawBody.toString() : String(rawBody);
          const params = new URLSearchParams(bodyText);

          // The KV read failure fell through to the Secret, exactly as if
          // Token_Store had been reachable but empty.
          expect(params.get("refresh_token")).toBe(secretRefreshToken);

          // The read failure is fully swallowed: it never surfaces as a
          // Failure or any other caller-visible difference.
          expect(result.ok).toBe(true);

          vi.unstubAllGlobals();
        }),
      );
    },
  );
});

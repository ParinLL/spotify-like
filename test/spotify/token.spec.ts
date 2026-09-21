// Property test for task 5.2. Per design.md's "Property 1", the Worker's
// token exchange always uses the refresh-token grant with exactly the
// credentials held in the environment: a POST to the Spotify token endpoint
// whose form body carries `grant_type=refresh_token` and the refresh token,
// authorized by a Basic header whose base64 payload decodes to exactly
// `<client id>:<client secret>` — and the access token it returns is the
// value callers use as the bearer credential on every subsequent call.
//
// Requirements: 3.1

import { env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { getAccessToken, invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

/**
 * Credential string generator: non-empty printable ASCII without `:` (which
 * would make the decoded Basic payload ambiguous to split back apart) and
 * without characters that fast-check's default string arbitrary can produce
 * but that would round-trip awkwardly through base64/form-encoding for the
 * purposes of this test (e.g. leading/trailing whitespace is fine since we
 * compare exact decoded/decoded values, not a split).
 */
const credentialArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40, unit: "grapheme-ascii" })
  .filter((s) => !s.includes(":"));

function tokenResponse(accessToken: string): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccessToken", () => {
  it(
    "Feature: spotify-like-action-button, Property 1: Token exchange uses the refresh-token grant with the stored credentials",
    () => {
      fc.assert(
        fc.asyncProperty(
          credentialArb,
          credentialArb,
          credentialArb,
          fc.string({ minLength: 1, maxLength: 40 }),
          async (clientId, clientSecret, refreshToken, accessToken) => {
            // Cold cache: force the exchange to actually happen for this run.
            invalidateAccessToken();

            const env: Env = {
              SPOTIFY_CLIENT_ID: clientId,
              SPOTIFY_CLIENT_SECRET: clientSecret,
              SPOTIFY_REFRESH_TOKEN: refreshToken,
              SHORTCUT_SECRET: "irrelevant-for-this-test",
              TOKEN_KV: workerEnv.TOKEN_KV,
            };

            const fetchMock = vi.fn().mockResolvedValue(tokenResponse(accessToken));
            vi.stubGlobal("fetch", fetchMock);

            const result = await getAccessToken(env);

            // Exactly one outbound request, and it is the token exchange.
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

            expect(url).toBe(TOKEN_URL);
            expect(init.method).toBe("POST");

            // Form body carries the refresh-token grant and the refresh token.
            const rawBody = init.body;
            const bodyText =
              rawBody instanceof URLSearchParams ? rawBody.toString() : String(rawBody);
            const params = new URLSearchParams(bodyText);
            expect(params.get("grant_type")).toBe("refresh_token");
            expect(params.get("refresh_token")).toBe(refreshToken);

            // Authorization header is Basic, decoding to exactly id:secret.
            const headers = new Headers(init.headers);
            const authHeader = headers.get("Authorization") ?? "";
            expect(authHeader.startsWith("Basic ")).toBe(true);
            const decoded = atob(authHeader.slice("Basic ".length));
            expect(decoded).toBe(`${clientId}:${clientSecret}`);

            // The returned value is exactly the scripted access token — the
            // credential every subsequent Spotify call would use as
            // `Authorization: Bearer <token>`.
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.value.token).toBe(accessToken);
              // No refresh_token was scripted in the response, so no
              // rotation was attempted and none could have failed.
              expect(result.value.rotationFailed).toBe(false);
            }

            vi.unstubAllGlobals();
          },
        ),
      );
    },
  );
});

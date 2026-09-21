// Property test for task 2.7. Per design.md's "Property 4", the bootstrap
// secret the test harness supplies as `env.SPOTIFY_REFRESH_TOKEN` is never
// overwritten, however many rotations occur across a sequence of
// invocations.
//
// Requirements: 2.4
//
// NOTE on scope: getAccessToken only ever *reads* env.SPOTIFY_REFRESH_TOKEN
// (as the cold-start fallback used when Token_Store holds nothing); nothing
// in src/spotify/token.ts assigns to that field anywhere — the only writes
// are env.TOKEN_KV.put(...) calls, never to a Secret. Since the property is
// fundamentally "this field is never assigned to anywhere in the module", a
// single call already exercises the only relevant code path fully. We still
// model a short sequence of rotation events (each call independently either
// receives a rotated refresh_token from the exchange or doesn't) and assert
// the invariant after every call, not just at the end, since that costs
// little extra and would catch a future regression that made the read path
// stateful across calls in a way that also mutated the Secret field.
//
// Owned exclusively by this file: does not touch any other
// test/spotify/token*.spec.ts file, to avoid colliding with parallel tasks
// writing tests against the same module.

import { env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { getAccessToken, invalidateAccessToken } from "../../src/spotify/token";
import { createFakeSpotify } from "../helpers/fake-spotify";
import type { Env } from "../../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Credential string generator: non-empty printable ASCII, following
 * test/spotify/token.spec.ts's `credentialArb` convention.
 */
const credentialArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 40,
  unit: "grapheme-ascii",
});

/** One rotation event: the token exchange either issues a new refresh_token or doesn't. */
const rotationEventArb: fc.Arbitrary<{ rotatedToken: string | null }> = fc.oneof(
  credentialArb.map((rotatedToken) => ({ rotatedToken })),
  fc.constant({ rotatedToken: null }),
);

describe("bootstrap secret immutability", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 4: The bootstrap secret is never overwritten",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          credentialArb,
          fc.array(rotationEventArb, { minLength: 1, maxLength: 5 }),
          async (secretRefreshToken, events) => {
            // Cold Token_Store at the start of each run, so the exchange
            // path (and its fallback to the Secret when nothing is stored)
            // is genuinely exercised rather than short-circuited by a
            // leftover value from a previous run.
            await workerEnv.TOKEN_KV.delete("refresh_token");
            await workerEnv.TOKEN_KV.delete("rotated_at");

            const env: Env = {
              SPOTIFY_CLIENT_ID: "client-id",
              SPOTIFY_CLIENT_SECRET: "client-secret",
              SPOTIFY_REFRESH_TOKEN: secretRefreshToken,
              SHORTCUT_SECRET: "irrelevant-for-this-test",
              TOKEN_KV: workerEnv.TOKEN_KV,
            };

            const fake = createFakeSpotify();

            for (const event of events) {
              // Cold-cache each call, so a sequence of N events genuinely
              // exercises N exchanges rather than N-1 warm-cache hits.
              invalidateAccessToken();

              fake.scriptToken({
                status: 200,
                body: {
                  access_token: "access-token",
                  expires_in: 3600,
                  ...(event.rotatedToken !== null ? { refresh_token: event.rotatedToken } : {}),
                },
              });

              vi.stubGlobal("fetch", fake.fetch);
              await getAccessToken(env);
              vi.unstubAllGlobals();

              // The invariant must hold after every call, not just at the
              // end of the sequence.
              expect(env.SPOTIFY_REFRESH_TOKEN).toBe(secretRefreshToken);
            }

            expect(env.SPOTIFY_REFRESH_TOKEN).toBe(secretRefreshToken);
          },
        ),
      );
    },
  );
});

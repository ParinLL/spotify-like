// Property test for task 10.9. Per design.md's "Property 11", no
// client id, client secret, refresh token, shared secret, or access token
// value may appear as a substring of the response body, any response
// header, or any captured log output — for any outcome. This is a
// handler-level property: it drives the real `fetch` handler running in
// `workerd` (see design.md's Testing Strategy and tasks.md's note that
// Properties 2, 4, 5, 6, 7, 8, 9, 10, and 11 live in task 10, after the
// handler is wired), with a fake Spotify backend scripted to a spread of
// outcomes so the property is checked across "any outcome", not just the
// happy path.
//
// Requirements: 5.2

import { createExecutionContext, env as workerEnv, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import worker from "../../src/index";
import type { Env } from "../../src/types";
import { createFakeSpotify } from "../helpers/fake-spotify";

// `cloudflare:test` expects the CF-flavored `IncomingRequest`. See
// test/smoke.spec.ts for the same workaround.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * Secret-shaped string generator: non-empty, high-entropy-ish printable
 * ASCII. Long enough that an accidental substring collision between two
 * independently generated secrets is not a realistic false negative.
 */
const secretArb: fc.Arbitrary<string> = fc.string({
  minLength: 24,
  maxLength: 48,
  unit: "grapheme-ascii",
});

/**
 * Five distinct secret-shaped values: the four Env bindings plus the
 * access token the fake Spotify token endpoint returns. Distinctness
 * matters both so a substring match is meaningful (no accidental overlap
 * between two "different" secrets) and so a bug that leaks, say, the
 * refresh token instead of the client secret is still caught.
 */
const distinctSecretsArb: fc.Arbitrary<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  shortcutSecret: string;
  accessToken: string;
}> = fc
  .uniqueArray(secretArb, { minLength: 5, maxLength: 5 })
  .map(([clientId, clientSecret, refreshToken, shortcutSecret, accessToken]) => ({
    clientId: clientId!,
    clientSecret: clientSecret!,
    refreshToken: refreshToken!,
    shortcutSecret: shortcutSecret!,
    accessToken: accessToken!,
  }));

/** Which scripted Spotify scenario to run, and whether to present the correct bearer secret. */
type Scenario =
  | "added"
  | "nothing_playing"
  | "not_addable"
  | "token_failure"
  | "unauthorized_caller";

const scenarioArb: fc.Arbitrary<Scenario> = fc.constantFrom(
  "added",
  "nothing_playing",
  "not_addable",
  "token_failure",
  "unauthorized_caller",
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("secret containment", () => {
  it(
    "Feature: spotify-like-action-button, Property 11: Secrets never escape the Worker",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctSecretsArb,
          scenarioArb,
          async ({ clientId, clientSecret, refreshToken, shortcutSecret, accessToken }, scenario) => {
            const env: Env = {
              SPOTIFY_CLIENT_ID: clientId,
              SPOTIFY_CLIENT_SECRET: clientSecret,
              SPOTIFY_REFRESH_TOKEN: refreshToken,
              SHORTCUT_SECRET: shortcutSecret,
              TOKEN_KV: workerEnv.TOKEN_KV,
            };

            const fake = createFakeSpotify();
            fake.scriptToken({
              status: 200,
              body: { access_token: accessToken, token_type: "Bearer", expires_in: 3600 },
            });

            switch (scenario) {
              case "added":
                fake.scriptCurrentlyPlaying({
                  status: 200,
                  body: {
                    item: { id: "track123", name: "Test Track", artists: [{ name: "Test Artist" }] },
                    currently_playing_type: "track",
                    is_playing: true,
                  },
                });
                break;
              case "nothing_playing":
                fake.scriptCurrentlyPlaying({ status: 204 });
                break;
              case "not_addable":
                fake.scriptCurrentlyPlaying({
                  status: 200,
                  body: {
                    item: { id: null, name: "Local File", artists: [{ name: "Unknown" }] },
                    currently_playing_type: "track",
                    is_playing: true,
                  },
                });
                break;
              case "token_failure":
                fake.scriptToken({ status: 500, body: { error: "server_error" } });
                break;
              case "unauthorized_caller":
                // No Spotify scripting needed: the gate rejects before any call.
                break;
            }

            vi.stubGlobal("fetch", fake.fetch);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            const headers: Record<string, string> =
              scenario === "unauthorized_caller"
                ? {} // deliberately omit the Authorization header
                : { Authorization: `Bearer ${shortcutSecret}` };

            const request = new IncomingRequest("http://example.com/like", {
              method: "POST",
              headers,
            });
            const ctx = createExecutionContext();

            const response = await worker.fetch(request, env, ctx);
            await waitOnExecutionContext(ctx);

            const bodyText = await response.text();
            const headerText = [...response.headers.entries()]
              .map(([name, value]) => `${name}: ${value}`)
              .join("\n");
            const logText = logSpy.mock.calls
              .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
              .join("\n");

            const secrets = [clientId, clientSecret, refreshToken, shortcutSecret, accessToken];
            for (const secret of secrets) {
              expect(bodyText).not.toContain(secret);
              expect(headerText).not.toContain(secret);
              expect(logText).not.toContain(secret);
            }

            logSpy.mockRestore();
            vi.unstubAllGlobals();
          },
        ),
        // Handler-level property: each run boots a request through the real
        // workerd fetch handler plus a fake-Spotify round trip. Kept at the
        // 100-run floor since this scenario spread is not pathological.
        { numRuns: 100 },
      );
    },
  );
});

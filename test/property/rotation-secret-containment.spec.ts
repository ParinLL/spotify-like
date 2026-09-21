// Property test for task 6.1. Per design.md's "Property 9" for the
// spotify-like-action-button-token-rotation feature:
//
//   "For any outcome and any Token_Store content, no value ever read from
//   or written to Token_Store (a Refresh_Token or Rotated_Refresh_Token
//   string) appears as a substring of the response body, any response
//   header, or any captured log output. A Rotation_Timestamp value MAY
//   appear in captured log output but MUST NOT appear in the response body
//   or headers."
//
// This extends the base feature's secret-containment approach
// (test/property/secret-containment.spec.ts, Property 11 of the OTHER
// spec) to also cover KV-sourced refresh-token values: the bootstrap
// Secret, a value pre-populated into Token_Store before the request, and a
// Rotated_Refresh_Token issued during the request itself. Kept in its own
// file rather than extending secret-containment.spec.ts, since that file
// stays scoped to the base feature's Property 11 and this is a distinct
// property of this spec, even though the technique is the same.
//
// This is a handler-level property (same pattern as secret-containment.
// spec.ts and rotation-outcome-stability.spec.ts): it drives the real
// `fetch` handler running in `workerd`, with a fake Spotify backend
// scripted to a spread of scenarios, spying on console.log, and asserting
// none of the tracked secret values appear as a substring of the response
// body, response headers, or captured log output. One scenario also
// substitutes a failing `TOKEN_KV.put` via the same proxy technique used in
// rotation-outcome-stability.spec.ts / rotation-warning.spec.ts, to cover
// the case where a rotation is attempted but fails to persist.
//
// Requirements: 7.1, 7.2

import { createExecutionContext, env as workerEnv, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import worker from "../../src/index";
import { invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";
import { createFakeSpotify } from "../helpers/fake-spotify";

// `cloudflare:test` expects the CF-flavored `IncomingRequest`. See
// test/smoke.spec.ts for the same workaround.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const REFRESH_TOKEN_KV_KEY = "refresh_token";
const ROTATED_AT_KV_KEY = "rotated_at";

/**
 * Secret-shaped string generator: non-empty, high-entropy-ish printable
 * ASCII. Long enough that an accidental substring collision between two
 * independently generated secrets is not a realistic false negative. Same
 * shape as secret-containment.spec.ts's `secretArb`, but additionally
 * trimmed of leading/trailing whitespace: per the Fetch spec, header
 * values are trimmed of HTTP whitespace on the wire, so a `shortcutSecret`
 * with leading/trailing spaces would never round-trip through a real
 * `Authorization` header and would make the "added"/"nothing_playing"
 * scenarios below spuriously fail the gate.
 */
const secretArb: fc.Arbitrary<string> = fc
  .string({
    minLength: 24,
    maxLength: 48,
    unit: "grapheme-ascii",
  })
  .map((s) => s.trim())
  .filter((s) => s.length >= 8);

/**
 * Six distinct secret-shaped values: the four Env bindings, the fake
 * access token, a Rotated_Refresh_Token the fake token endpoint returns
 * during the request, and a Token_Store-sourced refresh token pre-
 * populated into TOKEN_KV before the request. Distinctness matters both so
 * a substring match is meaningful and so a bug that leaks, say, the
 * KV-sourced token instead of the Secret is still caught.
 */
const distinctSecretsArb: fc.Arbitrary<{
  clientId: string;
  clientSecret: string;
  bootstrapRefreshToken: string;
  shortcutSecret: string;
  accessToken: string;
  rotatedRefreshToken: string;
  kvSeededRefreshToken: string;
}> = fc
  .uniqueArray(secretArb, { minLength: 7, maxLength: 7 })
  .map(
    ([
      clientId,
      clientSecret,
      bootstrapRefreshToken,
      shortcutSecret,
      accessToken,
      rotatedRefreshToken,
      kvSeededRefreshToken,
    ]) => ({
      clientId: clientId!,
      clientSecret: clientSecret!,
      bootstrapRefreshToken: bootstrapRefreshToken!,
      shortcutSecret: shortcutSecret!,
      accessToken: accessToken!,
      rotatedRefreshToken: rotatedRefreshToken!,
      kvSeededRefreshToken: kvSeededRefreshToken!,
    }),
  );

/**
 * Which scripted scenario to run, covering the scenario spread called for
 * by the task: a successful add with a persisted rotation, a successful
 * add with a rotation that fails to persist, nothing playing, and a
 * KV-sourced token-exchange failure.
 */
type Scenario = "added_rotation_persisted" | "added_rotation_failed" | "nothing_playing" | "token_failure_from_kv";

const scenarioArb: fc.Arbitrary<Scenario> = fc.constantFrom(
  "added_rotation_persisted",
  "added_rotation_failed",
  "nothing_playing",
  "token_failure_from_kv",
);

/** Whether Token_Store starts empty (falls back to the Secret) or pre-populated, per "any Token_Store content". */
type StoreSeed = "empty" | "seeded";

const storeSeedArb: fc.Arbitrary<StoreSeed> = fc.constantFrom("empty", "seeded");

/** A KVNamespace-shaped proxy: `get`/`delete`/etc. delegate to the real namespace, `put` always rejects. */
function makeFailingPutKv(real: KVNamespace): KVNamespace {
  return {
    ...real,
    get: real.get.bind(real),
    delete: real.delete.bind(real),
    list: real.list.bind(real),
    getWithMetadata: real.getWithMetadata.bind(real),
    put: async () => {
      throw new Error("simulated Token_Store write failure");
    },
  } as unknown as KVNamespace;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rotation secret containment", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 9: Rotation bookkeeping never appears in the response or in logs",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          distinctSecretsArb,
          scenarioArb,
          storeSeedArb,
          async (
            {
              clientId,
              clientSecret,
              bootstrapRefreshToken,
              shortcutSecret,
              accessToken,
              rotatedRefreshToken,
              kvSeededRefreshToken,
            },
            scenario,
            storeSeed,
          ) => {
            // Clean slate for every run: cold access-token cache and an
            // empty Token_Store, so a prior run's cache/KV state can't
            // change this run's read-then-exchange path.
            invalidateAccessToken();
            await workerEnv.TOKEN_KV.delete(REFRESH_TOKEN_KV_KEY);
            await workerEnv.TOKEN_KV.delete(ROTATED_AT_KV_KEY);

            if (storeSeed === "seeded") {
              await workerEnv.TOKEN_KV.put(REFRESH_TOKEN_KV_KEY, kvSeededRefreshToken);
            }

            const usesFailingKv = scenario === "added_rotation_failed";
            const tokenKv = usesFailingKv ? makeFailingPutKv(workerEnv.TOKEN_KV) : workerEnv.TOKEN_KV;

            const env: Env = {
              SPOTIFY_CLIENT_ID: clientId,
              SPOTIFY_CLIENT_SECRET: clientSecret,
              SPOTIFY_REFRESH_TOKEN: bootstrapRefreshToken,
              SHORTCUT_SECRET: shortcutSecret,
              TOKEN_KV: tokenKv,
            };

            const fake = createFakeSpotify();

            switch (scenario) {
              case "added_rotation_persisted":
              case "added_rotation_failed":
                fake.scriptToken({
                  status: 200,
                  body: {
                    access_token: accessToken,
                    token_type: "Bearer",
                    expires_in: 3600,
                    refresh_token: rotatedRefreshToken,
                  },
                });
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
                fake.scriptToken({
                  status: 200,
                  body: {
                    access_token: accessToken,
                    token_type: "Bearer",
                    expires_in: 3600,
                    refresh_token: rotatedRefreshToken,
                  },
                });
                fake.scriptCurrentlyPlaying({ status: 204 });
                break;
              case "token_failure_from_kv":
                // Per Property 8, an auth failure is indistinguishable
                // regardless of whether the rejected refresh token came
                // from Token_Store or the Secret; a KV-sourced rejection
                // is picked here since covering every axis isn't necessary
                // for this containment property.
                fake.scriptToken({ status: 401, body: { error: "invalid_grant" } });
                break;
            }

            vi.stubGlobal("fetch", fake.fetch);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            const request = new IncomingRequest("http://example.com/like", {
              method: "POST",
              headers: { Authorization: `Bearer ${shortcutSecret}` },
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

            // For debugging/setup confirmation only — not part of the
            // assertion surface itself, per the task's guidance.
            void (await workerEnv.TOKEN_KV.get(REFRESH_TOKEN_KV_KEY));

            const trackedSecrets = [
              clientId,
              clientSecret,
              bootstrapRefreshToken,
              shortcutSecret,
              accessToken,
              rotatedRefreshToken,
              kvSeededRefreshToken,
            ];
            for (const secret of trackedSecrets) {
              expect(bodyText).not.toContain(secret);
              expect(headerText).not.toContain(secret);
              expect(logText).not.toContain(secret);
            }

            // The Rotation_Timestamp exception: only checked after a
            // scenario where a rotation actually succeeded (so there is a
            // real timestamp value to check), and only against body/
            // headers (the strict two of three) — the design explicitly
            // permits the timestamp in logs, so that axis is deliberately
            // not asserted here.
            if (scenario === "added_rotation_persisted") {
              const rotatedAt = await workerEnv.TOKEN_KV.get(ROTATED_AT_KV_KEY);
              expect(rotatedAt).not.toBeNull();
              if (rotatedAt !== null) {
                expect(bodyText).not.toContain(rotatedAt);
                expect(headerText).not.toContain(rotatedAt);
              }
            }

            logSpy.mockRestore();
            vi.unstubAllGlobals();

            // Clean up so state doesn't leak into the next fast-check run.
            await workerEnv.TOKEN_KV.delete(REFRESH_TOKEN_KV_KEY);
            await workerEnv.TOKEN_KV.delete(ROTATED_AT_KV_KEY);
            invalidateAccessToken();
          },
        ),
        // Handler-level property: each run boots a request through the real
        // workerd fetch handler plus a fake-Spotify round trip, plus real
        // (local-simulation) KV reads/writes. Kept at the 100-run floor
        // since this scenario spread is not pathological.
        { numRuns: 100 },
      );
    },
  );
});

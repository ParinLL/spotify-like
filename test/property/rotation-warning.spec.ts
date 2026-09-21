// Property test for task 4.3. Per design.md's "Property 6" for the
// spotify-like-action-button-token-rotation feature, the rotation-failure
// warning suffix on the `added` outcome's message must appear exactly when
// a rotation was attempted (Spotify's token response included a non-empty
// `refresh_token`) and persisting it to Token_Store failed — and must not
// appear in either of the other two cases (no rotation attempted; rotation
// attempted and persisted successfully).
//
// Requirements: 3.3
//
// This is a handler-level property (like test/property/secret-containment.
// spec.ts's Property 11): it drives the real `fetch` handler running in
// `workerd`, via `worker.fetch(...)`, with a fake Spotify backend scripted
// to a currently-playing track so the outcome is always `added`, and varies
// the token-exchange response and the TOKEN_KV write behavior across the
// three scenarios above.
//
// Dedicated file: per the task's file-collision-avoidance note, this does
// NOT touch test/property/secret-containment.spec.ts or any
// test/spotify/token*.spec.ts file, since task 4.4 (running in parallel)
// also needs to substitute a failing `TOKEN_KV.put`.

import { createExecutionContext, env as workerEnv, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import worker from "../../src/index";
import { invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";
import { createFakeSpotify } from "../helpers/fake-spotify";
import { trackNameArb } from "../helpers/generators";

// `cloudflare:test` expects the CF-flavored `IncomingRequest`. See
// test/smoke.spec.ts for the same workaround.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SHORTCUT_SECRET = "test-shortcut-secret";
const REFRESH_TOKEN_KV_KEY = "refresh_token";
const ROTATION_FAILED_SUFFIX = "（但 token 更新失敗，請留意）";

/** Non-empty printable-ASCII token string, following the style used elsewhere for refresh-token values. */
const tokenStringArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 40,
  unit: "grapheme-ascii",
});

/** Which of the three Property 6 scenarios a given run exercises. */
type RotationScenario = "no_rotation" | "rotation_persisted" | "rotation_failed";

const scenarioArb: fc.Arbitrary<RotationScenario> = fc.constantFrom(
  "no_rotation",
  "rotation_persisted",
  "rotation_failed",
);

/**
 * Builds an `Env` whose `TOKEN_KV` is the real ambient local-simulation
 * binding, optionally overriding specific methods. `get`/`delete` always
 * delegate to the real binding (so `readEffectiveRefreshToken`'s read still
 * works normally); only `put` is ever substituted, per design.md's Testing
 * Strategy note for Property 5's identical substitution technique.
 */
function envWithTokenKv(overrides: Partial<KVNamespace> = {}): Env {
  const tokenKv: KVNamespace = {
    ...workerEnv.TOKEN_KV,
    get: workerEnv.TOKEN_KV.get.bind(workerEnv.TOKEN_KV),
    put: workerEnv.TOKEN_KV.put.bind(workerEnv.TOKEN_KV),
    delete: workerEnv.TOKEN_KV.delete.bind(workerEnv.TOKEN_KV),
    list: workerEnv.TOKEN_KV.list.bind(workerEnv.TOKEN_KV),
    getWithMetadata: workerEnv.TOKEN_KV.getWithMetadata.bind(workerEnv.TOKEN_KV),
    ...overrides,
  } as unknown as KVNamespace;

  return {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REFRESH_TOKEN: "bootstrap-refresh-token",
    SHORTCUT_SECRET,
    TOKEN_KV: tokenKv,
  };
}

function scriptAddableTrack(fake: ReturnType<typeof createFakeSpotify>, name: string, artist: string): void {
  fake.scriptCurrentlyPlaying({
    status: 200,
    body: {
      item: { id: "track123", name, artists: [{ name: artist }] },
      currently_playing_type: "track",
      is_playing: true,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rotation-failure warning", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 6: The rotation-failure warning appears exactly when a rotation was attempted and failed",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          trackNameArb,
          trackNameArb,
          tokenStringArb,
          scenarioArb,
          async (trackName, artistName, rotatedRefreshToken, scenario) => {
            // Cold cache and clean Token_Store slate for every run, so runs
            // don't leak into each other: a warm access-token cache would
            // skip the exchange entirely (and thus skip the rotation
            // attempt), and a prior run's stored refresh token could alter
            // this run's read (readEffectiveRefreshToken runs before the
            // token-exchange call in every scenario).
            invalidateAccessToken();
            await workerEnv.TOKEN_KV.delete(REFRESH_TOKEN_KV_KEY);

            const fake = createFakeSpotify();
            scriptAddableTrack(fake, trackName, artistName);

            const tokenBody: Record<string, unknown> = {
              access_token: "fake-access-token",
              token_type: "Bearer",
              expires_in: 3600,
            };
            if (scenario !== "no_rotation") {
              tokenBody.refresh_token = rotatedRefreshToken;
            }
            fake.scriptToken({ status: 200, body: tokenBody });

            vi.stubGlobal("fetch", fake.fetch);

            const env: Env =
              scenario === "rotation_failed"
                ? envWithTokenKv({
                    put: () => Promise.reject(new Error("simulated TOKEN_KV.put failure")),
                  })
                : envWithTokenKv();

            const request = new IncomingRequest("http://example.com/like", {
              method: "POST",
              headers: { Authorization: `Bearer ${SHORTCUT_SECRET}` },
            });
            const ctx = createExecutionContext();

            const response = await worker.fetch(request, env, ctx);
            await waitOnExecutionContext(ctx);

            const json = (await response.json()) as { message: string; ok: boolean; outcome: string };

            expect(json.outcome).toBe("added");
            expect(json.ok).toBe(true);
            expect(response.status).toBe(200);

            if (scenario === "rotation_failed") {
              expect(json.message).toContain(ROTATION_FAILED_SUFFIX);
            } else {
              expect(json.message).not.toContain(ROTATION_FAILED_SUFFIX);
            }

            vi.unstubAllGlobals();
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

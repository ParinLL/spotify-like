// Property test for task 4.4. Per design.md's "Property 5", a Token_Store
// write failure during rotation must never change the Spotify-facing
// outcome (kind, ok, status) — only the `added` outcome's message may
// differ, by exactly the rotation-failure warning suffix.
//
// This is a handler-level property: it drives the real `fetch` handler
// (see test/smoke.spec.ts and test/property/secret-containment.spec.ts for
// the same pattern), running the same scripted scenario twice — once with
// the real (local-simulation) `env.TOKEN_KV`, once with a proxy whose `put`
// always rejects — and comparing the two responses. Per design.md's
// Testing Strategy note on this exact property: "the test wraps it: builds
// a test `Env` whose `TOKEN_KV` is a small proxy object delegating `get` to
// the real namespace but making `put` reject".
//
// Requirements: 3.1, 3.2, 3.4

import { createExecutionContext, env as workerEnv, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import worker from "../../src/index";
import { invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";
import { createFakeSpotify } from "../helpers/fake-spotify";
import { trackNameArb, artistNameArb } from "../helpers/generators";

// `cloudflare:test` expects the CF-flavored `IncomingRequest`. See
// test/smoke.spec.ts for the same workaround.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SHORTCUT_SECRET = "test-shortcut-secret";
const TOKEN_KV_KEY = "refresh_token";
// Hardcoded to match src/messages.ts's (unexported) ROTATION_FAILED_SUFFIX.
const ROTATION_FAILED_SUFFIX = "（但 token 更新失敗，請留意）";

/**
 * Scenarios reachable when the token exchange itself succeeds — the axis
 * Property 5 is about. auth_failed/api_failed/network_failed/misconfigured/
 * unauthorized arise when the exchange (or a data call) itself fails, a
 * different axis, out of scope here (see Property 8 / task 4.6).
 */
type Scenario = "added" | "nothing_playing" | "not_addable";

const scenarioArb: fc.Arbitrary<Scenario> = fc.constantFrom(
  "added",
  "nothing_playing",
  "not_addable",
);

const rotatedRefreshTokenArb: fc.Arbitrary<string> = fc.string({
  minLength: 8,
  maxLength: 40,
  unit: "grapheme-ascii",
});

function baseEnv(tokenKv: KVNamespace): Env {
  return {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REFRESH_TOKEN: "bootstrap-refresh-token",
    SHORTCUT_SECRET,
    TOKEN_KV: tokenKv,
  };
}

/** A KVNamespace-shaped proxy: `get` delegates to the real namespace, `put` always rejects. */
function makeFailingPutKv(real: KVNamespace): KVNamespace {
  return {
    ...real,
    get: real.get.bind(real),
    put: async () => {
      throw new Error("simulated Token_Store write failure");
    },
  } as unknown as KVNamespace;
}

function scriptScenario(
  fake: ReturnType<typeof createFakeSpotify>,
  scenario: Scenario,
  rotatedRefreshToken: string,
  track: { name: string; artist: string },
): void {
  fake.scriptToken({
    status: 200,
    body: {
      access_token: "fake-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: rotatedRefreshToken,
    },
  });

  switch (scenario) {
    case "added":
      fake.scriptCurrentlyPlaying({
        status: 200,
        body: {
          item: {
            id: "track123",
            name: track.name,
            artists: [{ name: track.artist }],
          },
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
          item: {
            id: null,
            name: track.name,
            artists: [{ name: track.artist }],
          },
          currently_playing_type: "track",
          is_playing: true,
        },
      });
      break;
  }
}

interface CapturedResponse {
  outcome: string;
  ok: boolean;
  status: number;
  message: string;
}

async function runRequest(env: Env): Promise<CapturedResponse> {
  const request = new IncomingRequest("http://example.com/like", {
    method: "POST",
    headers: { Authorization: `Bearer ${SHORTCUT_SECRET}` },
  });
  const ctx = createExecutionContext();

  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);

  const json = (await response.json()) as { outcome: string; ok: boolean; message: string };
  return { outcome: json.outcome, ok: json.ok, status: response.status, message: json.message };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rotation outcome stability", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 5: A Token_Store write failure never changes the Spotify-facing outcome",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          scenarioArb,
          trackNameArb,
          artistNameArb,
          rotatedRefreshTokenArb,
          async (scenario, trackName, artistName, rotatedRefreshToken) => {
            const track = { name: trackName, artist: artistName };

            // --- Run A: the real (local-simulation) TOKEN_KV, write succeeds ---
            await workerEnv.TOKEN_KV.delete(TOKEN_KV_KEY);
            invalidateAccessToken();

            const fakeA = createFakeSpotify();
            scriptScenario(fakeA, scenario, rotatedRefreshToken, track);
            vi.stubGlobal("fetch", fakeA.fetch);

            const runA = await runRequest(baseEnv(workerEnv.TOKEN_KV));
            vi.unstubAllGlobals();

            // --- Run B: a proxy whose `get` delegates to the real KV but `put` rejects ---
            await workerEnv.TOKEN_KV.delete(TOKEN_KV_KEY);
            invalidateAccessToken();

            const fakeB = createFakeSpotify();
            scriptScenario(fakeB, scenario, rotatedRefreshToken, track);
            vi.stubGlobal("fetch", fakeB.fetch);

            const failingKv = makeFailingPutKv(workerEnv.TOKEN_KV);
            const runB = await runRequest(baseEnv(failingKv));
            vi.unstubAllGlobals();

            // Clean up so state doesn't leak into the next fast-check run.
            await workerEnv.TOKEN_KV.delete(TOKEN_KV_KEY);
            invalidateAccessToken();

            expect(runB.outcome).toBe(runA.outcome);
            expect(runB.ok).toBe(runA.ok);
            expect(runB.status).toBe(runA.status);

            if (scenario === "added") {
              expect(runB.message).toBe(`${runA.message}${ROTATION_FAILED_SUFFIX}`);
            } else {
              expect(runB.message).toBe(runA.message);
            }
          },
        ),
        // Handler-level property, two full request round trips per run
        // (each including a token exchange + at least one Spotify data
        // call). Kept at the 100-run floor.
        { numRuns: 100 },
      );
    },
  );
});

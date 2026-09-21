// Property test for task 4.6. Per design.md's "Property 8", a token-exchange
// rejection (any 4xx status) using an Effective_Refresh_Token must produce
// exactly the base feature's `auth_failed` outcome — with no distinguishing
// field, outcome variant, or status code that reveals whether the rejected
// value came from Token_Store or from Worker_Secrets.
//
// This is a handler-level property: it drives the real `fetch` handler (see
// test/smoke.spec.ts and test/property/rotation-outcome-stability.spec.ts
// for the same pattern), running the same scripted 4xx rejection twice per
// iteration — once with the Effective_Refresh_Token sourced from Token_Store,
// once with it falling back to Worker_Secrets — and asserting both the fixed
// expectation and that the two runs are indistinguishable from each other.
//
// Requirements: 4.1, 4.2

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

const SHORTCUT_SECRET = "test-shortcut-secret";
const TOKEN_KV_KEY = "refresh_token";
// Hardcoded to match src/messages.ts's MESSAGES.auth_failed, per the task
// instructions ("check src/messages.ts to confirm the exact string rather
// than assuming").
const AUTH_FAILED_MESSAGE = "Spotify 授權已失效，請重新取得授權";

/** Any 4xx status, per design.md's "any 4xx status" wording for Property 8. */
const fourXxStatusArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 400, max: 499 }) },
  // Guarantee 401 is sampled directly: the most realistic Spotify rejection
  // code for a bad refresh token, even though the property covers any 4xx.
  { weight: 1, arbitrary: fc.constant(401) },
);

/** Whether the Effective_Refresh_Token for this run is sourced from Token_Store or from the Secret. */
type Source = "kv" | "secret";
const sourceArb: fc.Arbitrary<Source> = fc.constantFrom("kv", "secret");

/** A refresh-token-shaped string: non-empty, printable, arbitrary length. */
const refreshTokenArb: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 64,
  unit: "grapheme-ascii",
});

function baseEnv(): Env {
  return {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REFRESH_TOKEN: "bootstrap-refresh-token",
    SHORTCUT_SECRET,
    TOKEN_KV: workerEnv.TOKEN_KV,
  };
}

/**
 * Prepares Token_Store for the given source: writes a refresh token under
 * KV_KEY when sourcing from Token_Store, or deletes the key so the read
 * falls through to `env.SPOTIFY_REFRESH_TOKEN` otherwise.
 */
async function prepareSource(source: Source, refreshToken: string): Promise<void> {
  if (source === "kv") {
    await workerEnv.TOKEN_KV.put(TOKEN_KV_KEY, refreshToken);
  } else {
    await workerEnv.TOKEN_KV.delete(TOKEN_KV_KEY);
  }
}

interface CapturedResponse {
  status: number;
  body: unknown;
}

async function runRequest(env: Env): Promise<CapturedResponse> {
  const request = new IncomingRequest("http://example.com/like", {
    method: "POST",
    headers: { Authorization: `Bearer ${SHORTCUT_SECRET}` },
  });
  const ctx = createExecutionContext();

  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);

  const body = await response.json();
  return { status: response.status, body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth-failure indistinguishability", () => {
  it(
    "Feature: spotify-like-action-button-token-rotation, Property 8: An auth failure on the effective refresh token is indistinguishable from any other auth failure",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fourXxStatusArb,
          refreshTokenArb,
          refreshTokenArb,
          async (status, kvRefreshToken, secretSourcedRefreshToken) => {
            // --- Run A: Effective_Refresh_Token sourced from Token_Store ---
            await prepareSource("kv", kvRefreshToken);
            invalidateAccessToken();

            const fakeA = createFakeSpotify();
            fakeA.scriptToken({ status, body: { error: "invalid_grant" } });
            vi.stubGlobal("fetch", fakeA.fetch);

            const runA = await runRequest(baseEnv());
            vi.unstubAllGlobals();

            // --- Run B: Effective_Refresh_Token falls back to Worker_Secrets ---
            await prepareSource("secret", secretSourcedRefreshToken);
            invalidateAccessToken();

            const fakeB = createFakeSpotify();
            fakeB.scriptToken({ status, body: { error: "invalid_grant" } });
            vi.stubGlobal("fetch", fakeB.fetch);

            const runB = await runRequest(baseEnv());
            vi.unstubAllGlobals();

            // Clean up so state doesn't leak into the next fast-check run.
            await workerEnv.TOKEN_KV.delete(TOKEN_KV_KEY);
            invalidateAccessToken();

            // Hardcoded anchor: both runs must match the base feature's
            // existing auth_failed shape exactly, regardless of source.
            const expected = {
              message: AUTH_FAILED_MESSAGE,
              ok: false,
              outcome: "auth_failed",
            };
            expect(runA.status).toBe(200);
            expect(runA.body).toEqual(expected);
            expect(runB.status).toBe(200);
            expect(runB.body).toEqual(expected);

            // Critical assertion: the two runs are indistinguishable from
            // each other, regardless of whether the rejected
            // Effective_Refresh_Token came from Token_Store or the Secret.
            expect(runB.status).toBe(runA.status);
            expect(runB.body).toEqual(runA.body);
          },
        ),
        // Handler-level property, two full request round trips per run
        // (each including a token exchange rejected with a 4xx). Kept at
        // the 100-run floor.
        { numRuns: 100 },
      );
    },
  );
});

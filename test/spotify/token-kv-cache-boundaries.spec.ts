// Unit tests for task 2.8. Per tasks.md's task 2.8 and design.md's
// Testing Strategy ("Unit tests cover what the properties don't"), these
// assert three cache/KV boundary behaviors that aren't properties in their
// own right:
//
//   1. A warm access-token cache skips the KV read entirely (no
//      `env.TOKEN_KV.get` call when `getAccessToken` returns early from
//      cache) — extends token-cache.spec.ts's warm-cache coverage with an
//      explicit KV-read assertion.
//   2. `invalidateAccessToken()` never touches Token_Store — it only clears
//      the in-isolate Access_Token cache.
//   3. The stale-token retry path in src/like.ts (`withStaleTokenRetry`,
//      not exported) calls `getAccessToken(env)` again after invalidating
//      the cache, and that second call also reads Token_Store, not just
//      the Secret.
//
// Requirements: 2.1, 2.4
//
// This file is dedicated to task 2.8 only, to avoid colliding with other
// in-flight tasks writing to test/spotify/token*.spec.ts (see
// token-rotation-persistence.spec.ts's header comment for the same
// convention).
//
// Uses the real ambient local-simulation KV binding from `cloudflare:test`,
// per design.md's Testing Strategy ("tests interact with env.TOKEN_KV as a
// real (local-simulation) KVNamespace"). vi.spyOn works directly on that
// real KVNamespace instance's methods, so no hand-rolled proxy is needed
// here (contrast with Property 5's KV-put-failure test, which needs `put`
// to actually fail rather than just be observed).

import { env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, invalidateAccessToken } from "../../src/spotify/token";
import { likeCurrentTrack } from "../../src/like";
import type { Env } from "../../src/types";
import { createFakeSpotify } from "../helpers/fake-spotify";

const REFRESH_TOKEN_KV_KEY = "refresh_token";

const env: Env = {
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "client-secret",
  SPOTIFY_REFRESH_TOKEN: "bootstrap-refresh-token",
  SHORTCUT_SECRET: "irrelevant-for-this-test",
  TOKEN_KV: workerEnv.TOKEN_KV,
};

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: accessToken, expires_in: expiresIn }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  invalidateAccessToken();
  await workerEnv.TOKEN_KV.delete(REFRESH_TOKEN_KV_KEY);
});

describe("warm cache skips the KV read", () => {
  it("a second getAccessToken call on a warm cache never calls TOKEN_KV.get or fetch again", async () => {
    invalidateAccessToken();
    await workerEnv.TOKEN_KV.delete(REFRESH_TOKEN_KV_KEY);

    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1"));
    vi.stubGlobal("fetch", fetchMock);

    // Prime the cache: this first call is expected to read KV (cold cache).
    const first = await getAccessToken(env);
    expect(first.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Now spy on TOKEN_KV.get only after priming, so the assertion is
    // scoped to the warm-cache call.
    const getSpy = vi.spyOn(workerEnv.TOKEN_KV, "get");

    const second = await getAccessToken(env);

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.token).toBe("token-1");
    }
    // Warm-cache early return: no KV read, and no second fetch.
    expect(getSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateAccessToken() touches no TOKEN_KV method", () => {
  it("calling invalidateAccessToken() directly never calls get, put, or delete on TOKEN_KV", () => {
    const getSpy = vi.spyOn(workerEnv.TOKEN_KV, "get");
    const putSpy = vi.spyOn(workerEnv.TOKEN_KV, "put");
    const deleteSpy = vi.spyOn(workerEnv.TOKEN_KV, "delete");

    invalidateAccessToken();

    expect(getSpy).not.toHaveBeenCalled();
    expect(putSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("stale-token retry re-reads Token_Store", () => {
  it("the retry's second getAccessToken call re-exchanges using the KV-stored refresh token, not just the Secret", async () => {
    invalidateAccessToken();
    await workerEnv.TOKEN_KV.delete(REFRESH_TOKEN_KV_KEY);

    const KV_REFRESH_TOKEN = "kv-stored-refresh-token";
    await workerEnv.TOKEN_KV.put(REFRESH_TOKEN_KV_KEY, KV_REFRESH_TOKEN);

    const fake = createFakeSpotify();
    fake.scriptToken({
      status: 200,
      body: { access_token: "access-token-1", token_type: "Bearer", expires_in: 3600 },
    });

    // First currently-playing call: a stale 401. withStaleTokenRetry will
    // invalidate the cache, re-exchange, and retry the data call once.
    let currentlyPlayingCalls = 0;
    fake.route(
      (url, method) => method === "GET" && url.pathname === "/v1/me/player/currently-playing",
      () => {
        currentlyPlayingCalls += 1;
        if (currentlyPlayingCalls === 1) {
          return { status: 401, body: { error: { status: 401, message: "The access token expired" } } };
        }
        return {
          status: 200,
          body: {
            item: { id: "track123", name: "Test Track", artists: [{ name: "Test Artist" }] },
            currently_playing_type: "track",
            is_playing: true,
          },
        };
      },
    );

    vi.stubGlobal("fetch", fake.fetch);
    const getSpy = vi.spyOn(workerEnv.TOKEN_KV, "get");

    const outcome = await likeCurrentTrack(env);

    expect(outcome.kind).toBe("added");
    expect(currentlyPlayingCalls).toBe(2);

    // The retry's second getAccessToken call (after invalidateAccessToken())
    // re-reads TOKEN_KV rather than skipping straight to the Secret: called
    // at least twice across the whole invocation (initial exchange, then
    // the retry's re-exchange).
    expect(getSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // More directly: both outbound token-exchange requests used the
    // KV-stored value as refresh_token, never the bootstrap Secret.
    const tokenRequests = fake.requestLog.filter(
      (r) => r.method === "POST" && r.url.startsWith("https://accounts.spotify.com/api/token"),
    );
    expect(tokenRequests.length).toBe(2);
    for (const req of tokenRequests) {
      const params = new URLSearchParams(req.body ?? "");
      expect(params.get("refresh_token")).toBe(KV_REFRESH_TOKEN);
    }
  });
});

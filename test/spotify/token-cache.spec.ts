// Unit tests for the token cache in src/spotify/token.ts. Covers the
// warm-cache skip, the 60s expiry margin forcing a fresh exchange, the
// expires_in default of 3600s, invalidateAccessToken() forcing a
// re-exchange, and the cache's secretFingerprint guard against cross-file
// module reuse. See design.md, "spotify/token.ts — token exchange".
//
// Task 5.3. Validates: Requirements 3.1
//
// NOTE on isolation: @cloudflare/vitest-pool-workers documents storage
// isolation as per test file, but ALSO documents that it "reuses Workers
// and their module caches between test runs where possible" — the
// module-scope `cached` variable in src/spotify/token.ts is therefore NOT
// guaranteed to reset between test files. This was observed causing a real
// flaky CI failure (a different test file's cached token leaking into
// test/spotify/token.spec.ts's Property 1 test, GitHub Actions run
// 35591003436) even though it never reproduced locally. `cached` now
// records a `secretFingerprint` (the SPOTIFY_REFRESH_TOKEN Secret in effect
// when it was populated) and getAccessToken treats a mismatch as a cache
// miss — see the "secretFingerprint guard" describe block below for the
// direct regression test. We still call invalidateAccessToken() at the
// start of every test body as a first line of defense.
//
// Time is controlled via vi.spyOn(Date, "now") rather than
// vi.useFakeTimers(), since http.ts applies a real AbortSignal.timeout(6000)
// on every call and full fake timers could interfere with that.

import { env as workerEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, invalidateAccessToken } from "../../src/spotify/token";
import type { Env } from "../../src/types";

const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3600;

const env: Env = {
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "client-secret",
  SPOTIFY_REFRESH_TOKEN: "refresh-token",
  SHORTCUT_SECRET: "irrelevant-for-this-test",
  TOKEN_KV: workerEnv.TOKEN_KV,
};

function tokenResponse(accessToken: string, expiresIn?: number): Response {
  const body: Record<string, unknown> = { access_token: accessToken };
  if (expiresIn !== undefined) body.expires_in = expiresIn;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  invalidateAccessToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("token cache", () => {
  it("a warm cache skips the exchange on the second call", async () => {
    invalidateAccessToken();
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1"));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getAccessToken(env);
    const second = await getAccessToken(env);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) {
      expect(first.value.token).toBe("token-1");
      expect(first.value.rotationFailed).toBe(false);
    }
    if (second.ok) {
      expect(second.value.token).toBe("token-1");
      expect(second.value.rotationFailed).toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a token inside the expiry margin triggers a fresh exchange", async () => {
    invalidateAccessToken();
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1", 3600));
    vi.stubGlobal("fetch", fetchMock);

    const baseNow = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

    const first = await getAccessToken(env);
    expect(first.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // expiresAt = baseNow + 3600_000; advance past expiresAt - 60_000.
    const expiresAt = baseNow + 3600 * 1000;
    nowSpy.mockReturnValue(expiresAt - EXPIRY_MARGIN_MS + 1);

    fetchMock.mockResolvedValue(tokenResponse("token-2", 3600));
    const second = await getAccessToken(env);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.token).toBe("token-2");
      expect(second.value.rotationFailed).toBe(false);
    }
  });

  it("a missing expires_in defaults to 3600 seconds", async () => {
    invalidateAccessToken();
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1"));
    vi.stubGlobal("fetch", fetchMock);

    const baseNow = 2_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

    const first = await getAccessToken(env);
    expect(first.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const defaultExpiresAt = baseNow + DEFAULT_EXPIRES_IN_S * 1000;

    // Just before the 3600s - 60s = 3540s mark: still cached, no new fetch.
    nowSpy.mockReturnValue(defaultExpiresAt - EXPIRY_MARGIN_MS - 1);
    const stillCached = await getAccessToken(env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stillCached.ok).toBe(true);
    if (stillCached.ok) {
      expect(stillCached.value.token).toBe("token-1");
      expect(stillCached.value.rotationFailed).toBe(false);
    }

    // Just after the mark: re-exchange happens.
    fetchMock.mockResolvedValue(tokenResponse("token-2"));
    nowSpy.mockReturnValue(defaultExpiresAt - EXPIRY_MARGIN_MS + 1);
    const reExchanged = await getAccessToken(env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reExchanged.ok).toBe(true);
    if (reExchanged.ok) {
      expect(reExchanged.value.token).toBe("token-2");
      expect(reExchanged.value.rotationFailed).toBe(false);
    }
  });

  it("invalidateAccessToken() forces the next call to re-exchange", async () => {
    invalidateAccessToken();
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1"));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getAccessToken(env);
    expect(first.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateAccessToken();

    fetchMock.mockResolvedValue(tokenResponse("token-2"));
    const second = await getAccessToken(env);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.token).toBe("token-2");
      expect(second.value.rotationFailed).toBe(false);
    }
  });
});

describe("token cache — secretFingerprint guard", () => {
  it("a cached token from a different SPOTIFY_REFRESH_TOKEN is never reused, even within the expiry margin", async () => {
    invalidateAccessToken();

    // Simulate one "test file" populating the cache under its own Secret.
    const envA: Env = { ...env, SPOTIFY_REFRESH_TOKEN: "secret-from-file-a" };
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-from-a", 3600));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getAccessToken(envA);
    expect(first.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate a different "test file" reusing the same module instance
    // (per Cloudflare's documented module-cache reuse) with a DIFFERENT
    // SPOTIFY_REFRESH_TOKEN, well within the first token's expiry margin.
    // Without the fingerprint guard, this would incorrectly hit the warm
    // cache and return token-from-a without ever calling fetch.
    const envB: Env = { ...env, SPOTIFY_REFRESH_TOKEN: "secret-from-file-b" };
    fetchMock.mockResolvedValue(tokenResponse("token-from-b", 3600));

    const second = await getAccessToken(envB);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.token).toBe("token-from-b");
    }
  });

  it("a cached token under the SAME SPOTIFY_REFRESH_TOKEN is still reused normally (no regression to the warm-cache behavior)", async () => {
    invalidateAccessToken();

    const fetchMock = vi.fn().mockResolvedValue(tokenResponse("token-1", 3600));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getAccessToken(env);
    const second = await getAccessToken(env);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.token).toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

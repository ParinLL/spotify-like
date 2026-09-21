// Unit tests for the token cache in src/spotify/token.ts. Covers the
// warm-cache skip, the 60s expiry margin forcing a fresh exchange, the
// expires_in default of 3600s, and invalidateAccessToken() forcing a
// re-exchange. See design.md, "spotify/token.ts — token exchange".
//
// Task 5.3. Validates: Requirements 3.1
//
// NOTE on isolation: this file, per Cloudflare's vitest-pool-workers docs,
// runs with per-test-file isolation (a fresh module registry per test
// file), so the module-scope `cached` variable in src/spotify/token.ts does
// not leak into test/spotify/token.spec.ts (task 5.2's property test) even
// without any special handling here. We still restore Date.now() in
// afterEach and call invalidateAccessToken() defensively at the start of
// every test body, as a second line of defense in case that isolation
// assumption ever changes.
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

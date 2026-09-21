// Unit tests for the no-throw fetch wrapper (src/spotify/http.ts). Covers
// status classification boundaries, network/timeout failures, and
// readJson's tolerance of empty/malformed bodies. See design.md
// "spotify/http.ts — the call wrapper".
//
// Task 4.2. Validates: Requirements 4.3, 4.4

import { afterEach, describe, expect, it, vi } from "vitest";
import { call, readJson } from "../../src/spotify/http";

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("call — status classification boundaries", () => {
  it("200 resolves ok with the response", async () => {
    const res = jsonResponse(200, { ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(res);
  });

  it("399 (just under the error threshold) resolves ok", async () => {
    const res = jsonResponse(399);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result.ok).toBe(true);
  });

  it("400 resolves err({kind: 'api'})", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(400)));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result).toEqual({ ok: false, error: { kind: "api", status: 400 } });
  });

  it("401 resolves err({kind: 'auth'})", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401)));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result).toEqual({ ok: false, error: { kind: "auth", status: 401 } });
  });

  it("403 resolves err({kind: 'auth'})", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403)));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result).toEqual({ ok: false, error: { kind: "auth", status: 403 } });
  });

  it("404 resolves err({kind: 'api'}), never 'auth'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404)));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result).toEqual({ ok: false, error: { kind: "api", status: 404 } });
  });

  it("500 resolves err({kind: 'api'})", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500)));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result).toEqual({ ok: false, error: { kind: "api", status: 500 } });
  });

  it("429 resolves err({kind: 'api'}), never 'auth', and is not retried inside this module", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429));
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result).toEqual({ ok: false, error: { kind: "api", status: 429 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("call — network and timeout failures", () => {
  it("a thrown error (DNS/TLS/reset) resolves err({kind: 'network'})", async () => {
    const cause = new TypeError("network error");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result).toEqual({ ok: false, error: { kind: "network", cause } });
  });

  it("an aborted/timed-out request resolves err({kind: 'network'})", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    const result = await call("https://api.spotify.com/v1/me", {});

    expect(result).toEqual({ ok: false, error: { kind: "network", cause: abortError } });
  });

  it("applies a 6000ms AbortSignal.timeout to every request", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200)));

    await call("https://api.spotify.com/v1/me", {});

    expect(timeoutSpy).toHaveBeenCalledWith(6_000);
    timeoutSpy.mockRestore();
  });

  it("passes the timeout signal through to fetch as init.signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await call("https://api.spotify.com/v1/me", { method: "GET" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("GET");
  });
});

describe("readJson", () => {
  it("returns undefined for an empty body", async () => {
    const res = new Response("");

    await expect(readJson(res)).resolves.toBeUndefined();
  });

  it("returns undefined for a malformed/invalid JSON body", async () => {
    const res = new Response("{not valid json");

    await expect(readJson(res)).resolves.toBeUndefined();
  });

  it("returns the parsed value for a valid JSON body", async () => {
    const res = new Response(JSON.stringify({ access_token: "abc", expires_in: 3600 }));

    await expect(readJson(res)).resolves.toEqual({ access_token: "abc", expires_in: 3600 });
  });
});

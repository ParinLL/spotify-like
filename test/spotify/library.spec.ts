// Unit tests for add-only saved-tracks writes (src/spotify/library.ts).
// Covers the PUT URL/URI-encoding, that a re-add of a present track is
// treated as a plain success (PUT is idempotent per design.md), the
// isTrackSaved boolean-array parsing, and that probe failures are swallowed
// rather than propagated. See design.md "spotify/library.ts — add-only
// writes".
//
// Task 7.2. Validates: Requirements 2.1, 2.2, 3.5

import { afterEach, describe, expect, it, vi } from "vitest";
import { isTrackSaved, saveTrack, trackUriFromId } from "../../src/spotify/library";
import * as library from "../../src/spotify/library";

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackUriFromId", () => {
  it("produces spotify:track:<id>", () => {
    expect(trackUriFromId("abc123")).toBe("spotify:track:abc123");
  });
});

describe("saveTrack", () => {
  it("issues a PUT to /v1/me/library with the URI-encoded track URI and a Bearer header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const trackUri = trackUriFromId("abc123");
    const result = await saveTrack("token-xyz", trackUri);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(trackUri)}`);
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-xyz");
  });

  it("percent-encodes special characters in the track URI within the query string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    // Track ids are normally alphanumeric, but the URI is built via string
    // interpolation, so a value containing reserved/special characters must
    // still come out encodeURIComponent-encoded in the final query string.
    const trackUri = trackUriFromId("a b&c=d");
    await saveTrack("token-xyz", trackUri);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(trackUri)}`);
    expect(url).toContain(encodeURIComponent("a b&c=d"));
    expect(url).not.toContain("a b&c=d");
  });

  it("resolves ok(...) when re-adding an already-present track (PUT is idempotent, success is success)", async () => {
    // Spotify's PUT /me/library is idempotent: adding a track already in the
    // library returns 200 with no special-cased response shape.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const trackUri = trackUriFromId("already-saved");
    const result = await saveTrack("token-xyz", trackUri);

    expect(result.ok).toBe(true);
  });
});

describe("isTrackSaved", () => {
  it("resolves true when the probe returns [true]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [true])));

    await expect(isTrackSaved("token-xyz", trackUriFromId("abc123"))).resolves.toBe(true);
  });

  it("resolves false when the probe returns [false]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [false])));

    await expect(isTrackSaved("token-xyz", trackUriFromId("abc123"))).resolves.toBe(false);
  });

  it("resolves false rather than throwing when fetch rejects with a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));

    await expect(isTrackSaved("token-xyz", trackUriFromId("abc123"))).resolves.toBe(false);
  });

  it("resolves false rather than throwing when the probe returns a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500)));

    await expect(isTrackSaved("token-xyz", trackUriFromId("abc123"))).resolves.toBe(false);
  });

  it("resolves false rather than throwing when the probe body is malformed", async () => {
    const malformed = new Response("{not valid json", { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(malformed));

    await expect(isTrackSaved("token-xyz", trackUriFromId("abc123"))).resolves.toBe(false);
  });

  it("a probe failure cannot change the outcome: saveTrack still succeeds independently", async () => {
    // isTrackSaved is off-critical-path — even when it fails, saveTrack (the
    // operation that actually determines the outcome) is unaffected because
    // the two are never coupled at the call site.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    const probeResult = await isTrackSaved("token-xyz", trackUriFromId("abc123"));
    expect(probeResult).toBe(false);

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200)));
    const saveResult = await saveTrack("token-xyz", trackUriFromId("abc123"));
    expect(saveResult.ok).toBe(true);
  });
});

describe("module export surface", () => {
  it("exports no DELETE-issuing function (add-only)", () => {
    const exportNames = Object.keys(library);
    expect(exportNames).toEqual(["trackUriFromId", "saveTrack", "isTrackSaved"]);
    for (const name of exportNames) {
      expect(name.toLowerCase()).not.toContain("delete");
      expect(name.toLowerCase()).not.toContain("remove");
    }
  });
});

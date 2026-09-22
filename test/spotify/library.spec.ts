// Unit tests for add-only saved-tracks writes (src/spotify/library.ts).
// Covers the PUT URL/URI-encoding, that a re-add of a present item is
// treated as a plain success (PUT is idempotent per design.md), and that the
// module exposes no removal path. See design.md "spotify/library.ts —
// add-only writes".
//
// Task 7.2. Validates: Requirements 2.1, 2.2, 3.5

import { afterEach, describe, expect, it, vi } from "vitest";
import { episodeUriFromId, saveTrack, trackUriFromId } from "../../src/spotify/library";
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

describe("episodeUriFromId", () => {
  it("produces spotify:episode:<id>", () => {
    expect(episodeUriFromId("ep123")).toBe("spotify:episode:ep123");
  });

  it("can be saved through the same saveTrack PUT call as a track URI", async () => {
    // /me/library accepts episode URIs through the same PUT call — no
    // separate endpoint or function is needed for episodes.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const episodeUri = episodeUriFromId("ep123");
    const result = await saveTrack("token-xyz", episodeUri);

    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(episodeUri)}`);
    expect(init.method).toBe("PUT");
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

describe("module export surface", () => {
  it("exports no DELETE-issuing function (add-only)", () => {
    const exportNames = Object.keys(library);
    expect(exportNames).toEqual(["trackUriFromId", "episodeUriFromId", "saveTrack"]);
    for (const name of exportNames) {
      expect(name.toLowerCase()).not.toContain("delete");
      expect(name.toLowerCase()).not.toContain("remove");
    }
  });
});

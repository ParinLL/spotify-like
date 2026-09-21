// Unit tests for currently-playing normalization (src/spotify/player.ts).
// One case per row of the response table in design.md,
// "spotify/player.ts — reading playback".
//
// Task 6.2. Validates: Requirements 1.1, 1.4

import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentlyPlaying } from "../../src/spotify/player";

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getCurrentlyPlaying — normalization table", () => {
  it("204 No Content (nothing active) normalizes to { track: null }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({ ok: true, value: { track: null } });
  });

  it("200 with an empty body normalizes to { track: null }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({ ok: true, value: { track: null } });
  });

  it("200 with item: null normalizes to { track: null }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { item: null })));

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({ ok: true, value: { track: null } });
  });

  it("200 with currently_playing_type: 'ad' normalizes to { track: null }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: "track1", name: "Song", artists: [{ name: "Artist" }] },
          currently_playing_type: "ad",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({ ok: true, value: { track: null } });
  });

  it("200 with currently_playing_type: 'unknown' normalizes to { track: null }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: "track1", name: "Song", artists: [{ name: "Artist" }] },
          currently_playing_type: "unknown",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({ ok: true, value: { track: null } });
  });

  it("200 with currently_playing_type: 'episode' normalizes to a track with id: null, not { track: null }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: "ep1", name: "Episode", artists: [{ name: "Show" }] },
          currently_playing_type: "episode",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // An episode still yields a track object — it must not collapse into
    // the "nothing playing" case, even though its id is not addable.
    expect(result.value.track).not.toBeNull();
    expect(result.value.track?.id).toBeNull();
    expect(result.value).toEqual({ track: { id: null, name: "Episode", artist: "Show" } });
  });

  it("200 track with id: null (local file) normalizes to a track with id: null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: null, name: "Local File", artists: [{ name: "Unknown" }] },
          currently_playing_type: "track",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({
      ok: true,
      value: { track: { id: null, name: "Local File", artist: "Unknown" } },
    });
  });

  it("200 track with an id, is_playing: false (paused) still counts as a track", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: "track1", name: "Song", artists: [{ name: "Artist" }] },
          is_playing: false,
          currently_playing_type: "track",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({
      ok: true,
      value: { track: { id: "track1", name: "Song", artist: "Artist" } },
    });
  });
});

describe("getCurrentlyPlaying — artist extraction edge cases", () => {
  it("falls back to an empty artist string when artists is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: "track1", name: "Song" },
          currently_playing_type: "track",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({
      ok: true,
      value: { track: { id: "track1", name: "Song", artist: "" } },
    });
  });

  it("falls back to an empty artist string when artists is an empty array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: "track1", name: "Song", artists: [] },
          currently_playing_type: "track",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({
      ok: true,
      value: { track: { id: "track1", name: "Song", artist: "" } },
    });
  });
});

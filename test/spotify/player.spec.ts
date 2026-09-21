// Unit tests for currently-playing normalization (src/spotify/player.ts).
// One case per row of the response table in design.md,
// "spotify/player.ts — reading playback", plus the episode-specific
// normalization added when episode support was introduced.
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

// Regression test: the endpoint defaults to track-only responses and
// reports a playing episode with an empty `item` unless the request
// explicitly asks for episode data via `additional_types`. This was the
// real root cause behind episodes always appearing not-addable in
// production — see https://github.com/spotify/web-api/issues/1496.
describe("getCurrentlyPlaying — request shape", () => {
  it("requests additional_types=track,episode so episode data is actually returned", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await getCurrentlyPlaying("token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v1/me/player/currently-playing");
    expect(parsed.searchParams.get("additional_types")).toBe("track,episode");
  });
});

describe("getCurrentlyPlaying — normalization table", () => {
  it("204 No Content (nothing active) normalizes to { track: null, episode: null }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({ ok: true, value: { track: null, episode: null } });
  });

  it("200 with an empty body normalizes to { track: null, episode: null }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({ ok: true, value: { track: null, episode: null } });
  });

  it("200 with item: null normalizes to { track: null, episode: null }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { item: null })));

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({ ok: true, value: { track: null, episode: null } });
  });

  it("200 with currently_playing_type: 'ad' normalizes to { track: null, episode: null }", async () => {
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

    expect(result).toEqual({ ok: true, value: { track: null, episode: null } });
  });

  it("200 with currently_playing_type: 'unknown' normalizes to { track: null, episode: null }", async () => {
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

    expect(result).toEqual({ ok: true, value: { track: null, episode: null } });
  });

  it("200 with currently_playing_type: 'episode' normalizes to an episode with the show name, not { track, episode: null }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: {
            id: "ep1",
            name: "Episode Title",
            show: { name: "The Show" },
          },
          currently_playing_type: "episode",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // An episode is reported through `episode`, never `track` — it must
    // not collapse into "nothing playing" or get treated as a track.
    expect(result.value.track).toBeNull();
    expect(result.value.episode).not.toBeNull();
    expect(result.value).toEqual({
      track: null,
      episode: { id: "ep1", name: "Episode Title", show: "The Show" },
    });
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
      value: {
        track: { id: null, name: "Local File", artist: "Unknown" },
        episode: null,
      },
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
      value: {
        track: { id: "track1", name: "Song", artist: "Artist" },
        episode: null,
      },
    });
  });

  // Regression test: Spotify sometimes reports a playing podcast episode
  // with `item: null` (no full item object at all), not just `item: {...}`
  // with `currently_playing_type: "episode"`. This combination was
  // observed against the real Spotify API in production and was
  // originally misclassified as `{track: null}` ("nothing playing")
  // instead of surfacing as a (not-addable) episode, because the
  // `item === null` early-return in getCurrentlyPlaying ran before the
  // `currently_playing_type === "episode"` check. The episode check now
  // runs first and always returns an `episode` value (never null) for this
  // type, even when `item` itself is null and the resulting name/show
  // fall back to empty strings; `episode.id` is null in that case, which
  // the orchestration layer (like.ts) treats as not-addable, same as a
  // local file.
  it("200 with item: null AND currently_playing_type: 'episode' still yields an episode with id: null, not { episode: null }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          is_playing: true,
          timestamp: 1789983711448,
          context: null,
          progress_ms: 3855220,
          item: null,
          currently_playing_type: "episode",
          actions: { disallows: { resuming: true } },
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.track).toBeNull();
    expect(result.value.episode).not.toBeNull();
    expect(result.value.episode?.id).toBeNull();
    expect(result.value).toEqual({
      track: null,
      episode: { id: null, name: "", show: "" },
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
      value: {
        track: { id: "track1", name: "Song", artist: "" },
        episode: null,
      },
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
      value: {
        track: { id: "track1", name: "Song", artist: "" },
        episode: null,
      },
    });
  });
});

describe("getCurrentlyPlaying — episode show-name extraction edge cases", () => {
  it("falls back to an empty show name when `show` is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: "ep1", name: "Episode Title" },
          currently_playing_type: "episode",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({
      ok: true,
      value: {
        track: null,
        episode: { id: "ep1", name: "Episode Title", show: "" },
      },
    });
  });

  it("falls back to an empty show name when `show.name` is not a string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          item: { id: "ep1", name: "Episode Title", show: { name: null } },
          currently_playing_type: "episode",
        }),
      ),
    );

    const result = await getCurrentlyPlaying("token");

    expect(result).toEqual({
      ok: true,
      value: {
        track: null,
        episode: { id: "ep1", name: "Episode Title", show: "" },
      },
    });
  });
});

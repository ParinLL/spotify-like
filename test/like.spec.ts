// Unit tests for the likeCurrentTrack orchestration (src/like.ts), covering
// the track/episode branch added alongside episode support:
//
//   - a playing track with an id -> added
//   - a playing track with id: null (local file) -> not_addable, unchanged
//   - a playing episode with an id -> episode_added, saved via
//     spotify:episode:<id>
//   - a playing episode with id: null (Spotify reported it without a full
//     item object) -> not_addable, same treatment as a local file
//   - nothing playing -> nothing_playing
//
// See design.md's episode-support addition and the base feature's
// "likeCurrentTrack — the orchestration" section.

import { env as workerEnv } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { likeCurrentTrack } from "../src/like";
import { invalidateAccessToken } from "../src/spotify/token";
import type { Env } from "../src/types";
import { createFakeSpotify } from "./helpers/fake-spotify";

function testEnv(): Env {
  return {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REFRESH_TOKEN: "refresh-token",
    SHORTCUT_SECRET: "irrelevant-for-this-test",
    TOKEN_KV: workerEnv.TOKEN_KV,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateAccessToken();
});

describe("likeCurrentTrack — track vs episode branch", () => {
  it("a playing track with an id is added, and PUT uses spotify:track:<id>", async () => {
    const fake = createFakeSpotify();
    fake.scriptCurrentlyPlaying({
      status: 200,
      body: {
        item: { id: "track123", name: "Song", artists: [{ name: "Artist" }] },
        currently_playing_type: "track",
        is_playing: true,
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const outcome = await likeCurrentTrack(testEnv());

    expect(outcome).toEqual({
      kind: "added",
      track: { id: "track123", name: "Song", artist: "Artist" },
      rotationFailed: undefined,
    });
    expect(fake.library.has("spotify:track:track123")).toBe(true);
  });

  it("a playing local file (track with id: null) is not_addable and issues no library write", async () => {
    const fake = createFakeSpotify();
    fake.scriptCurrentlyPlaying({
      status: 200,
      body: {
        item: { id: null, name: "Local File", artists: [{ name: "Unknown" }] },
        currently_playing_type: "track",
        is_playing: true,
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const outcome = await likeCurrentTrack(testEnv());

    expect(outcome).toEqual({ kind: "not_addable" });
    expect(fake.library.size).toBe(0);
  });

  it("a playing episode with an id is episode_added, and PUT uses spotify:episode:<id>", async () => {
    const fake = createFakeSpotify();
    fake.scriptCurrentlyPlaying({
      status: 200,
      body: {
        item: { id: "ep123", name: "Episode Title", show: { name: "The Show" } },
        currently_playing_type: "episode",
        is_playing: true,
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const outcome = await likeCurrentTrack(testEnv());

    expect(outcome).toEqual({
      kind: "episode_added",
      episode: { id: "ep123", name: "Episode Title", show: "The Show" },
      rotationFailed: undefined,
    });
    expect(fake.library.has("spotify:episode:ep123")).toBe(true);
    // Confirms the write went through the /me/library PUT, same endpoint
    // as a track save — no separate episode endpoint is used.
    const putRequests = fake.requestLog.filter((r) => r.method === "PUT");
    expect(putRequests).toHaveLength(1);
    expect(putRequests[0]?.url).toContain("/v1/me/library?uris=");
    expect(putRequests[0]?.url).toContain(encodeURIComponent("spotify:episode:ep123"));
  });

  // Regression scenario: the real production case that originally
  // motivated this fix — Spotify reporting a playing episode with
  // `item: null`. There is no episode id to add, so this must be
  // not_addable (same treatment as a local file), and must issue no
  // library write, even though a rotation was already attempted and the
  // token exchange succeeded.
  it("a playing episode reported with item: null (no id) is not_addable and issues no library write", async () => {
    const fake = createFakeSpotify();
    fake.route(
      (url, method) => method === "GET" && url.pathname === "/v1/me/player/currently-playing",
      () => ({
        status: 200,
        body: {
          is_playing: true,
          timestamp: 1789983711448,
          context: null,
          progress_ms: 3855220,
          item: null,
          currently_playing_type: "episode",
          actions: { disallows: { resuming: true } },
        },
      }),
    );
    vi.stubGlobal("fetch", fake.fetch);

    const outcome = await likeCurrentTrack(testEnv());

    expect(outcome).toEqual({ kind: "not_addable" });
    expect(fake.library.size).toBe(0);
    expect(fake.requestLog.some((r) => r.method === "PUT")).toBe(false);
  });

  it("nothing playing (204) is nothing_playing and issues no library write", async () => {
    const fake = createFakeSpotify();
    fake.scriptCurrentlyPlaying({ status: 204 });
    vi.stubGlobal("fetch", fake.fetch);

    const outcome = await likeCurrentTrack(testEnv());

    expect(outcome).toEqual({ kind: "nothing_playing" });
    expect(fake.library.size).toBe(0);
  });
});

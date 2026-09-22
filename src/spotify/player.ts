// Reads the currently playing item and normalizes it into a PlaybackState.
// The currently-playing endpoint has more shapes than its happy path
// suggests; see design.md, "spotify/player.ts — reading playback" for the
// full normalization table this function implements.

import { call, readJson } from "./http";
import {
  ok,
  type EpisodeInfo,
  type Failure,
  type PlaybackState,
  type Result,
  type TrackInfo,
} from "../types";

// `additional_types=track,episode` is required to get a populated `item`
// when a podcast episode is playing. Spotify's `currently-playing`
// endpoint defaults to track-only responses; without this parameter, an
// episode is reported with `item: null` regardless of what's actually
// playing (a long-standing, documented API behavior — see
// https://github.com/spotify/web-api/issues/1496). This was the real root
// cause of episodes always appearing not-addable in production: the
// endpoint was never asked for episode data in the first place.
const CURRENTLY_PLAYING_URL =
  "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode";

const NO_TRACK_TYPES = new Set(["ad", "unknown"]);

const NO_PLAYBACK: PlaybackState = { track: null, episode: null };

export async function getCurrentlyPlaying(token: string): Promise<Result<PlaybackState, Failure>> {
  const res = await call(CURRENTLY_PLAYING_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return res;

  // 204 No Content: call() yields ok(res) with no body to read.
  if (res.value.status === 204) return ok(NO_PLAYBACK);

  const body = await readJson(res.value);
  // 200 with an empty or malformed body normalizes the same as no content.
  if (body === undefined || typeof body !== "object" || body === null) {
    return ok(NO_PLAYBACK);
  }

  const payload = body as Record<string, unknown>;
  const type = payload.currently_playing_type;

  // An episode is reported through its own PlaybackState field, never
  // through `track`. This check MUST run before the `item === null`
  // early-return below: checking `item` first would misclassify a playing
  // episode as "nothing playing" rather than surfacing it as an episode.
  //
  // That ordering was originally written for the `item: null` episode
  // responses seen in production. Those turned out to be caused by this
  // module's own missing `additional_types` parameter (see the URL above),
  // not by the endpoint — with the parameter sent, a playing episode comes
  // back with a populated item. The ordering is kept as defence rather
  // than for that case: it costs nothing, and normalizeEpisode already
  // tolerates a null item by yielding `id: null`, so an unforeseen empty
  // item degrades to `not_addable` instead of the wrong "nothing playing".
  if (typeof type === "string" && type === "episode") {
    return ok({ track: null, episode: normalizeEpisode(payload.item) });
  }

  const item = payload.item;
  if (item === null || typeof item !== "object") return ok(NO_PLAYBACK);

  if (typeof type === "string" && NO_TRACK_TYPES.has(type)) return ok(NO_PLAYBACK);

  const track = normalizeTrack(item);
  return ok({ track, episode: null });
}

function normalizeTrack(item: unknown): TrackInfo {
  const itemObj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};

  // A local file has no addable track id.
  const rawId = itemObj.id;
  const id = typeof rawId === "string" ? rawId : null;

  const name = typeof itemObj.name === "string" ? itemObj.name : "";
  const artist = extractFirstArtist(itemObj.artists);

  return { id, name, artist };
}

function normalizeEpisode(item: unknown): EpisodeInfo {
  const itemObj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};

  const rawId = itemObj.id;
  const id = typeof rawId === "string" ? rawId : null;

  const name = typeof itemObj.name === "string" ? itemObj.name : "";
  const show = extractShowName(itemObj.show);

  return { id, name, show };
}

function extractFirstArtist(artists: unknown): string {
  if (!Array.isArray(artists) || artists.length === 0) return "";
  const first = artists[0];
  if (typeof first !== "object" || first === null) return "";
  const name = (first as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
}

function extractShowName(show: unknown): string {
  if (typeof show !== "object" || show === null) return "";
  const name = (show as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
}

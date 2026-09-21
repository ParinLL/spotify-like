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

const CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";

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
  // through `track`. In practice Spotify sometimes reports a playing
  // episode with `item: null` (no full item object), so this check MUST
  // run before the `item === null` early-return below — checking `item`
  // first would misclassify a playing episode as "nothing playing" instead
  // of surfacing it as an (possibly not-addable) episode.
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

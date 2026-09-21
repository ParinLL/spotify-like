// Reads the currently playing item and normalizes it into a PlaybackState.
// The currently-playing endpoint has more shapes than its happy path
// suggests; see design.md, "spotify/player.ts — reading playback" for the
// full normalization table this function implements.

import { call, readJson } from "./http";
import { ok, type Failure, type PlaybackState, type Result, type TrackInfo } from "../types";

const CURRENTLY_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing";

const NO_TRACK_TYPES = new Set(["ad", "unknown"]);

export async function getCurrentlyPlaying(token: string): Promise<Result<PlaybackState, Failure>> {
  const res = await call(CURRENTLY_PLAYING_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return res;

  // 204 No Content: call() yields ok(res) with no body to read.
  if (res.value.status === 204) return ok({ track: null });

  const body = await readJson(res.value);
  // 200 with an empty or malformed body normalizes the same as no content.
  if (body === undefined || typeof body !== "object" || body === null) {
    return ok({ track: null });
  }

  const payload = body as Record<string, unknown>;
  const item = payload.item;
  if (item === null || typeof item !== "object") return ok({ track: null });

  const type = payload.currently_playing_type;
  if (typeof type === "string" && NO_TRACK_TYPES.has(type)) return ok({ track: null });

  const track = normalizeTrack(item as Record<string, unknown>, type);
  return ok({ track });
}

function normalizeTrack(item: Record<string, unknown>, type: unknown): TrackInfo {
  // Episodes never carry an addable track id, regardless of what `id` holds.
  const rawId = type === "episode" ? null : item.id;
  const id = typeof rawId === "string" ? rawId : null;

  const name = typeof item.name === "string" ? item.name : "";
  const artist = extractFirstArtist(item.artists);

  return { id, name, artist };
}

function extractFirstArtist(artists: unknown): string {
  if (!Array.isArray(artists) || artists.length === 0) return "";
  const first = artists[0];
  if (typeof first !== "object" || first === null) return "";
  const name = (first as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
}

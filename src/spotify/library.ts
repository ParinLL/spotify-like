// Add-only writes against the saved-tracks library. Uses Spotify's current
// (non-deprecated) `/me/library` endpoints exclusively — `/me/tracks` and
// `/me/tracks/contains` are deprecated and never used here. See design.md,
// "spotify/library.ts — add-only writes".
//
// This module exports no DELETE path. The absence of a remove function is
// the enforcement mechanism for "add-only" (Requirement 2.3).

import { call, readJson } from "./http";
import type { Failure, Result } from "../types";

const LIBRARY_URL = "https://api.spotify.com/v1/me/library";
const LIBRARY_CONTAINS_URL = "https://api.spotify.com/v1/me/library/contains";

export function trackUriFromId(trackId: string): string {
  return `spotify:track:${trackId}`;
}

export function saveTrack(token: string, trackUri: string): Promise<Result<Response, Failure>> {
  return call(`${LIBRARY_URL}?uris=${encodeURIComponent(trackUri)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Off-critical-path probe: checks whether a track is already saved. Its
 * result cannot change whether an add is issued, so every failure mode —
 * network, non-2xx status, malformed body — is swallowed here and reported
 * as `false` rather than propagated as a Result/error.
 */
export async function isTrackSaved(token: string, trackUri: string): Promise<boolean> {
  try {
    const res = await call(`${LIBRARY_CONTAINS_URL}?uris=${encodeURIComponent(trackUri)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;

    const body = await readJson(res.value);
    if (!Array.isArray(body) || body.length === 0) return false;

    return body[0] === true;
  } catch {
    return false;
  }
}

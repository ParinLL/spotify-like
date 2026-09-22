// Add-only writes against the saved-tracks library. Uses Spotify's current
// `/me/library` endpoint exclusively. The entity-specific endpoints
// (`PUT /me/tracks`, `/me/episodes`, `/me/shows`, ...) were removed in
// Spotify's February 2026 API changes in favour of this one; `/me/library`
// is the replacement, not an alternative. See design.md,
// "spotify/library.ts — add-only writes".
//
// `/me/library` accepts Spotify URIs for several item types (tracks,
// episodes, shows, albums, ...), not just tracks — saveTrack() is generic
// over the URI, so the same PUT call saves either a track or an episode
// depending on which URI-building helper the caller uses.
//
// This module exports no DELETE path. The absence of a remove function is
// the enforcement mechanism for "add-only" (Requirement 2.3).

import { call } from "./http";
import type { Failure, Result } from "../types";

const LIBRARY_URL = "https://api.spotify.com/v1/me/library";

export function trackUriFromId(trackId: string): string {
  return `spotify:track:${trackId}`;
}

export function episodeUriFromId(episodeId: string): string {
  return `spotify:episode:${episodeId}`;
}

export function saveTrack(token: string, trackUri: string): Promise<Result<Response, Failure>> {
  return call(`${LIBRARY_URL}?uris=${encodeURIComponent(trackUri)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// There is deliberately no "is it already saved?" probe here. One existed
// (`isTrackSaved`, against `GET /me/library/contains`) but was never called
// on the request path — `PUT /me/library` is idempotent, so knowing the
// answer could not change whether the add is issued.
//
// It was removed along with the `user-library-read` scope, which is what
// that endpoint requires. Keeping the function without the scope would have
// been worse than not having it: it swallowed every failure into `false`,
// so a 403 for the missing scope would have been indistinguishable from a
// genuine "not saved" — a future caller would have read the wrong answer
// with nothing to indicate why. Re-adding the probe means re-adding the
// scope, which means re-authorizing.

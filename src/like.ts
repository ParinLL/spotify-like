// The orchestration: token exchange -> read currently-playing -> save.
// See design.md, "likeCurrentTrack — the orchestration". Every step returns
// a Result rather than throwing, so this function has one exit shape and
// classify() is the single place a Failure becomes a user-visible Outcome.
//
// Stale-token retry (task 9.2, design.md's "Stale-token retry" paragraph):
// if a data call (currently-playing or save) returns a 401 while using a
// cached token, invalidate the cache, re-exchange once, and retry that call
// once. A second 401 is reported as auth_failed directly, with no further
// retry. A 403 is not retried: it signals insufficient scope, not a stale
// token, so a fresh token would not help.

import { getAccessToken, invalidateAccessToken } from "./spotify/token";
import { getCurrentlyPlaying } from "./spotify/player";
import { saveTrack, trackUriFromId } from "./spotify/library";
import { classify } from "./outcome";
import { err, type Env, type Failure, type Outcome, type Result } from "./types";

/** True only for the failure the stale-token retry is meant to recover from. */
function isStaleToken401(failure: Failure): boolean {
  return failure.kind === "auth" && failure.status === 401;
}

/**
 * Takes the Result of a data call that has already failed once, and — if
 * that failure is a stale 401 — invalidates the cached token, re-exchanges
 * once, and retries `retryFn` exactly once with the fresh token.
 *
 * This function never recurses and never loops: it makes at most one
 * re-exchange and one retried call no matter what the retry returns, so a
 * second 401 (or any other failure) on the retry flows straight back out as
 * a plain Result for the caller to classify — a genuinely revoked
 * authorization cannot produce more than this single extra round trip.
 *
 * A non-stale failure (a 403, a 5xx, a network error, ...) is returned
 * unchanged: only a stale 401 warrants spending a re-exchange.
 */
async function withStaleTokenRetry<T>(
  env: Env,
  failed: Result<T, Failure> & { ok: false },
  retryFn: (freshToken: string) => Promise<Result<T, Failure>>,
): Promise<Result<T, Failure>> {
  if (!isStaleToken401(failed.error)) return failed;

  invalidateAccessToken();
  const freshToken = await getAccessToken(env);
  if (!freshToken.ok) return err(freshToken.error);

  // Only the token string is used here; a rotation failure surfacing on
  // this retry exchange is intentionally not threaded into the outcome —
  // see design.md's note on withStaleTokenRetry.
  return retryFn(freshToken.value.token);
}

export async function likeCurrentTrack(env: Env): Promise<Outcome> {
  const token = await getAccessToken(env);
  if (!token.ok) return classify(token.error, "token");

  const { token: accessToken, rotationFailed } = token.value;

  let playback = await getCurrentlyPlaying(accessToken);
  if (!playback.ok) {
    playback = await withStaleTokenRetry(env, playback, (freshToken) =>
      getCurrentlyPlaying(freshToken),
    );
    if (!playback.ok) return classify(playback.error, "data");
  }

  const track = playback.value.track;
  if (track === null) return { kind: "nothing_playing" };
  if (track.id === null) return { kind: "not_addable" };

  const trackUri = trackUriFromId(track.id);
  let saved = await saveTrack(accessToken, trackUri);
  if (!saved.ok) {
    saved = await withStaleTokenRetry(env, saved, (freshToken) => saveTrack(freshToken, trackUri));
    if (!saved.ok) return classify(saved.error, "data");
  }

  return { kind: "added", track, rotationFailed: rotationFailed || undefined };
}

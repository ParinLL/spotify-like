// fast-check arbitraries shared across the property tests (tasks 2.2, 5.2,
// 6.2, 7.2, 10.x). Centralized here so every property that needs a track
// name, a currently-playing payload, or a failure status code exercises the
// same edge cases: CJK text, emoji, surrounding whitespace, names containing
// " - ", multi-artist arrays, both `is_playing` values, extra/unknown
// fields, local files (`id: null`), episodes, ads, and the full 400-599
// status range with 429 guaranteed reachable.

import fc from "fast-check";

/**
 * Track or artist name generator. Mixes plain ASCII with the edge cases
 * called out in design.md's Property 3: CJK characters, emoji, leading/
 * trailing whitespace, and a literal " - " inside the name (which could be
 * confused with the "<name> - <artist>" message template's own separator).
 */
export const trackNameArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }),
  fc.stringMatching(/^[\u4e00-\u9fff\u3040-\u30ff]{1,20}$/), // CJK (Han + Hiragana/Katakana)
  fc.constantFrom("🎵", "🎶", "😀", "🔥", "🎧").chain((emoji) =>
    fc.string({ minLength: 0, maxLength: 15 }).map((s) => `${emoji}${s}${emoji}`),
  ),
  fc.string({ minLength: 1, maxLength: 20 }).map((s) => `  ${s}  `), // leading/trailing whitespace
  fc.string({ minLength: 1, maxLength: 15 }).chain((a) =>
    fc.string({ minLength: 1, maxLength: 15 }).map((b) => `${a} - ${b}`), // literal " - " inside the name
  ),
);

/** Alias — artists share the same edge-case shape as track names. */
export const artistNameArb: fc.Arbitrary<string> = trackNameArb;

/** A single Spotify artist object, `{ name }`, as returned in `item.artists[]`. */
export const spotifyArtistArb: fc.Arbitrary<{ name: string }> = artistNameArb.map((name) => ({
  name,
}));

/**
 * Generates 1-4 artists (multi-artist tracks are common — collaborations,
 * features), preserving that `artists[0]` is the one the Worker reads.
 */
export const spotifyArtistsArb: fc.Arbitrary<{ name: string }[]> = fc.array(spotifyArtistArb, {
  minLength: 1,
  maxLength: 4,
});

/** A Spotify track id: alphanumeric, matching real base62 ids closely enough for testing. */
export const trackIdArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Za-z0-9]{10,22}$/);

/** Arbitrary extra/unknown fields a real Spotify payload might carry, that the Worker must ignore. */
const extraFieldsArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 10 }).filter((k) => !RESERVED_KEYS.has(k)),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
  { maxKeys: 3 },
);

const RESERVED_KEYS = new Set([
  "id",
  "name",
  "artists",
  "type",
  "is_playing",
  "item",
  "currently_playing_type",
]);

/**
 * A `currently-playing` `item` for a normal track: has an id, a name, 1+
 * artists, `type: "track"`, plus arbitrary extra fields the Worker must
 * tolerate.
 */
export const trackItemArb: fc.Arbitrary<Record<string, unknown>> = fc
  .record({
    id: trackIdArb,
    name: trackNameArb,
    artists: spotifyArtistsArb,
    type: fc.constant("track"),
  })
  .chain((base) => extraFieldsArb.map((extra) => ({ ...extra, ...base })));

/** A local-file track: same shape as a track item, but `id: null` (not addable). */
export const localFileItemArb: fc.Arbitrary<Record<string, unknown>> = trackItemArb.map(
  (item) => ({ ...item, id: null }),
);

/** A podcast episode item — has an id, but the payload's `currently_playing_type` marks it as an episode. */
export const episodeItemArb: fc.Arbitrary<Record<string, unknown>> = fc
  .record({
    id: trackIdArb,
    name: trackNameArb,
    type: fc.constant("episode"),
  })
  .chain((base) => extraFieldsArb.map((extra) => ({ ...extra, ...base })));

/**
 * A full `GET /v1/me/player/currently-playing` 200 response body for a
 * *playing track* (the item is a normal track, not an episode/local file).
 * Varies `is_playing` (paused still counts, per design.md) and includes
 * extra/unknown top-level fields.
 */
export const playingTrackPayloadArb: fc.Arbitrary<Record<string, unknown>> = fc
  .record({
    is_playing: fc.boolean(),
    item: trackItemArb,
    currently_playing_type: fc.constant("track"),
    progress_ms: fc.nat(),
  })
  .chain((base) => extraFieldsArb.map((extra) => ({ ...extra, ...base })));

/**
 * A full currently-playing 200 body whose item is not addable: a local file
 * (`item.id: null`) or a podcast episode (`currently_playing_type:
 * "episode"`).
 */
export const notAddablePayloadArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.record({
    is_playing: fc.boolean(),
    item: localFileItemArb,
    currently_playing_type: fc.constant("track"),
  }),
  fc.record({
    is_playing: fc.boolean(),
    item: episodeItemArb,
    currently_playing_type: fc.constant("episode"),
  }),
);

/**
 * The "no track" family from design.md's normalization table: `item: null`,
 * or `currently_playing_type` of `ad`/`unknown` (with or without an item).
 * Does not include 204/empty-body — those are HTTP-level, not body shapes;
 * see `noTrackHttpResponseArb` below for the full family including those.
 */
export const noTrackBodyArb: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.record({ is_playing: fc.boolean(), item: fc.constant(null) }),
  fc.record({
    is_playing: fc.boolean(),
    item: fc.option(trackItemArb, { nil: null }),
    currently_playing_type: fc.constantFrom("ad", "unknown"),
  }),
);

/**
 * The complete "no track" family at the HTTP level: 204 with no body, 200
 * with an empty body, or 200 with one of the `noTrackBodyArb` shapes.
 * Shape: `{ status, body }` — `body: undefined` means "send no body".
 */
export const noTrackHttpResponseArb: fc.Arbitrary<{ status: number; body?: unknown }> = fc.oneof(
  fc.constant({ status: 204, body: undefined }),
  fc.constant({ status: 200, body: undefined }),
  noTrackBodyArb.map((body) => ({ status: 200, body })),
);

/**
 * HTTP status codes across the full failure range the Spotify adapters
 * must classify, 400-599. Weighted so 429 (the one status the design calls
 * out by name — "429 is not retried") and the 401/403 auth boundary are
 * reliably sampled rather than left to chance across the range.
 */
export const failureStatusArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 400, max: 599 }) },
  { weight: 1, arbitrary: fc.constant(429) },
  { weight: 1, arbitrary: fc.constantFrom(401, 403) },
);

/** A thrown-error scenario for a Spotify call site: DNS/TLS/reset/timeout, modeled as fetch throwing. */
export const thrownNetworkErrorArb: fc.Arbitrary<Error> = fc.constantFrom(
  new TypeError("fetch failed"),
  new DOMException("The operation was aborted.", "AbortError"),
  new Error("ECONNRESET"),
);

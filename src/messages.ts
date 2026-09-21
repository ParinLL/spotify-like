// Message catalog per the design's "Error Handling and Message Mapping"
// section. Every non-success Outcome kind maps to exactly one string per
// supported Language, and the catalogs are exported as enumerable
// collections so tests can assert that a given message is a member of one
// (Requirement 4.1 / Property 9).
//
// The two success cases ("added", "episode_added") have no fixed string —
// each is a template instantiated with the added item's fields — so they
// get formatters instead of catalog entries.
//
// Language is threaded explicitly through every formatter rather than read
// from a module-scope global. A Worker isolate is reused across requests,
// so a module-level "current language" would be shared mutable state on the
// request path; passing it as an argument keeps the whole catalog pure.

import type { Language, Outcome } from "./types";

/**
 * Outcome kinds that carry a fixed Chinese message. This excludes "added"
 * and "episode_added" (both templated, see the formatters below) and the
 * two routing outcomes "not_found" and "method_not_allowed", which are not
 * part of this table.
 */
type MessageOutcomeKind = Exclude<
  Outcome["kind"],
  "added" | "episode_added" | "not_found" | "method_not_allowed"
>;

export const MESSAGES: Record<Language, Record<MessageOutcomeKind, string>> = {
  en: {
    nothing_playing: "Nothing is playing",
    not_addable: "This item can't be added to your library",
    auth_failed: "Spotify authorization expired, please re-authorize",
    api_failed: "Couldn't complete that, please try again shortly",
    network_failed: "Can't reach Spotify, please check your connection",
    misconfigured: "Worker configuration is incomplete, please check the settings",
    unauthorized: "Unauthorized request",
  },
  zh_TW: {
    nothing_playing: "目前沒有播放中的歌曲",
    not_addable: "目前播放的內容無法加入喜愛",
    auth_failed: "Spotify 授權已失效，請重新取得授權",
    api_failed: "操作未完成，請稍後再試",
    network_failed: "無法連線到 Spotify，請檢查網路連線",
    misconfigured: "伺服器設定不完整，請檢查 Worker 設定",
    unauthorized: "未授權的請求",
  },
};

/** The default language, used when MESSAGE_LANGUAGE is absent or empty. */
export const DEFAULT_LANGUAGE: Language = "en";

/** Every supported language tag, derived from the catalog so the two cannot drift. */
export const LANGUAGES = Object.keys(MESSAGES) as readonly Language[];

/**
 * Narrows a raw MESSAGE_LANGUAGE value to a Language, or null if it names no
 * catalog we have. Deliberately strict — no case folding, no `zh-TW`/`zh_tw`
 * aliasing — so a near-miss is reported as the typo it is rather than
 * guessed at. config.ts turns the null into a `misconfigured` outcome.
 */
export function parseLanguage(raw: string): Language | null {
  // An own-property check, not `raw in MESSAGES`: `in` walks the prototype
  // chain, so "toString" / "constructor" / "__proto__" would all report as
  // supported languages and then render a function or an object into the
  // notification.
  //
  // `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`,
  // which needs lib es2022 — the same reason `Intl.Segmenter` above is
  // typed structurally instead of widening the project's global `lib`.
  return Object.prototype.hasOwnProperty.call(MESSAGES, raw) ? (raw as Language) : null;
}

/**
 * The language to render in: the configured one when recognized, otherwise
 * the default.
 *
 * This never fails, which is the point — it renders the response for every
 * outcome including the `misconfigured` one that an unrecognized
 * MESSAGE_LANGUAGE itself produces. Reporting a bad language value is
 * config.ts's job; this function's job is to always have *some* language to
 * report it in.
 */
export function resolveLanguage(env: { MESSAGE_LANGUAGE?: string }): Language {
  const raw = env.MESSAGE_LANGUAGE;
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_LANGUAGE;
  return parseLanguage(raw) ?? DEFAULT_LANGUAGE;
}

/** One language's catalog as an enumerable collection, for membership assertions. */
export function messageCatalog(language: Language): readonly string[] {
  return Object.values(MESSAGES[language]);
}

/** Every fixed message across every language, for language-agnostic membership assertions. */
export const MESSAGE_CATALOG: readonly string[] = LANGUAGES.flatMap((language) =>
  Object.values(MESSAGES[language]),
);

/**
 * Fixed suffix appended to the success message when a Spotify-issued
 * replacement refresh token could not be persisted to Token_Store. See
 * design.md's "src/messages.ts — addition" section (Requirement 3.3).
 */
const ROTATION_FAILED_SUFFIX: Record<Language, string> = {
  en: " (but the token refresh failed, please check)",
  zh_TW: "（但 token 更新失敗，請留意）",
};

/** The `已加入喜愛：` / `Liked: ` lead-in for a success message. */
const ADDED_PREFIX: Record<Language, string> = {
  en: "Liked: ",
  zh_TW: "已加入喜愛：",
};

/**
 * Display budget for the *attribution* field of the success message, in
 * notification columns — the artist for a track, the show name for a
 * podcast episode.
 *
 * Only the attribution is capped. The title (track name / episode title) is
 * always rendered in full: it is the part the reader is identifying, so
 * losing its tail to iOS's own banner truncation is preferable to eliding
 * it ourselves. The attribution is secondary, and capping it keeps a long
 * show name from consuming the banner before the title even starts.
 *
 * The budget is measured in columns rather than characters because CJK text
 * is full-width: 28 columns is ~14 Han characters or ~28 Latin characters,
 * so both scripts get the same visual length. A fixed character count would
 * leave Latin text with half the useful information.
 *
 * 28 is sized against the notification banner, which fits roughly 38-40
 * columns per line over two lines: the prefix (`已加入喜愛：` is 12 columns,
 * `Liked: ` is 7), a 28-column attribution and the ` - ` separator (3)
 * leave most of the second line for the title. The budget is shared across
 * languages — that is the whole reason it is measured in display columns
 * rather than characters.
 *
 * Only the human-facing `message` is truncated; the structured `track` /
 * `episode` fields in the response body keep their full values.
 */
export const MAX_ATTRIBUTION_COLUMNS = 28;

/** U+2026, one column, rather than three separate periods. */
const ELLIPSIS = "…";

/**
 * Splits text into grapheme clusters, so a multi-code-unit character is
 * never cut in half. `String.prototype.length` counts UTF-16 code units,
 * which would slice an emoji into broken halves — and track/show names do
 * contain emoji in practice (the test generators cover this deliberately).
 *
 * Falls back to code-point iteration where `Intl.Segmenter` is unavailable;
 * that still keeps surrogate pairs intact, only combining sequences (e.g. a
 * ZWJ emoji family) could split.
 */
function graphemes(text: string): string[] {
  // Typed structurally rather than via lib.es2022.intl: this is the only
  // Segmenter use in the project, and widening the global `lib` for one call
  // would pull in unrelated newer declarations.
  const intl = Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor };

  if (intl.Segmenter !== undefined) {
    const segmenter = new intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (entry) => entry.segment);
  }
  return Array.from(text);
}

interface GraphemeSegmenterConstructor {
  new (
    locales?: string | string[] | undefined,
    options?: { granularity?: "grapheme" | "word" | "sentence" },
  ): { segment(input: string): Iterable<{ segment: string }> };
}

/**
 * Whether a grapheme renders double-width (East Asian Wide/Fullwidth, plus
 * the common emoji blocks). Ranges follow Unicode's East Asian Width
 * property closely enough for laying out a notification banner; this is a
 * display heuristic, not a conformance implementation.
 */
function isFullWidth(grapheme: string): boolean {
  const cp = grapheme.codePointAt(0);
  if (cp === undefined) return false;

  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo initial consonants
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals through Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Misc symbols & pictographs, emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // Transport & map symbols
    (cp >= 0x1f900 && cp <= 0x1f9ff) // Supplemental symbols & pictographs
  );
}

/** Display width of `text` in notification columns (full-width counts 2). */
export function displayColumns(text: string): number {
  let columns = 0;
  for (const grapheme of graphemes(text)) {
    columns += isFullWidth(grapheme) ? 2 : 1;
  }
  return columns;
}

/**
 * Truncates `text` to at most `maxColumns` display columns, appending an
 * ellipsis when anything was dropped. Text that already fits is returned
 * unchanged, with no ellipsis. Trailing whitespace on a truncated value is
 * trimmed so the ellipsis reads as part of the word rather than floating.
 *
 * The ellipsis is not counted against `maxColumns`, so a truncated field
 * occupies at most `maxColumns + 1` columns.
 */
export function truncateToColumns(text: string, maxColumns = MAX_ATTRIBUTION_COLUMNS): string {
  if (displayColumns(text) <= maxColumns) return text;

  const kept: string[] = [];
  let columns = 0;

  for (const grapheme of graphemes(text)) {
    const width = isFullWidth(grapheme) ? 2 : 1;
    if (columns + width > maxColumns) break;
    columns += width;
    kept.push(grapheme);
  }

  return `${kept.join("").trimEnd()}${ELLIPSIS}`;
}

/**
 * Formats the success message for an added track, in `language`:
 * `已加入喜愛：<歌名> - <歌手>` / `Liked: <name> - <artist>`
 *
 * The track name is rendered in full; only the artist is capped at
 * MAX_ATTRIBUTION_COLUMNS display columns.
 *
 * When `options.rotationFailed` is true, appends a fixed warning suffix so
 * the caller knows the like succeeded but the refresh-token rotation did
 * not persist.
 */
export function formatAddedMessage(
  track: { name: string; artist: string },
  language: Language,
  options?: { rotationFailed?: boolean },
): string {
  const artist = truncateToColumns(track.artist);
  const base = `${ADDED_PREFIX[language]}${track.name} - ${artist}`;
  return options?.rotationFailed ? `${base}${ROTATION_FAILED_SUFFIX[language]}` : base;
}

/**
 * Formats the success message for an added podcast episode, in `language`:
 * `已加入喜愛：<節目名稱> - <單集標題>` / `Liked: <show> - <title>`
 *
 * The episode title is rendered in full; only the show name is capped at
 * MAX_ATTRIBUTION_COLUMNS display columns. Show names in particular run
 * long enough that an uncapped one would push the episode title out of the
 * banner before it started.
 *
 * Same "<A> - <B>" template as formatAddedMessage, but A/B are the show
 * name and the episode title rather than a track's name and artist —
 * episodes and tracks are deliberately kept as separate outcomes
 * (`episode_added` vs `added`), so this is a distinct formatter rather than
 * a generic one shared between the two.
 */
export function formatEpisodeAddedMessage(
  episode: { name: string; show: string },
  language: Language,
  options?: { rotationFailed?: boolean },
): string {
  const show = truncateToColumns(episode.show);
  const base = `${ADDED_PREFIX[language]}${show} - ${episode.name}`;
  return options?.rotationFailed ? `${base}${ROTATION_FAILED_SUFFIX[language]}` : base;
}

// Message catalog per the design's "Error Handling and Message Mapping"
// section. Every non-success Outcome kind maps to exactly one Traditional
// Chinese string here, and the catalog is exported as an enumerable
// collection so tests can assert that a given message is a member of it
// (Requirement 4.1 / Property 9).
//
// The two success cases ("added", "episode_added") have no fixed string —
// each is a template instantiated with the added item's fields — so they
// get formatters instead of catalog entries.

import type { Outcome } from "./types";

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

export const MESSAGES: Record<MessageOutcomeKind, string> = {
  nothing_playing: "目前沒有播放中的歌曲",
  not_addable: "目前播放的內容無法加入喜愛",
  auth_failed: "Spotify 授權已失效，請重新取得授權",
  api_failed: "操作未完成，請稍後再試",
  network_failed: "無法連線到 Spotify，請檢查網路連線",
  misconfigured: "伺服器設定不完整，請檢查 Worker 設定",
  unauthorized: "未授權的請求",
};

/** The catalog as an enumerable collection, for membership assertions. */
export const MESSAGE_CATALOG: readonly string[] = Object.values(MESSAGES);

/**
 * Fixed suffix appended to the success message when a Spotify-issued
 * replacement refresh token could not be persisted to Token_Store. See
 * design.md's "src/messages.ts — addition" section (Requirement 3.3).
 */
const ROTATION_FAILED_SUFFIX = "（但 token 更新失敗，請留意）";

/**
 * Per-field display budget for the success message, in notification
 * columns. iOS truncates a long banner from the tail, which would drop the
 * second field (the artist, or the episode title) entirely — so each field
 * is capped here instead, keeping both visible.
 *
 * The budget is measured in columns rather than characters because CJK text
 * is full-width: 28 columns is ~14 Han characters or ~28 Latin characters,
 * so both scripts get the same visual length. A fixed character count would
 * leave Latin text with half the useful information.
 *
 * 28 is sized against the notification banner itself, which fits roughly
 * 38-40 columns per line over two lines. Two fields at 28 plus the
 * `已加入喜愛：` prefix and the ` - ` separator comes to at most ~73
 * columns, so a fully truncated message still lands inside those two lines
 * while leaving most real track names (`Bohemian Rhapsody` is 17) uncut.
 *
 * Only the human-facing `message` is truncated; the structured `track` /
 * `episode` fields in the response body keep their full values.
 */
export const MAX_FIELD_COLUMNS = 28;

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
export function truncateToColumns(text: string, maxColumns = MAX_FIELD_COLUMNS): string {
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
 * Formats the success message for an added track:
 * `已加入喜愛：<歌名> - <歌手>`
 *
 * Both fields are truncated to MAX_FIELD_COLUMNS display columns so a long
 * name cannot push the artist out of the notification banner.
 *
 * When `options.rotationFailed` is true, appends a fixed warning suffix so
 * the caller knows the like succeeded but the refresh-token rotation did
 * not persist. The existing single-argument call shape is unaffected.
 */
export function formatAddedMessage(
  track: { name: string; artist: string },
  options?: { rotationFailed?: boolean },
): string {
  const name = truncateToColumns(track.name);
  const artist = truncateToColumns(track.artist);
  const base = `已加入喜愛：${name} - ${artist}`;
  return options?.rotationFailed ? `${base}${ROTATION_FAILED_SUFFIX}` : base;
}

/**
 * Formats the success message for an added podcast episode:
 * `已加入喜愛：<節目名稱> - <單集標題>`
 *
 * Both fields are truncated to MAX_FIELD_COLUMNS display columns, as for a
 * track — podcast show names in particular run long enough that iOS would
 * otherwise drop the episode title entirely.
 *
 * Same "<A> - <B>" template as formatAddedMessage, but A/B are the show
 * name and the episode title rather than a track's name and artist —
 * episodes and tracks are deliberately kept as separate outcomes
 * (`episode_added` vs `added`), so this is a distinct formatter rather than
 * a generic one shared between the two.
 */
export function formatEpisodeAddedMessage(
  episode: { name: string; show: string },
  options?: { rotationFailed?: boolean },
): string {
  const show = truncateToColumns(episode.show);
  const name = truncateToColumns(episode.name);
  const base = `已加入喜愛：${show} - ${name}`;
  return options?.rotationFailed ? `${base}${ROTATION_FAILED_SUFFIX}` : base;
}

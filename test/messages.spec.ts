import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_ATTRIBUTION_COLUMNS,
  displayColumns,
  formatAddedMessage,
  formatEpisodeAddedMessage,
  truncateToColumns,
} from "../src/messages";
import { artistNameArb, trackNameArb } from "./helpers/generators";

// Property test for task 2.2, amended when attribution truncation was added.
//
// Property 3 originally read: "the message is the template instantiated with
// the track's name and artist". That no longer holds verbatim — the
// attribution field (the artist for a track, the show name for an episode) is
// capped at MAX_ATTRIBUTION_COLUMNS display columns, so a long attribution
// cannot consume the banner before the title starts. The title itself is
// never truncated: it is what the reader is identifying, so if anything has
// to be lost to iOS's own tail truncation it should be the attribution.
//
// Requirements: 1.3, 2.2

const ELLIPSIS = "…";

// Fixtures below are derived from MAX_ATTRIBUTION_COLUMNS rather than
// hard-coded, so widening the budget does not silently turn an "exactly at
// the budget" case into an "under the budget" one.
const LATIN = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CJK = "一二三四五六七八九十壹貳參肆伍陸柒捌玖拾甲乙丙丁戊己庚辛壬癸";
/** Full-width graphemes that fit in the budget; an odd budget wastes one column. */
const FULL_WIDTH_FIT = Math.floor(MAX_ATTRIBUTION_COLUMNS / 2);

describe("formatAddedMessage", () => {
  it("Feature: spotify-like-action-button, Property 3: The success message is the template instantiated with the track's full name and the artist truncated to the attribution budget", () => {
    fc.assert(
      fc.property(trackNameArb, artistNameArb, (name, artist) => {
        const message = formatAddedMessage({ name, artist });

        expect(message).toBe(`已加入喜愛：${name} - ${truncateToColumns(artist)}`);

        // The message survives JSON serialization unchanged — it travels to
        // the Shortcut as a JSON string, and CJK/emoji/whitespace must not be
        // mangled in transit.
        const roundTripped = JSON.parse(JSON.stringify({ message })).message;
        expect(roundTripped).toBe(message);
      }),
    );
  });

  it("leaves both fields untouched when the artist fits the budget", () => {
    const message = formatAddedMessage({ name: "Queen", artist: "Bohemian" });
    expect(message).toBe("已加入喜愛：Queen - Bohemian");
    expect(message).not.toContain(ELLIPSIS);
  });

  it("never truncates the track name, however far over the budget it runs", () => {
    const name = LATIN.slice(0, MAX_ATTRIBUTION_COLUMNS + 20);
    const message = formatAddedMessage({ name, artist: "Queen" });
    expect(message).toBe(`已加入喜愛：${name} - Queen`);
    expect(message).not.toContain(ELLIPSIS);
  });

  it("truncates a long artist while keeping the track name in full", () => {
    const message = formatAddedMessage({
      name: "Stairway to Heaven",
      artist: "Led Zeppelin & The Very Long Orchestra",
    });
    expect(message).toBe("已加入喜愛：Stairway to Heaven - Led Zeppelin & The Very Long…");
    expect(message).toContain("Stairway to Heaven");
  });
});

// Same "<A> - <B>" template as formatAddedMessage, but for a podcast
// episode: A is the show name, B is the episode title. Note that the
// attribution (the show) leads here while for a track it trails — the
// truncated field is the attribution in both cases, not a fixed position.
// Kept as a separate property since episodes and tracks are distinct
// outcomes (episode_added vs added).
describe("formatEpisodeAddedMessage", () => {
  it("formats as 已加入喜愛：<show> - <name> with only the show truncated, surviving a JSON round-trip", () => {
    fc.assert(
      fc.property(trackNameArb, artistNameArb, (show, name) => {
        const message = formatEpisodeAddedMessage({ name, show });

        expect(message).toBe(`已加入喜愛：${truncateToColumns(show)} - ${name}`);

        const roundTripped = JSON.parse(JSON.stringify({ message })).message;
        expect(roundTripped).toBe(message);
      }),
    );
  });

  it("keeps the episode title in full when the show name is long", () => {
    // The real-world case this truncation exists for: a show name long
    // enough that iOS would otherwise cut the episode title off entirely.
    // The show is elided; the title survives intact.
    const message = formatEpisodeAddedMessage({
      show: "珞亦不絕 by 法律白話文 Plain Law Media",
      name: "154｜遲到、擺爛、不夠完美 ft. yoyo",
    });

    expect(message).toBe(
      "已加入喜愛：珞亦不絕 by 法律白話文 Plain… - 154｜遲到、擺爛、不夠完美 ft. yoyo",
    );
    // Both fields present, neither swallowed by the other.
    expect(message).toContain("珞亦不絕");
    expect(message).toContain("154");
  });

  it("appends the rotation-failed warning suffix when requested", () => {
    const message = formatEpisodeAddedMessage(
      { name: "Episode Title", show: "The Show" },
      { rotationFailed: true },
    );
    expect(message).toBe("已加入喜愛：The Show - Episode Title（但 token 更新失敗，請留意）");
  });

  it("omits the warning suffix by default (single-argument call)", () => {
    const message = formatEpisodeAddedMessage({ name: "Episode Title", show: "The Show" });
    expect(message).toBe("已加入喜愛：The Show - Episode Title");
  });
});

describe("displayColumns", () => {
  it("counts Latin characters as one column each", () => {
    expect(displayColumns("Queen")).toBe(5);
  });

  it("counts CJK characters as two columns each", () => {
    expect(displayColumns("色盲")).toBe(4);
  });

  it("counts emoji as two columns", () => {
    expect(displayColumns("🎵")).toBe(2);
  });

  it("sums mixed-script text correctly", () => {
    // 2 CJK (4) + 1 space (1) + 2 Latin (2) = 7
    expect(displayColumns("色盲 by")).toBe(7);
  });
});

describe("truncateToColumns", () => {
  it("returns text that already fits unchanged, with no ellipsis", () => {
    expect(truncateToColumns("Queen")).toBe("Queen");
  });

  it("returns text exactly at the budget unchanged", () => {
    const exact = LATIN.slice(0, MAX_ATTRIBUTION_COLUMNS);
    expect(displayColumns(exact)).toBe(MAX_ATTRIBUTION_COLUMNS);
    expect(truncateToColumns(exact)).toBe(exact);
  });

  it("truncates one column over the budget", () => {
    const kept = LATIN.slice(0, MAX_ATTRIBUTION_COLUMNS);
    const over = LATIN.slice(0, MAX_ATTRIBUTION_COLUMNS + 1);
    expect(displayColumns(over)).toBe(MAX_ATTRIBUTION_COLUMNS + 1);
    expect(truncateToColumns(over)).toBe(`${kept}${ELLIPSIS}`);
  });

  it("gives CJK text roughly half the character count of Latin, for equal visual width", () => {
    const source = CJK.slice(0, FULL_WIDTH_FIT + 2); // 4 columns over budget
    const cjk = truncateToColumns(source);
    expect(cjk).toBe(`${CJK.slice(0, FULL_WIDTH_FIT)}${ELLIPSIS}`);
    expect(displayColumns(cjk)).toBeLessThanOrEqual(MAX_ATTRIBUTION_COLUMNS + 1);
  });

  it("never splits an emoji into broken halves", () => {
    // Emoji are full-width, so the budget allows FULL_WIDTH_FIT of them;
    // feed it two more than that.
    const truncated = truncateToColumns("🎵".repeat(FULL_WIDTH_FIT + 2));
    expect(truncated).toBe(`${"🎵".repeat(FULL_WIDTH_FIT)}${ELLIPSIS}`);
    // A naive UTF-16 slice would leave a lone surrogate (U+FFFD when
    // rendered); every code point here must still be the full emoji.
    expect(truncated).not.toContain("\uFFFD");
    for (const char of truncated.replace(ELLIPSIS, "")) {
      expect(char.codePointAt(0)).not.toBeLessThan(0x1f000);
    }
  });

  it("trims trailing whitespace before the ellipsis", () => {
    // Put a space in the final column the budget allows, so the kept slice
    // ends on whitespace.
    const head = LATIN.slice(0, MAX_ATTRIBUTION_COLUMNS - 1);
    const truncated = truncateToColumns(`${head} tail`);
    expect(truncated).toBe(`${head}${ELLIPSIS}`);
  });

  it("respects an explicit column budget", () => {
    expect(truncateToColumns("abcdefgh", 4)).toBe(`abcd${ELLIPSIS}`);
  });

  it("keeps a truncated field within budget + 1 column for any generated name", () => {
    fc.assert(
      fc.property(trackNameArb, (name) => {
        const truncated = truncateToColumns(name);
        expect(displayColumns(truncated)).toBeLessThanOrEqual(MAX_ATTRIBUTION_COLUMNS + 1);
      }),
    );
  });
});

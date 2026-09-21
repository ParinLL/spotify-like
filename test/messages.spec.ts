import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  displayColumns,
  formatAddedMessage,
  formatEpisodeAddedMessage,
  truncateToColumns,
} from "../src/messages";
import { artistNameArb, trackNameArb } from "./helpers/generators";

// Property test for task 2.2, amended when per-field truncation was added.
//
// Property 3 originally read: "the message is the template instantiated with
// the track's name and artist". That no longer holds verbatim — each field is
// now capped at MAX_FIELD_COLUMNS display columns, because iOS truncates a
// long banner from the tail and would drop the second field entirely. The
// property is therefore restated in terms of the truncated fields: the
// message is the template instantiated with each field truncated, and a field
// that already fits is passed through untouched.
//
// Requirements: 1.3, 2.2

const MAX_FIELD_COLUMNS = 16;
const ELLIPSIS = "…";

describe("formatAddedMessage", () => {
  it("Feature: spotify-like-action-button, Property 3: The success message is the template instantiated with the track's name and artist, each truncated to the field budget", () => {
    fc.assert(
      fc.property(trackNameArb, artistNameArb, (name, artist) => {
        const message = formatAddedMessage({ name, artist });

        expect(message).toBe(
          `已加入喜愛：${truncateToColumns(name)} - ${truncateToColumns(artist)}`,
        );

        // The message survives JSON serialization unchanged — it travels to
        // the Shortcut as a JSON string, and CJK/emoji/whitespace must not be
        // mangled in transit.
        const roundTripped = JSON.parse(JSON.stringify({ message })).message;
        expect(roundTripped).toBe(message);
      }),
    );
  });

  it("leaves both fields untouched when they already fit the budget", () => {
    const message = formatAddedMessage({ name: "Queen", artist: "Bohemian" });
    expect(message).toBe("已加入喜愛：Queen - Bohemian");
    expect(message).not.toContain(ELLIPSIS);
  });

  it("truncates a long track name without dropping the artist", () => {
    const message = formatAddedMessage({
      name: "Bohemian Rhapsody",
      artist: "Queen",
    });
    expect(message).toBe("已加入喜愛：Bohemian Rhapsod… - Queen");
  });
});

// Same "<A> - <B>" template as formatAddedMessage, but for a podcast
// episode: A is the show name, B is the episode title. Kept as a separate
// property since episodes and tracks are distinct outcomes
// (episode_added vs added).
describe("formatEpisodeAddedMessage", () => {
  it("formats as 已加入喜愛：<show> - <name> with both fields truncated, surviving a JSON round-trip", () => {
    fc.assert(
      fc.property(trackNameArb, artistNameArb, (show, name) => {
        const message = formatEpisodeAddedMessage({ name, show });

        expect(message).toBe(
          `已加入喜愛：${truncateToColumns(show)} - ${truncateToColumns(name)}`,
        );

        const roundTripped = JSON.parse(JSON.stringify({ message })).message;
        expect(roundTripped).toBe(message);
      }),
    );
  });

  it("keeps the episode title visible when the show name is long", () => {
    // The real-world case this truncation exists for: a show name long
    // enough that iOS would otherwise cut the episode title off entirely.
    const message = formatEpisodeAddedMessage({
      show: "珞亦不絕 by 法律白話文 Plain Law Media",
      name: "154｜遲到、擺爛、不夠完美 ft. yoyo",
    });

    expect(message).toBe("已加入喜愛：珞亦不絕 by 法律… - 154｜遲到、擺爛…");
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
    const exact = "0123456789abcdef"; // 16 columns
    expect(displayColumns(exact)).toBe(MAX_FIELD_COLUMNS);
    expect(truncateToColumns(exact)).toBe(exact);
  });

  it("truncates one column over the budget", () => {
    const over = "0123456789abcdefg"; // 17 columns
    expect(truncateToColumns(over)).toBe(`0123456789abcdef${ELLIPSIS}`);
  });

  it("gives CJK text roughly half the character count of Latin, for equal visual width", () => {
    const cjk = truncateToColumns("一二三四五六七八九十");
    // 16 columns / 2 per character = 8 characters kept.
    expect(cjk).toBe(`一二三四五六七八${ELLIPSIS}`);
    expect(displayColumns(cjk)).toBeLessThanOrEqual(MAX_FIELD_COLUMNS + 1);
  });

  it("never splits an emoji into broken halves", () => {
    // 10 emoji = 20 columns; the budget allows 8 of them (16 columns).
    const truncated = truncateToColumns("🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵");
    expect(truncated).toBe(`🎵🎵🎵🎵🎵🎵🎵🎵${ELLIPSIS}`);
    // A naive UTF-16 slice would leave a lone surrogate (U+FFFD when
    // rendered); every code point here must still be the full emoji.
    expect(truncated).not.toContain("\uFFFD");
    for (const char of truncated.replace(ELLIPSIS, "")) {
      expect(char.codePointAt(0)).not.toBeLessThan(0x1f000);
    }
  });

  it("trims trailing whitespace before the ellipsis", () => {
    const truncated = truncateToColumns("0123456789abcde fghij");
    expect(truncated).toBe(`0123456789abcde${ELLIPSIS}`);
  });

  it("respects an explicit column budget", () => {
    expect(truncateToColumns("abcdefgh", 4)).toBe(`abcd${ELLIPSIS}`);
  });

  it("keeps a truncated field within budget + 1 column for any generated name", () => {
    fc.assert(
      fc.property(trackNameArb, (name) => {
        const truncated = truncateToColumns(name);
        expect(displayColumns(truncated)).toBeLessThanOrEqual(MAX_FIELD_COLUMNS + 1);
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatAddedMessage, formatEpisodeAddedMessage } from "../src/messages";
import { artistNameArb, trackNameArb } from "./helpers/generators";

// Property test for task 2.2. Per design.md's "Property 3", the success
// message is the `已加入喜愛：<name> - <artist>` template instantiated with
// the track's name and artist, and that string must survive JSON
// serialization unchanged — which matters because the Worker's response is
// JSON — for all string content including CJK characters, emoji,
// surrounding whitespace, and names that themselves contain " - ".
//
// Requirements: 1.3, 2.2

describe("formatAddedMessage", () => {
  it(
    "Feature: spotify-like-action-button, Property 3: The success message is the template instantiated with the track's name and artist",
    () => {
      fc.assert(
        fc.property(trackNameArb, artistNameArb, (name, artist) => {
          const message = formatAddedMessage({ name, artist });

          expect(message).toBe(`已加入喜愛：${name} - ${artist}`);

          const roundTripped = JSON.parse(JSON.stringify({ message })).message;
          expect(roundTripped).toBe(message);
        }),
      );
    },
  );
});

// Same "<A> - <B>" template as formatAddedMessage, but for a podcast
// episode: A is the show name, B is the episode title. Kept as a separate
// property since episodes and tracks are distinct outcomes
// (episode_added vs added).
describe("formatEpisodeAddedMessage", () => {
  it("formats as 已加入喜愛：<show> - <name>, surviving a JSON round-trip", () => {
    fc.assert(
      fc.property(trackNameArb, artistNameArb, (show, name) => {
        const message = formatEpisodeAddedMessage({ name, show });
        expect(message).toBe(`已加入喜愛：${show} - ${name}`);

        const roundTripped = JSON.parse(JSON.stringify({ message })).message;
        expect(roundTripped).toBe(message);
      }),
    );
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


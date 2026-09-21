import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createFakeSpotify } from "./fake-spotify";
import {
  failureStatusArb,
  noTrackHttpResponseArb,
  playingTrackPayloadArb,
  trackNameArb,
} from "./generators";

// Throwaway smoke coverage for task 1.4's harness itself (not a spec
// property). Exercises the fake's recording/scripting/library-model
// behavior and sanity-checks the generators produce well-formed values.
// Safe to delete once later tasks (2.2, 5.2, 6.2, 7.2, 10.x) exercise this
// harness through real production code.
describe("fake spotify harness smoke test", () => {
  it("records method, url, headers, and body for every call", async () => {
    const fake = createFakeSpotify();
    fake.scriptToken({ status: 200, body: { access_token: "tok", expires_in: 3600 } });

    await fake.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: "Basic abc123", "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=r1",
    });

    expect(fake.requestLog).toHaveLength(1);
    const [recorded] = fake.requestLog;
    expect(recorded!.method).toBe("POST");
    expect(recorded!.url).toBe("https://accounts.spotify.com/api/token");
    expect(recorded!.headers.authorization).toBe("Basic abc123");
    expect(recorded!.body).toBe("grant_type=refresh_token&refresh_token=r1");
  });

  it("serves scripted currently-playing responses", async () => {
    const fake = createFakeSpotify();
    fake.scriptCurrentlyPlaying({
      status: 200,
      body: { is_playing: true, item: { id: "abc", name: "Song", artists: [{ name: "Artist" }] } },
    });

    const res = await fake.fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      method: "GET",
      headers: { Authorization: "Bearer tok" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { id: string } };
    expect(body.item.id).toBe("abc");
  });

  it("models the library: PUT inserts, GET contains reads back", async () => {
    const fake = createFakeSpotify();

    const putRes = await fake.fetch(
      "https://api.spotify.com/v1/me/library?uris=" + encodeURIComponent("spotify:track:abc123"),
      { method: "PUT", headers: { Authorization: "Bearer tok" } },
    );
    expect(putRes.status).toBe(200);
    expect(fake.library.has("spotify:track:abc123")).toBe(true);

    const containsRes = await fake.fetch(
      "https://api.spotify.com/v1/me/library/contains?uris=" +
        encodeURIComponent("spotify:track:abc123,spotify:track:other"),
      { method: "GET", headers: { Authorization: "Bearer tok" } },
    );
    expect(await containsRes.json()).toEqual([true, false]);
  });

  it("library PUT is idempotent under repeated invocation (model backing Property 6/7)", async () => {
    const fake = createFakeSpotify();
    const uri = "spotify:track:repeat1";

    for (let i = 0; i < 5; i++) {
      await fake.fetch(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(uri)}`, {
        method: "PUT",
      });
    }

    expect(fake.library.size).toBe(1);
    expect(fake.library.has(uri)).toBe(true);
    // No DELETE was ever issued — Property 7's monotonicity check.
    expect(fake.requestLog.every((r) => r.method !== "DELETE")).toBe(true);
  });

  it("throws a clear error for unscripted routes instead of silently passing", async () => {
    const fake = createFakeSpotify();
    await expect(fake.fetch("https://example.com/unmatched", { method: "GET" })).rejects.toThrow(
      /no scripted route/,
    );
  });

  it("generators produce well-formed track names covering the edge cases", () => {
    fc.assert(
      fc.property(trackNameArb, (name) => {
        expect(typeof name).toBe("string");
      }),
    );
  });

  it("generators produce playing-track payloads with a non-null item id", () => {
    fc.assert(
      fc.property(playingTrackPayloadArb, (payload) => {
        const item = payload["item"] as { id: string };
        expect(typeof item.id).toBe("string");
      }),
    );
  });

  it("failureStatusArb stays within 400-599 and can produce 429", () => {
    let saw429 = false;
    fc.assert(
      fc.property(failureStatusArb, (status) => {
        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThanOrEqual(599);
        if (status === 429) saw429 = true;
      }),
      { numRuns: 200 },
    );
    expect(saw429).toBe(true);
  });

  it("noTrackHttpResponseArb only produces the documented no-track shapes", () => {
    fc.assert(
      fc.property(noTrackHttpResponseArb, ({ status, body }) => {
        expect([200, 204]).toContain(status);
        if (status === 204) expect(body).toBeUndefined();
      }),
    );
  });
});

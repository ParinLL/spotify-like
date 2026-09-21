import { createExecutionContext, env as workerEnv, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { createFakeSpotify } from "./helpers/fake-spotify";

// `cloudflare:test` expects the CF-flavored `IncomingRequest`, which differs
// slightly from the global `Request` type. See Cloudflare's Vitest
// integration docs for this exact workaround.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const SHORTCUT_SECRET = "test-shortcut-secret";

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REFRESH_TOKEN: "refresh-token",
    SHORTCUT_SECRET,
    TOKEN_KV: workerEnv.TOKEN_KV,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// End-to-end sanity checks that the real `fetch` handler — routing, the
// gate, and orchestration — is wired correctly. This is not the full
// property-test suite (task 10.x); it just proves the wiring works.
//
// Requirements: 4.1, 5.1, 5.2
describe("fetch handler wiring", () => {
  it("returns 404 not_found for any path other than /like", async () => {
    const request = new IncomingRequest("http://example.com/wrong-path", { method: "POST" });
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json).toMatchObject({ ok: false, outcome: "not_found" });
    expect(typeof (json as { message: unknown }).message).toBe("string");
    expect((json as { message: string }).message.length).toBeGreaterThan(0);
  });

  it("returns 405 method_not_allowed for a non-POST request to /like", async () => {
    const request = new IncomingRequest("http://example.com/like", { method: "GET" });
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(405);
    const json = await response.json();
    expect(json).toMatchObject({ ok: false, outcome: "method_not_allowed" });
  });

  it("returns 401 unauthorized when the bearer secret is missing", async () => {
    const request = new IncomingRequest("http://example.com/like", { method: "POST" });
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toEqual({ message: "未授權的請求", ok: false, outcome: "unauthorized" });
  });

  it("returns 200 with the added message for a successful /like POST", async () => {
    const fake = createFakeSpotify();
    vi.stubGlobal("fetch", fake.fetch);
    fake.scriptCurrentlyPlaying({
      status: 200,
      body: {
        item: {
          id: "track123",
          name: "Bohemian Rhapsody",
          artists: [{ name: "Queen" }],
        },
        currently_playing_type: "track",
        is_playing: true,
      },
    });

    const request = new IncomingRequest("http://example.com/like", {
      method: "POST",
      headers: { Authorization: `Bearer ${SHORTCUT_SECRET}` },
    });
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      // The track name is never truncated and "Queen" is inside the
      // attribution budget, so both reach the message intact.
      message: "已加入喜愛：Bohemian Rhapsody - Queen",
      ok: true,
      outcome: "added",
      track: { name: "Bohemian Rhapsody", artist: "Queen" },
    });
    expect(fake.library.has("spotify:track:track123")).toBe(true);
  });

  it("returns 200 with the episode_added message for a playing podcast episode", async () => {
    const fake = createFakeSpotify();
    vi.stubGlobal("fetch", fake.fetch);
    fake.scriptCurrentlyPlaying({
      status: 200,
      body: {
        item: { id: "ep123", name: "Episode Title", show: { name: "The Show" } },
        currently_playing_type: "episode",
        is_playing: true,
      },
    });

    const request = new IncomingRequest("http://example.com/like", {
      method: "POST",
      headers: { Authorization: `Bearer ${SHORTCUT_SECRET}` },
    });
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, testEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      message: "已加入喜愛：The Show - Episode Title",
      ok: true,
      outcome: "episode_added",
      episode: { name: "Episode Title", show: "The Show" },
    });
    expect(fake.library.has("spotify:episode:ep123")).toBe(true);
  });
});

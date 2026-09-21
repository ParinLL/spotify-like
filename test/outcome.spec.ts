import { describe, expect, it } from "vitest";
import { classify, httpStatusForOutcome, OUTCOME_STATUS } from "../src/outcome";
import type { CallSite } from "../src/outcome";
import type { Failure, Outcome } from "../src/types";

// Unit tests for task 2.4. Per design.md's "Error Handling and Message
// Mapping" section, classify() must be total over every Failure kind x
// every CallSite, with the token call site treating ANY 4xx (including the
// `400 invalid_grant` Spotify returns for a revoked refresh token) as
// auth_failed, while the data call site only treats 401/403 as auth_failed
// and every other >=400 status — including 429 — as a generic api_failed.
// classify() is a pure mapping and never retries.
//
// Requirements: 4.2, 4.3

const SITES: CallSite[] = ["token", "data"];

describe("classify", () => {
  it("maps a 401 auth failure to auth_failed at the data site", () => {
    const failure: Failure = { kind: "auth", status: 401 };
    expect(classify(failure, "data")).toEqual<Outcome>({ kind: "auth_failed" });
  });

  it("maps a 403 auth failure to auth_failed at the data site", () => {
    const failure: Failure = { kind: "auth", status: 403 };
    expect(classify(failure, "data")).toEqual<Outcome>({ kind: "auth_failed" });
  });

  it("maps a 400 invalid_grant api failure to auth_failed at the token site", () => {
    // Spotify returns a plain 400 (not 401) for a revoked refresh token, so
    // http.ts's classification produces {kind: "api", status: 400} here —
    // classify() must still treat it as an auth failure at the token site.
    const failure: Failure = { kind: "api", status: 400 };
    expect(classify(failure, "token")).toEqual<Outcome>({ kind: "auth_failed" });
  });

  it("maps the same 400 status to api_failed at the data site", () => {
    // Same status, different call site, different outcome — the call-site
    // distinction is exactly what classify()'s second parameter encodes.
    const failure: Failure = { kind: "api", status: 400 };
    expect(classify(failure, "data")).toEqual<Outcome>({ kind: "api_failed" });
  });

  it("maps a 429 api failure at the data site to api_failed, never auth_failed, with no implied retry", () => {
    const failure: Failure = { kind: "api", status: 429 };
    const outcome = classify(failure, "data");

    // classify() is a pure function returning a single Outcome value — there
    // is nothing here that could represent a retry, so asserting the return
    // value is the whole story.
    expect(outcome).toEqual<Outcome>({ kind: "api_failed" });
  });

  it("maps a 429 api failure at the token site to auth_failed per the token-site-any-4xx rule", () => {
    // 429 is still a 4xx, so the token site's "any 4xx is an auth failure"
    // rule applies here just as it does for 400.
    const failure: Failure = { kind: "api", status: 429 };
    expect(classify(failure, "token")).toEqual<Outcome>({ kind: "auth_failed" });
  });

  it.each(SITES)("maps a 500 api failure to api_failed at the %s site", (site) => {
    const failure: Failure = { kind: "api", status: 500 };
    expect(classify(failure, site)).toEqual<Outcome>({ kind: "api_failed" });
  });

  it.each(SITES)("maps a network failure to network_failed at the %s site", (site) => {
    const failure: Failure = { kind: "network", cause: new Error("network down") };
    expect(classify(failure, site)).toEqual<Outcome>({ kind: "network_failed" });
  });

  it.each(SITES)("maps a malformed response to api_failed at the %s site", (site) => {
    const failure: Failure = { kind: "malformed" };
    expect(classify(failure, site)).toEqual<Outcome>({ kind: "api_failed" });
  });

  it.each(SITES)("maps a config failure to misconfigured at the %s site", (site) => {
    const failure: Failure = { kind: "config", missing: ["SPOTIFY_CLIENT_ID"] };
    expect(classify(failure, site)).toEqual<Outcome>({ kind: "misconfigured" });
  });
});

// The outcome -> HTTP status table from design.md's "Endpoint Contract" /
// "Status codes" section. Business outcomes and Spotify-side failures all
// return 200; only the routing/gate outcomes get a real HTTP status.
describe("httpStatusForOutcome / OUTCOME_STATUS", () => {
  it.each<[Outcome, number]>([
    [{ kind: "added", track: { id: "1", name: "n", artist: "a" } }, 200],
    [{ kind: "episode_added", episode: { id: "1", name: "n", show: "s" } }, 200],
    [{ kind: "nothing_playing" }, 200],
    [{ kind: "not_addable" }, 200],
    [{ kind: "auth_failed" }, 200],
    [{ kind: "api_failed" }, 200],
    [{ kind: "network_failed" }, 200],
    [{ kind: "misconfigured" }, 200],
    [{ kind: "unauthorized" }, 401],
    [{ kind: "not_found" }, 404],
    [{ kind: "method_not_allowed" }, 405],
  ])("maps %o to HTTP %i", (outcome, status) => {
    expect(httpStatusForOutcome(outcome)).toBe(status);
  });

  it("exposes the same table directly via OUTCOME_STATUS", () => {
    expect(OUTCOME_STATUS).toEqual({
      added: 200,
      episode_added: 200,
      nothing_playing: 200,
      not_addable: 200,
      auth_failed: 200,
      api_failed: 200,
      network_failed: 200,
      misconfigured: 200,
      unauthorized: 401,
      not_found: 404,
      method_not_allowed: 405,
    });
  });
});

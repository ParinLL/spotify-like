import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isAuthorizedCaller } from "../src/gate";
import type { Env } from "../src/types";

// Unit tests for the shared-secret gate. Per design.md "Security
// Considerations" points 2 and 3, the gate must reject a missing or
// malformed Authorization header before any other work, and must never
// authorize a caller that presents a mere prefix of the real secret.
//
// Requirements: 5.1, 5.4, 5.5

const REAL_SECRET = "abc123";

function envWithSecret(secret: string): Env {
  return {
    SPOTIFY_CLIENT_ID: "client-id",
    SPOTIFY_CLIENT_SECRET: "client-secret",
    SPOTIFY_REFRESH_TOKEN: "refresh-token",
    SHORTCUT_SECRET: secret,
    TOKEN_KV: workerEnv.TOKEN_KV,
  };
}

describe("isAuthorizedCaller", () => {
  it("rejects a request with no Authorization header at all", () => {
    const request = new Request("https://example.com/like", { method: "POST" });

    expect(isAuthorizedCaller(request, envWithSecret(REAL_SECRET))).toBe(false);
  });

  it("rejects a wrong auth scheme (Basic instead of Bearer)", () => {
    const request = new Request("https://example.com/like", {
      method: "POST",
      headers: { Authorization: `Basic ${REAL_SECRET}` },
    });

    expect(isAuthorizedCaller(request, envWithSecret(REAL_SECRET))).toBe(false);
  });

  it("rejects every caller when SHORTCUT_SECRET is an empty string", () => {
    const request = new Request("https://example.com/like", {
      method: "POST",
      headers: { Authorization: "Bearer " },
    });

    expect(isAuthorizedCaller(request, envWithSecret(""))).toBe(false);
  });

  it("rejects a wrong secret value in the header", () => {
    const request = new Request("https://example.com/like", {
      method: "POST",
      headers: { Authorization: "Bearer wrongsecret" },
    });

    expect(isAuthorizedCaller(request, envWithSecret(REAL_SECRET))).toBe(false);
  });

  it("accepts the correct secret value in the header", () => {
    const request = new Request("https://example.com/like", {
      method: "POST",
      headers: { Authorization: `Bearer ${REAL_SECRET}` },
    });

    expect(isAuthorizedCaller(request, envWithSecret(REAL_SECRET))).toBe(true);
  });

  it("rejects a secret that is a proper prefix of the real secret", () => {
    const prefix = REAL_SECRET.slice(0, REAL_SECRET.length - 1); // "abc12"
    const request = new Request("https://example.com/like", {
      method: "POST",
      headers: { Authorization: `Bearer ${prefix}` },
    });

    expect(isAuthorizedCaller(request, envWithSecret(REAL_SECRET))).toBe(false);
  });
});

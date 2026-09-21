// The fetch handler: routing, the shared-secret gate, config validation,
// orchestration, and response shaping. See design.md, "index.ts — request
// handler" and "Endpoint Contract" / "Response". This is the only module
// that constructs a Response and the only place a request-scoped log line
// is written.
//
// Order of checks, per the design and task 9.4: path -> method -> gate ->
// config -> orchestration. Config validation runs before the Spotify
// orchestration (and therefore before any token exchange) so a misconfigured
// Worker issues zero Spotify calls, per requirements 3.2 and 5.2.
//
// Requirements: 4.1, 5.1, 5.2

import { isAuthorizedCaller } from "./gate";
import { validateConfig } from "./config";
import { likeCurrentTrack } from "./like";
import { classify, httpStatusForOutcome } from "./outcome";
import { formatAddedMessage, MESSAGES } from "./messages";
import type { Env, Outcome } from "./types";

/** Fixed messages for the two routing outcomes, which never reach the Shortcut in normal operation and so have no entry in the Traditional Chinese catalog. */
const ROUTING_MESSAGES: Record<"not_found" | "method_not_allowed", string> = {
  not_found: "Not Found",
  method_not_allowed: "Method Not Allowed",
};

/** Outcome kinds that are normal (non-failure) business results. */
const SUCCESS_KINDS: ReadonlySet<Outcome["kind"]> = new Set([
  "added",
  "nothing_playing",
  "not_addable",
]);

/**
 * Builds the JSON Response for a given Outcome, per design.md's Endpoint
 * Contract: always `application/json`, always a non-empty `message`, plus
 * `ok`, `outcome`, and — for a successful add — `track` (name/artist only;
 * the internal `id` field never appears in the response body).
 *
 * Logs only `{outcome, status}`. Never the request, headers, body, or any
 * secret/token value.
 */
function respond(outcome: Outcome): Response {
  const status = httpStatusForOutcome(outcome);
  const ok = SUCCESS_KINDS.has(outcome.kind);

  const body: Record<string, unknown> = {
    message: messageFor(outcome),
    ok,
    outcome: outcome.kind,
  };
  if (outcome.kind === "added") {
    body.track = { name: outcome.track.name, artist: outcome.track.artist };
  }

  console.log(JSON.stringify({ outcome: outcome.kind, status }));

  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function messageFor(outcome: Outcome): string {
  if (outcome.kind === "added") {
    return formatAddedMessage(outcome.track, { rotationFailed: outcome.rotationFailed });
  }
  if (outcome.kind === "not_found" || outcome.kind === "method_not_allowed") {
    return ROUTING_MESSAGES[outcome.kind];
  }
  return MESSAGES[outcome.kind];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/like") return respond({ kind: "not_found" });
    if (request.method !== "POST") return respond({ kind: "method_not_allowed" });
    if (!isAuthorizedCaller(request, env)) return respond({ kind: "unauthorized" });

    const config = validateConfig(env);
    if (!config.ok) return respond(classify(config.error, "data"));

    const outcome = await likeCurrentTrack(config.value);
    return respond(outcome);
  },
} satisfies ExportedHandler<Env>;

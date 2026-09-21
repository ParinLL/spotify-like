// The no-throw fetch wrapper. Every outbound Spotify request goes through
// `call` so a timeout is always applied and every failure mode — bad status,
// DNS/TLS/reset, or an aborted/timed-out request — becomes a Failure value
// instead of a thrown exception. See design.md, "spotify/http.ts — the call
// wrapper".

import { err, ok, type Failure, type Result } from "../types";

const TIMEOUT_MS = 6_000;

export async function call(url: string, init: RequestInit): Promise<Result<Response, Failure>> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return err({ kind: "auth", status: res.status });
    if (res.status >= 400) return err({ kind: "api", status: res.status });
    return ok(res);
  } catch (cause) {
    // DNS, TLS, reset, timeout/abort — anything fetch can throw.
    return err({ kind: "network", cause });
  }
}

/**
 * Reads a Response body as JSON, yielding `undefined` instead of throwing on
 * an empty body or invalid JSON. Callers that require a specific shape (e.g.
 * token.ts reading `access_token`) validate the parsed value themselves.
 */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

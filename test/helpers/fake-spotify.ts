// A fake `fetch` for the three Spotify endpoints the Worker calls (token
// exchange, currently-playing, and the /me/library add/check pair), plus a
// recording request log. Per design.md "Testing Strategy": "Outbound calls
// go through an injected fetch stub that records every request (method,
// URL, headers, body) and serves scripted responses — the recorded log is
// what Properties 2, 4, 5, 7, and 10 assert against."
//
// Usage:
//
//   const fake = createFakeSpotify();
//   vi.stubGlobal("fetch", fake.fetch);
//   fake.scriptCurrentlyPlaying({ status: 200, body: { item: {...} } });
//   ... run the code under test ...
//   expect(fake.requestLog).toContainEqual(...);
//
// Or inject `fake.fetch` directly wherever the code under test accepts a
// fetch implementation.

/** One recorded outbound call, in the shape Properties 2, 4, 5, 7, and 10 assert against. */
export interface RecordedRequest {
  method: string;
  url: string;
  /** Headers as a plain object (lower-cased names, as Headers normalizes them). */
  headers: Record<string, string>;
  /** Raw text body, or null for bodyless requests (e.g. GET). */
  body: string | null;
}

/** A scripted response for a matched request. */
export interface ScriptedResponse {
  status: number;
  /** JSON-serializable body. Omit (or pass undefined) for an empty body, e.g. a 204. */
  body?: unknown;
  headers?: Record<string, string>;
}

type Matcher = (url: URL, method: string) => boolean;
interface Route {
  matcher: Matcher;
  handler: (url: URL, req: RecordedRequest) => ScriptedResponse;
}

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const CURRENTLY_PLAYING_PATH = "/v1/me/player/currently-playing";
const LIBRARY_PATH = "/v1/me/library";

export interface FakeSpotify {
  /** Drop-in replacement for `fetch`. Install with `vi.stubGlobal("fetch", fake.fetch)` or inject directly. */
  fetch: typeof fetch;
  /** Every outbound call made through `fetch`, in call order. */
  requestLog: RecordedRequest[];
  /** The modeled library: Set of saved track URIs (e.g. "spotify:track:abc123"). Backs Properties 6 and 7. */
  library: Set<string>;
  /** Script the next (and subsequent, until re-scripted) response for POST accounts.spotify.com/api/token. */
  scriptToken(response: ScriptedResponse): void;
  /** Script the next (and subsequent) response for GET /v1/me/player/currently-playing. */
  scriptCurrentlyPlaying(response: ScriptedResponse): void;
  /**
   * Register an arbitrary URL-pattern route, for cases the built-in
   * scriptToken/scriptCurrentlyPlaying helpers don't cover (e.g. asserting
   * on a specific query string, or simulating an endpoint outside the
   * three modeled ones).
   */
  route(matcher: Matcher, handler: Route["handler"]): void;
  /** Clears the request log without resetting scripted responses or the library model. */
  clearLog(): void;
}

/**
 * Creates a fresh fake Spotify backend: a fetch stub with a request log, a
 * library model, and scriptable responses for the token, currently-playing,
 * and library endpoints.
 *
 * The library PUT/GET handlers are wired by default (see module docs on
 * "library model" below) so model-based properties (6, 7) work without
 * extra setup; token and currently-playing responses must be scripted per
 * test via scriptToken/scriptCurrentlyPlaying, since there is no sane
 * default for "what track is playing".
 */
export function createFakeSpotify(): FakeSpotify {
  const requestLog: RecordedRequest[] = [];
  const library = new Set<string>();
  const routes: Route[] = [];

  let tokenResponse: ScriptedResponse = {
    status: 200,
    body: { access_token: "fake-access-token", token_type: "Bearer", expires_in: 3600 },
  };
  let currentlyPlayingResponse: ScriptedResponse = { status: 204 };

  function scriptToken(response: ScriptedResponse): void {
    tokenResponse = response;
  }

  function scriptCurrentlyPlaying(response: ScriptedResponse): void {
    currentlyPlayingResponse = response;
  }

  function route(matcher: Matcher, handler: Route["handler"]): void {
    // Unshift so custom routes registered later can override the built-ins
    // below, which are registered first.
    routes.unshift({ matcher, handler });
  }

  // --- built-in routes, registered first so custom routes can override them ---

  route(
    (url, method) => method === "POST" && url.toString().startsWith(TOKEN_URL),
    () => tokenResponse,
  );

  route(
    (url, method) => method === "GET" && url.pathname === CURRENTLY_PLAYING_PATH,
    () => currentlyPlayingResponse,
  );

  route(
    (url, method) => method === "PUT" && url.pathname === LIBRARY_PATH,
    (url) => {
      for (const uri of urisFromQuery(url)) library.add(uri);
      return { status: 200 };
    },
  );

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = toRequest(input, init);
    const url = new URL(request.url);
    const recorded: RecordedRequest = {
      method: request.method,
      url: request.url,
      headers: headersToObject(request.headers),
      body: await readBody(input, init),
    };
    requestLog.push(recorded);

    const matched = routes.find((r) => r.matcher(url, recorded.method));
    if (!matched) {
      throw new Error(
        `createFakeSpotify: no scripted route for ${recorded.method} ${recorded.url}. ` +
          `Register one with fake.route(...) or use scriptToken/scriptCurrentlyPlaying.`,
      );
    }

    const scripted = matched.handler(url, recorded);
    return toResponse(scripted);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requestLog,
    library,
    scriptToken,
    scriptCurrentlyPlaying,
    route,
    clearLog(): void {
      requestLog.length = 0;
    },
  };
}

/** Parses `uris` (comma-separated, URL-encoded) from a query string into an array. */
function urisFromQuery(url: URL): string[] {
  const raw = url.searchParams.get("uris");
  if (raw === null || raw.length === 0) return [];
  return raw.split(",");
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) out[key] = value;
  return out;
}

function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  if (input instanceof Request) return init ? new Request(input, init) : input;
  return new Request(input.toString(), init);
}

/** Reads the request body as text without consuming a body the caller still owns. */
async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (init?.body !== undefined && init.body !== null) {
    return bodyInitToText(init.body);
  }
  if (input instanceof Request && input.body) {
    return input.clone().text();
  }
  return null;
}

async function bodyInitToText(body: BodyInit): Promise<string> {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return body.text();
  // ArrayBuffer / typed arrays / ReadableStream fall back to Response's
  // body handling, which is sufficient for what this Worker ever sends.
  return new Response(body as BodyInit).text();
}

function toResponse(scripted: ScriptedResponse): Response {
  const hasBody = scripted.body !== undefined;
  const text = hasBody ? JSON.stringify(scripted.body) : undefined;
  const headers = new Headers(scripted.headers ?? {});
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(text ?? null, { status: scripted.status, headers });
}

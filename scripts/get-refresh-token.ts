// One-time helper: obtains a Spotify refresh token via the OAuth
// authorization-code flow, per design.md's "One-Time Setup Procedure",
// step 2.
//
// This is a standalone Node.js CLI script, not part of the deployed Worker.
// `scripts/` is excluded from the Wrangler bundle (wrangler.toml's `main`
// points only at `src/index.ts`), and this script imports nothing from
// `src/`.
//
// Usage:
//   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node scripts/get-refresh-token.ts
// or:
//   node scripts/get-refresh-token.ts --client-id=... --client-secret=...
//
// The script prints the refresh token to stdout on success and writes no
// credential to disk. The access token returned alongside it is discarded.

/// <reference types="node" />

import * as http from "node:http";

const REDIRECT_URI = "http://127.0.0.1:8787/callback";
const CALLBACK_PORT = 8787;
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

// The two scopes the Worker actually uses (design.md, requirements 3.3):
//   user-read-currently-playing -> GET /me/player/currently-playing
//   user-library-modify         -> PUT /me/library
//
// Narrowed from four. `user-read-playback-state` was never used — it covers
// GET /me/player and /me/player/devices, which this Worker does not call,
// and it asks the user for Spotify Connect device access on top of that.
// `user-library-read` backed a library probe that has since been removed.
const SCOPES = ["user-read-currently-playing", "user-library-modify"] as const;

interface Credentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Reads the Spotify client id and client secret from CLI args
 * (--client-id=..., --client-secret=...) or, failing that, from the
 * SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET environment variables.
 * Credentials are never hardcoded and never written anywhere by this script.
 */
function readCredentials(argv: string[], env: NodeJS.ProcessEnv): Credentials {
  const fromArgs: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      fromArgs[match[1]] = match[2];
    }
  }

  const clientId = fromArgs["client-id"] ?? env.SPOTIFY_CLIENT_ID ?? "";
  const clientSecret = fromArgs["client-secret"] ?? env.SPOTIFY_CLIENT_SECRET ?? "";

  if (clientId === "" || clientSecret === "") {
    throw new Error(
      "Missing Spotify client id/secret. Provide SPOTIFY_CLIENT_ID and " +
        "SPOTIFY_CLIENT_SECRET env vars, or --client-id=... --client-secret=... args.",
    );
  }

  return { clientId, clientSecret };
}

/** Builds the authorize URL for step 1 of the authorization-code flow. */
export function buildAuthorizeUrl(clientId: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  return url.toString();
}

/**
 * Starts a local HTTP listener on 127.0.0.1:8787 and resolves with the
 * `code` query parameter once Spotify redirects back to `/callback`.
 * Responds to the browser and shuts the listener down before resolving.
 */
function waitForAuthorizationCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error !== null) {
        res
          .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
          .end(`Authorization failed: ${error}. You can close this tab.`);
        server.close();
        reject(new Error(`Spotify authorization failed: ${error}`));
        return;
      }

      if (code === null) {
        res
          .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
          .end("Missing authorization code. You can close this tab.");
        server.close();
        reject(new Error("Callback received with no `code` parameter"));
        return;
      }

      res
        .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        .end("Authorization received. You can close this tab.");
      server.close();
      resolve(code);
    });

    server.on("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
}

/**
 * Exchanges the authorization code for tokens via the authorization-code
 * grant with Basic auth, per design.md step 3. Returns only the refresh
 * token; the access token is discarded by the caller.
 */
async function exchangeCodeForTokens(
  code: string,
  credentials: Credentials,
): Promise<{ refreshToken: string }> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    "base64",
  );

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${text}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Token exchange returned a non-JSON body: ${text}`);
  }

  const refreshToken =
    typeof body === "object" && body !== null && "refresh_token" in body
      ? (body as { refresh_token: unknown }).refresh_token
      : undefined;

  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("Token exchange response did not contain a refresh_token");
  }

  return { refreshToken };
}

async function main(): Promise<void> {
  const credentials = readCredentials(process.argv.slice(2), process.env);
  const authorizeUrl = buildAuthorizeUrl(credentials.clientId);

  process.stderr.write("Open this URL in a browser signed in to the target Spotify account:\n\n");
  process.stderr.write(`${authorizeUrl}\n\n`);
  process.stderr.write(`Waiting for the redirect to ${REDIRECT_URI} ...\n`);

  const code = await waitForAuthorizationCode();
  const { refreshToken } = await exchangeCodeForTokens(code, credentials);

  // The refresh token is the only credential this script ever prints, and
  // it goes to stdout only — never to a file.
  process.stdout.write(`${refreshToken}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

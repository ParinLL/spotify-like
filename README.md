# Spotify Like Action Button

[中文版 (Traditional Chinese)](README.zh-TW.md)

A Cloudflare Worker that turns one iPhone Action Button press into "save the
currently playing Spotify track to Liked Songs", with a Traditional Chinese
notification for the result. See `.kiro/specs/spotify-like-action-button/`
for the requirements and design behind this Worker.

This README is the one-time setup procedure: registering a Spotify app,
obtaining a refresh token, deploying the Worker, and wiring the Shortcut.

## Spotify APIs used

Only the **Web API** (REST endpoints: token exchange, currently-playing, library writes). No Ads API, Web Playback SDK, iOS SDK, or Android SDK.

## Prerequisites

- A Spotify account (Free or Premium) whose library the button should modify.
- Node.js and this repo installed (`npm install`).
- The Wrangler CLI logged in to your Cloudflare account (`npx wrangler login`).
- An iPhone with the Shortcuts app and a programmable Action Button (iPhone 15 Pro or newer).

## 1. Register a Spotify application

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and sign in with the account whose library the button should modify.
2. Click **Create app**, fill in a name and description (anything works, this app is never public).
3. Add `http://127.0.0.1:8787/callback` as a **Redirect URI** and save. It's only used by the one-time authorization step below and can be removed afterwards.
4. Open **Settings** on the app and note the **Client ID** and **Client Secret**. You'll need both in the next step.

## 2. Obtain the refresh token

This is a one-time OAuth authorization-code exchange. It requests exactly
four scopes: `user-read-currently-playing`, `user-read-playback-state`,
`user-library-modify`, `user-library-read`. **Scopes cannot be widened
later without repeating this entire flow**, so don't skip any of the four
even if you think you won't need `user-library-read` yet.

### Option A: helper script (recommended)

```bash
SPOTIFY_CLIENT_ID=<your-client-id> SPOTIFY_CLIENT_SECRET=<your-client-secret> \
  npx tsx scripts/get-refresh-token.ts
```

or pass the credentials as flags instead of env vars:

```bash
npx tsx scripts/get-refresh-token.ts --client-id=<your-client-id> --client-secret=<your-client-secret>
```

The script prints an authorize URL to stderr, starts a local listener on
`127.0.0.1:8787`, and waits. Open the printed URL in a browser **signed in
as the target Spotify account**, approve access, and the script exchanges
the resulting code automatically. The refresh token is printed to stdout —
copy it. Nothing is written to disk.

### Option B: manual curl equivalent

1. Open this URL in a browser signed in as the target account (fill in `<CLIENT_ID>`):

   ```
   https://accounts.spotify.com/authorize?client_id=<CLIENT_ID>&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fcallback&scope=user-read-currently-playing%20user-read-playback-state%20user-library-modify%20user-library-read
   ```

2. Approve access. The browser redirects to `http://127.0.0.1:8787/callback?code=<AUTH_CODE>` (this will show as unreachable in the browser, since nothing is listening — that's fine, just copy `<AUTH_CODE>` from the address bar).
3. Exchange the code within a few minutes (codes are single-use and short-lived):

   ```bash
   curl -X POST https://accounts.spotify.com/api/token \
     -u "<CLIENT_ID>:<CLIENT_SECRET>" \
     -d grant_type=authorization_code \
     -d code=<AUTH_CODE> \
     -d redirect_uri=http://127.0.0.1:8787/callback
   ```

4. Copy the `refresh_token` field from the JSON response. It does not
   expire on its own — it's invalidated only by revoking the app's access
   or changing the account password. Discard the `access_token`; the
   Worker mints its own on every request.

## 3. Provision the token-rotation KV namespace

The Worker persists a Spotify-issued replacement refresh token to a
Cloudflare Workers KV namespace (`TOKEN_KV`) instead of discarding it, so
the button keeps working even if Spotify rotates the refresh token behind
the scenes. Before the first real deploy, create the namespace:

```bash
npx wrangler kv namespace create spotify-like-token-store
```

This prints an id. Copy it into the `id` field of the `[[kv_namespaces]]`
block already present in `wrangler.toml` (replacing the
`REPLACE_WITH_REAL_KV_NAMESPACE_ID` placeholder):

```toml
[[kv_namespaces]]
binding = "TOKEN_KV"
id = "<id printed above>"
```

No `wrangler kv key put` seeding step is needed — on first deploy the KV
namespace is empty and the Worker simply falls back to
`SPOTIFY_REFRESH_TOKEN` (set in the next step), behaving exactly like the
base feature until Spotify happens to rotate a token on its own.

## 4. Deploy the Worker

Set the four secrets, one at a time (`wrangler secret put` prompts for the
value so it never lands in shell history):

```bash
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put SPOTIFY_REFRESH_TOKEN
npx wrangler secret put SHORTCUT_SECRET      # e.g. value from: openssl rand -base64 32
```

Then deploy:

```bash
npx wrangler deploy
```

Note the Worker URL Wrangler prints (`https://<worker-name>.<subdomain>.workers.dev`) — you'll need it for the Shortcut.

### Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in the same four values
(this file is git-ignored and never committed):

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET,
# SPOTIFY_REFRESH_TOKEN, SHORTCUT_SECRET
npx wrangler dev
```

`wrangler dev` reads `.dev.vars` automatically and serves the Worker on
`http://127.0.0.1:8787`. No additional KV setup is needed for local
development either — `wrangler dev` provisions a local, on-disk simulation
of the `TOKEN_KV` namespace declared in `wrangler.toml` automatically, with
no real Cloudflare KV namespace id required.

## 5. Configure the Shortcut

In the iOS Shortcuts app, create a new shortcut with two actions:

1. **Get Contents of URL**
   - URL: `https://<worker-name>.<subdomain>.workers.dev/like`
   - Method: `POST`
   - Headers: add one header — `Authorization` = `Bearer <SHORTCUT_SECRET>` (the same value you set in step 4)
   - Request Body: none
2. **Show Notification**
   - Body: tap the field → **Select Variable** → **Get Dictionary Value** → key `message`, reading from the previous action's result (the JSON the Worker returns).

### Bind it to the Action Button

**Settings → Action Button → Shortcut**, then select this shortcut.

## 6. Verify

With a track playing, press the Action Button. Expected banner:

```
已加入喜愛：<歌名> - <歌手>
```

Also try it with playback stopped (expect `目前沒有播放中的歌曲`) and with a
podcast episode playing (expect `目前播放的內容無法加入喜愛`), to confirm all
three common outcomes render correctly.

**If iOS shows a generic "The action failed" / "Could not run shortcut"
dialog instead of a Chinese notification**, the `Authorization` header is
wrong — check that the `SHORTCUT_SECRET` in the Shortcut's header exactly
matches the secret you set with `wrangler secret put SHORTCUT_SECRET`. This
is the one outcome the Worker answers with a non-200 status, so every other
failure (Spotify down, expired Spotify authorization, network issues) still
reaches `Show Notification` with a readable message.

## Rotating or revoking access

- **Rotate the shortcut secret:** run `wrangler secret put SHORTCUT_SECRET` again with a new value, then update the header in the Shortcut.
- **Revoke Spotify access:** remove the app's access from your [Spotify account access list](https://www.spotify.com/account/apps/), then redo step 2 and `wrangler secret put SPOTIFY_REFRESH_TOKEN` with the new token.

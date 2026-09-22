# Spotify Like Action Button

[中文版 (Traditional Chinese)](README.zh-TW.md)

A Cloudflare Worker that saves the currently playing Spotify track (or
podcast episode) to Liked Songs in one tap, with a Traditional Chinese
notification for the result. The trigger is not limited to the iPhone Action
Button — any way of running an iOS Shortcut works; see "Triggering it" below.
See `.kiro/specs/spotify-like-action-button/` for the requirements and design
behind this Worker.

This README is the one-time setup procedure: registering a Spotify app,
obtaining a refresh token, deploying the Worker, and wiring the Shortcut.

## Spotify APIs used

Only the **Web API** (REST endpoints: token exchange, currently-playing, library writes). No Ads API, Web Playback SDK, iOS SDK, or Android SDK.

## Prerequisites

- A Spotify account whose library the button should modify. **Premium is
  required** — see [Development Mode requirements](#development-mode-requirements).
- Node.js and this repo installed (`npm install`).
- The Wrangler CLI logged in to your Cloudflare account (`npx wrangler login`).
- An iPhone with the Shortcuts app. An Action Button is not required — it's just one of several triggers (see step 5).

## 1. Register a Spotify application

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and sign in with the account whose library the button should modify.
2. Click **Create app**, fill in a name and description (anything works, this app is never public).
3. Add `http://127.0.0.1:8787/callback` as a **Redirect URI** and save. It's only used by the one-time authorization step below and can be removed afterwards.
4. Open **Settings** on the app and note the **Client ID** and **Client Secret**. You'll need both in the next step.

## 2. Obtain the refresh token

This is an OAuth authorization-code exchange requesting exactly two scopes,
which is everything the Worker uses and nothing more:

| Scope | What it is for |
|---|---|
| `user-read-currently-playing` | `GET /me/player/currently-playing` |
| `user-library-modify` | `PUT /me/library` (saves both tracks and episodes) |

Earlier versions requested two more. `user-read-playback-state` was never
used by any code path — it covers `GET /me/player` and `/me/player/devices`,
which this Worker does not call, and it additionally asks the user for
Spotify Connect device access. `user-library-read` backed an
"is it already saved?" probe that has since been removed, because
`PUT /me/library` is idempotent and the answer could not change whether the
add is issued.

Widening scopes later does mean repeating this flow — but you already repeat
it at least every 6 months for the refresh token anyway, so there is no
reason to over-request now.

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
   https://accounts.spotify.com/authorize?client_id=<CLIENT_ID>&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fcallback&scope=user-read-currently-playing%20user-library-modify
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

4. Copy the `refresh_token` field from the JSON response. Discard the
   `access_token`; the Worker mints its own on every request.

> [!IMPORTANT]
> **The refresh token expires 6 months after you authorize the app**, so
> this step is not one-time — you have to redo it at least every 6 months.
>
> The clock starts at the moment of authorization and **refreshing does not
> extend it**: per [Spotify's refresh token
> documentation](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens),
> the lifetime is measured from the original authorization, not from the last
> refresh. Spotify [introduced this in June
> 2026](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration);
> refresh tokens used to last indefinitely. Content was rephrased for
> compliance with licensing restrictions.
>
> When it expires, the token endpoint returns `400 invalid_grant` and the
> notification reads `Spotify authorization expired, please re-authorize`.
> See [Re-authorizing every 6 months](#re-authorizing-every-6-months) for the
> recovery procedure — note that it takes **two** commands, not one.
>
> **Set a calendar reminder now, while you are on this step.** Nothing will
> warn you as the deadline approaches: Spotify does not expose the token's
> issue date, and this Worker does not record when you authorized it, so the
> first signal is a press that fails. Aim a week early:
>
> ```bash
> date -v+6m -v-7d +%Y-%m-%d   # macOS
> date -d '+6 months -7 days' +%Y-%m-%d   # Linux
> ```
>
> Run that on the day you authorize and put the result in your calendar. The
> reminder doubles as the record of when the authorization happened.

## 3. Provision the token-rotation KV namespace

The Worker persists a Spotify-issued replacement refresh token to a
Cloudflare Workers KV namespace (`TOKEN_KV`) instead of discarding it, so
the button keeps working even if Spotify rotates the refresh token behind
the scenes.

This handles Spotify *replacing* a token mid-life. It does **not** extend
the 6-month authorization lifetime — a replacement token inherits the same
expiry as the one it replaces, because that expiry is tied to the original
authorization. Rotation and expiry are separate things.

Before the first real deploy, create the namespace:

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

### Notification language

Notifications are in **English by default**. To get Traditional Chinese, set
`MESSAGE_LANGUAGE` in `wrangler.toml`:

```toml
[vars]
MESSAGE_LANGUAGE = "zh_TW"   # "en" (default) or "zh_TW"
```

This is a plain var, not a secret, so it belongs in `wrangler.toml` rather
than `wrangler secret put`. Only `en` and `zh_TW` are accepted, exactly as
spelled — `zh-TW`, `zh_tw` and `EN` are all rejected. An unrecognized value
makes the Worker answer `misconfigured` for every request instead of quietly
falling back, so a typo is visible rather than silently serving the wrong
language. Leaving the var out entirely is fine and means English.

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

`MESSAGE_LANGUAGE` is read from `wrangler.toml` in local development too, not
from `.dev.vars` — it is a var, not a secret.

`wrangler dev` reads `.dev.vars` automatically and serves the Worker on
`http://127.0.0.1:8787`. No additional KV setup is needed for local
development either — `wrangler dev` provisions a local, on-disk simulation
of the `TOKEN_KV` namespace declared in `wrangler.toml` automatically, with
no real Cloudflare KV namespace id required.

## 5. Configure the Shortcut

In the iOS Shortcuts app, create a new shortcut with **three** actions, in order:

1. **Get Contents of URL**
   - URL: `https://<worker-name>.<subdomain>.workers.dev/like`
   - Method: `POST`
   - Headers: add one — key `Authorization`, value `Bearer <SHORTCUT_SECRET>`
     (one space after `Bearer`; same value you set in step 4). This is the
     only field that must be exactly right — see the troubleshooting note in
     step 6 for what a wrong value looks like.
   - Request Body: leave it alone. `None` and the default `JSON` with no
     fields both work, because the Worker ignores the body entirely — there
     is nothing for the caller to parameterize.
2. **Get Dictionary Value**
   - Get: `Value`
   - Key: `message`
   - Input is wired to the previous action's result automatically
3. **Show Notification**
   - Body: use the **Dictionary Value** variable from step 2 (not the whole
     "Contents of URL", which would render the raw JSON)
   - Title: can be left empty — the field is optional
   - Attachment: leave empty. Anything here is harmless but shows nothing
     useful, since the value is a plain string.
   - Play Sound: taste. Useful if you trigger this without looking at the
     screen.

Only the **Body** of this action matters. Action 2 is the one step people
miss: without it the notification shows the whole
`{"message":"...","ok":true,"outcome":"added",...}` string instead of just the
sentence.

That is the entire shortcut — three actions, nothing conditional. The same
three work unchanged as a second copy targeted at an Apple Watch.

### Triggering it (pick any — an Action Button is optional)

What matters is having a fast way to run the shortcut. The Action Button is
just the most convenient one:

| Trigger | Where to set it | Notes |
|---|---|---|
| **iPhone Action Button** | Settings → Action Button → Shortcut | iPhone 15 Pro or newer |
| **Apple Watch Ultra Action Button** | On the watch: Settings → Action Button → Shortcut; or iPhone's Watch app → Action Button | Ultra / Ultra 2. Most natural while listening |
| **Control Center** | Edit Control Center → add a Shortcuts control | iOS 18+ |
| **Lock Screen / Home Screen** | Shortcuts app → long-press the shortcut → Add to Home Screen; or a Lock Screen widget | Any model |
| **Back Tap** | Settings → Accessibility → Touch → Back Tap → Double/Triple Tap | Any model, uses no button |
| **Siri** | Just say the shortcut's name (e.g. "Spotify-like") | Works from Apple Watch / AirPods too |
| **Shortcuts app on Apple Watch** | Open Shortcuts on the watch and tap it; or add it as a watch face complication | Not Ultra-specific |

Running it from an Apple Watch works fine — the shortcut only uses "Get
Contents of URL", which watchOS supports. With LTE or Wi-Fi the watch runs it
independently; otherwise it goes through the paired iPhone.

(The `action-button` in this project's name reflects the original use case,
not a requirement.)

## 6. Verify

With a track playing, run the shortcut (via any trigger above). Expected banner:

```
Liked: <name> - <artist>
```

Try a few playback states to confirm all four outcomes render correctly:

| What's playing | Expected notification (`en`) | Expected notification (`zh_TW`) |
|---|---|---|
| A normal track | `Liked: <name> - <artist>` | `已加入喜愛：<歌名> - <歌手>` |
| A podcast episode | `Liked: <show> - <title>` | `已加入喜愛：<節目名稱> - <單集標題>` |
| Nothing | `Nothing is playing` | `目前沒有播放中的歌曲` |
| A local file | `This item can't be added to your library` | `目前播放的內容無法加入喜愛` |

A local file is the only expected "not addable" case. Podcasts add normally.

If a podcast ever reports "not addable", that is a bug worth reporting rather
than retrying. The one known cause was the Worker omitting
`additional_types=track,episode` from the currently-playing request: without
it, Spotify answers with `item: null` for *every* episode, leaving no episode
id to save ([spotify/web-api#1496](https://github.com/spotify/web-api/issues/1496)).
That parameter is now sent, so this has no known trigger left — earlier
versions of this README described it as an intermittent Spotify-side condition,
which was a misdiagnosis of our own missing parameter.

### Message length

The **title** (track name, episode title) is always shown in full. Only the
**attribution** (artist, show name) is capped — at **28 display columns**, with
`…` appended when it overflows.

The reason is that iOS truncates a notification *from the tail*. Without a cap,
a long show name eats the banner before the episode title even starts. Capping
the attribution instead means that if anything is lost to iOS's own truncation,
it is the secondary field rather than the thing you are trying to identify.

Columns rather than characters: CJK text is full-width and counts 2 per
character while Latin counts 1, so 28 columns is ~14 Han characters or ~28 Latin
characters — the same visual length for both scripts, and the same budget in
either notification language. The banner fits roughly 38-40 columns per line
over two lines, so the prefix (`已加入喜愛：` is 12 columns, `Liked: ` is 7), a
28-column attribution and the ` - ` separator (3) leave most of the second line
for the title.

```
Liked: 珞亦不絕 by 法律白話文 Plain… - 154｜遲到、擺爛、不夠完美 ft. yoyo
已加入喜愛：Bohemian Rhapsody - Queen
```

Truncation affects only the `message` field — the `track` / `episode` objects in
the response JSON keep their full, untruncated values.

**If iOS shows a generic "The action failed" / "Could not run shortcut"
dialog instead of a Chinese notification**, the `Authorization` header is
wrong — check that the `SHORTCUT_SECRET` in the Shortcut's header exactly
matches the secret you set with `wrangler secret put SHORTCUT_SECRET`. This
is the one outcome the Worker answers with a non-200 status, so every other
failure (Spotify down, expired Spotify authorization, network issues) still
reaches `Show Notification` with a readable message.

## Development Mode requirements

A personal app like this one stays in Spotify's **Development Mode** (Extended
Quota Mode is for apps serving many users). Since Spotify's
[February 2026 changes](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide),
that mode carries requirements worth knowing before you debug anything else:

- **The app owner needs an active Spotify Premium subscription.** If it lapses,
  the app stops working, and it resumes once you resubscribe. This is the one
  failure cause with no distinctive notification — it surfaces as
  `Couldn't complete that, please try again shortly` (`api_failed`) or an
  authorization message, neither of which points at billing. Check your
  subscription before anything else if the button stops working and nothing
  changed.
- **One Client ID per developer**, and **5 users per app**. Fine for personal
  use. Existing apps that already exceed these are grandfathered.
- Development Mode has a lower rate limit than Extended Quota Mode. Not a
  concern here: one press costs at most 3 API calls against a
  [30-second rolling window](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).

Content was rephrased for compliance with licensing restrictions.

## Re-authorizing every 6 months

When the notification says `Spotify authorization expired, please
re-authorize` (or `Spotify 授權已失效，請重新取得授權`), the 6-month refresh
token lifetime has run out. Redo step 2 to get a new refresh token, then run
**both** of these:

```bash
npx wrangler secret put SPOTIFY_REFRESH_TOKEN          # the new token
npx wrangler kv key delete refresh_token --binding TOKEN_KV --remote
```

The second command is the one that is easy to miss. The Worker prefers the
KV-stored rotated token over the `SPOTIFY_REFRESH_TOKEN` secret, so as long
as the expired value is still in KV it keeps winning and the Worker keeps
failing — updating the secret alone changes nothing. Deleting the key makes
the Worker fall back to the secret you just set, and the next rotation
repopulates KV.

To confirm it worked, press the Shortcut: a successful add means the new
authorization is live.

## Rotating or revoking access

- **Rotate the shortcut secret:** run `wrangler secret put SHORTCUT_SECRET` again with a new value, then update the header in the Shortcut.
- **Revoke Spotify access:** remove the app's access from your [Spotify account access list](https://www.spotify.com/account/apps/). To start using it again afterwards, follow [Re-authorizing every 6 months](#re-authorizing-every-6-months) — including the KV deletion.

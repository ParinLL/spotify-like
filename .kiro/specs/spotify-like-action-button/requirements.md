# Requirements Document

## Introduction

This feature lets a single user press the iPhone Action Button to save the currently playing Spotify item, either a track or a podcast episode, to their "Liked Songs" library. Pressing the Action Button triggers an iOS Shortcut, which calls a Cloudflare Worker HTTP endpoint. The Worker authenticates to the Spotify Web API using a single refresh token bound to one personal account, reads the currently playing item, adds it to Liked Songs in an idempotent (add-only) manner, and returns a human-readable status message for the Shortcut to display as a notification.

The refresh token is not long-lived. Spotify limits it to 6 months measured from the account's authorization of the Spotify application, and refreshing does not extend that window, so the authorization is repeated at least that often.

The notification language is configurable: English is the default and Traditional Chinese is available. The language is a deployment setting rather than a credential, so it is held in a plain variable rather than in Worker Secrets.

The design is intentionally minimal: personal single-account use only, no multi-user OAuth, and no per-user isolation. All secrets are stored in Cloudflare Worker Secrets.

## Glossary

- **Action_Button**: The programmable hardware button on the iPhone that the user presses to start the flow.
- **Shortcut**: The iOS Shortcuts automation bound to the Action Button that sends an HTTP request to the Worker and displays the returned message as a notification.
- **Worker**: The Cloudflare Worker service that receives the Shortcut request, calls the Spotify Web API, and returns a status message. This is the primary system under specification.
- **Spotify_API**: The Spotify Web API used to read the currently playing item and modify the user's library, via the currently-recommended endpoints for each operation (for example, the `/me/library` endpoint for saving items).
- **Liked_Songs**: The user's saved-tracks library in Spotify (the "Liked Songs" collection).
- **Refresh_Token**: The single OAuth refresh token bound to one Spotify account, used to obtain fresh access tokens. Its lifetime is 6 months, measured from the moment that account authorized the Spotify application and not extended by refreshing, so re-authorization is required at least every 6 months.
- **Access_Token**: A short-lived OAuth token obtained by exchanging the Refresh_Token, used to authorize Spotify_API calls.
- **Worker_Secrets**: Cloudflare Worker Secrets storage (via `wrangler secret`) holding the Spotify client id, client secret, Refresh_Token, and Shared_Secret.
- **Current_Track**: The track Spotify reports as currently playing for the bound account.
- **Current_Episode**: The podcast episode Spotify reports as currently playing for the bound account. It is identified to the user by two separate fields: the show name (the name of the podcast) and the episode title.
- **Current_Item**: Whatever Spotify reports as currently playing for the bound account, which is either a Current_Track or a Current_Episode.
- **Message_Language**: The language the Worker renders its notification messages in, selected by the optional `MESSAGE_LANGUAGE` plain variable declared in `wrangler.toml`. Its accepted values are exactly `en` (the default) and `zh_TW`. It holds a wording choice rather than a credential and is therefore not a Worker_Secret.
- **Setup_Operator**: The person performing the one-time setup (registering the Spotify app, obtaining the initial Refresh_Token, and setting Worker_Secrets).
- **Shared_Secret**: A high-entropy value known only to the Worker and the Shortcut, presented by the Shortcut on every request and verified by the Worker before any Spotify_API call is made.
- **Authorized_Request**: A request received by the Worker that presents the correct Shared_Secret.

## Requirements

### Requirement 1: Save the currently playing item on button press

**User Story:** As the account owner, I want a single Action Button press to save the currently playing song or podcast episode to my Liked Songs, so that I can like what I am listening to without unlocking my phone or opening Spotify.

#### Acceptance Criteria

1. WHEN the Worker receives an Authorized_Request from the Shortcut, THE Worker SHALL request the Current_Item from the Spotify_API.
2. WHEN the Spotify_API reports a Current_Track, THE Worker SHALL add the Current_Track to Liked_Songs.
3. WHEN the Worker adds the Current_Track to Liked_Songs, THE Worker SHALL return a success message in the Message_Language that contains the lead-in for that Message_Language, then the track name rendered in full, then the artist name truncated to at most 28 display columns with an ellipsis (`…`) appended when truncation occurs (rendered in `zh_TW` as "已加入喜愛：<歌名> - <歌手>" and in `en` as "Liked: <name> - <artist>").
4. WHEN the Spotify_API reports that no item is currently playing, THE Worker SHALL return the no-playback message in the Message_Language (which is "Nothing is playing" in `en` and "目前沒有播放中的歌曲" in `zh_TW`).
5. WHEN the Spotify_API reports a Current_Item that carries no addable Spotify identifier (a local file, or an item reported without an identifier), THE Worker SHALL return a message in the Message_Language indicating that the currently playing content cannot be added to Liked_Songs, and SHALL NOT call the Spotify_API to modify Liked_Songs.
6. WHEN the Spotify_API reports a Current_Episode that carries an addable Spotify identifier, THE Worker SHALL add the Current_Episode to Liked_Songs.
7. WHEN the Worker adds a Current_Episode to Liked_Songs, THE Worker SHALL return a success message in the Message_Language that contains the lead-in for that Message_Language, then the show name truncated to at most 28 display columns with an ellipsis (`…`) appended when truncation occurs, then the episode title rendered in full (rendered in `zh_TW` as "已加入喜愛：<節目名稱> - <單集標題>" and in `en` as "Liked: <show> - <title>").
8. THE Worker SHALL apply the 28-display-column truncation only to the human-readable message, and SHALL report the untruncated track name, artist name, show name, and episode title in the structured fields of its response.

### Requirement 2: Idempotent add-only behavior for repeated presses

**User Story:** As the account owner, I want repeated presses to be harmless, so that liking an already-liked song never removes it.

#### Acceptance Criteria

1. WHERE the Current_Track is already present in Liked_Songs, THE Worker SHALL keep the Current_Track in Liked_Songs.
2. WHEN the Worker processes a Current_Track that is already in Liked_Songs, THE Worker SHALL return a success message in the Message_Language containing the track name and artist name.
3. THE Worker SHALL perform an add-only operation and SHALL NOT remove any track from Liked_Songs.

### Requirement 3: Automatic Spotify authentication via refresh token

**User Story:** As the account owner, I want the Worker to authenticate to Spotify automatically, so that I do not re-authorize at any point during the Refresh_Token's lifetime.

#### Acceptance Criteria

1. WHEN the Worker needs to call the Spotify_API, THE Worker SHALL exchange the Refresh_Token for a fresh Access_Token using the OAuth refresh-token grant.
2. THE Worker SHALL read the Spotify client id, Spotify client secret, and Refresh_Token from Worker_Secrets.
3. THE Worker SHALL request exactly the OAuth scopes user-read-currently-playing and user-library-modify.
4. WHEN the Worker adds the Current_Item to Liked_Songs, THE Worker SHALL use the current Spotify library-save endpoint (`PUT /me/library`) rather than a deprecated equivalent.
5. WHEN the Worker adds the Current_Item to Liked_Songs, THE Worker SHALL rely on the idempotence of the Spotify library-save endpoint, and SHALL NOT query the Spotify_API for the saved status of the Current_Item.

### Requirement 4: Status notifications in the configured language for every outcome

**User Story:** As the account owner, I want clear notifications for every outcome, so that I know what happened after each press.

#### Acceptance Criteria

1. THE Worker SHALL return a human-readable message in the Message_Language in every response for the Shortcut to display as a notification.
2. IF the Spotify_API returns an authentication or authorization error, THEN THE Worker SHALL return an error message in the Message_Language indicating that authentication failed.
3. IF the Spotify_API returns an error other than authentication or authorization, THEN THE Worker SHALL return an error message in the Message_Language indicating that the request could not be completed.
4. IF the Worker cannot reach the Spotify_API, THEN THE Worker SHALL return an error message in the Message_Language indicating a connection failure.

### Requirement 5: Single-account binding with secure secret storage

**User Story:** As the account owner, I want the service bound to only my account with secrets stored securely, so that no other user or credential store is involved.

#### Acceptance Criteria

1. THE Worker SHALL operate against exactly one Spotify account identified by the single Refresh_Token in Worker_Secrets.
2. THE Worker SHALL store the Spotify client id, Spotify client secret, and Refresh_Token exclusively in Worker_Secrets.
3. THE Worker SHALL NOT store the Spotify client id, Spotify client secret, or Refresh_Token in source code.
4. THE Worker SHALL require every request to present the Shared_Secret using the Authorization Bearer scheme before performing any Spotify_API call.
5. IF a request does not present the correct Shared_Secret, THEN THE Worker SHALL reject the request and SHALL NOT call the Spotify_API.
6. THE Worker SHALL store the Shared_Secret exclusively in Worker_Secrets.
7. THE Worker SHALL NOT store the Shared_Secret in source code.
8. THE Worker SHALL read the Message_Language from the optional `MESSAGE_LANGUAGE` plain variable declared in `wrangler.toml` rather than from Worker_Secrets.

### Requirement 6: Documented setup procedure

**User Story:** As the Setup_Operator, I want documented setup steps, so that I can provision the Worker before first use and re-authorize it when its authorization expires.

#### Acceptance Criteria

1. THE project README SHALL document registration of a Spotify application to obtain a client id and client secret.
2. THE project README SHALL document the procedure to obtain the initial Refresh_Token using the OAuth authorization-code flow with the required scopes.
3. THE project README SHALL document setting the Spotify client id, Spotify client secret, Refresh_Token, and Shared_Secret as Worker_Secrets using `wrangler secret`.
4. THE project README SHALL document configuring the Shortcut to send an HTTP request to the Worker endpoint with the Shared_Secret and display the returned message as a notification.
5. THE project README SHALL document setting the optional `MESSAGE_LANGUAGE` variable in `wrangler.toml`, its accepted values `en` and `zh_TW`, and that omitting it selects English.
6. THE project README SHALL document the procedure to re-authorize after the Refresh_Token's 6-month lifetime expires, including both setting the newly obtained Refresh_Token as a Worker_Secret and deleting the rotated Refresh_Token persisted in the Worker's KV token store so that the new value takes effect.
7. THE project README SHALL document Spotify's Development Mode requirements, including that the account owning the Spotify application holds an active Spotify Premium subscription.

### Requirement 7: Configurable notification language

**User Story:** As the Setup_Operator, I want to choose which language the notifications are written in and to be told when I have set that choice to something unusable, so that the account owner reads the messages in the intended language and a mistyped setting is visible instead of silent.

#### Acceptance Criteria

1. WHERE `MESSAGE_LANGUAGE` is set to `en` or to `zh_TW`, THE Worker SHALL adopt that value as the Message_Language for every message it returns.
2. WHERE `MESSAGE_LANGUAGE` is absent or is empty, THE Worker SHALL adopt `en` as the Message_Language for every message it returns.
3. IF `MESSAGE_LANGUAGE` is set to a non-empty value that is not exactly `en` or `zh_TW` (for example `EN`, `zh_tw`, or `zh-TW`), THEN THE Worker SHALL return a message indicating that its configuration is incomplete, and SHALL NOT call the Spotify_API.
4. WHILE `MESSAGE_LANGUAGE` holds a non-empty value that is not exactly `en` or `zh_TW`, THE Worker SHALL adopt `en` as the Message_Language for the configuration message it returns.

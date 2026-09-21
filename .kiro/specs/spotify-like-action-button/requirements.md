# Requirements Document

## Introduction

This feature lets a single user press the iPhone Action Button to save the currently playing Spotify track to their "Liked Songs" library. Pressing the Action Button triggers an iOS Shortcut, which calls a Cloudflare Worker HTTP endpoint. The Worker authenticates to the Spotify Web API using a single long-lived refresh token bound to one personal account, reads the currently playing track, adds it to Liked Songs in an idempotent (add-only) manner, and returns a human-readable Traditional Chinese status message for the Shortcut to display as a notification.

The design is intentionally minimal: personal single-account use only, no multi-user OAuth, and no per-user isolation. All secrets are stored in Cloudflare Worker Secrets.

## Glossary

- **Action_Button**: The programmable hardware button on the iPhone that the user presses to start the flow.
- **Shortcut**: The iOS Shortcuts automation bound to the Action Button that sends an HTTP request to the Worker and displays the returned message as a notification.
- **Worker**: The Cloudflare Worker service that receives the Shortcut request, calls the Spotify Web API, and returns a status message. This is the primary system under specification.
- **Spotify_API**: The Spotify Web API used to read the currently playing track and modify the user's library, via the currently-recommended endpoints for each operation (for example, the `/me/library` endpoints for saving and checking saved status).
- **Liked_Songs**: The user's saved-tracks library in Spotify (the "Liked Songs" collection).
- **Refresh_Token**: The single long-lived OAuth refresh token bound to one Spotify account, used to obtain fresh access tokens.
- **Access_Token**: A short-lived OAuth token obtained by exchanging the Refresh_Token, used to authorize Spotify_API calls.
- **Worker_Secrets**: Cloudflare Worker Secrets storage (via `wrangler secret`) holding the Spotify client id, client secret, Refresh_Token, and Shared_Secret.
- **Current_Track**: The track Spotify reports as currently playing for the bound account.
- **Setup_Operator**: The person performing the one-time setup (registering the Spotify app, obtaining the initial Refresh_Token, and setting Worker_Secrets).
- **Shared_Secret**: A high-entropy value known only to the Worker and the Shortcut, presented by the Shortcut on every request and verified by the Worker before any Spotify_API call is made.
- **Authorized_Request**: A request received by the Worker that presents the correct Shared_Secret.

## Requirements

### Requirement 1: Save the currently playing track on button press

**User Story:** As the account owner, I want a single Action Button press to save the currently playing song to my Liked Songs, so that I can like tracks without unlocking my phone or opening Spotify.

#### Acceptance Criteria

1. WHEN the Worker receives an Authorized_Request from the Shortcut, THE Worker SHALL request the Current_Track from the Spotify_API.
2. WHEN the Spotify_API reports a Current_Track, THE Worker SHALL add the Current_Track to Liked_Songs.
3. WHEN the Worker adds the Current_Track to Liked_Songs, THE Worker SHALL return a Traditional Chinese success message containing the track name and artist name in the format "已加入喜愛：<歌名> - <歌手>".
4. WHEN the Spotify_API reports that no track is currently playing, THE Worker SHALL return the Traditional Chinese message "目前沒有播放中的歌曲".
5. WHEN the Spotify_API reports a Current_Track that has no addable track identifier (a podcast episode or a local file), THE Worker SHALL return a Traditional Chinese message indicating that the currently playing content cannot be added to Liked_Songs, and SHALL NOT call the Spotify_API to modify Liked_Songs.

### Requirement 2: Idempotent add-only behavior for repeated presses

**User Story:** As the account owner, I want repeated presses to be harmless, so that liking an already-liked song never removes it.

#### Acceptance Criteria

1. WHERE the Current_Track is already present in Liked_Songs, THE Worker SHALL keep the Current_Track in Liked_Songs.
2. WHEN the Worker processes a Current_Track that is already in Liked_Songs, THE Worker SHALL return a Traditional Chinese success message containing the track name and artist name.
3. THE Worker SHALL perform an add-only operation and SHALL NOT remove any track from Liked_Songs.

### Requirement 3: Automatic Spotify authentication via refresh token

**User Story:** As the account owner, I want the Worker to authenticate to Spotify automatically, so that I never re-authorize during normal use.

#### Acceptance Criteria

1. WHEN the Worker needs to call the Spotify_API, THE Worker SHALL exchange the Refresh_Token for a fresh Access_Token using the OAuth refresh-token grant.
2. THE Worker SHALL read the Spotify client id, Spotify client secret, and Refresh_Token from Worker_Secrets.
3. THE Worker SHALL request the OAuth scopes user-read-currently-playing, user-read-playback-state, user-library-modify, and user-library-read.
4. WHEN the Worker adds the Current_Track to Liked_Songs, THE Worker SHALL use the current Spotify library-save endpoint (`PUT /me/library`) rather than a deprecated equivalent.
5. WHERE the Worker checks whether the Current_Track is already saved, THE Worker SHALL use the user-library-read scope and the current Spotify library-check endpoint (`GET /me/library/contains`) rather than a deprecated equivalent to query saved status from the Spotify_API.

### Requirement 4: Traditional Chinese status notifications for every outcome

**User Story:** As the account owner, I want clear notifications for every outcome, so that I know what happened after each press.

#### Acceptance Criteria

1. THE Worker SHALL return a human-readable Traditional Chinese message in every response for the Shortcut to display as a notification.
2. IF the Spotify_API returns an authentication or authorization error, THEN THE Worker SHALL return a Traditional Chinese error message indicating that authentication failed.
3. IF the Spotify_API returns an error other than authentication or authorization, THEN THE Worker SHALL return a Traditional Chinese error message indicating that the request could not be completed.
4. IF the Worker cannot reach the Spotify_API, THEN THE Worker SHALL return a Traditional Chinese error message indicating a connection failure.

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

### Requirement 6: Documented one-time setup procedure

**User Story:** As the Setup_Operator, I want documented one-time setup steps, so that I can provision the Worker before first use.

#### Acceptance Criteria

1. THE project README SHALL document registration of a Spotify application to obtain a client id and client secret.
2. THE project README SHALL document the one-time procedure to obtain the initial Refresh_Token using the OAuth authorization-code flow with the required scopes.
3. THE project README SHALL document setting the Spotify client id, Spotify client secret, Refresh_Token, and Shared_Secret as Worker_Secrets using `wrangler secret`.
4. THE project README SHALL document configuring the Shortcut to send an HTTP request to the Worker endpoint with the Shared_Secret and display the returned message as a notification.

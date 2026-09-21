# Requirements Document

## Introduction

This feature extends the existing `spotify-like-action-button` Worker so that a Spotify-issued replacement `refresh_token` is captured and persisted across invocations, rather than discarded. The original design read the Refresh_Token exclusively from a fixed Worker Secret on every invocation; because Spotify may return a new `refresh_token` alongside an `access_token` on any token-exchange call, and because this button is pressed infrequently, the original Refresh_Token risks going stale from lack of rotation. This feature adds a Cloudflare Workers KV-backed persistence layer so the Worker prefers the most recently rotated Refresh_Token, falling back to the original Worker Secret value when KV has none, and keeps the Setup_Operator informed when rotation cannot be completed.

This feature does not change the core "press button, save track" behavior specified in `spotify-like-action-button`; it only changes where the Refresh_Token used for each token exchange comes from, and adds observability and fallback behavior around that change.

## Glossary

Terms below extend the glossary in `.kiro/specs/spotify-like-action-button/requirements.md`. All terms defined there (Worker, Spotify_API, Refresh_Token, Access_Token, Worker_Secrets, Shared_Secret, Authorized_Request, Setup_Operator, etc.) apply unchanged unless restated here.

- **Token_Store**: A Cloudflare Workers KV namespace bound to the Worker, used to persist the most recently rotated Refresh_Token and its rotation timestamp.
- **Rotated_Refresh_Token**: A `refresh_token` value returned by the Spotify_API in a token-exchange response, distinct from the Refresh_Token the Worker used to make that request.
- **Effective_Refresh_Token**: The Refresh_Token value the Worker actually uses for a given token exchange: the value read from Token_Store if present, otherwise the value from Worker_Secrets.
- **Rotation_Timestamp**: The time at which the Worker last successfully persisted a Rotated_Refresh_Token to Token_Store.
- **Rotation_Failure**: An attempt by the Worker to persist a Rotated_Refresh_Token to Token_Store that did not succeed.

## Requirements

### Requirement 1: Persist a rotated refresh token

**User Story:** As the account owner, I want the Worker to keep using Spotify's latest refresh token automatically, so that the button keeps working for months without me manually re-authorizing.

#### Acceptance Criteria

1. WHEN a token-exchange response from the Spotify_API includes a `refresh_token` field, THE Worker SHALL treat its value as a Rotated_Refresh_Token.
2. WHEN the Worker obtains a Rotated_Refresh_Token, THE Worker SHALL persist it to Token_Store, replacing any previously stored value.
3. WHEN the Worker persists a Rotated_Refresh_Token to Token_Store, THE Worker SHALL also persist a Rotation_Timestamp recording the time of that write.
4. WHEN a token-exchange response from the Spotify_API does not include a `refresh_token` field, THE Worker SHALL continue using the Effective_Refresh_Token from that exchange and SHALL NOT modify Token_Store.

### Requirement 2: Read the effective refresh token with fallback

**User Story:** As the account owner, I want the Worker to automatically use whichever refresh token is current, so that I don't have to track which one is valid.

#### Acceptance Criteria

1. WHEN the Worker needs a Refresh_Token for a token exchange, THE Worker SHALL read Token_Store first.
2. IF Token_Store holds a Refresh_Token value, THEN THE Worker SHALL use that value as the Effective_Refresh_Token for the token exchange.
3. IF Token_Store holds no Refresh_Token value, THEN THE Worker SHALL use the Refresh_Token from Worker_Secrets as the Effective_Refresh_Token for the token exchange.
4. THE Worker SHALL NOT modify the Refresh_Token value stored in Worker_Secrets.

### Requirement 3: Do not block the primary action on rotation failure

**User Story:** As the account owner, I want a Spotify library update to succeed even if the token-bookkeeping step fails, so that a storage hiccup never costs me a like I actually pressed the button for.

#### Acceptance Criteria

1. WHEN the Worker's attempt to persist a Rotated_Refresh_Token to Token_Store does not succeed, THE Worker SHALL classify this as a Rotation_Failure and SHALL continue the current request's orchestration using the Access_Token already obtained.
2. THE Worker SHALL NOT let a Rotation_Failure change the outcome of the current request's Spotify library operation (add-to-Liked_Songs, nothing-playing, or not-addable).
3. WHEN a Rotation_Failure occurs during a request that otherwise results in the track being added to Liked_Songs, THE Worker SHALL append a warning notice to the success message returned to the Shortcut, indicating that the track was saved but the token update failed.
4. WHEN a Rotation_Failure occurs, THE Worker SHALL keep the response's `ok` field `true` and the HTTP status `200` if the underlying Spotify operation succeeded, consistent with the existing outcome-to-status mapping in the base feature's design.
5. THE Worker SHALL log a Rotation_Failure using the same logging constraints as the base feature (no secret, token, header, or body content in the log line).

### Requirement 4: Report exhausted refresh tokens as an authentication failure

**User Story:** As the account owner, I want a fully expired authorization to produce the same clear message I already understand, so that I know to redo setup without learning a new failure category.

#### Acceptance Criteria

1. WHEN the Spotify_API rejects a token exchange made with the Effective_Refresh_Token (from either Token_Store or Worker_Secrets) with an authentication or authorization error, THE Worker SHALL classify the outcome as `auth_failed`, using the same Traditional Chinese message the base feature already returns for that outcome.
2. THE Worker SHALL NOT introduce a distinct outcome, message, or HTTP status for a token-exchange rejection caused specifically by an exhausted or revoked Rotated_Refresh_Token; it SHALL be indistinguishable, from the Shortcut's perspective, from any other `auth_failed` case in the base feature.

### Requirement 5: Local development requires no additional KV setup

**User Story:** As a developer, I want `wrangler dev` to work out of the box, so that adding this feature doesn't add a manual provisioning step to local development.

#### Acceptance Criteria

1. THE project SHALL configure the Token_Store KV binding in `wrangler.toml` such that `wrangler dev` uses Wrangler's local KV simulation automatically, without requiring the developer to create or bind a real Cloudflare KV namespace for local development.
2. THE project README SHALL state that local development relies on Wrangler's default local KV simulation and requires no additional setup beyond what the base feature's local development instructions already require.

### Requirement 6: Deploy-time KV provisioning

**User Story:** As the Setup_Operator, I want documented steps to provision the KV namespace, so that I can deploy this feature to a real Worker.

#### Acceptance Criteria

1. THE project README SHALL document creating a Cloudflare KV namespace for Token_Store.
2. THE project README SHALL document binding the created KV namespace to the Worker in `wrangler.toml` (or documenting the equivalent `wrangler` command) before running `wrangler deploy`.
3. THE Worker SHALL function using only the Refresh_Token from Worker_Secrets, per the base feature's existing behavior, on the first deployment before any rotation has occurred (i.e., before Token_Store holds a value).

### Requirement 7: Secrets and rotation state never escape the Worker

**User Story:** As the account owner, I want the rotation mechanism to uphold the same secrecy guarantees as the rest of the Worker, so that adding persistence doesn't create a new leak surface.

#### Acceptance Criteria

1. THE Worker SHALL NOT include any Refresh_Token value (from Worker_Secrets or Token_Store), Rotated_Refresh_Token value, or Rotation_Timestamp in any HTTP response body or response header.
2. THE Worker SHALL NOT log any Refresh_Token value or Rotated_Refresh_Token value; a log line MAY record that a rotation occurred or failed, and MAY record the Rotation_Timestamp, but MUST NOT record the token value itself.

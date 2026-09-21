// Message catalog per the design's "Error Handling and Message Mapping"
// section. Every non-success Outcome kind maps to exactly one Traditional
// Chinese string here, and the catalog is exported as an enumerable
// collection so tests can assert that a given message is a member of it
// (Requirement 4.1 / Property 9).
//
// The success case has no fixed string — it is a template instantiated with
// the track's name and artist — so it gets a formatter instead of a catalog
// entry.

import type { Outcome } from "./types";

/**
 * Outcome kinds that carry a fixed Chinese message. This excludes "added"
 * (templated, see formatAddedMessage) and the two routing outcomes
 * "not_found" and "method_not_allowed", which are not part of this table.
 */
type MessageOutcomeKind = Exclude<
  Outcome["kind"],
  "added" | "not_found" | "method_not_allowed"
>;

export const MESSAGES: Record<MessageOutcomeKind, string> = {
  nothing_playing: "目前沒有播放中的歌曲",
  not_addable: "目前播放的內容無法加入喜愛",
  auth_failed: "Spotify 授權已失效，請重新取得授權",
  api_failed: "操作未完成，請稍後再試",
  network_failed: "無法連線到 Spotify，請檢查網路連線",
  misconfigured: "伺服器設定不完整，請檢查 Worker 設定",
  unauthorized: "未授權的請求",
};

/** The catalog as an enumerable collection, for membership assertions. */
export const MESSAGE_CATALOG: readonly string[] = Object.values(MESSAGES);

/**
 * Fixed suffix appended to the success message when a Spotify-issued
 * replacement refresh token could not be persisted to Token_Store. See
 * design.md's "src/messages.ts — addition" section (Requirement 3.3).
 */
const ROTATION_FAILED_SUFFIX = "（但 token 更新失敗，請留意）";

/**
 * Formats the success message for an added track:
 * `已加入喜愛：<歌名> - <歌手>`
 *
 * When `options.rotationFailed` is true, appends a fixed warning suffix so
 * the caller knows the like succeeded but the refresh-token rotation did
 * not persist. The existing single-argument call shape is unaffected.
 */
export function formatAddedMessage(
  track: { name: string; artist: string },
  options?: { rotationFailed?: boolean },
): string {
  const base = `已加入喜愛：${track.name} - ${track.artist}`;
  return options?.rotationFailed ? `${base}${ROTATION_FAILED_SUFFIX}` : base;
}

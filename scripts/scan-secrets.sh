#!/usr/bin/env bash
# Credential scanner, per design.md's "Security Considerations" point 6
# ("CI greps the tree for credential-shaped literals") and the Testing
# Strategy's "CI step grepping the tree for hardcoded credential literals
# and for a committed `.dev.vars`" (requirement 5.3).
#
# Fails (non-zero exit) if:
#   1. `.dev.vars` is tracked by git (staged or committed) — a committed
#      `.dev.vars` is exactly the leak this script exists to catch.
#   2. Any git-tracked file contains a credential-shaped literal: an
#      assignment of one of the Spotify secret keys (or a generic
#      SECRET/TOKEN/PASSWORD-shaped key) to a long, high-entropy-looking
#      string literal.
#
# Exits 0 on a clean tree. Intended to be run identically in CI and locally
# via `npm run scan-secrets`.

set -euo pipefail

# Run from the repo root regardless of the caller's cwd.
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${repo_root}" ]]; then
  echo "scan-secrets: not inside a git repository" >&2
  exit 1
fi
cd "${repo_root}"

failed=0

# --- Check 1: .dev.vars must never be tracked -------------------------------
tracked_dev_vars="$(git ls-files -- '.dev.vars' || true)"
if [[ -n "${tracked_dev_vars}" ]]; then
  echo "scan-secrets: FAIL - '.dev.vars' is tracked by git." >&2
  echo "  '.dev.vars' holds real local secrets and must stay git-ignored." >&2
  echo "  Run: git rm --cached .dev.vars" >&2
  failed=1
fi

# --- Check 2: credential-shaped literals in tracked files -------------------
# Build the list of tracked files to scan, excluding this script itself
# (it legitimately mentions secret key names) and the documented example
# file (which intentionally lists the keys with empty values).
mapfile -d '' -t tracked_files < <(
  git ls-files -z -- \
    ':!:scripts/scan-secrets.sh' \
    ':!:.dev.vars.example'
)

# Pattern: one of the known secret env-var names (or a generic
# SECRET/TOKEN/PASSWORD/API_KEY-shaped identifier), assigned via `=`, `:`,
# or `: "..."` (JSON/TOML/YAML/JS/TS), to a quoted value that looks like a
# real credential — 16+ chars of base64url-ish content. This intentionally
# does not match empty strings (`""`, `''`) or short placeholders.
credential_pattern='(SPOTIFY_CLIENT_ID|SPOTIFY_CLIENT_SECRET|SPOTIFY_REFRESH_TOKEN|SHORTCUT_SECRET|[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*)[[:space:]]*[:=][[:space:]]*[\"'"'"'][A-Za-z0-9_.\-]{16,}[\"'"'"']'

matches=""
if [[ "${#tracked_files[@]}" -gt 0 ]]; then
  if matches="$(grep -InE "${credential_pattern}" "${tracked_files[@]}" 2>/dev/null)"; then
    :
  fi
fi

if [[ -n "${matches}" ]]; then
  echo "scan-secrets: FAIL - credential-shaped literal(s) found in tracked files:" >&2
  echo "${matches}" >&2
  echo "  Secrets belong only in Worker Secrets (wrangler secret put) or a" >&2
  echo "  git-ignored '.dev.vars'. Remove the literal value and re-run." >&2
  failed=1
fi

if [[ "${failed}" -ne 0 ]]; then
  exit 1
fi

echo "scan-secrets: OK - no committed .dev.vars and no credential-shaped literals found."
exit 0

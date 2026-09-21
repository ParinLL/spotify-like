// Node-native tests for scripts/scan-secrets.sh (run via `npm run
// test:scan-secrets`, using Node's built-in test runner rather than
// vitest). This script shells out to `git` and reads the filesystem, which
// the Cloudflare Workers vitest pool cannot do (no node:child_process /
// unrestricted node:fs in that runtime) — see design.md's Testing
// Strategy: everything else in this project runs through the real
// `workerd` runtime via @cloudflare/vitest-pool-workers, but this one
// script is a plain Node/bash tool with no Worker-runtime dependency, so
// it is tested with plain Node instead of being forced into that pool.
//
// Regression coverage: the scanner's original credential pattern matched
// any 16+ character value assigned to a SECRET/TOKEN-shaped key, which
// produced false positives on readable hyphenated test placeholders (e.g.
// "test-shortcut-secret", "bootstrap-refresh-token") used throughout
// test/. The fix requires the matched value to be an unbroken run of
// alphanumeric characters, which real credentials are and hyphenated
// placeholder phrases are not.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT_PATH = join(__dirname, "../scan-secrets.sh");

let repoDir;

function git(args) {
  execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
}

function runScanner() {
  try {
    const stdout = execFileSync("bash", [SCAN_SCRIPT_PATH], {
      cwd: repoDir,
      encoding: "utf-8",
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      exitCode: error.status,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "scan-secrets-test-"));
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("scan-secrets.sh", () => {
  it("passes on a clean tree with no tracked files", () => {
    writeFileSync(join(repoDir, "README.md"), "# empty repo\n");
    git(["add", "README.md"]);

    const result = runScanner();

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /OK/);
  });

  it("fails when a real credential-shaped literal is committed", () => {
    writeFileSync(
      join(repoDir, "leak.ts"),
      'const SPOTIFY_CLIENT_SECRET = "abcdEFGH12345678ijklMNOP";\n',
    );
    git(["add", "leak.ts"]);

    const result = runScanner();

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /credential-shaped literal/);
    assert.match(result.stderr, /SPOTIFY_CLIENT_SECRET/);
  });

  it("fails when .dev.vars itself is tracked", () => {
    writeFileSync(join(repoDir, ".dev.vars"), "SPOTIFY_CLIENT_ID=abc\n");
    git(["add", ".dev.vars"]);

    const result = runScanner();

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /\.dev\.vars/);
    assert.match(result.stderr, /tracked by git/);
  });

  it("does not flag readable hyphenated test placeholders", () => {
    const fixture = [
      'const SHORTCUT_SECRET = "test-shortcut-secret";',
      'const env = { SPOTIFY_REFRESH_TOKEN: "bootstrap-refresh-token" };',
      'const other = { SHORTCUT_SECRET: "irrelevant-for-this-test" };',
      'const kv = "kv-stored-refresh-token";',
    ].join("\n");
    writeFileSync(join(repoDir, "placeholder.spec.ts"), fixture);
    git(["add", "placeholder.spec.ts"]);

    const result = runScanner();

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /OK/);
  });

  it("does not flag empty-value placeholders (.dev.vars.example style)", () => {
    writeFileSync(
      join(repoDir, ".dev.vars.example"),
      "SPOTIFY_CLIENT_ID=\nSPOTIFY_CLIENT_SECRET=\nSHORTCUT_SECRET=\n",
    );
    git(["add", ".dev.vars.example"]);

    const result = runScanner();

    assert.equal(result.exitCode, 0);
  });

  it("still flags a credential-shaped literal in a TOML/YAML-style unquoted-key file", () => {
    // The scanner's pattern matches `KEY = "value"` / `KEY: "value"` (an
    // unquoted key, as in .toml/.yaml/.env-style files and plain JS/TS
    // object literals) but NOT a JSON-style `"KEY": "value"` with the key
    // itself quoted — that's a known gap in the current pattern, not
    // something this fix touches. This test locks in the supported case.
    writeFileSync(
      join(repoDir, "config.toml"),
      'SHORTCUT_SECRET = "aVeryRealLooking12345token67890Value"\n',
    );
    git(["add", "config.toml"]);

    const result = runScanner();

    assert.notEqual(result.exitCode, 0);
  });
});

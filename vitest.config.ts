import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// Runs tests against the real `fetch` handler inside `workerd`, using the
// same wrangler configuration the Worker deploys with, rather than a mock
// of the runtime. See design.md "Testing Strategy".
//
// @cloudflare/vitest-pool-workers 0.13+ replaced the old
// `defineWorkersConfig({ test: { poolOptions: { workers: {...} } } })` shape
// with a Vite plugin, `cloudflareTest(...)`, taking the same options
// directly. See:
// https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    // scripts/__tests__ holds Node-native tests for scripts/scan-secrets.sh
    // (run separately via `npm run test:scan-secrets`, using Node's own
    // test runner) — that script shells out to `git` and touches the
    // filesystem in ways the Workers runtime doesn't support, so it is
    // excluded from the Workers-pool test run here.
    exclude: [...configDefaults.exclude, "scripts/__tests__/**"],
    // Every property test drives real workerd + real (local-simulation) KV
    // for a 100-run fast-check floor, so per-test wall time is dominated by
    // the host's speed rather than by the assertions. GitHub's hosted
    // runners finish the whole suite in ~40s; a self-hosted Gitea act_runner
    // measured 6x slower on identical code (256s of test time), with the
    // heaviest property taking 57s on its own — well past vitest's 5s
    // default. Raised globally rather than per test: the slowness is
    // environmental, not specific to any one property, and per-test
    // overrides would silently cap below this floor.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});

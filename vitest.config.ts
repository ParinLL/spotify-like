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
  },
});

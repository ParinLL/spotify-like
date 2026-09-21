import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
  },
});

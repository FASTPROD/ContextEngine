import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "server/src/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // Every test file gets a throwaway ~/.contextengine: no test may touch the real store or
    // the real audit log (30 fake community.sync_error rows landed there on 2026-09-05).
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    testTimeout: 10000,
  },
});

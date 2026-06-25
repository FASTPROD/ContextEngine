import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "server/src/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 10000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    // Integration tests need Postgres; run them with `pnpm test:integration`.
    exclude: ["**/node_modules/**", "**/*.int.test.ts"],
  },
});

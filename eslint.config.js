import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/node_modules/", "**/dist/", "**/coverage/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Money must never pass through floating-point parsing; see packages/contracts/src/money.ts.
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "parseFloat", message: "Parse money with majorToMinor from @sentinel/contracts." }],
      "no-restricted-properties": ["error", { object: "Number", property: "parseFloat", message: "Parse money with majorToMinor from @sentinel/contracts." }],
    },
  },
);

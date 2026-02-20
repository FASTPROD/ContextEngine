import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "server/", "examples/", "defaults/", "skills/", "tests/"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Relax some rules for pragmatic TypeScript
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-function": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  // CLI files legitimately use console.log for user output
  {
    files: ["src/cli.ts", "src/test.ts"],
    rules: {
      "no-console": "off",
    },
  }
);

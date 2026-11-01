// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "data/"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Bug classes this codebase has actually had: unhandled async work and dropped errors.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      // Third-party JSON (YouTube) is untyped by nature; parsers validate it explicitly.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // node:test's test()/describe() return promises the runner tracks itself.
    files: ["src/**/*.test.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    files: ["../frontend/public/*.js"],
    languageOptions: { globals: { document: "readonly", window: "readonly", HTMLInputElement: "readonly", HTMLButtonElement: "readonly" } },
  },
);

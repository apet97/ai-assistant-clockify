// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "vendor/**", "src/ui/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The async-safety core — these stay ERROR (the reason this gate exists):
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      // Boundary `any` is intentional in places (untyped Clockify rows) — warn, don't block:
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      // Intentional `_`-prefixed destructures/params (e.g. `const { x, ...rest }`
      // drops, the Express error-middleware `_next`) are deliberate — honour the
      // underscore convention instead of forcing churn:
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Pure-stylistic rules new in the eslint v10 / recommended-type-checked set —
      // NOT the async-safety core this gate exists for. Off to keep the bar
      // "small, high-signal" without churning unrelated code:
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "preserve-caught-error": "off",
      // Possibly-real correctness smells — kept VISIBLE as warnings (don't block the
      // gate, but don't hide them either):
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/unbound-method": "warn",
    },
  },
);

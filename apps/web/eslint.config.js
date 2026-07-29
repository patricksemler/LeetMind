import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Flat ESLint config for the frontend.
 *
 * Deliberately NOT type-aware: `recommendedTypeChecked` would need a program per run and turns a
 * whole-repo lint into a multi-minute job. The rules that earn their place here are the ones that
 * catch real mistakes without needing types.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/__snapshots__/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    rules: {
      // Underscore prefix is the existing convention for a deliberately-unused binding.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-console": "error",
    },
  },

  // Browser code.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-console": "error",

      // These compiler-aware rules guard state and event lifecycles that previously regressed in
      // the workspace and SSE hook. Keep them blocking now that those paths are covered.
      "react-hooks/refs": "error",
      "react-hooks/immutability": "error",
      "react-hooks/set-state-in-effect": "error",
    },
  },

  // Tests: fixtures and mocks legitimately need shapes the production rules discourage.
  {
    files: ["**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // A `let x = null` declared before a try block and assigned inside it reads as a useless
      // assignment to this rule, but the initializer is what makes tsc treat `x` as definitely
      // assigned after the try/finally. Removing it satisfies the linter and breaks the typecheck.
      "no-useless-assignment": "off",
    },
  },
);

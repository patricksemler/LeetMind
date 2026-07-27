import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Flat ESLint config for the TypeScript workspace. The Python content plane is linted separately
 * by ruff (see content/pyproject.toml).
 *
 * Deliberately NOT type-aware: `recommendedTypeChecked` would need a program per package and turns
 * a whole-repo lint into a multi-minute job. The rules that earn their place here are the ones that
 * catch real mistakes without needing types.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/__snapshots__/**",
      "apps/web/test-results/**",
      "apps/web/playwright-report/**",
      "packages/sandbox/runners/**",
      "content/**",
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
      // Underscore prefix is the existing convention for a deliberately-unused binding
      // (e.g. `_deps` on route registrars that must match a shared signature).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Services log through pino (@leetmind/shared's createLogger), never console — see
      // CONTRACTS.md §1. CLIs and the dev-only mock server opt out below.
      "no-console": "error",
    },
  },

  // Browser code.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-console": "error",

      // eslint-plugin-react-hooks v7 turns on the React Compiler rule set. These three fire on
      // working, shipped code in useSubmissionEvents.ts and Problem.tsx — the SSE lifecycle and the
      // submission state machine, which are the two most delicate files in the app and the ones
      // with the least test coverage. Satisfying them means real behaviour changes (restructuring
      // effects and ref access), not a lint tidy-up, so they are warnings here: the signal stays
      // visible without blocking CI on a refactor that needs tests written first.
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },

  // Standalone CLIs and dev tooling: stdout/stderr IS their interface, so console is correct here.
  {
    files: [
      "scripts/**/*.ts",
      "apps/judge/src/rejudge.ts",
      "packages/sandbox/src/cli.ts",
      "apps/web/mock/**/*.ts",
      "packages/db/src/migrate.ts",
    ],
    rules: { "no-console": "off" },
  },

  // Tests: fixtures and mocks legitimately need shapes the production rules discourage.
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}", "apps/web/e2e/**/*.ts"],
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

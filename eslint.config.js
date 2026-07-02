// ESLint flat config for octopus-runtime.
//
// Pragmatic, NON type-checked ruleset: typescript-eslint's `recommended`
// layered on `eslint:recommended`. The codebase already passes
// `tsc --strict --noEmit`, so the type system covers the heavy correctness
// checks; ESLint catches the lint-class problems tsc does not (unused
// locals/imports, accidental constant conditions, etc.). Kept non-type-checked
// so lint stays fast and false-positive-free.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ],
      "prefer-const": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-console": "off",
      // `any` appears only at well-considered boundaries (the built-in schema's
      // internal casts). tsc --strict gates the rest.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off"
    }
  },
  {
    // Tests and the CLI/examples legitimately assert on fixtures and log.
    files: ["test/**/*.ts", "examples/**/*.ts", "src/cli.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off"
    }
  }
);

import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist/**", "dist-e2e/**", "test-results/**", "playwright-report/**"]),
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    // Listed one by one rather than taken from the plugin's preset, which
    // gains rules from one release to the next: these are the ones the
    // project was already held to.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/static-components": "error",
      "react-hooks/use-memo": "error",
      "react-hooks/preserve-manual-memoization": "error",
      "react-hooks/incompatible-library": "warn",
      "react-hooks/immutability": "error",
      "react-hooks/globals": "error",
      "react-hooks/refs": "error",
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/error-boundaries": "error",
      "react-hooks/purity": "error",
      "react-hooks/set-state-in-render": "error",
      "react-hooks/unsupported-syntax": "warn",
      "react-hooks/config": "error",
      "react-hooks/gating": "error",
    },
  },
]);

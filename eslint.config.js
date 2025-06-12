import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginReactConfig from "eslint-plugin-react/configs/recommended.js";
import { fixupConfigRules } from "@eslint/compat";
import ignorefile from "ignore";
import eslintConfigPrettier from "eslint-config-prettier";

const ignoreList = ignorefile()
  .add("eslint.config.js")
  .add("vite.config.js")
  .add("src/scripts/sample_pipelines/**")
  .createFilter();

export default [
  eslintConfigPrettier,
  {
    files: ["**/*.{ts,jsx,tsx}"].filter(ignoreList),
  },
  {
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        moduleResolution: "nodenext",
      },
    },
  },

  // Node backend
  {
    files: ["src/**/*.ts", "!src/client/**/*"].filter(ignoreList),
    rules: {
      ...pluginJs.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
    },
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },

  // React frontend
  {
    files: ["src/client/**/*"].filter(ignoreList),
    rules: {
      ...tseslint.configs.recommended.rules,
      ...fixupConfigRules(pluginReactConfig).rules,
    },
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: "./src/client/tsconfig.json",
        ecmaFeatures: { jsx: true },
      },
    },
  },
];

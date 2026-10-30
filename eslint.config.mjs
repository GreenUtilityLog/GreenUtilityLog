// Catches what a build does not: a name used but never defined. Vite bundles such
// code happily and it only fails in the browser, on the screen that uses it — which
// is how a removed handler took the Meter screen down. CI installs these plugins on
// the fly (server-tests.yml, job "app"); they are not app dependencies.
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [{
  files: ["src/**/*.{js,jsx}"],
  plugins: { react, "react-hooks": reactHooks },
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: { ...globals.browser },
  },
  rules: {
    "no-undef": "error",
    "react/jsx-no-undef": "error",
    "react/jsx-uses-vars": "error",
  },
}];

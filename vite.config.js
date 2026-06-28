import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  base: '/GreenUtilityLog/',
  // Don't copy a public/ folder. We don't ship static assets that way, and on
  // GitHub an accidental FILE named "public" (instead of a folder) makes Vite
  // crash with "ENOTDIR: not a directory, scandir public" and fails the build.
  // Disabling publicDir makes the build robust against that.
  publicDir: false,
  // dapp-kit creates valtio proxies (dapp-kit-ui) and subscribes to them
  // (dapp-kit-react). If more than one copy of valtio ends up in the bundle,
  // the proxy isn't recognised by the subscriber and dapp-kit crashes with
  // "Cannot read properties of undefined (reading '3')". Force a single copy.
  resolve: {
    dedupe: ['valtio', 'valtio/vanilla', 'valtio/vanilla/utils'],
  },
  plugins: [
    react(),
    // VeChain libraries (vechain-kit, dapp-kit, sdk-core, WalletConnect)
    // expect Node globals/builtins that don't exist in the browser.
    // Without these the site shows a blank page or "Buffer is not defined".
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  build: {
    outDir: 'dist',
    // Some VeChain/WalletConnect dependencies (e.g. mersenne-twister, used for
    // wallet avatars) are CommonJS modules that are imported from ES modules.
    // Without transformMixedEsModules, Rollup leaves bare `require(...)` calls
    // in the bundle, which throw "require is not defined" in the browser and
    // produce a blank page. This converts those CommonJS requires for the browser.
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
})

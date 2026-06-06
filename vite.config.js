import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  base: '/GreenUtilityLog/',
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
    outDir: 'dist'
  }
})

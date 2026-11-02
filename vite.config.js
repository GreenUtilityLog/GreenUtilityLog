import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// The page's description and link preview mention testnet only on a testnet build
// (VITE_NETWORK, set per build by the deploy; a local build is testnet).
const networkMeta = () => ({
  name: 'network-meta',
  transformIndexHtml(html) {
    const mainnet = process.env.VITE_NETWORK === 'mainnet'
    return html
      .replaceAll('__NETWORK_NOTE__', mainnet ? '' : ' Testnet beta.')
      .replaceAll('__NETWORK_NOTE_OG__', mainnet ? '' : ' Testnet beta — test tokens, no real value.')
  },
})

// The in-browser OCR (tesseract.js) is served from this site, not from a CDN. Its
// loader script could be pinned with SRI, but the worker and the WebAssembly core it
// then fetches could not — and they run as this origin, next to the wallet session.
// Copied from the exact npm versions in package.json into <outDir>/tesseract/.
const selfHostTesseract = () => {
  let outDir = 'dist'
  return {
    name: 'self-host-tesseract',
    configResolved(c) { outDir = c.build.outDir },
    closeBundle() {
      const dest = join(outDir, 'tesseract')
      mkdirSync(dest, { recursive: true })
      for (const f of ['tesseract.min.js', 'worker.min.js']) copyFileSync(join('node_modules/tesseract.js/dist', f), join(dest, f))
      for (const f of readdirSync('node_modules/tesseract.js-core')) {
        if (f.endsWith('.wasm.js')) copyFileSync(join('node_modules/tesseract.js-core', f), join(dest, f))
      }
    },
  }
}

// Content-Security-Policy, as a meta tag (GitHub Pages can't send headers). The part
// that matters is script-src: only this site's own files, the two inline scripts in
// index.html (by hash, computed here so an edit can't silently break them), jsPDF
// from cdnjs (also pinned by SRI) and Cloudflare's captcha. An injected <script> or
// a script from anywhere else is refused. Connections stay open to any https/wss
// host: wallets, nodes and WalletConnect relays vary per user and per network.
// Build only — the dev server injects inline scripts of its own.
const contentSecurityPolicy = () => ({
  name: 'content-security-policy',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
      const policy = [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')} https://cdnjs.cloudflare.com https://challenges.cloudflare.com 'wasm-unsafe-eval'`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' data: blob: https: wss:",
        "frame-src https:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
      return html.replace('<meta charset="UTF-8">', `<meta charset="UTF-8">\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`)
    },
  },
})

// Whether a module is reached from the entry through static imports only.
const startCache = new Map()
function loadedAtStart(id, getModuleInfo, seen = new Set()) {
  if (startCache.has(id)) return startCache.get(id)
  if (seen.has(id)) return false
  seen.add(id)
  const info = getModuleInfo(id)
  const yes = !!info && (info.isEntry || info.importers.some((i) => loadedAtStart(i, getModuleInfo, seen)))
  if (yes || seen.size === 1) startCache.set(id, yes)
  return yes
}

export default defineConfig({
  // The deploy also builds a test copy under /GreenUtilityLog/testnet/ (VITE_BASE).
  base: process.env.VITE_BASE || '/GreenUtilityLog/',
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
    networkMeta(),
    selfHostTesseract(),
    contentSecurityPolicy(),
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
    rollupOptions: {
      output: {
        // The libraries (wallet kit, WalletConnect, VeChain SDK, React) are ~85% of
        // the download and change only when package.json does. In their own file a
        // deploy of the app's code no longer makes every visitor download them again.
        // Only what the page needs at start: libraries loaded on demand (the
        // WalletConnect dialog, the second curve) stay in their own lazy files.
        manualChunks(id, { getModuleInfo }) {
          if (!id.includes('node_modules')) return undefined
          return loadedAtStart(id, getModuleInfo) ? 'vendor' : undefined
        },
      },
    },
  },
})

import React from 'react'
import ReactDOM from 'react-dom/client'
import { VeChainKitProvider } from '@vechain/vechain-kit'
import App from './App.jsx'

// ════════════════════════════════════════════════════════════════════════════
// WALLETCONNECT PROJECT ID
// ────────────────────────────────────────────────────────────────────────────
// WalletConnect lets people log in from a mobile wallet (or any browser that
// doesn't have the VeWorld extension). It needs a free "project ID".
//
// 👉 HOW TO GET YOURS (takes ~2 minutes, free, no credit card):
//    1. Go to https://cloud.reown.com  (formerly WalletConnect Cloud)
//    2. Sign up / log in and click "Create" → choose a "WalletKit" / AppKit project
//    3. Give it a name (e.g. "Green Utility Log") and copy the "Project ID"
//    4. Paste that ID below, replacing PASTE_WALLETCONNECT_PROJECT_ID_HERE
//
// Until you paste a real ID, desktop VeWorld still works, but WalletConnect
// (mobile) logins will not connect.
// ════════════════════════════════════════════════════════════════════════════
const WALLETCONNECT_PROJECT_ID = 'b1856bbf2965b4ff0b788450c06aba9c'

const APP_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <VeChainKitProvider
      // Run against VeChain main-net (where real B3TR lives).
      network={{ type: 'main' }}
      // Self-custody wallets — this is what makes login work everywhere:
      // VeWorld (extension + in-app browser) and WalletConnect (mobile).
      dappKit={{
        allowedWallets: ['veworld', 'wallet-connect', 'sync2'],
        walletConnectOptions: {
          projectId: WALLETCONNECT_PROJECT_ID,
          metadata: {
            name: 'Green Utility Log',
            description: 'Track utilities and earn B3TR on VeChain',
            url: APP_ORIGIN,
            icons: [`${APP_ORIGIN}/favicon.ico`],
          },
        },
      }}
      // Which buttons show inside the Kit's connect modal.
      // - "dappkit"  → VeWorld / WalletConnect / Sync2 (self-custody)
      // - "vechain"  → free "Login with VeChain" (email/social, no paid account)
      loginMethods={[
        { method: 'vechain', gridColumn: 4 },
        { method: 'dappkit', gridColumn: 4 },
      ]}
      darkMode={false}
      language="en"
    >
      <App />
    </VeChainKitProvider>
  </React.StrictMode>,
)

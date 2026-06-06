import React from 'react'
import ReactDOM from 'react-dom/client'
import { VeChainKitProvider } from '@vechain/vechain-kit'
import App from './App.jsx'

// ════════════════════════════════════════════════════════════════════════════
// WALLETCONNECT PROJECT ID  (free, from https://cloud.reown.com)
// ════════════════════════════════════════════════════════════════════════════
const WALLETCONNECT_PROJECT_ID = 'b1856bbf2965b4ff0b788450c06aba9c'

const APP_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

// ════════════════════════════════════════════════════════════════════════════
// TEMPORARY DIAGNOSTIC — show any startup error ON THE PAGE instead of a blank
// white screen. This block can be removed once the site loads correctly.
// ════════════════════════════════════════════════════════════════════════════
function describeError(err) {
  if (err == null) return 'Onbekende fout (null/undefined)'
  if (typeof err === 'string') return err
  const parts = []
  // Firefox's error.stack does NOT include the name/message, so show it explicitly.
  if (err.name || err.message) {
    parts.push((err.name || 'Error') + ': ' + (err.message || '(geen melding)'))
  } else {
    try { parts.push(JSON.stringify(err)) } catch { parts.push(String(err)) }
  }
  if (err.stack) parts.push('--- stack ---\n' + err.stack)
  return parts.join('\n\n')
}

function showError(label, err) {
  const root = document.getElementById('root')
  if (!root) return
  // Don't overwrite a successfully-rendered app with a late/extension error.
  if (root.dataset.appMounted === '1') return
  const detail = describeError(err)
  root.innerHTML =
    '<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:24px auto;padding:20px;border:2px solid #b00020;border-radius:10px;background:#fff5f5;color:#1a1a1a">' +
    '<h2 style="margin:0 0 8px;color:#b00020">Opstartfout (diagnose)</h2>' +
    '<p style="margin:0 0 12px">' + String(label) + '</p>' +
    '<pre style="white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #f0c0c0;border-radius:6px;padding:12px;margin:0;font:12px/1.4 monospace;color:#b00020">' +
    String(detail).replace(/&/g, '&amp;').replace(/</g, '&lt;') +
    '</pre></div>'
}

window.addEventListener('error', (e) => showError('window.onerror:', e.error || e.message))
window.addEventListener('unhandledrejection', (e) => showError('unhandledrejection:', e.reason))

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error) {
    showError('React render error:', error)
  }
  render() {
    return this.state.error ? null : this.props.children
  }
}

try {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
      <VeChainKitProvider
        network={{ type: 'main' }}
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
        loginMethods={[
          // NOTE: the 'vechain' login method ("Login with VeChain") boots a
          // Privy provider that crashed the page on load
          // (TypeError: can't access property 3, r is undefined). We use only
          // 'dappkit' — VeWorld, WalletConnect (mobile) and Sync2 — which is
          // stable and covers wallet login without Privy.
          { method: 'dappkit', gridColumn: 4 },
        ]}
        darkMode={false}
        language="en"
      >
        <App />
      </VeChainKitProvider>
    </ErrorBoundary>,
  )
  // Mark as mounted shortly after render so late errors don't wipe the app.
  setTimeout(() => {
    const root = document.getElementById('root')
    if (root && root.children.length > 0) root.dataset.appMounted = '1'
  }, 4000)
} catch (err) {
  showError('Crash tijdens opstarten (createRoot/render):', err)
}

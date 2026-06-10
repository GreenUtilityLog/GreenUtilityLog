import React from 'react'
import ReactDOM from 'react-dom/client'
import { DAppKitProvider } from '@vechain/dapp-kit-react'
import App, { ACTIVE_NODE } from './App.jsx'

// ════════════════════════════════════════════════════════════════════════════
// WALLETCONNECT PROJECT ID  (free, from https://cloud.reown.com)
// Enables mobile login: the connect dialog shows a QR code that VeWorld mobile
// (or any WalletConnect wallet) can scan.
// ════════════════════════════════════════════════════════════════════════════
const WALLETCONNECT_PROJECT_ID = 'b1856bbf2965b4ff0b788450c06aba9c'

const APP_ORIGIN =
  typeof window !== 'undefined' ? window.location.origin : 'https://greenutilitylog.github.io'

// ════════════════════════════════════════════════════════════════════════════
// Safety net: if startup ever fails, show the error on the page (not a blank
// white screen) so it can be diagnosed. Harmless when everything works.
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
    // Log for diagnostics. The render below always shows a visible fallback,
    // so a render crash can never leave a blank white screen (regardless of how
    // long after load it happens).
    try { console.error('React render error:', error) } catch {}
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ font: '14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif', maxWidth: 900, margin: '24px auto', padding: 20, border: '2px solid #b00020', borderRadius: 10, background: '#fff5f5', color: '#1a1a1a' }}>
        <h2 style={{ margin: '0 0 8px', color: '#b00020' }}>Er ging iets mis</h2>
        <p style={{ margin: '0 0 12px' }}>De app liep tegen een fout aan. Probeer de pagina te vernieuwen.</p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', border: '1px solid #f0c0c0', borderRadius: 6, padding: 12, margin: 0, font: '12px/1.4 monospace', color: '#b00020' }}>
          {describeError(this.state.error)}
        </pre>
      </div>
    )
  }
}

try {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
      <DAppKitProvider
        // VeChain node — testnet or mainnet, driven by NETWORK in App.jsx.
        node={ACTIVE_NODE}
        // Wallets offered in the connect dialog. 'wallet-connect' = mobile QR.
        allowedWallets={['veworld', 'wallet-connect', 'sync2']}
        // Remember the connection between page loads.
        usePersistence
        // Don't force an identity certificate just to connect; the user signs
        // when they actually submit a transaction.
        requireCertificate={false}
        // Required prop: dapp-kit reads v2Api.enabled internally. Keep the
        // default (false) for the widest wallet compatibility.
        v2Api={{ enabled: false }}
        walletConnectOptions={{
          projectId: WALLETCONNECT_PROJECT_ID,
          metadata: {
            name: 'Green Utility Log',
            description: 'Track utilities and earn B3TR on VeChain',
            url: APP_ORIGIN,
            icons: [`${APP_ORIGIN}/favicon.ico`],
          },
        }}
        language="en"
      >
        <App />
      </DAppKitProvider>
    </ErrorBoundary>,
  )
  setTimeout(() => {
    const root = document.getElementById('root')
    if (root && root.children.length > 0) root.dataset.appMounted = '1'
  }, 4000)
} catch (err) {
  showError('Crash tijdens opstarten (createRoot/render):', err)
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles.css'

// No-ops when service workers are unavailable (plain-HTTP LAN — full
// offline support arrives with HTTPS at M7). autoUpdate: new deploys
// activate on next load without a "refresh?" prompt.
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

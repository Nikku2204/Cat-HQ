import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Dev loop: `npm run dev` proxies API + WS to the backend (Docker or bare
// uvicorn) on :8000 — same-origin from the app's point of view, no CORS.
// Production: the backend serves dist/ itself (backend/Dockerfile stage 1).
const backend = 'http://localhost:8000'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
      manifest: {
        name: 'Cat HQ',
        short_name: 'Cat HQ',
        description: 'Monitor and control the cat devices',
        theme_color: '#fbf6ee',
        background_color: '#fbf6ee',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // photos (login background, ring) are NOT precached — they'd blow the
        // ~300 KB budget and the app needs the backend online anyway, so they
        // load on demand (instant on the LAN) and browser-cache after first use
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/devices/,
          /^\/events/,
          /^\/health/,
          /^\/ws/,
          /^\/docs/,
          /^\/redoc/,
          /^\/openapi/,
        ],
        // No runtimeCaching for the API on purpose: device state must never
        // be served from a cache (fail-loud, 01-ARCHITECTURE.md #4).
        // Offline = precached shell + the app's own offline banner.
      },
    }),
  ],
  server: {
    proxy: {
      '/devices': backend,
      '/events': backend,
      '/care': backend,
      '/health': backend,
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
})

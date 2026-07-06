// Test config is separate from vite.config.ts on purpose: unit tests don't
// want the PWA plugin (service-worker generation) in the pipeline.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true, // also enables testing-library's auto-cleanup between tests
    setupFiles: ['./src/test-setup.ts'],
  },
})

// Loaded once per test file (vitest.config.ts setupFiles).
// The import registers jest-dom matchers on vitest's expect AND, because this
// file is inside tsconfig's include, brings their type augmentation along.
import '@testing-library/jest-dom/vitest'

// Node 26 ships an experimental localStorage global that is undefined unless
// the process runs with --localstorage-file, and under vitest 4 it shadows
// jsdom's Storage — so api.ts's bare `localStorage` crashes in tests. Give
// every test file a real in-memory one (tests may still vi.stubGlobal over it).
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() {
    return this.store.size
  }
  clear() {
    this.store.clear()
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.store.delete(key)
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value))
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  writable: true,
  configurable: true,
})

afterEach(() => {
  localStorage.clear()
})

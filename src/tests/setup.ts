/**
 * Vitest global setup — mocks the @tauri-apps/api runtime so frontend
 * unit tests run in jsdom without a real Tauri process.
 */
import { vi } from 'vitest';

// Mock @tauri-apps/api/core (invoke / listen)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));

// Minimal window.__TAURI__ stub so any direct checks don't throw.
(globalThis as unknown as Record<string, unknown>).__TAURI__ = {};

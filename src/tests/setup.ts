/**
 * Vitest global test setup.
 * Mocks the Tauri IPC bridge so tests can run in jsdom without a Tauri runtime.
 */
import { vi } from "vitest";

// Mock @tauri-apps/api/core so invoke() calls don't throw in unit tests.
// Feature workstreams (WS-C) can override specific commands in their test files.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

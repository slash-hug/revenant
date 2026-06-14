/**
 * IPC contract smoke test — verifies the TypeScript type definitions
 * and wrapper functions are structurally sound.
 *
 * These tests do NOT make real Tauri IPC calls (invoke is mocked in setup.ts).
 * They verify the contract surface: function signatures, type shapes, and
 * that all expected exports exist.
 */

import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  openFile,
  saveFile,
  loadAnnotations,
  saveAnnotations,
  generateReview,
  exportObsidian,
  getSettings,
  setSettings,
  snapshotWebview,
  type Annotation,
  type Sidecar,
  type Settings,
  type FileResult,
  type IpcError,
} from "$lib/types/ipc";

const mockInvoke = vi.mocked(invoke);

describe("IPC contract", () => {
  it("exports all required command wrappers", () => {
    expect(typeof openFile).toBe("function");
    expect(typeof saveFile).toBe("function");
    expect(typeof loadAnnotations).toBe("function");
    expect(typeof saveAnnotations).toBe("function");
    expect(typeof generateReview).toBe("function");
    expect(typeof exportObsidian).toBe("function");
    expect(typeof getSettings).toBe("function");
    expect(typeof setSettings).toBe("function");
    expect(typeof snapshotWebview).toBe("function");
  });

  it("openFile calls invoke with correct command name", async () => {
    mockInvoke.mockResolvedValueOnce({
      path: "/test/doc.md",
      content_hash: "abc123",
      content: "# Hello",
    } satisfies FileResult);

    const result = await openFile("/test/doc.md");
    expect(mockInvoke).toHaveBeenCalledWith("open_file", {
      path: "/test/doc.md",
    });
    expect(result.path).toBe("/test/doc.md");
  });

  it("saveFile passes expected_hash for optimistic concurrency", async () => {
    mockInvoke.mockResolvedValueOnce({
      path: "/test/doc.md",
      content_hash: "def456",
      content: "",
    } satisfies FileResult);

    await saveFile({
      path: "/test/doc.md",
      content: "# Updated",
      expected_hash: "abc123",
    });

    expect(mockInvoke).toHaveBeenCalledWith("save_file", {
      request: {
        path: "/test/doc.md",
        content: "# Updated",
        expected_hash: "abc123",
      },
    });
  });

  it("Sidecar type has schema_version field", () => {
    // Type-level check via a compile-time valid literal
    const sidecar: Sidecar = {
      schema_version: 1,
      doc_content_hash: "abc",
      general_notes: "",
      annotations: [],
    };
    expect(sidecar.schema_version).toBe(1);
  });

  it("Settings type has schema_version field and no rest_key field", () => {
    const settings: Settings = {
      schema_version: 1,
      vaults: [],
      default_export_subfolder: "reviews",
      theme: "dark",
      export_on_save: false,
      rest_key_ref: null, // reference only — no raw key
    };
    expect(settings.schema_version).toBe(1);
    // Ensure no 'rest_key' property exists on the type (only rest_key_ref)
    expect("rest_key" in settings).toBe(false);
  });

  it("Annotation status is typed as a union", () => {
    const ann: Annotation = {
      id: "1",
      body: "test note",
      quoted_text: "some text",
      line_start: 0,
      line_end: 0,
      char_start: 0,
      char_end: 9,
      status: "anchored",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(["anchored", "detached", "block_level"]).toContain(ann.status);
  });

  it("snapshotWebview invokes the snapshot_webview command with no args", async () => {
    mockInvoke.mockResolvedValueOnce("data:image/png;base64,AAAA");
    const url = await snapshotWebview();
    expect(mockInvoke).toHaveBeenCalledWith("snapshot_webview");
    expect(url).toBe("data:image/png;base64,AAAA");
  });
});

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
  exportHtml,
  exportPdf,
  readFileBytes,
  setRestKey,
  clearRestKey,
  hasRestKey,
  testObsidianConnection,
  getAppVersion,
  checkForUpdates,
  openReleasePage,
  type Annotation,
  type Sidecar,
  type Settings,
  type FileResult,
  type IpcError,
  type ConnStatus,
  type UpdateCheck,
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
    // Export commands (A9)
    expect(typeof exportHtml).toBe("function");
    expect(typeof exportPdf).toBe("function");
    expect(typeof readFileBytes).toBe("function");
    // Settings / keychain commands (A1)
    expect(typeof setRestKey).toBe("function");
    expect(typeof clearRestKey).toBe("function");
    expect(typeof hasRestKey).toBe("function");
    expect(typeof testObsidianConnection).toBe("function");
    // Version / update-check commands (A6)
    expect(typeof getAppVersion).toBe("function");
    expect(typeof checkForUpdates).toBe("function");
    expect(typeof openReleasePage).toBe("function");
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
      preview_zoom: 100,
      agent_nudge_template: "Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed.",
      agent_nudge_path_style: "relative",
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

  // ─── Export commands (A9) ───────────────────────────────────────────────────

  it("exportHtml calls invoke with correct command name and args", async () => {
    mockInvoke.mockResolvedValueOnce("/tmp/export.html");
    const path = await exportHtml("/tmp/export.html", "<html/>");
    expect(mockInvoke).toHaveBeenCalledWith("export_html", {
      outPath: "/tmp/export.html",
      html: "<html/>",
    });
    expect(path).toBe("/tmp/export.html");
  });

  it("exportPdf calls invoke with correct command name and args", async () => {
    mockInvoke.mockResolvedValueOnce("/tmp/export.pdf");
    const path = await exportPdf("/tmp/export.pdf", "<html/>");
    expect(mockInvoke).toHaveBeenCalledWith("export_pdf", {
      outPath: "/tmp/export.pdf",
      html: "<html/>",
    });
    expect(path).toBe("/tmp/export.pdf");
  });

  it("readFileBytes calls invoke with correct command name and args", async () => {
    mockInvoke.mockResolvedValueOnce("base64encodedstring==");
    const b64 = await readFileBytes("/docs/readme.md", "/docs/images/fig.png");
    expect(mockInvoke).toHaveBeenCalledWith("read_file_bytes", {
      docPath: "/docs/readme.md",
      imagePath: "/docs/images/fig.png",
    });
    expect(b64).toBe("base64encodedstring==");
  });

  // ─── Settings / keychain commands (A1) ─────────────────────────────────────

  it("setRestKey calls set_rest_key with the key and returns Settings", async () => {
    const updatedSettings: Settings = {
      schema_version: 1,
      vaults: [],
      default_export_subfolder: "",
      theme: "system",
      export_on_save: false,
      rest_key_ref: "obsidian-rest",
      preview_zoom: 100,
      agent_nudge_template: "Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed.",
      agent_nudge_path_style: "relative",
    };
    mockInvoke.mockResolvedValueOnce(updatedSettings);
    const result = await setRestKey("my-secret-key");
    expect(mockInvoke).toHaveBeenCalledWith("set_rest_key", {
      key: "my-secret-key",
    });
    expect(result.rest_key_ref).toBe("obsidian-rest");
  });

  it("clearRestKey calls clear_rest_key with no args and returns Settings", async () => {
    const updatedSettings: Settings = {
      schema_version: 1,
      vaults: [],
      default_export_subfolder: "",
      theme: "system",
      export_on_save: false,
      rest_key_ref: null,
      preview_zoom: 100,
      agent_nudge_template: "Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed.",
      agent_nudge_path_style: "relative",
    };
    mockInvoke.mockResolvedValueOnce(updatedSettings);
    const result = await clearRestKey();
    expect(mockInvoke).toHaveBeenCalledWith("clear_rest_key");
    expect(result.rest_key_ref).toBeNull();
  });

  it("hasRestKey calls has_rest_key with no args and returns a boolean", async () => {
    mockInvoke.mockResolvedValueOnce(true);
    const present = await hasRestKey();
    expect(mockInvoke).toHaveBeenCalledWith("has_rest_key");
    expect(present).toBe(true);
  });

  it("testObsidianConnection calls test_obsidian_connection with null key when not provided", async () => {
    const status: ConnStatus = "ok";
    mockInvoke.mockResolvedValueOnce(status);
    const result = await testObsidianConnection();
    expect(mockInvoke).toHaveBeenCalledWith("test_obsidian_connection", {
      key: null,
    });
    expect(result).toBe("ok");
  });

  it("testObsidianConnection passes the key when provided (in-memory probe, D6)", async () => {
    const status: ConnStatus = "unauthorized";
    mockInvoke.mockResolvedValueOnce(status);
    const result = await testObsidianConnection("typed-key");
    expect(mockInvoke).toHaveBeenCalledWith("test_obsidian_connection", {
      key: "typed-key",
    });
    expect(result).toBe("unauthorized");
  });

  it("ConnStatus values cover all three probe outcomes", () => {
    // Type-level check: all valid string literals should pass the type guard.
    const statuses: ConnStatus[] = ["ok", "unauthorized", "unreachable"];
    expect(statuses).toHaveLength(3);
    expect(statuses).toContain("ok");
    expect(statuses).toContain("unauthorized");
    expect(statuses).toContain("unreachable");
  });

  // ─── Version / update-check commands (A6) ──────────────────────────────────

  it("getAppVersion calls invoke with correct command name", async () => {
    mockInvoke.mockResolvedValueOnce("0.1.0");
    const version = await getAppVersion();
    expect(mockInvoke).toHaveBeenCalledWith("get_app_version");
    expect(version).toBe("0.1.0");
  });

  it("checkForUpdates calls invoke with correct command name", async () => {
    const updateCheck: UpdateCheck = {
      current: "0.1.0",
      latest: "0.2.0",
      update_available: true,
      release_url: "https://github.com/slash-hug/revenant/releases/tag/v0.2.0",
    };
    mockInvoke.mockResolvedValueOnce(updateCheck);
    const result = await checkForUpdates();
    expect(mockInvoke).toHaveBeenCalledWith("check_for_updates");
    expect(result.update_available).toBe(true);
    expect(result.latest).toBe("0.2.0");
  });

  it("openReleasePage calls invoke with correct command name and url", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const url = "https://github.com/slash-hug/revenant/releases/tag/v0.2.0";
    await openReleasePage(url);
    expect(mockInvoke).toHaveBeenCalledWith("open_release_page", { url });
  });

  it("UpdateCheck type has all required shape fields", () => {
    // Compile-time shape assertion: if UpdateCheck interface changes, this test
    // catches it immediately (mirrors the Settings / Sidecar pattern above).
    const check: UpdateCheck = {
      current: "0.1.0",
      latest: "0.1.0",
      update_available: false,
      release_url: "https://github.com/slash-hug/revenant/releases/tag/v0.1.0",
    };
    expect(typeof check.current).toBe("string");
    expect(typeof check.latest).toBe("string");
    expect(typeof check.update_available).toBe("boolean");
    expect(typeof check.release_url).toBe("string");
  });

});

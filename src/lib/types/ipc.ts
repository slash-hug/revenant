/**
 * IPC contract — TypeScript mirror of src-tauri/src/ipc.rs
 *
 * WS-A owns and freezes this surface. Import from here in all frontend code.
 * All invoke() calls should use the typed wrappers at the bottom of this file.
 *
 * Events (subscribed via listen()):
 *   - "open_file_request"  payload: string (file path)
 *   - "file_changed"       payload: { path: string; external: boolean }
 *                          external=false for this process's own save_file writes.
 */

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Shared types — mirrored from Rust ipc.rs
// ---------------------------------------------------------------------------

/** Typed error envelope returned by all IPC commands. */
export interface IpcError {
  /** Machine-readable error code (e.g. "HASH_MISMATCH", "NOT_MARKDOWN", "IO_ERROR"). */
  code: string;
  /** Human-readable description for display. */
  message: string;
}

/** A single annotation anchored to a range in the source document. */
export interface Annotation {
  id: string;
  /** Body text of the annotation. */
  body: string;
  /** Quoted text from the source document at anchor time. */
  quoted_text: string;
  /** Starting line (0-indexed). */
  line_start: number;
  /** Ending line (0-indexed, inclusive). */
  line_end: number;
  /** Starting character offset within line_start. */
  char_start: number;
  /** Ending character offset within line_end. */
  char_end: number;
  /** "anchored" | "detached" | "block_level" */
  status: "anchored" | "detached" | "block_level";
  /** ISO 8601 creation timestamp. */
  created_at: string;
  /** ISO 8601 last-updated timestamp. */
  updated_at: string;
}

/** The sidecar envelope stored next to each document. */
export interface Sidecar {
  /** Always 1 for v1; bump on breaking schema changes. */
  schema_version: 1;
  /** sha256 hex of doc content at last save. */
  doc_content_hash: string;
  /** Freeform general notes persisted separately from anchored annotations. */
  general_notes: string;
  annotations: Annotation[];
}

/** Persisted user settings envelope. */
export interface Settings {
  /** Always 1 for v1; bump on breaking schema changes. */
  schema_version: 1;
  /** Configured Obsidian vault directories. */
  vaults: string[];
  /** Default export subfolder within the vault. */
  default_export_subfolder: string;
  /** UI theme. */
  theme: "dark" | "light" | "system";
  /** Whether to export to Obsidian automatically on save. */
  export_on_save: boolean;
  /**
   * Opaque reference to the keychain entry holding the Obsidian REST key.
   * The actual key is NEVER stored here — only this reference.
   */
  rest_key_ref: string | null;
  /** Preview zoom percentage (50–200). Default 100. */
  preview_zoom: number;
}

/** Response from open_file and save_file. */
export interface FileResult {
  /** Canonical path of the opened/saved file. */
  path: string;
  /** sha256 hex of the file content after the operation. */
  content_hash: string;
  /** File content (UTF-8). Populated on open; empty string on save. */
  content: string;
}

/** Request body for save_file. */
export interface SaveFileRequest {
  path: string;
  content: string;
  /**
   * sha256 hex the caller observed when it last read the file.
   * If the on-disk hash differs, the save is rejected with HASH_MISMATCH.
   */
  expected_hash: string;
}

/** Payload passed to generate_review — formatted by ReviewExporter.ts. */
export interface ReviewPayload {
  /** Canonical doc path — used to name the output file. */
  doc_path: string;
  /** Pre-formatted markdown review body (agent-agnostic, no hardcoded labels). */
  markdown: string;
}

/** Result of generate_review. */
export interface ReviewResult {
  review_path: string;
}

/** Request for Obsidian export. */
export interface ExportObsidianRequest {
  doc_path: string;
  /** Target vault directory (must be in configured vaults list). */
  vault_path: string;
  /** Subfolder within the vault (may be empty). */
  subfolder: string;
}

/** Result of Obsidian export. */
export interface ExportObsidianResult {
  /** "rest" | "filesystem" */
  method: "rest" | "filesystem";
  /** Destination path (filesystem) or URL (REST). */
  destination: string;
}

/**
 * Update-check result returned by checkForUpdates.
 * The Ok variant of the IpcResult — failures become thrown IpcErrors.
 */
export interface UpdateCheck {
  /** Current installed version (e.g. "0.1.0"). */
  current: string;
  /** Latest published version from GitHub Releases. */
  latest: string;
  /** Whether latest is semantically newer than current. */
  update_available: boolean;
  /** URL of the latest GitHub release page. */
  release_url: string;
}

// ---------------------------------------------------------------------------
// Anchor types — used by the annotation UI (C8 / A10)
// ---------------------------------------------------------------------------

/**
 * A source-level anchor produced by the editor (EditorPane / source selection).
 * Line numbers are 0-indexed to match the frozen IPC Annotation contract.
 *
 * NOTE: context_before and context_after have been removed (T1.5/C-IPC-TYPE).
 * Context lines are now derived server-side in the Rust `save_annotations`
 * command (T1.2/A2/A6) and are internal to the re-anchoring engine — they
 * never cross the IPC seam.
 */
export interface SourceAnchor {
  /** 0-indexed starting line. */
  start_line: number;
  /** Character offset within start_line. */
  start_char: number;
  /** 0-indexed ending line (inclusive). */
  end_line: number;
  /** Character offset within end_line. */
  end_char: number;
  /** The exact selected text. */
  quoted_text: string;
}

/**
 * A block-level anchor produced by the preview for transformed blocks
 * (Mermaid diagrams, tables, footnotes) where source character offsets
 * are unavailable (C8 degradation rule).
 */
export interface BlockAnchor {
  /** Block ID from the data-block-id attribute emitted by markdown.ts. */
  block_id: string;
  /** Type of the transformed block. */
  block_type: "mermaid" | "table" | "footnote";
  /** Selected text within the block (best-effort). */
  quoted_text: string;
}

/**
 * Discriminated union over the two anchor varieties.
 * PreviewPane and EditorPane dispatch this upward on selection.
 */
export type AnchorV1 =
  | { type: "source"; anchor: SourceAnchor }
  | { type: "block"; anchor: BlockAnchor };

// ---------------------------------------------------------------------------
// Typed IPC wrappers — use these instead of raw invoke() calls
// ---------------------------------------------------------------------------

/**
 * Open a markdown file by path.
 * Throws IpcError if the path is not a .md file or outside confined directories.
 */
export function openFile(path: string): Promise<FileResult> {
  return invoke<FileResult>("open_file", { path });
}

/**
 * Stop watching a file for external changes — call when its tab closes so the
 * Rust core releases the OS watcher instead of leaking it for the app's lifetime
 * (#26). No-op if the path isn't being watched.
 */
export function unwatchFile(path: string): Promise<void> {
  return invoke<void>("unwatch_file", { path });
}

/**
 * Save file content with optimistic concurrency (sha256 hash check).
 * Throws IpcError with code "HASH_MISMATCH" if on-disk content changed since last read.
 */
export function saveFile(request: SaveFileRequest): Promise<FileResult> {
  return invoke<FileResult>("save_file", { request });
}

/**
 * Load sidecar annotations for a document.
 * Migrates schema if needed; quarantines unknown future versions.
 */
export function loadAnnotations(docPath: string): Promise<Sidecar> {
  return invoke<Sidecar>("load_annotations", { docPath });
}

/**
 * Save sidecar annotations for a document.
 */
export function saveAnnotations(
  docPath: string,
  sidecar: Sidecar,
): Promise<void> {
  return invoke<void>("save_annotations", { docPath, sidecar });
}

/**
 * Write a pre-formatted review markdown file beside the document.
 * The frontend builds the ReviewPayload.markdown string via ReviewExporter.ts.
 */
export function generateReview(payload: ReviewPayload): Promise<ReviewResult> {
  return invoke<ReviewResult>("generate_review", { payload });
}

/**
 * Export the document to an Obsidian vault (REST or filesystem fallback).
 */
export function exportObsidian(
  request: ExportObsidianRequest,
): Promise<ExportObsidianResult> {
  return invoke<ExportObsidianResult>("export_obsidian", { request });
}

/**
 * Load persisted user settings.
 */
export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

/**
 * Persist user settings.
 * Note: the Obsidian REST key is managed via the OS keychain separately —
 * do not pass the raw key in settings.
 */
export function setSettings(settings: Settings): Promise<void> {
  return invoke<void>("set_settings", { settings });
}

/**
 * Capture the current web content as a `data:image/png;base64,...` URL.
 *
 * Backs the suminagashi open transition. Uses the native WKWebView snapshot on
 * macOS (real renderer → fonts match the live DOM exactly); throws IpcError with
 * code "SNAPSHOT_UNSUPPORTED" on other platforms, where the caller falls back to
 * html-to-image (which renders correctly on Chromium / WebView2).
 */
export function snapshotWebview(): Promise<string> {
  return invoke<string>("snapshot_webview");
}

// ---------------------------------------------------------------------------
// Export commands — A4
// ---------------------------------------------------------------------------

/**
 * Write a self-contained HTML bundle to `outPath`.
 *
 * `outPath` must be an absolute path with a `.html`/`.HTML` extension (e.g.
 * from a native Save dialog).  `html` is the complete document string produced
 * by `buildExportDocument` in `documentExport.ts` (fonts, CSS, content all
 * inlined as a single UTF-8 file).
 *
 * Throws IpcError with code "INVALID_PATH" if the path is invalid, "IO_ERROR"
 * if the write fails.
 */
export function exportHtml(outPath: string, html: string): Promise<string> {
  return invoke<string>("export_html", { outPath, html });
}

/**
 * Convert an HTML bundle to a PDF file at `outPath`.
 *
 * On macOS this uses a hidden off-screen WKWebView + `createPDFWithConfiguration`.
 * On non-macOS platforms it throws IpcError with code "PDF_EXPORT_UNSUPPORTED".
 *
 * `outPath` must be an absolute path with a `.pdf`/`.PDF` extension.
 * `html` is the same bundle string as passed to `exportHtml`.
 *
 * On timeout or native failure throws IpcError with code "PDF_EXPORT_FAILED".
 */
export function exportPdf(outPath: string, html: string): Promise<string> {
  return invoke<string>("export_pdf", { outPath, html });
}

/**
 * Read a local image file and return its bytes as a base64 string.
 *
 * `docPath` is the path to the open document (used to derive the allowed
 * directory root).  `imagePath` must be under `docPath`'s parent directory —
 * paths outside that root or containing `..` are rejected.
 *
 * On success returns a raw base64 string (no data-URI prefix).  On failure
 * (path violation, unreadable file) throws IpcError with code "IO_ERROR".
 * Callers should treat IO_ERROR as a "skip" and fall back to alt text.
 */
export function readFileBytes(docPath: string, imagePath: string): Promise<string> {
  return invoke<string>("read_file_bytes", { docPath, imagePath });
}

// ---------------------------------------------------------------------------
// Settings / keychain commands — A1
// ---------------------------------------------------------------------------

/**
 * Connection probe result for test_obsidian_connection.
 *
 * - "ok"           — REST server reachable, key accepted, vault listing succeeded.
 * - "unauthorized" — Server reachable but key was rejected (HTTP 401).
 * - "unreachable"  — Server not running or network timeout.
 */
export type ConnStatus = "ok" | "unauthorized" | "unreachable";

/**
 * Store the Obsidian REST API key in the OS keychain and persist the opaque
 * key reference in settings.  Returns the updated Settings so the frontend
 * store can stay in sync without a separate round-trip.
 *
 * The raw `key` is written only to the OS credential store and is never
 * included in the returned Settings struct.
 */
export function setRestKey(key: string): Promise<Settings> {
  return invoke<Settings>("set_rest_key", { key });
}

/**
 * Remove the Obsidian REST API key from the OS keychain and clear the
 * `rest_key_ref` field in settings.  Returns the updated Settings.
 */
export function clearRestKey(): Promise<Settings> {
  return invoke<Settings>("clear_rest_key");
}

/**
 * Return true if an Obsidian REST key is currently stored in the OS keychain.
 * Lightweight alternative to loading the full settings when only key presence
 * is needed.
 */
export function hasRestKey(): Promise<boolean> {
  return invoke<boolean>("has_rest_key");
}

/**
 * Probe the Obsidian Local REST API and return a ConnStatus result.
 *
 * Accepts an optional `key` for an in-memory, unsaved probe (D6): pass the
 * typed password text when testing before saving so the user does not have to
 * save first.  When `key` is omitted the saved keychain entry is used.
 *
 * The raw key, if provided, is used only for the duration of the probe and is
 * never persisted by this command.
 */
export function testObsidianConnection(key?: string): Promise<ConnStatus> {
  return invoke<ConnStatus>("test_obsidian_connection", { key: key ?? null });
}

// ---------------------------------------------------------------------------
// Version / update-check commands — A3
// ---------------------------------------------------------------------------

/**
 * Return the current application version string (e.g. "0.1.0").
 * Sourced from CARGO_PKG_VERSION at compile time.
 */
export function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

/**
 * Probe GitHub Releases for a newer version of Revenant.
 *
 * Returns an UpdateCheck on success.  Throws IpcError with code
 * "UPDATE_CHECK_FAILED" on network, parse, or other failure.
 */
export function checkForUpdates(): Promise<UpdateCheck> {
  return invoke<UpdateCheck>("check_for_updates");
}

/**
 * Open the Revenant release page in the system browser.
 *
 * `url` must be an https URL on github.com under the /slash-hug/revenant/releases
 * path.  Throws IpcError with code "UPDATE_CHECK_FAILED" if the URL fails
 * validation in the Rust layer.
 */
export function openReleasePage(url: string): Promise<void> {
  return invoke<void>("open_release_page", { url });
}

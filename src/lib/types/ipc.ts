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

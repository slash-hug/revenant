// IPC contract — WS-A owns and freezes this surface.
// All commands have todo!() bodies; WS-B/C/D fill sub-modules,
// and the bodies here will delegate to those modules.
//
// Events emitted (frontend subscribes with listen()):
//   - "open_file_request"  { path: string }     — emitted by main.rs on CLI/single-instance
//   - "file_changed"       { path: string }      — emitted by file_io watcher

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared types — mirrored in src/lib/types/ipc.ts
// ---------------------------------------------------------------------------

/// Typed error envelope returned by all IPC commands.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IpcError {
    /// Machine-readable error code (e.g. "HASH_MISMATCH", "NOT_MARKDOWN", "IO_ERROR").
    pub code: String,
    /// Human-readable description for display.
    pub message: String,
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

pub type IpcResult<T> = Result<T, IpcError>;

/// A single annotation anchored to a range in the source document.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Annotation {
    pub id: String,
    /// Body text of the annotation.
    pub body: String,
    /// Quoted text from the source document at anchor time.
    pub quoted_text: String,
    /// Starting line (0-indexed).
    pub line_start: u32,
    /// Ending line (0-indexed, inclusive).
    pub line_end: u32,
    /// Starting character offset within line_start.
    pub char_start: u32,
    /// Ending character offset within line_end.
    pub char_end: u32,
    /// "anchored" | "detached" | "block_level"
    pub status: String,
    /// ISO 8601 creation timestamp.
    pub created_at: String,
    /// ISO 8601 last-updated timestamp.
    pub updated_at: String,
}

/// The sidecar envelope stored next to each document.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Sidecar {
    /// Always 1 for v1; bump on breaking schema changes.
    pub schema_version: u32,
    /// sha256 hex of doc content at last save.
    pub doc_content_hash: String,
    /// Freeform general notes persisted separately from anchored annotations.
    pub general_notes: String,
    pub annotations: Vec<Annotation>,
}

/// Persisted user settings envelope.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    /// Always 1 for v1; bump on breaking schema changes.
    pub schema_version: u32,
    /// Configured Obsidian vault directories.
    pub vaults: Vec<String>,
    /// Default export subfolder within the vault.
    pub default_export_subfolder: String,
    /// UI theme: "dark" | "light" | "system".
    pub theme: String,
    /// Whether to export to Obsidian automatically on save.
    pub export_on_save: bool,
    /// Opaque reference to the keychain entry holding the Obsidian REST key.
    /// The actual key is NEVER stored in this struct — only this reference.
    pub rest_key_ref: Option<String>,
}

/// Response from open_file / save_file.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileResult {
    /// Canonical path of the opened/saved file.
    pub path: String,
    /// sha256 hex of the file content after the operation.
    pub content_hash: String,
    /// File content (UTF-8). Only populated on open; empty on save.
    pub content: String,
}

/// Request body for save_file — includes expected_hash for optimistic concurrency.
#[derive(Debug, Serialize, Deserialize)]
pub struct SaveFileRequest {
    pub path: String,
    pub content: String,
    /// sha256 hex the caller observed when it last read the file.
    /// If the on-disk hash differs, the save is rejected with HASH_MISMATCH.
    pub expected_hash: String,
}

/// Payload passed to generate_review — formatted by the frontend ReviewExporter.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewPayload {
    /// Canonical doc path — used to name the output file.
    pub doc_path: String,
    /// Pre-formatted markdown review body (agent-agnostic, no hardcoded labels).
    pub markdown: String,
}

/// Result of generate_review — path where the .review.md was written.
#[derive(Debug, Serialize, Deserialize)]
pub struct ReviewResult {
    pub review_path: String,
}

/// Request for Obsidian export.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportObsidianRequest {
    pub doc_path: String,
    /// Target vault directory (must be in configured vaults list).
    pub vault_path: String,
    /// Subfolder within the vault (may be empty).
    pub subfolder: String,
}

/// Result of Obsidian export.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportObsidianResult {
    /// "rest" | "filesystem"
    pub method: String,
    /// Destination path (filesystem) or URL (REST).
    pub destination: String,
}

// ---------------------------------------------------------------------------
// IPC Commands — todo!() bodies; sub-modules fill the real implementations.
// ---------------------------------------------------------------------------

/// Open a markdown file by path. Returns content + sha256 hash.
/// Path is canonicalized and confined to safe directories by file_io.
#[tauri::command]
pub fn open_file(_path: String) -> IpcResult<FileResult> {
    todo!("WS-B: delegate to crate::file_io::open_file(path)")
}

/// Save file content with optimistic concurrency (sha256 hash check).
/// Returns HASH_MISMATCH error if on-disk hash differs from expected_hash.
#[tauri::command]
pub fn save_file(_request: SaveFileRequest) -> IpcResult<FileResult> {
    todo!("WS-B: delegate to crate::file_io::save_file(request)")
}

/// Load sidecar annotations for a document. Migrates schema if needed.
#[tauri::command]
pub fn load_annotations(_doc_path: String) -> IpcResult<Sidecar> {
    todo!("WS-B: delegate to crate::annotations::load(doc_path)")
}

/// Save sidecar annotations for a document.
#[tauri::command]
pub fn save_annotations(_doc_path: String, _sidecar: Sidecar) -> IpcResult<()> {
    todo!("WS-B: delegate to crate::annotations::save(doc_path, sidecar)")
}

/// Write a pre-formatted review markdown file beside the document.
/// Frontend (ReviewExporter.ts) builds the markdown payload.
#[tauri::command]
pub fn generate_review(_payload: ReviewPayload) -> IpcResult<ReviewResult> {
    todo!("WS-B: write payload.markdown to <doc>.review.md via file_io")
}

/// Export the document to an Obsidian vault (REST or filesystem fallback).
#[tauri::command]
pub fn export_obsidian(_request: ExportObsidianRequest) -> IpcResult<ExportObsidianResult> {
    todo!("WS-D: delegate to crate::obsidian::export(request)")
}

/// Load persisted user settings.
#[tauri::command]
pub fn get_settings() -> IpcResult<Settings> {
    todo!("WS-D: delegate to crate::settings::load()")
}

/// Persist user settings (rest_key is NOT accepted here — use keychain via secrets module).
#[tauri::command]
pub fn set_settings(_settings: Settings) -> IpcResult<()> {
    todo!("WS-D: delegate to crate::settings::save(settings)")
}

// IPC contract — WS-A owns and freezes this surface.
// All commands have todo!() bodies; WS-B/C/D fill sub-modules,
// and the bodies here will delegate to those modules.
//
// Events emitted (frontend subscribes with listen()):
//   - "open_file_request"  { path: string }     — emitted by main.rs on CLI/single-instance
//   - "file_changed"       { path: string }      — emitted by file_io watcher

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

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
// Type-conversion helpers (IPC ↔ module types)
// ---------------------------------------------------------------------------

/// Convert an `ipc::Annotation` (transport layer) to an
/// `annotations::Annotation` (on-disk / data-engine format).
///
/// `context_before` and `context_after` are derived by the caller from the
/// document content (T1.2/A2/A6) — they are internal re-anchoring data
/// preserved only in the sidecar and never cross the IPC seam.
fn ann_from_ipc(
    a: Annotation,
    context_before: String,
    context_after: String,
) -> crate::annotations::Annotation {
    crate::annotations::Annotation {
        id: a.id,
        line_start: a.line_start,
        line_end: a.line_end,
        char_start: a.char_start,
        char_end: a.char_end,
        quoted_text: a.quoted_text,
        context_before,
        context_after,
        body: a.body,
        status: match a.status.as_str() {
            "detached" => crate::annotations::AnchorStatus::Detached,
            "block_level" => crate::annotations::AnchorStatus::BlockLevel,
            _ => crate::annotations::AnchorStatus::Anchored,
        },
        created_at: a.created_at,
        updated_at: a.updated_at,
    }
}

/// Convert an `annotations::Annotation` (on-disk) to an `ipc::Annotation`
/// (transport layer).
///
/// `context_before` / `context_after` are intentionally omitted from the IPC
/// type — they are internal implementation details of re-anchoring.
fn ann_to_ipc(a: crate::annotations::Annotation) -> Annotation {
    Annotation {
        id: a.id,
        body: a.body,
        quoted_text: a.quoted_text,
        line_start: a.line_start,
        line_end: a.line_end,
        char_start: a.char_start,
        char_end: a.char_end,
        status: match a.status {
            crate::annotations::AnchorStatus::Anchored => "anchored".to_string(),
            crate::annotations::AnchorStatus::Detached => "detached".to_string(),
            crate::annotations::AnchorStatus::BlockLevel => "block_level".to_string(),
        },
        created_at: a.created_at,
        updated_at: a.updated_at,
    }
}

/// Convert an `ipc::Sidecar` to an `annotations::Sidecar`, deriving
/// `context_before`/`context_after` from `doc_lines` for each annotation.
///
/// Per A6/T1.2: annotations are 0-indexed; `context_before` = line at
/// `line_start - 1` (empty if line_start == 0); `context_after` = line at
/// `line_end + 1` (empty if past EOF).
fn sidecar_from_ipc_with_context(s: Sidecar, doc_lines: &[&str]) -> crate::annotations::Sidecar {
    let annotations = s
        .annotations
        .into_iter()
        .map(|a| {
            let context_before = if a.line_start > 0 {
                doc_lines
                    .get((a.line_start - 1) as usize)
                    .copied()
                    .unwrap_or("")
                    .to_string()
            } else {
                String::new()
            };
            let context_after = doc_lines
                .get((a.line_end + 1) as usize)
                .copied()
                .unwrap_or("")
                .to_string();
            ann_from_ipc(a, context_before, context_after)
        })
        .collect();

    crate::annotations::Sidecar {
        schema_version: 1,
        doc_content_hash: s.doc_content_hash,
        general_notes: s.general_notes,
        annotations,
    }
}

/// Convert an `annotations::Sidecar` to an `ipc::Sidecar`.
fn sidecar_to_ipc(s: crate::annotations::Sidecar) -> Sidecar {
    Sidecar {
        schema_version: 1,
        doc_content_hash: s.doc_content_hash,
        general_notes: s.general_notes,
        annotations: s.annotations.into_iter().map(ann_to_ipc).collect(),
    }
}

/// Convert an `ipc::Settings` (transport) to a `settings::Settings` (module).
/// vaults are stored as PathBuf internally.
fn settings_from_ipc(s: Settings) -> crate::settings::Settings {
    crate::settings::Settings {
        schema_version: 1,
        vaults: s.vaults.into_iter().map(std::path::PathBuf::from).collect(),
        default_export_subfolder: s.default_export_subfolder,
        theme: s.theme,
        export_on_save: s.export_on_save,
        rest_key_ref: s.rest_key_ref,
    }
}

/// Convert a `settings::Settings` to `ipc::Settings`.
fn settings_to_ipc(s: crate::settings::Settings) -> Settings {
    Settings {
        schema_version: 1,
        vaults: s.vaults.into_iter()
            .filter_map(|p| p.to_str().map(str::to_string))
            .collect(),
        default_export_subfolder: s.default_export_subfolder,
        theme: s.theme,
        export_on_save: s.export_on_save,
        rest_key_ref: s.rest_key_ref,
    }
}

/// Map a `file_io::FileIoError` to an `IpcError`.
fn file_io_err(e: crate::file_io::FileIoError) -> IpcError {
    use crate::file_io::FileIoError::*;
    match e {
        NotMarkdown(_) => IpcError { code: "NOT_MARKDOWN".into(), message: e.to_string() },
        HashMismatch { .. } => IpcError { code: "HASH_MISMATCH".into(), message: e.to_string() },
        Path(_) => IpcError { code: "PATH_CONFINED".into(), message: e.to_string() },
        Io(_) => IpcError { code: "IO_ERROR".into(), message: e.to_string() },
    }
}

/// Map an `annotations::AnnotationError` to an `IpcError`.
fn ann_err(e: crate::annotations::AnnotationError) -> IpcError {
    IpcError { code: "ANNOTATION_ERROR".into(), message: e.to_string() }
}

/// Map a `spawn_blocking` join error (task panicked/cancelled) to an `IpcError`.
/// Write commands offload their blocking fs I/O to a blocking thread (perf #28)
/// so the IPC command pool stays responsive on large docs.
fn task_err<E: std::fmt::Display>(e: E) -> IpcError {
    IpcError { code: "INTERNAL".into(), message: format!("background task failed: {e}") }
}

/// Map a `settings::SettingsError` to an `IpcError`.
fn settings_err(e: crate::settings::SettingsError) -> IpcError {
    IpcError { code: "SETTINGS_ERROR".into(), message: e.to_string() }
}

/// Map a `secrets::SecretsError` to an `IpcError`.
fn secrets_err(e: crate::secrets::SecretsError) -> IpcError {
    IpcError { code: "SECRETS_ERROR".into(), message: e.to_string() }
}

/// Map an `obsidian::ObsidianError` to an `IpcError`.
fn obsidian_err(e: crate::obsidian::ObsidianError) -> IpcError {
    use crate::obsidian::ObsidianError::*;
    let code = match &e {
        NotRunning => "OBSIDIAN_NOT_RUNNING",
        Misconfigured => "OBSIDIAN_MISCONFIGURED",
        NoVaultConfigured => "NO_VAULT_CONFIGURED",
        HttpError { .. } => "OBSIDIAN_HTTP_ERROR",
        Io(_) => "IO_ERROR",
        Secrets(_) => "SECRETS_ERROR",
        Settings(_) => "SETTINGS_ERROR",
        Http(_) => "HTTP_ERROR",
    };
    IpcError { code: code.into(), message: e.to_string() }
}

// ---------------------------------------------------------------------------
// File-change watcher wiring (A5/C12)
// ---------------------------------------------------------------------------

/// Payload emitted on the `file_changed` event. `external` is `true` when the
/// change did NOT originate from this process's own `save_file` (i.e. an
/// outside editor touched the file); the frontend opens the conflict modal only
/// for external changes.
#[derive(Clone, Serialize)]
struct FileChangedPayload {
    path: String,
    external: bool,
}

/// Start (or refresh) a live watcher for `canonical`, emitting `file_changed`
/// when the file is modified. Idempotent per path: opening a file twice, or
/// saving it, just refreshes the "last written" hash so our own writes are
/// recognized as internal (`external == false`).
fn watch_file(
    app: &AppHandle,
    watchers: &State<crate::FileWatchers>,
    canonical: &Path,
    current_hash: &str,
) {
    let mut map = watchers
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some(handle) = map.get(canonical) {
        // Already watching — record the hash we just read/wrote so the
        // resulting notify event is treated as internal.
        if let Ok(mut lw) = handle.last_written.lock() {
            *lw = Some(current_hash.to_string());
        }
        return;
    }

    let last_written = Arc::new(Mutex::new(Some(current_hash.to_string())));
    let app_for_cb = app.clone();
    let path_string = canonical.to_string_lossy().into_owned();

    match crate::file_io::spawn_watcher(
        canonical.to_path_buf(),
        last_written.clone(),
        move |ev| {
            let _ = app_for_cb.emit(
                "file_changed",
                FileChangedPayload {
                    path: path_string.clone(),
                    external: ev.external,
                },
            );
        },
    ) {
        Ok(watcher) => {
            map.insert(
                canonical.to_path_buf(),
                crate::WatchHandle {
                    _watcher: watcher,
                    last_written,
                },
            );
        }
        // A watcher that fails to start is non-fatal: file I/O still works, the
        // app simply won't auto-detect external edits for this file.
        Err(_) => {}
    }
}

/// Stop watching a file — called from the frontend when its tab closes so the OS
/// watcher + thread are released instead of leaking for the app's lifetime (#26).
/// No-op if the path isn't being watched.
#[tauri::command]
pub fn unwatch_file(watchers: State<crate::FileWatchers>, path: String) {
    watchers.unwatch(&path);
}

// ---------------------------------------------------------------------------
// IPC Commands — delegating to WS-B/D modules.
// ---------------------------------------------------------------------------

/// Open a markdown file by path. Returns content + sha256 hash.
///
/// Path confinement (A7/C16): the canonicalized path must be inside one of the
/// configured vault directories OR must be an already-opened document's parent
/// dir.  For the initial open (before any vaults are configured) we allow any
/// `.md` file; once settings exist the vault list is used as the allowed-dirs set.
#[tauri::command]
pub fn open_file(
    app: AppHandle,
    watchers: State<crate::FileWatchers>,
    path: String,
) -> IpcResult<FileResult> {
    let p = std::path::Path::new(&path);
    let opened = crate::file_io::open_file(p).map_err(file_io_err)?;

    // Confinement check using configured vault dirs (best-effort; falls back to
    // allowing any path when no vaults are configured yet so first-run UX works).
    let settings_path = settings_file_path();
    if let Ok(settings) = crate::settings::get_settings(&settings_path) {
        if !settings.vaults.is_empty() {
            let allowed: Vec<std::path::PathBuf> = settings.vaults.iter()
                .filter_map(|v| std::fs::canonicalize(v).ok())
                .collect();
            // Also allow the document's own parent directory (opened doc can be
            // anywhere — the vault constraint applies to writes/exports, not reads
            // of arbitrary user files they drag-open). Use the opened canonical path.
            let doc_dir = opened.path.parent().map(|d| d.to_path_buf());
            let mut check_dirs = allowed;
            if let Some(d) = doc_dir {
                check_dirs.push(d);
            }
            crate::paths::assert_confined(&opened.path, &check_dirs)
                .map_err(|e| IpcError { code: "PATH_CONFINED".into(), message: e.to_string() })?;
        }
    }

    // Start watching this file for external changes so the frontend can surface
    // a conflict prompt instead of silently clobbering (A5/C12).
    watch_file(&app, &watchers, &opened.path, &opened.content_hash);

    Ok(FileResult {
        path: opened.path.to_string_lossy().into_owned(),
        content_hash: opened.content_hash,
        content: opened.content,
    })
}

/// Save file content with optimistic concurrency (sha256 hash check).
/// Returns HASH_MISMATCH error if on-disk hash differs from expected_hash.
///
/// Path confinement (A7/C16): canonicalized path must be inside a configured
/// vault directory.  The target path supplied by the frontend is *untrusted*:
/// we never derive the allowed set from the target path itself, because that
/// would allow any path to authorize its own parent, making confinement a no-op.
///
/// Write confinement fails *closed*: if vault list cannot be loaded we reject
/// the write rather than falling back to "allow all".
#[tauri::command]
pub async fn save_file(
    app: AppHandle,
    watchers: State<'_, crate::FileWatchers>,
    request: SaveFileRequest,
) -> IpcResult<FileResult> {
    // Confinement check + the fd-locked write are blocking fs work — offload to a
    // blocking thread so a large-doc save doesn't stall the IPC command pool
    // (perf #28). `watch_file` (which needs the non-'static AppHandle/State) runs
    // back on the async side after the write returns.
    let (canon, new_hash, path) = tauri::async_runtime::spawn_blocking(
        move || -> IpcResult<(std::path::PathBuf, String, String)> {
            let p = std::path::Path::new(&request.path);

            let canon = std::fs::canonicalize(p)
                .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;
            let settings_path = settings_file_path();
            let settings = crate::settings::get_settings(&settings_path).map_err(|e| IpcError {
                code: "SETTINGS_ERROR".into(),
                message: format!("cannot load settings for confinement check: {e}"),
            })?;

            if !settings.vaults.is_empty() {
                // Allowed dirs come ONLY from the pre-configured vault list — never
                // from the (frontend-supplied, untrusted) target path.
                let allowed: Vec<std::path::PathBuf> = settings.vaults.iter()
                    .filter_map(|v| std::fs::canonicalize(v).ok())
                    .collect();
                crate::paths::assert_confined(&canon, &allowed)
                    .map_err(|e| IpcError { code: "PATH_CONFINED".into(), message: e.to_string() })?;
            }
            // No vaults configured (first-run) → unrestricted; once configured every
            // save must be inside them.

            let new_hash = crate::file_io::save_file(p, &request.content, &request.expected_hash)
                .map_err(file_io_err)?;
            Ok((canon, new_hash, request.path))
        },
    )
    .await
    .map_err(task_err)??;

    // Record our own write so the watcher's resulting event is recognized as
    // internal (external == false) and does NOT trigger a false conflict prompt.
    watch_file(&app, &watchers, &canon, &new_hash);

    Ok(FileResult {
        path,
        content_hash: new_hash,
        content: String::new(),
    })
}

/// Core re-anchor logic extracted from the `load_annotations` IPC command.
///
/// Given a sidecar and the current document content + its hash, applies
/// in-memory re-anchoring when the stored hash differs from the current hash.
/// This is the exact guard that the async command wraps in `spawn_blocking`.
///
/// Extracted so that integration tests can call the real production logic
/// without needing a live `AppHandle` (closes T1.4/R-OFFSET-TEST fidelity
/// gap — tests no longer duplicate this logic inline).
pub fn apply_reanchor_to_sidecar(
    mut sidecar: crate::annotations::Sidecar,
    doc_content: &str,
    doc_hash: &str,
) -> crate::annotations::Sidecar {
    if sidecar.doc_content_hash != doc_hash && !sidecar.annotations.is_empty() {
        let stored_hash = sidecar.doc_content_hash.clone();
        let results = crate::reanchor::reanchor_all(
            &sidecar.annotations,
            doc_content,
            doc_hash,
            &stored_hash,
        );
        sidecar.annotations = results.into_iter().map(|r| r.annotation).collect();
        sidecar.doc_content_hash = doc_hash.to_string();
    }
    sidecar
}

/// Load sidecar annotations for a document. Migrates schema if needed.
///
/// T1.3/A4: now `async` so the re-anchor computation can run on a blocking
/// thread via `tauri::async_runtime::spawn_blocking` without stalling the IPC
/// handler thread on large documents.
///
/// On hash mismatch (doc has been edited since last save) re-anchors all
/// annotations in-memory per the approved C-LOAD-WRITE decision — does NOT
/// write the sidecar on load; re-anchored positions are returned to the
/// frontend and persisted on the next normal save.
///
/// The re-anchor guard itself is in `apply_reanchor_to_sidecar` — a sync
/// function that integration tests call directly (T1.4/R-OFFSET-TEST).
#[tauri::command]
pub async fn load_annotations(doc_path: String) -> IpcResult<Sidecar> {
    // Read the full doc content (we need it for re-anchoring and hashing).
    let doc_content = tauri::async_runtime::spawn_blocking({
        let path = doc_path.clone();
        move || std::fs::read_to_string(&path)
    })
    .await
    .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?
    .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;

    let doc_hash = crate::file_io::sha256_hex(doc_content.as_bytes());

    let load_result = tauri::async_runtime::spawn_blocking({
        let path = doc_path.clone();
        let hash = doc_hash.clone();
        move || {
            let p = std::path::Path::new(&path);
            crate::annotations::load_annotations(p, &hash)
        }
    })
    .await
    .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?
    .map_err(ann_err)?;

    let sidecar = match load_result {
        crate::annotations::LoadResult::Loaded(s) => s,
        crate::annotations::LoadResult::NotFound(s) => s,
        crate::annotations::LoadResult::Quarantined { fallback, .. } => fallback,
    };

    // T1.3: if the doc has changed since last save, re-anchor in-memory.
    // Delegate to `apply_reanchor_to_sidecar` (the same function integration
    // tests call directly) so the guard + hash-update logic is not duplicated.
    let sidecar = {
        let content_clone = doc_content.clone();
        let hash_clone = doc_hash.clone();
        tauri::async_runtime::spawn_blocking(move || {
            apply_reanchor_to_sidecar(sidecar, &content_clone, &hash_clone)
        })
        .await
        .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?
    };

    Ok(sidecar_to_ipc(sidecar))
}

/// Save sidecar annotations for a document.
///
/// T1.2/A2/A6: reads the document at `doc_path`, splits into 0-indexed lines,
/// and derives `context_before`/`context_after` for every annotation from the
/// live doc content — NOT from the IPC payload (the IPC Annotation type has no
/// context fields). This is the single source of truth for context; the
/// frontend never supplies it.
#[tauri::command]
pub async fn save_annotations(doc_path: String, sidecar: Sidecar) -> IpcResult<()> {
    // Reads the whole doc + writes the sidecar — blocking fs, offloaded (perf #28).
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<()> {
        let p = std::path::Path::new(&doc_path);

        // Read the current doc content so we can derive annotation context lines.
        let doc_content = std::fs::read_to_string(p)
            .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;
        let doc_lines: Vec<&str> = doc_content.lines().collect();

        let store_sidecar = sidecar_from_ipc_with_context(sidecar, &doc_lines);

        // Ensure gitignore entry on first write.
        if let Some(dir) = p.parent() {
            let _ = crate::paths::ensure_gitignore_entry(dir);
        }
        crate::annotations::save_annotations(p, &store_sidecar).map_err(ann_err)
    })
    .await
    .map_err(task_err)?
}

/// Write a pre-formatted review markdown file beside the document.
/// Frontend (ReviewExporter.ts) builds the markdown payload.
#[tauri::command]
pub async fn generate_review(payload: ReviewPayload) -> IpcResult<ReviewResult> {
    // Canonicalize + write the .review.md — blocking fs, offloaded (perf #28).
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<ReviewResult> {
    let doc_p = std::path::Path::new(&payload.doc_path);

    // Path confinement (A7/C16): the review file is written next to its source
    // document, so the only legitimate target is "<canonical doc>.review.md".
    // doc_path is frontend-supplied and therefore untrusted — require it to be
    // an existing .md file, canonicalize it, and assert the derived review path
    // stays inside the document's own directory. (Previously this command was
    // the one fs-writing path that bypassed confinement entirely.)
    crate::paths::assert_markdown(doc_p)
        .map_err(|e| IpcError { code: "NOT_MARKDOWN".into(), message: e.to_string() })?;
    let canon_doc = std::fs::canonicalize(doc_p)
        .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;

    // Derive review path: <canonical doc>.review.md
    let mut review_os = canon_doc.as_os_str().to_owned();
    review_os.push(".review.md");
    let review_path = std::path::PathBuf::from(review_os);

    let doc_dir = canon_doc.parent().ok_or_else(|| IpcError {
        code: "PATH_CONFINED".into(),
        message: "document has no parent directory".into(),
    })?;
    crate::paths::assert_confined(&review_path, &[doc_dir.to_path_buf()])
        .map_err(|e| IpcError { code: "PATH_CONFINED".into(), message: e.to_string() })?;

    std::fs::write(&review_path, payload.markdown.as_bytes())
        .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;

    Ok(ReviewResult {
        review_path: review_path.to_string_lossy().into_owned(),
    })
    })
    .await
    .map_err(task_err)?
}

/// Export the document to an Obsidian vault (REST or filesystem fallback).
///
/// Async + `spawn_blocking`: the work (settings read, path canonicalize, REST/fs
/// I/O) is blocking and can take up to the 3s REST probe timeout when Obsidian is
/// unreachable. Running it off a command-worker thread keeps the command pool /
/// UI responsive (perf #4).
#[tauri::command]
pub async fn export_obsidian(request: ExportObsidianRequest) -> IpcResult<ExportObsidianResult> {
    tauri::async_runtime::spawn_blocking(move || export_obsidian_blocking(request))
        .await
        .map_err(|e| IpcError {
            code: "INTERNAL".into(),
            message: format!("export task failed: {e}"),
        })?
}

/// The blocking body of `export_obsidian` (runs on a blocking thread).
fn export_obsidian_blocking(request: ExportObsidianRequest) -> IpcResult<ExportObsidianResult> {
    // Load current settings to get vault list and REST key ref.
    let settings_path = settings_file_path();
    let settings = crate::settings::get_settings(&settings_path).map_err(settings_err)?;

    // Validate that vault_path is in the configured vaults list. This fails
    // CLOSED (like save_file): if the requested vault cannot be canonicalized we
    // reject, because comparing a non-canonical path lets `..`/symlink variants
    // slip the starts_with guard (security #12).
    let requested_vault = std::path::PathBuf::from(&request.vault_path);
    let canonical_requested = std::fs::canonicalize(&requested_vault).map_err(|e| IpcError {
        code: "PATH_CONFINED".into(),
        message: format!("vault_path '{}' could not be resolved: {e}", request.vault_path),
    })?;
    // Allowed vaults are only those that themselves canonicalize — we never
    // compare against a non-canonical configured path.
    let allowed_vaults: Vec<std::path::PathBuf> = settings
        .vaults
        .iter()
        .filter_map(|v| std::fs::canonicalize(v).ok())
        .collect();
    let vault_allowed = allowed_vaults
        .iter()
        .any(|cv| canonical_requested == *cv || canonical_requested.starts_with(cv));
    if !vault_allowed {
        return Err(IpcError {
            code: "PATH_CONFINED".into(),
            message: format!(
                "vault_path '{}' is not in the configured vaults list",
                request.vault_path
            ),
        });
    }

    // Read document content.
    let doc_content = std::fs::read_to_string(&request.doc_path)
        .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;

    // Build vault-relative path: subfolder / filename
    let filename = std::path::Path::new(&request.doc_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("export.md");
    let vault_relative = if request.subfolder.is_empty() {
        filename.to_string()
    } else {
        format!("{}/{}", request.subfolder.trim_matches('/'), filename)
    };

    // Reject path-traversal in the derived target: a `..` component in the
    // subfolder would otherwise satisfy the lexical starts_with check below while
    // escaping the vault on disk (security #12).
    if crate::paths::has_parent_traversal(std::path::Path::new(&vault_relative)) {
        return Err(IpcError {
            code: "PATH_CONFINED".into(),
            message: format!("export path '{vault_relative}' contains a parent-directory traversal"),
        });
    }

    // Confinement: ensure the derived target stays inside the requested vault.
    let target = canonical_requested.join(&vault_relative);
    crate::paths::assert_confined(&target, &[canonical_requested.clone()])
        .map_err(|_| IpcError {
            code: "PATH_CONFINED".into(),
            message: format!("derived export path '{}' escapes the vault directory", target.display()),
        })?;

    // Use the requested vault, not just the first configured one.
    let mut export_settings = settings.clone();
    export_settings.vaults = vec![canonical_requested.clone()];

    let result = crate::obsidian::export_obsidian(
        &doc_content,
        &vault_relative,
        &export_settings,
        crate::obsidian::REST_DEFAULT_HTTP_PORT,
    ).map_err(obsidian_err)?;

    let (method, destination) = match result {
        crate::obsidian::ExportResult::RestPushed => (
            "rest".to_string(),
            format!("http://127.0.0.1:{}/vault/{}", crate::obsidian::REST_DEFAULT_HTTP_PORT, vault_relative),
        ),
        crate::obsidian::ExportResult::FilesystemCopy => (
            "filesystem".to_string(),
            canonical_requested.join(&vault_relative).to_string_lossy().into_owned(),
        ),
    };

    Ok(ExportObsidianResult { method, destination })
}

/// Load persisted user settings.
#[tauri::command]
pub async fn get_settings() -> IpcResult<Settings> {
    // Settings file read — small, but still fs; offloaded for consistency (perf #28).
    tauri::async_runtime::spawn_blocking(|| -> IpcResult<Settings> {
        let path = settings_file_path();
        let settings = crate::settings::get_settings(&path).map_err(settings_err)?;
        Ok(settings_to_ipc(settings))
    })
    .await
    .map_err(task_err)?
}

/// Persist user settings (rest_key is NOT accepted here — use keychain via secrets module).
#[tauri::command]
pub async fn set_settings(settings: Settings) -> IpcResult<()> {
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<()> {
        let path = settings_file_path();
        let store_settings = settings_from_ipc(settings);
        crate::settings::set_settings(&path, store_settings).map_err(settings_err)
    })
    .await
    .map_err(task_err)?
}

// ---------------------------------------------------------------------------
// Settings / keychain commands (A2) — store, clear, and probe the REST key.
// ---------------------------------------------------------------------------

/// Re-export the canonical ConnStatus from obsidian.rs so it is part of the
/// public IPC surface (serialised as `"ok"` | `"unauthorized"` | `"unreachable"`).
///
/// `ConnStatus` is defined once in `crate::obsidian` (WS-D) and re-exported here
/// so the Tauri command `test_obsidian_connection` can reference it without
/// introducing a duplicate definition.
pub use crate::obsidian::ConnStatus;

/// Store the Obsidian REST API key in the OS keychain, persist the opaque
/// reference in settings, and return the updated `Settings`.
///
/// The raw `key` is written only to the OS credential store.  It is never
/// included in the returned `Settings` struct and is never written to disk.
/// The `rest_key_ref` field in `Settings` holds only the opaque entry name
/// used to retrieve the key later via `secrets::get_rest_key`.
#[tauri::command]
pub async fn set_rest_key(key: String) -> IpcResult<Settings> {
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<Settings> {
        let path = settings_file_path();
        // Store the raw key in the OS keychain.
        crate::secrets::store_rest_key("obsidian-rest", &key).map_err(secrets_err)?;
        // Load current settings so we can update the key reference field.
        let mut settings = crate::settings::get_settings(&path).map_err(settings_err)?;
        settings.rest_key_ref = Some("obsidian-rest".to_string());
        // Persist the updated settings (only rest_key_ref changes; key is NOT written).
        crate::settings::set_settings(&path, settings.clone()).map_err(settings_err)?;
        Ok(settings_to_ipc(settings))
    })
    .await
    .map_err(task_err)?
}

/// Remove the Obsidian REST API key from the OS keychain, clear the
/// `rest_key_ref` field in settings, and return the updated `Settings`.
#[tauri::command]
pub async fn clear_rest_key() -> IpcResult<Settings> {
    tauri::async_runtime::spawn_blocking(|| -> IpcResult<Settings> {
        let path = settings_file_path();
        // Delete the key from the OS keychain (no-op if absent).
        crate::secrets::delete_rest_key("obsidian-rest").map_err(secrets_err)?;
        // Clear the key reference in settings.
        let mut settings = crate::settings::get_settings(&path).map_err(settings_err)?;
        settings.rest_key_ref = None;
        crate::settings::set_settings(&path, settings.clone()).map_err(settings_err)?;
        Ok(settings_to_ipc(settings))
    })
    .await
    .map_err(task_err)?
}

/// Return `true` if an Obsidian REST key is currently present in the OS keychain.
///
/// Lightweight check: does not load the full settings, does not attempt a
/// network probe.  The frontend uses this to drive the masked-vs-entry UI state
/// on first panel open when the settings store is already loaded (avoids a
/// second round-trip vs reading `rest_key_ref != null` from the store).
#[tauri::command]
pub async fn has_rest_key() -> IpcResult<bool> {
    tauri::async_runtime::spawn_blocking(|| -> IpcResult<bool> {
        let present = crate::secrets::get_rest_key("obsidian-rest")
            .map_err(secrets_err)?
            .is_some();
        Ok(present)
    })
    .await
    .map_err(task_err)?
}

/// Probe the Obsidian Local REST API and return a `ConnStatus` result.
///
/// `key` — optional raw API key for an in-session probe before saving (D6).
/// When `Some`, the provided key is used transiently for this probe only and
/// is NEVER persisted.  When `None`, the saved keychain entry is used.
///
/// Delegates to `obsidian::test_obsidian_connection` (WS-D) which resolves the
/// key, issues a read-only `GET /vault/` probe, and maps the response to a
/// `ConnStatus`.  The blocking network I/O runs on a `spawn_blocking` thread
/// so the IPC command pool stays responsive during the 3s probe timeout.
#[tauri::command]
pub async fn test_obsidian_connection(key: Option<String>) -> IpcResult<ConnStatus> {
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<ConnStatus> {
        let status = crate::obsidian::test_obsidian_connection(&settings_file_path(), key);
        Ok(status)
    })
    .await
    .map_err(task_err)?
}

// ---------------------------------------------------------------------------
// Export commands (A2) — delegating to crate::export
// ---------------------------------------------------------------------------

/// Write a self-contained HTML bundle to the user-chosen `out_path`.
///
/// `out_path` must be absolute with a `.html`/`.HTML` extension and no
/// parent-directory traversal.  `html` is the full document string produced by
/// the frontend's `buildExportDocument` helper (fonts, CSS, and all content
/// inlined).
///
/// Returns the written path on success; `INVALID_PATH` or `IO_ERROR` on failure.
#[tauri::command]
pub fn export_html(out_path: String, html: String) -> IpcResult<String> {
    let p = std::path::Path::new(&out_path);
    crate::export::export_html(p, &html)
}

/// Convert an HTML bundle to a PDF file at the user-chosen `out_path`.
///
/// On macOS: creates a hidden off-screen WKWebView, loads the bundle, waits
/// for it to render, calls `createPDFWithConfiguration`, and writes the bytes.
/// Bounded to 30 s total; returns `PDF_EXPORT_FAILED` on timeout or native
/// failure.
///
/// On non-macOS: returns `PDF_EXPORT_UNSUPPORTED` immediately so the frontend
/// can surface a friendly message.
///
/// `out_path` must be absolute with a `.pdf`/`.PDF` extension and no
/// parent-directory traversal.
#[tauri::command]
pub async fn export_pdf(out_path: String, html: String) -> IpcResult<String> {
    let p = std::path::PathBuf::from(&out_path);
    crate::export::export_pdf(p, html).await
}

/// Read an image file at `image_path` and return its bytes as a base64 string.
///
/// `image_path` must be under `doc_path`'s parent directory (all
/// subdirectories included).  A `has_parent_traversal` pre-guard is applied
/// before the confinement check so dot-dot paths cannot escape.
///
/// On failure (path out of bounds, unreadable) returns `IO_ERROR`.  The
/// frontend treats this as a "skip" and degrades to alt text — it must not
/// abort the entire export.
#[tauri::command]
pub fn read_file_bytes(doc_path: String, image_path: String) -> IpcResult<String> {
    let doc = std::path::Path::new(&doc_path);
    let img = std::path::Path::new(&image_path);
    crate::export::read_file_bytes(doc, img)
}

/// Capture the current web content as a PNG data URL.
///
/// Backs the suminagashi open transition: the frontend needs a faithful bitmap of
/// the freshly-opened document to feed the GPU ink reveal. On macOS this uses the
/// native WKWebView snapshot (real renderer → correct fonts); see `snapshot.rs`
/// for why html-to-image cannot be trusted there. On every other platform it
/// returns `SNAPSHOT_UNSUPPORTED` and the frontend falls back to html-to-image
/// (which renders correctly on Chromium / WebView2).
#[tauri::command]
pub async fn snapshot_webview(window: tauri::WebviewWindow) -> IpcResult<String> {
    #[cfg(target_os = "macos")]
    {
        crate::snapshot::capture_png_data_url(window).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err(IpcError {
            code: "SNAPSHOT_UNSUPPORTED".into(),
            message: "native webview snapshot is only available on macOS".into(),
        })
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Derive the settings file path from the standard app data directory.
/// Falls back to the current working directory in non-Tauri test contexts.
fn settings_file_path() -> std::path::PathBuf {
    // In production Tauri uses the app_data_dir; in tests we use a fixed temp path.
    // The IPC commands that need a Tauri State should use tauri::State, but for
    // simplicity in v1 we derive a platform-appropriate default here.
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        std::path::PathBuf::from(home)
            .join("Library/Application Support/com.codelogiq.revenant/settings.json")
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        std::path::PathBuf::from(appdata)
            .join("com.codelogiq.revenant/settings.json")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        std::path::PathBuf::from(home)
            .join(".config/com.codelogiq.revenant/settings.json")
    }
}

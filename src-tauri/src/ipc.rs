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
    /// Preview zoom percentage (50–200).
    pub preview_zoom: u32,
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

/// Update-check result returned by `check_for_updates`.
/// The Ok variant of `IpcResult<UpdateCheck>`; failures map to `IpcError`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheck {
    /// Current installed version (from CARGO_PKG_VERSION).
    pub current: String,
    /// Latest published version from GitHub Releases.
    pub latest: String,
    /// Whether `latest` is semantically newer than `current`.
    pub update_available: bool,
    /// URL of the latest release page (html_url from GitHub API).
    pub release_url: String,
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
        preview_zoom: s.preview_zoom,
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
        preview_zoom: s.preview_zoom,
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

/// Map a `updates::UpdatesError` to an `IpcError`.
fn updates_err(e: crate::updates::UpdatesError) -> IpcError {
    IpcError { code: "UPDATE_CHECK_FAILED".into(), message: e.to_string() }
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
pub fn unwatch_file(
    watchers: State<crate::FileWatchers>,
    open_docs: State<crate::OpenDocuments>,
    path: String,
) {
    watchers.unwatch(&path);
    // Drop it from the open set too, so a closed document can no longer be used
    // as an export/annotation source-read target (#85).
    open_docs.remove(&path);
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
    open_docs: State<crate::OpenDocuments>,
    path: String,
) -> IpcResult<FileResult> {
    let p = std::path::Path::new(&path);
    // No vault confinement on open (see rationale below): pass an empty
    // allowed-dirs set, which `file_io::open_file` treats as "unrestricted".
    // Confinement now lives inside the fs layer (#86), so the empty set is the
    // explicit, deliberate opt-out rather than a missing check.
    let opened = crate::file_io::open_file(p, &[]).map_err(file_io_err)?;

    // No vault confinement on open — intentionally. Revenant is a markdown
    // viewer, so opening an arbitrary `.md` the user explicitly chose (OS dialog,
    // CLI arg, drag-open) is the whole point; the user's open action IS the trust
    // boundary for reads. `file_io::open_file` already requires a readable `.md`.
    //
    // (#32) The vault check that used to live here was security theater: it always
    // appended the opened doc's OWN parent dir to the allowed set, so it could
    // never reject — `opened.path` always starts_with its own parent. Removing it
    // drops a misleading no-op (and a settings read on every open).
    //
    // Confinement that actually constrains untrusted input is enforced where it
    // matters: `save_file` confines writes to configured vaults, and the commands
    // that take an untrusted `doc_path` (export, annotations, image bytes) are
    // confined to the open-documents set (#85) tracked just below.

    // Track this document as open so the source-read confinement on
    // export/annotation commands can authorize against it. Done regardless of
    // whether the watcher below starts, so a failed watcher never wrongly blocks
    // a legitimately-open document from being exported/annotated (#85).
    open_docs.insert(opened.path.clone());

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
    settings_path: State<'_, crate::SettingsPath>,
    request: SaveFileRequest,
) -> IpcResult<FileResult> {
    // Confinement check + the fd-locked write are blocking fs work — offload to a
    // blocking thread so a large-doc save doesn't stall the IPC command pool
    // (perf #28). `watch_file` (which needs the non-'static AppHandle/State) runs
    // back on the async side after the write returns.
    let settings_path = settings_path.0.clone();
    let (canon, new_hash, path) = tauri::async_runtime::spawn_blocking(
        move || -> IpcResult<(std::path::PathBuf, String, String)> {
            let p = std::path::Path::new(&request.path);

            let canon = std::fs::canonicalize(p)
                .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;
            let settings = crate::settings::get_settings(&settings_path).map_err(|e| IpcError {
                code: "SETTINGS_ERROR".into(),
                message: format!("cannot load settings for confinement check: {e}"),
            })?;

            // Allowed dirs come ONLY from the pre-configured vault list — never
            // from the (frontend-supplied, untrusted) target path, which would let
            // any path authorize its own parent and make confinement a no-op.
            //
            // No vaults configured (first-run) → empty set → unrestricted; once
            // configured every save must be inside them. The confinement itself is
            // now enforced *inside* `file_io::save_file` (#86) so a caller cannot
            // write outside the allowed set by skipping a separate check — we pass
            // the allowed dirs through instead of asserting separately here. We
            // canonicalize against `canon` (symlink-resolved) so confinement is on
            // the real on-disk path.
            let allowed: Vec<std::path::PathBuf> = settings.vaults.iter()
                .filter_map(|v| std::fs::canonicalize(v).ok())
                .collect();

            let new_hash = crate::file_io::save_file(&canon, &request.content, &request.expected_hash, &allowed)
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

/// Confine a frontend-supplied document path to the set of documents the user
/// actually has open, returning its canonical path, before it is read or written.
///
/// `doc_path` comes from the (untrusted) webview. Every command that reads a
/// user-supplied document path — `export_obsidian`, `load_annotations`,
/// `save_annotations`, and `read_file_bytes` (whose image read is rooted at the
/// doc's parent) — routes through this so the confinement cannot drift between
/// them: a path the user never opened is rejected with `PATH_CONFINED`,
/// so a compromised frontend cannot read an arbitrary file (e.g. `~/.ssh/id_rsa`,
/// `/etc/passwd`) and leak it into a vault export or annotation sidecar (#85).
///
/// `open_docs` holds canonical paths (`OpenDocuments`), so we canonicalize the
/// incoming path before comparing — this also collapses symlink/`..`/case
/// variants to the same on-disk identity the open set was keyed by.
fn confine_open_doc(
    doc_path: &str,
    open_docs: &std::collections::HashSet<std::path::PathBuf>,
) -> IpcResult<std::path::PathBuf> {
    let canon = std::fs::canonicalize(doc_path).map_err(|e| IpcError {
        code: "PATH_CONFINED".into(),
        message: format!("doc_path '{doc_path}' could not be resolved: {e}"),
    })?;
    if open_docs.contains(&canon) {
        Ok(canon)
    } else {
        Err(IpcError {
            code: "PATH_CONFINED".into(),
            message: "document must be open before it can be read, exported, or annotated".into(),
        })
    }
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
pub async fn load_annotations(
    open_docs: State<'_, crate::OpenDocuments>,
    doc_path: String,
) -> IpcResult<Sidecar> {
    // Confine the (untrusted) doc_path to a currently-open document before any
    // read, so this command cannot be used to read an arbitrary file (#85).
    let canon = confine_open_doc(&doc_path, &open_docs.snapshot())?;

    // Read the full doc content (we need it for re-anchoring and hashing).
    let doc_content = tauri::async_runtime::spawn_blocking({
        let path = canon.clone();
        move || std::fs::read_to_string(&path)
    })
    .await
    .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?
    .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;

    let doc_hash = crate::file_io::sha256_hex(doc_content.as_bytes());

    let load_result = tauri::async_runtime::spawn_blocking({
        let path = canon.clone();
        let hash = doc_hash.clone();
        move || {
            let p = path.as_path();
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
pub async fn save_annotations(
    open_docs: State<'_, crate::OpenDocuments>,
    doc_path: String,
    sidecar: Sidecar,
) -> IpcResult<()> {
    // Confine the (untrusted) doc_path to a currently-open document before the
    // read + sidecar write (which also touches the nearest .gitignore) (#85).
    let canon = confine_open_doc(&doc_path, &open_docs.snapshot())?;

    // Reads the whole doc + writes the sidecar — blocking fs, offloaded (perf #28).
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<()> {
        let p = canon.as_path();

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
pub async fn export_obsidian(
    open_docs: State<'_, crate::OpenDocuments>,
    settings_path: State<'_, crate::SettingsPath>,
    request: ExportObsidianRequest,
) -> IpcResult<ExportObsidianResult> {
    // Confine the export SOURCE read to a currently-open document before the
    // blocking body reads it: without this, a frontend-supplied doc_path could
    // read any file on disk and push its contents into the vault export (#85).
    let canon_doc = confine_open_doc(&request.doc_path, &open_docs.snapshot())?;
    let settings_path = settings_path.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_obsidian_blocking(request, canon_doc, &settings_path)
    })
    .await
    .map_err(|e| IpcError {
        code: "INTERNAL".into(),
        message: format!("export task failed: {e}"),
    })?
}

/// The blocking body of `export_obsidian` (runs on a blocking thread).
///
/// `canon_doc` is the canonical source path already confined to an open
/// document by the async wrapper (#85); the read below uses it directly.
fn export_obsidian_blocking(
    request: ExportObsidianRequest,
    canon_doc: std::path::PathBuf,
    settings_path: &std::path::PathBuf,
) -> IpcResult<ExportObsidianResult> {
    // Load current settings to get vault list and REST key ref.
    let settings = crate::settings::get_settings(settings_path).map_err(settings_err)?;

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

    // Read document content from the confinement-checked canonical source path.
    let doc_content = std::fs::read_to_string(&canon_doc)
        .map_err(|e| IpcError { code: "IO_ERROR".into(), message: e.to_string() })?;

    // Build vault-relative path: subfolder / filename
    let filename = canon_doc
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
        crate::obsidian::REST_DEFAULT_PORTS,
    ).map_err(obsidian_err)?;

    let (method, destination) = match result {
        crate::obsidian::ExportResult::RestPushed => (
            "rest".to_string(),
            format!("vault/{vault_relative}"),
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
pub async fn get_settings(
    settings_path: State<'_, crate::SettingsPath>,
) -> IpcResult<Settings> {
    // Settings file read — small, but still fs; offloaded for consistency (perf #28).
    let path = settings_path.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<Settings> {
        let settings = crate::settings::get_settings(&path).map_err(settings_err)?;
        Ok(settings_to_ipc(settings))
    })
    .await
    .map_err(task_err)?
}

/// Persist user settings (rest_key is NOT accepted here — use keychain via secrets module).
///
/// A5: The call-site uses `set_settings_preserving_ref` (WS-D D1) instead of the
/// verbatim `set_settings` pass-through. This is the ONLY writer that must
/// preserve the on-disk `rest_key_ref` — the key handlers (`set_rest_key` /
/// `clear_rest_key`) still call the verbatim writer to CHANGE `rest_key_ref`.
/// Single-writer discipline: only the key handlers write `rest_key_ref`; the
/// general settings path never can (it is preserved by this fn).
#[tauri::command]
pub async fn set_settings(
    settings_path: State<'_, crate::SettingsPath>,
    settings: Settings,
) -> IpcResult<()> {
    let path = settings_path.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<()> {
        let store_settings = settings_from_ipc(settings);
        crate::settings::set_settings_preserving_ref(&path, store_settings).map_err(settings_err)
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
///
/// A5 rollback: if the settings write fails after the keychain write succeeds,
/// the keychain entry is deleted to keep the two stores consistent. If the
/// rollback deletion also fails, the error is swallowed (the original
/// settings-write error is returned). This is the documented orphan edge case:
/// on a double-failure the keychain holds a key with no corresponding
/// `rest_key_ref` in settings. No retry is attempted (lessons.md A6). The
/// Windows Credential Manager write→delete race requires real-hardware
/// verification (see lessons.md A6 / `#[ignore]` integration test in
/// settings_tests.rs D3).
/// Reject an empty or whitespace-only REST key at the IPC boundary.
///
/// Storing a blank credential would still flip `rest_key_ref = Some`, leaving the
/// app in a confusing "configured but Unauthorized" state with an empty key in
/// the keychain (#46). We validate the shape only — REST tokens are opaque and
/// have no fixed length, so no length/format check is imposed.
fn validate_rest_key(key: &str) -> IpcResult<()> {
    if key.trim().is_empty() {
        return Err(IpcError {
            code: "INVALID_KEY".into(),
            message: "REST API key must not be empty or whitespace".into(),
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn set_rest_key(
    settings_path: State<'_, crate::SettingsPath>,
    key: String,
) -> IpcResult<Settings> {
    validate_rest_key(&key)?;
    let path = settings_path.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<Settings> {
        // Store the raw key in the OS keychain.
        crate::secrets::store_rest_key("obsidian-rest", &key).map_err(secrets_err)?;
        // Load current settings so we can update the key reference field.
        let mut settings = crate::settings::get_settings(&path).map_err(settings_err)?;
        settings.rest_key_ref = Some("obsidian-rest".to_string());
        // Persist the updated settings (only rest_key_ref changes; key is NOT written).
        // A5: on settings-write failure, roll back the keychain write so the two stores
        // stay consistent. Rollback errors are swallowed; we return the original error.
        crate::settings::set_settings(&path, settings.clone()).map_err(|e| {
            // Attempt rollback — swallow any rollback error (double-failure orphan
            // edge case documented in lessons.md; no retry).
            //
            // Note on the replace-key case: if the user was replacing an existing
            // key (`rest_key_ref` was already `Some` on disk), `delete_rest_key`
            // removes the entry entirely rather than restoring the previous key.
            // The on-disk `rest_key_ref` is therefore left pointing at a now-absent
            // keychain entry until the user re-enters a key.  This is intentional:
            // the stores remain consistent (both indicate no valid key) and is
            // strictly safer than persisting a half-written state.
            let _ = crate::secrets::delete_rest_key("obsidian-rest");
            settings_err(e)
        })?;
        Ok(settings_to_ipc(settings))
    })
    .await
    .map_err(task_err)?
}

/// Remove the Obsidian REST API key from the OS keychain, clear the
/// `rest_key_ref` field in settings, and return the updated `Settings`.
#[tauri::command]
pub async fn clear_rest_key(
    settings_path: State<'_, crate::SettingsPath>,
) -> IpcResult<Settings> {
    let path = settings_path.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<Settings> {
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
pub async fn test_obsidian_connection(
    settings_path: State<'_, crate::SettingsPath>,
    key: Option<String>,
) -> IpcResult<ConnStatus> {
    let path = settings_path.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> IpcResult<ConnStatus> {
        let status = crate::obsidian::test_obsidian_connection(&path, key);
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
/// `doc_path` is itself confined to a currently-open document first (#85):
/// otherwise an untrusted frontend `doc_path` would let any directory authorize
/// reads of *any* file type within it (this command is not extension-restricted),
/// returning the bytes straight to the renderer.
///
/// On failure (path out of bounds, unreadable) returns `IO_ERROR`.  The
/// frontend treats this as a "skip" and degrades to alt text — it must not
/// abort the entire export.
#[tauri::command]
pub fn read_file_bytes(
    open_docs: State<crate::OpenDocuments>,
    doc_path: String,
    image_path: String,
) -> IpcResult<String> {
    let canon_doc = confine_open_doc(&doc_path, &open_docs.snapshot())?;
    let img = std::path::Path::new(&image_path);
    crate::export::read_file_bytes(&canon_doc, img)
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
// Version / update-check commands (A1)
// ---------------------------------------------------------------------------

/// Return the current application version as a string (e.g. "0.1.0").
/// Sourced from CARGO_PKG_VERSION at compile time — always accurate.
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Probe GitHub Releases for a newer version of Revenant.
///
/// Delegates the HTTP request and semver comparison to `crate::updates`.
/// Runs on a `spawn_blocking` thread so the IPC command pool stays responsive
/// during the 3 s network timeout.
///
/// On success returns `IpcResult<UpdateCheck>` (the Ok variant).
/// On failure (network, parse, invalid URL) returns `IpcError` with code
/// `UPDATE_CHECK_FAILED`.
#[tauri::command]
pub async fn check_for_updates() -> IpcResult<UpdateCheck> {
    tauri::async_runtime::spawn_blocking(|| -> IpcResult<UpdateCheck> {
        crate::updates::check_for_updates().map_err(updates_err)
    })
    .await
    .map_err(task_err)?
}

/// Open the Revenant release page in the system browser.
///
/// `url` must be an https URL on github.com under the /slash-hug/revenant/releases
/// path.  Validation is performed inside `crate::updates::open_release_page`
/// before the URL is handed to the OS opener.  Invalid URLs are rejected with
/// `UPDATE_CHECK_FAILED` rather than silently opened (security #open-url).
///
/// The actual browser launch goes through `tauri_plugin_opener` (not a raw
/// `std::process::Command` shell-out) — this preserves the design decision
/// that the app never spawns OS processes directly.
#[tauri::command]
pub fn open_release_page(app: AppHandle, url: String) -> IpcResult<()> {
    use tauri_plugin_opener::OpenerExt;
    crate::updates::open_release_page(&url).map_err(updates_err)?;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| updates_err(crate::updates::UpdatesError::InvalidUrl(e.to_string())))
}

/// Open a rendered Mermaid diagram in a new OS window for focused viewing.
///
/// Creates a new WebviewWindow showing `diagram-viewer.html` with the SVG
/// injected via an initialization script. Supports multiple concurrent popouts
/// (window labels are `diagram-0`, `diagram-1`, etc.).
///
/// `svg` is the sanitized SVG markup. `title` is a human-readable label
/// derived from the nearest heading in the document (or "Untitled").
/// `theme` is the current app theme (`"dark"` or `"light"`) so the popout
/// window can match the main window's appearance.
/// Serialize a string as a valid, fully-escaped JS string literal (including the
/// surrounding double-quotes). Uses `serde_json`, which correctly escapes quotes,
/// backslashes, and control characters.
///
/// JSON permits raw U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR),
/// but in pre-ES2019 JS engines these terminate a string literal. To stay safe
/// across engines we additionally escape them to their `\uXXXX` forms — they
/// round-trip identically through the JS parser.
fn js_string_literal(s: &str) -> Result<String, serde_json::Error> {
    let json = serde_json::to_string(s)?;
    let escaped = json
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Ok(escaped)
}

#[tauri::command]
pub async fn open_diagram_window(
    app: AppHandle,
    svg: String,
    title: String,
    theme: String,
) -> IpcResult<()> {
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("diagram-{}", id);

    // Serialize each interpolated value as a fully-escaped JS string literal
    // (serde_json emits the surrounding double-quotes and handles every escape,
    // including U+2028/U+2029 line/paragraph separators that break naive escaping).
    let to_window_err = |e: serde_json::Error| IpcError {
        code: "WINDOW_ERROR".to_string(),
        message: format!("Failed to serialize diagram init script: {}", e),
    };
    let svg_js = js_string_literal(&svg).map_err(to_window_err)?;
    let title_js = js_string_literal(&title).map_err(to_window_err)?;
    let theme_value = if theme == "light" { "light" } else { "dark" };
    let theme_js = js_string_literal(theme_value).map_err(to_window_err)?;

    let init_script = format!(
        "window.__DIAGRAM_SVG__ = {}; window.__DIAGRAM_TITLE__ = {}; document.documentElement.setAttribute('data-theme', {});",
        svg_js, title_js, theme_js
    );

    let window_title = if title.is_empty() {
        "Diagram".to_string()
    } else {
        format!("Diagram — {}", title)
    };

    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("diagram-viewer.html".into()))
        .title(&window_title)
        .inner_size(800.0, 600.0)
        .min_inner_size(400.0, 300.0)
        .resizable(true)
        .initialization_script(&init_script)
        .build()
        .map_err(|e| IpcError {
            code: "WINDOW_ERROR".to_string(),
            message: format!("Failed to create diagram window: {}", e),
        })?;

    // Focus the new window so it appears in front on Windows/macOS.
    let _ = window.set_focus();

    Ok(())
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------
//
// The settings file path is no longer derived here from HOME/APPDATA. It is
// resolved once at startup from Tauri's `app_config_dir()` and held in
// `crate::SettingsPath` managed state, so every command shares one source of
// truth and the path cannot desync from the real config location (#13).

#[cfg(test)]
mod ipc_tests {
    use super::js_string_literal;

    // ── #46: REST key shape validation (validate_rest_key) ────────────────────
    use super::validate_rest_key;

    #[test]
    fn validate_rest_key_rejects_empty_and_whitespace() {
        assert!(validate_rest_key("").is_err());
        assert!(validate_rest_key("   ").is_err());
        assert!(validate_rest_key("\t\n ").is_err());
    }

    #[test]
    fn validate_rest_key_accepts_a_real_key() {
        assert!(validate_rest_key("abc123").is_ok());
        // Surrounding whitespace is allowed as long as there's real content
        // (we validate shape, not format, and don't mutate the stored key).
        assert!(validate_rest_key("  abc123  ").is_ok());
    }

    // ── #85: source-read confinement (confine_open_doc) ───────────────────────
    use super::confine_open_doc;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn confine_open_doc_accepts_currently_open_document() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("note.md");
        std::fs::write(&f, "x").unwrap();
        let canon = std::fs::canonicalize(&f).unwrap();
        let mut open = HashSet::new();
        open.insert(canon.clone());
        assert_eq!(confine_open_doc(f.to_str().unwrap(), &open).unwrap(), canon);
    }

    #[test]
    fn confine_open_doc_rejects_unopened_document() {
        // A real, readable file that the user never opened must be rejected — this
        // is the exfiltration target (e.g. a secret file) the fix exists to block.
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("secret.md");
        std::fs::write(&f, "x").unwrap();
        let open: HashSet<PathBuf> = HashSet::new();
        assert!(confine_open_doc(f.to_str().unwrap(), &open).is_err());
    }

    #[test]
    fn confine_open_doc_rejects_nonexistent_path() {
        let open: HashSet<PathBuf> = HashSet::new();
        assert!(confine_open_doc("/no/such/file/xyzzy.md", &open).is_err());
    }

    // On case-insensitive filesystems (default macOS APFS) a differently-cased
    // path refers to the same file; `canonicalize` must normalize it to the same
    // on-disk identity the open set was keyed by, so an open doc isn't wrongly
    // rejected. This test verifies that property where it matters.
    #[cfg(target_os = "macos")]
    #[test]
    fn confine_open_doc_accepts_case_variant_of_open_doc() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("Note.md");
        std::fs::write(&f, "x").unwrap();
        let canon = std::fs::canonicalize(&f).unwrap();
        let mut open = HashSet::new();
        open.insert(canon.clone());
        // Query with a lowercased filename — same file on case-insensitive APFS.
        let lowercased = dir.path().join("note.md");
        let got = confine_open_doc(lowercased.to_str().unwrap(), &open);
        assert!(
            got.is_ok(),
            "a case-variant path to an open document must resolve to the same canonical path"
        );
        assert_eq!(got.unwrap(), canon);
    }

    #[test]
    fn js_string_literal_escapes_quotes_and_backslashes() {
        assert_eq!(js_string_literal("a\"b").unwrap(), "\"a\\\"b\"");
        assert_eq!(js_string_literal("a\\b").unwrap(), "\"a\\\\b\"");
    }

    #[test]
    fn js_string_literal_escapes_newlines() {
        assert_eq!(js_string_literal("a\nb\r").unwrap(), "\"a\\nb\\r\"");
    }

    #[test]
    fn js_string_literal_escapes_script_terminator() {
        // serde_json escapes the forward slash's `<`/`>` neighbors are left as-is,
        // but the closing-tag sequence must not break out of an inline <script>.
        // serde_json escapes `<`? No — it leaves `<`/`>` literal, so verify the
        // literal is still a valid, quote-delimited JS string (no premature close).
        let out = js_string_literal("</script>").unwrap();
        assert!(out.starts_with('"') && out.ends_with('"'));
        assert!(!out[1..out.len() - 1].contains('"'));
    }

    #[test]
    fn js_string_literal_escapes_line_paragraph_separators() {
        // U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR terminate JS
        // string literals; serde_json escapes them as   /  .
        assert_eq!(js_string_literal("a\u{2028}b").unwrap(), "\"a\\u2028b\"");
        assert_eq!(js_string_literal("a\u{2029}b").unwrap(), "\"a\\u2029b\"");
    }
}

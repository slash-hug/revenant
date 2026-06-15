// Revenant — library root
// IPC command handlers + plugin wiring.
// Sub-module stubs allow WS-B/C/D to fill implementations without editing this file.

pub mod ipc;
pub mod export;

// Integration tests (all workstreams). Compiled only in test builds so they
// never ship in the production binary.
#[cfg(test)]
mod tests;

// Data-layer modules (WS-B implements these)
pub mod file_io;
pub mod annotations;
pub mod reanchor;
pub mod frontmatter;
pub mod paths;

// Settings + secrets + Obsidian modules (WS-D implements these)
pub mod settings;
pub mod secrets;
pub mod obsidian;

// Update-check engine (WS-D implements the body; WS-A declares the module).
pub mod updates;

// Native macOS WKWebView snapshot (open-transition document capture).
#[cfg(target_os = "macos")]
pub mod snapshot;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::Emitter;

/// Live, per-path file watchers. Held in Tauri-managed state so a single watcher
/// per open document stays alive for the app's lifetime and `open_file` /
/// `save_file` can refresh it. Wired in `ipc::watch_file`.
#[derive(Default)]
pub struct FileWatchers {
    pub inner: Mutex<HashMap<PathBuf, WatchHandle>>,
}

/// A single document's watcher plus the hash of the last content this process
/// wrote, used to distinguish our own saves from external edits.
pub struct WatchHandle {
    /// Kept alive to keep the OS watch registered; dropping it stops watching.
    pub _watcher: notify::RecommendedWatcher,
    /// Shared with the watcher callback; refreshed on each save_file.
    pub last_written: Arc<Mutex<Option<String>>>,
}

impl FileWatchers {
    /// Stop watching `path`, releasing its OS watcher + thread (called when the
    /// document's tab closes — without this every opened file leaks a watcher for
    /// the app's lifetime, #26). The map is keyed by canonical path, and the
    /// frontend passes the canonical path it got from `open_file`; canonicalize
    /// anyway (idempotent) and fall back to the raw path if the file is now gone.
    /// No-op if the path isn't being watched.
    pub fn unwatch(&self, path: &str) {
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        map.remove(&key);
    }

    /// Number of live watchers (test-only).
    #[cfg(test)]
    pub fn watch_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }
}

/// Resolve a CLI path argument to an absolute path.
///
/// If `path` is already absolute, return it as-is. Otherwise, join it onto
/// `cwd` (the working directory at capture time) and canonicalize. Falls back
/// to the joined-but-uncanonicalized path if the file doesn't exist yet.
fn resolve_cli_path(path: &str, cwd: &str) -> String {
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        return path.to_string();
    }
    let joined = std::path::Path::new(cwd).join(p);
    // Try canonicalize (resolves symlinks, normalizes ./ and ../);
    // fall back to the joined path if the file doesn't exist yet.
    std::fs::canonicalize(&joined)
        .unwrap_or(joined)
        .to_string_lossy()
        .into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(FileWatchers::default())
        // No tauri-plugin-fs: all file I/O is routed through our own #[command]s
        // (path-confined in paths.rs). Registering the fs plugin would expose its
        // commands to the webview the moment any `fs:` capability were added,
        // bypassing that confinement — so it stays out entirely (security #23).
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_single_instance::init(|app, argv, cwd| {
                // When a second instance is launched (e.g., `revenant another.md`),
                // forward the file path argument to the already-running instance via
                // the `open_file_request` event so the frontend can open a new tab.
                // The webview is already loaded here, so emit immediately.
                //
                // Resolve relative paths against `cwd` (the second instance's working
                // directory) — the running instance's CWD differs from the terminal.
                if let Some(path) = argv.get(1) {
                    if !path.starts_with('-') {
                        let resolved = resolve_cli_path(path, &cwd);
                        let _ = app.emit("open_file_request", resolved);
                    }
                }
            }),
        )
        .setup(|app| {
            // Cold-start CLI argument: `revenant <file.md>`.
            //
            // We read argv directly (rather than via the cli plugin's parsed
            // matches) so a positional path works without extra config. The emit
            // is deferred briefly because `setup` runs before the webview has
            // registered its `open_file_request` listener — emitting synchronously
            // here would be missed. The single-instance path above does not need
            // this delay (its window already exists).
            //
            // Resolve relative paths against the process CWD at startup so the
            // path is absolute before the event reaches the frontend.
            if let Some(path) = std::env::args().nth(1) {
                if !path.starts_with('-') {
                    let cwd = std::env::current_dir().unwrap_or_default();
                    let resolved = resolve_cli_path(&path, &cwd.to_string_lossy());
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(700));
                        let _ = handle.emit("open_file_request", resolved);
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::open_file,
            ipc::unwatch_file,
            ipc::save_file,
            ipc::load_annotations,
            ipc::save_annotations,
            ipc::generate_review,
            ipc::export_obsidian,
            ipc::get_settings,
            ipc::set_settings,
            ipc::snapshot_webview,
            // Export commands (A3)
            ipc::export_html,
            ipc::export_pdf,
            ipc::read_file_bytes,
            // Settings / keychain commands (A3 — new surface)
            ipc::set_rest_key,
            ipc::clear_rest_key,
            ipc::has_rest_key,
            ipc::test_obsidian_connection,
            // Version / update-check commands (A4)
            ipc::get_app_version,
            ipc::check_for_updates,
            ipc::open_release_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

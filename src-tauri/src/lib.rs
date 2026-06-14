// Revenant — library root
// IPC command handlers + plugin wiring.
// Sub-module stubs allow WS-B/C/D to fill implementations without editing this file.

pub mod ipc;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(FileWatchers::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_single_instance::init(|app, argv, _cwd| {
                // When a second instance is launched (e.g., `revenant another.md`),
                // forward the file path argument to the already-running instance via
                // the `open_file_request` event so the frontend can open a new tab.
                // The webview is already loaded here, so emit immediately.
                if let Some(path) = argv.get(1) {
                    if !path.starts_with('-') {
                        let _ = app.emit("open_file_request", path);
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
            if let Some(path) = std::env::args().nth(1) {
                if !path.starts_with('-') {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(700));
                        let _ = handle.emit("open_file_request", path);
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::open_file,
            ipc::save_file,
            ipc::load_annotations,
            ipc::save_annotations,
            ipc::generate_review,
            ipc::export_obsidian,
            ipc::get_settings,
            ipc::set_settings,
            ipc::snapshot_webview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

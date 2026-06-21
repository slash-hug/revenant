// Revenant — library root
// IPC command handlers + plugin wiring.
// Sub-module stubs allow WS-B/C/D to fill implementations without editing this file.

pub mod ipc;
pub mod export;

// Shared schema-envelope policy for the versioned on-disk stores
// (settings + annotation sidecars). One home for the "missing version → 0"
// decision so the two stores can't re-diverge — see issue #13 item J.
pub mod schema;

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

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

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

/// Absolute path to `settings.json`, resolved once at startup from Tauri's real
/// app-config dir (`app_config_dir()`) and held in managed state. Every command
/// that reads or writes settings goes through this single source of truth, so the
/// path can no longer desync from the actual config location — previously each
/// caller re-derived it from `HOME`/`APPDATA`, and a wrong path silently read
/// empty settings, which could flip `save_file` into its unrestricted "first-run"
/// branch (#13).
pub struct SettingsPath(pub PathBuf);

/// The set of documents the user currently has open, keyed by canonical path.
///
/// Populated by `open_file` whenever a document is opened — **independently of
/// whether its OS watcher started** (watcher startup can fail on Windows+AV or
/// when the OS runs out of watch descriptors). Cleared by `unwatch_file` on tab
/// close. This is the authorization source for commands that read or write a
/// frontend-supplied document path (`export_obsidian`, `load_annotations`,
/// `save_annotations`): a file the user never opened is not in this set, so a
/// compromised frontend cannot trick those commands into reading an arbitrary
/// file (e.g. `~/.ssh/id_rsa`) and leaking it into a vault export or sidecar
/// (#85). Distinct from `FileWatchers`, whose membership depends on the watch
/// succeeding — which is exactly why we do not reuse it for authorization.
///
/// Two properties to preserve:
/// - **One path = one entry, no refcount.** `unwatch_file` removes the single
///   entry on tab close. This is safe only because the frontend dedupes opens by
///   path (focus-existing-tab), so a path is never open in two tabs at once. A
///   future duplicate-tab / multi-window feature that breaks that invariant would
///   need this set to become refcounted, or closing one tab would wrongly revoke
///   a still-open document.
/// - **Stale entries fail safe.** If the frontend never calls `unwatch_file`
///   (renderer crash, hard kill), an entry lingers for the process lifetime. The
///   residual exposure is bounded to a path the user *did* open this session, so
///   it is a confused-deputy non-escalation, not an arbitrary-read.
#[derive(Default)]
pub struct OpenDocuments {
    pub inner: Mutex<HashSet<PathBuf>>,
}

impl OpenDocuments {
    /// Mark `canonical` (a canonical path) as open. Idempotent.
    pub fn insert(&self, canonical: PathBuf) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(canonical);
    }

    /// Mark a path as closed (tab closed). The frontend passes the canonical path
    /// it got from `open_file`; canonicalize anyway (idempotent) and fall back to
    /// the raw path if the file is now gone. No-op if not present.
    pub fn remove(&self, path: &str) {
        let key = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&key);
    }

    /// Snapshot the open set so callers can drop the lock before async/blocking
    /// work (a `MutexGuard` must not be held across an `.await` / `spawn_blocking`).
    pub fn snapshot(&self) -> HashSet<PathBuf> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// Resolve a CLI path argument to an absolute path.
///
/// If `path` is already absolute, return it as-is. Otherwise, join it onto
/// `cwd` (the working directory at capture time) and canonicalize. Falls back
/// to the joined-but-uncanonicalized path if the file doesn't exist yet.
/// Pick the first CLI argument that is a file path rather than a flag.
///
/// Returns the first argument that does NOT start with `-`, so a path passed
/// after a flag (e.g. `revenant --foo file.md`) is still found. Shared by the
/// single-instance handler and the cold-start path so both behave identically.
///
/// Note: callers pass the full argv slice *including* `argv[0]` (the program
/// name); since the program name is itself not flag-prefixed, callers skip it
/// before calling this helper.
fn first_file_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().find(|arg| !arg.starts_with('-'))
}

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
        .manage(OpenDocuments::default())
        // No tauri-plugin-fs: all file I/O is routed through our own #[command]s
        // (path-confined in paths.rs). Registering the fs plugin would expose its
        // commands to the webview the moment any `fs:` capability were added,
        // bypassing that confinement — so it stays out entirely (security #23).
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_single_instance::init(|app, argv, cwd| {
                // When a second instance is launched (e.g., `revenant another.md`),
                // forward the file path argument to the already-running instance via
                // the `open_file_request` event so the frontend can open a new tab.
                // The webview is already loaded here, so emit immediately.
                //
                // Resolve relative paths against `cwd` (the second instance's working
                // directory) — the running instance's CWD differs from the terminal.
                // Skip argv[0] (program name); take the first non-flag argument so
                // a path passed after a flag (e.g. `revenant --foo file.md`) works.
                if let Some(path) = first_file_arg(argv.into_iter().skip(1)) {
                    let resolved = resolve_cli_path(&path, &cwd);
                    let _ = app.emit("open_file_request", resolved);
                }
            }),
        )
        .setup(|app| {
            // Resolve the settings.json location ONCE, from Tauri's real
            // app-config dir, and stash it in managed state so every command
            // shares one source of truth (#13). On `com.codelogiq.revenant` this
            // resolves to the same path the old HOME/APPDATA derivation produced,
            // so existing settings carry over with no migration.
            let settings_path = app
                .path()
                .app_config_dir()
                .map_err(|e| format!("could not resolve app config dir: {e}"))?
                .join("settings.json");
            app.manage(SettingsPath(settings_path));

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
            // Skip argv[0] (program name); take the first non-flag argument so a
            // path passed after a flag (e.g. `revenant --foo file.md`) works.
            if let Some(path) = first_file_arg(std::env::args().skip(1)) {
                let cwd = std::env::current_dir().unwrap_or_default();
                let resolved = resolve_cli_path(&path, &cwd.to_string_lossy());
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // The 700ms delay gives the webview time to mount and register
                    // its `open_file_request` listener; emitting sooner would be
                    // missed since `setup` runs before the frontend is ready.
                    // FOLLOW-UP: replace this fixed sleep with a frontend "ready"
                    // handshake — deferred because it needs live cold-start
                    // verification of the native app, which can't be done headless.
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    let _ = handle.emit("open_file_request", resolved);
                });
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

#[cfg(test)]
mod lib_tests {
    use super::first_file_arg;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn returns_path_when_first_arg() {
        assert_eq!(
            first_file_arg(args(&["file.md"])),
            Some("file.md".to_string())
        );
    }

    #[test]
    fn returns_path_after_flag() {
        assert_eq!(
            first_file_arg(args(&["--foo", "file.md"])),
            Some("file.md".to_string())
        );
    }

    #[test]
    fn returns_none_when_only_flags() {
        assert_eq!(first_file_arg(args(&["--foo", "-b"])), None);
    }

    #[test]
    fn returns_none_when_empty() {
        assert_eq!(first_file_arg(args(&[])), None);
    }
}

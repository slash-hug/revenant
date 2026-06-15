//! watcher_tests.rs — FileWatchers lifecycle (#26).
//!
//! Watchers were inserted on open/save but never removed, leaking one OS watcher
//! + thread per opened file for the app's lifetime. `unwatch` (called on tab
//! close) must drop the handle, which stops the OS watch.

use crate::FileWatchers;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

/// Insert a real watcher the way `ipc::watch_file` does.
fn insert_watch(watchers: &FileWatchers, canon: &std::path::Path) {
    let last = Arc::new(Mutex::new(Some("h".to_string())));
    let watcher =
        crate::file_io::spawn_watcher(canon.to_path_buf(), last.clone(), |_| {}).unwrap();
    watchers.inner.lock().unwrap().insert(
        canon.to_path_buf(),
        crate::WatchHandle { _watcher: watcher, last_written: last },
    );
}

#[test]
fn unwatch_releases_the_watcher_handle() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.md");
    std::fs::write(&path, "hello").unwrap();
    let canon = std::fs::canonicalize(&path).unwrap();

    let watchers = FileWatchers::default();
    insert_watch(&watchers, &canon);
    assert_eq!(watchers.watch_count(), 1);

    // The frontend passes the canonical path it received from open_file.
    watchers.unwatch(&canon.to_string_lossy());
    assert_eq!(watchers.watch_count(), 0, "watcher handle should be dropped on unwatch");

    // Idempotent — unwatching an already-removed path is a no-op.
    watchers.unwatch(&canon.to_string_lossy());
    assert_eq!(watchers.watch_count(), 0);
}

#[test]
fn unwatch_unknown_path_is_noop() {
    let watchers = FileWatchers::default();
    watchers.unwatch("/no/such/file.md");
    assert_eq!(watchers.watch_count(), 0);
}

#[test]
fn unwatch_still_drops_handle_when_file_is_gone() {
    // If the file was deleted before the tab closed, canonicalize() fails; unwatch
    // must fall back to the raw (canonical) path it was given and still remove it.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.md");
    std::fs::write(&path, "hello").unwrap();
    let canon = std::fs::canonicalize(&path).unwrap();

    let watchers = FileWatchers::default();
    insert_watch(&watchers, &canon);
    assert_eq!(watchers.watch_count(), 1);

    std::fs::remove_file(&path).unwrap();
    watchers.unwatch(&canon.to_string_lossy());
    assert_eq!(watchers.watch_count(), 0);
}

//! File I/O with optimistic concurrency and file-watcher support.
//!
//! Architecture decisions implemented here:
//! - A5/C6: `save_file(path, content, expected_hash)` — sha256 hash-based
//!   optimistic concurrency.  A mismatch (disk content changed since the caller
//!   last read it) returns `FileIoError::HashMismatch` and never writes.
//! - A7: `.md` extension validation + path confinement (delegated to
//!   `crate::paths`).
//! - Spec §6: friendly errors; no silent failures.
//!
//! # File-watcher
//! `spawn_watcher` starts a background thread using the `notify` crate. It
//! emits `file_changed` events (path + whether the change was external, i.e.
//! not triggered by this process's own `save_file` call).  In a full Tauri
//! build the events are re-emitted via the Tauri app handle; here we expose a
//! generic callback interface so the module is testable without Tauri.

use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::paths::{assert_markdown, PathError};

/// Error type for file I/O operations.
#[derive(Debug, thiserror::Error)]
pub enum FileIoError {
    #[error("Only .md files are supported: {0}")]
    NotMarkdown(PathBuf),

    #[error("Hash mismatch — file was modified on disk since last read. Reload and try again.")]
    HashMismatch {
        expected: String,
        actual: String,
    },

    #[error("Path error: {0}")]
    Path(#[from] PathError),

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}

impl From<FileIoError> for String {
    fn from(e: FileIoError) -> Self {
        e.to_string()
    }
}

/// The result of opening a file.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedFile {
    /// Canonicalized path.
    pub path: PathBuf,
    /// UTF-8 file content.
    pub content: String,
    /// sha256 hex digest of `content` (used as the `expected_hash` in the next
    /// `save_file` call).
    pub content_hash: String,
}

/// Read a `.md` file from disk.
///
/// Returns the content and its sha256 hex digest so the caller can pass the
/// hash back to `save_file` for optimistic-concurrency checking.
///
/// Errors if `path` is not a `.md` file or cannot be read.
pub fn open_file(path: &Path) -> Result<OpenedFile, FileIoError> {
    // Validate extension before attempting I/O.
    assert_markdown(path).map_err(|_| FileIoError::NotMarkdown(path.to_path_buf()))?;

    let content = fs::read_to_string(path)?;
    let content_hash = sha256_hex(content.as_bytes());
    let canonical = fs::canonicalize(path)?;

    Ok(OpenedFile {
        path: canonical,
        content,
        content_hash,
    })
}

/// Write `content` to `path` — but only if the current on-disk content matches
/// `expected_hash`.
///
/// Returns the new sha256 hash on success (the caller should store it for the
/// next save).
///
/// Returns `FileIoError::HashMismatch` if the disk has changed since the
/// caller's last read, without writing anything (optimistic concurrency per
/// A5/C6).
///
/// Also rejects non-`.md` paths.
///
/// # Arguments
/// * `path`          - Target file path (must have `.md` extension).
/// * `content`       - New content to write.
/// * `expected_hash` - sha256 hex digest the caller received from the last
///   `open_file` or successful `save_file`.
pub fn save_file(
    path: &Path,
    content: &str,
    expected_hash: &str,
) -> Result<String, FileIoError> {
    // Validate extension.
    assert_markdown(path).map_err(|_| FileIoError::NotMarkdown(path.to_path_buf()))?;

    // Read current disk content and compare hashes.
    let disk_content = fs::read_to_string(path)?;
    let actual_hash = sha256_hex(disk_content.as_bytes());

    if actual_hash != expected_hash {
        return Err(FileIoError::HashMismatch {
            expected: expected_hash.to_string(),
            actual: actual_hash,
        });
    }

    // Hashes match — safe to write.
    fs::write(path, content.as_bytes())?;
    let new_hash = sha256_hex(content.as_bytes());
    Ok(new_hash)
}

/// Compute the sha256 hex digest of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    hex::encode(result)
}

/// A file-change event emitted by the watcher.
#[derive(Debug, Clone, PartialEq)]
pub struct FileChangedEvent {
    /// Canonicalized path of the changed file.
    pub path: PathBuf,
    /// `true` if the change originated outside this process (i.e., an external
    /// editor or filesystem operation).  `false` for writes this process made
    /// via `save_file` (tracked via `last_written`).
    pub external: bool,
}

/// Spawn a file watcher for `watch_path`.
///
/// `on_change` is called on a background thread each time the file is modified.
/// The `external` field is `true` when the modification was NOT caused by this
/// process (determined by comparing against the hash stored in `last_written`).
///
/// Returns a handle that keeps the watcher alive.  Drop the handle to stop
/// watching.
///
/// # Note
/// In the full Tauri integration, `on_change` would emit a Tauri event via the
/// app handle.  The callback interface used here is framework-agnostic so the
/// module is unit-testable.
pub fn spawn_watcher<F>(
    watch_path: PathBuf,
    last_written: Arc<Mutex<Option<String>>>,
    on_change: F,
) -> Result<notify::RecommendedWatcher, FileIoError>
where
    F: Fn(FileChangedEvent) + Send + 'static,
{
    use notify::{Event, EventKind, RecursiveMode, Watcher};

    let path_for_watcher = watch_path.clone();
    let mut watcher = notify::RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let is_modify = matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_)
                );
                if !is_modify {
                    return;
                }

                // Re-read to get the hash.
                let current_hash = fs::read(path_for_watcher.clone())
                    .map(|bytes| sha256_hex(&bytes))
                    .ok();

                let external = {
                    let guard = last_written.lock().unwrap_or_else(|e| e.into_inner());
                    // It's external if we have no record of writing this hash.
                    !guard.as_deref().eq(&current_hash.as_deref())
                };

                on_change(FileChangedEvent {
                    path: path_for_watcher.clone(),
                    external,
                });
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    watcher
        .watch(&watch_path, RecursiveMode::NonRecursive)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_tmp_md(dir: &TempDir, name: &str, content: &str) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, content).unwrap();
        path
    }

    // ── open_file tests ───────────────────────────────────────────────────────

    #[test]
    fn open_file_returns_content_and_hash() {
        let dir = TempDir::new().unwrap();
        let path = write_tmp_md(&dir, "test.md", "# Hello");
        let opened = open_file(&path).unwrap();
        assert_eq!(opened.content, "# Hello");
        assert_eq!(opened.content_hash, sha256_hex(b"# Hello"));
    }

    #[test]
    fn open_file_rejects_non_md() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.txt");
        fs::write(&path, "text").unwrap();
        let err = open_file(&path).unwrap_err();
        assert!(matches!(err, FileIoError::NotMarkdown(_)));
    }

    // ── save_file tests ───────────────────────────────────────────────────────

    #[test]
    fn save_file_round_trip() {
        let dir = TempDir::new().unwrap();
        let path = write_tmp_md(&dir, "doc.md", "original");
        let opened = open_file(&path).unwrap();

        let new_hash = save_file(&path, "updated", &opened.content_hash).unwrap();
        assert_eq!(new_hash, sha256_hex(b"updated"));

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, "updated");
    }

    #[test]
    fn save_file_hash_mismatch_rejects_write() {
        let dir = TempDir::new().unwrap();
        let path = write_tmp_md(&dir, "doc.md", "original");

        // Simulate external write — change disk without updating expected_hash.
        fs::write(&path, "external change").unwrap();

        let stale_hash = sha256_hex(b"original");
        let err = save_file(&path, "my change", &stale_hash).unwrap_err();
        assert!(matches!(err, FileIoError::HashMismatch { .. }));

        // File must remain at the externally-written content.
        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, "external change");
    }

    #[test]
    fn save_file_rejects_non_md() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.txt");
        fs::write(&path, "text").unwrap();
        let err = save_file(&path, "new", "anyhash").unwrap_err();
        assert!(matches!(err, FileIoError::NotMarkdown(_)));
    }

    // ── sha256_hex ────────────────────────────────────────────────────────────

    #[test]
    fn sha256_hex_is_deterministic() {
        let h1 = sha256_hex(b"hello world");
        let h2 = sha256_hex(b"hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // 256 bits → 64 hex chars
    }

    #[test]
    fn sha256_hex_differs_on_different_input() {
        assert_ne!(sha256_hex(b"foo"), sha256_hex(b"bar"));
    }
}

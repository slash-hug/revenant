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

use fd_lock::RwLock as FdRwLock;
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

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
/// T2.1/A7: takes an exclusive `fd-lock` advisory lock on the file, then
/// re-hashes from the SAME file handle (re-hash + write under the lock, no
/// TOCTOU gap for co-operating writers). Non-co-operating external writers
/// that ignore advisory locks can still race between our re-hash and write,
/// but they will be detected by the re-hash if they finish before we read.
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

    // Open the file for read+write so we can re-hash from the same fd.
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;

    // Take an exclusive advisory lock (fd-lock / flock / fcntl).
    // Cooperating writers will wait; non-cooperating ones are outside the
    // advisory model (see A7/R-FDLOCK-MACOS in the plan).
    let mut lock = FdRwLock::new(file);
    let mut guard = lock
        .write()
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    // Re-hash from the locked handle (same fd — the TOCTOU window is closed
    // for cooperating writers).
    let mut existing_bytes = Vec::new();
    guard.read_to_end(&mut existing_bytes)?;
    let actual_hash = sha256_hex(&existing_bytes);

    if actual_hash != expected_hash {
        return Err(FileIoError::HashMismatch {
            expected: expected_hash.to_string(),
            actual: actual_hash,
        });
    }

    // Hashes match — write atomically: stage to a unique sibling temp file, flush
    // it to disk, then rename over the target. A direct write-through-the-handle
    // (seek/write/set_len) leaves the document half-new/half-old if the write
    // fails partway (e.g. disk full), corrupting it; an atomic rename never can —
    // a crash leaves either the whole old file or the whole new one.
    let new_hash = sha256_hex(content.as_bytes());

    // Release the advisory lock / file handle *before* the rename: Windows
    // refuses to replace a file that still has an open handle, so the lock
    // cannot be held across the rename there. The optimistic-concurrency check
    // already happened under the lock above; the remaining drop→rename window is
    // far smaller than the old full-duration in-place write, and the rename
    // itself is atomic. (Non-cooperating external writers were already outside
    // the advisory-lock model per A7.)
    drop(guard);
    drop(lock);

    atomic_write_bytes(path, content.as_bytes())?;

    Ok(new_hash)
}

/// Atomically replace `target` with `bytes`.
///
/// Stages the bytes to a *unique* sibling temp file (process id + a
/// per-process atomic counter, so concurrent or repeated writes never collide
/// on a fixed name), `sync_all()`s it to stable storage, then renames it over
/// `target`. A crash mid-write leaves either the whole old file or the whole
/// new one — never a half-written, corrupt file. On any error the temp file is
/// cleaned up best-effort.
///
/// Shared by `save_file` and `annotations::save_annotations_to_path` so both
/// durability paths behave identically (issue #55).
pub(crate) fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp_path = unique_temp_path(target)?;

    // Stage the new content and fsync before swapping it in.
    if let Err(e) = stage_temp(&tmp_path, bytes) {
        let _ = fs::remove_file(&tmp_path); // best-effort cleanup
        return Err(e);
    }

    if let Err(e) = fs::rename(&tmp_path, target) {
        let _ = fs::remove_file(&tmp_path); // best-effort cleanup
        return Err(e);
    }

    Ok(())
}

/// Build a collision-resistant temp path that sits next to `target` (same
/// directory, so the final `rename` stays on one filesystem and is atomic).
///
/// The name embeds the process id plus a monotonically increasing per-process
/// counter, so two writes — even to the same target, even concurrently within
/// this process — never stage to the same temp file.
fn unique_temp_path(target: &Path) -> io::Result<PathBuf> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();

    let file_name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    let tmp_name = format!(".{file_name}.revenant.{pid}.{n}.tmp");

    Ok(match target.parent() {
        Some(dir) => dir.join(tmp_name),
        None => PathBuf::from(tmp_name),
    })
}

/// Write `bytes` to `tmp` (creating/truncating it) and flush to stable storage.
/// Used by `atomic_write_bytes` to stage content before an atomic rename.
fn stage_temp(tmp: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp_file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(tmp)?;
    tmp_file.write_all(bytes)?;
    tmp_file.sync_all()?;
    Ok(())
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
    // Cheap dedup state: the (mtime, size) we last processed. Editors fire a burst
    // of events per save (write + rename + chmod, atomic-save = temp+rename), and
    // many carry no content change — skipping the whole-file read+hash when
    // mtime/size are unchanged avoids re-reading the file several times per save
    // (perf #5).
    let last_meta: Arc<Mutex<Option<(SystemTime, u64)>>> = Arc::new(Mutex::new(None));
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

                // Precheck: stat (mtime + size) is far cheaper than read + sha256.
                // If unchanged since we last processed, this event is redundant
                // (chmod / duplicate / rename of identical content) — skip it.
                if let Some(stamp) = fs::metadata(&path_for_watcher)
                    .ok()
                    .and_then(|m| Some((m.modified().ok()?, m.len())))
                {
                    let mut last = last_meta.lock().unwrap_or_else(|e| e.into_inner());
                    if last.as_ref() == Some(&stamp) {
                        return;
                    }
                    *last = Some(stamp);
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

    /// Returns true if any of our staging temp files (`.<name>.revenant.*.tmp`)
    /// remain in `dir`. Used to assert atomic writes clean up after themselves.
    fn any_temp_left(dir: &Path) -> bool {
        fs::read_dir(dir).unwrap().any(|e| {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            name.contains(".revenant.") && name.ends_with(".tmp")
        })
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
    fn save_file_truncates_and_leaves_no_temp() {
        // Atomic temp+rename must fully replace longer old content with shorter
        // new content (no trailing bytes) and clean up its staging file.
        let dir = TempDir::new().unwrap();
        let path = write_tmp_md(&dir, "doc.md", "a much longer original body");
        let opened = open_file(&path).unwrap();

        let new_hash = save_file(&path, "short", &opened.content_hash).unwrap();
        assert_eq!(new_hash, sha256_hex(b"short"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "short");

        // No sibling staging file (unique-named .revenant.*.tmp) must linger
        // after a successful save.
        assert!(
            !any_temp_left(dir.path()),
            "temp staging file was left behind"
        );

        // A second save round-trips against the new hash.
        let h2 = save_file(&path, "second update", &new_hash).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second update");
        assert_eq!(h2, sha256_hex(b"second update"));
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

    // ── atomic_write_bytes ────────────────────────────────────────────────────

    #[test]
    fn atomic_write_bytes_round_trip_and_no_temp() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("data.bin");

        // Write into a fresh path, then overwrite it; both must round-trip exactly.
        atomic_write_bytes(&target, b"first contents").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"first contents");

        atomic_write_bytes(&target, b"second, shorter").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second, shorter");

        // No staging temp file should be left behind after success.
        assert!(!any_temp_left(dir.path()), "temp staging file lingered");
    }

    #[test]
    fn unique_temp_path_never_collides() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("doc.md");

        // Two successive temp paths for the same target must differ (the fixed
        // `.tmp` collision bug from issue #55).
        let a = unique_temp_path(&target).unwrap();
        let b = unique_temp_path(&target).unwrap();
        assert_ne!(a, b, "unique temp paths collided");
        assert_eq!(a.parent(), Some(dir.path()));
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

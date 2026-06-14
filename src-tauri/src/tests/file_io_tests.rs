//! Integration-level tests for file_io.rs.
//!
//! Unit tests are also colocated in `file_io.rs`. This file adds tests
//! that require cross-module interaction or larger fixtures.

#[cfg(test)]
mod integration {
    use crate::file_io::{open_file, save_file, sha256_hex};
    use std::fs;
    use tempfile::TempDir;

    /// Full save → reload cycle: open, compute hash, save new content,
    /// reload and verify the hash updates correctly.
    #[test]
    fn full_edit_cycle_updates_hash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("cycle.md");
        fs::write(&path, "# First\n").unwrap();

        let opened = open_file(&path).unwrap();
        let v1_hash = opened.content_hash.clone();

        let v2_hash = save_file(&path, "# Second\n", &v1_hash).unwrap();
        assert_ne!(v1_hash, v2_hash);
        assert_eq!(v2_hash, sha256_hex(b"# Second\n"));

        let reopened = open_file(&path).unwrap();
        assert_eq!(reopened.content, "# Second\n");
        assert_eq!(reopened.content_hash, v2_hash);
    }

    /// Verifies that the hash returned by `save_file` can be used as the
    /// `expected_hash` in the next `save_file` call (chain of saves).
    #[test]
    fn chained_saves_use_returned_hash() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("chain.md");
        fs::write(&path, "v1\n").unwrap();

        let opened = open_file(&path).unwrap();
        let h1 = save_file(&path, "v2\n", &opened.content_hash).unwrap();
        let h2 = save_file(&path, "v3\n", &h1).unwrap();
        assert_eq!(h2, sha256_hex(b"v3\n"));
    }

    /// A stale hash from two saves ago must still cause a mismatch error.
    #[test]
    fn stale_hash_from_previous_save_causes_mismatch() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("stale.md");
        fs::write(&path, "original\n").unwrap();

        let opened = open_file(&path).unwrap();
        let original_hash = opened.content_hash.clone();

        // First save succeeds.
        let _h2 = save_file(&path, "intermediate\n", &original_hash).unwrap();

        // Trying to save with the old hash now fails.
        let err = save_file(&path, "attempted\n", &original_hash).unwrap_err();
        assert!(
            format!("{}", err).contains("Hash mismatch"),
            "expected hash mismatch error"
        );
    }

    // ── T2.1: fd-lock advisory lock tests ─────────────────────────────────────

    /// A hash mismatch (simulating concurrent external write) must reject the
    /// save and NOT modify the on-disk content. This covers the in-process TOCTOU
    /// case: we simulate "external write happened before save_file re-hashes" by
    /// simply providing a stale expected_hash.
    #[test]
    fn fd_lock_hash_mismatch_does_not_write() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lock_test.md");
        let initial_content = "initial content\n";
        fs::write(&path, initial_content).unwrap();

        let stale_hash = sha256_hex(b"definitely wrong hash");
        let err = save_file(&path, "new content\n", &stale_hash).unwrap_err();

        // Must be a HashMismatch.
        let msg = format!("{}", err);
        assert!(msg.contains("Hash mismatch"), "got: {}", msg);

        // File must still have the initial content (not modified).
        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, initial_content, "file must be unmodified on mismatch");
    }

    /// save_file correctly truncates when writing shorter content over longer.
    /// This exercises the `set_len` call added for the fd-lock implementation.
    #[test]
    fn save_file_truncates_when_new_content_shorter() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("truncate.md");
        let long_content = "# Very long initial content that will be replaced\n\nWith much less text.\n";
        fs::write(&path, long_content).unwrap();

        let hash = sha256_hex(long_content.as_bytes());
        let short = "short\n";
        let new_hash = save_file(&path, short, &hash).unwrap();

        let on_disk = fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, short, "file must contain only the new shorter content");
        assert_eq!(new_hash, sha256_hex(short.as_bytes()));
    }
}

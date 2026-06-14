//! Integration tests for the save → edit → load → re-anchor round-trip.
//!
//! These tests exercise the full pipeline at the library level: they call
//! `crate::ipc::apply_reanchor_to_sidecar` — the same function that the
//! `load_annotations` IPC command delegates to — rather than re-implementing
//! the guard inline. This closes the previous fidelity gap (T1.4/R-OFFSET-TEST)
//! where a regression in the hash-comparison guard, the hash reassignment, or
//! the reanchor_all delegation inside the IPC handler would not have been caught.
//!
//! The Tauri async wrapper (`spawn_blocking`, IPC transport) is still out-of-scope
//! (requires a live AppHandle), but the behavioral core — hash guard + reanchor_all
//! + sidecar update — is now exercised by the production function.
//!
//! Tests:
//! 1. R-OFFSET-TEST: After inserting N lines above an anchored position, the
//!    re-anchored line numbers are exactly `stored_line + N` (not just "anchored").
//! 2. Detaching: Deleting the anchored text causes the annotation to be Detached.

use std::fs;
use tempfile::TempDir;

use crate::annotations::{self, AnchorStatus, Annotation, Sidecar, CURRENT_SCHEMA_VERSION};
use crate::file_io::sha256_hex;

// ── helpers ──────────────────────────────────────────────────────────────────

fn make_annotation(
    id: &str,
    line_start: u32,
    line_end: u32,
    quoted_text: &str,
    context_before: &str,
    context_after: &str,
) -> Annotation {
    Annotation {
        id: id.to_string(),
        line_start,
        line_end,
        char_start: 0,
        char_end: quoted_text.len() as u32,
        quoted_text: quoted_text.to_string(),
        context_before: context_before.to_string(),
        context_after: context_after.to_string(),
        body: "A test comment".to_string(),
        status: AnchorStatus::Anchored,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

fn write_doc(dir: &TempDir, name: &str, content: &str) -> std::path::PathBuf {
    let path = dir.path().join(name);
    fs::write(&path, content).unwrap();
    path
}

fn save_sidecar(doc_path: &std::path::Path, sidecar: &Sidecar) {
    annotations::save_annotations(doc_path, sidecar).unwrap();
}

/// Load annotations from disk and apply re-anchoring via the production
/// `ipc::apply_reanchor_to_sidecar` function — the same function the
/// `load_annotations` IPC command delegates to. This exercises the real
/// hash-comparison guard and hash reassignment (previously duplicated inline).
fn load_and_reanchor(doc_path: &std::path::Path) -> Sidecar {
    let doc_content = fs::read_to_string(doc_path).unwrap();
    let doc_hash = sha256_hex(doc_content.as_bytes());

    let load_result = annotations::load_annotations(doc_path, &doc_hash).unwrap();
    let sidecar = match load_result {
        annotations::LoadResult::Loaded(s) => s,
        annotations::LoadResult::NotFound(s) => s,
        annotations::LoadResult::Quarantined { fallback, .. } => fallback,
    };

    // Call the production IPC function that the async command delegates to.
    // This exercises the hash guard, reanchor_all delegation, and hash update
    // — closing the fidelity gap documented in T1.4.
    crate::ipc::apply_reanchor_to_sidecar(sidecar, &doc_content, &doc_hash)
}

// ── Test 1: R-OFFSET-TEST ─────────────────────────────────────────────────────
//
// Insert N lines ABOVE the anchor; assert line numbers move by exactly +N
// and status is Anchored.

#[test]
fn reanchor_offset_correct_after_above_insertion() {
    let dir = TempDir::new().unwrap();

    // Original document (5 lines, 0-indexed 0..4).
    let original = "Header line\nThis is the key sentence.\nMiddle\nSeparator\nFooter\n";
    let doc_path = write_doc(&dir, "doc.md", original);
    let original_hash = sha256_hex(original.as_bytes());

    // "This is the key sentence." is at line 1 (0-indexed).
    let ann = make_annotation(
        "ann-1",
        1, // line_start (0-indexed)
        1, // line_end
        "This is the key sentence.",
        "Header line",      // context_before = line 0
        "Middle",           // context_after  = line 2
    );

    let sidecar = Sidecar {
        schema_version: CURRENT_SCHEMA_VERSION,
        doc_content_hash: original_hash,
        general_notes: String::new(),
        annotations: vec![ann],
    };
    save_sidecar(&doc_path, &sidecar);

    // Insert 3 lines ABOVE the anchor (N = 3).
    let n: u32 = 3;
    let edited = "New line 1\nNew line 2\nNew line 3\nHeader line\nThis is the key sentence.\nMiddle\nSeparator\nFooter\n";
    fs::write(&doc_path, edited).unwrap();

    // Load and re-anchor via the production function.
    let result = load_and_reanchor(&doc_path);

    assert_eq!(result.annotations.len(), 1, "annotation must be retained");
    let re = &result.annotations[0];

    // Status must be Anchored.
    assert_eq!(re.status, AnchorStatus::Anchored, "should be anchored after insertion");

    // Line numbers must shift exactly by +N (verbatim probe or fuzzy).
    assert_eq!(
        re.line_start,
        1 + n,
        "line_start must be old(1) + N({}), got {}",
        n,
        re.line_start
    );
    assert_eq!(
        re.line_end,
        1 + n,
        "line_end must be old(1) + N({}), got {}",
        n,
        re.line_end
    );
}

// ── Test 2: Detached after text deletion ──────────────────────────────────────
//
// Delete the anchored text; assert status becomes Detached.

#[test]
fn reanchor_detached_after_text_deletion() {
    let dir = TempDir::new().unwrap();

    // Original document.
    let original = "Introduction\nVolatile section to be deleted.\nConclusion\n";
    let doc_path = write_doc(&dir, "doc2.md", original);
    let original_hash = sha256_hex(original.as_bytes());

    // "Volatile section to be deleted." is at line 1 (0-indexed).
    let ann = make_annotation(
        "ann-2",
        1,
        1,
        "Volatile section to be deleted.",
        "Introduction",
        "Conclusion",
    );

    let sidecar = Sidecar {
        schema_version: CURRENT_SCHEMA_VERSION,
        doc_content_hash: original_hash,
        general_notes: String::new(),
        annotations: vec![ann],
    };
    save_sidecar(&doc_path, &sidecar);

    // Remove the annotated line (and replace with something completely different).
    let edited = "Introduction\nCompletely different text here.\nConclusion\n";
    fs::write(&doc_path, edited).unwrap();

    // Load and re-anchor via the production function.
    let result = load_and_reanchor(&doc_path);

    assert_eq!(result.annotations.len(), 1, "annotation must be retained");
    let re = &result.annotations[0];

    // Status must be Detached because the text is gone.
    assert_eq!(re.status, AnchorStatus::Detached, "should detach when anchored text is gone");
}

// ── Test 3: No-op when doc hash matches (short-circuit guard) ─────────────────
//
// Verify that apply_reanchor_to_sidecar does NOT mutate annotations when the
// stored hash equals the current doc hash (the reanchor guard must short-circuit).
// This tests the guard condition in the IPC handler body directly.

#[test]
fn reanchor_noop_when_hash_matches() {
    let dir = TempDir::new().unwrap();

    let content = "Line one\nLine two\n";
    let doc_path = write_doc(&dir, "doc3.md", content);
    let hash = sha256_hex(content.as_bytes());

    let ann = make_annotation("ann-3", 0, 0, "Line one", "", "Line two");

    let sidecar = Sidecar {
        schema_version: CURRENT_SCHEMA_VERSION,
        doc_content_hash: hash.clone(),
        general_notes: String::new(),
        annotations: vec![ann],
    };
    save_sidecar(&doc_path, &sidecar);

    // Call apply_reanchor_to_sidecar directly with hash == stored_hash.
    let loaded = match annotations::load_annotations(&doc_path, &hash).unwrap() {
        annotations::LoadResult::Loaded(s) => s,
        annotations::LoadResult::NotFound(s) => s,
        annotations::LoadResult::Quarantined { fallback, .. } => fallback,
    };

    let result = crate::ipc::apply_reanchor_to_sidecar(loaded, content, &hash);

    // The annotation must be unchanged — reanchor_all is not called.
    assert_eq!(result.annotations.len(), 1);
    assert_eq!(result.annotations[0].line_start, 0);
    assert_eq!(result.annotations[0].status, AnchorStatus::Anchored);
    // Hash must still match.
    assert_eq!(result.doc_content_hash, hash);
}

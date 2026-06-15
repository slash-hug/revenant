//! Tests for crate::export — path validation and I/O for export_html and
//! read_file_bytes.  export_pdf is async + macOS-native; it is covered by the
//! live G1 smoke test rather than unit tests.

use std::path::{Path, PathBuf};
use tempfile::TempDir;

// ─── export_html ─────────────────────────────────────────────────────────────

/// A valid absolute .html path should write successfully.
#[test]
fn export_html_writes_utf8_bundle() {
    let dir = TempDir::new().unwrap();
    let out = dir.path().join("export.html");
    let html = "<html><body><h1>Hello</h1></body></html>";

    let result = crate::export::export_html(&out, html);
    assert!(result.is_ok(), "expected Ok, got {result:?}");
    let written = std::fs::read_to_string(&out).unwrap();
    assert_eq!(written, html);
}

/// A relative path must be rejected with INVALID_PATH.
#[test]
fn export_html_rejects_relative_path() {
    let out = Path::new("relative/path/out.html");
    let result = crate::export::export_html(out, "<html/>");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "INVALID_PATH");
    assert!(err.message.contains("absolute"));
}

/// A wrong extension (.txt instead of .html) must be rejected with INVALID_PATH.
#[test]
fn export_html_rejects_wrong_extension() {
    let dir = TempDir::new().unwrap();
    let out = dir.path().join("export.txt");
    let result = crate::export::export_html(&out, "<html/>");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "INVALID_PATH");
    assert!(err.message.contains(".html"));
}

/// A path containing `..` traversal must be rejected with INVALID_PATH.
#[test]
fn export_html_rejects_traversal_path() {
    // Construct an absolute path that still contains `..` components.
    // On POSIX we can do this without the path existing.
    let out = PathBuf::from("/tmp/valid_dir/../escape/out.html");
    let result = crate::export::export_html(&out, "<html/>");
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "INVALID_PATH");
    assert!(err.message.contains("traversal"));
}

/// Case-insensitive extension check: .HTML should be accepted.
#[test]
fn export_html_accepts_uppercase_extension() {
    let dir = TempDir::new().unwrap();
    let out = dir.path().join("EXPORT.HTML");
    let result = crate::export::export_html(&out, "<html/>");
    assert!(result.is_ok(), "expected Ok for .HTML extension, got {result:?}");
}

// ─── export_pdf (path validation only) ───────────────────────────────────────
// The actual PDF-generation path requires a live macOS process with a main
// run loop; it is validated by the G1 live smoke test.  We test path
// validation here since that code runs on all platforms.

/// Relative path → INVALID_PATH.
#[test]
fn export_pdf_validate_rejects_relative_path() {
    let p = PathBuf::from("relative/out.pdf");
    // We only test the synchronous validation logic by calling the private
    // validate helper indirectly via export_html-like structure.  Since
    // export_pdf is async and platform-gated, verify the validation by checking
    // the error type returned when the extension is wrong.
    // Here we check via a blocking `block_on` approach.
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(crate::export::export_pdf(p, "<html/>".into()));
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "INVALID_PATH");
}

/// Wrong extension (.html instead of .pdf) → INVALID_PATH.
#[test]
fn export_pdf_validate_rejects_wrong_extension() {
    let dir = TempDir::new().unwrap();
    let p = dir.path().join("out.html");
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(crate::export::export_pdf(p, "<html/>".into()));
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "INVALID_PATH");
    assert!(err.message.contains(".pdf"));
}

/// .PDF uppercase extension should pass validation (may then fail with
/// PDF_EXPORT_UNSUPPORTED on non-macOS, which is also acceptable).
#[test]
fn export_pdf_validate_accepts_uppercase_extension() {
    let dir = TempDir::new().unwrap();
    let p = dir.path().join("EXPORT.PDF");
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(crate::export::export_pdf(p, "<html/>".into()));
    // On macOS this may return PDF_EXPORT_FAILED (webview never loads in a
    // unit-test context) or succeed; on other platforms PDF_EXPORT_UNSUPPORTED.
    // The key assertion is that it is NOT INVALID_PATH.
    if let Err(e) = result {
        assert_ne!(e.code, "INVALID_PATH", "unexpected INVALID_PATH: {}", e.message);
    }
}

// ─── read_file_bytes ──────────────────────────────────────────────────────────

/// A file in a subdirectory of the document's parent must be readable.
#[test]
fn read_file_bytes_allows_subdir_path() {
    let dir = TempDir::new().unwrap();
    // Create: dir/doc.md, dir/images/fig.png
    let doc = dir.path().join("doc.md");
    std::fs::write(&doc, "# Doc").unwrap();
    let images_dir = dir.path().join("images");
    std::fs::create_dir(&images_dir).unwrap();
    let img = images_dir.join("fig.png");
    std::fs::write(&img, b"\x89PNG").unwrap();

    let result = crate::export::read_file_bytes(&doc, &img);
    assert!(result.is_ok(), "expected Ok for subdir file, got {result:?}");

    // Verify it is valid base64.
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(result.unwrap())
        .expect("base64 decode failed");
    assert_eq!(&decoded[..4], b"\x89PNG");
}

/// A `..` traversal must be rejected before confinement check.
#[test]
fn read_file_bytes_rejects_traversal() {
    let dir = TempDir::new().unwrap();
    let doc = dir.path().join("doc.md");
    std::fs::write(&doc, "# Doc").unwrap();
    // Construct a path that tries to escape via `..`
    let escape = dir.path().join("../etc/passwd");

    let result = crate::export::read_file_bytes(&doc, &escape);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "IO_ERROR");
    assert!(err.message.contains("traversal") || err.message.contains("outside"));
}

/// A path in a sibling directory (not under the doc's parent) must be rejected
/// by the confinement guard.
#[test]
fn read_file_bytes_rejects_sibling_dir() {
    let root = TempDir::new().unwrap();
    // /root/doc_dir/doc.md
    let doc_dir = root.path().join("doc_dir");
    std::fs::create_dir(&doc_dir).unwrap();
    let doc = doc_dir.join("doc.md");
    std::fs::write(&doc, "# Doc").unwrap();

    // /root/sibling/secret.png — outside doc_dir
    let sibling = root.path().join("sibling");
    std::fs::create_dir(&sibling).unwrap();
    let secret = sibling.join("secret.png");
    std::fs::write(&secret, b"\x89PNG").unwrap();

    let result = crate::export::read_file_bytes(&doc, &secret);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.code, "IO_ERROR");
}

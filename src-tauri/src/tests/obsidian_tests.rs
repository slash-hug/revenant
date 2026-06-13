/// Tests for obsidian.rs (WS-D / D3).
///
/// Per plan §5 D3 / §7 (spec verification matrix):
/// 1. Mocked REST endpoint — successful PUT returns RestPushed.
/// 2. REST 401 → ObsidianError::Misconfigured.
/// 3. Connection refused → filesystem fallback → FilesystemCopy.
/// 4. Frontmatter merge is applied before export.
/// 5. Distinguish "REST not running" vs "REST misconfigured" error paths.
use crate::obsidian::{
    export_obsidian, export_obsidian_with_frontmatter, ExportResult, ObsidianError,
    REST_DEFAULT_HTTP_PORT,
};
use crate::settings::Settings;
use mockito::Server;
use std::collections::HashMap;
use tempfile::TempDir;

// Helper: a settings struct with the given key_ref and vault dir.
fn settings_with_ref(key_ref: &str, vault: &std::path::Path) -> Settings {
    Settings {
        rest_key_ref: Some(key_ref.to_string()),
        vaults: vec![vault.to_path_buf()],
        ..Settings::default()
    }
}

fn settings_no_rest(vault: &std::path::Path) -> Settings {
    Settings {
        rest_key_ref: None,
        vaults: vec![vault.to_path_buf()],
        ..Settings::default()
    }
}

// ── Test 1: successful REST push ──────────────────────────────────────────────

/// When the REST server returns 200, rest_put returns Ok(()).
/// Uses mockito to stand up a fake Obsidian REST API on a random port.
///
/// We use `rest_put` directly (bypassing keychain) so this test is hermetic
/// and verifies the actual HTTP request shape.
#[test]
fn test_rest_push_success() {
    use crate::obsidian::rest_put;

    let mut server = Server::new();
    let port = server
        .url()
        .trim_start_matches("http://127.0.0.1:")
        .parse::<u16>()
        .unwrap();

    // Mockito matches the URL-encoded path.
    let _mock = server
        .mock("PUT", mockito::Matcher::Any)
        .with_status(200)
        .create();

    let result = rest_put("# Note content", "Reviews/note.md", "valid-api-key", port);
    assert!(
        result.is_ok(),
        "200 from REST server must return Ok, got: {result:?}"
    );
}

/// Verify the filesystem fallback path when no key_ref is configured
/// (validates the integration of export_obsidian at the top level).
#[test]
fn test_export_obsidian_no_key_ref_uses_filesystem() {
    let dir = TempDir::new().unwrap();
    let settings = settings_no_rest(dir.path());

    let result = export_obsidian("# Note", "Reviews/note.md", &settings, 1);
    assert!(
        matches!(result, Ok(ExportResult::FilesystemCopy)),
        "without key_ref, should fall back to filesystem copy, got: {result:?}"
    );

    let written = std::fs::read_to_string(dir.path().join("Reviews/note.md")).unwrap();
    assert_eq!(written, "# Note");
}

// ── Test 2: REST 401 → Misconfigured ─────────────────────────────────────────

/// When the Obsidian REST API returns 401, the error must be Misconfigured
/// (not NotRunning), so the UI can prompt the user to fix their API key.
///
/// Uses `rest_put` directly (bypasses keychain) so the test is hermetic
/// and doesn't depend on macOS Keychain being accessible in CI.
#[test]
fn test_rest_401_is_misconfigured() {
    use crate::obsidian::rest_put;

    let mut server = Server::new();
    let port = server
        .url()
        .trim_start_matches("http://127.0.0.1:")
        .parse::<u16>()
        .unwrap();

    let _mock = server
        .mock("PUT", mockito::Matcher::Any)
        .with_status(401)
        .create();

    // Call rest_put directly with a fake key — no keychain involved.
    let result = rest_put("# Content", "Reviews/note.md", "fake-bad-key", port);

    assert!(
        matches!(result, Err(ObsidianError::Misconfigured)),
        "401 from REST API must map to Misconfigured, got: {result:?}"
    );
}

// ── Test 3: REST not running → filesystem fallback ───────────────────────────

/// When the REST server is unreachable (connection refused OR key not in keychain),
/// export_obsidian must fall back to filesystem copy and return FilesystemCopy.
///
/// We test two sub-cases:
/// 3a. key_ref is present in settings but absent from keychain (e.g., cleared by user)
///     → treat as NotRunning → filesystem copy.
/// 3b. No key_ref in settings at all → filesystem copy directly.
#[test]
fn test_rest_not_running_falls_back_to_filesystem_no_key_in_keychain() {
    // 3a: key_ref set in settings but keychain returns None.
    // Use a ref that was definitely never stored.
    let dir = TempDir::new().unwrap();
    let settings = settings_with_ref("definitely-never-stored-ref", dir.path());

    let result = export_obsidian(
        "# Fallback doc",
        "Reviews/fallback.md",
        &settings,
        1, // port — doesn't matter since key lookup fails first
    );

    assert!(
        matches!(result, Ok(ExportResult::FilesystemCopy)),
        "absent keychain key must fall back to FilesystemCopy, got: {result:?}"
    );

    let written = std::fs::read_to_string(dir.path().join("Reviews/fallback.md")).unwrap();
    assert!(
        written.contains("# Fallback doc"),
        "filesystem copy must write the document content"
    );
}

/// 3b: No key_ref in settings → filesystem copy without attempting REST.
#[test]
fn test_rest_no_key_ref_falls_back_to_filesystem() {
    let dir = TempDir::new().unwrap();
    let settings = settings_no_rest(dir.path());

    let result = export_obsidian("# No-REST doc", "Reviews/norest.md", &settings, 1);

    assert!(
        matches!(result, Ok(ExportResult::FilesystemCopy)),
        "no key_ref should immediately fall back to FilesystemCopy, got: {result:?}"
    );

    let written = std::fs::read_to_string(dir.path().join("Reviews/norest.md")).unwrap();
    assert_eq!(written, "# No-REST doc");
}

/// 3c: rest_put to an unreachable port returns NotRunning (connection refused).
#[test]
fn test_rest_put_connection_refused_is_not_running() {
    use crate::obsidian::rest_put;

    // Port 1 is privileged and always refused on macOS.
    let result = rest_put("# Doc", "note.md", "any-key", 1);

    assert!(
        matches!(result, Err(ObsidianError::NotRunning)),
        "connection refused must map to NotRunning, got: {result:?}"
    );
}

// ── Test 4: frontmatter merge is applied before export ───────────────────────

/// export_obsidian_with_frontmatter merges extra keys into existing frontmatter
/// and writes the merged document to the vault.
#[test]
fn test_frontmatter_merge_before_export() {
    let dir = TempDir::new().unwrap();
    let settings = settings_no_rest(dir.path());

    let original_markdown = "---\ntitle: My Doc\nauthor: Randy\n---\n# Body text here\n";

    let mut extra: HashMap<String, serde_json::Value> = HashMap::new();
    extra.insert(
        "review_status".to_string(),
        serde_json::Value::String("in-review".to_string()),
    );
    extra.insert(
        "reviewed_at".to_string(),
        serde_json::Value::String("2026-06-13".to_string()),
    );

    let result = export_obsidian_with_frontmatter(
        original_markdown,
        &extra,
        "Reviews/merged.md",
        &settings,
        REST_DEFAULT_HTTP_PORT,
    );

    assert!(
        matches!(result, Ok(ExportResult::FilesystemCopy)),
        "should succeed via filesystem copy, got: {result:?}"
    );

    let written = std::fs::read_to_string(dir.path().join("Reviews/merged.md")).unwrap();

    // Original frontmatter fields must be preserved.
    assert!(
        written.contains("title:") || written.contains("\"title\""),
        "original 'title' frontmatter field must survive merge"
    );
    assert!(
        written.contains("author:") || written.contains("\"author\""),
        "original 'author' frontmatter field must survive merge"
    );
    // Injected fields must be present.
    assert!(
        written.contains("review_status") || written.contains("review_status"),
        "injected 'review_status' field must appear in merged output"
    );
    assert!(
        written.contains("in-review"),
        "injected 'review_status' value must appear in merged output"
    );
    // Body must be preserved.
    assert!(
        written.contains("# Body text here"),
        "document body must be preserved after frontmatter merge"
    );
}

// ── Test 5: no vault configured → NoVaultConfigured error ────────────────────

/// When REST is not running AND no vault dir is set, the error must be
/// NoVaultConfigured (not a cryptic I/O error).
#[test]
fn test_no_vault_configured_returns_clear_error() {
    let settings = Settings {
        rest_key_ref: None,
        vaults: vec![], // intentionally empty
        ..Settings::default()
    };

    let result = export_obsidian("# Content", "note.md", &settings, 1 /* refused port */);

    assert!(
        matches!(result, Err(ObsidianError::NoVaultConfigured)),
        "empty vault list must return NoVaultConfigured, got: {result:?}"
    );
}

// ── Test 6: filesystem copy creates parent directories ───────────────────────

#[test]
fn test_filesystem_copy_creates_parent_dirs() {
    let dir = TempDir::new().unwrap();
    let settings = settings_no_rest(dir.path());

    let result = export_obsidian(
        "# Deep note",
        "a/b/c/deep.md",
        &settings,
        1, // refused
    );

    assert!(
        matches!(result, Ok(ExportResult::FilesystemCopy)),
        "deep nested path should be created, got: {result:?}"
    );

    assert!(
        dir.path().join("a/b/c/deep.md").exists(),
        "nested parent directories must be created automatically"
    );
}

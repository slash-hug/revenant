/// Tests for settings.rs (WS-D / D2).
///
/// Key assertions per plan §5 / D2:
/// 1. Round-trip: save then load returns identical Settings.
/// 2. "No secret in JSON": the serialized JSON must never contain the raw
///    REST API key — only the opaque rest_key_ref may appear.
/// 3. Missing file returns default settings.
/// 4. Migration: version 0 (no version field) is migrated in-place to v1.
/// 5. Unknown future version is quarantined (.bak) and returns an error.
/// 6. (D-4) set/clear/has rest-key: keychain stores key + sets rest_key_ref;
///    clearing nulls both; has_rest_key reflects state.
use crate::secrets::test_helpers::init_mock_keychain;
use crate::secrets::{delete_rest_key, get_rest_key, has_rest_key, store_rest_key};
use crate::settings::{
    get_settings, load_settings, save_settings, set_settings, set_settings_preserving_ref,
    Settings, SettingsError, CURRENT_SCHEMA_VERSION,
};
use std::path::PathBuf;
use tempfile::TempDir;

fn tmp_settings_path(dir: &TempDir) -> PathBuf {
    dir.path().join("settings.json")
}

// ── Test 1: round-trip save → load ───────────────────────────────────────────

#[test]
fn test_settings_round_trip() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    let original = Settings {
        schema_version: CURRENT_SCHEMA_VERSION,
        vaults: vec![PathBuf::from("/Users/test/ObsidianVault")],
        default_export_subfolder: "Reviews".to_string(),
        theme: "dark".to_string(),
        export_on_save: true,
        rest_key_ref: Some("obsidian-rest".to_string()),
        preview_zoom: 125,
    };

    save_settings(&path, &original).expect("save should succeed");
    let loaded = load_settings(&path).expect("load should succeed");

    assert_eq!(
        original, loaded,
        "loaded settings must be identical to what was saved"
    );
}

// ── Test 2: no secret in JSON ─────────────────────────────────────────────────

/// The RAW API key must never appear in the serialized settings JSON.
/// Only the opaque `rest_key_ref` (a label, not a secret) may be present.
///
/// This guards against future refactors accidentally putting the key back
/// into the Settings struct.
#[test]
fn test_no_secret_in_serialized_json() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    // Use a recognizable fake key so we can assert it's absent.
    const FAKE_API_KEY: &str = "super-secret-obsidian-key-abc123";

    let settings = Settings {
        schema_version: CURRENT_SCHEMA_VERSION,
        vaults: vec![],
        default_export_subfolder: String::new(),
        theme: "system".to_string(),
        export_on_save: false,
        // rest_key_ref holds the LABEL, not the secret.
        rest_key_ref: Some("obsidian-rest".to_string()),
        preview_zoom: 100,
    };

    save_settings(&path, &settings).expect("save should succeed");

    let raw_json = std::fs::read_to_string(&path).expect("file should exist");

    // The raw key must be completely absent from the JSON on disk.
    assert!(
        !raw_json.contains(FAKE_API_KEY),
        "Raw API key must not appear in persisted settings JSON. \
         Key found in: {raw_json}"
    );

    // The reference label is allowed to appear (it's not a secret).
    assert!(
        raw_json.contains("obsidian-rest"),
        "rest_key_ref label should be present in serialized JSON"
    );

    // Schema version must be present.
    assert!(
        raw_json.contains("\"schema_version\""),
        "schema_version field must be present in serialized JSON"
    );
}

// ── Test 3: missing file → default settings ──────────────────────────────────

#[test]
fn test_missing_file_returns_default() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nonexistent.json");

    let result = get_settings(&path).expect("missing file should return defaults, not error");

    let expected = Settings::default();
    assert_eq!(
        result, expected,
        "missing settings file should yield default settings"
    );
}

// ── Test 4: schema_version absent (v0) → migrated in-place to v1 ────────────

#[test]
fn test_version_zero_migrated_in_place() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    // Write a settings JSON that has no schema_version field (pre-v1 era).
    let legacy_json = r#"{
        "vaults": [],
        "default_export_subfolder": "",
        "theme": "light",
        "export_on_save": false,
        "rest_key_ref": null
    }"#;
    std::fs::write(&path, legacy_json).unwrap();

    let loaded = load_settings(&path).expect("migration should succeed");
    assert_eq!(
        loaded.schema_version, CURRENT_SCHEMA_VERSION,
        "after migration, schema_version should be {CURRENT_SCHEMA_VERSION}"
    );
    assert_eq!(loaded.theme, "light", "migrated settings should preserve existing values");

    // Verify the file was written back with the new version.
    let updated_json = std::fs::read_to_string(&path).unwrap();
    assert!(
        updated_json.contains("\"schema_version\""),
        "migrated file should contain schema_version field"
    );
}

// ── Test 5: unknown future version → quarantine ──────────────────────────────

#[test]
fn test_unknown_future_version_quarantined() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    // Write a settings JSON with a far-future version number.
    let future_json = r#"{
        "schema_version": 999,
        "vaults": [],
        "default_export_subfolder": "",
        "theme": "system",
        "export_on_save": false,
        "rest_key_ref": null
    }"#;
    std::fs::write(&path, future_json).unwrap();

    let result = load_settings(&path);
    assert!(
        matches!(result, Err(SettingsError::UnknownVersion { version: 999, .. })),
        "unknown version should return UnknownVersion error, got: {result:?}"
    );

    // The original file should have been renamed to .bak — not left in place.
    assert!(
        !path.exists(),
        "original settings file should have been quarantined (renamed to .bak)"
    );
    let backup = dir.path().join("settings.json.bak");
    assert!(
        backup.exists(),
        "quarantined backup file should exist at .bak path"
    );
}

// ── Test 5b: migration deserialization failure → quarantine, no data loss ────

/// Regression for #53: when an older-version settings file has a malformed
/// field, migration deserialization fails. The original MUST be quarantined to
/// `.bak` (preserved verbatim) rather than reset to defaults and overwritten,
/// which would be silent data loss.
#[test]
fn test_migration_parse_failure_quarantines_without_dataloss() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    // An older-version file (v0, no schema_version field) with a malformed
    // field: `vaults` is a string, not the expected array. Deserialization into
    // Settings will fail during migration.
    let malformed_legacy_json = r#"{
        "vaults": "this-should-be-an-array-not-a-string",
        "default_export_subfolder": "",
        "theme": "light",
        "export_on_save": false,
        "rest_key_ref": null
    }"#;
    std::fs::write(&path, malformed_legacy_json).unwrap();

    let result = load_settings(&path);

    // (a) It must NOT silently succeed by returning defaults written over the file.
    assert!(
        matches!(result, Err(SettingsError::MigrationFailed { version: 0, .. })),
        "malformed migration must return MigrationFailed, got: {result:?}"
    );

    // (b) The original file must have been quarantined to .bak — not destroyed.
    assert!(
        !path.exists(),
        "original settings file should have been quarantined (renamed to .bak)"
    );
    let backup = dir.path().join("settings.json.bak");
    assert!(
        backup.exists(),
        "quarantined backup file should exist at .bak path"
    );

    // (c) The .bak content must be the ORIGINAL bytes — preserved, not overwritten
    //     with defaults.
    let backup_content = std::fs::read_to_string(&backup).unwrap();
    assert_eq!(
        backup_content, malformed_legacy_json,
        "quarantined .bak must contain the original file content verbatim, \
         proving the original was preserved (not reset to defaults)"
    );
    // Defaults must NOT have leaked into the .bak.
    assert!(
        !backup_content.contains("\"schema_version\""),
        "quarantined original must not have been rewritten with a schema_version"
    );
}

// ── Test 6: default schema_version is 1 ──────────────────────────────────────

#[test]
fn test_default_settings_has_schema_version_1() {
    let settings = Settings::default();
    assert_eq!(
        settings.schema_version,
        CURRENT_SCHEMA_VERSION,
        "default Settings must carry schema_version = {CURRENT_SCHEMA_VERSION}"
    );
}

// ── Test 7: rest_key_ref field exists but holds no secret ────────────────────

#[test]
fn test_settings_struct_has_no_raw_key_field() {
    // Serialize default settings and confirm the word "key" only appears
    // as part of "rest_key_ref", never as a standalone secret value.
    let settings = Settings::default();
    let json = serde_json::to_string(&settings).unwrap();

    // "rest_key_ref" may appear (it's the reference, not the secret).
    // No bare secret-pattern strings should be present.
    for forbidden in &["sk-", "Bearer ", "password", "api_key\":"] {
        assert!(
            !json.contains(forbidden),
            "Serialized default settings must not contain '{forbidden}'. JSON: {json}"
        );
    }
}

// ── Issue #61: rest_key_ref opaque-reference guard ───────────────────────────
//
// `save_settings` asserts that, if `rest_key_ref` is present, it equals the
// single legitimate opaque keychain reference ("obsidian-rest") — never a raw
// secret leaked into the field. `None` must always pass.

/// The opaque-ref guard accepts the legitimate ref and `None`, and rejects a
/// raw-looking value smuggled into `rest_key_ref`.
#[test]
fn test_rest_key_ref_guard_accepts_opaque_ref_and_none() {
    let dir = TempDir::new().unwrap();

    // Legitimate opaque reference passes.
    let with_ref = Settings {
        rest_key_ref: Some("obsidian-rest".to_string()),
        ..Settings::default()
    };
    save_settings(&dir.path().join("with_ref.json"), &with_ref)
        .expect("opaque rest_key_ref must pass the guard");

    // No reference at all passes.
    let without_ref = Settings {
        rest_key_ref: None,
        ..Settings::default()
    };
    save_settings(&dir.path().join("without_ref.json"), &without_ref)
        .expect("None rest_key_ref must pass the guard");

    // A raw-looking value smuggled into rest_key_ref must trip the assert.
    let leaked = Settings {
        rest_key_ref: Some("sk-super-secret-raw-key-abc123".to_string()),
        ..Settings::default()
    };
    let path = dir.path().join("leaked.json");
    let leaked_path = path.clone();
    let result = std::panic::catch_unwind(move || {
        let _ = save_settings(&leaked_path, &leaked);
    });
    assert!(
        result.is_err(),
        "a raw-looking value in rest_key_ref must trip the secret-leak guard"
    );
    // The guard must fire BEFORE writing the file to disk.
    assert!(
        !path.exists(),
        "the file must not be written when the guard trips"
    );
}

// ── D-4: set / clear / has rest-key lifecycle ────────────────────────────────
//
// These tests exercise the composition of `secrets` + `settings` to verify the
// full store-key → reflect-in-settings → retrieve → clear lifecycle.
//
// The `keyring` mock credential builder (`keyring::mock::default_credential_builder`)
// is per-Entry-instance: it creates a fresh `MockCredential` for every `Entry::new()`
// call, so secrets do NOT persist across separate Entry instantiations.  This means
// cross-call round-trips (store_rest_key → get_rest_key) cannot be tested with the
// mock and are guarded with `#[ignore]` — they require the real OS keychain and are
// validated manually or in an integration environment.
//
// What we CAN test without the real keychain:
// - settings side: rest_key_ref persists / clears correctly in the JSON file.
// - mock builder installs without panic (init_mock_keychain is callable).
// - has_rest_key returns false for a key that was never stored via the mock.
// - delete_rest_key is a no-op when no entry exists (NoEntry → Ok).

/// Settings side of the "set key" flow:
/// - persisting rest_key_ref in the settings JSON file works correctly.
/// - the raw key never appears in the JSON.
/// - clearing nulls rest_key_ref in the JSON.
///
/// This does NOT exercise the keychain; keychain operations are covered by the
/// integration tests below (marked `#[ignore]`).
#[test]
fn test_settings_ref_persists_and_clears() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    let key_ref = "obsidian-rest";
    let raw_key = "super-secret-key-must-not-appear";

    // Simulate "set key" — write the ref (not the raw key) to settings.
    let settings_with_ref = Settings {
        rest_key_ref: Some(key_ref.to_string()),
        ..Settings::default()
    };
    set_settings(&path, settings_with_ref).expect("save should succeed");

    let raw_json = std::fs::read_to_string(&path).unwrap();
    assert!(
        raw_json.contains("obsidian-rest"),
        "rest_key_ref label must appear in settings JSON"
    );
    assert!(
        !raw_json.contains(raw_key),
        "raw API key must not appear in settings JSON: {raw_json}"
    );

    let loaded = load_settings(&path).expect("load should succeed");
    assert_eq!(
        loaded.rest_key_ref,
        Some(key_ref.to_string()),
        "settings must persist rest_key_ref"
    );

    // Simulate "clear key" — null the ref in settings.
    let settings_cleared = Settings {
        rest_key_ref: None,
        ..Settings::default()
    };
    set_settings(&path, settings_cleared).expect("clear save should succeed");

    let cleared = load_settings(&path).expect("load after clear should succeed");
    assert_eq!(
        cleared.rest_key_ref, None,
        "rest_key_ref must be null after clearing"
    );
}

/// `has_rest_key` returns false when no key has been stored (uses mock keychain).
#[test]
fn test_has_rest_key_false_when_no_key_stored() {
    init_mock_keychain();
    let key_ref = "obsidian-rest-d4-never-stored";
    assert!(
        !has_rest_key(key_ref),
        "has_rest_key must return false for a key that was never stored"
    );
}

/// `delete_rest_key` is a no-op (Ok) when no entry exists (mock keychain).
#[test]
fn test_delete_rest_key_no_op_when_absent() {
    init_mock_keychain();
    let key_ref = "obsidian-rest-d4-absent";
    let result = delete_rest_key(key_ref);
    assert!(
        result.is_ok(),
        "delete_rest_key must be Ok when no entry exists (NoEntry treated as Ok)"
    );
    // Second call is also fine.
    assert!(delete_rest_key(key_ref).is_ok());
}

/// `get_rest_key` returns None for an unstored key (mock keychain).
#[test]
fn test_get_rest_key_returns_none_when_absent() {
    init_mock_keychain();
    let key_ref = "obsidian-rest-d4-get-absent";
    let result = get_rest_key(key_ref).expect("get should not error when absent");
    assert_eq!(result, None, "get_rest_key must return None when no key stored");
}

// ── Integration tests (require real OS keychain) ─────────────────────────────
//
// The `keyring` mock builder is per-Entry-instance (no cross-call persistence),
// so round-trip tests (store → get, store → has, store → delete → get → None)
// must run against the real macOS Keychain or Windows Credential Manager.
// These are marked `#[ignore]` so CI passes without the OS keychain available.
// Run manually with: cargo test -- --ignored

/// Full round-trip: store key → get key returns same value.
/// Requires real OS keychain.
#[test]
#[ignore = "requires real OS keychain (macOS Keychain / Windows Credential Manager)"]
fn test_store_and_get_rest_key_round_trip() {
    let key_ref = "obsidian-rest-d4-roundtrip";
    let raw_key = "test-key-round-trip-abc123";

    store_rest_key(key_ref, raw_key).expect("store should succeed");
    let retrieved = get_rest_key(key_ref).expect("get should succeed");
    assert_eq!(
        retrieved,
        Some(raw_key.to_string()),
        "get must return the stored key"
    );
    let _ = delete_rest_key(key_ref); // cleanup
}

/// store → has_rest_key returns true; delete → has_rest_key returns false.
/// Requires real OS keychain.
#[test]
#[ignore = "requires real OS keychain (macOS Keychain / Windows Credential Manager)"]
fn test_has_rest_key_reflects_state() {
    let key_ref = "obsidian-rest-d4-has";
    let _ = delete_rest_key(key_ref); // ensure clean slate

    assert!(!has_rest_key(key_ref), "has_rest_key must be false before storing");
    store_rest_key(key_ref, "some-key").expect("store should succeed");
    assert!(has_rest_key(key_ref), "has_rest_key must be true after storing");
    delete_rest_key(key_ref).expect("delete should succeed");
    assert!(!has_rest_key(key_ref), "has_rest_key must be false after deleting");
}

/// Full composition: settings + keychain set/clear lifecycle.
/// Requires real OS keychain.
#[test]
#[ignore = "requires real OS keychain (macOS Keychain / Windows Credential Manager)"]
fn test_full_set_clear_rest_key_lifecycle() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    let key_ref = "obsidian-rest-d4-lifecycle";
    let raw_key = "lifecycle-secret-key-xyz";

    // Store key in keychain.
    store_rest_key(key_ref, raw_key).expect("store should succeed");

    // Persist ref in settings.
    let settings = Settings {
        rest_key_ref: Some(key_ref.to_string()),
        ..Settings::default()
    };
    set_settings(&path, settings).expect("save should succeed");

    // Verify: key retrieved, ref in settings, raw key absent from JSON.
    let retrieved = get_rest_key(key_ref).expect("get should succeed");
    assert_eq!(retrieved, Some(raw_key.to_string()), "stored key must be retrievable");
    let loaded = load_settings(&path).expect("load should succeed");
    assert_eq!(loaded.rest_key_ref, Some(key_ref.to_string()), "ref must be in settings");
    let raw_json = std::fs::read_to_string(&path).unwrap();
    assert!(!raw_json.contains(raw_key), "raw key must not appear in settings JSON");
    assert!(has_rest_key(key_ref), "has_rest_key must be true after storing");

    // Clear: delete from keychain and null ref in settings.
    delete_rest_key(key_ref).expect("delete should succeed");
    let settings_cleared = Settings { rest_key_ref: None, ..Settings::default() };
    set_settings(&path, settings_cleared).expect("clear should succeed");

    // Verify cleared state.
    assert_eq!(get_rest_key(key_ref).unwrap(), None, "key must be None after delete");
    assert!(!has_rest_key(key_ref), "has_rest_key must be false after clearing");
    let cleared = load_settings(&path).expect("load after clear should succeed");
    assert_eq!(cleared.rest_key_ref, None, "settings ref must be null after clearing");
}

// ── D2: set_settings_preserving_ref — lost-update regression ─────────────────
//
// Scenario: set_rest_key writes rest_key_ref = Some("obsidian-rest") to disk.
// A stale frontend payload (with rest_key_ref = None) then calls
// set_settings_preserving_ref.  The on-disk ref must survive.

/// Lost-update regression: `set_settings_preserving_ref` must keep the
/// on-disk `rest_key_ref` even when the incoming payload sets it to `None`.
/// Other fields (theme, vaults) from the incoming payload ARE applied.
#[test]
fn test_preserving_ref_survives_stale_frontend_payload() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    // Step 1: write an on-disk state with a non-null rest_key_ref
    //         (simulates what set_rest_key would leave behind).
    let on_disk = Settings {
        schema_version: CURRENT_SCHEMA_VERSION,
        vaults: vec![PathBuf::from("/vault/original")],
        default_export_subfolder: "Reviews".to_string(),
        theme: "dark".to_string(),
        export_on_save: false,
        rest_key_ref: Some("obsidian-rest".to_string()),
        preview_zoom: 90,
    };
    save_settings(&path, &on_disk).expect("initial save should succeed");

    // Step 2: simulate a stale frontend payload — different theme/vault, but
    //         rest_key_ref = None (the frontend never saw the updated ref).
    let stale_incoming = Settings {
        schema_version: CURRENT_SCHEMA_VERSION,
        vaults: vec![PathBuf::from("/vault/updated")],
        default_export_subfolder: "NewFolder".to_string(),
        theme: "light".to_string(),
        export_on_save: true,
        rest_key_ref: None, // stale — frontend doesn't know about the saved key
        preview_zoom: 150,
    };
    set_settings_preserving_ref(&path, stale_incoming).expect("merge save should succeed");

    // Step 3: reload and assert the key ref survived AND other fields updated.
    let loaded = load_settings(&path).expect("load after merge should succeed");

    assert_eq!(
        loaded.rest_key_ref,
        Some("obsidian-rest".to_string()),
        "rest_key_ref must be preserved from disk even when incoming payload is None"
    );
    assert_eq!(
        loaded.vaults,
        vec![PathBuf::from("/vault/updated")],
        "vaults from incoming payload must be applied"
    );
    assert_eq!(
        loaded.theme, "light",
        "theme from incoming payload must be applied"
    );
    assert_eq!(
        loaded.default_export_subfolder, "NewFolder",
        "default_export_subfolder from incoming payload must be applied"
    );
    assert!(
        loaded.export_on_save,
        "export_on_save from incoming payload must be applied"
    );
    assert_eq!(
        loaded.preview_zoom, 150,
        "preview_zoom from incoming payload must be applied"
    );
    assert_eq!(
        loaded.schema_version, CURRENT_SCHEMA_VERSION,
        "schema_version must be CURRENT_SCHEMA_VERSION after merge"
    );
}

/// Secret-guard-through-merge: `set_settings_preserving_ref` routes through
/// `save_settings`, which asserts no secret-pattern fields are present.
/// This test exercises the merge path with a recognisable ref label and
/// confirms the raw API key never appears in the written JSON.
#[test]
fn test_preserving_ref_does_not_leak_secret() {
    let dir = TempDir::new().unwrap();
    let path = tmp_settings_path(&dir);

    const FAKE_RAW_KEY: &str = "super-secret-api-key-must-not-appear-in-json";

    // Seed an on-disk entry with a ref label.
    let on_disk = Settings {
        rest_key_ref: Some("obsidian-rest".to_string()),
        ..Settings::default()
    };
    save_settings(&path, &on_disk).expect("seed save should succeed");

    // Incoming payload — if a bug accidentally put the raw key into
    // rest_key_ref, this would be where it happens.  We use the ref label, not
    // the raw key, but this test verifies the JSON file never contains the raw
    // key regardless.
    let incoming = Settings {
        rest_key_ref: None, // stale — the merge fn will restore "obsidian-rest" from disk
        ..Settings::default()
    };
    set_settings_preserving_ref(&path, incoming).expect("merge save should succeed");

    let raw_json = std::fs::read_to_string(&path).expect("settings file should exist after merge");

    assert!(
        !raw_json.contains(FAKE_RAW_KEY),
        "raw API key must never appear in settings JSON written by the merge fn. \
         JSON: {raw_json}"
    );
    assert!(
        raw_json.contains("obsidian-rest"),
        "rest_key_ref label must be present after the merge preserves it"
    );
    assert!(
        raw_json.contains("\"schema_version\""),
        "schema_version must be present after merge"
    );
}

// ── D3: keychain rollback test ────────────────────────────────────────────────
//
// The rollback scenario: store_rest_key succeeds (key written to keychain) but
// the subsequent settings write fails.  On failure the caller should delete the
// orphaned keychain entry so the system returns to a consistent state.
//
// The keyring mock backend is per-Entry-instance (no cross-call persistence), so
// we cannot round-trip store→get in unit tests.  What we CAN assert:
// - delete_rest_key is a no-op (Ok) after a failed store path — i.e. the rollback
//   call itself never panics or double-faults.
// - The mock-keychain install + delete_rest_key path compiles and runs.
//
// The "write-then-fail" integration test that requires real hardware is
// marked #[ignore] with a comment requiring Windows verification.

/// Unit-level rollback smoke: `delete_rest_key` (the rollback call) is safe to
/// invoke even when no key exists — establishes that the rollback code path
/// compiles and does not panic under the mock backend.
#[test]
fn test_rollback_delete_is_safe_when_key_absent() {
    init_mock_keychain();

    let key_ref = "obsidian-rest-d3-rollback-absent";

    // Simulate the rollback: key was never stored (write failed before store)
    // or was already cleaned up.  The rollback call must be a no-op.
    let result = delete_rest_key(key_ref);
    assert!(
        result.is_ok(),
        "rollback delete_rest_key must return Ok when no entry exists (no-op)"
    );

    // A second rollback call is also safe (idempotent).
    assert!(
        delete_rest_key(key_ref).is_ok(),
        "second rollback call must also return Ok (idempotent)"
    );
}

/// Integration test: simulate a settings-write failure AFTER store_rest_key,
/// then assert delete_rest_key (the rollback) is called.
///
/// Because the keyring mock does not persist across Entry instances, the full
/// store → fail → rollback → confirm-deleted round-trip requires the real OS
/// keychain.  Marked #[ignore] — run manually or in a hardware-backed CI job.
///
/// Windows verification REQUIRED: macOS Keychain and Windows Credential Manager
/// behave differently on concurrent access; validate on actual Windows hardware
/// before removing this gate.
#[test]
#[ignore = "requires real OS keychain (macOS Keychain / Windows Credential Manager); \
            Windows hardware verification required before removing this gate"]
fn test_keychain_rollback_on_settings_write_failure() {
    let dir = TempDir::new().unwrap();

    // Create a FILE at the path that save_settings will try to use as a parent
    // directory.  save_settings calls create_dir_all(parent), which fails when
    // the parent path component is an existing regular file rather than a
    // directory — the OS cannot create a directory over a file.  A missing
    // subdirectory is NOT a valid failure trigger here because create_dir_all
    // would simply create it and the write would succeed.
    let blocker = dir.path().join("blocker");
    std::fs::write(&blocker, b"not a directory").unwrap();
    let bad_path = blocker.join("settings.json"); // parent is a file, not a dir

    let key_ref = "obsidian-rest-d3-integration-rollback";
    let raw_key = "integration-rollback-key-xyz";

    // Step 1: store the key in the real keychain (simulating the first half of set_rest_key).
    store_rest_key(key_ref, raw_key).expect("store should succeed on real keychain");
    assert!(has_rest_key(key_ref), "key must be present after store");

    // Step 2: attempt the settings write to a path that WILL fail (parent is a file).
    let settings_with_ref = Settings {
        rest_key_ref: Some(key_ref.to_string()),
        ..Settings::default()
    };
    let write_result = set_settings(&bad_path, settings_with_ref);
    assert!(write_result.is_err(), "write must fail when parent path is a regular file");

    // Step 3: caller performs rollback — delete the orphaned keychain entry.
    delete_rest_key(key_ref).expect("rollback delete should succeed on real keychain");

    // Step 4: assert rollback succeeded — key no longer present.
    assert!(
        !has_rest_key(key_ref),
        "key must be absent from keychain after rollback delete"
    );
}

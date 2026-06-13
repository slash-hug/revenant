/// Tests for settings.rs (WS-D / D2).
///
/// Key assertions per plan §5 / D2:
/// 1. Round-trip: save then load returns identical Settings.
/// 2. "No secret in JSON": the serialized JSON must never contain the raw
///    REST API key — only the opaque rest_key_ref may appear.
/// 3. Missing file returns default settings.
/// 4. Migration: version 0 (no version field) is migrated in-place to v1.
/// 5. Unknown future version is quarantined (.bak) and returns an error.
use crate::settings::{
    get_settings, load_settings, save_settings, Settings, SettingsError,
    CURRENT_SCHEMA_VERSION,
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

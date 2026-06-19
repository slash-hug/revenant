/// Versioned application settings store.
///
/// Design decisions (from plan §0 / C14):
/// - `schema_version: 1` in the envelope from day 1 (A3/C4).
/// - REST key is NEVER stored here in plaintext; only a `rest_key_ref`
///   (opaque string used to look up the key in the OS keychain via
///   `secrets.rs`). This enforces the security requirement (A6/C14).
/// - Migration: known older versions migrate in-place; unknown/newer
///   versions are quarantined (renamed to .bak) — see C5.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Current settings schema version.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// The opaque reference written into `rest_key_ref` to name the OS-keychain
/// entry holding the REST key (set by `set_rest_key` in `ipc.rs`). The raw REST
/// key is NEVER stored in settings: a legitimate `rest_key_ref` is this opaque
/// label, so any value present must begin with this prefix. A raw key (e.g. an
/// `sk-…` token) would not, which is exactly what the leak guard catches.
pub const REST_KEY_REF: &str = "obsidian-rest";

/// Default preview zoom percentage.
fn default_preview_zoom() -> u32 {
    100
}

/// Application-level settings (persisted to disk as JSON).
///
/// The REST key is intentionally absent from this struct — it lives
/// in the OS keychain and is referenced only by `rest_key_ref`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    /// Schema version for forward-compatibility (C4).
    pub schema_version: u32,

    /// Obsidian vault paths the user has configured.
    pub vaults: Vec<PathBuf>,

    /// Default subfolder within the vault where exports are written.
    /// Empty string = vault root.
    pub default_export_subfolder: String,

    /// UI theme preference: "system", "light", or "dark".
    pub theme: String,

    /// Whether to auto-export to Obsidian on every save.
    pub export_on_save: bool,

    /// Opaque reference used to retrieve the REST key from the OS keychain.
    /// `None` means the user has not configured the REST integration.
    /// The actual key is NEVER stored here (C14 / A6).
    pub rest_key_ref: Option<String>,

    /// Preview zoom level as a percentage (50–200). Default 100.
    #[serde(default = "default_preview_zoom")]
    pub preview_zoom: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            vaults: Vec::new(),
            default_export_subfolder: String::new(),
            theme: "system".to_string(),
            export_on_save: false,
            rest_key_ref: None,
            preview_zoom: 100,
        }
    }
}

/// Error type for settings operations.
#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Unknown schema version {version}; settings quarantined to {backup_path}")]
    UnknownVersion { version: u32, backup_path: PathBuf },

    #[error("Failed to migrate settings from version {version}; original quarantined to {backup_path}")]
    MigrationFailed { version: u32, backup_path: PathBuf },
}

/// Quarantine the file at `path` by renaming it to a sibling `.bak` file.
///
/// Used whenever the on-disk settings cannot be safely loaded (unknown future
/// version, or a known-version migration that fails to deserialize). The
/// original is NEVER discarded — it is preserved so the user can recover it.
fn quarantine_to_bak(path: &PathBuf) -> Result<PathBuf, SettingsError> {
    let mut backup_path = path.clone();
    let ext = backup_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("json");
    backup_path.set_extension(format!("{ext}.bak"));
    std::fs::rename(path, &backup_path)?;
    Ok(backup_path)
}

/// Load settings from a file path, applying migration or quarantine as needed (C5).
///
/// - Known older version → migrate in-place, write back.
/// - Unknown/future version → quarantine (rename to .bak), return default.
pub fn load_settings(path: &PathBuf) -> Result<Settings, SettingsError> {
    let raw = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)?;

    let version = value
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    match version {
        0 => {
            // Version 0 predates the schema_version field.
            // Inject the field, then deserialize so existing values are preserved.
            let mut obj = value;
            if let serde_json::Value::Object(ref mut map) = obj {
                map.insert(
                    "schema_version".to_string(),
                    serde_json::Value::Number(serde_json::Number::from(CURRENT_SCHEMA_VERSION)),
                );
            }
            // On deserialization failure, DO NOT reset to defaults and overwrite —
            // that would silently destroy the user's original settings. Instead
            // quarantine the original to .bak and return defaults without writing.
            let mut settings: Settings = match serde_json::from_value(obj) {
                Ok(s) => s,
                Err(_) => {
                    let backup_path = quarantine_to_bak(path)?;
                    return Err(SettingsError::MigrationFailed {
                        version,
                        backup_path,
                    });
                }
            };
            settings.schema_version = CURRENT_SCHEMA_VERSION;
            save_settings(path, &settings)?;
            Ok(settings)
        }
        v if v == CURRENT_SCHEMA_VERSION => {
            // Current version — deserialize directly.
            let settings: Settings = serde_json::from_value(value)?;
            Ok(settings)
        }
        v if v < CURRENT_SCHEMA_VERSION => {
            // Older known version — migrate in-place, preserving all present fields.
            let mut obj = value;
            if let serde_json::Value::Object(ref mut map) = obj {
                map.insert(
                    "schema_version".to_string(),
                    serde_json::Value::Number(serde_json::Number::from(CURRENT_SCHEMA_VERSION)),
                );
            }
            // On deserialization failure, DO NOT reset to defaults and overwrite —
            // that would silently destroy the user's original settings. Instead
            // quarantine the original to .bak and return defaults without writing.
            let mut settings: Settings = match serde_json::from_value(obj) {
                Ok(s) => s,
                Err(_) => {
                    let backup_path = quarantine_to_bak(path)?;
                    return Err(SettingsError::MigrationFailed {
                        version: v,
                        backup_path,
                    });
                }
            };
            settings.schema_version = CURRENT_SCHEMA_VERSION;
            save_settings(path, &settings)?;
            Ok(settings)
        }
        v => {
            // Unknown/future version — quarantine to .bak, return default (C5).
            let backup_path = quarantine_to_bak(path)?;
            Err(SettingsError::UnknownVersion {
                version: v,
                backup_path,
            })
        }
    }
}

/// Serialize and write settings to disk.
pub fn save_settings(path: &PathBuf, settings: &Settings) -> Result<(), SettingsError> {
    // Ensure the parent directory exists.
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;

    // Structural safety check: the Settings struct intentionally has no field
    // that holds a raw secret — only `rest_key_ref`, which must hold an opaque
    // keychain reference (never a raw API key). This runtime assert fires in
    // both debug AND release builds so it cannot be silently compiled away.
    //
    // The real leak risk is a raw key written into `rest_key_ref` (it would
    // serialize as `"rest_key_ref":"<key>"`, which no generic field-name scan
    // would catch). So we assert directly on the value: if it is present it must
    // be the opaque keychain reference (it begins with `REST_KEY_REF`). A raw
    // key would not, so this trips before it can be persisted. `None` is fine.
    assert!(
        settings
            .rest_key_ref
            .as_deref()
            .map_or(true, |r| r.starts_with(REST_KEY_REF)),
        "BUG: rest_key_ref holds an unexpected value; it must be the opaque \
         keychain reference {REST_KEY_REF:?}, never a raw key."
    );

    std::fs::write(path, json)?;
    Ok(())
}

/// Tauri IPC command: return current settings.
/// The settings file path is derived from Tauri's app-data dir in the real
/// app; here we accept the path explicitly so tests can inject a temp path.
pub fn get_settings(path: &PathBuf) -> Result<Settings, SettingsError> {
    if path.exists() {
        load_settings(path)
    } else {
        Ok(Settings::default())
    }
}

/// Tauri IPC command: persist updated settings.
pub fn set_settings(path: &PathBuf, settings: Settings) -> Result<(), SettingsError> {
    save_settings(path, &settings)
}

/// Persist updated settings while preserving the on-disk `rest_key_ref`.
///
/// Problem: when the frontend calls `setSettings` (via `patchSettings`) it sends
/// back the full `Settings` struct it last read from the store.  If `set_rest_key`
/// or `clear_rest_key` ran concurrently and updated `rest_key_ref` on disk, the
/// frontend's stale copy would overwrite it — a classic lost-update.
///
/// This function prevents that race by:
/// 1. Loading the **current** on-disk settings.
/// 2. Building a merged struct from `incoming` but keeping `rest_key_ref` from disk.
/// 3. Ensuring `schema_version = CURRENT_SCHEMA_VERSION`.
/// 4. Writing through `save_settings` (preserves the secret-leak assert).
///
/// Do NOT modify `set_settings` — its verbatim pass-through behavior is depended on
/// by `set_rest_key` / `clear_rest_key` which already own the `rest_key_ref` value
/// they are writing.
pub fn set_settings_preserving_ref(
    path: &PathBuf,
    incoming: Settings,
) -> Result<(), SettingsError> {
    let on_disk = get_settings(path)?;
    let merged = Settings {
        schema_version: CURRENT_SCHEMA_VERSION,
        // Preserve the on-disk keychain reference — never let a stale frontend
        // copy clobber a rest_key_ref that was just written by set_rest_key.
        rest_key_ref: on_disk.rest_key_ref,
        // Take all other fields from the incoming (user-edited) payload.
        vaults: incoming.vaults,
        default_export_subfolder: incoming.default_export_subfolder,
        theme: incoming.theme,
        export_on_save: incoming.export_on_save,
        preview_zoom: incoming.preview_zoom,
    };
    save_settings(path, &merged)
}

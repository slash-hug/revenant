/// Obsidian vault export module (WS-D / D3).
///
/// Export strategy (plan §5 / D3 / docs/obsidian-rest-notes.md):
///   1. Probe `GET http://127.0.0.1:27123/` to check reachability.
///   2. If reachable, push via `PUT /vault/{path}` with Bearer auth.
///   3. If not reachable → `ObsidianError::NotRunning` → filesystem fallback.
///   4. If 401 → `ObsidianError::Misconfigured` → surface configure prompt.
///
/// Frontmatter merge: uses `crate::frontmatter::{parse, merge_mappings, reassemble}`
/// (implemented by WS-B). Incoming review metadata is merged into the
/// document's existing frontmatter before export.
use crate::frontmatter::{merge_mappings, parse, reassemble};
use crate::secrets::{get_rest_key, SecretsError};
use crate::settings::{Settings, SettingsError};
use reqwest::blocking::Client;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// Default HTTP port for the Obsidian Local REST API plugin.
/// We default to HTTP (27123) in v1 to avoid self-signed certificate trust
/// complexity on a loopback-only connection. See docs/obsidian-rest-notes.md.
pub const REST_DEFAULT_HTTP_PORT: u16 = 27123;

/// Default HTTPS port (for future v1.x when cert-pinning is implemented).
pub const REST_DEFAULT_HTTPS_PORT: u16 = 27124;

/// Connection timeout for REST reachability probes.
const PROBE_TIMEOUT_SECS: u64 = 3;

/// Result of a connection probe — tells the caller (and the UI settings panel)
/// whether the Obsidian REST plugin is reachable and properly authorized.
///
/// Serialized with snake_case so the IPC layer can forward it to the frontend
/// as `"ok"`, `"unauthorized"`, or `"unreachable"` without extra mapping.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnStatus {
    /// The Local REST API plugin is running and the key is accepted.
    Ok,
    /// The plugin is running but the key was rejected (HTTP 401).
    Unauthorized,
    /// The plugin is not running or Obsidian is not open (connection refused / timeout).
    Unreachable,
}

/// Probe the Obsidian Local REST API with a read-only authenticated `GET /vault/`
/// (vault-root listing).
///
/// This is intentionally read-only so it can be called to test connectivity
/// without side effects.  Maps HTTP responses as:
/// - 2xx → `ConnStatus::Ok`
/// - 401 → `ConnStatus::Unauthorized`
/// - connection refused / timeout → `ConnStatus::Unreachable`
pub fn probe_obsidian(api_key: &str, port: u16) -> ConnStatus {
    let client = rest_client();
    let url = format!("http://127.0.0.1:{port}/vault/");

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .send();

    match response {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if (200..300).contains(&status) {
                ConnStatus::Ok
            } else if status == 401 {
                ConnStatus::Unauthorized
            } else {
                // Any other non-2xx: treat as unreachable for probe purposes.
                ConnStatus::Unreachable
            }
        }
        Err(e) => {
            if e.is_connect() || e.is_timeout() || is_connection_refused(&e) {
                ConnStatus::Unreachable
            } else {
                ConnStatus::Unreachable
            }
        }
    }
}

/// Synchronous helper that resolves the REST key and probes the Obsidian plugin.
///
/// Key resolution order:
/// 1. Use the explicitly supplied `key` (typed, unsaved — used when the user is
///    testing a key before saving it in the settings UI).
/// 2. If `key` is `None`, load settings from `settings_path` and look up the
///    stored `rest_key_ref` in the OS keychain.
/// 3. If no key is available either way → `ConnStatus::Unreachable`.
///
/// The raw key is used ONLY for the probe and is NEVER persisted or logged.
///
/// Intended to be wrapped in `tauri::async_runtime::spawn_blocking` by the IPC
/// layer (WS-A) so it doesn't block the async Tauri event loop.
pub fn test_obsidian_connection(settings_path: &Path, key: Option<String>) -> ConnStatus {
    let api_key = match key {
        // Caller supplied an explicit (unsaved) key — use it directly.
        Some(k) => k,
        // No explicit key — load settings and retrieve from keychain.
        None => {
            use crate::settings::get_settings;
            let settings = match get_settings(&settings_path.to_path_buf()) {
                Ok(s) => s,
                Err(_) => return ConnStatus::Unreachable,
            };
            let key_ref = match settings.rest_key_ref {
                Some(r) => r,
                None => return ConnStatus::Unreachable,
            };
            match get_rest_key(&key_ref) {
                Ok(Some(k)) => k,
                _ => return ConnStatus::Unreachable,
            }
        }
    };

    probe_obsidian(&api_key, REST_DEFAULT_HTTP_PORT)
}

/// A process-wide reqwest client, built once and reused (perf #4). The probe
/// timeout bounds how long an unreachable Obsidian blocks before we fall back to
/// a filesystem copy. Build is effectively infallible; on the off chance it
/// fails we fall back to a default client (no custom timeout).
fn rest_client() -> &'static Client {
    static REST_CLIENT: OnceLock<Client> = OnceLock::new();
    REST_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// Error type for Obsidian export operations.
#[derive(Debug, thiserror::Error)]
pub enum ObsidianError {
    /// The Local REST API plugin is not running (connection refused / timeout).
    /// Use the filesystem fallback path.
    #[error("Obsidian is not running or the Local REST API plugin is not enabled")]
    NotRunning,

    /// The REST API is reachable but the stored key was rejected (HTTP 401).
    /// The user must reconfigure their API key.
    #[error("API key is invalid. Open Settings → Obsidian to reconfigure")]
    Misconfigured,

    /// The REST API returned a non-success status we don't handle specially.
    #[error("Export failed (HTTP {status}). Check the Obsidian console")]
    HttpError { status: u16 },

    /// No vault is configured in settings.
    #[error("No Obsidian vault configured. Open Settings → Obsidian to add a vault")]
    NoVaultConfigured,

    /// Filesystem fallback I/O error.
    #[error("Filesystem export failed: {0}")]
    Io(#[from] std::io::Error),

    /// Keychain error retrieving the REST key.
    #[error("Keychain error: {0}")]
    Secrets(#[from] SecretsError),

    /// Settings error.
    #[error("Settings error: {0}")]
    Settings(#[from] SettingsError),

    /// HTTP client error (network-level, e.g. TLS, DNS).
    #[error("HTTP client error: {0}")]
    Http(String),
}

impl From<reqwest::Error> for ObsidianError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_connect() || e.is_timeout() || is_connection_refused(&e) {
            ObsidianError::NotRunning
        } else {
            ObsidianError::Http(e.to_string())
        }
    }
}

/// Detect connection-refused errors that reqwest may not classify as `is_connect()`.
/// Checks the error message as a last-resort heuristic.
fn is_connection_refused(e: &reqwest::Error) -> bool {
    let msg = e.to_string().to_lowercase();
    msg.contains("connection refused")
        || msg.contains("os error 61") // macOS ECONNREFUSED
        || msg.contains("os error 111") // Linux ECONNREFUSED
}

/// Result of an export operation — tells the caller which path was taken.
#[derive(Debug, PartialEq)]
pub enum ExportResult {
    /// File was pushed via the Obsidian Local REST API.
    RestPushed,
    /// File was written directly to the filesystem (REST was not running).
    FilesystemCopy,
}

/// Export a markdown document to an Obsidian vault.
///
/// `doc_path` — absolute path of the source document.
/// `content` — full markdown text to export (after frontmatter merge).
/// `vault_relative_path` — where to write inside the vault (e.g. "Reviews/doc.md").
/// `settings` — current app settings (vault dir, rest_key_ref, export subfolder).
/// `rest_port` — override for testing (pass `REST_DEFAULT_HTTP_PORT` in production).
///
/// Returns `ExportResult` so the caller can emit appropriate UI events.
pub fn export_obsidian(
    content: &str,
    vault_relative_path: &str,
    settings: &Settings,
    rest_port: u16,
) -> Result<ExportResult, ObsidianError> {
    // 1. Try REST if a key reference is configured.
    if let Some(ref key_ref) = settings.rest_key_ref {
        match try_rest_export(content, vault_relative_path, key_ref, rest_port) {
            Ok(()) => return Ok(ExportResult::RestPushed),
            Err(ObsidianError::NotRunning) => {
                // Fall through to filesystem fallback below.
            }
            Err(e) => return Err(e),
        }
    }

    // 2. Filesystem fallback: write to first configured vault.
    let vault_dir = settings
        .vaults
        .first()
        .ok_or(ObsidianError::NoVaultConfigured)?;

    filesystem_copy(content, vault_dir, vault_relative_path)?;
    Ok(ExportResult::FilesystemCopy)
}

/// Merge `extra_frontmatter` (key→JSON string pairs) into the document and export.
///
/// Convenience wrapper used by the IPC layer so the caller can supply
/// review metadata without knowing the merge algorithm.
pub fn export_obsidian_with_frontmatter(
    markdown: &str,
    extra_frontmatter: &std::collections::HashMap<String, serde_json::Value>,
    vault_relative_path: &str,
    settings: &Settings,
    rest_port: u16,
) -> Result<ExportResult, ObsidianError> {
    // Convert HashMap<String, serde_json::Value> → serde_yaml::Mapping for the frontmatter API.
    let overlay: serde_yaml::Mapping = extra_frontmatter
        .iter()
        .filter_map(|(k, v)| {
            // Convert the JSON value to a YAML value via round-trip through string.
            let yaml_val: serde_yaml::Value = serde_json::from_value(v.clone())
                .ok()
                .and_then(|j: serde_json::Value| {
                    serde_yaml::to_string(&j).ok().and_then(|s| serde_yaml::from_str(&s).ok())
                })?;
            Some((serde_yaml::Value::String(k.clone()), yaml_val))
        })
        .collect();

    let parsed = parse(markdown).map_err(|e| {
        ObsidianError::Http(format!("frontmatter parse error: {e}"))
    })?;
    let merged_mapping = match &parsed.mapping {
        Some(base) => merge_mappings(base, &overlay),
        None => overlay,
    };
    // T2.3: pass the detected line_ending so CRLF documents are preserved.
    let merged_doc = reassemble(Some(&merged_mapping), &parsed.body, parsed.line_ending).map_err(|e| {
        ObsidianError::Http(format!("frontmatter reassemble error: {e}"))
    })?;
    export_obsidian(&merged_doc, vault_relative_path, settings, rest_port)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Attempt a REST push via the Obsidian Local REST API.
///
/// Returns:
/// - `Ok(())` on success.
/// - `Err(ObsidianError::NotRunning)` if the server is unreachable (caller falls back to filesystem).
/// - `Err(ObsidianError::Misconfigured)` if the server is reachable but rejects the key (401).
/// - `Err(ObsidianError::NotRunning)` also if the key is absent from the keychain (treat as
///   unconfigured → fall back to filesystem; the user will get a configure-prompt event).
fn try_rest_export(
    content: &str,
    vault_relative_path: &str,
    key_ref: &str,
    port: u16,
) -> Result<(), ObsidianError> {
    // If the key isn't in the keychain (returns None), treat it the same as
    // "not configured" → fall through to filesystem copy rather than surfacing
    // a Misconfigured error. The one-time configure-prompt event handles UX.
    let api_key = match get_rest_key(key_ref)? {
        Some(k) => k,
        None => return Err(ObsidianError::NotRunning),
    };

    rest_put(content, vault_relative_path, &api_key, port)
}

/// Low-level REST PUT — sends the request with the given API key.
/// Extracted for testability (inject key directly without keychain).
pub fn rest_put(
    content: &str,
    vault_relative_path: &str,
    api_key: &str,
    port: u16,
) -> Result<(), ObsidianError> {
    // Reuse one Client across calls so TLS/connection-pool setup isn't rebuilt
    // every export (perf #4).
    let client = rest_client();

    // Encode the vault path segments safely.
    let encoded_path = vault_relative_path
        .split('/')
        .map(|seg| {
            percent_encoding::utf8_percent_encode(seg, percent_encoding::NON_ALPHANUMERIC)
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("/");

    let url = format!("http://127.0.0.1:{port}/vault/{encoded_path}");

    let response = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "text/markdown")
        .body(content.to_owned())
        .send()
        .map_err(ObsidianError::from)?;

    match response.status().as_u16() {
        200 | 201 => Ok(()),
        401 => Err(ObsidianError::Misconfigured),
        status => Err(ObsidianError::HttpError { status }),
    }
}

/// Write content directly to the filesystem inside the vault directory.
///
/// Security (A7/C16): canonicalizes the vault dir and the derived target path
/// and calls `crate::paths::assert_confined` before any write.  A
/// `vault_relative_path` containing `../` segments is rejected, preventing
/// path-traversal escapes from the vault directory.
fn filesystem_copy(
    content: &str,
    vault_dir: &PathBuf,
    vault_relative_path: &str,
) -> Result<(), std::io::Error> {
    // Canonicalize the vault directory so we get a stable base for confinement.
    let canon_vault = std::fs::canonicalize(vault_dir)?;

    // Join the relative path and resolve it *before* any mkdir, so we can
    // detect traversal attempts on a path that doesn't exist yet.
    // We construct the absolute path ourselves first:
    let naive_target = canon_vault.join(vault_relative_path);
    // Normalize without requiring the path to exist (resolve `..` manually).
    let normalized = normalize_path(&naive_target);

    // Confinement check: the resolved path must stay inside the vault.
    crate::paths::assert_confined(&normalized, &[canon_vault])
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::PermissionDenied, e.to_string()))?;

    // Safe to create parent directories and write.
    if let Some(parent) = normalized.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&normalized, content)?;
    Ok(())
}

/// Normalize a `PathBuf` by resolving `.` and `..` components lexically
/// without requiring the path to exist on disk.  Used for pre-write
/// confinement checks where the target dir may not yet exist.
fn normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

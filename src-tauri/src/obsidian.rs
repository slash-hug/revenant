/// Obsidian vault export module (WS-D / D3).
///
/// Export strategy (plan §5 / D3 / docs/obsidian-rest-notes.md):
///   1. Probe `GET http://127.0.0.1:27123/` to check reachability.
///   2. If reachable, push via `PUT /vault/{path}` with Bearer auth.
///   3. If not reachable → `ObsidianError::NotRunning` → filesystem fallback.
///   4. If 401 → `ObsidianError::Misconfigured` → surface configure prompt.
///
/// Frontmatter merge: uses `crate::frontmatter::{parse, merge, render}`
/// (implemented by WS-B). Incoming review metadata is merged into the
/// document's existing frontmatter before export.
use crate::frontmatter::{merge, parse, render};
use crate::secrets::{get_rest_key, SecretsError};
use crate::settings::{Settings, SettingsError};
use reqwest::blocking::Client;
use std::path::PathBuf;
use std::time::Duration;

/// Default HTTP port for the Obsidian Local REST API plugin.
/// We default to HTTP (27123) in v1 to avoid self-signed certificate trust
/// complexity on a loopback-only connection. See docs/obsidian-rest-notes.md.
pub const REST_DEFAULT_HTTP_PORT: u16 = 27123;

/// Default HTTPS port (for future v1.x when cert-pinning is implemented).
pub const REST_DEFAULT_HTTPS_PORT: u16 = 27124;

/// Connection timeout for REST reachability probes.
const PROBE_TIMEOUT_SECS: u64 = 3;

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
    let (base_fm, body) = parse(markdown);
    let merged_fm = merge(&base_fm, extra_frontmatter);
    let merged_doc = render(&merged_fm, &body);
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
    let client = Client::builder()
        .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS))
        .build()
        .map_err(|e| ObsidianError::Http(e.to_string()))?;

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
fn filesystem_copy(
    content: &str,
    vault_dir: &PathBuf,
    vault_relative_path: &str,
) -> Result<(), std::io::Error> {
    let target = vault_dir.join(vault_relative_path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, content)?;
    Ok(())
}

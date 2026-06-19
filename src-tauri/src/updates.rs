/// Update-check engine (WS-D / D1–D3).
///
/// Provides two public functions surfaced through `ipc.rs`:
///
/// - `check_for_updates()` — GETs the latest GitHub release, compares semver
///   versions, returns an `ipc::UpdateCheck`.
/// - `open_release_page(url)` — validates the URL is a legitimate revenant
///   release URL (https, github.com, correct repo path prefix).  The actual
///   browser launch is handled by the `ipc::open_release_page` command via
///   `tauri_plugin_opener` — this module contains only the pure validation.
///
/// Design decisions:
/// - A dedicated `reqwest::blocking::Client` (shared via `OnceLock`) with a
///   3-second timeout avoids blocking the IPC command pool for longer than
///   necessary when GitHub is slow.  The IPC command bodies in `ipc.rs` run
///   these synchronous fns via `spawn_blocking` for the same reason.
/// - The GitHub slug is a const so the host/path validation in
///   `open_release_page` can cross-check against the same value — a single
///   place to update if the repo ever moves.
/// - `semver::Version::parse` is strict (requires X.Y.Z); GitHub tags have a
///   leading `v` which is stripped before parsing.
/// - `check_for_updates_from(url)` is the testable inner function (accepts an
///   arbitrary endpoint URL) so tests can point at a mockito server without
///   needing env-var tricks or global mutation.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::Client;
use thiserror::Error;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// GitHub owner/repo slug for release API calls.
pub(crate) const GITHUB_SLUG: &str = "slash-hug/revenant";

/// GitHub Releases latest API endpoint (production).
const RELEASES_LATEST_URL: &str =
    "https://api.github.com/repos/slash-hug/revenant/releases/latest";

/// User-Agent sent with every HTTP request (GitHub API requires one).
const USER_AGENT: &str = "revenant-updater";

/// HTTP request timeout.  Short so a slow GitHub never freezes the UI.
const REQUEST_TIMEOUT_SECS: u64 = 3;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors that can arise during the update-check flow.
#[derive(Debug, Error)]
pub enum UpdatesError {
    /// A network-level failure (connection refused, timeout, TLS, etc.).
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    /// The response body could not be parsed as expected JSON.
    #[error("parse error: {0}")]
    Parse(String),

    /// The URL supplied to `open_release_page` failed validation (wrong
    /// scheme, wrong host, or wrong repo path prefix) or the system browser
    /// could not be launched.
    #[error("invalid release URL: {0}")]
    InvalidUrl(String),
}

// ---------------------------------------------------------------------------
// Shared HTTP client
// ---------------------------------------------------------------------------

/// Returns a lazily-initialised, shared blocking client.
///
/// Using a single `OnceLock<Client>` avoids paying the overhead of creating a
/// new client (TLS handshake, socket pool) on every check.
fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .expect("failed to build reqwest blocking client")
    })
}

// ---------------------------------------------------------------------------
// D2 — check_for_updates
// ---------------------------------------------------------------------------

/// Fetch the latest GitHub release and compare it to the running binary.
///
/// Returns an `ipc::UpdateCheck` on success.  Failures are wrapped in
/// `UpdatesError` — the IPC layer maps them to `UPDATE_CHECK_FAILED`.
pub fn check_for_updates() -> Result<crate::ipc::UpdateCheck, UpdatesError> {
    check_for_updates_from(RELEASES_LATEST_URL, env!("CARGO_PKG_VERSION"))
}

/// Inner function used by tests: fetch from `api_url` and compare against
/// `current_version`.  Both are parameterised so tests can point at a mockito
/// server and supply any "current" version string.
pub(crate) fn check_for_updates_from(
    api_url: &str,
    current_version: &str,
) -> Result<crate::ipc::UpdateCheck, UpdatesError> {
    let response = client()
        .get(api_url)
        .send()?
        .error_for_status()?;

    let body: serde_json::Value = response.json()?;

    // Extract tag_name and html_url.
    let tag_name = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| UpdatesError::Parse("missing 'tag_name' in releases/latest".into()))?;

    let release_url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| UpdatesError::Parse("missing 'html_url' in releases/latest".into()))?;

    // Strip leading `v` before semver parsing.
    let latest_str = tag_name.trim_start_matches('v');

    let latest = semver::Version::parse(latest_str).map_err(|e| {
        UpdatesError::Parse(format!("invalid latest version '{latest_str}': {e}"))
    })?;
    let current = semver::Version::parse(current_version).map_err(|e| {
        UpdatesError::Parse(format!("invalid current version '{current_version}': {e}"))
    })?;

    Ok(crate::ipc::UpdateCheck {
        // Require the latest release to be a *stable* semver (empty pre-release
        // field). GitHub's `/releases/latest` already excludes prereleases, but
        // that guarantee lives in the endpoint, not here — without this guard a
        // stable build (e.g. 1.0.0) would flag `1.1.0-rc.1` as an available
        // update if the release source ever changed. (#44)
        update_available: latest > current && latest.pre.is_empty(),
        latest: latest_str.to_string(),
        current: current_version.to_string(),
        release_url: release_url.to_string(),
    })
}

// ---------------------------------------------------------------------------
// D3 — open_release_page
// ---------------------------------------------------------------------------

/// Validate `url` against the expected release-page shape.
///
/// Accepted URL shape:
/// - scheme must be `https`
/// - host must be `github.com`
/// - path must start with `/<GITHUB_SLUG>/releases` followed by `/` or end-of-path
///
/// On validation failure → `UpdatesError::InvalidUrl`.
/// Callers are responsible for actually opening the URL (e.g. via
/// `tauri_plugin_opener`) after validation succeeds.
pub fn open_release_page(url: &str) -> Result<(), UpdatesError> {
    validate_release_url(url)
}

/// URL validation (pure, used in both the public function and tests).
pub(crate) fn validate_release_url(url: &str) -> Result<(), UpdatesError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| UpdatesError::InvalidUrl(format!("URL parse error: {e}")))?;

    if parsed.scheme() != "https" {
        return Err(UpdatesError::InvalidUrl(format!(
            "scheme must be 'https', got '{}'",
            parsed.scheme()
        )));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| UpdatesError::InvalidUrl("missing host".into()))?;

    if host != "github.com" {
        return Err(UpdatesError::InvalidUrl(format!(
            "host must be 'github.com', got '{host}'"
        )));
    }

    let expected_prefix = format!("/{}/releases", GITHUB_SLUG);
    let path = parsed.path();
    let valid = path == expected_prefix
        || path.starts_with(&format!("{}/", expected_prefix));
    if !valid {
        return Err(UpdatesError::InvalidUrl(format!(
            "path must be '{expected_prefix}' or start with '{expected_prefix}/', got '{path}'"
        )));
    }

    Ok(())
}

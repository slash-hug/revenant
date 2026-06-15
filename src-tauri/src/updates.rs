// Update-check engine — WS-D implements the full body.
//
// WS-A provides this stub so the IPC contract (ipc.rs) compiles and the
// module declaration in lib.rs resolves. WS-D replaces the function bodies
// when it lands; the pub signatures below are the agreed interface.
//
// Agreed signatures (DO NOT CHANGE without updating ipc.rs):
//   pub fn check_for_updates() -> Result<crate::ipc::UpdateCheck, UpdatesError>
//   pub fn open_release_page(url: &str) -> Result<(), UpdatesError>

use thiserror::Error;

/// Errors that can occur during update checking or URL opening.
#[derive(Debug, Error)]
pub enum UpdatesError {
    #[error("network error: {0}")]
    Network(String),
    #[error("parse error: {0}")]
    Parse(String),
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
}

/// Probe GitHub Releases for a newer version of Revenant.
///
/// Implementation provided by WS-D (updates.rs full body).
/// Stub returns a placeholder; replace with the real implementation.
pub fn check_for_updates() -> Result<crate::ipc::UpdateCheck, UpdatesError> {
    // WS-D replaces this stub with the real GitHub API probe + semver compare.
    todo!("WS-D: implement check_for_updates in updates.rs")
}

/// Open the release page URL in the system browser.
///
/// Implementation provided by WS-D (updates.rs full body).
/// Stub returns a placeholder; replace with the real implementation.
pub fn open_release_page(_url: &str) -> Result<(), UpdatesError> {
    // WS-D replaces this stub with URL validation + tauri-plugin-opener call.
    todo!("WS-D: implement open_release_page in updates.rs")
}

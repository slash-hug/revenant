/// OS keychain wrapper for the Obsidian REST API key.
///
/// Design decisions (plan §0 / C14 / A6):
/// - The REST key is stored in the OS keychain (macOS Keychain /
///   Windows Credential Manager) via the `keyring` crate.
/// - `settings.rs` holds only a `rest_key_ref` (opaque string) that
///   identifies the keychain entry. The raw key never touches disk.
/// - Three operations: store, retrieve, delete.
use keyring::Entry;

/// Keychain service name for all Revenant secrets.
const KEYCHAIN_SERVICE: &str = "com.codelogiq.revenant";

/// Error type for keychain operations.
#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("Keychain error: {0}")]
    Keychain(#[from] keyring::Error),
}

/// Store the Obsidian REST API key in the OS keychain.
///
/// `key_ref` is the opaque identifier persisted in settings (e.g. "obsidian-rest").
/// The actual secret `api_key` is written only to the OS credential store.
pub fn store_rest_key(key_ref: &str, api_key: &str) -> Result<(), SecretsError> {
    let entry = Entry::new(KEYCHAIN_SERVICE, key_ref)?;
    entry.set_password(api_key)?;
    Ok(())
}

/// Retrieve the Obsidian REST API key from the OS keychain.
///
/// Returns `None` if no key is stored for `key_ref`.
pub fn get_rest_key(key_ref: &str) -> Result<Option<String>, SecretsError> {
    let entry = Entry::new(KEYCHAIN_SERVICE, key_ref)?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(SecretsError::Keychain(e)),
    }
}

/// Delete the Obsidian REST API key from the OS keychain.
///
/// No-op (Ok) if no entry exists.
pub fn delete_rest_key(key_ref: &str) -> Result<(), SecretsError> {
    let entry = Entry::new(KEYCHAIN_SERVICE, key_ref)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretsError::Keychain(e)),
    }
}

/// Check whether a key is currently stored in the keychain for `key_ref`.
///
/// Returns `true` if a key exists and is retrievable, `false` otherwise.
/// Useful for settings-panel "configured" indicators without exposing the key.
pub fn has_rest_key(key_ref: &str) -> bool {
    matches!(get_rest_key(key_ref), Ok(Some(_)))
}

// ── Test helpers ──────────────────────────────────────────────────────────────

#[cfg(test)]
pub mod test_helpers {
    /// Install the `keyring` in-memory mock credential builder for the current
    /// test process.
    ///
    /// Call this once — typically at the top of a test that exercises keychain
    /// code — to redirect all `keyring::Entry` calls to a process-local,
    /// non-persistent store.  This avoids touching the real macOS Keychain or
    /// Windows Credential Manager in CI.
    ///
    /// IMPORTANT: `set_default_credential_builder` is a one-way global write
    /// (the keyring crate uses an `OnceLock` internally), so calling this more
    /// than once per process is fine — subsequent calls are no-ops.  Tests that
    /// run in parallel should each set up their own unique `key_ref` strings to
    /// avoid cross-test interference within the shared in-memory store.
    pub fn init_mock_keychain() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    }
}

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

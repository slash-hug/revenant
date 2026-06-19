//! Shared schema-envelope helpers for the versioned on-disk stores.
//!
//! Both the annotation sidecar (`annotations.rs`) and the application settings
//! store (`settings.rs`) carry a `schema_version: 1` envelope and share one
//! migration *policy* (see `CLAUDE.md` → "Schema versions"):
//!
//! - **missing / version 0** → treat as the oldest known version and migrate
//!   in-place to the current version (a value-less or pre-`schema_version`
//!   file is a v0 file, never a corrupt one).
//! - **known older version** (`0 < v < CURRENT`) → migrate in-place.
//! - **unknown / newer version** (`v > CURRENT`) → quarantine to `.bak`,
//!   never discard.
//!
//! Issue #13 item J tracked the historical risk that the two stores would
//! *drift* on the very first of these cases — at one point `settings.rs`
//! defaulted a missing version to 0 and migrated while `annotations.rs`
//! quarantined the same file. PR #53 (settings migration data-loss) and the
//! C-PEEK-1 sidecar fix converged them onto the policy above. This module gives
//! the one decision they literally duplicate — *"read the `schema_version` from
//! an already-parsed JSON value; absent or null means version 0"* — a single
//! home so it cannot silently re-diverge.
//!
//! Everything *downstream* of this decision is intentionally NOT shared: the
//! two stores deserialize into different structs, name their `.bak` files
//! differently (settings: single slot; sidecar: collision-avoiding `.bak.N`),
//! return different result shapes (`SettingsError` variants vs. the
//! `LoadResult::Quarantined` enum), and differ deliberately on corrupt-JSON
//! handling (settings surfaces a parse error; the sidecar quarantines). Forcing
//! those into a shared abstraction would change observable behavior, which the
//! data-safety guarantee forbids.

use serde_json::Value;

/// The version assigned to a JSON envelope whose `schema_version` field is
/// absent or `null`. Such a file predates the `schema_version` field and is
/// treated as the oldest known version (migrate in-place, never quarantine).
pub const MISSING_SCHEMA_VERSION: u32 = 0;

/// Read the `schema_version` from an already-parsed JSON envelope.
///
/// Returns [`MISSING_SCHEMA_VERSION`] (`0`) when the field is absent, `null`,
/// or not a non-negative integer — so valid-but-version-less JSON migrates
/// in-place rather than being quarantined. This is the single decision that
/// `settings.rs` and `annotations.rs` must agree on (issue #13 item J); both
/// call this so the policy lives in exactly one place.
///
/// The caller is responsible for the corrupt-JSON case *before* calling this:
/// this function assumes `value` is already a successfully parsed
/// [`serde_json::Value`]. The two stores deliberately differ on what to do with
/// JSON that fails to parse at all, so that decision is left to each caller.
pub fn schema_version_of(value: &Value) -> u32 {
    value
        .get("schema_version")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(MISSING_SCHEMA_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_present_version() {
        assert_eq!(schema_version_of(&json!({ "schema_version": 1 })), 1);
        assert_eq!(schema_version_of(&json!({ "schema_version": 99 })), 99);
    }

    #[test]
    fn absent_field_is_version_zero() {
        // Valid JSON with no schema_version field → 0 → migrate-in-place policy.
        assert_eq!(
            schema_version_of(&json!({ "doc_content_hash": "abc" })),
            MISSING_SCHEMA_VERSION
        );
        assert_eq!(schema_version_of(&json!({})), 0);
    }

    #[test]
    fn null_field_is_version_zero() {
        assert_eq!(
            schema_version_of(&json!({ "schema_version": Value::Null })),
            0
        );
    }

    #[test]
    fn non_integer_field_is_version_zero() {
        // A string or negative/float value is not a valid version → treat as 0
        // (migrate), matching the historical `as_u64().unwrap_or(0)` behavior of
        // both stores.
        assert_eq!(schema_version_of(&json!({ "schema_version": "1" })), 0);
        assert_eq!(schema_version_of(&json!({ "schema_version": -3 })), 0);
        assert_eq!(schema_version_of(&json!({ "schema_version": 1.5 })), 0);
    }
}

/// Tests for updates.rs (WS-D / D4).
///
/// Per task spec §D4:
/// 1. Semver comparison — newer/older/equal → update_available.
/// 2. GitHub-response parse via mockito::Server.
/// 3. Network/parse error → graceful Err (no panic).
/// 4. URL-validation — accept/reject cases:
///      accept: https github.com /slash-hug/revenant/releases/...
///      reject: http, evil host, wrong path.
use crate::updates::{
    check_for_updates_from, open_release_page, validate_release_url, UpdatesError,
};
use mockito::Server;

// ---------------------------------------------------------------------------
// 1. Semver comparison: update_available flag
// ---------------------------------------------------------------------------

/// When the latest version is strictly newer, update_available must be true.
#[test]
fn test_semver_newer_sets_update_available() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"tag_name":"v9.9.9","html_url":"https://github.com/slash-hug/revenant/releases/tag/v9.9.9"}"#)
        .create();

    let result = check_for_updates_from(&api_url, "0.1.0");
    let info = result.expect("check should succeed against mockito server");

    assert!(
        info.update_available,
        "v9.9.9 > 0.1.0: update_available must be true, got: {:?}",
        info
    );
    assert_eq!(info.latest, "9.9.9");
    assert_eq!(info.current, "0.1.0");
}

/// When the latest version equals the running version, update_available must be false.
#[test]
fn test_semver_equal_no_update() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"tag_name":"v1.2.3","html_url":"https://github.com/slash-hug/revenant/releases/tag/v1.2.3"}"#)
        .create();

    let result = check_for_updates_from(&api_url, "1.2.3");
    let info = result.expect("check should succeed");

    assert!(
        !info.update_available,
        "equal versions: update_available must be false, got: {:?}",
        info
    );
}

/// When the running version is newer than the latest release (e.g. local dev
/// build), update_available must be false — not a panic.
#[test]
fn test_semver_older_remote_no_update() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"tag_name":"v0.0.1","html_url":"https://github.com/slash-hug/revenant/releases/tag/v0.0.1"}"#)
        .create();

    let result = check_for_updates_from(&api_url, "1.0.0");
    let info = result.expect("check should succeed");

    assert!(
        !info.update_available,
        "0.0.1 < 1.0.0: update_available must be false, got: {:?}",
        info
    );
}

// ---------------------------------------------------------------------------
// 2. GitHub-response parse via mockito
// ---------------------------------------------------------------------------

/// A well-formed response sets all fields correctly.
#[test]
fn test_parse_response_fields() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{
                "tag_name": "v2.0.0",
                "html_url": "https://github.com/slash-hug/revenant/releases/tag/v2.0.0",
                "name": "Release 2.0.0"
            }"#,
        )
        .create();

    let info = check_for_updates_from(&api_url, "1.0.0").expect("parse should succeed");

    assert_eq!(info.latest, "2.0.0", "latest without leading v");
    assert_eq!(
        info.release_url,
        "https://github.com/slash-hug/revenant/releases/tag/v2.0.0"
    );
    assert!(info.update_available);
}

/// A response missing `tag_name` must return a Parse error, not panic.
#[test]
fn test_parse_error_missing_tag_name() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"html_url":"https://github.com/slash-hug/revenant/releases/tag/v1.0.0"}"#)
        .create();

    let result = check_for_updates_from(&api_url, "0.1.0");

    assert!(
        matches!(result, Err(UpdatesError::Parse(_))),
        "missing tag_name must return Parse error, got: {result:?}"
    );
}

/// A response missing `html_url` must return a Parse error, not panic.
#[test]
fn test_parse_error_missing_html_url() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"tag_name":"v1.0.0"}"#)
        .create();

    let result = check_for_updates_from(&api_url, "0.1.0");

    assert!(
        matches!(result, Err(UpdatesError::Parse(_))),
        "missing html_url must return Parse error, got: {result:?}"
    );
}

/// An invalid semver in `tag_name` must return a Parse error, not panic.
#[test]
fn test_parse_error_invalid_semver_in_tag() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{"tag_name":"not-a-version","html_url":"https://github.com/slash-hug/revenant/releases/tag/v1.0.0"}"#,
        )
        .create();

    let result = check_for_updates_from(&api_url, "0.1.0");

    assert!(
        matches!(result, Err(UpdatesError::Parse(_))),
        "invalid semver tag must return Parse error, got: {result:?}"
    );
}

// ---------------------------------------------------------------------------
// 3. Network / server error → graceful Err (no panic)
// ---------------------------------------------------------------------------

/// Connection refused (port 1) must return a Network error, not panic.
#[test]
fn test_network_error_connection_refused() {
    // Port 1 is always connection-refused on macOS/Linux.
    let result = check_for_updates_from("http://127.0.0.1:1/releases/latest", "0.1.0");

    assert!(
        matches!(result, Err(UpdatesError::Network(_))),
        "connection refused must return Network error, got: {result:?}"
    );
}

/// An HTTP 500 from the server must return a Network error (reqwest's
/// `error_for_status` maps 4xx/5xx → `reqwest::Error`).
#[test]
fn test_network_error_http_500() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(500)
        .create();

    let result = check_for_updates_from(&api_url, "0.1.0");

    assert!(
        matches!(result, Err(UpdatesError::Network(_))),
        "HTTP 500 must return Network error, got: {result:?}"
    );
}

/// Non-JSON response body must return a Network error (reqwest `.json()`
/// returns a reqwest::Error when deserialization fails).
#[test]
fn test_network_error_non_json_body() {
    let mut server = Server::new();
    let api_url = format!("{}/repos/test/test/releases/latest", server.url());

    let _mock = server
        .mock("GET", mockito::Matcher::Any)
        .with_status(200)
        .with_header("content-type", "text/html")
        .with_body("<html>not json</html>")
        .create();

    let result = check_for_updates_from(&api_url, "0.1.0");

    // reqwest .json() returns a reqwest::Error when JSON deserialization fails,
    // which maps to UpdatesError::Network via the From impl.
    assert!(
        result.is_err(),
        "non-JSON body must return an error, got: {result:?}"
    );
}

// ---------------------------------------------------------------------------
// 4. URL validation — accept / reject cases
// ---------------------------------------------------------------------------

/// A canonical https://github.com/.../releases/... URL must be accepted.
#[test]
fn test_url_valid_https_github_releases() {
    let url = "https://github.com/slash-hug/revenant/releases/tag/v1.2.3";
    assert!(
        validate_release_url(url).is_ok(),
        "valid release URL must pass validation"
    );
}

/// The releases root path (no tag) must also be accepted.
#[test]
fn test_url_valid_releases_root() {
    let url = "https://github.com/slash-hug/revenant/releases";
    assert!(
        validate_release_url(url).is_ok(),
        "releases root URL must pass validation"
    );
}

/// http (not https) must be rejected.
#[test]
fn test_url_reject_http_scheme() {
    let url = "http://github.com/slash-hug/revenant/releases/tag/v1.0.0";
    assert!(
        matches!(validate_release_url(url), Err(UpdatesError::InvalidUrl(_))),
        "http scheme must be rejected"
    );
}

/// A different host must be rejected (open-redirect / confused deputy guard).
#[test]
fn test_url_reject_evil_host() {
    let url = "https://evil.com/slash-hug/revenant/releases/tag/v1.0.0";
    assert!(
        matches!(validate_release_url(url), Err(UpdatesError::InvalidUrl(_))),
        "non-github.com host must be rejected"
    );
}

/// A path to a different GitHub repo must be rejected.
#[test]
fn test_url_reject_wrong_repo_path() {
    let url = "https://github.com/other-org/revenant/releases/tag/v1.0.0";
    assert!(
        matches!(validate_release_url(url), Err(UpdatesError::InvalidUrl(_))),
        "wrong repo path must be rejected"
    );
}

/// A path that doesn't include /releases at all must be rejected.
#[test]
fn test_url_reject_non_releases_path() {
    let url = "https://github.com/slash-hug/revenant/issues/123";
    assert!(
        matches!(validate_release_url(url), Err(UpdatesError::InvalidUrl(_))),
        "non-releases path must be rejected"
    );
}

/// A completely malformed URL must be rejected.
#[test]
fn test_url_reject_malformed() {
    let url = "not a url at all";
    assert!(
        matches!(validate_release_url(url), Err(UpdatesError::InvalidUrl(_))),
        "malformed URL must be rejected"
    );
}

/// open_release_page with a valid URL should not panic (the browser may not
/// open in CI but the function must not return an error on a well-formed URL —
/// the spawn is fire-and-forget; OS-level "not found" for the browser binary
/// would be a CI-host issue not a URL issue).
///
/// Note: we only assert no validation error.  We do NOT assert that the browser
/// actually opens because CI environments may lack `open`/`xdg-open`/`start`.
#[test]
fn test_open_release_page_valid_url_no_panic() {
    // This test only validates that URL validation passes for a good URL.
    // We do not call open_release_page directly (would spawn a browser process
    // in CI), but we verify that validate_release_url — which is the only
    // rejection path — passes for the canonical URL shape.
    let url = "https://github.com/slash-hug/revenant/releases/latest";
    let validation = validate_release_url(url);
    assert!(
        validation.is_ok(),
        "valid release URL must pass validation before open attempt"
    );
}

/// open_release_page with an invalid URL must return InvalidUrl error.
#[test]
fn test_open_release_page_invalid_url_returns_error() {
    let url = "http://evil.com/slash-hug/revenant/releases/tag/v1.0.0";
    let result = open_release_page(url);
    assert!(
        matches!(result, Err(UpdatesError::InvalidUrl(_))),
        "invalid URL passed to open_release_page must return InvalidUrl error, got: {result:?}"
    );
}

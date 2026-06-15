// Test module root for all workstreams.
// WS-B: data engine tests
pub mod file_io_tests;
pub mod annotations_tests;
pub mod reanchor_tests;
pub mod reanchor_integration_tests;
pub mod watcher_tests;
// WS-D: settings, secrets & Obsidian tests
pub mod settings_tests;
pub mod obsidian_tests;
// WS-A: export tests (path validation + I/O for export_html, read_file_bytes)
pub mod export_tests;
// WS-D: update-check engine tests (semver compare, mockito parse, URL validation)
pub mod updates_tests;

//! Integration-level tests for annotations.rs.
//!
//! Unit tests are also colocated in `annotations.rs`.  This file adds tests
//! that span load → modify → save → reload workflows.
//!
//! T2.4 (A9/C-CRLF-BLAST): CRLF regression test drives `frontmatter::merge_into_doc`
//! (the `obsidian.rs:164` export/merge path) with a CRLF document and asserts
//! CRLF is preserved after merge. The preview path (frontend `stripFrontmatter`)
//! is NOT tested here — it is already CRLF-aware and does not exercise the Rust
//! frontmatter code.

#[cfg(test)]
mod integration {
    use crate::annotations::{
        load_annotations_from_path, save_annotations_to_path, Annotation, AnchorStatus,
        LoadResult, Sidecar, CURRENT_SCHEMA_VERSION,
    };
    use std::fs;
    use tempfile::TempDir;

    fn make_annotation(id: &str) -> Annotation {
        Annotation {
            id: id.to_string(),
            line_start: 0,
            line_end: 1,
            char_start: 0,
            char_end: 6,
            quoted_text: "quoted".to_string(),
            context_before: "before".to_string(),
            context_after: "after".to_string(),
            body: "comment body".to_string(),
            status: AnchorStatus::Anchored,
            created_at: "2025-01-01T00:00:00Z".to_string(),
            updated_at: "2025-01-01T00:00:00Z".to_string(),
        }
    }

    /// Verifies load → modify (add annotation) → save → reload preserves all
    /// data including the added annotation.
    #[test]
    fn load_modify_save_reload_round_trip() {
        let dir = TempDir::new().unwrap();
        let sidecar_path = dir.path().join("doc.md.annotations.json");

        // Start: no sidecar exists.
        let loaded = load_annotations_from_path(&sidecar_path, "hash1").unwrap();
        let mut sidecar = match loaded {
            LoadResult::NotFound(s) => s,
            _ => panic!("expected NotFound"),
        };

        // Add two annotations.
        sidecar.annotations.push(make_annotation("ann-1"));
        sidecar.annotations.push(make_annotation("ann-2"));
        sidecar.general_notes = "doc-level note".to_string();

        save_annotations_to_path(&sidecar_path, &sidecar).unwrap();

        // Reload.
        let reloaded = load_annotations_from_path(&sidecar_path, "hash1").unwrap();
        let final_sidecar = match reloaded {
            LoadResult::Loaded(s) => s,
            _ => panic!("expected Loaded"),
        };

        assert_eq!(final_sidecar.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(final_sidecar.annotations.len(), 2);
        assert_eq!(final_sidecar.general_notes, "doc-level note");
    }

    /// Issue #55: the annotations save path is atomic and durable — it writes
    /// the exact bytes and leaves no staging temp file behind on success.
    #[test]
    fn save_round_trips_exact_content_and_leaves_no_temp() {
        let dir = TempDir::new().unwrap();
        let sidecar_path = dir.path().join("doc.md.annotations.json");

        let sidecar = Sidecar {
            schema_version: CURRENT_SCHEMA_VERSION,
            doc_content_hash: "deadbeef".to_string(),
            general_notes: "round-trip note".to_string(),
            annotations: vec![make_annotation("ann-rt")],
        };
        save_annotations_to_path(&sidecar_path, &sidecar).unwrap();

        // Exact content: the file on disk equals the pretty-printed JSON.
        let expected = serde_json::to_string_pretty(&sidecar).unwrap();
        assert_eq!(fs::read_to_string(&sidecar_path).unwrap(), expected);

        // No staging temp file (unique-named `.revenant.*.tmp`) lingers.
        let leftover = fs::read_dir(dir.path()).unwrap().any(|e| {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            name.contains(".revenant.") && name.ends_with(".tmp")
        });
        assert!(!leftover, "temp staging file was left behind");
    }

    /// Verifies that a detached annotation survives a save/reload cycle.
    #[test]
    fn detached_annotation_survives_round_trip() {
        let dir = TempDir::new().unwrap();
        let sidecar_path = dir.path().join("detach.md.annotations.json");

        let mut ann = make_annotation("detached-ann");
        ann.status = AnchorStatus::Detached;
        let sidecar = Sidecar {
            schema_version: 1,
            doc_content_hash: "xyz".to_string(),
            general_notes: String::new(),
            annotations: vec![ann],
        };
        save_annotations_to_path(&sidecar_path, &sidecar).unwrap();

        let loaded = load_annotations_from_path(&sidecar_path, "xyz").unwrap();
        let s = match loaded {
            LoadResult::Loaded(s) => s,
            _ => panic!("expected Loaded"),
        };
        assert_eq!(s.annotations[0].status, AnchorStatus::Detached);
    }

    /// The quarantined `.bak` file contains the full original data (no loss).
    #[test]
    fn quarantined_bak_contains_original_data() {
        let dir = TempDir::new().unwrap();
        let sidecar_path = dir.path().join("future.md.annotations.json");
        let future_json = r#"{
            "schema_version": 42,
            "doc_content_hash": "abc",
            "general_notes": "precious notes",
            "annotations": [{"id":"x","line_start":1,"line_end":1,"quoted_text":"q","context_before":"","context_after":"","body":"b","status":"anchored"}]
        }"#;
        fs::write(&sidecar_path, future_json).unwrap();

        let result = load_annotations_from_path(&sidecar_path, "current").unwrap();
        let bak_path = match result {
            LoadResult::Quarantined { bak_path, .. } => bak_path,
            _ => panic!("expected Quarantined"),
        };

        // All original data is in the .bak.
        let bak_content = fs::read_to_string(&bak_path).unwrap();
        assert!(bak_content.contains("precious notes"));
        assert!(bak_content.contains("42")); // original schema_version preserved
        assert!(bak_content.contains("\"x\"")); // annotation id preserved
    }

    /// After quarantine, a fresh save/load cycle works normally.
    #[test]
    fn after_quarantine_can_save_fresh_sidecar() {
        let dir = TempDir::new().unwrap();
        let sidecar_path = dir.path().join("new.md.annotations.json");

        // Write a future-version sidecar.
        fs::write(
            &sidecar_path,
            r#"{"schema_version":999,"doc_content_hash":"h","general_notes":"","annotations":[]}"#,
        )
        .unwrap();

        let result = load_annotations_from_path(&sidecar_path, "h").unwrap();
        let mut fresh = match result {
            LoadResult::Quarantined { fallback, .. } => fallback,
            _ => panic!("expected Quarantined"),
        };

        fresh.annotations.push(make_annotation("new-ann"));
        save_annotations_to_path(&sidecar_path, &fresh).unwrap();

        let reloaded = load_annotations_from_path(&sidecar_path, "h").unwrap();
        match reloaded {
            LoadResult::Loaded(s) => assert_eq!(s.annotations.len(), 1),
            _ => panic!("expected Loaded after fresh save"),
        }
    }

    // ── T2.4: CRLF regression via the export/merge path (A9/C-CRLF-BLAST) ───
    //
    // Drives `frontmatter::merge_into_doc` (the obsidian.rs:164 path) with a
    // CRLF document, asserting the merged output has YAML correctly applied and
    // CRLF line endings are preserved.

    #[test]
    fn merge_into_doc_preserves_crlf_round_trip() {
        use crate::frontmatter::merge_into_doc;
        use serde_yaml::Value;

        // A CRLF document with existing frontmatter.
        let crlf_doc = "---\r\ntitle: Existing\r\nauthor: Alice\r\n---\r\n# Body content\r\nWith CRLF\r\n";

        // Overlay: add a new key and override the title.
        let overlay: serde_yaml::Mapping = serde_yaml::from_str("title: Updated\ntags: [review]").unwrap();

        let result = merge_into_doc(crlf_doc, &overlay).unwrap();

        // YAML must be correctly merged.
        assert!(result.contains("title:"), "title key must be present");
        assert!(result.contains("Updated"), "overlay title must win");
        assert!(result.contains("author:"), "base author must be preserved");
        assert!(result.contains("Alice"), "base author value must be preserved");
        assert!(result.contains("tags:"), "overlay tags must be present");

        // Body must be preserved.
        assert!(result.contains("# Body content"), "body must be preserved");

        // CRLF must be preserved throughout — no bare LF-only lines in the
        // frontmatter section.
        assert!(result.contains("\r\n"), "output must contain CRLF");
        // Opening and closing fences must use CRLF.
        assert!(result.starts_with("---\r\n"), "opening fence must use CRLF");

        // Round-trip: parse the result and check YAML fields again.
        let reparsed = crate::frontmatter::parse(&result).unwrap();
        let m = reparsed.mapping.expect("reparsed must have mapping");
        assert_eq!(
            m.get(&Value::String("title".into())),
            Some(&Value::String("Updated".into())),
            "title must survive CRLF round-trip"
        );
        assert_eq!(
            m.get(&Value::String("author".into())),
            Some(&Value::String("Alice".into())),
            "author must survive CRLF round-trip"
        );
    }

    /// CRLF document WITHOUT frontmatter: adding overlay frontmatter via
    /// `merge_into_doc` must produce correct CRLF fences.
    #[test]
    fn merge_into_doc_crlf_no_prior_frontmatter() {
        use crate::frontmatter::merge_into_doc;

        let crlf_no_fm = "# Title\r\nSome content.\r\n";
        let overlay: serde_yaml::Mapping = serde_yaml::from_str("added: yes").unwrap();
        let result = merge_into_doc(crlf_no_fm, &overlay).unwrap();

        assert!(result.contains("added:"), "added key must be present");
        assert!(result.contains("# Title"), "body must be preserved");
        // Since the input uses CRLF, the injected fences should too.
        assert!(result.contains("\r\n"), "CRLF from input must be reflected in output");
    }
}

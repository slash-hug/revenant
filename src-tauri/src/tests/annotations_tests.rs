//! Integration-level tests for annotations.rs.
//!
//! Unit tests are also colocated in `annotations.rs`.  This file adds tests
//! that span load → modify → save → reload workflows.

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
            line_start: 1,
            line_end: 2,
            quoted_text: "quoted".to_string(),
            context_before: "before".to_string(),
            context_after: "after".to_string(),
            body: "comment body".to_string(),
            status: AnchorStatus::Anchored,
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
}
